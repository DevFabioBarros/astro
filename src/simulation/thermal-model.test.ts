import { describe, expect, it } from "vitest";
import { advanceThermalTemperatures, supportsThermalProfile } from "./thermal-model";
import { createSolarSystem } from "./solar-system";
import type { CelestialBody } from "./types";
import { adoptWaterInventory, getWaterInventoryMetrics } from "./water-model";
import { createMaterialCompositionCandidate } from "./body-edits";
import { deriveAtmosphereMetrics, ATMOSPHERE_PROFILES, WATER_VAPOR_OPTICAL_PROFILE } from "./atmosphere-model";
import { materialCompositionVolumeM3 } from "./material-profiles";

const astronomicalUnitM = 149_597_870_700;
const profile = "earthlike-global-mean-v1" as const;
const gravitationalConstant = 6.6743e-11;

function makeWorld(distanceAu: number, temperatureK = 288): CelestialBody[] {
  const solar = createSolarSystem();
  const star = { ...solar[0]!, bodyType: "star" as const, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const };
  const planet = {
    ...solar[3]!, thermalProfileId: profile,
    positionM: [distanceAu * astronomicalUnitM, 0, 0] as const,
    velocityMs: [0, 0, 0] as const,
    surfaceTemperatureK: temperatureK,
  };
  return [star, planet];
}

function makeAtmosphereWorld(
  distanceAu: number, temperatureK = 288, dryGasMassKg = 5e18, isothermalTemperatureK = 288, vaporKg = 0,
): CelestialBody[] {
  const [star, originalPlanet] = makeWorld(distanceAu, temperatureK);
  const planet = createMaterialCompositionCandidate([originalPlanet!], { gravitationalConstant }, originalPlanet!.id,
    "mass-authoritative", { rock: 0.7, iron: 0.3, gas: 0 })[0]!;
  const materialDryMassKg = planet.materials!.rockKg + planet.materials!.ironKg + planet.materials!.gasKg;
  const dryVolumeM3 = materialCompositionVolumeM3(planet.materials!);
  const retainedWaterVolumeM3 = vaporKg / 1_000;
  const atmospherePlanet: CelestialBody = {
    ...planet,
    massKg: materialDryMassKg + dryGasMassKg + vaporKg,
    radiusM: Math.cbrt(3 * (dryVolumeM3 + retainedWaterVolumeM3) / (4 * Math.PI)),
    atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg, isothermalTemperatureK },
    ...(vaporKg > 0 ? { waterInventory: {
      modelId: "water-inventory-v1" as const, escapeModelId: "water-escape-retention-500-1000k-v1" as const,
      dryMassKg: materialDryMassKg + dryGasMassKg, dryVolumeM3,
      liquidKg: 0, iceKg: 0, vaporKg, escapedKg: 0,
    } } : {}),
  };
  return [star!, atmospherePlanet];
}

