import { describe, expect, it } from "vitest";
import { installSimulationWorker } from "./simulation.worker";
import { createSimulationClient } from "./simulation-client";
import { decodeSimulation, encodeSimulation } from "./save-file";
import { createEmptySwarmLedger } from "./swarm-model";
import type { SimulationWorkerMessage } from "./types";

class Scope {
  listener?: (event: MessageEvent<unknown>) => void;
  messages: SimulationWorkerMessage[] = [];
  onPost?: (message: SimulationWorkerMessage) => void;
  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  postMessage(message: SimulationWorkerMessage) { this.messages.push(message); this.onPost?.(message); }
  send(data: unknown) { this.listener?.({ data } as MessageEvent<unknown>); }
}

class WorkerAdapter {
  private listeners = new Map<string, EventListener>();
  constructor(private readonly scope: Scope) { scope.onPost = (data) => this.listeners.get("message")?.({ data } as MessageEvent<unknown> as Event); }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  removeEventListener(type: string) { this.listeners.delete(type); }
  postMessage(data: unknown) { this.scope.send(data); }
  terminate() {}
}

describe("physical swarm Worker sidecar", () => {
  it("re-emits the ledger at a later accepted revision so client export keeps it", () => {
    const scope = new Scope();
    const dispose = installSimulationWorker(scope);
    const client = createSimulationClient(new WorkerAdapter(scope) as unknown as Worker);
    const primary = { id: "primary", name: "Primary", kind: "planet" as const, bodyType: "rocky-planet" as const,
      massKg: 8e24, radiusM: 6e6, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 };
    const settings = { gravitationalConstant: 6.6743e-11 };
    const snapshots: import("./types").SimulationSnapshot[] = [];
    client.subscribe((snapshot) => snapshots.push(snapshot));
    client.setWorld([primary], settings, 1, "initial", undefined, undefined, 51, undefined, createEmptySwarmLedger());
    client.mutateWorld({ type: "CREATE_ORBITAL_RING", primaryId: primary.id, innerRadiusM: 1e8, outerRadiusM: 1.2e8,
      representativeCount: 4, totalMassKg: 4e12, profileId: "rock-v1", planeNormal: [0, 0, 1] }, 2);
    const afterRing = snapshots.at(-1)!;
    expect(afterRing.worldRevision).toBe(2);
    expect(afterRing.swarmLedger?.groups).toHaveLength(1);

    client.setSettings(settings, 3);
    const afterSettings = snapshots.at(-1)!;
    expect(afterSettings.worldRevision).toBe(3);
    expect(afterSettings.swarmLedger).toEqual(afterRing.swarmLedger);
    expect(decodeSimulation(encodeSimulation(afterSettings.bodies, settings, undefined, afterSettings.simulationTimeSeconds,
      undefined, afterSettings.swarmLedger)).swarmLedger).toEqual(afterRing.swarmLedger);
    client.dispose();
    dispose();
  });

  it("commits ring ledger with the same accepted revision and restores it through undo", () => {
    const scope = new Scope();
    const dispose = installSimulationWorker(scope);
    const primary = { id: "primary", name: "Primary", kind: "planet" as const, bodyType: "rocky-planet" as const,
      massKg: 8e24, radiusM: 6e6, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 };
    const settings = { gravitationalConstant: 6.6743e-11 };
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [primary], settings, environmentSeed: 51, revision: 1 });
    scope.messages.length = 0;

    scope.send({ type: "MUTATE_WORLD", revision: 2, mutation: { type: "CREATE_ORBITAL_RING", primaryId: primary.id,
      innerRadiusM: 1e8, outerRadiusM: 1.2e8, representativeCount: 4, totalMassKg: 4e12, profileId: "rock-v1", planeNormal: [0, 0, 1] } });
    const sidecar = scope.messages.find((message) => message.type === "SWARM_STATE");
    const snapshotMessage = scope.messages.find((message) => message.type === "SNAPSHOT");

    expect(sidecar?.worldRevision).toBe(2);
    expect(snapshotMessage?.type).toBe("SNAPSHOT");
    if (snapshotMessage?.type !== "SNAPSHOT") throw new Error("Snapshot ausente.");
    expect(snapshotMessage.snapshot.bodies).toHaveLength(5);
    expect((sidecar as Extract<SimulationWorkerMessage, { type: "SWARM_STATE" }>).swarmLedger.groups[0]?.initialMassKg).toBe(4e12);
    const checkpointId = snapshotMessage.snapshot.history?.undoCheckpointId;
    const generation = snapshotMessage.snapshot.history?.generation;
    expect(checkpointId).toBeTruthy();
    expect(generation).toBeDefined();

    scope.messages.length = 0;
    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId, direction: "undo", generation, revision: 3 });
    const restoredLedger = scope.messages.find((message) => message.type === "SWARM_STATE");
    const restored = scope.messages.find((message) => message.type === "SNAPSHOT");
    expect(restoredLedger).toMatchObject({ type: "SWARM_STATE", worldRevision: 3, swarmLedger: { groups: [], bodyMassShares: {} } });
    expect(restored).toMatchObject({ type: "SNAPSHOT", worldRevision: 3, snapshot: { bodies: [primary] } });
    dispose();
  });
});
