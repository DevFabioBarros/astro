import * as THREE from "three";
import type { CelestialBody, CollisionMode, SurfaceHeatPatch } from "@/simulation/types";
import { IMPACT_SURFACE_GLOW_HALF_LIFE_SECONDS, IMPACT_SURFACE_GLOW_MODEL_ID, surfaceHeatIntensityAt } from "@/simulation/surface-heat";
import { spinPhaseAtAcceptedTimeRad } from "@/simulation/spin-model";
import type { AtmosphereMetrics } from "@/simulation/atmosphere-model";
import { getWaterInventoryMetrics } from "@/simulation/water-model";
import { getBodyType, isLuminousBody } from "@/simulation/body-catalog";
import { stellarLuminosityW } from "@/simulation/stellar-evolution";
import { createSurfaceTexture } from "./body-texture";
import { CREATIVE_BLACK_HOLE_HORIZON_SCALE, stellarColorTemperature, stellarVisualBrightness, stellarVisualResponse } from "./body-appearance";
import { configureEarthSurfaceShader, installEarthSurfaceResponse, updateEarthSurfaceResponse, updateSurfaceMaterialColor } from "./surface-material";
import type { SceneEclipseLight } from "./scene-lighting";
import type { RockSurfaceAssets } from "./rock-assets";
import { atmosphereMaterial, blackHoleDiskMaterial, glowTexture, installEclipseLighting, proceduralStellarMaterial, saturnRingMaterial, solarCoronaMaterial, updateAtmosphereMaterial } from "./celestial-body-materials";
import { createCometTailVisual, type CometTailVisual } from "./comet-tail";
import { createSurfaceWaterMaterial, updateSurfaceWaterMaterial } from "./surface-material";
import { MAX_SURFACE_RELIEF_M, SURFACE_GRID_CELL_COUNT, SURFACE_GRID_HEIGHT, SURFACE_GRID_WIDTH, isValidSurfaceMetadata } from "@/simulation/surface-state";
import type { SurfaceReliefPatch } from "@/simulation/types";

const ROTATION_SECONDS: Record<string, number> = { sun: 2192832, mercury: 5067032, venus: -20996760, earth: 86164, moon: 2360591, mars: 88643, jupiter: 35730, saturn: 38362, uranus: -62064, neptune: 57996 };
const TEXTURED_BODIES = new Set(Object.keys(ROTATION_SECONDS));
const CANONICAL_VISUAL_IDS = new Set([...TEXTURED_BODIES, "asteroid-1"]);

function canonicalVisualId(id: string): string {
  const baseId = id.replace(/(?:-copy-\d+)+$/, "");
  return baseId !== id && CANONICAL_VISUAL_IDS.has(baseId) ? baseId : id;
}

function genericRockTint(id: string): THREE.Color {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const channel = (shift: number) => 0.76 + ((hash >>> shift) & 0xff) / 255 * 0.2;
  return new THREE.Color().setRGB(channel(16), channel(8), channel(0));
}