describe("earthlike global mean thermal profile", () => {
  it("approaches the calibrated solar equilibrium near 288 K", () => {
    const world = makeWorld(1, 350);
    const advanced = advanceThermalTemperatures(world, world, 1e12);

    expect(advanced[1]!.surfaceTemperatureK).toBeCloseTo(287.846, 3);
  });

  it("keeps the exact T10 result when q is zero or atmosphere is absent", () => {
    const baseline = makeWorld(1, 350);
    const tinyAtmosphere = makeAtmosphereWorld(1, 350, 1e-300);
    const baselineTemperature = advanceThermalTemperatures(baseline, baseline, 1e12)[1]!.surfaceTemperatureK;
    const tinyMetrics = deriveAtmosphereMetrics(tinyAtmosphere[1]!, gravitationalConstant);
    const tinyTemperature = advanceThermalTemperatures(tinyAtmosphere, tinyAtmosphere, 1e12, gravitationalConstant)[1]!.surfaceTemperatureK;

    expect(tinyMetrics.greenhousePotentialAbsorptionFraction).toBe(0);
    expect(tinyTemperature).toBe(baselineTemperature);
  });

  it("warms with atmosphere, increases monotonically with mass, and ignores isothermal temperature radiatively", () => {
    const baseline = makeWorld(1, 350);
    const atmosphere = makeAtmosphereWorld(1, 350, 5e18, 288);
    const heavier = makeAtmosphereWorld(1, 350, 1e19, 288);
    const warmerStructure = makeAtmosphereWorld(1, 350, 5e18, 700);
    const baselineTemperature = advanceThermalTemperatures(baseline, baseline, 1e12)[1]!.surfaceTemperatureK;
    const atmosphereTemperature = advanceThermalTemperatures(atmosphere, atmosphere, 1e12, gravitationalConstant)[1]!.surfaceTemperatureK;
    const heavierTemperature = advanceThermalTemperatures(heavier, heavier, 1e12, gravitationalConstant)[1]!.surfaceTemperatureK;
    const warmerStructureTemperature = advanceThermalTemperatures(warmerStructure, warmerStructure, 1e12, gravitationalConstant)[1]!.surfaceTemperatureK;

    expect(atmosphereTemperature).toBeGreaterThan(baselineTemperature);
    expect(deriveAtmosphereMetrics(heavier[1]!, gravitationalConstant).greenhousePotentialAbsorptionFraction)
      .toBeGreaterThan(deriveAtmosphereMetrics(atmosphere[1]!, gravitationalConstant).greenhousePotentialAbsorptionFraction);
    expect(heavierTemperature).toBeGreaterThan(atmosphereTemperature);
    expect(warmerStructureTemperature).toBe(atmosphereTemperature);
  });

  it("uses retained T11 vapor once through its own longwave coefficient", () => {
    const vaporKg = 1e15;
    const wet = makeAtmosphereWorld(1, 288, 5e18, 288, vaporKg);
    const dryReference = makeAtmosphereWorld(1, 288, 5e18);
    const dryMassKg = 5e18 + vaporKg * WATER_VAPOR_OPTICAL_PROFILE.longwaveAbsorptionCoefficientM2Kg
      / ATMOSPHERE_PROFILES["nitrogen-oxygen-v1"].longwaveAbsorptionCoefficientM2Kg;
    const matchedDry = makeAtmosphereWorld(1, 288, dryMassKg);
    matchedDry[1] = { ...matchedDry[1]!, radiusM: wet[1]!.radiusM };
    const wetMetrics = deriveAtmosphereMetrics(wet[1]!, gravitationalConstant);
    const matchedDryMetrics = deriveAtmosphereMetrics(matchedDry[1]!, gravitationalConstant);
    const dryReferenceTemperature = advanceThermalTemperatures(dryReference, dryReference, 1e6, gravitationalConstant)[1]!.surfaceTemperatureK;
    const wetTemperature = advanceThermalTemperatures(wet, wet, 1e6, gravitationalConstant)[1]!.surfaceTemperatureK;
    const matchedDryTemperature = advanceThermalTemperatures(matchedDry, matchedDry, 1e6, gravitationalConstant)[1]!.surfaceTemperatureK;

    expect(wet[1]!.massKg).toBeGreaterThan(dryReference[1]!.massKg);
    expect(wetMetrics.vaporLongwaveOpticalDepth).toBeGreaterThan(0);
    expect(wetMetrics.greenhouseOpticalDepth).toBeCloseTo(matchedDryMetrics.greenhouseOpticalDepth, 12);
    expect(wetTemperature).toBeGreaterThan(dryReferenceTemperature);
    expect(wetTemperature).toBeCloseTo(matchedDryTemperature, 12);
  });

  it("rejects unsupported atmosphere G and thin-shell domains in the thermal path", () => {
    const atmosphere = makeAtmosphereWorld(1);
    expect(() => advanceThermalTemperatures(atmosphere, atmosphere, 1, 0)).toThrow();
    const outsideThinShell = [{ ...atmosphere[1]!, radiusM: 1e10 }];
    expect(() => advanceThermalTemperatures(outsideThinShell, outsideThinShell, 1, gravitationalConstant)).toThrow(/casca fina/);
  });

  it("cools toward a fixed cold-orbit reference over a long interval", () => {
    const world = makeWorld(35, 350);
    const advanced = advanceThermalTemperatures(world, world, 1e12);

    expect(advanced[1]!.surfaceTemperatureK).toBeCloseTo(56.007, 2);
  });

  it("warms closer to a luminous star and cools farther away", () => {
    const close = makeWorld(0.1);
    const far = makeWorld(2);

    expect(advanceThermalTemperatures(close, close, 1e6)[1]!.surfaceTemperatureK).toBeGreaterThan(288);
    expect(advanceThermalTemperatures(far, far, 1e8)[1]!.surfaceTemperatureK).toBeLessThan(288);
  });

  it("caps the profile without failing when absorbed flux exceeds its domain", () => {
    const world = makeWorld(0.01);

    expect(advanceThermalTemperatures(world, world, 1e9)[1]!.surfaceTemperatureK).toBe(1_000);
  });

  it("does not treat a black hole tagged as a star as a light source", () => {
    const world = makeWorld(1);
    const blackHole = { ...world[0]!, bodyType: "black-hole" as const, surfaceTemperatureK: 10_000_000 };
    const baseline = advanceThermalTemperatures([world[1]!], [world[1]!], 1e6)[0]!.surfaceTemperatureK;

    expect(advanceThermalTemperatures([blackHole, world[1]!], [blackHole, world[1]!], 1e6)[1]!.surfaceTemperatureK).toBe(baseline);
  });

  it("keeps manual bodies unchanged and rejects gas giants from opt-in", () => {
    const manual = { ...createSolarSystem()[3]!, surfaceTemperatureK: 288 };

    expect(advanceThermalTemperatures([manual], [manual], 1e9)[0]!.surfaceTemperatureK).toBe(288);
    expect(supportsThermalProfile({ id: "jupiter-copy-1", kind: "planet", bodyType: "gas-giant" })).toBe(false);
  });

  it("ledgers heat-driven water escape while profile cooling changes phase without restoring it", () => {
    const hotWorld = makeWorld(0.01);
    const hotPlanet = adoptWaterInventory(hotWorld[1]!);
    const heated = advanceThermalTemperatures([hotWorld[0]!, hotPlanet], [hotWorld[0]!, hotPlanet], 1e9);
    const farSnapshot = makeWorld(35, heated[1]!.surfaceTemperatureK);
    const farWorld = [farSnapshot[0]!, { ...heated[1]!, positionM: farSnapshot[1]!.positionM }];
    const cooled = advanceThermalTemperatures(farWorld, farWorld, 1e12);

    expect(heated[1]!.surfaceTemperatureK).toBe(1_000);
    expect(getWaterInventoryMetrics(heated[1]!).retainedWaterKg).toBe(0);
    expect(getWaterInventoryMetrics(heated[1]!).escapedWaterKg).toBeGreaterThan(0);
    expect(cooled[1]!.surfaceTemperatureK).toBeLessThan(273.15);
    expect(getWaterInventoryMetrics(cooled[1]!).phase).toBe("ice");
    expect(getWaterInventoryMetrics(cooled[1]!).retainedWaterKg).toBe(0);
    expect(getWaterInventoryMetrics(cooled[1]!).escapedWaterKg).toBe(getWaterInventoryMetrics(heated[1]!).escapedWaterKg);
  });
});
