import { describe, expect, it } from "vitest";
import { applyCollisionVisualHeat, COLLISION_VISUAL_HEAT_FRACTION, COLLISION_VISUAL_HEAT_HALF_LIFE_SECONDS, COLLISION_VISUAL_HEAT_MODEL_ID, decayCollisionVisualHeat, validateSurfaceHeatData } from "./surface-heat";
import type { CelestialBody } from "./types";

const body: CelestialBody = { id: "planet", name: "Planet", kind: "planet", massKg: 1e24, radiusM: 6e6,
  positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0,
  surface: { modelId: "sparse-relief-v1", seed: 3, revision: 0, resolution: 64, dataId: "planet" } };

describe("collision-visual-heat-v1", () => {
  it("stores one percent of accepted merge energy in a bounded, deterministic footprint", () => {
    const initial = { planet: [] };
    const first = applyCollisionVisualHeat([body], initial, "planet", [1, 0, 0], 1e5, 1e12);
    const total = first.planet!.reduce((sum, patch) => sum + patch.energyJ, 0);

    expect(COLLISION_VISUAL_HEAT_MODEL_ID).toBe("collision-visual-heat-v1");
    expect(total).toBeCloseTo(1e12 * COLLISION_VISUAL_HEAT_FRACTION, 4);
    expect(first).toEqual(applyCollisionVisualHeat([body], initial, "planet", [1, 0, 0], 1e5, 1e12));
    expect(first.planet!.length).toBeLessThan(64 * 32);
    expect(initial).toEqual({ planet: [] });
    validateSurfaceHeatData(first, ["planet"]);
  });

  it("decays only by accepted seconds and rejects malformed bounded sidecars", () => {
    const hot = { planet: [{ cellIndex: 10, energyJ: 8e9 }] };
    expect(decayCollisionVisualHeat(hot, 0)).toBe(hot);
    expect(decayCollisionVisualHeat(hot, COLLISION_VISUAL_HEAT_HALF_LIFE_SECONDS).planet![0]!.energyJ).toBeCloseTo(4e9);
    expect(() => validateSurfaceHeatData({ planet: [{ cellIndex: 10, energyJ: Infinity }] }, ["planet"])).toThrow();
    expect(() => decayCollisionVisualHeat(hot, -1)).toThrow();
  });
});
