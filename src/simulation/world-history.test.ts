import { describe, expect, it } from "vitest";
import type { CelestialBody } from "./types";
import type { SurfaceData } from "./types";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "./world-seed";
import {
  createWorldHistory,
  MAX_WORLD_HISTORY_ACTIONS,
  MAX_WORLD_HISTORY_BYTES,
  recordWorldHistoryAction,
  restoreWorldHistoryCheckpoint,
  startNewWorldHistoryGeneration,
  summarizeWorldHistory,
  type WorldHistoryState,
} from "./world-history";

const body: CelestialBody = {
  id: "earth", name: "Earth", kind: "planet", massKg: 1e24, radiusM: 1e6,
  positionM: [1, 2, 3], velocityMs: [4, 5, 6], surfaceTemperatureK: 288, waterFraction: 0.7,
};

const state = (massKg: number, simulationTimeSeconds = 12): WorldHistoryState => ({
  environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1,
  bodies: [{ ...body, massKg }],
  settings: { gravitationalConstant: 6.6743e-11 },
  simulationTimeSeconds,
  collisionMode: "scientific",
  surfaceData: {},
});

function record(history: ReturnType<typeof createWorldHistory>, before: WorldHistoryState, after: WorldHistoryState, coalesceId?: string) {
  const result = recordWorldHistoryAction(history, before, after, coalesceId);
  if (!result.ok) throw new Error(result.reason);
  return result.history;
}

describe("world history", () => {
  it("clones checkpoint state and restores only the adjacent undo/redo checkpoint", () => {
    const before = state(1e24);
    let history = record(createWorldHistory(), before, state(2e24));
    (before.bodies[0] as { massKg: number }).massKg = 9e24;

    const summary = summarizeWorldHistory(history);
    const undo = restoreWorldHistoryCheckpoint(history, summary.undoCheckpointId!, "undo", summary.generation);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.checkpoint.bodies[0]!.massKg).toBe(1e24);
    expect(restoreWorldHistoryCheckpoint(undo.history, "0:999", "redo", summary.generation).ok).toBe(false);

    const redoSummary = summarizeWorldHistory(undo.history);
    const redo = restoreWorldHistoryCheckpoint(undo.history, redoSummary.redoCheckpointId!, "redo", summary.generation);
    expect(redo.ok && redo.checkpoint.bodies[0]!.massKg).toBe(2e24);
  });

  it("counts, clones, and restores the sparse surface sidecar with each checkpoint", () => {
    const surfaceData: SurfaceData = { "earth-relief": [{ cellIndex: 23, elevationM: -1200 }] };
    const before = { ...state(1e24), surfaceData };
    const after = { ...state(2e24), surfaceData: { "earth-relief": [{ cellIndex: 24, elevationM: 2500 }] } };
    const history = record(createWorldHistory(), before, after);
    const withoutSurface = record(createWorldHistory(), state(1e24), state(2e24));
    const summary = summarizeWorldHistory(history);
    const undone = restoreWorldHistoryCheckpoint(history, summary.undoCheckpointId!, "undo", summary.generation);

    expect(summary.bytes).toBeGreaterThan(summarizeWorldHistory(withoutSurface).bytes);
    expect(undone.ok && undone.checkpoint.surfaceData).toEqual(surfaceData);
    surfaceData["earth-relief"]![0]!.elevationM = 999;
    expect(undone.ok && undone.checkpoint.surfaceData["earth-relief"]![0]!.elevationM).toBe(-1200);
  });

  it("coalesces one consecutive slider gesture and invalidates redo on a new action", () => {
    let history = record(createWorldHistory(), state(1e24), state(2e24), "mass-drag-1");
    history = record(history, state(2e24), state(3e24), "mass-drag-1");
    expect(summarizeWorldHistory(history).actionCount).toBe(1);

    const summary = summarizeWorldHistory(history);
    const undone = restoreWorldHistoryCheckpoint(history, summary.undoCheckpointId!, "undo", summary.generation);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    const branch = record(undone.history, state(1e24), state(4e24), "mass-drag-2");
    expect(summarizeWorldHistory(branch).redoCheckpointId).toBeNull();
  });

  it("keeps the newest 20 entries and rejects an indivisible entry over 16 MiB", () => {
    let history = createWorldHistory();
    for (let index = 0; index < MAX_WORLD_HISTORY_ACTIONS + 5; index += 1) {
      history = record(history, state(index + 1), state(index + 2));
    }
    expect(summarizeWorldHistory(history).actionCount).toBe(MAX_WORLD_HISTORY_ACTIONS);
    expect(summarizeWorldHistory(history).bytes).toBeLessThanOrEqual(MAX_WORLD_HISTORY_BYTES);

    const largeBefore = { ...state(1), bodies: [{ ...body, name: "x".repeat(MAX_WORLD_HISTORY_BYTES / 2) }] };
    const largeAfter = { ...largeBefore, bodies: [{ ...largeBefore.bodies[0]!, massKg: 2e24 }] };
    const empty = createWorldHistory();
    const rejected = recordWorldHistoryAction(empty, largeBefore, largeAfter);
    expect(rejected.ok).toBe(false);
    expect(empty).toEqual({ generation: 0, undo: [], redo: [], bytes: 0, nextCheckpointSequence: 1 });
  });

  it("starts an empty generation and rejects stale checkpoint restores", () => {
    const history = record(createWorldHistory(), state(1e24), state(2e24));
    const next = startNewWorldHistoryGeneration(history);
    expect(next.generation).toBe(history.generation + 1);
    expect(summarizeWorldHistory(next)).toMatchObject({ actionCount: 0, bytes: 0, undoCheckpointId: null, redoCheckpointId: null });
    expect(restoreWorldHistoryCheckpoint(history, summarizeWorldHistory(history).undoCheckpointId!, "undo", next.generation).ok).toBe(false);
  });
});