function createSaturnRingGeometry(): THREE.BufferGeometry {
  const angularSegments = 192;
  const bands = [[1.24, 1.925, 16], [1.975, 2.32, 8]] as const;
  const vertexCount = bands.reduce((count, [, , radialSegments]) => count + (radialSegments + 1) * (angularSegments + 1), 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const [innerRadius, outerRadius, radialSegments] of bands) {
    const rowLength = angularSegments + 1;
    for (let radialIndex = 0; radialIndex <= radialSegments; radialIndex += 1) {
      const radialFraction = radialIndex / radialSegments;
      const radius = THREE.MathUtils.lerp(innerRadius, outerRadius, radialFraction);
      for (let angularIndex = 0; angularIndex <= angularSegments; angularIndex += 1) {
        const angle = (angularIndex / angularSegments) * Math.PI * 2;
        const vertex = vertexOffset + radialIndex * rowLength + angularIndex;
        positions[vertex * 3] = Math.cos(angle) * radius;
        positions[vertex * 3 + 1] = Math.sin(angle) * radius;
        normals[vertex * 3 + 2] = 1;
        uvs[vertex * 2] = angularIndex / angularSegments;
        uvs[vertex * 2 + 1] = radialFraction;
      }
    }
    for (let radialIndex = 0; radialIndex < radialSegments; radialIndex += 1) {
      for (let angularIndex = 0; angularIndex < angularSegments; angularIndex += 1) {
        const inner = vertexOffset + radialIndex * rowLength + angularIndex;
        const outer = inner + rowLength;
        indices.push(inner, outer, inner + 1, outer, outer + 1, inner + 1);
      }
    }
    vertexOffset += (radialSegments + 1) * rowLength;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export type BodyVisual = {
  group: THREE.Group; surface: THREE.Mesh; surfaceHeatOverlay?: THREE.Mesh; surfaceWaterOverlay?: THREE.Mesh; clouds?: THREE.Mesh; ring?: THREE.Mesh; corona?: THREE.Mesh; cometTail?: CometTailVisual;
  setEclipseLighting?: (lights: readonly SceneEclipseLight[]) => void; setAtmosphereMetrics?: (metrics: AtmosphereMetrics | undefined) => void;
  setFragmentHeat?: (heat: number) => void; setSurfaceHeat?: (patches: readonly SurfaceHeatPatch[], simulationTimeSeconds: number) => void;
  setSurfaceHeatTime?: (simulationTimeSeconds: number) => void; setSurfaceWater?: (coverage: number, iceFraction: number) => void; dispose: () => void;
};

function applyRockSurfaceMaps(material: THREE.MeshStandardMaterial, assets: RockSurfaceAssets): boolean {
  if (!assets.diffuse && !assets.roughness) return false;
  if (assets.diffuse) {
    material.map = assets.diffuse;
  }
  if (assets.roughness) {
    material.roughnessMap = assets.roughness;
  }
  material.roughness = 0.96;
  material.needsUpdate = true;
  return true;
}

export function applyRockSurfaceAssetsToVisual(body: CelestialBody, visual: BodyVisual, assets: RockSurfaceAssets): boolean {
  if (getBodyType(body) !== "rocky-planet" || TEXTURED_BODIES.has(canonicalVisualId(body.id)) || visual.setFragmentHeat || !(visual.surface.material instanceof THREE.MeshStandardMaterial)) return false;
  if (!applyRockSurfaceMaps(visual.surface.material, assets)) return false;
  visual.surface.material.color.copy(genericRockTint(body.id));
  return true;
}

function validReliefPatches(patches: readonly SurfaceReliefPatch[] | undefined): patches is SurfaceReliefPatch[] {
  if (!Array.isArray(patches) || patches.length > SURFACE_GRID_CELL_COUNT) return false;
  const cells = new Set<number>();
  for (const patch of patches) {
    if (typeof patch !== "object" || patch === null || Object.keys(patch).length !== 2
      || !Object.hasOwn(patch, "cellIndex") || !Object.hasOwn(patch, "elevationM")
      || !Number.isInteger(patch.cellIndex) || patch.cellIndex < 0 || patch.cellIndex >= SURFACE_GRID_CELL_COUNT
      || !Number.isFinite(patch.elevationM) || Math.abs(patch.elevationM) > MAX_SURFACE_RELIEF_M
      || cells.has(patch.cellIndex)) return false;
    cells.add(patch.cellIndex);
  }
  return patches.length > 0;
}

export function surfaceReliefCellIndex(x: number, y: number, z: number): number | null {
  if (![x, y, z].every(Number.isFinite)) return null;
  const length = Math.hypot(x, y, z);
  if (length <= 0 || !Number.isFinite(length)) return null;
  const nx = x / length, ny = y / length, nz = z / length;
  const latitude = Math.asin(Math.max(-1, Math.min(1, ny)));
  const longitude = Math.hypot(nx, nz) <= 1e-8 ? 0 : Math.atan2(nz, nx);
  const row = Math.max(0, Math.min(SURFACE_GRID_HEIGHT - 1,
    Math.round(((latitude + Math.PI / 2) * SURFACE_GRID_HEIGHT) / Math.PI - 0.5)));
  const column = ((Math.round(((longitude + Math.PI) * SURFACE_GRID_WIDTH) / (2 * Math.PI) - 0.5) % SURFACE_GRID_WIDTH)
    + SURFACE_GRID_WIDTH) % SURFACE_GRID_WIDTH;
  return row * SURFACE_GRID_WIDTH + column;
}

function sampleSurfaceGrid(values: Float32Array, x: number, y: number, z: number): number {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) return 0;
  const nx = x / length, ny = y / length, nz = z / length;
  const latitude = Math.asin(Math.max(-1, Math.min(1, ny)));
  const longitudeRadius = Math.hypot(nx, nz);
  if (longitudeRadius <= 1e-6) {
    const rowOffset = (ny < 0 ? 0 : SURFACE_GRID_HEIGHT - 1) * SURFACE_GRID_WIDTH;
    let poleAverage = 0;
    for (let column = 0; column < SURFACE_GRID_WIDTH; column += 1) poleAverage += values[rowOffset + column]!;
    return poleAverage / SURFACE_GRID_WIDTH;
  }
  const rowPosition = THREE.MathUtils.clamp(((latitude + Math.PI / 2) * SURFACE_GRID_HEIGHT) / Math.PI - 0.5, 0, SURFACE_GRID_HEIGHT - 1);
  const row0 = Math.floor(rowPosition), row1 = Math.min(SURFACE_GRID_HEIGHT - 1, row0 + 1), rowBlend = rowPosition - row0;
  const columnPosition = (Math.atan2(nz, nx) + Math.PI) * SURFACE_GRID_WIDTH / (2 * Math.PI) - 0.5;
  const columnFloor = Math.floor(columnPosition);
  const column0 = ((columnFloor % SURFACE_GRID_WIDTH) + SURFACE_GRID_WIDTH) % SURFACE_GRID_WIDTH;
  const column1 = (column0 + 1) % SURFACE_GRID_WIDTH, columnBlend = columnPosition - columnFloor;
  const lower = THREE.MathUtils.lerp(values[row0 * SURFACE_GRID_WIDTH + column0]!, values[row0 * SURFACE_GRID_WIDTH + column1]!, columnBlend);
  const upper = THREE.MathUtils.lerp(values[row1 * SURFACE_GRID_WIDTH + column0]!, values[row1 * SURFACE_GRID_WIDTH + column1]!, columnBlend);
  return THREE.MathUtils.lerp(lower, upper, rowBlend);
}

/** Clones and displaces only a body's render geometry; missing or invalid relief leaves the source untouched. */
export function createSurfaceReliefGeometry(
  body: CelestialBody,
  geometry: THREE.BufferGeometry,
  patches: readonly SurfaceReliefPatch[] | undefined,
): THREE.BufferGeometry {
  if (!isValidSurfaceMetadata(body.surface) || !Number.isFinite(body.radiusM) || body.radiusM <= 0 || !validReliefPatches(patches)
    || patches.every(({ elevationM }) => elevationM === 0)) return geometry;
  const positions = geometry.getAttribute("position");
  if (!positions || positions.itemSize < 3) return geometry;
  for (let index = 0; index < positions.count; index += 1) {
    if (![positions.getX(index), positions.getY(index), positions.getZ(index)].every(Number.isFinite)) return geometry;
  }
  const elevationByCell = new Float32Array(SURFACE_GRID_CELL_COUNT);
  for (const { cellIndex, elevationM } of patches) elevationByCell[cellIndex] = elevationM;
  const displaced = geometry.clone();
  displaced.userData = { ...displaced.userData };
  delete displaced.userData.sharedAsset;
  const output = displaced.getAttribute("position");
  const surfaceElevations = new Float32Array(output.count);
  for (let index = 0; index < output.count; index += 1) {
    const x = output.getX(index), y = output.getY(index), z = output.getZ(index);
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length <= 0) continue;
    const elevationM = sampleSurfaceGrid(elevationByCell, x, y, z);
    if (!Number.isFinite(elevationM) || elevationM === 0) continue;
    surfaceElevations[index] = elevationM;
    const scale = 1 + elevationM / body.radiusM;
    if (!Number.isFinite(scale) || scale <= 0) {
      displaced.dispose();
      return geometry;
    }
    output.setXYZ(index, x * scale, y * scale, z * scale);
  }
  displaced.setAttribute("surfaceElevation", new THREE.BufferAttribute(surfaceElevations, 1));
  output.needsUpdate = true;
  displaced.computeVertexNormals();
  displaced.computeBoundingSphere();
  return displaced;
}

