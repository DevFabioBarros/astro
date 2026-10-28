import { describe, expect, it } from "vitest";
import { createSimulationClient } from "./simulation-client";
import { createSwarmLedger } from "./swarm-model";
import type { CelestialBody, PhysicsSettings, SimulationWorkerMessage } from "./types";

class FakeWorker {
  listener?: (event: MessageEvent<unknown>) => void;
  posted: unknown[] = [];
  addEventListener(type: string, listener: EventListener) { if (type === "message") this.listener = listener as (event: MessageEvent<unknown>) => void; }
  removeEventListener() { this.listener = undefined; }
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() {}
  send(message: SimulationWorkerMessage) { this.listener?.({ data: message } as MessageEvent<unknown>); }
}

describe("SimulationClient swarm sidecar", () => {
  it("joins only the sidecar matching the accepted snapshot revision", () => {
    const worker = new FakeWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const body: CelestialBody = { id: "particle", name: "Particle", kind: "planet", bodyType: "asteroid", massKg: 1e12,
      radiusM: 1000, positionM: [1e8, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 150, waterFraction: 0 };
    const settings: PhysicsSettings = { gravitationalConstant: 0 };
    const ledger = createSwarmLedger([body], { environmentSeed: 5, profileId: "rock-v1", nextSequence: 0 });
    const accepted: Array<{ revision: number; hasLedger: boolean; ledger?: unknown }> = [];
    client.subscribe((snapshot) => accepted.push({ revision: snapshot.worldRevision ?? -1, hasLedger: Boolean(snapshot.swarmLedger), ledger: snapshot.swarmLedger }));
    client.setWorld([body], settings, 1, "initial", undefined, undefined, 5, undefined, ledger);

    worker.send({ type: "SWARM_STATE", worldRevision: 1, swarmLedger: ledger });
    worker.send({ type: "SNAPSHOT", worldRevision: 1, settings, snapshot: { bodies: [body], environmentSeed: 5,
      simulationTimeSeconds: 0, status: "paused", collisionMode: "scientific" } });
    worker.send({ type: "SWARM_STATE", worldRevision: 0, swarmLedger: { ...ledger, groups: [] } });

    expect(accepted.at(-1)).toEqual({ revision: 1, hasLedger: true, ledger });
    const acceptedLedger = accepted.at(-1)!.ledger as typeof ledger;
    expect(Object.isFrozen(acceptedLedger)).toBe(true);
    expect(Object.isFrozen(acceptedLedger.groups)).toBe(true);
    expect(Object.isFrozen(acceptedLedger.groups[0])).toBe(true);
    expect(Object.isFrozen(acceptedLedger.bodyMassShares)).toBe(true);
    expect(Object.isFrozen(acceptedLedger.bodyMassShares.particle)).toBe(true);
    expect(Object.isFrozen(acceptedLedger.bodyMassShares.particle?.[0])).toBe(true);
    client.dispose();
  });
});
