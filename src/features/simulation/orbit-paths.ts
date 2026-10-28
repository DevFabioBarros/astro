import * as THREE from "three";
import type { BodyType, CelestialBody, Vector3 } from "@/simulation/types";
import { findOrbitalPrimary } from "@/simulation/orbital-analysis";
import { getBodyType } from "@/simulation/body-catalog";
import { isDebrisBody } from "@/simulation/body-identity";
import { SCENE_UNITS_PER_METER, toScenePosition, toSceneRadius } from "./scene-scale";

const MAX_ORBIT_RADIUS_M = 2e13;
const MAX_OCCLUDERS = 64;
const DEFAULT_ORBIT_SEGMENTS = 256;
const FOCUSED_ORBIT_SEGMENTS = 4096;
const PREVIEW_ORBIT_SEGMENTS = 96;
const PREVIEW_HIGHLIGHT_COLOR = new THREE.Color(0xb8efff);
export type OrbitPositionMapper = (positionM: Vector3) => THREE.Vector3;

function orbitOcclusionUniforms() {
  return { uOccluders: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) }, uOccluderCount: { value: 0 }, uPixelRatio: { value: 1 } };
}

export function setOrbitPathOccluders(group: THREE.Group, occluders: readonly { x: number; y: number; radius: number }[], pixelRatio = 1): void {
  const count = Math.min(occluders.length, MAX_OCCLUDERS);
  for (const line of group.children) {
    const uniforms = line.userData.occlusionUniforms as ReturnType<typeof orbitOcclusionUniforms> | undefined;
    if (!uniforms) continue;
    uniforms.uOccluderCount.value = count;
    uniforms.uPixelRatio.value = pixelRatio;
    for (let index = 0; index < count; index += 1) {
      const { x, y, radius } = occluders[index]!;
      uniforms.uOccluders.value[index]!.set(x, y, radius, 0);
    }
  }
}

