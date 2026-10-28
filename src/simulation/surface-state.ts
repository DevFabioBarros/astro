import type { SurfaceData, SurfaceMetadata, SurfaceReliefPatch, SurfaceStateMessage } from "./types";

export const SURFACE_GRID_WIDTH = 64;
export const SURFACE_GRID_HEIGHT = 32;
export const SURFACE_GRID_CELL_COUNT = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;
export const MAX_SURFACE_RELIEF_M = 10_000_000;
export const MAX_SURFACE_DATA_BYTES = 4 * 1024 * 1024;
export const MAX_SURFACE_DATASETS = 64;

export function isSurfaceStateAcceptedAtSnapshot(state: SurfaceStateMessage | null, snapshotRevision: number, acceptedRevision: number): boolean {
  return state !== null && state.worldRevision === snapshotRevision && state.worldRevision >= acceptedRevision;
}

export function isValidSurfaceMetadata(value: unknown): value is SurfaceMetadata {
  if (typeof value !== "object" || value === null) return false;
  const metadata = value as Record<string, unknown>;
  return Object.keys(metadata).length === 5 && Object.hasOwn(metadata, "modelId") && Object.hasOwn(metadata, "seed")
    && Object.hasOwn(metadata, "revision") && Object.hasOwn(metadata, "resolution") && Object.hasOwn(metadata, "dataId")
    && metadata.modelId === "sparse-relief-v1"
    && Number.isInteger(metadata.seed) && (metadata.seed as number) >= 0 && (metadata.seed as number) <= 0xffff_ffff
    && Number.isSafeInteger(metadata.revision) && (metadata.revision as number) >= 0
    && metadata.resolution === SURFACE_GRID_WIDTH
    && typeof metadata.dataId === "string" && !!metadata.dataId.trim() && metadata.dataId.length <= 128;
}

export function validateSurfaceData(value: unknown, metadata: readonly SurfaceMetadata[]): asserts value is SurfaceData {
  if (!isValidSurfacePayload(value)) throw new Error("Payload de superfície inválido.");
  const data = value as Record<string, unknown>;
  const expected = new Map<string, SurfaceMetadata>();
  for (const surface of metadata) {
    if (!isValidSurfaceMetadata(surface)) throw new Error("Metadata de superfície inválida.");
    const previous = expected.get(surface.dataId);
    if (previous && (previous.modelId !== surface.modelId || previous.seed !== surface.seed || previous.revision !== surface.revision
      || previous.resolution !== surface.resolution)) throw new Error("Referências de superfície compartilhadas divergem.");
    expected.set(surface.dataId, surface);
  }
  const actualIds = Object.keys(data);
  if (actualIds.length !== expected.size || actualIds.some((dataId) => !expected.has(dataId))) {
    throw new Error("Payload de superfície ausente ou sem referência.");
  }
}

export function isValidSurfacePayload(value: unknown): value is SurfaceData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const dataIds = Object.keys(data);
  if (dataIds.length > MAX_SURFACE_DATASETS) return false;
  for (const dataId of dataIds) {
    const patches = data[dataId];
    if (!Array.isArray(patches) || patches.length > SURFACE_GRID_CELL_COUNT) return false;
    const cells = new Set<number>();
    for (const value of patches) {
      if (!isValidSurfacePatch(value) || cells.has(value.cellIndex)) return false;
      cells.add(value.cellIndex);
    }
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_SURFACE_DATA_BYTES;
}

export function isWithinCombinedSurfacePayloadLimit(surfaceData: unknown, surfaceHeatData: unknown): boolean {
  if (typeof surfaceData !== "object" || surfaceData === null || Array.isArray(surfaceData)
    || typeof surfaceHeatData !== "object" || surfaceHeatData === null || Array.isArray(surfaceHeatData)) return false;
  const dataIds = new Set([...Object.keys(surfaceData), ...Object.keys(surfaceHeatData)]);
  if (dataIds.size > MAX_SURFACE_DATASETS) return false;
  try {
    return new TextEncoder().encode(JSON.stringify({ surfaceData, surfaceHeatData })).byteLength <= MAX_SURFACE_DATA_BYTES;
  } catch {
    return false;
  }
}

function isValidSurfacePatch(value: unknown): value is SurfaceReliefPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  return Object.keys(patch).length === 2 && Object.hasOwn(patch, "cellIndex") && Object.hasOwn(patch, "elevationM")
    && Number.isInteger(patch.cellIndex) && (patch.cellIndex as number) >= 0 && (patch.cellIndex as number) < SURFACE_GRID_CELL_COUNT
    && typeof patch.elevationM === "number" && Number.isFinite(patch.elevationM)
    && Math.abs(patch.elevationM) <= MAX_SURFACE_RELIEF_M;
}
