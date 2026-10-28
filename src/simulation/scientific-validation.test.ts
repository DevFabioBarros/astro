import { describe, expect, it } from "vitest";
import { advanceWorld } from "./world";
import { NEWTONIAN_G } from "./physical-constants";
import { createSolarSystem } from "./solar-system";
import type { CelestialBody } from "./types";

const settings = { gravitationalConstant: NEWTONIAN_G };
const AU_M = 149_597_870_700;
const DAY_SECONDS = 86_400;

function invariants(bodies: readonly CelestialBody[]) {
  let energyJ = 0;
  const momentum = [0, 0, 0];
  const angularMomentum = [0, 0, 0];
  let momentumScale = 0;
  for (let first = 0; first < bodies.length; first += 1) {
    const body = bodies[first]!;
    const [x, y, z] = body.positionM;
    const [vx, vy, vz] = body.velocityMs;
    energyJ += 0.5 * body.massKg * (vx * vx + vy * vy + vz * vz);
    momentumScale += body.massKg * Math.hypot(vx, vy, vz);
    for (let axis = 0; axis < 3; axis += 1) momentum[axis]! += body.massKg * body.velocityMs[axis]!;
    angularMomentum[0]! += body.massKg * (y * vz - z * vy);
    angularMomentum[1]! += body.massKg * (z * vx - x * vz);
    angularMomentum[2]! += body.massKg * (x * vy - y * vx);
    for (let second = first + 1; second < bodies.length; second += 1) {
      const other = bodies[second]!;
      energyJ -= NEWTONIAN_G * body.massKg * other.massKg
        / Math.hypot(...body.positionM.map((value, axis) => value - other.positionM[axis]!));
    }
  }
  return { energyJ, momentum, angularMomentum, momentumScale };
}

const difference = (first: readonly number[], second: readonly number[]) => Math.hypot(...first.map((value, axis) => value - second[axis]!));

function earthSunPair(separationM: number): CelestialBody[] {
  const preset = createSolarSystem();
  const sun = preset.find(({ id }) => id === "sun")!;
  const earth = preset.find(({ id }) => id === "earth")!;
  const totalMass = sun.massKg + earth.massKg;
  const relativeSpeed = Math.sqrt(NEWTONIAN_G * totalMass / separationM);
  return [sun, earth].map((body, index) => {
    const fraction = index === 0 ? -earth.massKg / totalMass : sun.massKg / totalMass;
    return {
      ...body,
      positionM: [fraction * separationM, 0, 0],
      velocityMs: [0, fraction * relativeSpeed * 0.6, fraction * relativeSpeed * 0.8],
    };
  });
}

describe("scientific Newtonian validation", () => {
  it("bounds energy and vector momentum drift over ten inclined Earth-Sun orbits", () => {
    let bodies = earthSunPair(AU_M);
    const initial = invariants(bodies);
    const totalMass = bodies.reduce((sum, body) => sum + body.massKg, 0);
    const periodSeconds = 2 * Math.PI * Math.sqrt(AU_M ** 3 / (NEWTONIAN_G * totalMass));
    const stepSeconds = 21_600;
    const durationSeconds = periodSeconds * 10;
    let maximumEnergyDrift = 0;
    let maximumMomentumDrift = 0;
    let maximumAngularMomentumDrift = 0;
    for (let elapsed = 0; elapsed < durationSeconds;) {
      const step = Math.min(stepSeconds, durationSeconds - elapsed);
      bodies = advanceWorld(bodies, settings, step);
      elapsed += step;
      const current = invariants(bodies);
      maximumEnergyDrift = Math.max(maximumEnergyDrift, Math.abs((current.energyJ - initial.energyJ) / initial.energyJ));
      maximumMomentumDrift = Math.max(maximumMomentumDrift, difference(current.momentum, initial.momentum) / initial.momentumScale);
      maximumAngularMomentumDrift = Math.max(maximumAngularMomentumDrift, difference(current.angularMomentum, initial.angularMomentum) / Math.hypot(...initial.angularMomentum));
    }

    // dt/T ≈ 0.00068; circular Verlet energy error is fourth order, while vector invariants accumulate roundoff.
    expect(maximumEnergyDrift).toBeLessThan(1e-8);
    expect(maximumMomentumDrift).toBeLessThan(1e-12);
    expect(maximumAngularMomentumDrift).toBeLessThan(1e-12);
    const separation = Math.hypot(...bodies[1]!.positionM.map((value, axis) => value - bodies[0]!.positionM[axis]!));
    expect(Math.abs(separation / AU_M - 1)).toBeLessThan(1e-4);
  });

  it("measures Kepler's period ratio from orbital returns at one and two AU", () => {
    const initial = earthSunPair(AU_M);
    const totalMass = initial.reduce((sum, body) => sum + body.massKg, 0);
    const expectedPeriod = 2 * Math.PI * Math.sqrt(AU_M ** 3 / (NEWTONIAN_G * totalMass));
    const stepSeconds = expectedPeriod / 2_048;
    const periods = [AU_M, AU_M * 2].map((distanceM) => {
      let bodies = earthSunPair(distanceM);
      for (let index = 1; index <= 6_200; index += 1) {
        const before = bodies[1]!.positionM[1] - bodies[0]!.positionM[1];
        bodies = advanceWorld(bodies, settings, stepSeconds);
        const after = bodies[1]!.positionM[1] - bodies[0]!.positionM[1];
        const x = bodies[1]!.positionM[0] - bodies[0]!.positionM[0];
        if (before < 0 && after >= 0 && x > 0) return (index - 1 + -before / (after - before)) * stepSeconds;
      }
      throw new Error("The body did not complete an orbit within the measurement window.");
    });

    // A measured crossing is interpolated between Verlet samples; tolerate its second-order phase error.
    expect(Math.abs(periods[0]! / expectedPeriod - 1)).toBeLessThan(1e-4);
    expect(Math.abs(periods[1]! / periods[0]! - Math.sqrt(8))).toBeLessThan(1e-4);
  });

  it("conserves invariants for the interacting three-body Sun-Earth-Moon preset", () => {
    let bodies = createSolarSystem().filter(({ id }) => ["sun", "earth", "moon"].includes(id));
    const initial = invariants(bodies);
    for (let step = 0; step < 30 * 24; step += 1) bodies = advanceWorld(bodies, settings, DAY_SECONDS / 24);
    const final = invariants(bodies);

    expect(bodies).toHaveLength(3);
    expect(bodies.flatMap(({ positionM, velocityMs }) => [...positionM, ...velocityMs]).every(Number.isFinite)).toBe(true);
    expect(Math.abs((final.energyJ - initial.energyJ) / initial.energyJ)).toBeLessThan(1e-4);
    expect(difference(final.momentum, initial.momentum) / initial.momentumScale).toBeLessThan(1e-12);
    expect(difference(final.angularMomentum, initial.angularMomentum) / Math.hypot(...initial.angularMomentum)).toBeLessThan(1e-12);
  });
});
