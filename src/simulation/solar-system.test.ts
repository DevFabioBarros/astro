import { describe, expect, it } from "vitest";
import { createSolarSystem } from "./solar-system";

describe("createSolarSystem", () => {
  it("loads the Sun, eight planets, and Earth–Moon system in SI units", () => {
    const bodies = createSolarSystem();
    const planets = bodies.filter((body) => body.kind === "planet");
    const moons = bodies.filter((body) => body.kind === "moon");
    const sun = bodies.find((body) => body.kind === "star");

    expect(sun?.name).toBe("Sol");
    expect(planets).toHaveLength(8);
    expect(moons.map((body) => body.name)).toContain("Lua");
    expect(bodies).toHaveLength(10);
    expect(bodies.every((body) => body.massKg > 0 && body.radiusM > 0)).toBe(true);
    expect(bodies.flatMap((body) => [...body.positionM, ...body.velocityMs]).every(Number.isFinite)).toBe(true);
  });

  it("returns independent preset bodies on each call", () => {
    const first = createSolarSystem();
    const second = createSolarSystem();

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });
});
