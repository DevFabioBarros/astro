import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bodyLocalDirectionFromWorldHit, LaserPointerCapture } from "./laser-aim";
import { isLaserShotAllowedForRevision } from "@/simulation/laser-model";

describe("laser body-local aim", () => {
  it("converts a world hit through the accepted body transform and normalizes it", () => {
    const group = new THREE.Group();
    group.position.set(8, -4, 2);
    group.rotation.z = Math.PI / 2;
    group.scale.setScalar(3);
    const direction = bodyLocalDirectionFromWorldHit(group, new THREE.Vector3(8, 5, 2));
    expect(direction?.[0]).toBeCloseTo(1);
    expect(direction?.[1]).toBeCloseTo(0);
    expect(direction?.[2]).toBeCloseTo(0);
    expect(Math.hypot(...direction!)).toBeCloseTo(1);
  });

  it("rejects the center point because it has no surface direction", () => {
    expect(bodyLocalDirectionFromWorldHit(new THREE.Group(), new THREE.Vector3())).toBeNull();
  });

  it("captures a pointer and releases it on cancellation or completion", () => {
    const captured = new Set<number>();
    const target = {
      setPointerCapture: (id: number) => { captured.add(id); },
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { captured.delete(id); },
    } as unknown as Element;
    const capture = new LaserPointerCapture(target);
    expect(capture.begin(4)).toBe(true);
    expect(captured.has(4)).toBe(true);
    expect(capture.begin(5)).toBe(false);
    capture.cancel();
    expect(captured.has(4)).toBe(false);
    expect(capture.begin(6)).toBe(true);
    expect(capture.finish(6)).toBe(true);
    expect(captured.has(6)).toBe(false);
  });

  it("cancels an aimed shot and capture when another world edit becomes pending", () => {
    let laserAim: { bodyId: string } | null = { bodyId: "earth" };
    const captured = new Set<number>();
    const capture = new LaserPointerCapture({
      setPointerCapture: (id: number) => { captured.add(id); },
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { captured.delete(id); },
    } as unknown as Element);
    const pendingMutations: unknown[] = [];
    let laserMutations = 0;
    expect(capture.begin(7)).toBe(true);
    const enqueueInspectorEdit = (mutation: unknown) => {
      laserAim = null;
      capture.cancel();
      pendingMutations.push(mutation);
    };
    enqueueInspectorEdit({ type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 6e24 });
    if (isLaserShotAllowedForRevision(null, 8, 8, pendingMutations.length > 0)) laserMutations += 1;

    expect(pendingMutations).toHaveLength(1);
    expect(laserAim).toBeNull();
    expect(captured.has(7)).toBe(false);
    expect(laserMutations).toBe(0);
  });
});
