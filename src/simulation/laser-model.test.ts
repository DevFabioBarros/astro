import { describe, expect, it } from "vitest";
import { createSolarSystem } from "./solar-system";
import { calculateLaserExposure, isLaserShotAllowedForRevision } from "./laser-model";

describe("grey albedo laser profile", () => {
  const earth = createSolarSystem().find(({ id }) => id === "earth")!;
  const materialized = { ...earth, materials: { modelId: "material-composition-v1" as const, rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 } };

  it("closes input, absorbed, and reflected energy for an explicit materialized target", () => {
    expect(calculateLaserExposure(materialized, 2e8, 10, "grey-albedo-laser-absorption-v1")).toEqual({
      profileId: "grey-albedo-laser-absorption-v1", albedo: 0.3,
      inputJ: 2e9, absorbedJ: 1.4e9, reflectedJ: 0.6e9,
    });
  });

  it.each([
    [0, 1, "grey-albedo-laser-absorption-v1"],
    [1e16, 1, "grey-albedo-laser-absorption-v1"],
    [1, 61, "grey-albedo-laser-absorption-v1"],
    [1, 1, "unknown-profile"],
  ])("rejects invalid laser energy or profile (%s W, %s s)", (powerW, durationSeconds, profileId) => {
    expect(() => calculateLaserExposure(materialized, powerW, durationSeconds, profileId)).toThrow();
  });

  it("refuses legacy bodies without explicit material composition", () => {
    expect(() => calculateLaserExposure(earth, 100, 1, "grey-albedo-laser-absorption-v1")).toThrow();
  });

  it("allows at most one shot for the current accepted revision", () => {
    expect(isLaserShotAllowedForRevision(null, 8, 8)).toBe(true);
    expect(isLaserShotAllowedForRevision(8, 8, 8)).toBe(false);
    expect(isLaserShotAllowedForRevision(null, 7, 8)).toBe(false);
  });

});
