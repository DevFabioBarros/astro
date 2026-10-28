import { describe, expect, it } from "vitest";
import { MATERIAL_PROFILES, MATERIAL_PROFILE_IDS, calculateDryMaterialVolumeM3, calculateMaterialRadiusM, getMaterialCompositionView } from "./material-profiles";

describe("versioned material profile anchors", () => {
  it("names density, heat-capacity, and albedo domains by unit", () => {
    expect(MATERIAL_PROFILE_IDS).toEqual(["rock-v1", "iron-v1", "water-ice-v1", "gas-v1"]);
    for (const profile of Object.values(MATERIAL_PROFILES)) {
      expect(profile.densityKgM3.min).toBeGreaterThan(0);
      expect(profile.densityKgM3.min).toBeLessThanOrEqual(profile.densityKgM3.nominal);
      expect(profile.densityKgM3.nominal).toBeLessThanOrEqual(profile.densityKgM3.max);
      expect(profile.specificHeatJkgK.min).toBeLessThanOrEqual(profile.specificHeatJkgK.nominal);
      expect(profile.specificHeatJkgK.nominal).toBeLessThanOrEqual(profile.specificHeatJkgK.max);
      expect(profile.albedoFraction).toMatchObject({ min: 0, max: 1 });
    }
  });

  it("uses additive component volumes and derives water only from T11 retained phases", () => {
    const fractions = { rock: 0.5, iron: 0.25, gas: 0.25 };
    const expectedVolume = 1e6 * (0.5 / 3_000 + 0.25 / 7_870 + 0.25 / 1_326);
    expect(calculateDryMaterialVolumeM3(1e6, fractions)).toBeCloseTo(expectedVolume, 12);
    expect(calculateMaterialRadiusM(1e6, fractions)).toBeCloseTo(Math.cbrt(3 * expectedVolume / (4 * Math.PI)), 12);
    expect(getMaterialCompositionView({ materials: { modelId: "material-composition-v1", rockKg: 1, ironKg: 2, gasKg: 3 },
      waterInventory: { modelId: "water-inventory-v1", escapeModelId: "water-escape-retention-500-1000k-v1", dryMassKg: 6, dryVolumeM3: 1,
        liquidKg: 2, iceKg: 3, vaporKg: 4, escapedKg: 99 } })).toEqual({ modelId: "material-composition-v1", rockKg: 1, ironKg: 2, gasKg: 3, waterKg: 9 });
    expect(getMaterialCompositionView({ materials: { modelId: "material-composition-v1", rockKg: 1, ironKg: 2, gasKg: 3 },
      waterInventory: undefined })).toMatchObject({ waterKg: 0 });
  });
});
