import { describe, expect, it } from "vitest";
import { installSimulationWorker } from "./simulation.worker";
import type { CelestialBody, SimulationSnapshot, SimulationWorkerMessage } from "./types";

class Scope {
  listener?: (event: MessageEvent<unknown>) => void;
  messages: SimulationWorkerMessage[] = [];
  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  postMessage(message: SimulationWorkerMessage) { this.messages.push(structuredClone(message)); }
  send(data: unknown) { this.listener?.({ data: structuredClone(data) } as MessageEvent<unknown>); }
}

function latestSnapshot(scope: Scope): SimulationSnapshot {
  const message = scope.messages.findLast((candidate) => candidate.type === "SNAPSHOT");
  if (message?.type !== "SNAPSHOT") throw new Error("Expected a worker snapshot");
  return message.snapshot;
}

const initialBodies: CelestialBody[] = [
  { id: "batch-a", name: "A", kind: "planet", bodyType: "rocky-planet", massKg: 1e20, radiusM: 1e6, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 },
  { id: "batch-b", name: "B", kind: "planet", bodyType: "rocky-planet", massKg: 2e20, radiusM: 1.1e6, positionM: [1e8, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 },
  { id: "batch-c", name: "C", kind: "planet", bodyType: "rocky-planet", massKg: 3e20, radiusM: 1.2e6, positionM: [2e8, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 },
];

describe("atomic batch scaling history", () => {
  it("rejects an invalid member without mutation and one undo restores all three bodies", () => {
    const scope = new Scope();
    const dispose = installSimulationWorker(scope);
    try {
      const settings = { gravitationalConstant: 0 };
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: initialBodies, settings, environmentSeed: 17, revision: 1 });

      scope.send({ type: "MUTATE_WORLD", revision: 2, mutation: {
        type: "BATCH_SCALE_BODIES", bodyIds: initialBodies.map(({ id }) => id), field: "radiusM", factor: 2,
      } });
      const scaled = latestSnapshot(scope);
      expect(scaled.bodies.map(({ id, radiusM }) => [id, radiusM])).toEqual([
        ["batch-a", 2e6], ["batch-b", 2.2e6], ["batch-c", 2.4e6],
      ]);
      expect(scaled.history).toMatchObject({ actionCount: 1 });

      scope.send({ type: "MUTATE_WORLD", revision: 3, mutation: {
        type: "BATCH_SCALE_BODIES", bodyIds: ["batch-a", "batch-b", "missing"], field: "radiusM", factor: 2,
      } });
      const rejection = scope.messages.findLast((message) => message.type === "ERROR");
      expect(rejection?.type).toBe("ERROR");
      if (rejection?.type !== "ERROR") throw new Error("Expected an atomic batch rejection");
      expect(rejection.message).toContain("Nenhuma alteração foi aplicada.");
      expect(rejection.snapshot?.bodies).toEqual(scaled.bodies);
      expect(rejection.snapshot?.history).toMatchObject({ actionCount: 1, undoCheckpointId: scaled.history?.undoCheckpointId });

      scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: scaled.history!.undoCheckpointId!, direction: "undo",
        generation: scaled.history!.generation, revision: 4 });
      const undone = latestSnapshot(scope);
      expect(undone.bodies).toEqual(initialBodies);
      expect(undone.history).toMatchObject({ actionCount: 1, undoCheckpointId: null });
      expect(undone.history?.redoCheckpointId).not.toBeNull();
    } finally {
      dispose();
    }
  });
});
