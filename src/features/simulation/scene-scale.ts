import type { CollisionMode, Vector3 } from "@/simulation/types";
import type { CelestialBody } from "@/simulation/types";
import * as THREE from "three";
import type { BodyVisual } from "./celestial-bodies";
import { getBodyType } from "@/simulation/body-catalog";
import { blackHoleVisualExtent } from "./body-appearance";
import { COMET_TAIL_ENVELOPE_RADII } from "./comet-tail";
import { MAX_POSITION_COMPONENT_M, MAX_RADIUS_M } from "@/simulation/physics";
import { SOLAR_PROFILE_MAX_POSITION_COMPONENT_M, SOLAR_PROFILE_MAX_RADIUS_M } from "@/simulation/stellar-evolution-limits";

export const SCENE_UNITS_PER_METER = 1e-9;
const OVERVIEW_RADIAL_SCALE_UNITS = 30;
export const OVERVIEW_POSITION_TRANSITION_MS = 850;
export const MAX_CAMERA_DISTANCE = 300000;
export const MAX_SCENE_EXTENT_UNITS = 2 * Math.sqrt(3) * Math.max(MAX_POSITION_COMPONENT_M, SOLAR_PROFILE_MAX_POSITION_COMPONENT_M) * SCENE_UNITS_PER_METER;
export const MAX_SCENE_BODY_RADIUS = Math.max(MAX_RADIUS_M, SOLAR_PROFILE_MAX_RADIUS_M) * SCENE_UNITS_PER_METER;
export const MIN_CAMERA_DISTANCE = 1e-8;
export const MAX_CAMERA_TARGET_OFFSET = MAX_SCENE_EXTENT_UNITS;
export const MAX_CAMERA_BODY_DISTANCE = MAX_CAMERA_DISTANCE + 4 * MAX_SCENE_EXTENT_UNITS + MAX_SCENE_BODY_RADIUS;
export const CAMERA_FAR = MAX_CAMERA_BODY_DISTANCE + 2500;

export function toSceneRadius(radiusM: number): number {
  return radiusM * SCENE_UNITS_PER_METER;
}

export function assistedOverviewRadius(radius: number, bodyKind: CelestialBody["kind"], bodyType: string, cameraDistance: number, fovDegrees: number, viewportHeight: number, minimumPixelOverride?: number): number {
  if (!(radius > 0 && cameraDistance > 0 && viewportHeight > 0 && Number.isFinite(fovDegrees))) return radius;
  const minimumPixels = minimumPixelOverride ?? (bodyKind === "star" ? 16 : bodyType === "gas-giant" ? 13 : bodyType === "moon" ? 6 : bodyType === "asteroid" || bodyType === "comet" ? 3 : 10);
  const projectedPixels = radius / cameraDistance / Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2) * viewportHeight / 2;
  if (projectedPixels >= minimumPixels * 2) return radius;
  const blend = THREE.MathUtils.smoothstep(projectedPixels, minimumPixels, minimumPixels * 2);
  const assistedPixels = minimumPixels + blend * Math.max(0, projectedPixels - minimumPixels);
  return radius * assistedPixels / Math.max(projectedPixels, 1e-9);
}

export function minimumCameraDistance(bodyRadius: number): number {
  return Math.max(MIN_CAMERA_DISTANCE, bodyRadius * 1.12);
}

export function measureBodyExtent(bodies: readonly CelestialBody[], visuals: ReadonlyMap<string, BodyVisual>, appearances: ReadonlyMap<string, { radiusM: number }>, center: THREE.Vector3, collisionMode: CollisionMode = "scientific", renderedEnvelope = false): number {
  return Math.max(0.00001, ...bodies.map((body) => {
    const visual = visuals.get(body.id)!;
    const radius = getBodyType(body) === "black-hole" ? blackHoleVisualExtent(body, collisionMode) : appearances.get(body.id)?.radiusM ?? body.radiusM;
    const renderedRadius = renderedEnvelope ? visual.group.scale.x * (getBodyType(body) === "black-hole" ? blackHoleVisualExtent(body, collisionMode) / body.radiusM : 1) : toSceneRadius(radius);
    const envelope = Math.max(body.id === "saturn" ? 2.32 : 1, visual.cometTail?.mesh.visible ? COMET_TAIL_ENVELOPE_RADII : 1);
    return visual.group.position.distanceTo(center) + renderedRadius * envelope;
  }));
}

