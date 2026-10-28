import * as THREE from "three";
import { MAX_CAMERA_DISTANCE, MAX_SCENE_EXTENT_UNITS, minimumCameraDistance } from "./scene-scale";

type CameraControls = { target: THREE.Vector3; cursor: THREE.Vector3; minDistance: number; maxDistance: number; maxTargetRadius: number };
export type SafeCameraViewport = { left: number; top: number; right: number; bottom: number };
export type CameraFocusState = { bodyId: string | null; position: THREE.Vector3; aspect: number; fitDistance: number; fitRadius?: number; appearanceKey?: string; usableWidth?: number; usableHeight?: number };
const SATURN_RING_OUTER_RADIUS_RATIO = 2.32;

export function shouldFollowFocusedBody(focusedBodyId: string | null, selectedBodyId: string, viewRequestChanged: boolean): boolean {
  return viewRequestChanged || focusedBodyId === selectedBodyId;
}

/** Fit a bounding sphere inside both the vertical and horizontal field of view. */
export function systemCameraDistance(extent: number, aspect: number, verticalFovDegrees = 42, usableWidthFraction = 1, usableHeightFraction = 1): number {
  const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(verticalFovDegrees / 2));
  const halfVerticalFov = Math.atan(halfFovTangent * Math.max(0.01, usableHeightFraction));
  const halfHorizontalFov = Math.atan(halfFovTangent * Math.max(aspect, 0.001) * Math.max(0.01, usableWidthFraction));
  return extent / Math.sin(Math.min(halfVerticalFov, halfHorizontalFov)) * 1.08;
}

export function focusCameraFitDistance(bodyRadius: number, aspect: number, verticalFovDegrees: number, usableWidth = 1, usableHeight = 1): number {
  return systemCameraDistance(bodyRadius, aspect, verticalFovDegrees, usableWidth, usableHeight) * 1.25;
}

export function applySafeCameraViewport(camera: THREE.PerspectiveCamera, viewport: SafeCameraViewport, width: number, height: number): void {
  if (!(width > 0 && height > 0)) return;
  camera.setViewOffset(width, height, width / 2 - (viewport.left + viewport.right) / 2, height / 2 - (viewport.top + viewport.bottom) / 2, width, height);
}

function safeSolarDistance(radius: number, aspect: number, verticalFovDegrees: number, usableWidth = 1, usableHeight = 1): number {
  const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(verticalFovDegrees / 2));
  const safeHalfAngle = Math.atan(halfFovTangent * Math.min(0.76 * Math.min(aspect, 1), usableHeight, aspect * usableWidth));
  return radius / Math.sin(safeHalfAngle);
}

export function refitSystemCamera(camera: THREE.PerspectiveCamera, controls: CameraControls, center: THREE.Vector3, previousExtent: number, nextExtent: number, usableWidthFraction: number, usableHeightFraction: number): void {
  const distance = (extent: number) => systemCameraDistance(extent, camera.aspect, camera.fov, usableWidthFraction, usableHeightFraction);
  const ratio = distance(nextExtent) / distance(previousExtent);
  const cameraOffset = camera.position.clone().sub(center).multiplyScalar(ratio);
  const targetOffset = controls.target.clone().sub(center).multiplyScalar(ratio);
  const cursorOffset = controls.cursor.clone().sub(center).multiplyScalar(ratio);
  camera.position.copy(center).add(cameraOffset);
  controls.target.copy(center).add(targetOffset);
  controls.cursor.copy(center).add(cursorOffset);
}

export function followSystemExtent(camera: THREE.PerspectiveCamera, controls: CameraControls, center: THREE.Vector3, previousExtent: number, nextExtent: number, usableWidthFraction: number, usableHeightFraction: number): number {
  if (previousExtent <= 0 || Math.abs(nextExtent / previousExtent - 1) <= 0.002) return previousExtent;
  const nextDistance = systemCameraDistance(nextExtent, camera.aspect, camera.fov, usableWidthFraction, usableHeightFraction);
  refitSystemCamera(camera, controls, center, previousExtent, nextExtent, usableWidthFraction, usableHeightFraction);
  controls.maxDistance = Math.max(MAX_CAMERA_DISTANCE, nextDistance * 1.1);
  return nextExtent;
}

export function updateSystemCamera(camera: THREE.PerspectiveCamera, controls: CameraControls, center: THREE.Vector3, extent: number, previousExtent: number, viewport: { left: number; top: number; right: number; bottom: number }, width: number, height: number, reset: boolean): number {
  const usableWidth = width > 0 ? (viewport.right - viewport.left) / width : 1, usableHeight = height > 0 ? (viewport.bottom - viewport.top) / height : 1;
  if (!reset) return followSystemExtent(camera, controls, center, previousExtent, extent, usableWidth, usableHeight);
  const distance = systemCameraDistance(extent, camera.aspect, camera.fov, usableWidth, usableHeight);
  applySafeCameraViewport(camera, viewport, width, height);
  controls.maxDistance = Math.max(MAX_CAMERA_DISTANCE, distance * 1.1);
  controls.target.copy(center); controls.cursor.copy(center); controls.minDistance = 0.001;
  camera.position.copy(center).add(new THREE.Vector3(0, -1.5, 2.3).normalize().multiplyScalar(distance));
  camera.lookAt(center);
  return extent;
}

