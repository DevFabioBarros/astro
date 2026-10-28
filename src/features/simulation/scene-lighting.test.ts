import { describe, expect, it } from "vitest";
import type { CelestialBody } from "@/simulation/types";
import { stellarColorTemperature } from "./body-appearance";
import { findStrongestEclipseBlocker, isSceneSourceOccluded, sceneExposureTarget, sceneLightSourceLimit, sceneStellarDistanceFactor, selectSceneLightSources } from "./scene-lighting";

function star(
  id: string,
  radiusM: number,
  surfaceTemperatureK: number,
  bodyType: CelestialBody["bodyType"] = "star",
): CelestialBody {
  return {
    id,
    name: id,
    kind: "star",
    bodyType,
    massKg: 1e30,
    radiusM,
    positionM: [0, 0, 0],
    velocityMs: [0, 0, 0],
    surfaceTemperatureK,
    waterFraction: 0,
  };
}

describe("selectSceneLightSources", () => {
  it("returns only the two brightest luminous bodies in luminosity order", () => {
    const dim = star("dim", 2, 3000);
    const medium = star("medium", 1, 6000);
    const bright = star("bright", 1.5, 6000);
    const blackHole = star("black-hole", 1e10, 1e9, "black-hole");
    const planet = { ...bright, id: "planet", kind: "planet" as const };

    expect(selectSceneLightSources([dim, medium, bright, blackHole, planet]).map(({ body }) => body.id))
      .toEqual(["bright", "medium"]);
  });

  it("allows the high visual profile to use four bounded stellar lights", () => {
    const stars = [1, 2, 3, 4, 5].map((factor) => star(`star-${factor}`, factor, 6000));
    const lights = selectSceneLightSources(stars, 4);

    expect(lights.map(({ body }) => body.id)).toEqual(["star-5", "star-4", "star-3", "star-2"]);
    expect(lights.reduce((total, light) => total + light.intensity, 0)).toBeLessThanOrEqual(6.4);
    expect(selectSceneLightSources(stars, 99)).toHaveLength(4);
  });

  it("keeps both equally luminous binary stars useful and colors them by accepted temperature", () => {
    const primary = star("primary", 695_700_000, 5772);
    const secondary = star("secondary", 695_700_000, 5772);

    const lights = selectSceneLightSources([primary, secondary]);

    expect(lights.map(({ body }) => body.id)).toEqual(["primary", "secondary"]);
    expect(lights[0]!.intensity).toBeGreaterThan(1);
    expect(lights[0]!.intensity).toBeCloseTo(1.6);
    expect(lights[1]!.intensity).toBe(lights[0]!.intensity);
    expect(lights[0]!.color).toEqual(stellarColorTemperature(5772));
    expect(lights[1]!.color).toEqual(stellarColorTemperature(5772));
  });

  it("keeps the aggregate visual intensity finite and within its shared budget", () => {
    const hotA = star("hot-a", 1e10, 1e9);
    const hotB = star("hot-b", 1e10, 1e9);
    const invalid = star("invalid", 1, Number.POSITIVE_INFINITY);

    const lights = selectSceneLightSources([hotA, hotB, invalid]);

    expect(lights).toHaveLength(2);
    expect(lights.every(({ intensity }) => Number.isFinite(intensity) && intensity >= 0)).toBe(true);
    expect(lights.reduce((total, { intensity }) => total + intensity, 0)).toBeLessThanOrEqual(6.4);
  });
});

describe("sceneLightSourceLimit", () => {
  it("uses two lights by default and four only for the capable high-resolution profile", () => {
    expect(sceneLightSourceLimit(1.25, 16_384)).toBe(2);
    expect(sceneLightSourceLimit(1.75, 4096)).toBe(2);
    expect(sceneLightSourceLimit(1.75, 16_384)).toBe(4);
  });
});

describe("sceneExposureTarget", () => {
  it("adapts smoothly within a narrow artistic range as lights combine", () => {
    expect(sceneExposureTarget(1.6)).toBe(1);
    expect(sceneExposureTarget(3.2)).toBeCloseTo(0.945);
    expect(sceneExposureTarget(100)).toBe(0.82);
    expect(sceneExposureTarget(Number.NaN)).toBe(1);
  });
});

describe("sceneStellarDistanceFactor", () => {
  it("keeps the one-AU anchor and applies bounded softened inverse-square falloff", () => {
    const au = 149_597_870_700;

    expect(sceneStellarDistanceFactor(au)).toBeCloseTo(1, 12);
    expect(sceneStellarDistanceFactor(2 * au)).toBeCloseTo(0.252, 2);
    expect(sceneStellarDistanceFactor(0.4 * au)).toBe(4);
    expect(sceneStellarDistanceFactor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("findStrongestEclipseBlocker", () => {
  it("selects the in-disc blocker with greatest central coverage", () => {
    const source = { ...star("source", 1e6, 5772), positionM: [0, 0, 10e6] as const };
    const target = { ...source, id: "target", kind: "planet" as const, bodyType: "rocky-planet" as const, positionM: [0, 0, 0] as const };
    const weaker = { ...source, id: "weaker", positionM: [500_000, 0, 5e6] as const, radiusM: 200_000 };
    const stronger = { ...source, id: "stronger", positionM: [0, 0, 7e6] as const, radiusM: 500_000 };

    expect(findStrongestEclipseBlocker(source, target, [source, target, weaker, stronger])?.bodyId).toBe("stronger");
  });

  it("ignores blockers outside the source disc or behind the target", () => {
    const source = { ...star("source", 1e6, 5772), positionM: [0, 0, 10e6] as const };
    const target = { ...source, id: "target", kind: "planet" as const, bodyType: "rocky-planet" as const, positionM: [0, 0, 0] as const };
    const behind = { ...source, id: "behind", positionM: [0, 0, -5e6] as const };
    const offDisc = { ...source, id: "off-disc", positionM: [3e6, 0, 5e6] as const, radiusM: 10_000 };

    expect(findStrongestEclipseBlocker(source, target, [source, target, behind, offDisc])).toBeUndefined();
  });

  it("uses the supplied rendered radius for overview eclipse selection", () => {
    const source = { ...star("source", 1e6, 5772), positionM: [0, 0, 10e6] as const };
    const target = { ...source, id: "target", kind: "planet" as const, bodyType: "rocky-planet" as const, positionM: [0, 0, 0] as const };
    const moon = { ...source, id: "moon", positionM: [800_000, 0, 5e6] as const, radiusM: 10_000 };
    const bodies = [source, target, moon];

    expect(findStrongestEclipseBlocker(source, target, bodies)).toBeUndefined();
    const assisted = findStrongestEclipseBlocker(source, target, bodies, (body) => body.id === "moon" ? 500_000 : body.radiusM);
    expect(assisted?.bodyId).toBe("moon");
    expect(assisted?.radiusM).toBe(500_000);
  });
});

describe("isSceneSourceOccluded", () => {
  it("hides a flare only when a rendered body intersects the camera-to-star segment", () => {
    const source = [0, 0, 10] as const;
    const observer = [0, 0, 0] as const;
    const body = { id: "planet", position: [0, 0, 5] as const, radius: 1 };

    expect(isSceneSourceOccluded("sun", source, observer, [body])).toBe(true);
    expect(isSceneSourceOccluded("sun", source, observer, [{ ...body, position: [3, 0, 5] as const }])).toBe(false);
    expect(isSceneSourceOccluded("sun", source, observer, [{ ...body, position: [0, 0, 12] as const }])).toBe(false);
    expect(isSceneSourceOccluded("sun", source, observer, [{ ...body, id: "sun" }])).toBe(false);
  });
});
