import * as THREE from "three";
import { classifyWaterPhase, type WaterPhase } from "@/simulation/surface-phase";
import { SURFACE_GRID_CELL_COUNT } from "@/simulation/surface-state";
import type { SurfaceReliefPatch } from "@/simulation/types";
import { stellarColorTemperature } from "./body-appearance";

const PHASE_TINT: Record<WaterPhase, number | null> = {
  ice: 0x8fc8d4,
  liquid: 0x3f9b93,
  vapor: 0xd99358,
  unsupported: null,
};

const DEFAULT_ROUGHNESS = 0.82;
const DEFAULT_METALNESS = 0.02;
const THERMAL_GLOW_START_K = 650;
const THERMAL_GLOW_FULL_K = 2200;

type EarthShader = Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0];
type ThermalGlow = { color: THREE.Color; intensity: number };
type EarthSurfaceState = { waterFraction: number; ice: number; warm: number; thermalTemperatureK: number; thermalGlow: ThermalGlow; shader?: EarthShader };
type ThermalMaterialState = { temperatureK: number; baseColor: THREE.Color; baseIntensity: number; baseMap: THREE.Texture | null; ownsMap: boolean };
type SurfaceMaterialOptions = { phase?: WaterPhase; phaseTintStrength?: number; minimumRoughness?: number; vaporFraction?: number };
type SurfaceWaterResponse = { coverage: number; iceFraction: number; levelM: number; transitionM: number };
type SurfaceWaterDistribution = { sorted: number[]; depressed: number[]; transitionM: number };

function deriveSurfaceWaterDistribution(patches: readonly SurfaceReliefPatch[]): SurfaceWaterDistribution {
  const elevations = new Float32Array(SURFACE_GRID_CELL_COUNT);
  for (const patch of patches) {
    if (Number.isInteger(patch.cellIndex) && patch.cellIndex >= 0 && patch.cellIndex < SURFACE_GRID_CELL_COUNT && Number.isFinite(patch.elevationM)) {
      elevations[patch.cellIndex] = patch.elevationM;
    }
  }
  const sorted = Array.from(elevations).sort((left, right) => left - right);
  const depressed = sorted.filter((elevation) => elevation < 0);
  return { sorted, depressed, transitionM: Math.max(0.01, (sorted[sorted.length - 1]! - sorted[0]!) * 0.01) };
}

function deriveSurfaceWaterResponse(distribution: SurfaceWaterDistribution, coverage: number, iceFraction: number): SurfaceWaterResponse | undefined {
  if (!Number.isFinite(coverage) || coverage <= 0 || !Number.isFinite(iceFraction)) return undefined;
  if (distribution.depressed.length === 0) return undefined;
  const wetCellCount = Math.max(1, Math.min(SURFACE_GRID_CELL_COUNT, Math.ceil(Math.min(1, coverage) * SURFACE_GRID_CELL_COUNT)));
  const levelM = wetCellCount <= distribution.depressed.length
    ? distribution.depressed[wetCellCount - 1]!
    : distribution.sorted[wetCellCount - 1]!;
  return { coverage: Math.min(1, coverage), iceFraction: Math.max(0, Math.min(1, iceFraction)), levelM, transitionM: distribution.transitionM };
}

export function surfaceWaterMaskAtElevation(elevationM: number, response: SurfaceWaterResponse | undefined): number {
  if (!response || !Number.isFinite(elevationM)) return 0;
  const amount = Math.max(0, Math.min(1, (response.levelM + response.transitionM - elevationM) / (2 * response.transitionM)));
  const smooth = amount * amount * (3 - 2 * amount);
  return smooth;
}