export function getSafeCameraViewport(host: HTMLElement): SafeCameraViewport {
  const root = host.closest(".astro-shell"), bounds = host.getBoundingClientRect();
  const width = host.clientWidth, height = host.clientHeight;
  if (!(width > 0 && height > 0 && (bounds.width ?? width) > 0 && (bounds.height ?? height) > 0)) return { left: 0, top: 0, right: Math.max(0, width), bottom: Math.max(0, height) };
  const [rail, navigation, tools, dock] = [".object-rail", ".planet-navigation", ".scene-tools", ".experiment-dock"].map((selector) => {
    const rect = root?.querySelector(selector)?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
  });
  const dockSpansViewport = !!dock && dock.width > width * 0.55;
  const top = Math.max(120, (tools?.bottom ?? bounds.top + 120) - bounds.top + 22, dockSpansViewport ? dock.bottom - bounds.top + 22 : 0);
  const bottom = Math.max(top + 100, (navigation?.top ?? bounds.bottom - 150) - bounds.top - 25);
  const left = Math.min(Math.max(30, dock && !dockSpansViewport ? dock.right - bounds.left + 24 : 30), Math.max(30, width - 120)), right = rail && width > 600 ? Math.max(left + 100, rail.left - bounds.left - 30) : width - 30;
  const safeBottom = Math.min(height, rail && width <= 600 ? Math.min(bottom, rail.top - bounds.top) : bottom);
  if (right - left < 100 || safeBottom - top < 100) return { left: 0, top: 0, right: width, bottom: height };
  return { left, top, right, bottom: safeBottom };
}

export function focusCameraOnBody(camera: THREE.PerspectiveCamera, controls: CameraControls, bodyId: string, position: THREE.Vector3, bodyRadius: number, state: CameraFocusState, viewport?: SafeCameraViewport, width = 1, height = 1, visualExtent = bodyRadius, minimumDistanceOverride?: number, appearanceKey?: string): void {
  const usableWidth = viewport && width > 0 ? (viewport.right - viewport.left) / width : 1;
  const usableHeight = viewport && height > 0 ? (viewport.bottom - viewport.top) / height : 1;
  const changed = state.bodyId !== bodyId;
  const offset = changed ? position.clone().sub(controls.target) : position.clone().sub(state.position);
  camera.position.add(offset);
  controls.target.add(offset);
  controls.cursor.add(offset);
  const fitRadius = Math.max(bodyId === "saturn" ? bodyRadius * SATURN_RING_OUTER_RADIUS_RATIO : bodyRadius, visualExtent);
  const nextFitDistance = focusCameraFitDistance(fitRadius, camera.aspect, camera.fov, usableWidth, usableHeight);
  const aspectChanged = camera.aspect !== state.aspect, viewportChanged = usableWidth !== (state.usableWidth ?? 1) || usableHeight !== (state.usableHeight ?? 1);
  const appearanceChanged = !changed && appearanceKey !== undefined && state.appearanceKey !== undefined && appearanceKey !== state.appearanceKey;
  const radiusChanged = bodyRadius !== state.fitRadius;
  const previousRadius = state.fitRadius ?? fitRadius;
  if (changed) {
    controls.target.copy(position);
    controls.cursor.copy(position);
    // The initial view shows the real sphere, rather than an empty astronomical distance.
    const direction = new THREE.Vector3(0.45, -3.8, 1.45).normalize();
    camera.position.copy(position).addScaledVector(direction, nextFitDistance * (bodyId === "sun" ? 1.12 : 1));
    state.bodyId = bodyId;
    state.fitDistance = nextFitDistance;
    state.fitRadius = fitRadius;
  } else if (aspectChanged || viewportChanged || appearanceChanged) {
    const distanceRatio = appearanceChanged ? nextFitDistance / state.fitDistance : focusCameraFitDistance(previousRadius, camera.aspect, camera.fov, usableWidth, usableHeight) / state.fitDistance;
    const cameraOffset = camera.position.clone().sub(controls.target).multiplyScalar(distanceRatio);
    camera.position.copy(controls.target).add(cameraOffset);
  }
  if (bodyId === "sun" && (changed || radiusChanged || aspectChanged)) {
    const cameraOffset = camera.position.clone().sub(controls.target);
    const minimumSafeDistance = safeSolarDistance(bodyRadius, camera.aspect, camera.fov, usableWidth, usableHeight);
    if (cameraOffset.length() < minimumSafeDistance) camera.position.copy(controls.target).add(cameraOffset.setLength(minimumSafeDistance));
  }
  state.fitDistance = nextFitDistance;
  state.appearanceKey = appearanceKey;
  state.usableWidth = usableWidth; state.usableHeight = usableHeight;
  state.fitRadius = fitRadius;
  state.aspect = camera.aspect;
  state.position.copy(position);
  controls.maxTargetRadius = MAX_SCENE_EXTENT_UNITS;
  controls.minDistance = Math.max(minimumCameraDistance(bodyRadius), minimumDistanceOverride ?? 0);
  const cameraOffset = camera.position.clone().sub(controls.target);
  if (cameraOffset.length() < controls.minDistance) {
    if (cameraOffset.lengthSq() === 0) cameraOffset.set(0, -1, 0);
    camera.position.copy(controls.target).add(cameraOffset.setLength(controls.minDistance));
  }
  camera.lookAt(controls.target);
}
