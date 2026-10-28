import type { CelestialBody, EnvironmentSeed, PhysicsSettings, SurfaceData, SurfaceReliefPatch, SimulationEvent, Vector3 } from "./types";
import {
  MAX_SURFACE_RELIEF_M,
  SURFACE_GRID_CELL_COUNT,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  isValidSurfaceMetadata,
  validateSurfaceData,
} from "./surface-state";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "./world-seed";

export const IMPACT_CRATER_MODEL_ID = "impact-crater-visual-v1" as const;

type SurfaceWorld = {
  bodies: CelestialBody[];
  settings: PhysicsSettings;
  surfaceData: SurfaceData;
};

type SurfaceWorldResult = SurfaceWorld;

export function updateSurfaceAfterAcceptedCollision(
  beforeBodies: readonly CelestialBody[],
  afterBodies: CelestialBody[],
  event: Pick<SimulationEvent, "bodyIds" | "contact" | "outcome">,
  settings: PhysicsSettings,
  environmentSeedOrSurfaceData: EnvironmentSeed | SurfaceData,
  providedSurfaceData?: SurfaceData,
): SurfaceWorldResult {
  const environmentSeed = typeof environmentSeedOrSurfaceData === "number" ? environmentSeedOrSurfaceData : DEFAULT_ENVIRONMENT_SEED_V1;
  const surfaceData = typeof environmentSeedOrSurfaceData === "number" ? providedSurfaceData ?? {} : environmentSeedOrSurfaceData;
  const prune = (bodies: CelestialBody[], data: SurfaceData): SurfaceWorldResult => {
    const referencedIds = new Set(bodies.flatMap(({ surface }) => surface ? [surface.dataId] : []));
    const oldIds = Object.keys(data);
    const nextSurfaceData = oldIds.length === referencedIds.size && oldIds.every((id) => referencedIds.has(id))
      ? data
      : Object.fromEntries(oldIds.filter((id) => referencedIds.has(id)).map((id) => [id, data[id]!])) as SurfaceData;
    validateSurfaceData(nextSurfaceData, bodies.flatMap(({ surface }) => surface ? [surface] : []));
    return { bodies, settings, surfaceData: nextSurfaceData };
  };
  const outcome = event.outcome;
  if (!outcome || outcome.kind !== "perfectly-inelastic-merge" || event.bodyIds.length !== 2
    || !event.contact || !event.contact.normalM) return prune(afterBodies, surfaceData);
  const normal = event.contact.normalM;
  const point = event.contact.pointM;
  if (!Array.isArray(normal) || normal.length !== 3 || !normal.every(Number.isFinite)
    || Math.abs(Math.hypot(...normal) - 1) > 1e-6 || !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
    return prune(afterBodies, surfaceData);
  }
  const [firstId, secondId] = event.bodyIds;
  const first = beforeBodies.find(({ id }) => id === firstId);
  const second = beforeBodies.find(({ id }) => id === secondId);
  const survivor = afterBodies.find(({ id }) => id === outcome.survivorBodyId);
  if (!first || !second || !survivor) return prune(afterBodies, surfaceData);
  const absorbed = first.id === survivor.id ? second : second.id === survivor.id ? first : undefined;
  if (!absorbed) return prune(afterBodies, surfaceData);
  let selectedSurface = survivor.surface ?? absorbed.surface;
  let nextSurfaceData = surfaceData;
  if (!selectedSurface) {
    const seedInput = `${environmentSeed}:${survivor.id}:sparse-relief-v1`;
    let seed = 2166136261;
    for (const char of seedInput) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
    const nextDataId = resolveDataId(survivor.id, 0, surfaceData);
    selectedSurface = { modelId: "sparse-relief-v1", seed: seed >>> 0, revision: 0, resolution: SURFACE_GRID_WIDTH, dataId: nextDataId };
    nextSurfaceData = { ...surfaceData, [nextDataId]: [] };
  }
  const bodiesWithSurvivorSurface = afterBodies.map((body) => body.id === survivor.id ? { ...body, surface: selectedSurface } : body);
  const unchanged = prune(bodiesWithSurvivorSurface, nextSurfaceData);
  const radial = point.map((coordinate, axis) => coordinate - survivor.positionM[axis]!) as [number, number, number];
  const radialLength = Math.hypot(...radial);
  if (!Number.isFinite(radialLength)) return unchanged;
  const direction = radialLength > 0
    ? radial.map((coordinate) => coordinate / radialLength) as [number, number, number]
    : normal.map((coordinate) => coordinate * (survivor.id === first.id ? 1 : -1)) as [number, number, number];
  try {
    return applyImpactCrater(unchanged, survivor.id, direction, Math.min(first.radiusM, second.radiusM));
  } catch (error) {
    if (error instanceof Error && (error.message === "Direção de impacto inválida." || error.message === "Direção de impacto deve ser unitária.")) return unchanged;
    throw error;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeDirection(direction: Vector3): [number, number, number] {
  if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(Number.isFinite)) {
    throw new Error("Direção de impacto inválida.");
  }
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-6) throw new Error("Direção de impacto deve ser unitária.");
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function makeCellDirection(cellIndex: number): [number, number, number] {
  const row = Math.floor(cellIndex / SURFACE_GRID_WIDTH);
  const column = cellIndex % SURFACE_GRID_WIDTH;
  const latitude = -Math.PI / 2 + ((row + 0.5) * Math.PI) / SURFACE_GRID_HEIGHT;
  const longitude = -Math.PI + ((column + 0.5) * 2 * Math.PI) / SURFACE_GRID_WIDTH;
  const latitudeCosine = Math.cos(latitude);
  return [latitudeCosine * Math.cos(longitude), Math.sin(latitude), latitudeCosine * Math.sin(longitude)];
}

function resolveDataId(bodyId: string, revision: number, existing: SurfaceData): string {
  const base = `${bodyId}-relief-${revision}`.slice(0, 110);
  let candidate = base;
  let suffix = 1;
  while (Object.hasOwn(existing, candidate)) candidate = `${base.slice(0, 110 - String(suffix).length)}-${suffix++}`;
  return candidate;
}

/** Applies a visual-only crater to an accepted surface sidecar without changing physical body state. */
export function applyImpactCrater(
  world: SurfaceWorld,
  bodyId: string,
  impactDirection: Vector3,
  smallerPreImpactRadiusM: number,
): SurfaceWorldResult {
  if (!world || !Array.isArray(world.bodies) || !world.surfaceData || typeof world.surfaceData !== "object") {
    throw new Error("Estado de superfície inválido.");
  }
  const targetIndex = world.bodies.findIndex((body) => body.id === bodyId);
  const target = world.bodies[targetIndex];
  if (!target || !isValidSurfaceMetadata(target.surface)) throw new Error("Corpo sem metadata de superfície válida.");
  if (!Number.isFinite(target.radiusM) || target.radiusM <= 0
    || !Number.isFinite(smallerPreImpactRadiusM) || smallerPreImpactRadiusM <= 0 || smallerPreImpactRadiusM >= target.radiusM) {
    throw new Error("Raios do impacto inválidos.");
  }
  const direction = normalizeDirection(impactDirection);
  if (!Number.isSafeInteger(target.surface.revision) || target.surface.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Revisão de superfície esgotada.");
  }

  const metadata = world.bodies.flatMap((body) => body.surface ? [body.surface] : []);
  validateSurfaceData(world.surfaceData, metadata);
  const targetData = world.surfaceData[target.surface.dataId];
  if (!targetData) throw new Error("Dados da superfície ausentes.");

  const nextRevision = target.surface.revision + 1;
  const shared = world.bodies.some((body, index) => index !== targetIndex && body.surface?.dataId === target.surface!.dataId);
  const nextDataId = shared ? resolveDataId(bodyId, nextRevision, world.surfaceData) : target.surface.dataId;
  const nextData: SurfaceReliefPatch[] = targetData.map(({ cellIndex, elevationM }) => ({ cellIndex, elevationM }));
  const elevationByCell = new Map(nextData.map(({ cellIndex, elevationM }) => [cellIndex, elevationM]));

  const angularRadius = Math.min(Math.PI / 4, Math.max(0.3, (3 * smallerPreImpactRadiusM) / target.radiusM));
  const bowlRadius = angularRadius * 0.72;
  const depth = Math.min(angularRadius * target.radiusM * 0.06, MAX_SURFACE_RELIEF_M * 0.5);
  for (let cellIndex = 0; cellIndex < SURFACE_GRID_CELL_COUNT; cellIndex += 1) {
    const cell = makeCellDirection(cellIndex);
    const angle = Math.acos(clamp(cell[0] * direction[0] + cell[1] * direction[1] + cell[2] * direction[2], -1, 1));
    if (angle > angularRadius) continue;
    const normalized = angle / angularRadius;
    const delta = normalized <= 0.72
      ? -depth * (1 - (normalized / 0.72) ** 2)
      : depth * 0.25 * Math.sin(Math.PI * (normalized - 0.72) / 0.28);
    if (Math.abs(delta) < 1e-12) continue;
    const combined = (elevationByCell.get(cellIndex) ?? 0) + delta;
    if (!Number.isFinite(combined) || Math.abs(combined) > MAX_SURFACE_RELIEF_M) throw new Error("Relevo excede o limite permitido.");
    elevationByCell.set(cellIndex, combined);
  }
  if (elevationByCell.size === targetData.length && !Array.from(elevationByCell.values()).some((elevation, index) => elevation !== targetData[index]?.elevationM)) {
    throw new Error("Cratera não atingiu células da grade.");
  }

  const nextBodies = world.bodies.map((body, index) => index === targetIndex
    ? { ...body, surface: { ...body.surface!, revision: nextRevision, dataId: nextDataId } }
    : body);
  const nextSurfaceData: SurfaceData = { ...world.surfaceData };
  if (shared) nextSurfaceData[nextDataId] = [];
  nextSurfaceData[nextDataId] = Array.from(elevationByCell, ([cellIndex, elevationM]) => ({ cellIndex, elevationM }))
    .sort((left, right) => left.cellIndex - right.cellIndex);
  validateSurfaceData(nextSurfaceData, nextBodies.flatMap((body) => body.surface ? [body.surface] : []));
  return { ...world, bodies: nextBodies, surfaceData: nextSurfaceData };
}