export function createSurfaceWaterMaterial(patches: readonly SurfaceReliefPatch[]): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0, transparent: true, depthWrite: false });
  const state: { distribution: SurfaceWaterDistribution; response?: SurfaceWaterResponse; shader?: Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0] } = {
    distribution: deriveSurfaceWaterDistribution(patches),
  };
  material.userData.surfaceWaterState = state;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.surfaceWaterCoverage = { value: state.response?.coverage ?? 0 };
    shader.uniforms.surfaceWaterLevelM = { value: state.response?.levelM ?? 0 };
    shader.uniforms.surfaceWaterTransitionM = { value: state.response?.transitionM ?? 1 };
    shader.uniforms.surfaceWaterIceFraction = { value: state.response?.iceFraction ?? 0 };
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute float surfaceElevation; varying float vSurfaceElevation;");
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvSurfaceElevation = surfaceElevation;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nuniform float surfaceWaterCoverage; uniform float surfaceWaterLevelM; uniform float surfaceWaterTransitionM; uniform float surfaceWaterIceFraction; varying float vSurfaceElevation;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
      float surfaceWaterMask = 1.0 - smoothstep(surfaceWaterLevelM - surfaceWaterTransitionM, surfaceWaterLevelM + surfaceWaterTransitionM, vSurfaceElevation);
      if (surfaceWaterMask <= 0.001) discard;
      vec3 liquidWaterColor = vec3(0.035, 0.22, 0.42);
      vec3 surfaceIceColor = vec3(0.72, 0.86, 0.94);
      diffuseColor.rgb = mix(liquidWaterColor, surfaceIceColor, surfaceWaterIceFraction);
      diffuseColor.a = surfaceWaterMask * 0.88;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, mix(0.16, 0.94, surfaceWaterIceFraction), surfaceWaterMask);`);
    state.shader = shader;
  };
  material.customProgramCacheKey = () => "astro-surface-water-depressions-v1";
  return material;
}

export function updateSurfaceWaterMaterial(material: THREE.MeshStandardMaterial, coverage: number, iceFraction: number): boolean {
  const state = material.userData.surfaceWaterState as { distribution: SurfaceWaterDistribution; response?: SurfaceWaterResponse; shader?: Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0] } | undefined;
  if (!state) return false;
  const response = deriveSurfaceWaterResponse(state.distribution, coverage, iceFraction);
  const previous = state.response;
  if (response && previous && response.coverage === previous.coverage && response.iceFraction === previous.iceFraction && response.levelM === previous.levelM) return true;
  if (!response && !previous) return false;
  state.response = response;
  if (state.shader) {
    state.shader.uniforms.surfaceWaterCoverage.value = response?.coverage ?? 0;
    state.shader.uniforms.surfaceWaterLevelM.value = response?.levelM ?? 0;
    state.shader.uniforms.surfaceWaterTransitionM.value = response?.transitionM ?? 1;
    state.shader.uniforms.surfaceWaterIceFraction.value = response?.iceFraction ?? 0;
  }
  return response !== undefined;
}

function thermalGlow(temperatureK: number): ThermalGlow {
  const amount = THREE.MathUtils.smoothstep(temperatureK, THERMAL_GLOW_START_K, THERMAL_GLOW_FULL_K);
  const color = stellarColorTemperature(Math.max(1667, Math.min(6000, temperatureK)));
  return {
    color: new THREE.Color().setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace),
    intensity: 3.6 * amount ** 1.35,
  };
}

function updateThermalMaterial(material: THREE.MeshStandardMaterial, temperatureK: number): void {
  let state = material.userData.thermalGlow as ThermalMaterialState | undefined;
  if (state?.temperatureK === temperatureK) {
    if (state.ownsMap && material.emissiveMap !== material.map) {
      material.emissiveMap = material.map;
      material.needsUpdate = true;
    } else if (!state.ownsMap && temperatureK > THERMAL_GLOW_START_K && material.map) {
      state.baseMap = material.emissiveMap;
      state.ownsMap = true;
      material.emissiveMap = material.map;
      material.needsUpdate = true;
    }
    return;
  }
  if (!state) {
    state = { temperatureK: Number.NaN, baseColor: material.emissive.clone(), baseIntensity: material.emissiveIntensity, baseMap: material.emissiveMap, ownsMap: false };
    material.userData.thermalGlow = state;
  }
  const glow = thermalGlow(temperatureK);
  if (glow.intensity > 0) {
    if (!state.ownsMap && material.map) {
      state.baseMap = material.emissiveMap;
      state.ownsMap = true;
      material.emissiveMap = material.map;
      material.needsUpdate = true;
    }
    material.emissive.copy(glow.color);
    material.emissiveIntensity = state.baseIntensity + glow.intensity;
  } else {
    if (state.ownsMap) {
      material.emissiveMap = state.baseMap;
      state.ownsMap = false;
      material.needsUpdate = true;
    }
    material.emissive.copy(state.baseColor);
    material.emissiveIntensity = state.baseIntensity;
  }
  state.temperatureK = temperatureK;
}

export function installEarthSurfaceResponse(material: THREE.MeshStandardMaterial): void {
  material.userData.earthSurfaceState = { waterFraction: 1, ice: 0, warm: 0, thermalTemperatureK: Number.NaN, thermalGlow: thermalGlow(0) } satisfies EarthSurfaceState;
  material.customProgramCacheKey = () => "astro-earth-hypsometry-v3-thermal";
}

export function configureEarthSurfaceShader(material: THREE.MeshStandardMaterial, shader: EarthShader): void {
  const state = material.userData.earthSurfaceState as EarthSurfaceState;
  shader.uniforms.astroWaterFraction = { value: state.waterFraction };
  shader.uniforms.astroIceCover = { value: state.ice };
  shader.uniforms.astroWarm = { value: state.warm };
  shader.uniforms.astroThermalColor = { value: state.thermalGlow.color };
  shader.uniforms.astroThermalIntensity = { value: state.thermalGlow.intensity };
  shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nuniform float astroWaterFraction; uniform float astroIceCover; uniform float astroWarm; uniform vec3 astroThermalColor; uniform float astroThermalIntensity;`);
  shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
    vec3 astroMapColor = texture2D(map, vMapUv).rgb;
    float astroOcean = smoothstep(0.015, 0.12, astroMapColor.b - max(astroMapColor.r, astroMapColor.g) * 1.15);
    float astroMapLight = dot(astroMapColor, vec3(0.2126, 0.7152, 0.0722));
    float astroMapChroma = max(astroMapColor.r, max(astroMapColor.g, astroMapColor.b)) - min(astroMapColor.r, min(astroMapColor.g, astroMapColor.b));
    float astroSnow = smoothstep(0.48, 0.78, astroMapLight) * (1.0 - smoothstep(0.08, 0.5, astroMapChroma));
    vec3 astroDryOcean = vec3(0.08, 0.05, 0.03) + vec3(0.55, 0.48, 0.3) * astroMapLight;
    vec3 astroDrySurface = mix(astroMapColor, astroDryOcean, astroOcean);
    float astroOriginalWater = astroOcean * min(astroWaterFraction / 0.71, 1.0);
    float astroFloodLevel = smoothstep(0.71, 1.0, astroWaterFraction) * 1.2;
    float astroReliefHeight = clamp(0.12 + 0.82 * astroMapLight, 0.12, 0.94);
    float astroFloodedLand = (1.0 - astroOcean) * smoothstep(astroReliefHeight - 0.07, astroReliefHeight + 0.07, astroFloodLevel);
    float astroWaterCoverage = max(astroOriginalWater, astroFloodedLand);
    vec3 astroLiquidWater = vec3(0.045, 0.16, 0.31) + vec3(0.02, 0.11, 0.2) * astroMapLight;
    vec3 astroSurface = mix(astroDrySurface, astroLiquidWater, astroWaterCoverage);
    vec3 astroWarmSnow = vec3(astroMapLight * 0.7, astroMapLight * 0.55, astroMapLight * 0.38);
    float astroRemoveBakedIce = max(astroWarm, 1.0 - smoothstep(0.0, 0.2, astroWaterFraction));
    astroSurface = mix(astroSurface, astroWarmSnow, astroRemoveBakedIce * astroSnow * 0.92);
    float astroReliefTone = 0.68 + 0.38 * astroMapLight;
    vec3 astroIce = vec3(0.68, 0.79, 0.86) * astroReliefTone;
    diffuseColor.rgb = mix(astroSurface, astroIce, astroIceCover * 0.88);`);
  shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
    roughnessFactor = mix(roughnessFactor, 0.18, astroWaterCoverage);
    roughnessFactor = mix(roughnessFactor, 0.96, astroIceCover);`);
  shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
    totalEmissiveRadiance += diffuseColor.rgb * astroThermalColor * astroThermalIntensity;`);
  state.shader = shader;
}

export function updateEarthSurfaceResponse(
  material: THREE.MeshStandardMaterial,
  temperatureK: number,
  waterFraction: number,
  acceptedPhase?: { iceFraction: number; vaporFraction: number },
): { ice: number; vapor: number } {
  const state = material.userData.earthSurfaceState as EarthSurfaceState | undefined;
  const water = THREE.MathUtils.clamp(waterFraction, 0, 1);
  const ice = water === 0 ? 0 : acceptedPhase
    ? THREE.MathUtils.clamp(acceptedPhase.iceFraction, 0, 1)
    : 1 - THREE.MathUtils.smoothstep(temperatureK, 269.15, 273.15);
  const vapor = acceptedPhase
    ? THREE.MathUtils.clamp(acceptedPhase.vaporFraction, 0, 1)
    : water === 0 ? 0 : THREE.MathUtils.smoothstep(temperatureK, 373.15, 378.15);
  const liquid = acceptedPhase ? water * (1 - ice) : water * (1 - ice) * (1 - vapor);
  if (state) {
    state.waterFraction = liquid; state.ice = ice * water; state.warm = THREE.MathUtils.smoothstep(temperatureK, 288, 373);
    if (state.thermalTemperatureK !== temperatureK) {
      state.thermalTemperatureK = temperatureK;
      state.thermalGlow = thermalGlow(temperatureK);
      if (state.shader) {
        state.shader.uniforms.astroThermalColor.value.copy(state.thermalGlow.color);
        state.shader.uniforms.astroThermalIntensity.value = state.thermalGlow.intensity;
      }
    }
    if (state.shader) {
      state.shader.uniforms.astroWaterFraction.value = state.waterFraction;
      state.shader.uniforms.astroIceCover.value = state.ice;
      state.shader.uniforms.astroWarm.value = state.warm;
    }
  }
  material.roughness = 0.84;
  material.metalness = 0.02;
  material.opacity = 1; material.transparent = false; material.depthWrite = true;
  return { ice, vapor };
}

export function updateSurfaceMaterialColor(
  material: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial,
  baseColor: number,
  temperatureK: number,
  waterFraction: number,
  options: SurfaceMaterialOptions = {},
): void {
  material.color.setHex(baseColor);
  const phase = options.phase ?? (waterFraction === 0 ? "unsupported" : classifyWaterPhase(temperatureK));
  const vapor = options.vaporFraction ?? (phase === "vapor" ? waterFraction : 0);
  if (material instanceof THREE.MeshStandardMaterial) {
    const phaseRoughness = { ice: 0.96, liquid: 0.18, vapor: 0.72, unsupported: DEFAULT_ROUGHNESS }[phase];
    material.roughness = Math.max(options.minimumRoughness ?? 0, THREE.MathUtils.lerp(DEFAULT_ROUGHNESS, phaseRoughness, waterFraction));
    material.metalness = THREE.MathUtils.lerp(DEFAULT_METALNESS, phase === "liquid" ? 0.08 : DEFAULT_METALNESS, waterFraction);
    const opacity = options.vaporFraction === undefined && phase === "vapor"
      ? 1 - 0.65 * THREE.MathUtils.clamp(vapor, 0, 1)
      : 1;
    if (material.opacity !== opacity || material.transparent !== (opacity < 1)) material.needsUpdate = true;
    material.opacity = opacity;
    material.transparent = opacity < 1;
    material.depthWrite = opacity === 1;
    updateThermalMaterial(material, temperatureK);
  }
  const tintAmount = phase === "vapor" ? vapor : waterFraction;
  if (tintAmount <= 0) return;
  const tint = PHASE_TINT[phase];
  if (tint !== null) material.color.lerp(new THREE.Color(tint), Math.min(0.72, tintAmount * 0.85) * (options.phaseTintStrength ?? 1));
}
