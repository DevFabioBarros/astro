import { describe, expect, it } from "vitest";
import { advanceWorld, SimulationError } from "./world";
import type { CelestialBody, PhysicsSettings } from "./types";

const settings: PhysicsSettings = { gravitationalConstant: 0 };

const body = (overrides: Partial<CelestialBody> = {}): CelestialBody => ({
  id: "earth",
  name: "Earth",
  kind: "planet",
  massKg: 5.972e24,
  radiusM: 6.371e6,
  positionM: [0, 0, 0],
  velocityMs: [1, 0, 0],
  surfaceTemperatureK: 288,
  waterFraction: 0.7,
  ...overrides,
});

describe("advanceWorld", () => {
  it("returns a new state without mutating the input", () => {
    const input = [body()];
    const output = advanceWorld(input, settings, 10);

    expect(output).not.toBe(input);
    expect(output[0]).not.toBe(input[0]);
    expect(input[0]!.positionM).toEqual([0, 0, 0]);
    expect(output[0]!.positionM).toEqual([10, 0, 0]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid timestep %s", (dt) => {
    expect(() => advanceWorld([body()], settings, dt)).toThrow(SimulationError);
  });

  it("rejects a finite timestep that overflows the resulting position", () => {
    expect(() => advanceWorld([body({ velocityMs: [2, 0, 0] })], settings, Number.MAX_VALUE))
      .toThrow(SimulationError);
  });
});
