import { describe, expect, it } from "vitest";
import { createBinaryStarSystem } from "./binary-star";
import { findOrbitalPrimary, getOrbitalElements } from "./orbital-analysis";
import type { CelestialBody, Vector3 } from "./types";

const settings = { gravitationalConstant: 1 };
const body = (id: string, positionM: Vector3, velocityMs: Vector3): CelestialBody => ({
  id, name: id, kind: "planet", massKg: 1, radiusM: 0.1,
  positionM, velocityMs, surfaceTemperatureK: 200, waterFraction: 0,
});
const primary = body("primary", [0, 0, 0], [0, 0, 0]);

describe("findOrbitalPrimary", () => {
  it("returns each equal-mass binary member as the other's primary", () => {
    const { bodies, settings } = createBinaryStarSystem();
    const [starA, starB] = bodies;

    expect(findOrbitalPrimary(starA!, bodies, settings)?.id).toBe(starB!.id);
    expect(findOrbitalPrimary(starB!, bodies, settings)?.id).toBe(starA!.id);
    expect(findOrbitalPrimary(starA!, [...bodies].reverse(), settings)?.id).toBe(starB!.id);
  });

  it("does not pair unrelated equal-mass bodies", () => {
    const first = body("first", [0, 0, 0], [0, 0, 0]);
    const second = body("second", [2, 0, 0], [0, 0, 0]);
    const bodies = [first, second];

    expect(findOrbitalPrimary(first, bodies, settings)).toBeUndefined();
    expect(findOrbitalPrimary(second, bodies, settings)).toBeUndefined();
  });

  it("still selects a strictly heavier unrelated body", () => {
    const target = body("target", [0, 0, 0], [0, 0, 0]);
    const equalMass = body("equal-mass", [2, 0, 0], [0, 0, 0]);
    const heavier = { ...body("heavier", [4, 0, 0], [0, 0, 0]), massKg: 2 };

    expect(findOrbitalPrimary(target, [target, equalMass, heavier], settings)?.id).toBe("heavier");
  });
});

describe("getOrbitalElements", () => {
  it.each([
    { name: "circular", speed: Math.SQRT2, eccentricity: 0, periapsisM: 1, apoapsisM: 1, bound: true },
    { name: "elliptic at apoapsis", speed: 1, eccentricity: 0.5, periapsisM: 1 / 3, apoapsisM: 1, bound: true },
    { name: "parabolic at periapsis", speed: 2, eccentricity: 1, periapsisM: 1, apoapsisM: Infinity, bound: false },
    { name: "hyperbolic at periapsis", speed: Math.sqrt(6), eccentricity: 2, periapsisM: 1, apoapsisM: Infinity, bound: false },
  ])("returns physical apsides for a $name trajectory", ({ speed, eccentricity, periapsisM, apoapsisM, bound }) => {
    const orbit = getOrbitalElements(body("orbiting", [1, 0, 0], [0, speed, 0]), primary, settings)!;

    expect(orbit.eccentricity).toBeCloseTo(eccentricity, 12);
    expect(orbit.periapsisM).toBeCloseTo(periapsisM, 12);
    if (Number.isFinite(apoapsisM)) expect(orbit.apoapsisM).toBeCloseTo(apoapsisM, 12);
    else expect(orbit.apoapsisM).toBe(Infinity);
    expect(orbit.bound).toBe(bound);
  });

  it("returns zero periapsis for a radial escape instead of NaN", () => {
    const orbit = getOrbitalElements(body("orbiting", [1, 0, 0], [2, 0, 0]), primary, settings)!;

    expect(orbit.specificEnergy).toBe(0);
    expect(orbit.periapsisM).toBe(0);
  });

  it("uses relative three-dimensional motion around a moving primary", () => {
    const movingPrimary = body("primary", [10, 20, 30], [3, 4, 5]);
    const orbit = getOrbitalElements(body("orbiting", [10, 21, 30], [3, 4, 7]), movingPrimary, settings)!;

    expect(orbit.eccentricity).toBe(1);
    expect(orbit.specificEnergy).toBe(0);
    expect(orbit.periapsisM).toBe(1);
    expect(orbit.semiMajorAxisM).toBe(Infinity);
  });
});
