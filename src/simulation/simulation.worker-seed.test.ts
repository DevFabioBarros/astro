import { afterEach, describe, expect, it } from "vitest";
import { createSolarSystem } from "./solar-system";
import { createSimulationClient } from "./simulation-client";
import { installSimulationWorker } from "./simulation.worker";
import type { SimulationSnapshot, SimulationWorkerMessage } from "./types";

class WorkerScope extends EventTarget {
  outbound = new EventTarget();
  messages: SimulationWorkerMessage[] = [];
  postMessage = (message: SimulationWorkerMessage) => {
    this.messages.push(structuredClone(message));
    this.outbound.dispatchEvent(new MessageEvent("message", { data: structuredClone(message) }));
  };
  send(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) })); }
  latest(): SimulationSnapshot {
    const snapshot = this.messages.filter((message) => message.type === "SNAPSHOT").at(-1);
    if (!snapshot || snapshot.type !== "SNAPSHOT") throw new Error("Expected worker snapshot");
    return snapshot.snapshot;
  }
}

class WorkerAdapter extends EventTarget {
  constructor(private readonly scope: WorkerScope) {
    super();
    scope.outbound.addEventListener("message", (event) => this.dispatchEvent(new MessageEvent("message", { data: (event as MessageEvent).data })));
  }
  postMessage(data: unknown) { this.scope.send(data); }
  terminate() {}
}

describe("world environment seed in the worker", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it("sets the seed atomically and preserves/restores it through mutations and history", () => {
    const scope = new WorkerScope();
    const uninstall = installSimulationWorker(scope as unknown as Parameters<typeof installSimulationWorker>[0]);
    const client = createSimulationClient(new WorkerAdapter(scope) as unknown as Worker);
    cleanup = () => { client.dispose(); uninstall(); };
    const bodies = createSolarSystem().slice(0, 1);
    const settings = { gravitationalConstant: 6.6743e-11 };

    client.setWorld(bodies, settings, 1, "initial", undefined, undefined, 101);
    expect(scope.latest().environmentSeed).toBe(101);
    client.setBodies(bodies.map((body) => ({ ...body, massKg: body.massKg * 1.01 })), 2);
    expect(scope.latest().environmentSeed).toBe(101);
    client.mutateWorld({ type: "EDIT_BODY", bodyId: bodies[0]!.id, field: "massKg", value: bodies[0]!.massKg * 1.02 }, 3);
    expect(scope.latest().environmentSeed).toBe(101);

    client.setWorld(bodies, settings, 4, "experiment", "creative", undefined, 202);
    expect(scope.latest().environmentSeed).toBe(202);
    const history = scope.latest().history!;
    client.restoreCheckpoint(history.undoCheckpointId!, "undo", 5, history.generation);
    expect(scope.latest().environmentSeed).toBe(101);
    const redo = scope.latest().history!;
    client.restoreCheckpoint(redo.redoCheckpointId!, "redo", 6, redo.generation);
    expect(scope.latest().environmentSeed).toBe(202);
  });
});
