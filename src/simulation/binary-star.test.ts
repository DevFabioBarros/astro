import { describe, expect, it } from "vitest";
import { advanceWorld } from "./world";
import { decodeSimulation, encodeSimulation } from "./save-file";
import { NEWTONIAN_G } from "./physical-constants";
import { createBinaryStarSystem } from "./binary-star";

const AU_M = 149_597_870_700;
const DAY_SECONDS = 86_400;

function centerOfMassPosition(bodies: ReturnType<typeof createBinaryStarSystem>["bodies"]): number[] {
  const totalMass = bodies.reduce((sum, body) => sum + body.massKg, 0);
  return [0, 1, 2].map((axis) => bodies.reduce((sum, body) => sum + body.massKg * body.positionM[axis]!, 0) / totalMass);
}

function totalMomentum(bodies: ReturnType<typeof createBinaryStarSystem>["bodies"]): number[] {
  return [0, 1, 2].map((axis) => bodies.reduce((sum, body) => sum + body.massKg * body.velocityMs[axis]!, 0));
}

describe("createBinaryStarSystem", () => {
  it("creates a symmetric solar-mass pair with a bound one-AU relative orbit", () => {
    const { bodies, settings } = createBinaryStarSystem();
    const [first, second] = bodies;

    expect(bodies).toHaveLength(2);
    expect(first?.massKg).toBe(1.9884e30);
    expect(second?.massKg).toBe(1.9884e30);
    expect(first?.radiusM).toBe(695_700_000);
    expect(second?.radiusM).toBe(695_700_000);
    expect(first?.surfaceTemperatureK).toBe(5772);
    expect(second?.surfaceTemperatureK).toBe(5772);
    expect(Math.hypot(...first!.positionM.map((value, axis) => value - second!.positionM[axis]!))).toBeCloseTo(AU_M, -3);
    expect(Math.hypot(...first!.velocityMs.map((value, axis) => value - second!.velocityMs[axis]!))).toBeCloseTo(Math.sqrt(NEWTONIAN_G * (first!.massKg + second!.massKg) / AU_M), 3);
    expect(Math.hypot(...centerOfMassPosition(bodies))).toBeLessThan(1e-3);
    expect(Math.hypot(...totalMomentum(bodies))).toBeLessThan(1e15);
    expect(settings.gravitationalConstant).toBe(NEWTONIAN_G);

    const relativeSpeed = Math.hypot(...first!.velocityMs.map((value, axis) => value - second!.velocityMs[axis]!));
    const relativeEnergy = relativeSpeed ** 2 / 2 - NEWTONIAN_G * (first!.massKg + second!.massKg) / AU_M;
    expect(relativeEnergy).toBeLessThan(0);
  });

  it("keeps the barycenter, momentum, and bound orbit stable for five periods", () => {
    const { bodies: initial, settings } = createBinaryStarSystem();
    const mass = initial[0]!.massKg + initial[1]!.massKg;
    const initialSeparation = Math.hypot(...initial[0]!.positionM.map((value, axis) => value - initial[1]!.positionM[axis]!));
    const initialRelativeSpeed = Math.hypot(...initial[0]!.velocityMs.map((value, axis) => value - initial[1]!.velocityMs[axis]!));
    const initialEnergy = initialRelativeSpeed ** 2 / 2 - NEWTONIAN_G * mass / initialSeparation;
    const periodSeconds = 2 * Math.PI * Math.sqrt(initialSeparation ** 3 / (NEWTONIAN_G * mass));
    const fivePeriods = periodSeconds * 5;
    const stepSeconds = DAY_SECONDS;
    let bodies = initial;

    for (let elapsed = 0; elapsed < fivePeriods;) {
      const step = Math.min(stepSeconds, fivePeriods - elapsed);
      bodies = advanceWorld(bodies, settings, step);
      elapsed += step;
    }

    const separation = Math.hypot(...bodies[0]!.positionM.map((value, axis) => value - bodies[1]!.positionM[axis]!));
    const relativeSpeed = Math.hypot(...bodies[0]!.velocityMs.map((value, axis) => value - bodies[1]!.velocityMs[axis]!));
    const energy = relativeSpeed ** 2 / 2 - NEWTONIAN_G * mass / separation;

    // dt/T ≈ 0.0039; Verlet is second order, so 1e-3 energy tolerance leaves >60× margin over (dt/T)².
    expect(separation).toBeGreaterThan(initialSeparation * 0.99);
    expect(separation).toBeLessThan(initialSeparation * 1.01);
    expect(Math.hypot(...centerOfMassPosition(bodies))).toBeLessThan(1e-3);
    expect(Math.hypot(...totalMomentum(bodies))).toBeLessThan(1e15);
    expect(energy).toBeLessThan(0);
    expect(Math.abs((energy - initialEnergy) / initialEnergy)).toBeLessThan(1e-3);
  });

  it("round-trips through the existing v2 import schema", () => {
    const scenario = createBinaryStarSystem();
    const restored = decodeSimulation(encodeSimulation(scenario.bodies, scenario.settings));

    expect(restored).toEqual(scenario);
  });
});
