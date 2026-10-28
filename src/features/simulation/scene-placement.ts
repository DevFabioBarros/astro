import * as THREE from "three";
import type { CelestialBody, OrbitalPlacementMutation, Vector3 } from "@/simulation/types";
import { MAX_ACCELERATION_MS2, MAX_POSITION_COMPONENT_M, MAX_VELOCITY_MS } from "@/simulation/physics";
import { SCENE_UNITS_PER_METER } from "./scene-scale";

const MAX_PLACEMENT_LAUNCH_SPEED_MS = MAX_VELOCITY_MS * 0.1;
const MAX_PLACEMENT_POSITION_M = MAX_POSITION_COMPONENT_M * 0.9;

export function orbitalPlacementDraftFromDrag(
  mutation: OrbitalPlacementMutation,
  anchor: THREE.Vector3,
  point: THREE.Vector3,
  planeNormal: THREE.Vector3,
): OrbitalPlacementMutation | null {
  if (!planeNormal.lengthSq() || !Number.isFinite(planeNormal.lengthSq())) return null;
  const normal = planeNormal.clone().normalize();
  const radial = point.clone().sub(anchor);
  radial.addScaledVector(normal, -radial.dot(normal));
  const radiusM = radial.length() / SCENE_UNITS_PER_METER;
  if (!(radiusM > 0) || !Number.isFinite(radiusM)) return null;
  if (mutation.type === "CREATE_ORBITAL_RING" && radiusM <= mutation.innerRadiusM) return null;
  const plane = [normal.x, normal.y, normal.z] as Vector3;
  const direction = radial.normalize().toArray() as Vector3;
  if (mutation.type === "CREATE_ORBITAL_BODY") return { ...mutation, semiMajorAxisM: radiusM, planeNormal: plane, radialDirection: direction };
  if (mutation.type === "SET_ORBITAL_PAIR") return { ...mutation, separationM: radiusM, planeNormal: plane, radialDirection: direction };
  return { ...mutation, outerRadiusM: radiusM, planeNormal: plane, radialDirection: direction };
}

export function intersectPlacementPlane(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  camera: THREE.Camera,
  target: THREE.Vector3,
  raycaster: THREE.Raycaster,
  pointer: THREE.Vector2,
  plane: THREE.Plane,
  out: THREE.Vector3,
): THREE.Vector3 | null {
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  pointer.set((clientX - bounds.left) / bounds.width * 2 - 1, -(clientY - bounds.top) / bounds.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const normal = camera.getWorldDirection(new THREE.Vector3());
  plane.setFromNormalAndCoplanarPoint(normal, target);
  return raycaster.ray.intersectPlane(plane, out);
}

export function scenePointToPositionM(point: THREE.Vector3, originM: Vector3): Vector3 {
  return [0, 1, 2].map((axis) => THREE.MathUtils.clamp(
    originM[axis]! + point.getComponent(axis) / SCENE_UNITS_PER_METER,
    -MAX_PLACEMENT_POSITION_M,
    MAX_PLACEMENT_POSITION_M,
  )) as unknown as Vector3;
}

export function placementPointOnDepth(point: THREE.Vector3, viewDirection: THREE.Vector3, offsetSceneUnits: number): THREE.Vector3 {
  return point.clone().addScaledVector(viewDirection.clone().normalize(), offsetSceneUnits);
}

export function placementLaunchVelocity(start: THREE.Vector3, end: THREE.Vector3, pixelDistance: number, speedOverrideMs?: number): Vector3 {
  const direction = end.clone().sub(start);
  if (!(pixelDistance > 5) || direction.lengthSq() === 0) return [0, 0, 0];
  const requestedSpeed = speedOverrideMs === undefined
    ? pixelDistance * MAX_PLACEMENT_LAUNCH_SPEED_MS / 180
    : Number.isFinite(speedOverrideMs) ? Math.max(0, speedOverrideMs) : 0;
  const speed = Math.min(MAX_PLACEMENT_LAUNCH_SPEED_MS, requestedSpeed);
  direction.normalize().multiplyScalar(speed);
  return [direction.x, direction.y, direction.z];
}

export function placementSafetyEnvelopeRadiusM(body: Pick<CelestialBody, "massKg" | "radiusM">, reference: Pick<CelestialBody, "massKg" | "radiusM">, gravity: number): number {
  const accelerationRadius = gravity > 0 ? Math.sqrt(gravity * Math.max(body.massKg, reference.massKg) / MAX_ACCELERATION_MS2) : 0;
  return body.radiusM + reference.radiusM + accelerationRadius;
}
