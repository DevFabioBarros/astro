import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { SceneEventEffects } from "./scene-events";
import type { SimulationEvent } from "@/simulation/types";
import { createSolarSystem } from "@/simulation/solar-system";

const event: SimulationEvent = { id: 1, type: "explosion", timeSeconds: 10, positionM: [0, 0, 0], radiusM: 1e6, energyJ: 1e20, bodyIds: ["moon"] };
const effectGroups = (scene: THREE.Scene) => scene.children.filter((child): child is THREE.Group => child instanceof THREE.Group);

describe("scene event effects", () => {
  it("draws the impulse direction only from a validated accepted event", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const impulse: SimulationEvent = { id: 2, type: "impulse", timeSeconds: 10, positionM: [1e6, 2e6, 3e6], radiusM: 1e5,
      energyJ: 5, bodyIds: ["moon"], impulse: { modelId: "center-of-mass-impulse-v1", deltaVelocityMs: [0, 2, 0], impulseNs: [0, 10, 0], externalWorkJ: -5 } };

    effects.consume([impulse], 100, 0);

    const group = effectGroups(scene)[0];
    expect(group).toBeDefined();
    expect(group!.children.find((child) => child.name === "center-of-mass-impulse-arrow")).toBeDefined();
    effects.update(1300);
    expect(effects.hasActiveEffects).toBe(false);
    effects.dispose();
  });

  it("renders an accepted laser on its body-local hit and decays only with accepted simulation time", () => {
    const scene = new THREE.Scene();
    const bodyGroup = new THREE.Group();
    scene.add(bodyGroup);
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const laser: SimulationEvent = { id: 8, type: "laser", timeSeconds: 10, positionM: [0, 0, 0], radiusM: 10,
      energyJ: 40, bodyIds: ["moon"], laser: { modelId: "laser-energy-ledger-v1", profileId: "grey-albedo-laser-absorption-v1",
        bodyLocalDirection: [0, 1, 0], powerW: 10, durationAcceptedSeconds: 4, albedo: 0.3,
        inputJ: 40, absorbedJ: 28, reflectedJ: 12 } };
    effects.consume([laser], 100, 0, [], "scientific", () => ({ group: bodyGroup, surfaceRadius: 10 }));

    const group = bodyGroup.children.find((child) => child.name === "accepted-laser-effect") as THREE.Group | undefined;
    expect(group).toBeDefined();
    expect(group!.children.find((child) => child.name === "accepted-laser-beam")).toBeDefined();
    expect(group!.children.find((child) => child.name === "accepted-laser-visual-spot")).toBeDefined();
    effects.update(1_000_000, undefined, [], undefined, 12);
    expect((group!.children[0] as THREE.Mesh).material).toMatchObject({ opacity: expect.closeTo(0.34) });
    effects.update(1_000_001, undefined, [], undefined, 14);
    expect(bodyGroup.children).toHaveLength(0);
    effects.dispose();
  });

  it("does not draw a malformed laser event", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const invalid = { ...event, id: 9, type: "laser", laser: { modelId: "laser-energy-ledger-v1", profileId: "grey-albedo-laser-absorption-v1",
      bodyLocalDirection: [0, 0, 2], powerW: 1, durationAcceptedSeconds: 1, albedo: 0.3, inputJ: 1, absorbedJ: 0.7, reflectedJ: 0.3 } } as unknown as SimulationEvent;
    effects.consume([invalid], 100, 0, [], "scientific", () => ({ group: new THREE.Group(), surfaceRadius: 10 }));
    expect(effectGroups(scene)).toHaveLength(0);
    effects.dispose();
  });

  it("deduplicates numeric event IDs and expires effects after seven wall-clock seconds", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    effects.consume([event], 100, 0);
    expect(effects.hasActiveEffects).toBe(true);
    effects.consume([event], 500, 0);
    expect(effectGroups(scene)).toHaveLength(1);
    effects.update(7099);
    expect(effectGroups(scene)).toHaveLength(1);
    effects.update(7100);
    expect(effectGroups(scene)).toHaveLength(0);
    expect(effects.hasActiveEffects).toBe(false);
    effects.dispose();
  });

  it("renders an accepted stellar gas event even when its source star is absent from the next snapshot", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const gasEvent: SimulationEvent = { ...event, type: "explosion", energyJ: 0, bodyIds: ["sun"], visualEffect: "stellar-gas-expansion" };

    effects.consume([gasEvent], 100, 0, []);

    expect(effectGroups(scene)).toHaveLength(1);
    expect(effectGroups(scene)[0]!.children.some((child) => child.name === "stellar-gas-expansion-visual-only")).toBe(true);
    effects.dispose();
  });

  it("shows bounded collision impact, plume, and debris scaled by event radius and energy", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const collision = { ...event, type: "collision" as const, bodyIds: ["earth", "moon"] };
    const smallerImpact = { ...collision, id: 2, radiusM: 5e5, energyJ: 1e10 };
    effects.consume([collision, smallerImpact], 100, 0);
    const group = effectGroups(scene)[0]!;
    const debris = group.children.find((child) => child instanceof THREE.Points) as THREE.Points;
    const plume = group.children.find((child) => child.name === "collision-fragmentation-plume") as THREE.Mesh;
    const ring = group.children.find((child) => child.name === "collision-ring") as THREE.Mesh;
    const smallPlume = effectGroups(scene)[1]!.children.find((child) => child.name === "collision-fragmentation-plume") as THREE.Mesh;
    const camera = new THREE.PerspectiveCamera();
    camera.rotation.set(0.3, 0.6, 0);
    camera.updateMatrixWorld();
    effects.update(100, camera);
    expect(group.children.some((child) => child.name === "collision-ring")).toBe(true);
    expect((ring.material as THREE.MeshBasicMaterial).depthTest).toBe(false);
    expect((plume.material as THREE.MeshBasicMaterial).depthTest).toBe(true);
    expect((debris.material as THREE.PointsMaterial).depthTest).toBe(false);
    expect(ring.quaternion.angleTo(camera.quaternion)).toBeLessThan(1e-6);
    expect((debris.material as THREE.PointsMaterial).size).toBeGreaterThan(0.00001);
    expect(plume).toBeInstanceOf(THREE.Mesh);
    expect(plume.scale.y).toBeGreaterThan(smallPlume.scale.y);
    expect(debris.visible).toBe(true);
    expect((debris.geometry.getAttribute("position") as THREE.BufferAttribute).count).toBeGreaterThan(6);
    effects.update(1600);
    expect((debris.material as THREE.PointsMaterial).opacity).toBeLessThan(1);
    expect(plume.scale.y).toBeGreaterThan(0);
    effects.update(7100);
    expect(effectGroups(scene)).toHaveLength(0);
    effects.dispose();
  });

  it("gives collisions a brief bright contact pulse before the existing effects fade", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const collision = { ...event, type: "collision" as const, bodyIds: ["earth", "moon"] };
    effects.consume([collision, { ...event, id: 2, type: "explosion" as const }], 100, 0);
    const group = effectGroups(scene)[0]!;
    const flash = group.children.find((child) => child.name === "collision-contact-pulse") as THREE.Mesh;
    const flashMaterial = flash.material as THREE.MeshBasicMaterial;
    const ring = group.children.find((child) => child.name === "collision-ring") as THREE.Mesh;
    const plume = group.children.find((child) => child.name === "collision-fragmentation-plume") as THREE.Mesh;
    const explosion = effectGroups(scene)[1]!;
    const explosionFlash = explosion.children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry) as THREE.Mesh;

    effects.update(100);
    const initialOpacity = flashMaterial.opacity;
    const initialScale = flash.scale.x;
    effects.update(200);
    const pulseOpacity = flashMaterial.opacity;
    const pulseScale = flash.scale.x;
    const contactPlumeOpacity = (plume.material as THREE.MeshBasicMaterial).opacity;
    effects.update(340);
    const latePulseOpacity = flashMaterial.opacity;
    effects.update(549);
    const finalPulseOpacity = flashMaterial.opacity;
    effects.update(550);

    expect(initialOpacity).toBeGreaterThan(0.9);
    expect(pulseOpacity).toBeGreaterThan(0.5);
    expect(initialScale).toBeGreaterThan(pulseScale);
    expect(latePulseOpacity).toBeGreaterThan(0.45);
    expect(finalPulseOpacity).toBeGreaterThan(0);
    expect(finalPulseOpacity).toBeLessThanOrEqual(0.01);
    expect(flashMaterial.opacity).toBe(0);
    expect(contactPlumeOpacity).toBe(0);
    expect((plume.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0);
    expect((explosionFlash.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0.5);
    expect((ring.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0);
    effects.dispose();
  });

  it("uses a hollow contact pulse instead of drawing a faceted disk over the merged body", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    effects.consume([{ ...event, type: "collision" as const, bodyIds: ["earth", "mars"] }], 100, 0);
    const group = effectGroups(scene)[0]!;
    const contactPulse = group.children.find((child) => child.name === "collision-contact-pulse") as THREE.Mesh;

    expect(contactPulse.geometry).toBeInstanceOf(THREE.RingGeometry);
    expect((contactPulse.geometry as THREE.RingGeometry).parameters.innerRadius).toBeGreaterThan(0);
    effects.dispose();
  });

  it("keeps collision overlay rings within a small projected viewport radius at close zoom", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const collision = { ...event, type: "collision" as const, radiusM: 1e6, energyJ: 1e20 };
    const camera = new THREE.PerspectiveCamera(42, 1440 / 900, 1e-7, 10);
    camera.position.set(0, 0, 0.0015);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    effects.consume([collision], 100, 0);
    const ring = effectGroups(scene)[0]!.children.find((child) => child.name === "collision-ring") as THREE.Mesh;
    effects.update(1600, camera);
    ring.updateMatrixWorld(true);

    const center = ring.getWorldPosition(new THREE.Vector3()).project(camera);
    const edge = ring.localToWorld(new THREE.Vector3(0, 1.08, 0)).project(camera);
    expect(Math.abs(edge.y - center.y)).toBeLessThanOrEqual(0.18);
    effects.dispose();
  });

  it("keeps an off-center collision ring inside the free viewport near its edge", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const collision = { ...event, type: "collision" as const, positionM: [-3.5e9, 0, 0] as const, radiusM: 1e9 };
    const camera = new THREE.PerspectiveCamera(42, 1000 / 800, 0.1, 100);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -10, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const viewport = { left: 100, top: 50, right: 950, bottom: 750, width: 1000, height: 800 };
    effects.consume([collision], 100, 0);
    effects.update(300, camera, [], viewport);

    const ring = effectGroups(scene)[0]!.children.find((child) => child.name === "collision-ring") as THREE.Mesh;
    ring.updateMatrixWorld(true);
    const projectedEdges = Array.from({ length: 32 }, (_, index) => {
      const angle = index / 32 * Math.PI * 2;
      return ring.localToWorld(new THREE.Vector3(Math.cos(angle) * 1.08, Math.sin(angle) * 1.08, 0)).project(camera);
    });
    const pixelX = projectedEdges.map((point) => (point.x + 1) * viewport.width / 2);
    const pixelY = projectedEdges.map((point) => (1 - point.y) * viewport.height / 2);

    expect(Math.min(...pixelX)).toBeGreaterThanOrEqual(viewport.left);
    expect(Math.max(...pixelX)).toBeLessThanOrEqual(viewport.right);
    expect(Math.min(...pixelY)).toBeGreaterThanOrEqual(viewport.top);
    expect(Math.max(...pixelY)).toBeLessThanOrEqual(viewport.bottom);
    effects.dispose();
  });

  it("caps collision effects and disposes evicted and expired resources", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const events = Array.from({ length: 18 }, (_, id) => ({ ...event, id: id + 1, type: "collision" as const }));
    effects.consume(events, 100, 0);
    expect(effectGroups(scene)).toHaveLength(16);
    const evictedGeometry = effectGroups(scene)[0]!.children.find((child) => child instanceof THREE.Mesh)!.geometry;
    const dispose = vi.spyOn(evictedGeometry, "dispose");
    effects.consume([{ ...event, id: 99, type: "collision" }], 200, 0);
    expect(dispose).toHaveBeenCalledOnce();
    effects.update(7200);
    expect(effectGroups(scene)).toHaveLength(0);
    effects.dispose();
  });

  it("does not evict an active effect when a valid capture event is rejected", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    effects.consume(Array.from({ length: 16 }, (_, index) => ({ ...event, id: index + 1, type: "collision" as const })), 100, 0);
    const oldest = effectGroups(scene)[0]!;
    const oldestGeometry = oldest.children.find((child) => child instanceof THREE.Mesh)!.geometry;
    const disposeGeometry = vi.spyOn(oldestGeometry, "dispose");
    const rejectedCapture: SimulationEvent = { ...event, id: 99, type: "black-hole-capture", energyJ: 0, bodyIds: ["missing-bh", "missing-victim"], outcome: {
      kind: "creative-accretion", modelId: "creative-accretion-v1", captorBodyId: "missing-bh", absorbedBodyId: "missing-victim", captureRadiusM: 1e8,
    } };

    effects.consume([rejectedCapture], 200, 0, [], "creative");

    expect(effectGroups(scene)).toHaveLength(16);
    expect(oldest.parent).toBe(scene);
    expect(disposeGeometry).not.toHaveBeenCalled();
    effects.dispose();
  });

  it("clears queued effects when world generation changes", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    effects.consume([event], 100, 0);
    effects.consume([], 200, 1);
    effects.consume([event], 300, 1);
    expect(effectGroups(scene)).toHaveLength(1);
    effects.dispose();
    expect(effectGroups(scene)).toHaveLength(0);
  });

  it("does not add motion when reduced motion is requested", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], true);
    effects.consume([event], 100, 0);
    expect(effectGroups(scene)).toHaveLength(0);
    effects.dispose();
  });

  it("highlights only accepted live fragments and ends their short contact VFX", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const fragment = { ...createSolarSystem()[0]!, id: "live-fragment", bodyType: "asteroid" as const, radiusM: 1e5, positionM: [1e6, 0, 0] as const };
    const collision: SimulationEvent = { ...event, type: "collision", bodyIds: ["a", "b"], outcome: {
      kind: "creative-fragmentation", modelId: "creative-fragmentation-v1", fragmentBodyIds: ["live-fragment", "already-consumed"],
      availableEnergyJ: 1e18, fragmentKineticEnergyJ: 1e17, dissipatedEnergyJ: 1e16,
    } };
    effects.consume([collision], 100, 0, [fragment], "creative");
    const group = effectGroups(scene)[0]!;
    const fireball = group.children.find((child) => child.name === "impact-volumetric-fireball") as THREE.Mesh;
    const fireballMaterial = fireball.material as THREE.ShaderMaterial;
    const sparks = group.children.find((child) => child.name === "accepted-fragment-contact-sparks-visual-only") as THREE.Points;
    const trails = group.children.find((child) => child.name === "accepted-fragment-contact-trails-visual-only") as THREE.LineSegments;
    const light = scene.children.find((child) => child.name === "bounded-event-light") as THREE.PointLight;
    effects.update(900, undefined, [fragment]);
    expect(fireball.scale.x).toBeGreaterThan(0);
    expect(fireballMaterial.uniforms.heat.value).toBeLessThan(0.02);
    expect(sparks).toBeDefined();
    expect(trails).toBeDefined();
    expect(group.children.find((child) => child.name === "impact-instanced-rocks")).toBeUndefined();
    expect(group.children.find((child) => child.name === "accepted-live-fragments")).toBeUndefined();
    expect(light.intensity).toBe(0);
    effects.update(1499);
    expect(effects.hasActiveEffects).toBe(true);
    effects.update(1500);
    expect(effectGroups(scene)).toHaveLength(0);
    effects.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("shows accepted black-hole capture flare only in creative mode despite zero event energy", () => {
    const scene = new THREE.Scene();
    const effects = new SceneEventEffects(scene, [0, 0, 0], false);
    const capture: SimulationEvent = { ...event, id: 9, type: "black-hole-capture", bodyIds: ["bh", "rock"], energyJ: 0, outcome: {
      kind: "creative-accretion", modelId: "creative-accretion-v1", captorBodyId: "bh", absorbedBodyId: "rock", captureRadiusM: 1e8,
    } };
    const captor = { ...createSolarSystem()[0]!, id: "bh", bodyType: "black-hole" as const, radiusM: 1e3 };
    effects.consume([capture], 100, 0, [captor], "scientific");
    expect(effectGroups(scene)).toHaveLength(0);
    effects.consume([{ ...capture, id: 10 }], 100, 0, [captor], "creative");
    expect(effectGroups(scene)).toHaveLength(1);
    const captureGroup = effectGroups(scene)[0]!;
    expect(captureGroup.name).toBe("black-hole-capture-vortex-visual-only");
    expect(captureGroup.children.find((child) => child.name === "black-hole-capture-outer-vortex-visual-only")).toBeDefined();
    expect(captureGroup.children.find((child) => child.name === "black-hole-capture-spiral-particles-visual-only")).toBeDefined();
    expect(captureGroup.children.find((child) => child.name === "impact-volumetric-fireball")).toBeUndefined();
    effects.dispose();
  });
});