export function createRockGeometry(seed: string, detail = 2): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const positions = geometry.getAttribute("position");
  let seedHash = 2166136261;
  for (const char of seed) seedHash = Math.imul(seedHash ^ char.charCodeAt(0), 16777619);
  const offsets = new Map<string, number>();
  let maxRadius = 0;
  for (let index = 0; index < positions.count; index += 1) {
    const direction = new THREE.Vector3(positions.getX(index), positions.getY(index), positions.getZ(index)).normalize();
    const key = `${Math.round(direction.x * 10000)},${Math.round(direction.y * 10000)},${Math.round(direction.z * 10000)}`;
    let radius = offsets.get(key);
    if (radius === undefined) {
      let hash = seedHash;
      for (const coordinate of key) hash = Math.imul(hash ^ coordinate.charCodeAt(0), 16777619);
      radius = 0.84 + ((hash >>> 0) / 4294967295) * 0.16;
      offsets.set(key, radius);
    }
    positions.setXYZ(index, direction.x * radius, direction.y * radius, direction.z * radius);
    maxRadius = Math.max(maxRadius, Math.hypot(positions.getX(index), positions.getY(index), positions.getZ(index)));
  }
  for (let index = 0; index < positions.array.length; index += 1) positions.array[index] = positions.array[index]! / maxRadius;
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createBodyVisual(body: CelestialBody, geometry: THREE.BufferGeometry, anisotropy: number, highResolution = true, collisionMode: CollisionMode = "scientific", rockAssets?: RockSurfaceAssets, rockyFragment = false, surfacePatches?: readonly SurfaceReliefPatch[]): BodyVisual {
  const group = new THREE.Group();
  const type = getBodyType(body);
  const visualId = canonicalVisualId(body.id);
  const compact = type === "white-dwarf" || type === "neutron-star";
  const luminous = isLuminousBody(body);
  const textures = new Set<THREE.Texture>();
  let active = true;
  const textureId = type === "gas-giant" ? visualId === "saturn" ? "saturn" : "jupiter" : type === "moon" || type === "asteroid" || type === "comet" ? "moon" : visualId;
  const fallback = createSurfaceTexture(textureId, luminous ? "star" : "planet");
  textures.add(fallback);
  let material = type === "black-hole"
    ? new THREE.MeshBasicMaterial({ color: 0x000000 })
    : compact || (luminous && type === "star" && visualId !== "sun")
    ? proceduralStellarMaterial(body, visualId)
    : luminous && visualId === "sun"
    ? proceduralStellarMaterial(body, visualId)
    : luminous
    ? new THREE.MeshBasicMaterial({ map: visualId === "sun" ? fallback : null })
    : new THREE.MeshStandardMaterial({ map: fallback, roughness: visualId === "earth" ? 0.95 : 0.94, metalness: 0, emissive: 0x000000 });
  if (type === "black-hole" && material instanceof THREE.MeshBasicMaterial) {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vAstroHorizonViewPosition; varying vec3 vAstroHorizonViewNormal;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvAstroHorizonViewPosition = mvPosition.xyz; vAstroHorizonViewNormal = normalize(normalMatrix * normal);");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vAstroHorizonViewPosition; varying vec3 vAstroHorizonViewNormal;")
        .replace("#include <opaque_fragment>", `float horizonFacing = abs(dot(normalize(vAstroHorizonViewNormal), normalize(vAstroHorizonViewPosition)));
          float horizonLimb = 1.0 - smoothstep(0.0, 0.22, horizonFacing);
          outgoingLight = mix(outgoingLight, vec3(0.035, 0.05, 0.09), horizonLimb);
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => "astro-black-hole-horizon-limb-v1";
  }
  if (visualId === "earth" && material instanceof THREE.MeshStandardMaterial) installEarthSurfaceResponse(material);
  const bennuGeometry = type === "asteroid" && visualId === "asteroid-1" ? rockAssets?.bennuGeometry : undefined;
  if (bennuGeometry && rockAssets?.bennuMaterial) {
    const modelMaterial = rockAssets.bennuMaterial.clone();
    modelMaterial.roughnessMap = rockAssets.roughness ?? null;
    modelMaterial.roughness = 0.96;
    material.dispose();
    material = modelMaterial;
  } else if ((type === "asteroid" || type === "rocky-planet" && !TEXTURED_BODIES.has(visualId)) && material instanceof THREE.MeshStandardMaterial && rockAssets && (rockAssets.diffuse || rockAssets.roughness)) {
    applyRockSurfaceMaps(material, rockAssets);
  }
  if (rockyFragment) {
    material.dispose();
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: rockAssets?.diffuse ?? fallback, roughnessMap: rockAssets?.roughness ?? null,
      roughness: 0.96, metalness: 0, emissive: 0xff4a12, emissiveMap: rockAssets?.diffuse ?? null, emissiveIntensity: 0,
    });
  }
  const baseSurfaceGeometry = rockyFragment ? createRockGeometry(`fragment-${body.id}`, 2) : bennuGeometry ?? (type === "asteroid" || type === "comet" ? createRockGeometry(body.id) : geometry);
  const surfaceGeometry = createSurfaceReliefGeometry(body, baseSurfaceGeometry, surfacePatches);
  const ownedBaseGeometry = surfaceGeometry !== baseSurfaceGeometry && baseSurfaceGeometry !== geometry && !baseSurfaceGeometry.userData.sharedAsset
    ? baseSurfaceGeometry : undefined;
  if (type === "rocky-planet" && !TEXTURED_BODIES.has(visualId) && material instanceof THREE.MeshStandardMaterial) material.color.copy(genericRockTint(body.id));
  const surface = new THREE.Mesh(surfaceGeometry, material);
  surface.userData.bodyId = body.id;
  if (type === "black-hole" && collisionMode === "creative") {
    surface.scale.setScalar(CREATIVE_BLACK_HOLE_HORIZON_SCALE);
    surface.userData.visualScaleNote = "escala visual ampliada";
    group.userData.orbitOcclusionScale = CREATIVE_BLACK_HOLE_HORIZON_SCALE;
  }
  surface.rotation.x = Math.PI / 2;
  group.add(surface);
  let surfaceWaterOverlay: THREE.Mesh | undefined;
  let setSurfaceWater: ((coverage: number, iceFraction: number) => void) | undefined;
  if (surfaceGeometry.getAttribute("surfaceElevation")) {
    const waterMaterial = createSurfaceWaterMaterial(surfacePatches ?? []);
    surfaceWaterOverlay = new THREE.Mesh(surfaceGeometry.clone(), waterMaterial);
    surfaceWaterOverlay.name = "surface-water-depressions";
    surfaceWaterOverlay.renderOrder = 1;
    surfaceWaterOverlay.scale.setScalar(1.001);
    surfaceWaterOverlay.visible = false;
    surfaceWaterOverlay.rotation.copy(surface.rotation);
    group.add(surfaceWaterOverlay);
    setSurfaceWater = (coverage, iceFraction) => { surfaceWaterOverlay!.visible = updateSurfaceWaterMaterial(waterMaterial, coverage, iceFraction); };
  }
  let surfaceHeatOverlay: THREE.Mesh | undefined;
  let setSurfaceHeat: ((patches: readonly SurfaceHeatPatch[], simulationTimeSeconds: number) => void) | undefined;
  let setSurfaceHeatTime: ((simulationTimeSeconds: number) => void) | undefined;
  if (body.surface && !luminous && type !== "black-hole") {
    const heatGeometry = surfaceGeometry.clone();
    const positions = heatGeometry.getAttribute("position");
    const heatColors = new THREE.BufferAttribute(new Float32Array(positions.count * 4), 4);
    heatGeometry.setAttribute("heatColor", heatColors);
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
      const length = Math.hypot(x, y, z);
      if (length > 0 && Number.isFinite(length)) positions.setXYZ(index, x * 1.001, y * 1.001, z * 1.001);
    }
    positions.needsUpdate = true;
    const heatMaterial = new THREE.ShaderMaterial({
      uniforms: { acceptedTimeDecay: { value: 1 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: "attribute vec4 heatColor; varying vec4 vHeatColor; void main() { vHeatColor = heatColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform float acceptedTimeDecay; varying vec4 vHeatColor; void main() { float alpha = vHeatColor.a * acceptedTimeDecay; if (alpha <= 0.001) discard; gl_FragColor = vec4(vHeatColor.rgb, alpha); }",
    });
    surfaceHeatOverlay = new THREE.Mesh(heatGeometry, heatMaterial);
    surfaceHeatOverlay.name = "collision-visual-heat";
    surfaceHeatOverlay.renderOrder = 2;
    surfaceHeatOverlay.visible = false;
    group.add(surfaceHeatOverlay);
    let heatPatches: readonly SurfaceHeatPatch[] = [];
    let heatReferenceTimeSeconds = 0;
    let nextHeatStartTimeSeconds = Number.POSITIVE_INFINITY;
    let hasHeat = false;
    const applySurfaceHeat = (patches: readonly SurfaceHeatPatch[], simulationTimeSeconds: number) => {
      heatPatches = patches;
      heatReferenceTimeSeconds = simulationTimeSeconds;
      nextHeatStartTimeSeconds = Number.POSITIVE_INFINITY;
      hasHeat = false;
      const intensityByCell = new Float32Array(SURFACE_GRID_CELL_COUNT);
      let totalIntensity = 0;
      let peakIntensity = 0;
      for (const patch of patches) {
        if (patch.modelId !== IMPACT_SURFACE_GLOW_MODEL_ID || !Number.isInteger(patch.cellIndex) || patch.cellIndex < 0 || patch.cellIndex >= SURFACE_GRID_CELL_COUNT
          || !Number.isFinite(patch.intensity01) || patch.intensity01 <= 0 || patch.intensity01 > 1
          || !Number.isFinite(patch.startedAtSimulationTimeSeconds) || patch.startedAtSimulationTimeSeconds < 0) continue;
        const intensity = surfaceHeatIntensityAt(patch, simulationTimeSeconds);
        intensityByCell[patch.cellIndex] = intensity;
        totalIntensity += intensity;
        peakIntensity = Math.max(peakIntensity, intensity);
        if (simulationTimeSeconds < patch.startedAtSimulationTimeSeconds) nextHeatStartTimeSeconds = Math.min(nextHeatStartTimeSeconds, patch.startedAtSimulationTimeSeconds);
        hasHeat = true;
      }
      if (peakIntensity > 0) {
        for (let cellIndex = 0; cellIndex < intensityByCell.length; cellIndex += 1) intensityByCell[cellIndex] /= peakIntensity;
      }
      let visible = false;
      for (let index = 0; index < positions.count; index += 1) {
        const localFalloff = Math.pow(sampleSurfaceGrid(intensityByCell, positions.getX(index), positions.getY(index), positions.getZ(index)), 1.5);
        const visualIntensity = localFalloff * Math.min(1, totalIntensity);
        heatColors.setXYZW(index, 1, 0.22 + visualIntensity * 0.52, 0.015, visualIntensity * 0.58);
        visible ||= visualIntensity > 0;
      }
      heatColors.needsUpdate = true;
      heatMaterial.uniforms.acceptedTimeDecay.value = 1;
      surfaceHeatOverlay!.visible = hasHeat && (visible || Number.isFinite(nextHeatStartTimeSeconds));
    };
    setSurfaceHeat = applySurfaceHeat;
    setSurfaceHeatTime = (simulationTimeSeconds) => {
      if (!Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0) return;
      if (simulationTimeSeconds < heatReferenceTimeSeconds || simulationTimeSeconds >= nextHeatStartTimeSeconds) {
        applySurfaceHeat(heatPatches, simulationTimeSeconds);
        return;
      }
      const decay = Math.exp(-Math.LN2 * (simulationTimeSeconds - heatReferenceTimeSeconds) / IMPACT_SURFACE_GLOW_HALF_LIFE_SECONDS);
      heatMaterial.uniforms.acceptedTimeDecay.value = decay;
      surfaceHeatOverlay!.visible = hasHeat && decay > 0.001;
    };
  }
  const cometTail = type === "comet" ? createCometTailVisual() : undefined;
  if (cometTail) group.add(cometTail.mesh);
  if (type === "black-hole" && collisionMode === "creative") {
    const seed = body.id.split("").reduce((value, char) => (value * 31 + char.charCodeAt(0)) % 997, 0);
    const disk = new THREE.Mesh(new THREE.RingGeometry(10.5, 32, 192, 8), blackHoleDiskMaterial(seed));
    disk.name = "black-hole-accretion-disk";
    disk.userData.bodyId = body.id;
    disk.userData.bodyPickExtentMultiplier = 4;
    disk.rotation.x = 0.14;
    disk.userData.visualOnly = true;
    group.add(disk);
    const photonRing = new THREE.Mesh(new THREE.TorusGeometry(9.15, 0.28, 10, 128), new THREE.MeshBasicMaterial({ color: 0xffd6a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    photonRing.name = "black-hole-photon-ring";
    photonRing.userData.bodyId = body.id;
    photonRing.userData.bodyPickExtentMultiplier = 1.18;
    photonRing.userData.visualOnly = true;
    group.add(photonRing);
    for (const [index, color] of [0xff9b52, 0xa6d9ff].entries()) {
      const arc = new THREE.Mesh(new THREE.TorusGeometry(10.4 + index * 0.55, 0.11, 8, 96, Math.PI * 1.08), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false }));
      arc.name = `black-hole-lensing-arc-${index}`;
      arc.userData.bodyId = body.id;
      arc.userData.bodyPickExtentMultiplier = 1.5;
      arc.rotation.set(Math.PI * (0.3 + index * 0.4), 0.22, index * 0.8);
      arc.userData.visualOnly = true;
      group.add(arc);
    }
  }
  const corona = visualId === "sun" && luminous ? new THREE.Mesh(geometry, solarCoronaMaterial()) : undefined;
  if (corona) {
    corona.scale.setScalar(1.04);
    corona.renderOrder = 1;
    group.add(corona);
  }
  const load = (path: string, apply: (texture: THREE.Texture) => void, color = true) => {
    new THREE.TextureLoader().load(`/textures/${path}.jpg`, (texture) => {
      if (!active) { texture.dispose(); return; }
      texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = THREE.RepeatWrapping;
      textures.add(texture);
      apply(texture);
    }, undefined, () => { /* The procedural texture remains usable when a local map fails. */ });
  };
  if (type !== "black-hole" && !(visualId === "sun" && type !== "star") && TEXTURED_BODIES.has(visualId)) {
    const albedo = visualId === "earth" ? highResolution ? "earth-day" : "earth-day-2k" : visualId === "moon" ? highResolution ? "moon-lroc-color-4k" : "moon-lroc-color-2k" : visualId;
    if (material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshStandardMaterial) load(albedo, (texture) => { material.map = texture; material.needsUpdate = true; });
    if (material instanceof THREE.ShaderMaterial && material.uniforms.surfaceMap) load(albedo, (texture) => { material.uniforms.surfaceMap.value = texture; material.uniforms.hasSurfaceMap.value = 1; });
    if (visualId === "moon" && material instanceof THREE.MeshStandardMaterial) {
      // NASA LOLA JPEG is lossy; use it for illustrative relief, never measurement.
      load("moon-lola-height-2k", (texture) => { material.bumpMap = texture; material.bumpScale = 0.008; material.needsUpdate = true; }, false);
    }
  }
  let clouds: THREE.Mesh | undefined;
  let saturnRing: THREE.Mesh | undefined;
  let decorativeEarthAtmosphere: THREE.Mesh | undefined;
  if (!rockyFragment && visualId === "earth" && !luminous && type !== "black-hole") {
    if (material instanceof THREE.MeshStandardMaterial) {
      material.onBeforeCompile = (shader) => {
        configureEarthSurfaceShader(material, shader);
        shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          #if NUM_POINT_LIGHTS > 0
            vec3 citySunDirection = normalize(pointLights[0].position + vViewPosition);
            float cityNightMask = 1.0 - smoothstep(-0.08, 0.12, dot(normal, citySunDirection));
            totalEmissiveRadiance *= cityNightMask * (1.0 - astroWaterCoverage);
          #else
            totalEmissiveRadiance *= 0.0;
          #endif`);
      };
      material.customProgramCacheKey = () => "astro-earth-night-mask-hypsometry-v3-thermal";
      load("earth-night", (texture) => { material.emissiveMap = texture; material.emissive.setHex(0xffffff); material.emissiveIntensity = 0.4; material.needsUpdate = true; });
    }
    const cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, roughness: 1 });
    clouds = new THREE.Mesh(geometry, cloudMaterial);
    clouds.scale.setScalar(1.007);
    clouds.rotation.x = Math.PI / 2;
    group.add(clouds);
    load("earth-clouds", (texture) => { cloudMaterial.alphaMap = texture; cloudMaterial.opacity = 0.66; cloudMaterial.needsUpdate = true; }, false);
    decorativeEarthAtmosphere = new THREE.Mesh(geometry, atmosphereMaterial(0.62));
    decorativeEarthAtmosphere.name = "earth-decorative-atmosphere";
    decorativeEarthAtmosphere.scale.setScalar(1.025);
    decorativeEarthAtmosphere.visible = !body.atmosphere;
    group.add(decorativeEarthAtmosphere);
  }
  let explicitAtmosphere: THREE.Mesh | undefined;
  const setAtmosphereMetrics = (metrics: AtmosphereMetrics | undefined) => {
    if (!active) return;
    if (metrics && !explicitAtmosphere) {
      explicitAtmosphere = new THREE.Mesh(geometry, atmosphereMaterial());
      explicitAtmosphere.name = "body-atmosphere";
      explicitAtmosphere.visible = false;
      group.add(explicitAtmosphere);
    }
    if (metrics && explicitAtmosphere?.material instanceof THREE.ShaderMaterial) {
      explicitAtmosphere.scale.setScalar(updateAtmosphereMaterial(explicitAtmosphere.material, metrics));
      explicitAtmosphere.visible = true;
      if (decorativeEarthAtmosphere) decorativeEarthAtmosphere.visible = false;
    } else if (!metrics && explicitAtmosphere) {
      explicitAtmosphere.removeFromParent();
      (explicitAtmosphere.material as THREE.Material).dispose();
      explicitAtmosphere = undefined;
      if (decorativeEarthAtmosphere) decorativeEarthAtmosphere.visible = true;
    }
  };
  const eclipseSetters: Array<(lights: readonly SceneEclipseLight[]) => void> = [];
  if (material instanceof THREE.MeshStandardMaterial) eclipseSetters.push(installEclipseLighting(material));
  if (clouds?.material instanceof THREE.MeshStandardMaterial) eclipseSetters.push(installEclipseLighting(clouds.material));
  if (!rockyFragment && visualId === "saturn" && type === "gas-giant") {
    const ringMaterial = saturnRingMaterial();
    ringMaterial.emissiveIntensity = 0;
    eclipseSetters.push(installEclipseLighting(ringMaterial));
    const eclipseCompile = ringMaterial.onBeforeCompile;
    const eclipseProgramKey = ringMaterial.customProgramCacheKey();
    ringMaterial.onBeforeCompile = (shader, renderer) => {
      eclipseCompile.call(ringMaterial, shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(
        "directLight.color *= planetShadow;",
        "directLight.color *= mix(0.02, 1.48, smoothstep(0.12, 0.86, planetShadow));",
      );
    };
    ringMaterial.customProgramCacheKey = () => `${eclipseProgramKey}-saturn-planet-shadow-contrast-v3`;
    saturnRing = new THREE.Mesh(createSaturnRingGeometry(), ringMaterial);
    saturnRing.userData.bodyId = body.id;
    saturnRing.userData.bodyPickExtentMultiplier = 2.32;
    saturnRing.rotation.x = 0.47;
    group.add(saturnRing);
  }
  const setEclipseLighting = eclipseSetters.length ? (lights: readonly SceneEclipseLight[]) => eclipseSetters.forEach((set) => set(lights)) : undefined;
  if (luminous || compact) {
    const texture = glowTexture(compact ? type === "neutron-star" ? 1.15 : 1.6 : 3);
    textures.add(texture);
    const color = stellarColorTemperature(body.surfaceTemperatureK);
    const glowColor = new THREE.Color().setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: glowColor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: compact }));
    glow.scale.setScalar(compact ? type === "neutron-star" ? 7 : 4.2 : 8);
    group.add(glow);
  }
  return { group, surface, surfaceHeatOverlay, surfaceWaterOverlay, clouds, ring: saturnRing, corona, cometTail, setEclipseLighting, setSurfaceHeat, setSurfaceHeatTime, setSurfaceWater, setAtmosphereMetrics: rockyFragment || luminous || type === "black-hole" ? undefined : setAtmosphereMetrics, setFragmentHeat: rockyFragment ? (heat) => {
    if (surface.material instanceof THREE.MeshStandardMaterial) surface.material.emissiveIntensity = THREE.MathUtils.clamp(heat, 0, 1) * 4;
  } : undefined, dispose: () => {
    active = false;
    ownedBaseGeometry?.dispose();
    textures.forEach((texture) => texture.dispose());
    group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        if (object instanceof THREE.Mesh && object.geometry !== geometry && !object.geometry.userData.sharedAsset) object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((entry) => entry.dispose());
      }
    });
  } };
}

