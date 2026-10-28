import { describe, expect, it, vi } from "vitest";
import { installSimulationWorker } from "./simulation.worker";

class TestWorkerScope {
  messages: unknown[] = [];
  private listener?: (event: MessageEvent<unknown>) => void;
  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  postMessage(message: unknown) { this.messages.push(message); }
  send(data: unknown) { this.listener?.(new MessageEvent("message", { data })); }
}

const surface = { modelId: "sparse-relief-v1", seed: 7, revision: 0, resolution: 64, dataId: "earth-relief" };
const body = { id: "earth", name: "Earth", kind: "planet", massKg: 1e12, radiusM: 1e6,
  positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0, surface };
const surfaceData = { "earth-relief": [{ cellIndex: 2, elevationM: -500 }] };

describe("worker surface sidecar transport", () => {
  it("publishes accepted replacement and restored sidecars outside ordinary snapshots", () => {
    vi.useFakeTimers();
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [body], settings: { gravitationalConstant: 0 },
        environmentSeed: 15, surfaceData, revision: 1 });
      expect(scope.messages.map((message) => (message as { type: string }).type)).toEqual(["SURFACE_STATE", "SNAPSHOT"]);
      const replacementSnapshot = scope.messages[1] as { snapshot: Record<string, unknown> };
      expect(replacementSnapshot.snapshot).not.toHaveProperty("surfaceData");
      scope.messages = [];

      scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 2e12 }, revision: 2 });
      expect(scope.messages.map((message) => (message as { type: string }).type)).toEqual(["SNAPSHOT"]);
      const summary = (scope.messages.at(-1) as { snapshot: { history: { undoCheckpointId: string; generation: number } } }).snapshot.history;
      scope.messages = [];
      scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: summary.undoCheckpointId, direction: "undo", generation: summary.generation, revision: 3 });
      expect(scope.messages.map((message) => (message as { type: string }).type)).toEqual(["SURFACE_STATE", "SNAPSHOT"]);
      expect(scope.messages[0]).toEqual({ type: "SURFACE_STATE", worldRevision: 3, surfaceData, surfaceHeatData: { "earth-relief": [] } });
      expect((scope.messages[1] as { snapshot: Record<string, unknown> }).snapshot).not.toHaveProperty("surfaceData");

      scope.messages = [];
      scope.send({ type: "SET_WORLD", origin: "import", bodies: [body], settings: { gravitationalConstant: 0 }, environmentSeed: 16, revision: 4 });
      expect((scope.messages[0] as { type: string }).type).toBe("ERROR");
      expect((scope.messages[0] as { snapshot: { bodies: typeof body[]; simulationTimeSeconds: number } }).snapshot)
        .toMatchObject({ bodies: [body], simulationTimeSeconds: 0 });
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("commits a collision crater with the interval and publishes its revision-bound sidecar", async () => {
    vi.useFakeTimers();
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const large = { ...body, id: "earth", massKg: 2e12, positionM: [0, 0, 0] };
    const small = { id: "rock", name: "Rock", kind: "planet", massKg: 1e12, radiusM: 5e5,
      positionM: [1.4e6, 0, 0], velocityMs: [-100, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 };
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [large, small], settings: { gravitationalConstant: 0 },
        environmentSeed: 15, surfaceData: { "earth-relief": [] }, revision: 1 });
      scope.messages = [];
      scope.send({ type: "START" });
      scope.messages = [];
      now.mockReturnValue(25);
      scope.send({ type: "PAUSE" });

      const surfaceMessage = scope.messages.find((message) => (message as { type: string }).type === "SURFACE_STATE") as { type: string; worldRevision: number; surfaceData: typeof surfaceData; surfaceHeatData: Record<string, { cellIndex: number; energyJ: number }[]> } | undefined;
      const snapshotMessage = scope.messages.find((message) => (message as { type: string }).type === "SNAPSHOT") as { snapshot: { bodies: typeof body[]; simulationTimeSeconds: number } } | undefined;
      expect(surfaceMessage).toMatchObject({ type: "SURFACE_STATE", worldRevision: 1 });
      expect(surfaceMessage?.surfaceData["earth-relief"]?.length).toBeGreaterThan(0);
      expect(surfaceMessage?.surfaceHeatData["earth-relief"]?.length).toBeGreaterThan(0);
      expect(surfaceMessage?.surfaceHeatData["earth-relief"]?.reduce((sum, patch) => sum + patch.energyJ, 0)).toBeGreaterThan(0);
      expect(snapshotMessage?.snapshot.bodies).toHaveLength(1);
      expect(snapshotMessage?.snapshot.bodies[0]?.surface?.revision).toBe(1);
      expect(snapshotMessage?.snapshot.simulationTimeSeconds).toBeGreaterThan(0);
      expect(snapshotMessage?.snapshot).not.toHaveProperty("surfaceData");
    } finally {
      dispose();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("clears transient collision heat when restoring an undo checkpoint", () => {
    vi.useFakeTimers();
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const large = { ...body, id: "earth", massKg: 2e12, positionM: [0, 0, 0], velocityMs: [0, 0, 0] };
    const small = { id: "rock", name: "Rock", kind: "planet", massKg: 1e12, radiusM: 5e5,
      positionM: [1.4e6, 0, 0], velocityMs: [-100, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 };
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [large, small], settings: { gravitationalConstant: 0 },
        environmentSeed: 15, surfaceData: { "earth-relief": [] }, revision: 1 });
      scope.messages = [];
      scope.send({ type: "START" });
      scope.messages = [];
      now.mockReturnValue(25);
      scope.send({ type: "PAUSE" });
      const hotState = scope.messages.find((message) => (message as { type: string }).type === "SURFACE_STATE") as { surfaceHeatData?: Record<string, { energyJ: number }[]> } | undefined;
      expect(hotState?.surfaceHeatData?.["earth-relief"]?.some(({ energyJ }) => energyJ > 0)).toBe(true);

      scope.messages = [];
      scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 4e12 }, revision: 2 });
      const history = (scope.messages.at(-1) as { snapshot: { history: { undoCheckpointId: string; generation: number } } }).snapshot.history;
      scope.messages = [];
      scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: history.undoCheckpointId, direction: "undo", generation: history.generation, revision: 3 });

      expect(scope.messages.find((message) => (message as { type: string }).type === "SURFACE_STATE")).toEqual({
        type: "SURFACE_STATE", worldRevision: 3, surfaceData: { "earth-relief": expect.any(Array) }, surfaceHeatData: { "earth-relief": [] },
      });
    } finally {
      dispose();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects a collision interval atomically when its surface revision cannot advance", async () => {
    vi.useFakeTimers();
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const exhaustedSurface = { ...surface, revision: Number.MAX_SAFE_INTEGER };
    const large = { ...body, id: "earth", massKg: 2e12, positionM: [0, 0, 0], surface: exhaustedSurface };
    const small = { id: "rock", name: "Rock", kind: "planet", massKg: 1e12, radiusM: 5e5,
      positionM: [1.4e6, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 };
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [large, small], settings: { gravitationalConstant: 0 },
        environmentSeed: 15, surfaceData: { "earth-relief": [] }, revision: 1 });
      scope.messages = [];
      scope.send({ type: "START" });
      scope.messages = [];
      now.mockReturnValue(25);
      scope.send({ type: "PAUSE" });

      expect(scope.messages.some((message) => (message as { type: string }).type === "SURFACE_STATE")).toBe(false);
      const errorMessage = scope.messages.find((message) => (message as { type: string }).type === "ERROR") as { snapshot: { bodies: typeof body[]; simulationTimeSeconds: number; status: string } } | undefined;
      expect(errorMessage?.snapshot).toMatchObject({ bodies: [large, small], simulationTimeSeconds: 0, status: "error" });
    } finally {
      dispose();
      now.mockRestore();
      vi.useRealTimers();
    }
  });
});
