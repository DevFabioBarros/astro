import { describe, expect, it } from "vitest";
import { velocityVerletStep } from "./integrator";
import type { CelestialBody, PhysicsSettings } from "./types";

const settings: PhysicsSettings = { gravitationalConstant: 1 };

const body = (
  id: string,
  positionM: CelestialBody["positionM"],
  velocityMs: CelestialBody["velocityMs"],
): CelestialBody => ({
  id,
  name: id,
  kind: "planet",
  massKg: 1,
  radiusM: 0.1,
  positionM,
  velocityMs,
  surfaceTemperatureK: 288,
  waterFraction: 0,
});

describe("velocityVerletStep", () => {
  it("produces the same state for the same input", () => {
    const bodies = [body("a", [-0.5, 0, 0], [0, -Math.sqrt(0.5), 0]), body("b", [0.5, 0, 0], [0, Math.sqrt(0.5), 0])];

    expect(velocityVerletStep(bodies, settings, 0.01)).toEqual(
      velocityVerletStep(bodies, settings, 0.01),
    );
  });

  it("keeps energy drift bounded over one two-body orbital period", () => {
    const bodies = [body("a", [-0.5, 0, 0], [0, -Math.sqrt(0.5), 0]), body("b", [0.5, 0, 0], [0, Math.sqrt(0.5), 0])];
    const period = (2 * Math.PI) / Math.sqrt(2);
    const step = period / 500;
    let state = bodies;

    for (let i = 0; i < 500; i += 1) state = velocityVerletStep(state, settings, step);

    const distance = Math.hypot(...state[1]!.positionM.map((value, index) => value - state[0]!.positionM[index]!) as [number, number, number]);
    const kinetic = state.reduce((sum, item) => sum + 0.5 * item.massKg * item.velocityMs.reduce((v2, value) => v2 + value * value, 0), 0);
    const energy = kinetic - (state[0]!.massKg * state[1]!.massKg) / distance;

    expect(Math.abs(energy + 0.5) / 0.5).toBeLessThan(1e-4);
    expect(state[0]!.positionM[0]).toBeCloseTo(-0.5, 3);
    expect(state[1]!.positionM[0]).toBeCloseTo(0.5, 3);
  });
});
