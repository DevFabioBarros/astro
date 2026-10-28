import { describe, expect, it } from "vitest";
import { createBodyEditCandidate, getBodyEditLimits, parseBodyEdit, updateBodyEditErrors } from "./body-edits";
import { isSafeGravitationalConstant } from "./physics";
import { createSolarSystem } from "./solar-system";
import { calculateAccelerations } from "./physics";
import { createSolarEvolutionCandidate, setSolarEvolutionModeCandidate } from "./stellar-evolution";
import { createCatalogBody, schwarzschildRadius } from "./body-catalog";
import { adoptWaterInventory, getWaterInventoryMetrics } from "./water-model";
import { validateSimulationState } from "./physics";
import { createMaterialCompositionCandidate } from "./body-edits";
import { createMaterialSizeCandidate } from "./body-edits";

describe("parseBodyEdit", () => {
  it.each([
    ["massKg", "0"], ["massKg", "-1"], ["massKg", "Infinity"], ["massKg", "NaN"], ["massKg", "1.7976931348623157e308"],
    ["radiusM", "0"], ["radiusM", "-1"], ["radiusM", "Infinity"], ["radiusM", "NaN"], ["radiusM", "1.7976931348623157e308"],
    ["surfaceTemperatureK", "-1"], ["surfaceTemperatureK", "Infinity"],
    ["waterFraction", "-0.01"], ["waterFraction", "1.01"], ["waterFraction", "NaN"],
    ["positionM.0", "Infinity"], ["positionM.2", "1.7976931348623157e308"], ["velocityMs.2", "NaN"], ["velocityMs.1", "1.7976931348623157e308"],
  ] as const)("rejects invalid %s value %s", (field, value) => {
    expect(parseBodyEdit(field, value)).toBeNull();
  });

  it.each([
    ["massKg", "5.972e24", 5.972e24], ["radiusM", "6371000", 6371000],
    ["surfaceTemperatureK", "0", 0], ["waterFraction", "1", 1],
    ["positionM.1", "-2e11", -2e11], ["velocityMs.0", "30000", 30000],
  ] as const)("accepts valid %s value %s", (field, value, expected) => {
    expect(parseBodyEdit(field, value)).toBe(expected);
  });
});

describe("material edits with atmosphere", () => {
  it("preserves atmospheric dry mass and derives the edited total mass and radius", () => {
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const wet = adoptWaterInventory(earth);
    const material = createMaterialCompositionCandidate([wet], { gravitationalConstant: 6.6743e-11 }, earth.id,
      "mass-authoritative", { rock: 0.7, iron: 0.2, gas: 0.1 })[0]!;
    const atmosphere = { modelId: "isothermal-atmosphere-v1" as const, profileId: "nitrogen-oxygen-v1" as const,
      dryGasMassKg: 1e17, isothermalTemperatureK: 288 };
    const atmospheric = { ...material, atmosphere, massKg: material.massKg + atmosphere.dryGasMassKg,
      waterInventory: { ...material.waterInventory!, dryMassKg: material.waterInventory!.dryMassKg + atmosphere.dryGasMassKg } };
    const phasesBefore = [atmospheric.waterInventory.liquidKg, atmospheric.waterInventory.iceKg,
      atmospheric.waterInventory.vaporKg, atmospheric.waterInventory.escapedKg];
    const edited = createMaterialSizeCandidate([atmospheric], { gravitationalConstant: 6.6743e-11 }, earth.id,
      "mass-authoritative", atmospheric.massKg * 1.2)[0]!;

    expect(edited.atmosphere).toEqual(atmosphere);
    expect(edited.massKg).toBe(atmospheric.massKg * 1.2);
    const retainedWaterKg = edited.waterInventory!.liquidKg + edited.waterInventory!.iceKg + edited.waterInventory!.vaporKg;
    const rebuiltMassKg = edited.materials!.rockKg + edited.materials!.ironKg + edited.materials!.gasKg
      + atmosphere.dryGasMassKg + retainedWaterKg;
    expect(Math.abs(rebuiltMassKg / edited.massKg - 1)).toBeLessThan(1e-12);
    expect([edited.waterInventory!.liquidKg, edited.waterInventory!.iceKg,
      edited.waterInventory!.vaporKg, edited.waterInventory!.escapedKg]).toEqual(phasesBefore);

    const resized = createMaterialSizeCandidate([atmospheric], { gravitationalConstant: 6.6743e-11 }, earth.id,
      "radius-authoritative", atmospheric.radiusM * 1.1)[0]!;
    expect(resized.radiusM).toBe(atmospheric.radiusM * 1.1);
    expect(resized.atmosphere).toEqual(atmosphere);
    const resizedRetainedKg = resized.waterInventory!.liquidKg + resized.waterInventory!.iceKg + resized.waterInventory!.vaporKg;
    expect(Math.abs((resized.materials!.rockKg + resized.materials!.ironKg + resized.materials!.gasKg
      + atmosphere.dryGasMassKg + resizedRetainedKg) / resized.massKg - 1)).toBeLessThan(1e-12);

    const recomposed = createMaterialCompositionCandidate([atmospheric], { gravitationalConstant: 6.6743e-11 }, earth.id,
      "mass-authoritative", { rock: 0.5, iron: 0.4, gas: 0.1 })[0]!;
    expect(recomposed.atmosphere).toEqual(atmosphere);
    expect(recomposed.massKg).toBe(atmospheric.massKg);
    expect([recomposed.waterInventory!.liquidKg, recomposed.waterInventory!.iceKg,
      recomposed.waterInventory!.vaporKg, recomposed.waterInventory!.escapedKg]).toEqual(phasesBefore);
    const recomposedDryMassKg = recomposed.materials!.rockKg + recomposed.materials!.ironKg
      + recomposed.materials!.gasKg + atmosphere.dryGasMassKg;
    expect(Math.abs(recomposed.waterInventory!.dryMassKg / recomposedDryMassKg - 1)).toBeLessThan(1e-12);
  });
});

