import { describe, expect, it } from "vitest";
import { applyCenterOfMassImpulse } from "./impulse-model";
import type { CelestialBody } from "./types";

const body: CelestialBody = {
  id: "target", name: "Target", kind: "planet", massKg: 10, radiusM: 2,
  positionM: [1, 2, 3], velocityMs: [3, 4, 0], surfaceTemperatureK: 288, waterFraction: 0,
};

describe("center-of-mass-impulse-v1", () => {
  it("derives delta-v and signed external work from the applied impulse", () => {
    const result = applyCenterOfMassImpulse(body, [10, 0, 0]);

    expect(result.body.velocityMs).toEqual([4, 4, 0]);
    expect(result.deltaVelocityMs).toEqual([1, 0, 0]);
    expect(result.impulseNs).toEqual([10, 0, 0]);
    expect(result.externalWorkJ).toBe(35);
    expect(result.body.positionM).toBe(body.positionM);
    expect(result.body.spin).toBeUndefined();
  });

  it("preserves negative work when the impulse brakes the center of mass", () => {
    expect(applyCenterOfMassImpulse(body, [-10, 0, 0]).externalWorkJ).toBe(-25);
  });

  it("rejects zero, non-finite, or out-of-bound delta-v vectors", () => {
    expect(() => applyCenterOfMassImpulse(body, [0, 0, 0])).toThrow();
    expect(() => applyCenterOfMassImpulse(body, [Number.NaN, 0, 0])).toThrow();
    expect(() => applyCenterOfMassImpulse(body, [1e9, 0, 0])).toThrow();
  });
});
