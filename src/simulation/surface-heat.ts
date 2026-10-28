import type { CelestialBody, SimulationEvent, SurfaceHeatData, SurfaceHeatPatch, Vector3 } from "./types";
import { SURFACE_GRID_CELL_COUNT, SURFACE_GRID_HEIGHT, SURFACE_GRID_WIDTH } from "./surface-state";

export const IMPACT_SURFACE_GLOW_MODEL_ID = "impact-surface-glow-v1" as const;
export const IMPACT_SURFACE_GLOW_HALF_LIFE_SECONDS = 86_400;

export function validateSurfaceHeatData(value: unknown, dataIds: readonly string[]): asserts value is SurfaceHeatData {
  if (!isValidSurfaceHeatPayload(value)) throw new Error("Payload de brilho superficial inválido.");
  const data = value as Record<string, unknown>;
  const expected = new Set(dataIds);
  if (Object.keys(data).length !== expected.size || Object.keys(data).some((id) => !expected.has(id))) throw new Error("Referências de brilho superficial inválidas.");
}

export function isValidSurfaceHeatPayload(value: unknown): value is SurfaceHeatData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>, ids = Object.keys(data);
  if (ids.length > 64) return false;
  for (const patches of Object.values(data)) {
    if (!Array.isArray(patches) || patches.length > SURFACE_GRID_CELL_COUNT) return false;
    const cells = new Set<number>();
    for (const patch of patches) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
      const entry = patch as Record<string, unknown>;
      if (Object.keys(entry).length !== 4 || entry.modelId !== IMPACT_SURFACE_GLOW_MODEL_ID || !Object.hasOwn(entry, "modelId")
        || !Object.hasOwn(entry, "cellIndex")
        || !Object.hasOwn(entry, "intensity01") || !Object.hasOwn(entry, "startedAtSimulationTimeSeconds")
        || !Number.isInteger(entry.cellIndex) || (entry.cellIndex as number) < 0 || (entry.cellIndex as number) >= SURFACE_GRID_CELL_COUNT
        || typeof entry.intensity01 !== "number" || !Number.isFinite(entry.intensity01) || entry.intensity01 < 0 || entry.intensity01 > 1
        || typeof entry.startedAtSimulationTimeSeconds !== "number" || !Number.isFinite(entry.startedAtSimulationTimeSeconds)
        || entry.startedAtSimulationTimeSeconds < 0 || cells.has(entry.cellIndex as number)) return false;
      cells.add(entry.cellIndex as number);
    }
  }
  return true;
}

function cellDirection(cellIndex: number): [number, number, number] {
  const row = Math.floor(cellIndex / SURFACE_GRID_WIDTH), column = cellIndex % SURFACE_GRID_WIDTH;
  const latitude = -Math.PI / 2 + ((row + 0.5) * Math.PI) / SURFACE_GRID_HEIGHT;
  const longitude = -Math.PI + ((column + 0.5) * 2 * Math.PI) / SURFACE_GRID_WIDTH;
  return [Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude)];
}

export function surfaceHeatIntensityAt(patch: SurfaceHeatPatch, simulationTimeSeconds: number): number {
  if (!Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < patch.startedAtSimulationTimeSeconds) return 0;
  return patch.intensity01 * Math.exp(-Math.LN2 * (simulationTimeSeconds - patch.startedAtSimulationTimeSeconds)
    / IMPACT_SURFACE_GLOW_HALF_LIFE_SECONDS);
}

function impactGlowIntensity(energyJ: number): number {
  return Math.min(1, Math.log10(1 + energyJ) / 30);
}