describe("updateBodyEditErrors", () => {
  it("keeps other invalid fields marked when one field becomes valid", () => {
    const withInvalidMass = updateBodyEditErrors([], "mass", true);
    const withInvalidRadius = updateBodyEditErrors(withInvalidMass, "radius", true);

    expect(updateBodyEditErrors(withInvalidRadius, "radius", false)).toEqual(["mass"]);
  });
});

describe("isSafeGravitationalConstant", () => {
  it.each([0, 6.6743e-11, 1])("accepts supported G=%s", (value) => {
    expect(isSafeGravitationalConstant(value)).toBe(true);
  });

  it.each([-1, 1 + Number.EPSILON, Number.MAX_VALUE, Number.POSITIVE_INFINITY])("rejects unsupported G=%s", (value) => {
    expect(isSafeGravitationalConstant(value)).toBe(false);
  });
});

describe("createBodyEditCandidate", () => {
  it("atomically derives radius from fixed dry mass and explicit material fractions", () => {
    const earth = createSolarSystem()[3]!;
    const edited = createMaterialCompositionCandidate([earth], { gravitationalConstant: 0 }, earth.id,
      "mass-authoritative", { rock: 0.7, iron: 0.2, gas: 0.1 })[0]!;

    expect(edited.massKg).toBe(earth.massKg);
    expect(edited.materials!.modelId).toBe("material-composition-v1");
    expect(Math.abs(edited.materials!.rockKg / (earth.massKg * 0.7) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(edited.materials!.ironKg / (earth.massKg * 0.2) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(edited.materials!.gasKg / (earth.massKg * 0.1) - 1)).toBeLessThan(1e-12);
    expect(edited.radiusM).not.toBe(earth.radiusM);
  });

  it("keeps radius and T11 water phases fixed in radius-authoritative edits", () => {
    const adopted = adoptWaterInventory(createSolarSystem()[3]!);
    const edited = createMaterialCompositionCandidate([adopted], { gravitationalConstant: 0 }, adopted.id,
      "radius-authoritative", { rock: 0.7, iron: 0.2, gas: 0.1 })[0]!;

    expect(edited.radiusM).toBe(adopted.radiusM);
    expect(edited.waterInventory).toMatchObject({ liquidKg: adopted.waterInventory!.liquidKg, iceKg: adopted.waterInventory!.iceKg,
      vaporKg: adopted.waterInventory!.vaporKg, escapedKg: adopted.waterInventory!.escapedKg });
    expect(Math.abs((edited.materials!.rockKg + edited.materials!.ironKg + edited.materials!.gasKg) / edited.waterInventory!.dryMassKg - 1)).toBeLessThan(1e-12);
  });

  it("rejects invalid fractions atomically without changing the input world", () => {
    const earth = createSolarSystem()[3]!;
    expect(() => createMaterialCompositionCandidate([earth], { gravitationalConstant: 0 }, earth.id,
      "mass-authoritative", { rock: 0.5, iron: 0.2, gas: 0.2 })).toThrow();
    expect(earth.materials).toBeUndefined();
  });
  it("keeps water inventory mass and radius coherent across edits and records heating loss once", () => {
    const settings = { gravitationalConstant: 0 };
    const legacyEarth = createSolarSystem()[3]!;
    const adoptedEarth = adoptWaterInventory(legacyEarth);
    const heated = createBodyEditCandidate([adoptedEarth], settings, adoptedEarth.id, "surfaceTemperatureK", 700)[0]!;
    const reheated = createBodyEditCandidate([heated], settings, heated.id, "surfaceTemperatureK", 700)[0]!;
    const cooled = createBodyEditCandidate([reheated], settings, reheated.id, "surfaceTemperatureK", 260)[0]!;
    const massEdited = createBodyEditCandidate([cooled], settings, cooled.id, "massKg", cooled.massKg * 2)[0]!;
    const radiusEdited = createBodyEditCandidate([massEdited], settings, massEdited.id, "radiusM", massEdited.radiusM * 1.1)[0]!;

    expect(heated.waterInventory!.escapedKg).toBeGreaterThan(0);
    expect(reheated.waterInventory!.escapedKg).toBe(heated.waterInventory!.escapedKg);
    expect(getWaterInventoryMetrics(cooled).retainedWaterKg).toBe(getWaterInventoryMetrics(heated).retainedWaterKg);
    expect(massEdited.waterInventory!.dryMassKg).toBeGreaterThan(cooled.waterInventory!.dryMassKg);
    expect(radiusEdited.radiusM).toBeCloseTo(massEdited.radiusM * 1.1, 8);
    expect(getWaterInventoryMetrics(radiusEdited).escapedWaterKg).toBe(heated.waterInventory!.escapedKg);
    expect(() => validateSimulationState([radiusEdited], settings)).not.toThrow();
  });

  it("rejects total mass below retained water or radius below its water volume", () => {
    const settings = { gravitationalConstant: 0 };
    const adoptedEarth = adoptWaterInventory(createSolarSystem()[3]!);
    const retainedWaterKg = adoptedEarth.waterInventory!.liquidKg;

    expect(() => createBodyEditCandidate([adoptedEarth], settings, adoptedEarth.id, "massKg", retainedWaterKg * 0.5)).toThrow(/maior que a água retida/);
    expect(() => createBodyEditCandidate([adoptedEarth], settings, adoptedEarth.id, "radiusM", 1)).toThrow(/comportar o núcleo seco/);
  });

  it("rejects a field-valid edit that makes the current world exceed its acceleration limit", () => {
    const bodies = [
      { ...createSolarSystem()[0]!, id: "a", massKg: 1e32, positionM: [0, 0, 0] as const },
      { ...createSolarSystem()[0]!, id: "b", massKg: 1e32, positionM: [1e9, 0, 0] as const },
    ];
    expect(() => createBodyEditCandidate(bodies, { gravitationalConstant: 6.6743e-11 }, "a", "positionM.0", 9.5e8)).toThrow();
    expect(bodies[0]!.positionM).toEqual([0, 0, 0]);
  });

  it("allows a black hole's zero-temperature no-op and keeps its canonical temperature", () => {
    const settings = { gravitationalConstant: 6.6743e-11 };
    const blackHole = createCatalogBody("black-hole", [], null, settings);

    const edited = createBodyEditCandidate([blackHole], settings, blackHole.id, "surfaceTemperatureK", 0)[0]!;

    expect(edited.surfaceTemperatureK).toBe(0);
    expect(edited.radiusM).toBe(schwarzschildRadius(edited.massKg));
  });

  it("keeps an edited black hole at zero surface temperature", () => {
    const settings = { gravitationalConstant: 6.6743e-11 };
    const blackHole = { ...createCatalogBody("black-hole", [], null, settings), surfaceTemperatureK: 500 };

    const edited = createBodyEditCandidate([blackHole], settings, blackHole.id, "velocityMs.0", 10)[0]!;

    expect(edited.surfaceTemperatureK).toBe(0);
    expect(edited.velocityMs[0]).toBe(10);
  });

  it("rejects a nonzero surface temperature edit for a black hole with a localized error", () => {
    const settings = { gravitationalConstant: 6.6743e-11 };
    const blackHole = createCatalogBody("black-hole", [], null, settings);

    expect(() => createBodyEditCandidate([blackHole], settings, blackHole.id, "surfaceTemperatureK", 1))
      .toThrow("Buracos negros não têm temperatura de superfície editável.");
  });

  it("rejects water-surface edits for a black hole with a localized error", () => {
    const settings = { gravitationalConstant: 6.6743e-11 };
    const blackHole = createCatalogBody("black-hole", [], null, settings);

    expect(() => createBodyEditCandidate([blackHole], settings, blackHole.id, "waterFraction", 0))
      .toThrow("Buracos negros não têm água de superfície editável.");
  });

  it("preserves Schwarzschild classification and zero temperature when editing a star's radius", () => {
    const settings = { gravitationalConstant: 6.6743e-11 };
    const sun = createSolarSystem()[0]!;

    const edited = createBodyEditCandidate([sun], settings, sun.id, "radiusM", schwarzschildRadius(sun.massKg))[0]!;

    expect(edited.bodyType).toBe("black-hole");
    expect(edited.radiusM).toBe(schwarzschildRadius(edited.massKg));
    expect(edited.surfaceTemperatureK).toBe(0);
  });
});

describe("solar profile edit limits", () => {
  it("allows larger stellar radius and world coordinates only when caller supplies profile limits", () => {
    expect(parseBodyEdit("radiusM", "2.5e11")).toBeNull();
    expect(parseBodyEdit("radiusM", "2.5e11", { maxRadiusM: 3e11 })).toBe(2.5e11);
    expect(parseBodyEdit("positionM.0", "8e12")).toBeNull();
    expect(parseBodyEdit("positionM.0", "8e12", { maxPositionComponentM: 1e13 })).toBe(8e12);
    const sun = {
      ...createSolarSystem()[0]!,
      stellarEvolution: { modelId: "mist-v1.2-solar-1msun-nonrotating" as const, modelVersion: "1.2" as const, ageYears: 1e10, accretedMassKg: 0, absorbedBodyIds: [], mode: "manual" as const },
    };
    expect(getBodyEditLimits([sun], sun)).toEqual({ maxRadiusM: 3e11, maxPositionComponentM: 1e13 });
  });

  it("blocks direct edits to a secularly evolving Sun", () => {
    const world = createSolarSystem();
    world[0] = {
      ...world[0]!,
      stellarEvolution: { modelId: "mist-v1.2-solar-1msun-nonrotating", modelVersion: "1.2", ageYears: 4.58e9, accretedMassKg: 0, absorbedBodyIds: [], mode: "secular" },
    };

    expect(() => createBodyEditCandidate(world, { gravitationalConstant: 6.6743e-11 }, "sun", "massKg", 2e30)).toThrow(/encerre a evolução solar/);
  });

  it("detaches manual mass edits from solar evolution and uses edited mass for gravity", () => {
    const settings = { gravitationalConstant: 6.6743e-11 };
    const world = createSolarEvolutionCandidate(createSolarSystem());
    const transitioned = setSolarEvolutionModeCandidate(world, "manual");
    const manual = [transitioned.find(({ id }) => id === "sun")!, transitioned.find(({ id }) => id === "earth")!];
    const sun = manual.find(({ id }) => id === "sun")!;
    const earth = manual.find(({ id }) => id === "earth")!;
    const velocityBefore = sun.velocityMs;
    const accelerationBefore = Math.hypot(...calculateAccelerations(manual, settings)[manual.findIndex(({ id }) => id === "earth")]!);
    const edited = createBodyEditCandidate(manual, settings, "sun", "massKg", sun.massKg * 2);
    const editedSun = edited.find(({ id }) => id === "sun")!;
    const accelerationAfter = Math.hypot(...calculateAccelerations(edited, settings)[edited.findIndex(({ id }) => id === "earth")]!);

    expect(editedSun.stellarEvolution).toBeUndefined();
    expect(editedSun.massKg).toBe(sun.massKg * 2);
    expect(editedSun.velocityMs).toEqual(velocityBefore);
    expect(earth.velocityMs).toEqual(manual.find(({ id }) => id === "earth")!.velocityMs);
    expect(accelerationAfter / accelerationBefore).toBeCloseTo(2, 12);
  });
});
