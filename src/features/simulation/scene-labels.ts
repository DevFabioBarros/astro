import * as THREE from "three";

export type SceneLabelAnchor = { id: string; x: number; y: number; width: number; selected: boolean; focused?: boolean; depth?: number };
export type SceneLabelPlacement = SceneLabelAnchor & { labelX: number; labelY: number };
export type SceneViewport = { left: number; top: number; right: number; bottom: number };
export type SceneLabelOccluder = { x: number; y: number; radius: number; depth: number };

export function compactSceneLabel(name: string, maxLength = 14): string {
  return name.length > maxLength ? `${name.slice(0, maxLength - 1)}…` : name;
}

export function projectSceneOccluder(center: THREE.Vector3, radius: number, camera: THREE.PerspectiveCamera, width: number, height: number): SceneLabelOccluder | null {
  const cameraPoint = center.clone().applyMatrix4(camera.matrixWorldInverse);
  const depth = -cameraPoint.z;
  if (!(depth > 0) || !(radius > 0)) return null;
  const projected = center.clone().project(camera);
  const distance = center.distanceTo(camera.position);
  const projectedRadius = distance > radius
    ? (radius / Math.sqrt(distance * distance - radius * radius)) * camera.projectionMatrix.elements[5]! * height / 2
    : Number.MAX_SAFE_INTEGER;
  return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, radius: projectedRadius, depth };
}

function labelOverlapsOccluder(x: number, y: number, width: number, occluder: SceneLabelOccluder): boolean {
  const nearestX = Math.max(x - width / 2, Math.min(occluder.x, x + width / 2));
  const nearestY = Math.max(y - 12, Math.min(occluder.y, y + 12));
  return Math.hypot((nearestX - occluder.x) / occluder.radius, (nearestY - occluder.y) / occluder.radius) < 1;
}

function hiddenBehindPhotosphere(x: number, y: number, width: number, depth: number, selected: boolean, occluders: readonly SceneLabelOccluder[]): boolean {
  return !selected && occluders.some((occluder) => depth > occluder.depth && labelOverlapsOccluder(x, y, width, occluder));
}

export function layoutFocusLabel(x: number, y: number, radius: number, width: number, viewport: SceneViewport, occluders: readonly SceneLabelOccluder[] = [], depth = Number.POSITIVE_INFINITY, selected = false, focused = false): { x: number; y: number } | null {
  const halfWidth = width / 2;
  const gap = 14;
  for (const labelX of [x + radius + halfWidth + gap, x - radius - halfWidth - gap]) {
    if (labelX - halfWidth >= viewport.left && labelX + halfWidth <= viewport.right
      && y - 12 >= viewport.top && y + 12 <= viewport.bottom
      && !hiddenBehindPhotosphere(labelX, y, width, depth, selected || focused, occluders)) return { x: labelX, y };
  }
  for (const labelY of [y - radius - 12 - gap, y + radius + 12 + gap]) {
    if (x - halfWidth >= viewport.left && x + halfWidth <= viewport.right
      && labelY - 12 >= viewport.top && labelY + 12 <= viewport.bottom
      && !hiddenBehindPhotosphere(x, labelY, width, depth, selected || focused, occluders)) return { x, y: labelY };
  }
  return null;
}

/** Place text around true screen anchors; leaders preserve the physical positions. */
export function layoutSceneLabels(anchors: readonly SceneLabelAnchor[], viewport: SceneViewport, occluders: readonly SceneLabelOccluder[] = []): SceneLabelPlacement[] {
  const placed: SceneLabelPlacement[] = [];
  const sorted = [...anchors].sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.focused) - Number(a.focused) || a.id.localeCompare(b.id));
  for (const anchor of sorted) {
    let result: SceneLabelPlacement | undefined;
    for (const offset of [0, -28, 28, -56, 56, -84, 84, -112, 112, -140, 140]) {
      for (const side of [1, -1]) {
        const labelX = Math.max(viewport.left + anchor.width / 2, Math.min(viewport.right - anchor.width / 2, anchor.x + side * (anchor.width / 2 + 14)));
        const labelY = Math.max(viewport.top + 12, Math.min(viewport.bottom - 12, anchor.y + offset));
        if (placed.some((label) => Math.abs(label.labelX - labelX) < (label.width + anchor.width) / 2 + 5 && Math.abs(label.labelY - labelY) < 27)
          || hiddenBehindPhotosphere(labelX, labelY, anchor.width, anchor.depth ?? Number.POSITIVE_INFINITY, anchor.selected || !!anchor.focused, occluders)) continue;
        result = { ...anchor, labelX, labelY };
        break;
      }
      if (result) break;
    }
    if (result) placed.push(result);
  }
  return placed;
}