export function applyCollisionVisualHeat(
  bodies: readonly CelestialBody[], data: SurfaceHeatData, survivorId: string, direction: Vector3,
  smallerRadiusM: number, intensity01: number, simulationTimeSeconds: number,
): SurfaceHeatData {
  const survivor = bodies.find(({ id }) => id === survivorId);
  const ids = bodies.flatMap(({ surface }) => surface ? [surface.dataId] : []);
  validateSurfaceHeatData(data, ids);
  if (!survivor?.surface || !Array.isArray(direction) || direction.length !== 3 || !direction.every(Number.isFinite)
    || Math.abs(Math.hypot(...direction) - 1) > 1e-6 || !Number.isFinite(smallerRadiusM) || smallerRadiusM <= 0
    || !Number.isFinite(survivor.radiusM) || survivor.radiusM <= 0 || !Number.isFinite(intensity01) || intensity01 < 0 || intensity01 > 1
    || !Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0) throw new Error("Entrada de brilho superficial inválida.");
  if (intensity01 === 0) return data;
  const angularRadius = Math.min(Math.PI / 4, Math.max(0.3, 3 * smallerRadiusM / survivor.radiusM));
  const weights: { cellIndex: number; weight: number }[] = [];
  for (let cellIndex = 0; cellIndex < SURFACE_GRID_CELL_COUNT; cellIndex += 1) {
    const cell = cellDirection(cellIndex);
    const angle = Math.acos(Math.max(-1, Math.min(1, cell[0] * direction[0] + cell[1] * direction[1] + cell[2] * direction[2])));
    if (angle <= angularRadius) weights.push({ cellIndex, weight: 1 - (angle / angularRadius) ** 2 });
  }
  const sum = weights.reduce((value, cell) => value + cell.weight, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) throw new Error("A mancha de brilho não alcançou células da grade.");
  const existing = new Map(data[survivor.surface.dataId]!.map((patch) => [patch.cellIndex, patch]));
  for (const cell of weights) {
    const previous = existing.get(cell.cellIndex);
    const remaining = previous ? surfaceHeatIntensityAt(previous, simulationTimeSeconds) : 0;
    const intensity = Math.min(1, remaining + intensity01 * cell.weight / sum);
    existing.set(cell.cellIndex, { modelId: IMPACT_SURFACE_GLOW_MODEL_ID, cellIndex: cell.cellIndex,
      intensity01: intensity, startedAtSimulationTimeSeconds: simulationTimeSeconds });
  }
  const next = { ...data, [survivor.surface.dataId]: Array.from(existing.values()).sort((a, b) => a.cellIndex - b.cellIndex) };
  validateSurfaceHeatData(next, ids);
  return next;
}

export function updateSurfaceHeatAfterAcceptedCollision(
  before: readonly CelestialBody[], after: readonly CelestialBody[],
  event: Pick<SimulationEvent, "bodyIds" | "contact" | "outcome" | "energyJ">,
  current: SurfaceHeatData, simulationTimeSeconds: number,
): SurfaceHeatData {
  const ids = after.flatMap(({ surface }) => surface ? [surface.dataId] : []);
  const unchangedIds = Object.keys(current).length === ids.length && ids.every((id) => Object.hasOwn(current, id));
  const next = unchangedIds ? current : Object.fromEntries(ids.map((dataId) => [dataId, current[dataId] ?? []]));
  validateSurfaceHeatData(next, ids);
  if (!event.outcome || event.outcome.kind !== "perfectly-inelastic-merge" || event.bodyIds.length !== 2 || !event.contact?.normalM) return next;
  const survivorId = event.outcome.survivorBodyId;
  const first = before.find(({ id }) => id === event.bodyIds[0]);
  const second = before.find(({ id }) => id === event.bodyIds[1]);
  const survivor = after.find(({ id }) => id === survivorId);
  if (!first || !second || !survivor?.surface) return next;
  const radial = event.contact.pointM.map((value, axis) => value - survivor.positionM[axis]!) as [number, number, number];
  const length = Math.hypot(...radial);
  if (!Number.isFinite(length)) throw new Error("Direção de brilho superficial inválida.");
  const direction = length > 0 ? radial.map((value) => value / length) as [number, number, number]
    : event.contact.normalM.map((value) => value * (survivor.id === first.id ? 1 : -1)) as [number, number, number];
  return applyCollisionVisualHeat(after, next, survivor.id, direction, Math.min(first.radiusM, second.radiusM),
    impactGlowIntensity(event.energyJ), simulationTimeSeconds);
}
