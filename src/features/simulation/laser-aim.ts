import * as THREE from "three";
import type { Vector3 } from "@/simulation/types";

export class LaserPointerCapture {
  private pointerId: number | null = null;

  constructor(private readonly target: Pick<Element, "setPointerCapture" | "releasePointerCapture" | "hasPointerCapture">) {}

  begin(pointerId: number): boolean {
    if (this.pointerId !== null) return false;
    try {
      this.target.setPointerCapture(pointerId);
      this.pointerId = pointerId;
      return true;
    } catch {
      return false;
    }
  }

  finish(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    this.release(pointerId);
    return true;
  }

  cancel(): void {
    const pointerId = this.pointerId;
    this.pointerId = null;
    if (pointerId !== null) this.release(pointerId);
  }

  private release(pointerId: number): void {
    try {
      if (this.target.hasPointerCapture(pointerId)) this.target.releasePointerCapture(pointerId);
    } catch { /* Pointer may already have been released by the browser. */ }
  }
}

export function bodyLocalDirectionFromWorldHit(bodyGroup: THREE.Object3D, worldHit: THREE.Vector3): Vector3 | null {
  bodyGroup.updateWorldMatrix(true, false);
  const localHit = bodyGroup.worldToLocal(worldHit.clone());
  if (![localHit.x, localHit.y, localHit.z].every(Number.isFinite) || localHit.lengthSq() <= 1e-18) return null;
  localHit.normalize();
  return [localHit.x, localHit.y, localHit.z];
}
