import * as THREE from "three";

const cameraPosition = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const effectPosition = new THREE.Vector3();

export type EffectViewport = { left: number; top: number; right: number; bottom: number; width: number; height: number };

export function maxEffectScale(camera: THREE.Camera | undefined, group: THREE.Group, radius: number, maxNdcRadius: number, outerRadius = 1): number {
  const boundedWorldRadius = radius * 1.6;
  if (!camera) return boundedWorldRadius;
  camera.updateWorldMatrix(true, false);
  group.getWorldPosition(effectPosition);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.getWorldPosition(cameraPosition);
    camera.getWorldDirection(cameraDirection);
    const depth = effectPosition.sub(cameraPosition).dot(cameraDirection);
    if (depth > 0) {
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * depth;
      return Math.min(boundedWorldRadius, halfHeight * maxNdcRadius / outerRadius);
    }
  } else if (camera instanceof THREE.OrthographicCamera) {
    const halfHeight = (camera.top - camera.bottom) / (2 * camera.zoom);
    return Math.min(boundedWorldRadius, halfHeight * maxNdcRadius / outerRadius);
  }
  return boundedWorldRadius;
}

export function boundedImpactScale(camera: THREE.Camera | undefined, group: THREE.Group, desiredRadius: number, sourceRadius: number, maxNdcRadius: number, outerRadius: number, viewport: EffectViewport | undefined, minimumPixels = 5): number {
  if (!camera || !viewport || !(viewport.width > 0 && viewport.height > 0 && outerRadius > 0)) {
    return Math.min(desiredRadius, maxEffectScale(camera, group, sourceRadius, maxNdcRadius, outerRadius));
  }
  camera.updateWorldMatrix(true, false);
  group.getWorldPosition(effectPosition);
  const projected = effectPosition.clone().project(camera);
  if (!projected.toArray().every(Number.isFinite) || projected.z < -1 || projected.z > 1) return 0;
  let halfHeight: number;
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.getWorldPosition(cameraPosition);
    camera.getWorldDirection(cameraDirection);
    const depth = effectPosition.sub(cameraPosition).dot(cameraDirection);
    if (!(depth > 0)) return 0;
    halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * depth;
  } else if (camera instanceof THREE.OrthographicCamera) {
    halfHeight = (camera.top - camera.bottom) / (2 * camera.zoom);
  } else {
    return Math.min(desiredRadius, maxEffectScale(camera, group, sourceRadius, maxNdcRadius, outerRadius));
  }
  const aspect = viewport.width / viewport.height;
  const leftNdc = viewport.left / viewport.width * 2 - 1;
  const rightNdc = viewport.right / viewport.width * 2 - 1;
  const topNdc = 1 - viewport.top / viewport.height * 2;
  const bottomNdc = 1 - viewport.bottom / viewport.height * 2;
  const edgeRadiusNdc = Math.min(
    (projected.x - leftNdc) * aspect,
    (rightNdc - projected.x) * aspect,
    projected.y - bottomNdc,
    topNdc - projected.y,
  ) - 2 / viewport.height;
  const maximumRadiusNdc = Math.min(maxNdcRadius, Math.max(0, edgeRadiusNdc));
  if (!(maximumRadiusNdc > 0 && halfHeight > 0)) return 0;
  const minimumRadiusNdc = Math.min(maximumRadiusNdc, minimumPixels * 2 / viewport.height);
  const minimumScale = halfHeight * minimumRadiusNdc / outerRadius;
  const maximumScale = Math.min(halfHeight * maximumRadiusNdc / outerRadius, Math.max(sourceRadius * 1.6, minimumScale));
  return Math.min(maximumScale, Math.max(minimumScale, desiredRadius));
}