export function rotateBody(visual: BodyVisual, body: CelestialBody, simulationTime: number, appearanceBody: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK"> = body, animateSurface = true): void {
  const visualId = canonicalVisualId(body.id);
  if (visual.setSurfaceWater) {
    const inventory = body.waterInventory;
    const surfaceWaterKg = inventory ? inventory.liquidKg + inventory.iceKg : 0;
    const water = inventory ? getWaterInventoryMetrics(body) : undefined;
    visual.setSurfaceWater(water?.surfaceCoverageFraction ?? 0, surfaceWaterKg > 0 ? inventory!.iceKg / surfaceWaterKg : 0);
  }
  if (body.spin) {
    const axis = new THREE.Vector3(...body.spin.axisUnitWorld);
    const axisRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    const phase = spinPhaseAtAcceptedTimeRad(body.spin, simulationTime);
    const spinRotation = axisRotation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), phase));
    visual.surface.quaternion.copy(spinRotation);
    visual.surfaceHeatOverlay?.quaternion.copy(spinRotation);
    visual.surfaceWaterOverlay?.quaternion.copy(spinRotation);
    visual.clouds?.quaternion.copy(spinRotation);
    visual.ring?.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  } else {
    const decorativeSpin = (simulationTime / (ROTATION_SECONDS[visualId] ?? 86400)) * Math.PI * 2;
    const tilt = visualId === "earth" ? THREE.MathUtils.degToRad(23.44) : 0;
    visual.surface.rotation.set(Math.PI / 2 + tilt, 0, 0);
    visual.surface.rotateY(decorativeSpin + 1.5);
    visual.surfaceHeatOverlay?.rotation.copy(visual.surface.rotation);
    visual.surfaceWaterOverlay?.rotation.copy(visual.surface.rotation);
    if (visual.clouds) {
      visual.clouds.rotation.set(Math.PI / 2 + tilt, 0, 0);
      visual.clouds.rotateY(decorativeSpin * 1.03 + 1.5);
    }
  }
  const compact = getBodyType(body) === "white-dwarf" || getBodyType(body) === "neutron-star";
  if (isLuminousBody(body) || compact) {
    const color = stellarColorTemperature(appearanceBody.surfaceTemperatureK);
    const luminosityRatio = stellarLuminosityW(appearanceBody) / stellarLuminosityW({ radiusM: 695700000, surfaceTemperatureK: 5772 });
    const visualResponse = stellarVisualResponse(appearanceBody);
    const boundedTime = Number.isFinite(simulationTime) ? ((simulationTime % 314159) + 314159) % 314159 * 0.00002 : 0;
    if (visual.surface.material instanceof THREE.ShaderMaterial) {
      visual.surface.material.uniforms.baseColor.value.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
      visual.surface.material.uniforms.surfaceTime.value = animateSurface ? boundedTime : 0;
      visual.surface.material.uniforms.temperatureMapBlend.value = THREE.MathUtils.smoothstep(appearanceBody.surfaceTemperatureK, 5772, 12000);
      if (visualId === "sun") visual.surface.material.uniforms.surfaceActivity.value = getBodyType(body) === "white-dwarf" ? 0 : visualResponse.surfaceActivity;
      // Compact remnants use a bounded art fill; ordinary stars retain their accepted luminosity response.
      visual.surface.material.uniforms.surfaceBrightness.value = compact ? getBodyType(body) === "white-dwarf" ? 0.78 : 1 : 0.5 + 0.5 * Math.sqrt(stellarVisualBrightness(luminosityRatio));
    } else if (visual.surface.material instanceof THREE.MeshBasicMaterial) {
      visual.surface.material.color.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
      visual.surface.material.toneMapped = false;
    }
    const emitting = appearanceBody.surfaceTemperatureK > 0;
    visual.surface.visible = emitting;
    const glow = visual.group.children.find((object): object is THREE.Sprite => object instanceof THREE.Sprite);
    if (glow) {
      const glowMaterial = Array.isArray(glow.material) ? glow.material[0] : glow.material;
      if (glowMaterial instanceof THREE.SpriteMaterial) {
        glowMaterial.color.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
        glowMaterial.opacity = emitting ? compact ? getBodyType(body) === "neutron-star" ? 0.96 : 0.34 : Math.min(0.72, Math.max(0.08, 0.28 * Math.log10(1 + luminosityRatio))) : 0;
      }
      glow.visible = emitting;
    }
    if (visual.corona) {
      visual.corona.rotation.copy(visual.surface.rotation);
      visual.corona.visible = emitting;
      const coronaMaterial = visual.corona.material as THREE.ShaderMaterial;
      coronaMaterial.uniforms.surfaceTime.value = animateSurface ? boundedTime : 0;
      coronaMaterial.uniforms.coronaIntensity.value = visualResponse.coronaIntensity;
      coronaMaterial.uniforms.coronaColor.value.setRGB(color.r, color.g * 0.72, color.b * 0.48, THREE.SRGBColorSpace);
    }
  } else if (visual.surface.material instanceof THREE.MeshStandardMaterial && !visual.setFragmentHeat) {
    const water = getWaterInventoryMetrics(body);
    if (visualId === "earth") {
      const acceptedPhase = body.waterInventory
        ? {
          iceFraction: body.waterInventory.liquidKg + body.waterInventory.iceKg > 0
            ? body.waterInventory.iceKg / (body.waterInventory.liquidKg + body.waterInventory.iceKg)
            : 0,
          vaporFraction: water.vaporFraction,
        }
        : undefined;
      const { ice, vapor } = updateEarthSurfaceResponse(visual.surface.material, body.surfaceTemperatureK, water.surfaceCoverageFraction, acceptedPhase);
      if (visual.clouds?.material instanceof THREE.MeshStandardMaterial) {
        visual.clouds.material.opacity = THREE.MathUtils.clamp(Math.max(water.surfaceCoverageFraction, water.vaporFraction) * (0.42 + ice * 0.16 + vapor * 0.2), 0, 0.72);
        visual.clouds.material.color.setRGB(1, 0.97 - vapor * 0.05, 0.92 - vapor * 0.13);
        visual.clouds.scale.setScalar(1.007 + vapor * 0.009 + ice * 0.002);
      }
      return;
    }
    const genericRock = getBodyType(body) === "rocky-planet" && !TEXTURED_BODIES.has(visualId);
    updateSurfaceMaterialColor(visual.surface.material, genericRock ? genericRockTint(body.id).getHex() : 0xffffff, body.surfaceTemperatureK, water.surfaceCoverageFraction, { phase: water.phase, ...(genericRock ? { phaseTintStrength: 0.28, minimumRoughness: 0.9 } : {}), ...(body.waterInventory ? { vaporFraction: water.vaporFraction } : {}) });
  }
  for (const child of visual.group.children) if (child.name === "black-hole-accretion-disk" && child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) {
    child.material.uniforms.diskTime.value = animateSurface ? ((simulationTime % 100000) + 100000) % 100000 * 0.0002 : 0;
  }
}