export function cachedBodyExtent(cache: { bodies?: readonly CelestialBody[]; extent: number; collisionMode?: CollisionMode; renderedEnvelope?: boolean }, bodies: readonly CelestialBody[], visuals: ReadonlyMap<string, BodyVisual>, appearances: ReadonlyMap<string, { radiusM: number }>, center: THREE.Vector3, dirty: boolean, collisionMode: CollisionMode = "scientific", renderedEnvelope = false): number {
  if (dirty || cache.bodies !== bodies || cache.collisionMode !== collisionMode || cache.renderedEnvelope !== renderedEnvelope) { cache.extent = measureBodyExtent(bodies, visuals, appearances, center, collisionMode, renderedEnvelope); cache.bodies = bodies; cache.collisionMode = collisionMode; cache.renderedEnvelope = renderedEnvelope; }
  return cache.extent;
}

export function measureOrbitExtent(group: THREE.Group, center: THREE.Vector3): number {
  let extent = 0;
  for (const line of group.children) if (line instanceof THREE.Line) {
    const points = line.geometry.getAttribute("position");
    for (let index = 0; index < points.count; index += 1) extent = Math.max(extent, new THREE.Vector3().fromBufferAttribute(points, index).add(line.position).distanceTo(center));
  }
  return extent;
}

export function toScenePosition(positionM: Vector3, originM: Vector3): [number, number, number] {
  const position = positionM.map((value, axis) => (value - originM[axis]!) * SCENE_UNITS_PER_METER);
  if (!position.every(Number.isFinite)) throw new RangeError("Body position cannot be represented in scene coordinates.");
  return position as [number, number, number];
}

/** Renderer-only radial compression for system overview; physical coordinates remain unchanged. */
export function toOverviewScenePosition(positionM: Vector3, originM: Vector3, centerM: Vector3, blend: number): [number, number, number] {
  const center = new THREE.Vector3(...toScenePosition(centerM, originM));
  const relative = new THREE.Vector3(
    (positionM[0] - centerM[0]) * SCENE_UNITS_PER_METER,
    (positionM[1] - centerM[1]) * SCENE_UNITS_PER_METER,
    (positionM[2] - centerM[2]) * SCENE_UNITS_PER_METER,
  );
  const radius = relative.length();
  if (!(radius > 0) || !Number.isFinite(radius)) return center.toArray() as [number, number, number];
  const amount = THREE.MathUtils.clamp(blend, 0, 1);
  const compressedRadius = OVERVIEW_RADIAL_SCALE_UNITS * Math.asinh(radius / OVERVIEW_RADIAL_SCALE_UNITS);
  relative.multiplyScalar(THREE.MathUtils.lerp(1, compressedRadius / radius, amount));
  return center.add(relative).toArray() as [number, number, number];
}

/** Inverse used only for converting overview pointer placement back to physical SI coordinates. */
export function fromOverviewScenePosition(scenePosition: THREE.Vector3, originM: Vector3, centerM: Vector3, blend: number): [number, number, number] {
  const centerScene = new THREE.Vector3(...toScenePosition(centerM, originM));
  const relative = scenePosition.clone().sub(centerScene);
  const mappedRadius = relative.length();
  const amount = THREE.MathUtils.clamp(blend, 0, 1);
  if (!(mappedRadius > 0) || amount === 0) {
    return [0, 1, 2].map((axis) => centerM[axis]! + relative.getComponent(axis) / SCENE_UNITS_PER_METER) as [number, number, number];
  }
  const mapRadius = (radius: number) => THREE.MathUtils.lerp(radius, OVERVIEW_RADIAL_SCALE_UNITS * Math.asinh(radius / OVERVIEW_RADIAL_SCALE_UNITS), amount);
  let low = 0, high = Math.max(mappedRadius, OVERVIEW_RADIAL_SCALE_UNITS);
  while (mapRadius(high) < mappedRadius && Number.isFinite(high)) high *= 2;
  if (!Number.isFinite(high)) throw new RangeError("Overview position cannot be mapped back to physical coordinates.");
  for (let iteration = 0; iteration < 56; iteration += 1) {
    const middle = (low + high) / 2;
    if (mapRadius(middle) < mappedRadius) low = middle;
    else high = middle;
  }
  relative.multiplyScalar(((low + high) / 2) / mappedRadius / SCENE_UNITS_PER_METER);
  return [0, 1, 2].map((axis) => centerM[axis]! + relative.getComponent(axis)) as [number, number, number];
}

export function interpolateOverviewCompression(from: number, to: number, progress: number): number {
  const normalized = THREE.MathUtils.clamp(progress, 0, 1);
  const eased = normalized * normalized * (3 - 2 * normalized);
  return THREE.MathUtils.lerp(from, to, eased);
}
