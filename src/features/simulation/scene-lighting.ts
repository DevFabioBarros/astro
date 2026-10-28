import { isLuminousBody } from "@/simulation/body-catalog";
import { stellarLuminosityW } from "@/simulation/stellar-evolution";
import type { CelestialBody } from "@/simulation/types";
import { stellarColorTemperature, stellarLightIntensity } from "./body-appearance";

const MAX_SCENE_LIGHT_INTENSITY = 6.4;
const SOLAR_REFERENCE_INTENSITY = 1.6;
const SOLAR_LIGHT_MODEL_ANCHOR = 3.1;
const ASTRONOMICAL_UNIT_M = 149_597_870_700;
const DISTANCE_SOFTENING_AU = 0.1;
const MAX_STELLAR_DISTANCE_FACTOR = 4;

export type SceneLightSource = {
  body: CelestialBody;
  intensity: number;
  color: { r: number; g: number; b: number };
};

export type SceneEclipseLight = {
  sourcePosition: readonly [number, number, number];
  sourceRadius: number;
  distanceFactor: number;
  blockerPosition: readonly [number, number, number];
  blockerRadius: number;
  blockerId?: string;
};

export function sceneLightSourceLimit(pixelRatio: number, maxTextureSize: number): 2 | 4 {
  return pixelRatio >= 1.5 && maxTextureSize >= 8192 ? 4 : 2;
}

/** Bounded tone-mapping target from normalized scene-light load, not physical exposure. */
export function sceneExposureTarget(totalIntensity: number): number {
  const load = Number.isFinite(totalIntensity) ? Math.max(0, totalIntensity) : 0;
  return Math.max(0.82, 1 - 0.055 * Math.max(0, load / SOLAR_REFERENCE_INTENSITY - 1));
}

/** Visual light budget only; it is not an irradiance or thermal-energy model. */
export function selectSceneLightSources(bodies: readonly CelestialBody[], maxSources = 2): SceneLightSource[] {
  const sources = bodies.flatMap((body) => {
    if (!isLuminousBody(body)
      || !Number.isFinite(body.radiusM) || body.radiusM <= 0
      || !Number.isFinite(body.surfaceTemperatureK) || body.surfaceTemperatureK <= 0) return [];

    const luminosityW = stellarLuminosityW(body);
    const intensity = stellarLightIntensity(body) * (SOLAR_REFERENCE_INTENSITY / SOLAR_LIGHT_MODEL_ANCHOR);
    const color = stellarColorTemperature(body.surfaceTemperatureK);
    if (!Number.isFinite(luminosityW) || luminosityW <= 0 || !Number.isFinite(intensity) || intensity <= 0) return [];

    return [{ body, luminosityW, intensity, color }];
  }).sort((left, right) => right.luminosityW - left.luminosityW)
    .slice(0, Number.isFinite(maxSources) ? Math.max(0, Math.min(4, Math.floor(maxSources))) : 2);

  const totalIntensity = sources.reduce((total, source) => total + source.intensity, 0);
  const scale = totalIntensity > MAX_SCENE_LIGHT_INTENSITY ? MAX_SCENE_LIGHT_INTENSITY / totalIntensity : 1;
  return sources.map(({ body, intensity, color }) => ({ body, intensity: intensity * scale, color }));
}

export type SceneOccluder = { id: string; position: readonly [number, number, number]; radius: number };

/** Ray/sphere approximation for a screen-space flare; units need only match within the scene. */
export function isSceneSourceOccluded(
  sourceId: string,
  sourcePosition: readonly [number, number, number],
  observerPosition: readonly [number, number, number],
  occluders: readonly SceneOccluder[],
): boolean {
  const direction = sourcePosition.map((value, axis) => value - observerPosition[axis]!) as [number, number, number];
  const distance = Math.hypot(...direction);
  if (!(distance > 0) || !Number.isFinite(distance)) return false;
  const unit = direction.map((value) => value / distance) as [number, number, number];
  for (const body of occluders) {
    if (body.id === sourceId || !(body.radius > 0) || !Number.isFinite(body.radius)) continue;
    const relative = body.position.map((value, axis) => value - observerPosition[axis]!) as [number, number, number];
    const along = relative[0] * unit[0] + relative[1] * unit[1] + relative[2] * unit[2];
    const closestAlong = Math.max(0, Math.min(distance, along));
    const perpendicularSquared = relative.reduce((sum, value, axis) => sum + (value - unit[axis]! * closestAlong) ** 2, 0);
    if (perpendicularSquared <= body.radius ** 2) return true;
  }
  return false;
}

