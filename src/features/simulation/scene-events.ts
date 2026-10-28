import * as THREE from "three";
import type { CelestialBody, CollisionMode, SimulationEvent, Vector3 } from "@/simulation/types";
import { getBodyType } from "@/simulation/body-catalog";
import { toScenePosition, toSceneRadius } from "./scene-scale";
import { createRockGeometry } from "./celestial-bodies";
import { CAPTURE_LIFETIME_MS, createBlackHoleCaptureEffect, isAcceptedCaptureEvent, updateBlackHoleCaptureEffect, type BlackHoleCaptureEffect } from "./black-hole-capture-effect";
import { boundedImpactScale, maxEffectScale, type EffectViewport } from "./scene-effect-scale";
import { GREY_ALBEDO_LASER_PROFILE_ID, isNormalizedLaserDirection, MAX_LASER_DURATION_SECONDS, MAX_LASER_ENERGY_J, MAX_LASER_POWER_W } from "@/simulation/laser-model";

const LIFETIME_MS = 7000;
const MERGE_LIFETIME_MS = 2800;
const FRAGMENTATION_LIFETIME_MS = 2800;
const MAX_EFFECTS = 16;
const DEBRIS_COUNT = 96;
const MAX_RING_NDC_RADIUS = 0.18;
const MAX_FIREBALL_NDC_RADIUS = 0.26;
const MAX_SHOCKWAVE_NDC_RADIUS = 0.3;
const MAX_STELLAR_GAS_NDC_RADIUS = 0.5;
const RING_OUTER_RADIUS = 1.08;
const CONTACT_PULSE_MS = 900;
const CONTACT_MARK_LIFETIME_MS = 2500;
const COLLISION_SHOCKWAVE_MS = 2400;
const FRAGMENT_TRAIL_LOOKBACK_SECONDS = 1200;
const FRAGMENT_TRAIL_RADIUS_MULTIPLIER = 1.6;
const MAX_FRAGMENT_TRAIL_LENGTH_M = 6_000_000;
const cameraPosition = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const effectPosition = new THREE.Vector3();

type EffectBase = { id: number; startedAt: number; group: THREE.Group; radius: number };
type Effect = EffectBase & ({ kind: "legacy"; variant: "merge" | "fragmentation" | "explosion" | "legacy-collision"; lifetimeMs: number; ring: THREE.Mesh; flash: THREE.Mesh; plume?: THREE.Mesh; debris?: THREE.Points; fireball: THREE.Mesh; shockwave: THREE.Mesh; shards?: THREE.InstancedMesh; trails?: THREE.LineSegments; acceptedFragmentIds?: string[]; fragmentPoints?: THREE.Points; fragmentTrails?: THREE.LineSegments; energyScale: number; collision: boolean; contactMark?: THREE.Group } | { kind: "impulse"; arrow: THREE.ArrowHelper } | { kind: "laser"; startedSimulationSeconds: number; lifetimeSeconds: number; beam: THREE.Mesh; spot: THREE.Mesh } | { kind: "stellar-gas"; gas: THREE.Mesh; corona: THREE.Mesh; flash: THREE.Mesh } | BlackHoleCaptureEffect);
const fragmentMatrix = new THREE.Matrix4(), fragmentPosition = new THREE.Vector3(), fragmentRotation = new THREE.Euler(), fragmentScale = new THREE.Vector3();

function isFiniteVector3(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component));
}

function fireballMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { effectTime: { value: 0 }, effectColor: { value: new THREE.Color(color) }, heat: { value: 1 } },
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vPosition; varying vec3 vNormal; varying vec3 vViewDirection; void main(){ vPosition=position; vNormal=normal; vec4 viewPosition=modelViewMatrix*vec4(position,1.0); vViewDirection=normalize(-viewPosition.xyz); gl_Position=projectionMatrix*viewPosition; }`,
    fragmentShader: `uniform float effectTime; uniform vec3 effectColor; uniform float heat; varying vec3 vPosition; varying vec3 vNormal; varying vec3 vViewDirection;
      float hash(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
      float noise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){ float n=noise(vPosition*4.5+vec3(0.0,effectTime*0.42,0.0)); float rim=pow(max(0.0,1.0-abs(dot(normalize(vNormal),normalize(vViewDirection)))),0.7);
      float tongues=smoothstep(0.12,0.88,n)*rim; float cloud=smoothstep(0.18,0.9,n);
      float whiteHot=smoothstep(0.78,0.94,n)*smoothstep(0.56,0.84,heat);
      vec3 hot=mix(effectColor,vec3(1.0,0.9,0.62),whiteHot);
      gl_FragColor=vec4(hot,clamp((0.16+cloud*0.32+tongues*0.72)*heat,0.0,0.92));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

function stellarGasMaterial(color: number, corona = false): THREE.ShaderMaterial {
  const highlight = corona ? "vec3(1.0,0.91,0.73)" : "vec3(1.0,0.38,0.08)";
  return new THREE.ShaderMaterial({
    uniforms: { effectTime: { value: 0 }, effectColor: { value: new THREE.Color(color) }, fade: { value: 1 } },
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vPosition; varying vec3 vNormal; varying vec3 vViewDirection; void main(){ vPosition=position; vNormal=normal; vec4 viewPosition=modelViewMatrix*vec4(position,1.0); vViewDirection=normalize(-viewPosition.xyz); gl_Position=projectionMatrix*viewPosition; }`,
    fragmentShader: `uniform float effectTime; uniform vec3 effectColor; uniform float fade; varying vec3 vPosition; varying vec3 vNormal; varying vec3 vViewDirection;
      float hash(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
      float noise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){ float broad=noise(vPosition*3.8+vec3(effectTime*0.2,effectTime*0.08,0.0)); float detail=noise(vPosition*8.2+vec3(-effectTime*0.34,effectTime*0.22,effectTime*0.12)); float n=mix(broad,detail,0.32); float rim=pow(max(0.0,1.0-abs(dot(normalize(vNormal),normalize(vViewDirection)))),${corona ? "1.2" : "0.62"});
        float cloud=smoothstep(${corona ? "0.18,0.84" : "0.12,0.88"},n); vec3 hot=mix(effectColor,${highlight},smoothstep(0.35,0.92,n));
        float density=${corona ? "rim*(0.34+0.5*cloud)" : "(0.16+0.8*cloud+0.42*rim*cloud)"}; gl_FragColor=vec4(hot,clamp(density*fade,0.0,0.92));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function fragmentSparkMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 1 } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: `void main(){ vec4 viewPosition=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*viewPosition; gl_PointSize=7.0; }`,
    fragmentShader: `
      uniform float opacity;
      void main(){
        float r=length(gl_PointCoord-vec2(0.5))*2.0;
        float core=1.0-smoothstep(0.08,0.58,r);
        float halo=1.0-smoothstep(0.18,1.0,r);
        float alpha=(core*0.76+halo*0.24)*opacity;
        if(alpha<0.008) discard;
        gl_FragColor=vec4(1.0,0.82,0.58,alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function stellarGasEvent(event: SimulationEvent): boolean {
  return (event as SimulationEvent & { visualEffect?: unknown }).visualEffect === "stellar-gas-expansion";
}

function isAcceptedStellarGasEvent(event: SimulationEvent): boolean {
  if (event.type !== "explosion" || !stellarGasEvent(event) || event.energyJ !== 0 || event.bodyIds.length !== 1) return false;
  return event.bodyIds[0]!.length > 0;
}

function disposeEffect(effect: Effect): void {
  effect.group.removeFromParent();
  effect.group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function validEvent(event: SimulationEvent): boolean {
  if (!event || typeof event !== "object") return false;
  const position = event.positionM;
  const validImpulse = event.type !== "impulse" || event.impulse?.modelId === "center-of-mass-impulse-v1"
    && event.impulse.deltaVelocityMs.length === 3 && event.impulse.deltaVelocityMs.every(Number.isFinite)
    && event.impulse.deltaVelocityMs.some((component) => component !== 0)
    && Number.isFinite(event.impulse.externalWorkJ) && event.energyJ === Math.abs(event.impulse.externalWorkJ)
    && event.bodyIds.length === 1;
  const validLaser = event.type !== "laser" || event.laser?.modelId === "laser-energy-ledger-v1"
    && event.laser.profileId === GREY_ALBEDO_LASER_PROFILE_ID && isNormalizedLaserDirection(event.laser.bodyLocalDirection)
    && Number.isFinite(event.laser.powerW) && event.laser.powerW > 0 && event.laser.powerW <= MAX_LASER_POWER_W
    && Number.isFinite(event.laser.durationAcceptedSeconds) && event.laser.durationAcceptedSeconds > 0 && event.laser.durationAcceptedSeconds <= MAX_LASER_DURATION_SECONDS
    && Number.isFinite(event.laser.inputJ) && event.laser.inputJ > 0 && event.laser.inputJ <= MAX_LASER_ENERGY_J
    && event.laser.inputJ === event.energyJ && event.laser.inputJ === event.laser.powerW * event.laser.durationAcceptedSeconds
    && event.laser.inputJ === event.laser.absorbedJ + event.laser.reflectedJ && event.bodyIds.length === 1;
  return Number.isSafeInteger(event.id) && (event.type === "collision" || event.type === "explosion" || event.type === "black-hole-capture" || event.type === "impulse" || event.type === "laser")
    && validImpulse && validLaser
    && Number.isFinite(event.timeSeconds) && Number.isFinite(event.radiusM) && event.radiusM > 0
    && Number.isFinite(event.energyJ) && Array.isArray(event.bodyIds) && event.bodyIds.every((id) => typeof id === "string")
    && Array.isArray(position) && position.length === 3 && position.every(Number.isFinite);
}

function stellarGasNdcLimit(camera: THREE.Camera | undefined, group: THREE.Group, starRadius: number): number {
  if (!camera) return MAX_STELLAR_GAS_NDC_RADIUS;
  camera.updateWorldMatrix(true, false);
  group.getWorldPosition(effectPosition);
  const center = effectPosition.clone().project(camera);
  const edge = Math.max(0, Math.min(1 - Math.abs(center.x), 1 - Math.abs(center.y)) - 0.025);
  let starRadiusNdc = 0;
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.getWorldPosition(cameraPosition);
    camera.getWorldDirection(cameraDirection);
    const depth = effectPosition.sub(cameraPosition).dot(cameraDirection);
    if (depth > 0) starRadiusNdc = starRadius / (Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * depth);
  } else if (camera instanceof THREE.OrthographicCamera) {
    starRadiusNdc = starRadius / ((camera.top - camera.bottom) / (2 * camera.zoom));
  }
  return Math.min(edge, Math.max(MAX_STELLAR_GAS_NDC_RADIUS, starRadiusNdc * 1.3 + 0.04));
}

type ScenePositionMapper = (positionM: Vector3) => THREE.Vector3;

function createContactMark(event: SimulationEvent, bodies: readonly CelestialBody[], group: THREE.Group, mapPosition: ScenePositionMapper): THREE.Group | undefined {
  const contact = event.contact;
  if (event.type !== "collision" || !contact || !Array.isArray(contact.pointM) || contact.pointM.length !== 3
    || !contact.pointM.every(Number.isFinite) || !contact.normalM || !contact.normalM.every(Number.isFinite)) return undefined;
  const normal = new THREE.Vector3(...contact.normalM);
  if (Math.abs(normal.length() - 1) > 0.01) return undefined;
  normal.normalize();
  const contactPoint = new THREE.Vector3(...contact.pointM);
  const survivorId = event.outcome?.kind === "perfectly-inelastic-merge" ? event.outcome.survivorBodyId : undefined;
  const survivor = survivorId ? bodies.find((body) => body.id === survivorId) : undefined;
  if (survivorId && !survivor) return undefined;
  let markCenter = contactPoint;
  let markRadiusM = event.radiusM;
  if (survivor) {
    const survivorCenter = new THREE.Vector3(...survivor.positionM);
    const outward = contactPoint.sub(survivorCenter);
    if (outward.lengthSq() > 1e-12) normal.copy(outward.normalize());
    else if (event.bodyIds[1] === survivor.id) normal.negate();
    markCenter = survivorCenter.addScaledVector(normal, survivor.radiusM);
    markRadiusM = survivor.radiusM;
  }
  const radius = toSceneRadius(markRadiusM) * 0.085;
  if (!(radius > 0 && Number.isFinite(radius))) return undefined;
  const marker = new THREE.Group();
  marker.name = "collision-contact-mark-visual-only";
  marker.userData.visualOnly = true;
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.66, radius, 40), new THREE.MeshBasicMaterial({ color: 0xffdf9c, transparent: true, opacity: 0.82, depthTest: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
  const hotspot = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff8c32, transparent: true, opacity: 0.82, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  ring.name = "collision-contact-ring-visual-only";
  hotspot.name = "collision-contact-hotspot-visual-only";
  marker.add(ring, hotspot);
  if (survivor) {
    marker.userData.survivorBodyId = survivor.id;
    marker.userData.surfaceNormal = normal.toArray();
    marker.userData.baseRadius = radius;
  }
  marker.position.copy(mapPosition(markCenter.toArray() as Vector3));
  marker.position.sub(group.position).addScaledVector(normal, radius * 0.08);
  marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  marker.renderOrder = 11;
  group.add(marker);
  return marker;
}

export class SceneEventEffects {
  private readonly active: Effect[] = [];
  private readonly seen = new Set<number>();
  private generation = -1;
  private readonly flashLight = new THREE.PointLight(0xffbf77, 0, 0, 2);

  constructor(private readonly scene: THREE.Scene, private readonly origin: Vector3, private readonly reducedMotion: boolean | (() => boolean),
    private readonly mapPosition: ScenePositionMapper = (positionM) => new THREE.Vector3(...toScenePosition(positionM, origin))) {
    this.flashLight.name = "bounded-event-light";
  }

  get hasActiveEffects(): boolean {
    return this.active.some((effect) => effect.kind !== "laser");
  }

  consume(events: readonly SimulationEvent[], now: number, generation: number, bodies: readonly CelestialBody[] = [], collisionMode: CollisionMode = "scientific",
    resolveLaserTarget?: (bodyId: string) => { group: THREE.Group; surfaceRadius: number } | undefined): void {
    if (generation !== this.generation) {
      this.active.splice(0).forEach(disposeEffect);
      this.seen.clear();
      this.generation = generation;
    }
    const reduceMotion = typeof this.reducedMotion === "function" ? this.reducedMotion() : this.reducedMotion;
    if (reduceMotion) this.active.splice(0).forEach(disposeEffect);
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (!validEvent(event) || this.seen.has(event.id)) continue;
      if (event.type === "black-hole-capture" && !isAcceptedCaptureEvent(event, bodies)) continue;
      this.seen.add(event.id);
      if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
      if (reduceMotion || (event.type === "black-hole-capture" && collisionMode !== "creative")) continue;
      let nextEffect: Effect | undefined;
      if (event.type === "laser") {
        const target = resolveLaserTarget?.(event.bodyIds[0]!);
        if (target) nextEffect = this.createLaser(event, now, target.group, target.surfaceRadius);
      } else if (event.type === "impulse") {
        nextEffect = this.createImpulse(event, now);
      } else if (event.type === "black-hole-capture") {
        nextEffect = createBlackHoleCaptureEffect(this.scene, event, now, this.origin);
      } else if (event.type === "explosion" && stellarGasEvent(event)) {
        if (isAcceptedStellarGasEvent(event)) nextEffect = this.createStellarGas(event, now);
      } else nextEffect = this.create(event, now, bodies);
      if (!nextEffect) continue;
      if (this.active.length >= MAX_EFFECTS) disposeEffect(this.active.shift()!);
      this.active.push(nextEffect);
      if (!this.flashLight.parent) this.scene.add(this.flashLight);
    }
  }

  update(now: number, camera?: THREE.Camera, bodies: readonly CelestialBody[] = [], effectViewport?: EffectViewport, acceptedSimulationTimeSeconds = 0): void {
    this.flashLight.intensity = 0;
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const effect = this.active[index]!;
      if (effect.kind === "laser") {
        const progress = (acceptedSimulationTimeSeconds - effect.startedSimulationSeconds) / effect.lifetimeSeconds;
        if (progress >= 1) {
          this.active.splice(index, 1);
          disposeEffect(effect);
          continue;
        }
        const opacity = 1 - Math.max(0, progress);
        (effect.beam.material as THREE.MeshBasicMaterial).opacity = opacity * 0.68;
        (effect.spot.material as THREE.MeshBasicMaterial).opacity = opacity * 0.9;
        continue;
      }
      const eventPositionM = effect.group.userData.eventPositionM;
      if (effect.kind !== "black-hole-capture" && isFiniteVector3(eventPositionM)) {
        effect.group.position.copy(this.mapPosition(eventPositionM));
      }
      const lifetimeMs = effect.kind === "black-hole-capture" ? CAPTURE_LIFETIME_MS : effect.kind === "legacy" ? effect.lifetimeMs : effect.kind === "impulse" ? 1200 : LIFETIME_MS;
      const progress = (now - effect.startedAt) / lifetimeMs;
      if (progress >= 1) {
        this.active.splice(index, 1);
        disposeEffect(effect);
        continue;
      }
      const fade = 1 - Math.max(0, progress);
      if (effect.kind === "black-hole-capture") {
        if (!updateBlackHoleCaptureEffect(effect, now, camera, bodies, this.origin, this.flashLight, effectViewport)) {
          this.active.splice(index, 1);
          disposeEffect(effect);
          continue;
        }
        const captor = bodies.find(({ id }) => id === effect.captorId);
        if (captor) effect.group.position.copy(this.mapPosition(captor.positionM));
        continue;
      }
      if (effect.kind === "stellar-gas") {
        const age = Math.max(0, now - effect.startedAt) / 1000;
        const thermalFlash = Math.exp(-age / 0.18);
        for (const mesh of [effect.gas, effect.corona]) {
          const material = mesh.material as THREE.ShaderMaterial;
          material.uniforms.effectTime.value = age;
          material.uniforms.fade.value = fade * (0.72 + thermalFlash * 0.28);
        }
        const gasNdcLimit = stellarGasNdcLimit(camera, effect.group, effect.radius);
        effect.gas.scale.setScalar(Math.min(effect.radius * (1.12 + progress * 2.5), maxEffectScale(camera, effect.group, effect.radius * 1.65, gasNdcLimit)));
        effect.corona.scale.setScalar(Math.min(effect.radius * (1.025 + progress * 0.18), maxEffectScale(camera, effect.group, effect.radius * 1.1, 0.22)));
        effect.flash.scale.setScalar(Math.min(effect.radius * (1.12 + thermalFlash * 0.44), maxEffectScale(camera, effect.group, effect.radius * 1.1, 0.42)));
        (effect.flash.material as THREE.MeshBasicMaterial).opacity = thermalFlash * fade;
        if (camera) effect.flash.quaternion.copy(camera.quaternion);
        const lightAge = age / 0.58;
        if (lightAge < 1) {
          this.flashLight.position.copy(effect.group.position);
          this.flashLight.color.setHex(0xffbd79);
          this.flashLight.intensity = (1 - lightAge) ** 2 * 3.2;
          this.flashLight.distance = Math.max(1, effect.radius * 20);
        }
        continue;
      }
      if (effect.kind === "impulse") {
        (effect.arrow.line.material as THREE.LineBasicMaterial).opacity = fade;
        (effect.arrow.cone.material as THREE.MeshBasicMaterial).opacity = fade;
        continue;
      }
      if (effect.contactMark) {
        const markAge = Math.max(0, now - effect.startedAt);
        const survivorId = effect.contactMark.userData.survivorBodyId;
        const survivor = typeof survivorId === "string" ? bodies.find(({ id }) => id === survivorId) : undefined;
        effect.contactMark.visible = markAge < CONTACT_MARK_LIFETIME_MS && (!survivorId || Boolean(survivor));
        if (survivor && typeof effect.contactMark.userData.baseRadius === "number") {
          const normal = new THREE.Vector3(...effect.contactMark.userData.surfaceNormal).normalize();
          const bodyRadius = toSceneRadius(survivor.radiusM);
          const markRadius = bodyRadius * 0.085;
          effect.contactMark.position.copy(this.mapPosition(survivor.positionM));
          effect.contactMark.position.sub(effect.group.position).addScaledVector(normal, bodyRadius + markRadius * 0.08);
          effect.contactMark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
          effect.contactMark.scale.setScalar(markRadius / effect.contactMark.userData.baseRadius * (0.92 + Math.min(1, markAge / CONTACT_MARK_LIFETIME_MS) * 0.24));
        }
        const markOpacity = markAge < CONTACT_MARK_LIFETIME_MS ? 0.82 * (1 - markAge / CONTACT_MARK_LIFETIME_MS) ** 1.4 : 0;
        effect.contactMark.traverse((object) => {
          if (object instanceof THREE.Mesh) (object.material as THREE.MeshBasicMaterial).opacity = markOpacity;
        });
        if (!survivor) effect.contactMark.scale.setScalar(0.92 + Math.min(1, markAge / CONTACT_MARK_LIFETIME_MS) * 0.24);
      }
      const contactPulse = effect.collision ? THREE.MathUtils.clamp(1 - (now - effect.startedAt) / CONTACT_PULSE_MS, 0, 1) : fade;
      const sourceRadius = effect.radius * effect.energyScale;
      const effectScale = (desired: number, source: number, limit: number, outerRadius = 1) => effect.collision && effectViewport
        ? boundedImpactScale(camera, effect.group, desired, source, limit, outerRadius, effectViewport)
        : Math.min(desired, maxEffectScale(camera, effect.group, source, limit, outerRadius));
      const blastPulse = Math.exp(-Math.max(0, now - effect.startedAt) / 950);
      const shockwaveAge = Math.max(0, now - effect.startedAt);
      const shockwaveMaterial = effect.shockwave.material as THREE.MeshBasicMaterial;
      const shockwaveDuration = effect.collision ? COLLISION_SHOCKWAVE_MS : 720;
      shockwaveMaterial.opacity = shockwaveAge < shockwaveDuration ? (1 - shockwaveAge / shockwaveDuration) ** 1.2 * (effect.variant === "merge" ? 0.28 : effect.collision ? 0.4 : 0.72) : 0;
      effect.shockwave.visible = shockwaveAge < shockwaveDuration;
      const shockwaveLimit = effect.variant === "merge" ? 0.08 : effect.collision ? 0.14 : MAX_SHOCKWAVE_NDC_RADIUS;
      const shockwaveGrowth = effect.variant === "merge" ? 0.55 + shockwaveAge / shockwaveDuration * 3 : 1.25 + shockwaveAge / shockwaveDuration * 8;
      effect.shockwave.scale.setScalar(effectScale(sourceRadius * shockwaveGrowth, sourceRadius * 8, shockwaveLimit));
      const ringGrowth = effect.variant === "merge" ? 0.4 + progress * 2 : 0.4 + progress * 5;
      const ringScale = effectScale(sourceRadius * ringGrowth, sourceRadius, MAX_RING_NDC_RADIUS, RING_OUTER_RADIUS);
      const fireballGrowth = effect.variant === "merge" ? 0.24 + contactPulse * 0.36 : effect.variant === "fragmentation" ? 0.7 + progress * 0.45 : 1.4 + progress * 4.8;
      const fireballLimit = effect.variant === "merge" ? 0.1 : effect.variant === "fragmentation" ? 0.18 : MAX_FIREBALL_NDC_RADIUS;
      const fireballScale = effectScale(sourceRadius * fireballGrowth, sourceRadius, fireballLimit);
      effect.fireball.scale.setScalar(fireballScale);
      const fireballMaterial = effect.fireball.material as THREE.ShaderMaterial;
      fireballMaterial.uniforms.effectTime.value = Math.min(20, Math.max(0, (now - effect.startedAt) / 1000));
      const flashHeat = Math.exp(-Math.max(0, now - effect.startedAt) / 120);
      fireballMaterial.uniforms.heat.value = fade * (effect.variant === "merge" ? 0.7 * contactPulse : effect.variant === "fragmentation" ? 0.58 * Math.exp(-Math.max(0, now - effect.startedAt) / 180) : effect.collision ? 0.55 + 0.45 * contactPulse : 0.22 + 0.3 * flashHeat);
      effect.ring.scale.setScalar(ringScale);
      effect.flash.scale.setScalar(effectScale(sourceRadius * (effect.collision ? 0.22 + contactPulse * 0.45 : 0.55 + blastPulse * 0.5), sourceRadius, effect.collision ? 0.2 : 0.12));
      effect.plume?.scale.set(effect.radius * effect.energyScale * (0.08 + progress * 0.15), effect.radius * effect.energyScale * (0.08 + progress * 0.25), effect.radius * effect.energyScale * (0.08 + progress * 0.15));
      if (camera) {
        effect.ring.quaternion.copy(camera.quaternion);
        effect.shockwave.quaternion.copy(camera.quaternion);
        if (effect.collision) effect.flash.quaternion.copy(camera.quaternion);
      }
      (effect.ring.material as THREE.MeshBasicMaterial).opacity = fade * 0.28;
      (effect.flash.material as THREE.MeshBasicMaterial).opacity = effect.collision ? contactPulse : fade * (0.06 + blastPulse * 0.08);
      if (effect.plume) (effect.plume.material as THREE.MeshBasicMaterial).opacity = effect.collision && contactPulse > 0 ? 0 : fade * 0.18;
      if (effect.debris) {
        (effect.debris.material as THREE.PointsMaterial).opacity = fade;
        effect.debris.scale.setScalar(effect.radius * effect.energyScale * (1 + progress * 4));
      }
      if (effect.shards && effect.trails) {
        for (let shardIndex = 0; shardIndex < effect.shards.count; shardIndex += 1) {
          const y = 1 - 2 * (shardIndex + 0.5) / effect.shards.count;
          const angle = shardIndex * 2.399963229728653 + effect.id * 0.61803398875;
          const radial = Math.sqrt(1 - y * y);
          const directionX = Math.cos(angle) * radial, directionY = y, directionZ = Math.sin(angle) * radial;
          fragmentPosition.set(directionX, directionY, directionZ).multiplyScalar(effect.radius * effect.energyScale * (0.45 + progress * 3.8));
          fragmentRotation.set(progress * (1 + shardIndex % 3), progress * (2 + shardIndex % 5), angle + progress * 4);
          fragmentScale.setScalar(effect.radius * (0.035 + (shardIndex % 4) * 0.013) * (0.7 + fade * 0.3));
          fragmentMatrix.compose(fragmentPosition, new THREE.Quaternion().setFromEuler(fragmentRotation), fragmentScale);
          effect.shards.setMatrixAt(shardIndex, fragmentMatrix);
        }
        effect.shards.instanceMatrix.needsUpdate = true;
        const trailPositions = effect.trails.geometry.getAttribute("position");
        for (let shardIndex = 0; shardIndex < effect.shards.count; shardIndex += 1) {
          const y = 1 - 2 * (shardIndex + 0.5) / effect.shards.count;
          const angle = shardIndex * 2.399963229728653 + effect.id * 0.61803398875;
          const radial = Math.sqrt(1 - y * y), distance = effect.radius * effect.energyScale * (0.45 + progress * 3.8);
          const x = Math.cos(angle) * radial * distance, z = Math.sin(angle) * radial * distance;
          trailPositions.setXYZ(shardIndex * 2, x, y * distance, z);
          trailPositions.setXYZ(shardIndex * 2 + 1, x * 0.62, y * distance * 0.62, z * 0.62);
        }
        trailPositions.needsUpdate = true;
        (effect.trails.material as THREE.LineBasicMaterial).opacity = fade * 0.72;
      }
      if (effect.acceptedFragmentIds && effect.fragmentPoints && effect.fragmentTrails) {
        const pointPositions = effect.fragmentPoints.geometry.getAttribute("position");
        const trailPositions = effect.fragmentTrails.geometry.getAttribute("position");
        let visibleFragments = 0;
        let visibleTrails = 0;
        for (const fragmentId of effect.acceptedFragmentIds) {
          const fragment = bodies.find(({ id }) => id === fragmentId);
          if (!fragment) continue;
          const position = this.mapPosition(fragment.positionM);
          const x = position.x - effect.group.position.x;
          const y = position.y - effect.group.position.y;
          const z = position.z - effect.group.position.z;
          pointPositions.setXYZ(visibleFragments, x, y, z);
          visibleFragments += 1;
          const velocity = new THREE.Vector3(...fragment.velocityMs);
          const speedMs = velocity.length();
          if (!(speedMs > 0 && Number.isFinite(speedMs))) continue;
          const trailLength = Math.min(toSceneRadius(fragment.radiusM) * FRAGMENT_TRAIL_RADIUS_MULTIPLIER, toSceneRadius(speedMs * FRAGMENT_TRAIL_LOOKBACK_SECONDS), toSceneRadius(MAX_FRAGMENT_TRAIL_LENGTH_M));
          if (!(trailLength > 0 && Number.isFinite(trailLength))) continue;
          velocity.multiplyScalar(trailLength / speedMs);
          trailPositions.setXYZ(visibleTrails * 2, x - velocity.x, y - velocity.y, z - velocity.z);
          trailPositions.setXYZ(visibleTrails * 2 + 1, x, y, z);
          visibleTrails += 1;
        }
        effect.fragmentPoints.geometry.setDrawRange(0, visibleFragments);
        effect.fragmentTrails.geometry.setDrawRange(0, visibleTrails * 2);
        pointPositions.needsUpdate = true;
        trailPositions.needsUpdate = true;
        (effect.fragmentPoints.material as THREE.ShaderMaterial).uniforms.opacity.value = fade;
        (effect.fragmentTrails.material as THREE.LineBasicMaterial).opacity = fade * 0.8;
      }
      const lightAge = Math.max(0, (now - effect.startedAt) / 520);
      if (lightAge < 1) {
        this.flashLight.position.copy(effect.group.position);
        this.flashLight.intensity = (1 - lightAge) ** 2 * 2.4;
        this.flashLight.distance = Math.max(1, effect.radius * 18);
      }
    }
    if (!this.active.length) this.scene.remove(this.flashLight);
  }

  dispose(): void {
    this.active.splice(0).forEach(disposeEffect);
    this.seen.clear();
    this.scene.remove(this.flashLight);
  }

  private create(event: SimulationEvent, now: number, bodies: readonly CelestialBody[]): Effect {
    const collision = event.type === "collision";
    const variant = collision
      ? event.outcome?.kind === "creative-fragmentation" ? "fragmentation" : event.outcome?.kind === "perfectly-inelastic-merge" ? "merge" : "legacy-collision"
      : "explosion";
    const hasGenericEjecta = variant === "explosion" || variant === "legacy-collision";
    const acceptedFragmentIds = variant === "fragmentation" && event.outcome?.kind === "creative-fragmentation"
      ? [...new Set(event.outcome.fragmentBodyIds.filter((id) => bodies.some((body) => body.id === id)))]
      : [];
    const color = event.type === "collision" ? 0xff7c32 : event.type === "black-hole-capture" ? 0xb888ff : 0xffbd73;
    const radius = Math.min(1000, Math.max(0.0002, toSceneRadius(event.radiusM)));
    // Graphic proxy only; event energy is not calibrated to ejecta or luminosity.
    const energyScale = THREE.MathUtils.clamp(0.75 + Math.log10(1 + event.energyJ / Math.max(event.radiusM, 1)) * 0.12, 0.75, 1.6);
    const group = new THREE.Group();
    group.userData.eventPositionM = event.positionM;
    group.position.copy(this.mapPosition(event.positionM));
    const ringMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 48), ringMaterial);
    ring.name = event.type === "collision" ? "collision-ring" : "explosion-ring";
    ring.rotation.x = Math.PI / 2;
    const contactMark = event.type === "collision" ? createContactMark(event, bodies, group, this.mapPosition) : undefined;
    const flashMaterial = new THREE.MeshBasicMaterial({ color: event.type === "collision" ? 0xfff0ce : 0xffa84f, transparent: true, opacity: 0.72, depthTest: event.type !== "collision", depthWrite: false, blending: THREE.AdditiveBlending });
    const flashGeometry = event.type === "collision"
      ? new THREE.RingGeometry(0.22 * 0.72, 0.22, 48)
      : new THREE.SphereGeometry(1, 24, 16);
    const flash = new THREE.Mesh(flashGeometry, flashMaterial);
    if (event.type === "collision") flash.name = "collision-contact-pulse";
    const plume = hasGenericEjecta ? new THREE.Mesh(new THREE.ConeGeometry(0.42, 1, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: collision, depthWrite: false })) : undefined;
    if (plume) plume.name = collision ? "collision-fragmentation-plume" : "explosion-plume";
    let debris: THREE.Points | undefined;
    let shards: THREE.InstancedMesh | undefined;
    let trails: THREE.LineSegments | undefined;
    if (hasGenericEjecta) {
      const positions = new Float32Array(DEBRIS_COUNT * 3);
      for (let index = 0; index < DEBRIS_COUNT; index += 1) {
        const y = 1 - 2 * (index + 0.5) / DEBRIS_COUNT;
        const angle = index * 2.399963229728653 + event.id * 0.61803398875;
        const radial = Math.sqrt(1 - y * y);
        positions.set([Math.cos(angle) * radial, y, Math.sin(angle) * radial], index * 3);
      }
      const debrisGeometry = new THREE.BufferGeometry();
      debrisGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      debris = new THREE.Points(debrisGeometry, new THREE.PointsMaterial({ color, size: radius * 0.035, transparent: true, opacity: 1, depthTest: false, depthWrite: false, sizeAttenuation: true }));
      const shardGeometry = createRockGeometry(`impact-${event.id}`, 1);
      shards = new THREE.InstancedMesh(shardGeometry, new THREE.MeshStandardMaterial({ color: 0xffc36b, emissive: 0xff4a08, emissiveIntensity: 3.2, roughness: 0.82 }), 24);
      shards.name = "impact-instanced-rocks";
      shards.userData.visualOnly = true;
      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24 * 6), 3));
      trailGeometry.setDrawRange(0, 48);
      trails = new THREE.LineSegments(trailGeometry, new THREE.LineBasicMaterial({ color: 0xffa454, transparent: true, opacity: 0.7, depthWrite: false }));
      trails.name = "impact-fragment-trails";
      trails.userData.visualOnly = true;
    }
    let fragmentPoints: THREE.Points | undefined;
    let fragmentTrails: THREE.LineSegments | undefined;
    if (acceptedFragmentIds.length) {
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(acceptedFragmentIds.length * 3), 3));
      fragmentPoints = new THREE.Points(pointGeometry, fragmentSparkMaterial());
      fragmentPoints.name = "accepted-fragment-contact-sparks-visual-only";
      fragmentPoints.userData.visualOnly = true;
      fragmentPoints.frustumCulled = false;
      const trailGeometry = new THREE.BufferGeometry();
      const trailPositions = new THREE.BufferAttribute(new Float32Array(acceptedFragmentIds.length * 6), 3);
      trailGeometry.setAttribute("position", trailPositions);
      trailGeometry.setDrawRange(0, 0);
      fragmentTrails = new THREE.LineSegments(trailGeometry, new THREE.LineBasicMaterial({ color: 0xffa454, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, toneMapped: false }));
      fragmentTrails.name = "accepted-fragment-contact-trails-visual-only";
      fragmentTrails.userData.visualOnly = true;
      fragmentTrails.frustumCulled = false;
      acceptedFragmentIds.forEach((id, index) => {
        const fragment = bodies.find(({ id: bodyId }) => bodyId === id);
        if (!fragment) return;
        const position = this.mapPosition(fragment.positionM);
        const x = position.x - group.position.x;
        const y = position.y - group.position.y;
        const z = position.z - group.position.z;
        (pointGeometry.getAttribute("position") as THREE.BufferAttribute).setXYZ(index, x, y, z);
      });
    }
    const fireball = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), fireballMaterial(color));
    fireball.name = "impact-volumetric-fireball";
    fireball.userData.visualOnly = true;
    const shockwave = new THREE.Mesh(new THREE.RingGeometry(0.91, 1, 96), new THREE.MeshBasicMaterial({ color: 0xffa544, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    shockwave.name = "impact-shockwave-visual-only";
    shockwave.userData.visualOnly = true;
    ring.renderOrder = flash.renderOrder = 10;
    if (plume) plume.renderOrder = 10;
    if (debris) debris.renderOrder = 10;
    shockwave.renderOrder = 5; fireball.renderOrder = 6;
    if (trails) trails.renderOrder = 7;
    if (shards) shards.renderOrder = 8;
    if (fragmentTrails) fragmentTrails.renderOrder = 10;
    if (fragmentPoints) fragmentPoints.renderOrder = 11;
    group.add(shockwave, fireball, ...(trails ? [trails] : []), ...(shards ? [shards] : []), ring, flash, ...(plume ? [plume] : []), ...(debris ? [debris] : []), ...(fragmentTrails ? [fragmentTrails] : []), ...(fragmentPoints ? [fragmentPoints] : []));
    this.scene.add(group);
    const lifetimeMs = variant === "merge" ? MERGE_LIFETIME_MS : variant === "fragmentation" ? FRAGMENTATION_LIFETIME_MS : LIFETIME_MS;
    return { kind: "legacy", variant, lifetimeMs, id: event.id, startedAt: now, group, ring, flash, ...(plume ? { plume } : {}), ...(debris ? { debris } : {}), fireball, shockwave, ...(shards ? { shards } : {}), ...(trails ? { trails } : {}), ...(acceptedFragmentIds.length ? { acceptedFragmentIds, fragmentPoints: fragmentPoints!, fragmentTrails: fragmentTrails! } : {}), radius, energyScale, collision, ...(contactMark ? { contactMark } : {}) };
  }

  private createStellarGas(event: SimulationEvent, now: number): Effect {
    const radius = Math.min(1000, Math.max(0.0002, toSceneRadius(event.radiusM)));
    const group = new THREE.Group();
    group.userData.eventPositionM = event.positionM;
    group.position.copy(this.mapPosition(event.positionM));
    const gas = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), stellarGasMaterial(0xff6532));
    gas.name = "stellar-gas-expansion-visual-only";
    gas.userData.visualOnly = true;
    const corona = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), stellarGasMaterial(0xffb45f, true));
    corona.name = "temporary-stellar-corona-visual-only";
    corona.userData.visualOnly = true;
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: 0xfff0ce, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }));
    flash.name = "stellar-expansion-flash-visual-only";
    flash.userData.visualOnly = true;
    gas.renderOrder = corona.renderOrder = 6; flash.renderOrder = 7;
    group.add(gas, corona, flash);
    this.scene.add(group);
    return { kind: "stellar-gas", id: event.id, startedAt: now, group, radius, gas, corona, flash };
  }

  private createImpulse(event: SimulationEvent, now: number): Effect | undefined {
    const impulse = event.impulse;
    if (!impulse) return undefined;
    const deltaV = new THREE.Vector3(...impulse.deltaVelocityMs);
    if (deltaV.lengthSq() === 0) return undefined;
    const radius = Math.min(1000, Math.max(0.0002, toSceneRadius(event.radiusM)));
    const arrow = new THREE.ArrowHelper(deltaV.normalize(), new THREE.Vector3(), radius * 1.2, 0x62dfff,
      radius * 0.28, radius * 0.16);
    arrow.name = "center-of-mass-impulse-arrow";
    arrow.userData.visualOnly = true;
    (arrow.line.material as THREE.LineBasicMaterial).transparent = true;
    (arrow.cone.material as THREE.MeshBasicMaterial).transparent = true;
    const group = new THREE.Group();
    group.userData.eventPositionM = event.positionM;
    group.position.copy(this.mapPosition(event.positionM));
    group.add(arrow);
    this.scene.add(group);
    return { kind: "impulse", id: event.id, startedAt: now, group, radius, arrow };
  }

  private createLaser(
    event: SimulationEvent & { type: "laser"; laser: NonNullable<SimulationEvent["laser"]> },
    now: number,
    bodyGroup: THREE.Group,
    surfaceRadius: number,
  ): Effect | undefined {
    const direction = new THREE.Vector3(...event.laser.bodyLocalDirection);
    if (!Number.isFinite(surfaceRadius) || surfaceRadius <= 0 || direction.lengthSq() === 0) return undefined;
    direction.normalize();
    const radius = Math.min(1000, Math.max(0.0002, surfaceRadius));
    const beamLength = radius * 0.72;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.018, radius * 0.018, beamLength, 8),
      new THREE.MeshBasicMaterial({ color: 0xff5b32, transparent: true, opacity: 0.68, depthWrite: false, blending: THREE.AdditiveBlending }));
    beam.name = "accepted-laser-beam";
    beam.userData.visualOnly = true;
    beam.position.copy(direction).multiplyScalar(radius + beamLength * 0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    const spot = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.075, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb35b, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    spot.name = "accepted-laser-visual-spot";
    spot.userData.visualOnly = true;
    spot.position.copy(direction).multiplyScalar(radius * 1.012);
    const group = new THREE.Group();
    group.name = "accepted-laser-effect";
    group.userData.visualOnly = true;
    group.add(beam, spot);
    bodyGroup.add(group);
    return { kind: "laser", id: event.id, startedAt: now, startedSimulationSeconds: event.timeSeconds,
      lifetimeSeconds: Math.max(1, Math.min(8, event.laser.durationAcceptedSeconds)), group, radius, beam, spot };
  }

}
