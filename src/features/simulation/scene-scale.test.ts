import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createSolarSystem } from "@/simulation/solar-system";
import { renderedBodyRadius } from "./body-appearance";
import { CAMERA_FAR, MAX_CAMERA_BODY_DISTANCE, MAX_SCENE_BODY_RADIUS, MAX_SCENE_EXTENT_UNITS, fromOverviewScenePosition, interpolateOverviewCompression, measureBodyExtent, minimumCameraDistance, toOverviewScenePosition, toScenePosition, toSceneRadius } from "./scene-scale";

describe("real astronomical scale", () => {
  it("includes the creative black-hole disk envelope in system framing without changing scientific extent", () => {
    const blackHole = { ...createSolarSystem()[0]!, id: "bh", bodyType: "black-hole" as const };
    const visuals = new Map([[blackHole.id, { group: new THREE.Group() } as import("./celestial-bodies").BodyVisual]]);
    const appearances = new Map<string, { radiusM: number }>();
    const center = new THREE.Vector3();
    const physical = measureBodyExtent([blackHole], visuals, appearances, center, "scientific");
    const creative = measureBodyExtent([blackHole], visuals, appearances, center, "creative");
    expect(creative).toBeCloseTo(toSceneRadius(renderedBodyRadius(blackHole)) * 32);
    expect(creative).toBeGreaterThan(physical);
  });
  it("uses the same linear factor for radii and distances", () => {
    const earthRadius = 6371008.4;
    const moonDistance = 384400000;
    const radius = toSceneRadius(earthRadius);
    const distance = toScenePosition([moonDistance, 0, 0], [0, 0, 0])[0];
    expect(distance / radius).toBeCloseTo(moonDistance / earthRadius, 10);
    expect(radius).toBeCloseTo(0.0063710084, 12);
  });
  it("keeps both maximum world extent and a close planet clear", () => {
    expect(CAMERA_FAR).toBeGreaterThan(MAX_CAMERA_BODY_DISTANCE);
    expect(minimumCameraDistance(0.006371)).toBeCloseTo(0.006371 * 1.12);
    expect(minimumCameraDistance(0.006371)).toBeGreaterThan(0.006371);
  });
  it("maps relative coordinates without mutating the physical state", () => {
    const position = [2e11, 3e11, 1000] as const;
    expect(toScenePosition(position, [1e11, 2e11, 0])).toEqual([100, 100, 0.0000010000000000000002]);
    expect(position).toEqual([2e11, 3e11, 1000]);
  });
  it("separates inner planets in overview while preserving an exact inverse for placement", () => {
    const sun = [0, 0, 0] as const, earth = [149_597_870_700, 0, 0] as const, neptune = [4_500_000_000_000, 0, 0] as const;
    const physicalRatio = earth[0] / neptune[0];
    const mappedEarth = toOverviewScenePosition(earth, sun, sun, 1);
    const mappedNeptune = toOverviewScenePosition(neptune, sun, sun, 1);
    const mappedRatio = mappedEarth[0]! / mappedNeptune[0]!;
    expect(mappedRatio).toBeGreaterThan(physicalRatio * 2);
    const restoredNeptune = fromOverviewScenePosition(new THREE.Vector3(...mappedNeptune), sun, sun, 1);
    const restoredEarth = fromOverviewScenePosition(new THREE.Vector3(...toOverviewScenePosition(earth, sun, sun, 0.45)), sun, sun, 0.45);
    expect(Math.hypot(...restoredNeptune.map((value, axis) => value - neptune[axis]))).toBeLessThan(1);
    expect(Math.hypot(...restoredEarth.map((value, axis) => value - earth[axis]))).toBeLessThan(1);
  });
  it("interpolates overview compression continuously when entering and leaving focus", () => {
    expect(interpolateOverviewCompression(1, 0, 0)).toBe(1);
    expect(interpolateOverviewCompression(1, 0, 0.5)).toBe(0.5);
    expect(interpolateOverviewCompression(1, 0, 1)).toBe(0);
    expect(interpolateOverviewCompression(0, 1, 0.25)).toBeGreaterThan(0);
    expect(interpolateOverviewCompression(0, 1, 0.25)).toBeLessThan(1);
  });
  it("covers the approved solar stellar radius and position envelope", () => {
    expect(toSceneRadius(3e11)).toBe(300);
    expect(MAX_SCENE_BODY_RADIUS).toBe(300);
    expect(toScenePosition([1e13, 1e13, 1e13], [0, 0, 0])).toEqual([10000, 10000, 10000]);
    expect(MAX_SCENE_EXTENT_UNITS).toBeGreaterThan(Math.sqrt(3) * 10000);
    expect(CAMERA_FAR).toBeGreaterThan(MAX_CAMERA_BODY_DISTANCE);
  });
});
