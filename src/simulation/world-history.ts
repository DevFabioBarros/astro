import { createEmptySwarmLedger } from "./swarm-model";
import type { CelestialBody, CollisionMode, EnvironmentSeed, PhysicsSettings, SurfaceData, SwarmLedger, WorldHistorySummary, WorldRestoreDirection } from "./types";

export const MAX_WORLD_HISTORY_ACTIONS = 20;
export const MAX_WORLD_HISTORY_BYTES = 16 * 1024 * 1024;
export const MAX_WORLD_HISTORY_COALESCE_ID_LENGTH = 128;

export type WorldHistoryState = {
  environmentSeed: EnvironmentSeed;
  bodies: readonly CelestialBody[];
  settings: PhysicsSettings;
  simulationTimeSeconds: number;
  collisionMode: CollisionMode;
  surfaceData?: SurfaceData;
  swarmLedger?: SwarmLedger;
};

export type WorldCheckpoint = {
  checkpointId: string;
  generation: number;
  environmentSeed: EnvironmentSeed;
  bodies: CelestialBody[];
  settings: PhysicsSettings;
  simulationTimeSeconds: number;
  collisionMode: CollisionMode;
  surfaceData: SurfaceData;
  swarmLedger?: SwarmLedger;
};

type HistoryEntry = {
  before: WorldCheckpoint;
  after: WorldCheckpoint;
  coalesceId?: string;
  bytes: number;
};

export type WorldHistory = {
  generation: number;
  undo: readonly HistoryEntry[];
  redo: readonly HistoryEntry[];
  bytes: number;
  nextCheckpointSequence: number;
};

export type RecordWorldHistoryResult =
  | { ok: true; history: WorldHistory; recorded: boolean }
  | { ok: false; reason: "checkpoint-too-large" | "invalid-coalesce-id" };

export type RestoreWorldHistoryResult =
  | { ok: true; history: WorldHistory; checkpoint: WorldCheckpoint }
  | { ok: false; reason: "stale-generation" | "checkpoint-not-adjacent" };

const encoder = new TextEncoder();

function stateJson(state: WorldHistoryState): string {
  return JSON.stringify({
    bodies: state.bodies,
    environmentSeed: state.environmentSeed,
    settings: state.settings,
    simulationTimeSeconds: state.simulationTimeSeconds,
    collisionMode: state.collisionMode,
    surfaceData: state.surfaceData ?? {},
    swarmLedger: state.swarmLedger ?? createEmptySwarmLedger(),
  });
}

function checkpointBytes(checkpoint: WorldCheckpoint): number {
  return encoder.encode(JSON.stringify(checkpoint)).byteLength;
}

function cloneCheckpoint(state: WorldHistoryState, generation: number, sequence: number): WorldCheckpoint {
  return {
    checkpointId: `${generation}:${sequence}`,
    generation,
    environmentSeed: state.environmentSeed,
    bodies: structuredClone([...state.bodies]),
    settings: structuredClone(state.settings),
    simulationTimeSeconds: state.simulationTimeSeconds,
    collisionMode: state.collisionMode,
    surfaceData: structuredClone(state.surfaceData ?? {}),
    ...(state.swarmLedger === undefined ? {} : { swarmLedger: structuredClone(state.swarmLedger) }),
  };
}

function sumBytes(entries: readonly HistoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

export function createWorldHistory(generation = 0): WorldHistory {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("History generation must be a non-negative safe integer.");
  return { generation, undo: [], redo: [], bytes: 0, nextCheckpointSequence: 1 };
}

export function summarizeWorldHistory(history: WorldHistory): WorldHistorySummary {
  return {
    generation: history.generation,
    undoCheckpointId: history.undo.at(-1)?.before.checkpointId ?? null,
    redoCheckpointId: history.redo.at(-1)?.after.checkpointId ?? null,
    actionCount: history.undo.length + history.redo.length,
    bytes: history.bytes,
  };
}

export function recordWorldHistoryAction(
  history: WorldHistory,
  before: WorldHistoryState,
  after: WorldHistoryState,
  coalesceId?: string,
): RecordWorldHistoryResult {
  if (coalesceId !== undefined && (!coalesceId.trim() || coalesceId.length > MAX_WORLD_HISTORY_COALESCE_ID_LENGTH)) {
    return { ok: false, reason: "invalid-coalesce-id" };
  }
  if (stateJson(before) === stateJson(after)) return { ok: true, history, recorded: false };

  const last = history.undo.at(-1);
  const coalesces = coalesceId !== undefined && history.redo.length === 0 && last?.coalesceId === coalesceId;
  const beforeCheckpoint = coalesces
    ? last.before
    : cloneCheckpoint(before, history.generation, history.nextCheckpointSequence);
  const afterCheckpoint = cloneCheckpoint(after, history.generation, history.nextCheckpointSequence + (coalesces ? 0 : 1));
  const entry: HistoryEntry = {
    before: beforeCheckpoint,
    after: afterCheckpoint,
    ...(coalesceId === undefined ? {} : { coalesceId }),
    bytes: checkpointBytes(beforeCheckpoint) + checkpointBytes(afterCheckpoint),
  };
  if (entry.bytes > MAX_WORLD_HISTORY_BYTES) return { ok: false, reason: "checkpoint-too-large" };

  let undo = coalesces
    ? [...history.undo.slice(0, -1), entry]
    : [...history.undo, entry];
  let bytes = sumBytes(undo);
  while (undo.length > MAX_WORLD_HISTORY_ACTIONS || bytes > MAX_WORLD_HISTORY_BYTES) {
    if (undo.length <= 1) return { ok: false, reason: "checkpoint-too-large" };
    bytes -= undo[0]!.bytes;
    undo = undo.slice(1);
  }

  return {
    ok: true,
    history: {
      generation: history.generation,
      undo,
      redo: [],
      bytes,
      nextCheckpointSequence: history.nextCheckpointSequence + (coalesces ? 1 : 2),
    },
    recorded: true,
  };
}

export function restoreWorldHistoryCheckpoint(
  history: WorldHistory,
  checkpointId: string,
  direction: WorldRestoreDirection,
  generation: number,
): RestoreWorldHistoryResult {
  if (generation !== history.generation) return { ok: false, reason: "stale-generation" };

  if (direction === "undo") {
    const entry = history.undo.at(-1);
    if (!entry || entry.before.checkpointId !== checkpointId || entry.before.generation !== generation) {
      return { ok: false, reason: "checkpoint-not-adjacent" };
    }
    return {
      ok: true,
      checkpoint: structuredClone(entry.before),
      history: { ...history, undo: history.undo.slice(0, -1), redo: [...history.redo, entry] },
    };
  }

  const entry = history.redo.at(-1);
  if (!entry || entry.after.checkpointId !== checkpointId || entry.after.generation !== generation) {
    return { ok: false, reason: "checkpoint-not-adjacent" };
  }
  return {
    ok: true,
    checkpoint: structuredClone(entry.after),
    history: { ...history, undo: [...history.undo, entry], redo: history.redo.slice(0, -1) },
  };
}

export function startNewWorldHistoryGeneration(history: WorldHistory): WorldHistory {
  const generation = history.generation + 1;
  if (!Number.isSafeInteger(generation)) throw new RangeError("History generation is exhausted.");
  return createWorldHistory(generation);
}