export function updateOrbitPathOcclusion(group: THREE.Group, camera: THREE.PerspectiveCamera, bodies: ReadonlyMap<string, { group: THREE.Object3D }>, width: number, height: number, pixelRatio: number): void {
  const projected = group.userData.occlusionProjected as THREE.Vector3 | undefined ?? (group.userData.occlusionProjected = new THREE.Vector3());
  const occluders = group.userData.occlusionScratch as { x: number; y: number; radius: number }[] | undefined ?? (group.userData.occlusionScratch = []);
  occluders.length = 0;
  for (const { group: body } of bodies.values()) {
    projected.copy(body.position).project(camera);
    if (projected.z <= -1 || projected.z >= 1) continue;
    const distance = camera.position.distanceTo(body.position);
    const visibleRadius = body.scale.x * (Number(body.userData.orbitOcclusionScale) || 1);
    const radius = visibleRadius / Math.sqrt(Math.max(distance * distance - visibleRadius * visibleRadius, 1e-24)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * height / 2 + 2;
    occluders.push({ x: (projected.x + 1) * width / 2, y: (projected.y + 1) * height / 2, radius });
  }
  setOrbitPathOccluders(group, occluders, pixelRatio);
}

function interpolateVector(previous: Vector3, current: Vector3, alpha: number): Vector3 {
  return [
    THREE.MathUtils.lerp(previous[0], current[0], alpha),
    THREE.MathUtils.lerp(previous[1], current[1], alpha),
    THREE.MathUtils.lerp(previous[2], current[2], alpha),
  ];
}

export function interpolateOrbitBodies(previous: readonly CelestialBody[], current: readonly CelestialBody[], alpha: number): CelestialBody[] {
  const previousById = new Map(previous.map((body) => [body.id, body]));
  return current.map((body) => {
    const prior = previousById.get(body.id);
    if (!prior) return body;
    return {
      ...body,
      positionM: interpolateVector(prior.positionM, body.positionM, alpha),
      velocityMs: interpolateVector(prior.velocityMs, body.velocityMs, alpha),
    };
  });
}

/** Two-body osculating path; the N-body simulation remains authoritative. */
export function calculateOrbit(body: CelestialBody, primary: CelestialBody, gravitationalConstant: number, segments = 256): Vector3[] {
  const r = new THREE.Vector3().fromArray(body.positionM).sub(new THREE.Vector3().fromArray(primary.positionM));
  const v = new THREE.Vector3().fromArray(body.velocityMs).sub(new THREE.Vector3().fromArray(primary.velocityMs));
  const mu = gravitationalConstant * (body.massKg + primary.massKg);
  if (!(mu > 0) || r.lengthSq() === 0) return [];
  const h = new THREE.Vector3().crossVectors(r, v);
  if (h.lengthSq() === 0) return [];
  const eVector = new THREE.Vector3().crossVectors(v, h).divideScalar(mu).sub(r.clone().normalize());
  const eccentricity = eVector.length();
  const p = h.lengthSq() / mu;
  const x = eccentricity > 1e-8 ? eVector.normalize() : r.clone().normalize();
  const y = new THREE.Vector3().crossVectors(h.clone().normalize(), x).normalize();
  const limit = eccentricity < 1 ? Math.PI : Math.acos(-1 / eccentricity) * 0.96;
  const points: Vector3[] = [];
  let clippedTail = false;
  for (let index = 0; index <= segments; index += 1) {
    const angle = -limit + (index / segments) * limit * 2;
    const radius = p / (1 + eccentricity * Math.cos(angle));
    if (!Number.isFinite(radius) || radius > MAX_ORBIT_RADIUS_M) {
      if (points.length) clippedTail = true;
      continue;
    }
    if (clippedTail) break;
    const position = x.clone().multiplyScalar(radius * Math.cos(angle)).addScaledVector(y, radius * Math.sin(angle));
    points.push([position.x + primary.positionM[0], position.y + primary.positionM[1], position.z + primary.positionM[2]]);
  }
  return points;
}

function calculateOrbitEntries(bodies: readonly CelestialBody[], gravity: number, detailedBodyId?: string) {
  const entries: { body: CelestialBody; primary: CelestialBody; points: Vector3[] }[] = [];
  for (const body of bodies) {
    if (isDebrisBody(body)) continue;
    const primary = findOrbitalPrimary(body, bodies, { gravitationalConstant: gravity });
    if (!primary) continue;
    const segments = body.id === detailedBodyId ? FOCUSED_ORBIT_SEGMENTS : DEFAULT_ORBIT_SEGMENTS;
    const points = calculateOrbit(body, primary, gravity, segments);
    if (points.length < 2) continue;
    entries.push({ body, primary, points });
  }
  return entries;
}

function mappedPosition(positionM: Vector3, origin: Vector3, mapPosition?: OrbitPositionMapper): THREE.Vector3 {
  return mapPosition?.(positionM) ?? new THREE.Vector3().fromArray(toScenePosition(positionM, origin));
}

function writeOrbitGeometry(line: THREE.Line, points: readonly Vector3[], primary: CelestialBody, origin: Vector3, mapPosition?: OrbitPositionMapper): void {
  const mappedPrimary = mappedPosition(primary.positionM, origin, mapPosition);
  const local = points.map((point) => mappedPosition(point, origin, mapPosition).sub(mappedPrimary));
  let position = line.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || position.count !== local.length) {
    position = new THREE.BufferAttribute(new Float32Array(local.length * 3), 3);
    line.geometry.setAttribute("position", position);
  }
  local.forEach((point, index) => position!.setXYZ(index, point.x, point.y, point.z));
  position.needsUpdate = true;
  line.geometry.setDrawRange(0, local.length);
  line.geometry.computeBoundingSphere();
}

export function orbitPathColor(body: CelestialBody): number {
  const type = getBodyType(body);
  if (type === "black-hole") return 0xc084fc;
  if (type === "star") return 0xffd166;
  if (type === "gas-giant") return body.id === "saturn" ? 0xf4b942 : body.id === "jupiter" ? 0xf97316 : 0x38bdf8;
  if (type === "moon") return 0xcbd5e1;
  if (type === "asteroid" || type === "comet") return body.id.startsWith("comet") ? 0x67e8f9 : 0xa3e635;
  if (body.id === "earth") return 0x22d3ee;
  if (body.id === "mars") return 0xfb7185;
  if (body.id === "venus") return 0xfacc15;
  if (body.id === "mercury") return 0x94a3b8;
  return 0x60a5fa;
}