function circleOverlapFraction(sourceRadius: number, occulterRadius: number, separation: number): number {
  if (separation >= sourceRadius + occulterRadius) return 0;
  if (separation <= Math.abs(sourceRadius - occulterRadius)) {
    return Math.min(1, Math.min(sourceRadius, occulterRadius) ** 2 / sourceRadius ** 2);
  }
  const sourceAngle = Math.acos((separation ** 2 + sourceRadius ** 2 - occulterRadius ** 2) / (2 * separation * sourceRadius));
  const occulterAngle = Math.acos((separation ** 2 + occulterRadius ** 2 - sourceRadius ** 2) / (2 * separation * occulterRadius));
  const radical = Math.max(0, (-separation + sourceRadius + occulterRadius) * (separation + sourceRadius - occulterRadius)
    * (separation - sourceRadius + occulterRadius) * (separation + sourceRadius + occulterRadius));
  const overlap = sourceRadius ** 2 * sourceAngle + occulterRadius ** 2 * occulterAngle - 0.5 * Math.sqrt(radical);
  return Math.max(0, Math.min(1, overlap / (Math.PI * sourceRadius ** 2)));
}

/** Visual inverse-square response, normalized to the existing Earth-at-1-AU scene brightness. */
export function sceneStellarDistanceFactor(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0) return 0;
  const distanceAu = distanceM / ASTRONOMICAL_UNIT_M;
  const softeningSquared = DISTANCE_SOFTENING_AU ** 2;
  const normalized = (1 + softeningSquared) / (distanceAu ** 2 + softeningSquared);
  return Math.min(MAX_STELLAR_DISTANCE_FACTOR, Math.max(0, normalized));
}

export type EclipseBlocker = {
  bodyId: string;
  positionM: CelestialBody["positionM"];
  radiusM: number;
  sourceRadiusM: number;
  coverage: number;
};

/** Selects one strongest apparent blocker; radii may be renderer-assisted in overview. */
export function findStrongestEclipseBlocker(
  source: CelestialBody,
  target: CelestialBody,
  bodies: readonly CelestialBody[],
  radiusForBody: (body: CelestialBody) => number = (body) => body.radiusM,
): EclipseBlocker | undefined {
  const sourceVector = source.positionM.map((value, axis) => value - target.positionM[axis]!) as [number, number, number];
  const sourceDistance = Math.hypot(...sourceVector);
  const sourceRadiusM = radiusForBody(source);
  if (!(sourceDistance > 0 && sourceRadiusM > 0) || !Number.isFinite(sourceDistance + sourceRadiusM)) return undefined;
  const sourceAngle = Math.asin(Math.min(1, sourceRadiusM / sourceDistance));
  const direction = sourceVector.map((value) => value / sourceDistance) as [number, number, number];
  let strongest: EclipseBlocker | undefined;

  for (const body of bodies) {
    const radiusM = radiusForBody(body);
    if (body.id === source.id || body.id === target.id || !(radiusM > 0) || !Number.isFinite(radiusM)) continue;
    const relative = body.positionM.map((value, axis) => value - target.positionM[axis]!) as [number, number, number];
    const along = relative[0] * direction[0] + relative[1] * direction[1] + relative[2] * direction[2];
    if (!(along > 0 && along < sourceDistance)) continue;
    const distance = Math.hypot(...relative);
    if (!(distance > 0) || !Number.isFinite(distance)) continue;
    const perpendicular = Math.sqrt(Math.max(0, distance ** 2 - along ** 2));
    const blockerAngle = Math.asin(Math.min(1, radiusM / distance));
    const separation = Math.atan2(perpendicular, along);
    if (separation >= sourceAngle + blockerAngle) continue;
    const coverage = circleOverlapFraction(sourceAngle, blockerAngle, separation);
    if (!strongest || coverage > strongest.coverage || (coverage === strongest.coverage && body.id < strongest.bodyId)) {
      strongest = { bodyId: body.id, positionM: body.positionM, radiusM, sourceRadiusM, coverage };
    }
  }
  return strongest;
}
