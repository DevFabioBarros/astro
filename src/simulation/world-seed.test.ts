import { describe, expect, it } from "vitest";
import { createExperimentPreset, EXPERIMENT_ENVIRONMENT_SEEDS_V1, type ExperimentId } from "./experiment-presets";
import { DEFAULT_ENVIRONMENT_SEED_V1, LEGACY_ENVIRONMENT_SEED_V1, isEnvironmentSeed } from "./world-seed";

describe("world environment seeds", () => {
  it("defines valid versioned defaults and an explicit stable seed for every preset", () => {
    expect(isEnvironmentSeed(DEFAULT_ENVIRONMENT_SEED_V1)).toBe(true);
    expect(isEnvironmentSeed(LEGACY_ENVIRONMENT_SEED_V1)).toBe(true);
    expect(Object.values(EXPERIMENT_ENVIRONMENT_SEEDS_V1).every(isEnvironmentSeed)).toBe(true);
    expect(new Set(Object.values(EXPERIMENT_ENVIRONMENT_SEEDS_V1)).size).toBe(Object.keys(EXPERIMENT_ENVIRONMENT_SEEDS_V1).length);
    expect(EXPERIMENT_ENVIRONMENT_SEEDS_V1).toEqual({
      "earth-mars": 0x41535401, "black-hole": 0x41535402, "extreme-sun": 0x41535403,
      "binary-stars": 0x41535404, eclipse: 0x41535405, "displaced-moon": 0x41535406, "oblique-impact": 0x41535407,
    });
    for (const [id, seed] of Object.entries(EXPERIMENT_ENVIRONMENT_SEEDS_V1)) {
      expect(createExperimentPreset(id as ExperimentId).environmentSeed).toBe(seed);
    }
  });

  it("accepts only uint32 values", () => {
    expect([0, 0xffffffff].every(isEnvironmentSeed)).toBe(true);
    expect([-1, 0x1_0000_0000, 1.5, Number.NaN, Number.POSITIVE_INFINITY].some(isEnvironmentSeed)).toBe(false);
  });
});
