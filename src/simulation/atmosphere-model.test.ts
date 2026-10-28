import { describe, expect, it } from "vitest";
import { deriveAtmosphereMetrics, WATER_VAPOR_OPTICAL_PROFILE } from "./atmosphere-model";
import type { CelestialBody } from "./types";

const body: CelestialBody = {
  id: "world", name: "World", kind: "planet", bodyType: "rocky-planet",
  massKg: 6e24, radiusM: 6e6, positionM: [0, 0, 0], velocityMs: [0, 0, 0],
  surfaceTemperatureK: 288, waterFraction: 0,
  materials: { modelId: "material-composition-v1", rockKg: 6e24 - 5e18, ironKg: 0, gasKg: 0 },
  atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 5e18, isothermalTemperatureK: 288 },
};

describe("deriveAtmosphereMetrics", () => {
  it("derives thin-shell pressure and molecular scale height with retained vapor in the mixture", () => {
    const dryMetrics = deriveAtmosphereMetrics(body, 6.6743e-11);
    const withVapor: CelestialBody = { ...body, massKg: body.massKg + 1e16, waterInventory: {
      modelId: "water-inventory-v1", escapeModelId: "water-escape-retention-500-1000k-v1",
      dryMassKg: body.massKg, dryVolumeM3: 4 * Math.PI * body.radiusM ** 3 / 3,
      liquidKg: 0, iceKg: 0, vaporKg: 1e16, escapedKg: 1e16,
    } };
    const metrics = deriveAtmosphereMetrics(withVapor, 6.6743e-11);
    const gravity = 6.6743e-11 * withVapor.massKg / withVapor.radiusM ** 2;
    const expectedPressure = (body.atmosphere!.dryGasMassKg + 1e16) * gravity / (4 * Math.PI * body.radiusM ** 2);

    expect(Math.abs(metrics.surfaceGravityMs2 / gravity - 1)).toBeLessThan(1e-12);
    expect(Math.abs(metrics.surfacePressurePa / expectedPressure - 1)).toBeLessThan(1e-12);
    expect(metrics.scaleHeightM).toBeGreaterThan(0);
    expect(metrics.pressureAtAltitudePa(0)).toBe(metrics.surfacePressurePa);
    expect(Math.abs(metrics.pressureAtAltitudePa(metrics.scaleHeightM) / (metrics.surfacePressurePa / Math.E) - 1)).toBeLessThan(1e-12);
    expect(metrics.columnMassKg).toBe(body.atmosphere!.dryGasMassKg + 1e16);
    expect(metrics.effectiveMolarMassKgMol).not.toBe(metrics.profile.molarMassKgMol);
    expect(metrics.assumptions).toContain("thin-shell");
    const vaporColumnMassKgM2 = 1e16 / (4 * Math.PI * body.radiusM ** 2);
    expect(dryMetrics.vaporVisualOpticalDepth).toBe(0);
    expect(dryMetrics.vaporLongwaveOpticalDepth).toBe(0);
    expect(metrics.waterVaporOpticalProfileId).toBe(WATER_VAPOR_OPTICAL_PROFILE.id);
    expect(metrics.dryVisualOpticalDepth).toBe(dryMetrics.dryVisualOpticalDepth);
    expect(metrics.vaporVisualOpticalDepth).toBe(WATER_VAPOR_OPTICAL_PROFILE.visualExtinctionCoefficientM2Kg * vaporColumnMassKgM2);
    expect(metrics.dryLongwaveOpticalDepth).toBe(dryMetrics.dryLongwaveOpticalDepth);
    expect(metrics.vaporLongwaveOpticalDepth).toBe(WATER_VAPOR_OPTICAL_PROFILE.longwaveAbsorptionCoefficientM2Kg * vaporColumnMassKgM2);
    expect(metrics.visualOpticalDepth).toBe(metrics.dryVisualOpticalDepth + metrics.vaporVisualOpticalDepth);
    expect(metrics.greenhouseOpticalDepth).toBe(metrics.dryLongwaveOpticalDepth + metrics.vaporLongwaveOpticalDepth);
    expect(metrics.visualOpacityFraction).toBeGreaterThan(dryMetrics.visualOpacityFraction);
    expect(metrics.greenhousePotentialAbsorptionFraction).toBeGreaterThan(dryMetrics.greenhousePotentialAbsorptionFraction);
    expect(metrics.surfacePressurePa).toBeGreaterThan(dryMetrics.surfacePressurePa);
  });

  it("derives mass-dependent visible opacity and versioned greenhouse diagnostics", () => {
    const before = structuredClone(body);
    const heavier = { ...body, massKg: body.massKg + 5e18,
      atmosphere: { ...body.atmosphere!, dryGasMassKg: body.atmosphere!.dryGasMassKg * 2 } };
    const low = deriveAtmosphereMetrics(body, 6.6743e-11);
    const high = deriveAtmosphereMetrics(heavier, 6.6743e-11);

    expect(low.profile.visualExtinctionCoefficientM2Kg).toBeGreaterThan(0);
    expect(low.profile.longwaveAbsorptionCoefficientM2Kg).toBeGreaterThan(0);
    expect(low.columnMassKgM2).toBe(low.columnMassKg / (4 * Math.PI * body.radiusM ** 2));
    expect(low.visualOpticalDepth).toBe(low.profile.visualExtinctionCoefficientM2Kg * low.columnMassKgM2);
    expect(low.visualOpacityFraction).toBe(1 - Math.exp(-low.visualOpticalDepth));
    expect(low.greenhouseDiagnosticModelId).toBe("grey-column-optical-depth-v1");
    expect(low.greenhouseOpticalDepth).toBeGreaterThan(0);
    expect(low.greenhousePotentialAbsorptionFraction).toBe(1 - Math.exp(-low.greenhouseOpticalDepth));
    expect(high.visualOpacityFraction).toBeGreaterThan(low.visualOpacityFraction);
    expect(high.greenhousePotentialAbsorptionFraction).toBeGreaterThan(low.greenhousePotentialAbsorptionFraction);
    expect(low.visualOpacityFraction).toBeLessThanOrEqual(1);
    expect(low.greenhousePotentialAbsorptionFraction).toBeLessThanOrEqual(1);
    expect(body).toEqual(before);
    expect(body.surfaceTemperatureK).toBe(288);
  });

  it("exposes and rejects a hydrostatic scale height ratio above 0.05", () => {
    const metrics = deriveAtmosphereMetrics(body, 6.6743e-11);
    expect(metrics.scaleHeightToRadiusRatio).toBe(metrics.scaleHeightM / body.radiusM);
    expect(metrics.scaleHeightToRadiusRatio).toBeLessThanOrEqual(0.05);
    expect(() => deriveAtmosphereMetrics({ ...body, radiusM: 1e10 }, 6.6743e-11)).toThrow(/casca fina/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid gravity %s", (gravity) => {
    expect(() => deriveAtmosphereMetrics(body, gravity)).toThrow();
  });
});
