import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applySafeCameraViewport, focusCameraOnBody, getSafeCameraViewport, refitSystemCamera, shouldFollowFocusedBody, systemCameraDistance, type SafeCameraViewport } from "./camera-focus";
import { CAMERA_FAR, MAX_CAMERA_BODY_DISTANCE, MAX_SCENE_BODY_RADIUS, MAX_SCENE_EXTENT_UNITS } from "./scene-scale";

function setup() {
  return { camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), cursor: new THREE.Vector3(), minDistance: 0, maxDistance: 0, maxTargetRadius: 0 }, state: { bodyId: null as string | null, position: new THREE.Vector3(), aspect: 1, fitDistance: 0 } };
}

describe("focusCameraOnBody", () => {
  it("keeps camera on its current view when an accepted snapshot changes selection without a focus request", () => {
    expect(shouldFollowFocusedBody("mars", "asteroid-1", false)).toBe(false);
    expect(shouldFollowFocusedBody("mars", "mars", false)).toBe(true);
    expect(shouldFollowFocusedBody("mars", "asteroid-1", true)).toBe(true);
  });
  it("reserves the inspector and dock space when framing the system", () => {
    const extent = 5000, aspect = 1.6;
    const distance = systemCameraDistance(extent, aspect, 42, 0.75, 0.55);
    const angularRadius = Math.asin(extent / distance);
    expect(angularRadius).toBeLessThan(Math.atan(Math.tan(THREE.MathUtils.degToRad(21)) * 0.55));
    expect(angularRadius).toBeLessThan(Math.atan(Math.tan(THREE.MathUtils.degToRad(21)) * aspect * 0.75));
  });
  it("frames the largest supported system in a portrait viewport without camera clamping", () => {
    const extent = MAX_SCENE_EXTENT_UNITS + MAX_SCENE_BODY_RADIUS;
    const aspect = 0.25;
    const distance = systemCameraDistance(extent, aspect);
    const angularRadius = Math.asin(extent / distance);
    const horizontalHalfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(21)) * aspect);
    expect(angularRadius).toBeLessThan(horizontalHalfFov);
    expect(distance).toBeLessThan(MAX_CAMERA_BODY_DISTANCE);
    expect(distance + extent).toBeLessThan(CAMERA_FAR);
  });
  it("refits expanded system while preserving pan and zoom ratios", () => {
    const { camera, controls } = setup();
    const center = new THREE.Vector3(3, 4, 5);
    camera.position.set(12, -8, 15);
    controls.target.set(4, 6, 5);
    controls.cursor.set(5, 7, 5);
    const oldFit = systemCameraDistance(10, camera.aspect, camera.fov);
    const newFit = systemCameraDistance(30, camera.aspect, camera.fov);
    const zoomRatio = camera.position.distanceTo(controls.target) / oldFit;
    const pan = controls.target.clone().sub(center);
    refitSystemCamera(camera, controls, center, 10, 30, 1, 1);
    expect(controls.target.clone().sub(center).distanceTo(pan.multiplyScalar(newFit / oldFit))).toBeLessThan(1e-12);
    expect(camera.position.distanceTo(controls.target) / newFit).toBeCloseTo(zoomRatio, 10);
  });
  it("frames a real sized sphere on selection", () => {
    const { camera, controls, state } = setup();
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(140, 50, 0), 0.006371, state);
    expect(controls.target.toArray()).toEqual([140, 50, 0]);
    expect(camera.position.distanceTo(controls.target) / 0.006371).toBeCloseTo(3.195, 2);
    expect(controls.minDistance).toBeCloseTo(0.006371 * 1.025);
  });
  it("centers focused target in safe viewport and fits its diameter there", () => {
    const { camera, controls, state } = setup();
    const safe: SafeCameraViewport = { left: 100, top: 100, right: 900, bottom: 700 };
    camera.aspect = 1.6;
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(5, 0, 0), 1, state, safe, 1000, 800);
    applySafeCameraViewport(camera, safe, 1000, 800);
    camera.lookAt(controls.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const projected = controls.target.clone().project(camera);
    expect((projected.x + 1) * 500).toBeCloseTo(500);
    expect((1 - projected.y) * 400).toBeCloseTo(400);
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(1 / Math.sin(THREE.MathUtils.degToRad(21) * 0.75));
  });
  it("preserves zoom ratio when safe viewport changes", () => {
    const { camera, controls, state } = setup();
    const full: SafeCameraViewport = { left: 0, top: 0, right: 1200, bottom: 800 };
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(), 1, state, full, 1200, 800);
    camera.position.setLength(camera.position.length() * 1.5);
    const zoom = camera.position.distanceTo(controls.target) / state.fitDistance;
    const narrow: SafeCameraViewport = { left: 0, top: 128, right: 1200, bottom: 584 };
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(), 1, state, narrow, 1200, 800);
    expect(camera.position.distanceTo(controls.target) / state.fitDistance).toBeCloseTo(zoom, 8);
  });
  it("falls back to a finite full viewport for degenerate host geometry", () => {
    const host = { clientWidth: 0, clientHeight: 0, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) };
    expect(getSafeCameraViewport(host as unknown as HTMLElement)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(Number.isFinite(systemCameraDistance(1, 0, 42, 0, 0))).toBe(true);
  });
  it("frames Earth, Jupiter, and Saturn close enough for their maps to read while preserving physical radii", () => {
    const { camera, controls, state } = setup();
    camera.fov = 42;
    const radii = [0.006371, 0.069911, 0.058232];

    for (const [index, radius] of radii.entries()) {
      focusCameraOnBody(camera, controls, ["earth", "jupiter", "saturn"][index]!, new THREE.Vector3(), radius, state);
      const distance = camera.position.distanceTo(controls.target);
      const projectedDiameter = Math.tan(Math.asin(radius / distance)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      expect(projectedDiameter).toBeGreaterThan(index === 2 ? 0.25 : 0.65);
      expect(projectedDiameter).toBeLessThan(index === 2 ? 0.4 : 0.8);
      expect(controls.minDistance).toBeGreaterThanOrEqual(radius * 1.12);
      expect(controls.minDistance).toBeLessThanOrEqual(radius * 1.13);
    }
  });
  it.each([
    { name: "desktop safe rect", width: 1440, height: 900, rect: { left: 60, top: 110, right: 1080, bottom: 760 } },
    { name: "portrait asymmetric safe rect", width: 390, height: 844, rect: { left: 14, top: 128, right: 376, bottom: 356 } },
    { name: "320 by 740 mobile safe rect", width: 320, height: 740, rect: { left: 12, top: 128, right: 308, bottom: 304 } },
  ])("keeps Saturn's complete outer ring inside the $name", ({ width, height, rect }) => {
    const { camera, controls, state } = setup();
    const radius = 0.058232, ringOuterRadius = radius * 2.32;
    camera.aspect = width / height; camera.up.set(0, 0, 1);
    focusCameraOnBody(camera, controls, "saturn", new THREE.Vector3(), radius, state, rect, width, height);
    applySafeCameraViewport(camera, rect, width, height);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const ringRotation = new THREE.Euler(0.47, 0, 0);
    const ringVertices = Array.from({ length: 128 }, (_, index) => new THREE.Vector3(
      ringOuterRadius * Math.cos(index * Math.PI / 64), ringOuterRadius * Math.sin(index * Math.PI / 64), 0,
    ).applyEuler(ringRotation).project(camera));
    const screen = ringVertices.map(({ x, y }) => ({ x: (x + 1) * width / 2, y: (1 - y) * height / 2 }));
    const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const planetEdge = controls.target.clone().addScaledVector(cameraUp, radius).project(camera);
    const planetDiameterFraction = Math.abs(planetEdge.y) * height / (rect.bottom - rect.top) * 2;
    expect(Math.min(...screen.map((point) => point.x))).toBeGreaterThanOrEqual(rect.left);
    expect(Math.max(...screen.map((point) => point.x))).toBeLessThanOrEqual(rect.right);
    expect(Math.min(...screen.map((point) => point.y))).toBeGreaterThanOrEqual(rect.top);
    expect(Math.max(...screen.map((point) => point.y))).toBeLessThanOrEqual(rect.bottom);
    expect(planetDiameterFraction).toBeGreaterThan(0.25);
  });
  it("preserves manual Saturn zoom until focus or viewport changes", () => {
    const { camera, controls, state } = setup();
    focusCameraOnBody(camera, controls, "saturn", new THREE.Vector3(), 0.058232, state);
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, state.fitDistance * 1.6);
    const manualDistance = camera.position.distanceTo(controls.target);
    focusCameraOnBody(camera, controls, "saturn", new THREE.Vector3(), 0.058232, state);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(manualDistance, 10);
  });
  it("preserves user pan and zoom while following physical movement", () => {
    const { camera, controls, state } = setup();
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(10, 20, 30), 5, state);
    camera.position.x += 100;
    controls.target.x += 100;
    const beforeCamera = camera.position.clone(), beforeTarget = controls.target.clone();
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(11, 22, 30), 5, state);
    expect(camera.position.clone().sub(beforeCamera).toArray()).toEqual([1, 2, 0]);
    expect(controls.target.clone().sub(beforeTarget).toArray()).toEqual([1, 2, 0]);
  });
  it("keeps user camera and target fixed as stellar radius changes", () => {
    const { camera, controls, state } = setup();
    camera.aspect = 1.6;
    focusCameraOnBody(camera, controls, "sun", new THREE.Vector3(), 350, state);
    camera.position.add(new THREE.Vector3(5, 2, 1));
    controls.target.add(new THREE.Vector3(5, 2, 1));
    const beforeCamera = camera.position.clone();
    const beforeTarget = controls.target.clone();

    focusCameraOnBody(camera, controls, "sun", new THREE.Vector3(), 0.014, state);

    expect(camera.position.distanceTo(beforeCamera)).toBeLessThan(1e-12);
    expect(controls.target.distanceTo(beforeTarget)).toBeLessThan(1e-12);
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(0.014 * 1.025);
  });
  it("frames the creative black-hole disk completely inside portrait safe area while keeping horizon zoom available", () => {
    const { camera, controls, state } = setup();
    const safe = { left: 14, top: 128, right: 376, bottom: 716 };
    const width = 390, height = 844, rs = 0.00003, diskOuter = rs * 24, visualExtent = rs * 32;
    camera.aspect = width / height;
    focusCameraOnBody(camera, controls, "bh", new THREE.Vector3(), rs * 8, state, safe, width, height, visualExtent);
    applySafeCameraViewport(camera, safe, width, height);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const edge = Array.from({ length: 96 }, (_, index) => {
      const angle = index * Math.PI / 48;
      return new THREE.Vector3(diskOuter * Math.cos(angle), diskOuter * Math.sin(angle), 0).project(camera);
    });
    const pixels = edge.map(({ x, y }) => ({ x: (x + 1) * width / 2, y: (1 - y) * height / 2 }));
    expect(Math.min(...pixels.map((point) => point.x))).toBeGreaterThanOrEqual(safe.left);
    expect(Math.max(...pixels.map((point) => point.x))).toBeLessThanOrEqual(safe.right);
    expect(Math.min(...pixels.map((point) => point.y))).toBeGreaterThanOrEqual(safe.top);
    expect(Math.max(...pixels.map((point) => point.y))).toBeLessThanOrEqual(safe.bottom);
    expect(controls.minDistance).toBeCloseTo(rs * 8 * 1.12);
  });
  it("keeps accepted MIST solar growth visible and inside the frame, including a viewport resize", () => {
    const { camera, controls, state } = setup();
    const solarRadius = 0.6957;
    const mistRadius = solarRadius * 1.52;
    camera.aspect = 1.6;
    const projectedFraction = (radius: number) => {
      const vertical = Math.tan(Math.asin(radius / camera.position.distanceTo(controls.target)))
        / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      return Math.max(vertical, vertical / camera.aspect);
    };

    focusCameraOnBody(camera, controls, "sun", new THREE.Vector3(), solarRadius, state);
    const initial = projectedFraction(solarRadius);
    camera.aspect = 1.5;
    camera.updateProjectionMatrix();
    focusCameraOnBody(camera, controls, "sun", new THREE.Vector3(), mistRadius, state);

    const final = projectedFraction(mistRadius);
    expect(final).toBeGreaterThan(initial);
    expect(final / initial).toBeGreaterThan(1.1);
    expect(final).toBeLessThan(0.8);
  });
  it("does not undo manual solar zoom while accepted radius and viewport stay fixed", () => {
    const { camera, controls, state } = setup();
    const radius = 0.6957;
    focusCameraOnBody(camera, controls, "sun", new THREE.Vector3(), radius, state);
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, radius * 2.5);

    focusCameraOnBody(camera, controls, "sun", new THREE.Vector3(), radius, state);

    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(radius * 2.5, 10);
  });
  it("refits 480 px and 320 px viewports while preserving direction and user zoom", () => {
    const { camera, controls, state } = setup();
    const radius = 0.006371;
    camera.aspect = 1.6;
    focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(), radius, state);
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, state.fitDistance * 1.4);

    for (const aspect of [0.6, 0.4, 0.6]) {
      const target = controls.target.clone();
      camera.aspect = aspect;
      focusCameraOnBody(camera, controls, "earth", new THREE.Vector3(), radius, state);
      const offset = camera.position.clone().sub(controls.target);
      expect(controls.target.distanceTo(target)).toBe(0);
      expect(offset.clone().normalize().distanceTo(direction)).toBeLessThan(1e-10);
      expect(offset.length() / state.fitDistance).toBeCloseTo(1.4, 8);
    }
  });
});
