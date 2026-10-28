import * as THREE from "three";
import type { CelestialBody, SimulationEvent, Vector3 } from "@/simulation/types";
import { getBodyType } from "@/simulation/body-catalog";
import { toScenePosition, toSceneRadius } from "./scene-scale";
import { boundedImpactScale, type EffectViewport } from "./scene-effect-scale";

export const CAPTURE_LIFETIME_MS = 4500;
const CAPTURE_PARTICLE_COUNT = 64;

export type BlackHoleCaptureEffect = {
  kind: "black-hole-capture";
  id: number;
  startedAt: number;
  group: THREE.Group;
  radius: number;
  captorId: string;
  outerRing: THREE.Mesh;
  innerRing: THREE.Mesh;
  stream: THREE.Points;
};

export function isAcceptedCaptureEvent(event: SimulationEvent, bodies: readonly CelestialBody[]): event is SimulationEvent & {
  type: "black-hole-capture";
  outcome: { kind: "creative-accretion"; modelId: "creative-accretion-v1"; captorBodyId: string; absorbedBodyId: string; captureRadiusM: number };
} {
  if (event.type !== "black-hole-capture" || event.energyJ !== 0 || event.bodyIds.length !== 2) return false;
  const outcome = event.outcome;
  if (!outcome || outcome.kind !== "creative-accretion" || outcome.modelId !== "creative-accretion-v1"
    || event.bodyIds[0] !== outcome.captorBodyId || event.bodyIds[1] !== outcome.absorbedBodyId
    || !outcome.captorBodyId || !outcome.absorbedBodyId || outcome.captorBodyId === outcome.absorbedBodyId
    || !Number.isFinite(outcome.captureRadiusM) || outcome.captureRadiusM <= 0) return false;
  const captor = bodies.find((body) => body.id === outcome.captorBodyId);
  return !!captor && getBodyType(captor) === "black-hole" && !bodies.some((body) => body.id === outcome.absorbedBodyId);
}

export function createBlackHoleCaptureEffect(
  scene: THREE.Scene,
  event: SimulationEvent & { type: "black-hole-capture"; outcome: { kind: "creative-accretion"; modelId: "creative-accretion-v1"; captorBodyId: string; absorbedBodyId: string; captureRadiusM: number } },
  now: number,
  origin: Vector3,
): BlackHoleCaptureEffect {
  const radius = Math.min(1000, Math.max(0.0002, toSceneRadius(event.outcome.captureRadiusM)));
  const group = new THREE.Group();
  group.name = "black-hole-capture-vortex-visual-only";
  group.position.fromArray(toScenePosition(event.positionM, origin));
  group.userData.visualOnly = true;
  const outerRing = new THREE.Mesh(new THREE.RingGeometry(0.84, 0.91, 96), new THREE.MeshBasicMaterial({ color: 0x37eaff, transparent: true, opacity: 1, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
  outerRing.name = "black-hole-capture-outer-vortex-visual-only";
  const innerRing = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.55, 72), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
  innerRing.name = "black-hole-capture-inner-vortex-visual-only";
  const streamGeometry = new THREE.BufferGeometry();
  streamGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(CAPTURE_PARTICLE_COUNT * 3), 3));
  const stream = new THREE.Points(streamGeometry, new THREE.PointsMaterial({ color: 0x8af5ff, size: 5, sizeAttenuation: false, transparent: true, opacity: 1, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  stream.name = "black-hole-capture-spiral-particles-visual-only";
  outerRing.renderOrder = 9;
  innerRing.renderOrder = 10;
  stream.renderOrder = 11;
  group.add(outerRing, innerRing, stream);
  scene.add(group);
  return { kind: "black-hole-capture", id: event.id, startedAt: now, group, radius, captorId: event.outcome.captorBodyId, outerRing, innerRing, stream };
}

export function updateBlackHoleCaptureEffect(
  effect: BlackHoleCaptureEffect,
  now: number,
  camera: THREE.Camera | undefined,
  bodies: readonly CelestialBody[],
  origin: Vector3,
  light: THREE.PointLight,
  viewport: EffectViewport | undefined,
): boolean {
  const captor = bodies.find((body) => body.id === effect.captorId && getBodyType(body) === "black-hole");
  if (!captor) return false;
  const progress = THREE.MathUtils.clamp((now - effect.startedAt) / CAPTURE_LIFETIME_MS, 0, 1);
  const fade = (1 - progress) ** 3;
  effect.group.position.fromArray(toScenePosition(captor.positionM, origin));
  if (camera) effect.group.quaternion.copy(camera.quaternion);
  const age = Math.max(0, now - effect.startedAt) / 1000;
  const radius = boundedImpactScale(camera, effect.group, effect.radius, effect.radius, 0.3, 1.15, viewport, 22);
  effect.outerRing.scale.setScalar(radius * (0.8 + progress * 0.35));
  effect.innerRing.scale.setScalar(radius * (0.58 - progress * 0.3));
  effect.outerRing.rotation.z = age * 0.9;
  effect.innerRing.rotation.z = -age * 1.35;
  (effect.outerRing.material as THREE.MeshBasicMaterial).opacity = fade * (0.66 + Math.sin(age * 7) * 0.12);
  (effect.innerRing.material as THREE.MeshBasicMaterial).opacity = fade * 0.72;
  const positions = effect.stream.geometry.getAttribute("position");
  for (let particle = 0; particle < CAPTURE_PARTICLE_COUNT; particle += 1) {
    const seedAngle = particle * 2.399963229728653 + effect.id * 0.61803398875;
    const radial = 0.24 + ((particle * 17) % CAPTURE_PARTICLE_COUNT) / CAPTURE_PARTICLE_COUNT * 0.72;
    const angle = seedAngle + age * (1.8 + (particle % 4) * 0.24);
    const inward = 1 - progress * 0.76;
    positions.setXYZ(particle, Math.cos(angle) * radial * inward, Math.sin(angle) * radial * inward, Math.sin(angle * 2) * 0.045 * inward);
  }
  positions.needsUpdate = true;
  effect.stream.scale.setScalar(radius * (1 - progress * 0.14));
  (effect.stream.material as THREE.PointsMaterial).opacity = fade;
  light.position.copy(effect.group.position);
  light.color.setHex(0x61eaff);
  light.intensity = fade * 1.4;
  light.distance = Math.max(radius * 2, 1e-9);
  return true;
}