export function orbitPathColorForBodyType(type: BodyType): number {
  if (type === "black-hole") return 0xc084fc;
  if (type === "star") return 0xffd166;
  if (type === "gas-giant") return 0x38bdf8;
  if (type === "moon") return 0xcbd5e1;
  if (type === "asteroid") return 0xa3e635;
  if (type === "comet") return 0x67e8f9;
  return 0x60a5fa;
}

/** Preview-only circular guide from Worker-accepted candidate poses; no body state is created. */
export function createCircularOrbitPreviewPath(
  centerPositionM: Vector3,
  radiusM: number,
  planeNormal: Vector3,
  origin: Vector3,
  color: number,
  mapPosition?: OrbitPositionMapper,
): THREE.Line | undefined {
  const normal = new THREE.Vector3(...planeNormal);
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > MAX_ORBIT_RADIUS_M
    || !centerPositionM.every(Number.isFinite) || !normal.toArray().every(Number.isFinite) || normal.lengthSq() <= 1e-20) return undefined;
  normal.normalize();
  const reference = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const axisX = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const axisY = new THREE.Vector3().crossVectors(normal, axisX).normalize();
  const center = new THREE.Vector3(...centerPositionM);
  const radius = radiusM;
  const points = Array.from({ length: PREVIEW_ORBIT_SEGMENTS + 1 }, (_, index) => {
    const angle = index / PREVIEW_ORBIT_SEGMENTS * Math.PI * 2;
    const point = center.clone().addScaledVector(axisX, Math.cos(angle) * radius).addScaledVector(axisY, Math.sin(angle) * radius).toArray() as Vector3;
    return mappedPosition(point, origin, mapPosition);
  });
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.07, transparent: true, opacity: 0.82, depthTest: true, depthWrite: false });
  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  line.name = "orbital-preview-path";
  line.userData.visualOnly = true;
  line.userData.nonPickable = true;
  return line;
}

