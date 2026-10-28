import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { layoutFocusLabel, layoutSceneLabels, projectSceneOccluder } from "./scene-labels";

describe("system labels", () => {
  it.each([
    { name: "wide", width: 1440, height: 900, distance: 2400 },
    { name: "narrow", width: 320, height: 740, distance: 3200 },
  ])("uses projected solar radius to keep giant-background labels off the photosphere on $name viewports", ({ width, height, distance }) => {
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 10000);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const center = new THREE.Vector3(0, 0, 0);
    const anchorDisk = projectSceneOccluder(center, 1, camera, width, height)!;
    const giantDisk = projectSceneOccluder(center, 343, camera, width, height)!;
    expect(giantDisk.radius).toBeGreaterThan(anchorDisk.radius * 300);

    const centerX = width / 2, centerY = height / 2;
    const viewport = { left: 0, top: 0, right: width, bottom: height };
    const behind = { id: "behind", x: centerX + giantDisk.radius * 0.2, y: centerY, width: 70, selected: false, depth: distance + 100 };
    const foreground = { ...behind, id: "foreground", depth: distance - 100 };
    const outside = { ...behind, id: "outside", x: centerX + giantDisk.radius + 80 };

    const anchorPlacement = layoutSceneLabels([{ ...behind, depth: distance + 100 }], viewport, [anchorDisk]);
    const giantPlacements = layoutSceneLabels([behind, foreground, outside], viewport, [giantDisk]);

    expect(anchorPlacement).toHaveLength(1);
    expect(giantPlacements.map(({ id }) => id)).toContain("foreground");
    expect(giantPlacements.map(({ id }) => id)).toContain("outside");
    for (const label of giantPlacements.filter(({ id }) => id === "behind")) {
      const nearestX = Math.max(label.labelX - label.width / 2, Math.min(giantDisk.x, label.labelX + label.width / 2));
      const nearestY = Math.max(label.labelY - 12, Math.min(giantDisk.y, label.labelY + 12));
      expect(Math.hypot((nearestX - giantDisk.x) / giantDisk.radius, (nearestY - giantDisk.y) / giantDisk.radius)).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([
    { name: "wide", width: 1440, height: 900, distance: 2400 },
    { name: "narrow", width: 320, height: 740, distance: 3200 },
  ])("retains the selected label over a giant on $name viewports", ({ width, height, distance }) => {
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 10000);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const disk = projectSceneOccluder(new THREE.Vector3(), 343, camera, width, height)!;
    const label = { id: "selected", x: width / 2, y: height / 2, width: 70, selected: true, depth: distance + 100 };
    expect(layoutSceneLabels([label], { left: 0, top: 0, right: width, bottom: height }, [disk])).toHaveLength(1);
  });

  it.each([
    { name: "wide", width: 1440, height: 900, distance: 2400 },
    { name: "narrow", width: 320, height: 740, distance: 3200 },
  ])("preserves keyboard focus and filters focused-view labels on $name viewports", ({ width, height, distance }) => {
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 10000);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const disk = projectSceneOccluder(new THREE.Vector3(), 343, camera, width, height)!;
    const x = width / 2 + disk.radius * 0.2, y = height / 2;
    const viewport = { left: 0, top: 0, right: width, bottom: height };
    const focused = { id: "keyboard", x, y, width: 70, selected: false, focused: true, depth: distance + 100 };

    expect(layoutSceneLabels([focused], viewport, [disk])).toHaveLength(1);
    expect(layoutFocusLabel(x, y, 15, 70, viewport, [disk], distance + 100)).toBeNull();
    expect(layoutFocusLabel(x, y, 15, 70, viewport, [disk], distance - 100)).not.toBeNull();
  });

  it("keeps overlapping inner-planet labels apart without moving their anchors", () => {
    const anchors = ["sun", "mercury", "venus", "earth", "moon"].map((id, index) => ({ id, x: 500 + index, y: 340 + index, width: 65, selected: id === "earth" }));
    const placed = layoutSceneLabels(anchors, { left: 30, top: 150, right: 1000, bottom: 650 });
    expect(placed).toHaveLength(5);
    expect(placed[0]!.id).toBe("earth");
    for (const label of placed) {
      expect(label.x).toBe(anchors.find((anchor) => anchor.id === label.id)!.x);
      for (const other of placed) if (other !== label) {
        expect(Math.abs(label.labelX - other.labelX) >= (label.width + other.width) / 2 + 5 || Math.abs(label.labelY - other.labelY) >= 27).toBe(true);
      }
    }
  });
  it("clamps text into the available scene area at edges", () => {
    const placed = layoutSceneLabels([{ id: "neptune", x: 998, y: 151, width: 70, selected: false }], { left: 30, top: 150, right: 1000, bottom: 650 });
    expect(placed[0]!.labelX + 35).toBeLessThanOrEqual(1000);
    expect(placed[0]!.labelY - 12).toBeGreaterThanOrEqual(150);
  });

  it("places a focus label outside the visible body disk or hides it when no side fits", () => {
    const viewport = { left: 0, top: 0, right: 1000, bottom: 700 };
    const placement = layoutFocusLabel(500, 350, 240, 90, viewport);
    expect(placement).not.toBeNull();
    expect(placement!.x - 45).toBeGreaterThan(740);
    expect(layoutFocusLabel(500, 350, 480, 90, viewport)).toBeNull();
  });

  it("tries vertical focus-label slots when neither side fits a mobile viewport", () => {
    const x = 160, y = 370, radius = 90;
    const placement = layoutFocusLabel(x, y, radius, 160, { left: 0, top: 0, right: 320, bottom: 740 });

    expect(placement).not.toBeNull();
    expect(placement!.x).toBe(x);
    expect(Math.abs(placement!.y - y)).toBeGreaterThan(radius + 12);
    expect(placement!.y - 12).toBeGreaterThanOrEqual(0);
    expect(placement!.y + 12).toBeLessThanOrEqual(740);
  });

  it("rejects vertical focus-label slots when centered x falls outside the viewport", () => {
    expect(layoutFocusLabel(50, 370, 10, 70, { left: 100, top: 0, right: 320, bottom: 740 })).toBeNull();
  });
});