export function createOrbitalRingPreviewGuide(
  centerPositionM: Vector3,
  innerRadiusM: number,
  outerRadiusM: number,
  planeNormal: Vector3,
  origin: Vector3,
  mapPosition?: OrbitPositionMapper,
): THREE.Mesh | undefined {
  const normal = new THREE.Vector3(...planeNormal);
  if (!Number.isFinite(innerRadiusM) || !Number.isFinite(outerRadiusM) || innerRadiusM <= 0
    || outerRadiusM <= innerRadiusM || outerRadiusM > MAX_ORBIT_RADIUS_M
    || !centerPositionM.every(Number.isFinite) || !normal.toArray().every(Number.isFinite) || normal.lengthSq() <= 1e-20) return undefined;
  normal.normalize();
  const geometry = new THREE.RingGeometry(toSceneRadius(innerRadiusM), toSceneRadius(outerRadiusM), PREVIEW_ORBIT_SEGMENTS, 1);
  const center = new THREE.Vector3(...centerPositionM);
  const mappedCenter = mappedPosition(centerPositionM, origin, mapPosition);
  if (mapPosition) {
    const positions = geometry.getAttribute("position");
    const axisReference = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const axisX = new THREE.Vector3().crossVectors(axisReference, normal).normalize();
    const axisY = new THREE.Vector3().crossVectors(normal, axisX).normalize();
    for (let index = 0; index < positions.count; index += 1) {
      const offset = axisX.clone().multiplyScalar(positions.getX(index) / SCENE_UNITS_PER_METER)
        .addScaledVector(axisY, positions.getY(index) / SCENE_UNITS_PER_METER);
      const physicalPoint = center.clone().add(offset);
      const mapped = mappedPosition(physicalPoint.toArray() as Vector3, origin, mapPosition);
      positions.setXYZ(index, mapped.x - mappedCenter.x, mapped.y - mappedCenter.y, mapped.z - mappedCenter.z);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  const material = new THREE.MeshBasicMaterial({ color: 0x9bc9dc, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthTest: true, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "orbital-ring-preview-guide";
  mesh.position.copy(mappedCenter);
  if (!mapPosition) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  mesh.renderOrder = 4;
  mesh.userData.visualOnly = true;
  mesh.userData.nonPickable = true;
  return mesh;
}

export function updateOrbitPathHighlights(group: THREE.Group, bodyIds: ReadonlySet<string>, strength: number): void {
  const amount = THREE.MathUtils.clamp(strength, 0, 1);
  for (const child of group.children) {
    if (!(child instanceof THREE.Line) || !(child.material instanceof THREE.LineBasicMaterial)) continue;
    const baseColor = child.userData.orbitBaseColor as THREE.Color | undefined;
    const baseOpacity = child.userData.orbitBaseOpacity as number | undefined;
    if (!baseColor || baseOpacity === undefined) continue;
    child.material.color.copy(baseColor).lerp(PREVIEW_HIGHLIGHT_COLOR, bodyIds.has(child.name) ? amount : 0);
    child.material.opacity = THREE.MathUtils.lerp(baseOpacity, Math.max(baseOpacity, 0.88), bodyIds.has(child.name) ? amount : 0);
  }
}

export function createOrbitPaths(bodies: readonly CelestialBody[], gravity: number, origin: Vector3, detailedBodyId?: string, mapPosition?: OrbitPositionMapper): THREE.Group {
  const group = new THREE.Group();
  for (const { body, primary, points } of calculateOrbitEntries(bodies, gravity, detailedBodyId)) {
    const uniforms = orbitOcclusionUniforms();
    const material = new THREE.LineBasicMaterial({ color: orbitPathColor(body), transparent: true, opacity: 0.26, depthTest: true, depthWrite: false });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        uniform vec4 uOccluders[${MAX_OCCLUDERS}]; uniform int uOccluderCount; uniform float uPixelRatio;`)
        .replace("#include <opaque_fragment>", `vec2 screenPoint = gl_FragCoord.xy / uPixelRatio;
          for (int occluderIndex = 0; occluderIndex < ${MAX_OCCLUDERS}; occluderIndex++) {
            if (occluderIndex >= uOccluderCount) break;
            vec2 delta = screenPoint - uOccluders[occluderIndex].xy;
            if (dot(delta, delta) < uOccluders[occluderIndex].z * uOccluders[occluderIndex].z) discard;
          }
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => "astro-orbit-body-occlusion-v1";
    const line = new THREE.Line(new THREE.BufferGeometry(), material);
    line.userData.occlusionUniforms = uniforms;
    line.userData.orbitBaseColor = material.color.clone();
    line.userData.orbitBaseOpacity = material.opacity;
    writeOrbitGeometry(line, points, primary, origin, mapPosition);
    line.name = body.id;
    line.userData.primaryId = primary.id;
    line.position.copy(mappedPosition(primary.positionM, origin, mapPosition));
    group.add(line);
  }
  return group;
}

/** Refresh paths from one interpolated snapshot while keeping line materials alive. */
export function refreshOrbitPaths(group: THREE.Group, bodies: readonly CelestialBody[], gravity: number, origin: Vector3, detailedBodyId?: string, mapPosition?: OrbitPositionMapper): boolean {
  const entries = calculateOrbitEntries(bodies, gravity, detailedBodyId);
  const lines = group.children.filter((child): child is THREE.Line => child instanceof THREE.Line);
  if (lines.length !== entries.length || entries.some(({ body, primary }, index) => {
    const line = lines[index];
    return line?.name !== body.id || line.userData.primaryId !== primary.id;
  })) return false;
  entries.forEach(({ primary, points }, index) => {
    const line = lines[index]!;
    writeOrbitGeometry(line, points, primary, origin, mapPosition);
    line.position.copy(mappedPosition(primary.positionM, origin, mapPosition));
  });
  return true;
}

