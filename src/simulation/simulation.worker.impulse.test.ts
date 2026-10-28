import { describe, expect, it } from "vitest";
import { installSimulationWorker } from "./simulation.worker";
import { createSolarSystem } from "./solar-system";

class TestWorkerScope {
  messages: unknown[] = [];
  private listener?: (event: MessageEvent<unknown>) => void;
  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  postMessage(message: unknown) { this.messages.push(message); }
  send(data: unknown) { this.listener?.(new MessageEvent("message", { data })); }
}

describe("worker center-of-mass impulse commit", () => {
  it("publishes an event only with the accepted atomic velocity candidate, including while paused", () => {
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [earth], settings: { gravitationalConstant: 0 }, environmentSeed: 15, revision: 1 });
      scope.messages = [];
      scope.send({ type: "MUTATE_WORLD", mutation: { type: "APPLY_IMPULSE", bodyId: earth.id, impulseNs: [earth.massKg * 10, 0, 0] }, revision: 2 });
      const accepted = scope.messages.find((message) => (message as { type: string }).type === "SNAPSHOT") as { snapshot: { status: string; bodies: typeof earth[]; events: { type: string; energyJ: number; impulse?: { modelId: string; externalWorkJ: number; impulseNs: number[] } }[] } };

      expect(accepted.snapshot.status).toBe("paused");
      expect(accepted.snapshot.bodies[0]!.velocityMs[0]).toBeCloseTo(earth.velocityMs[0]! + 10);
      expect(accepted.snapshot.events.at(-1)).toMatchObject({ type: "impulse", bodyIds: [earth.id], impulse: {
        modelId: "center-of-mass-impulse-v1", externalWorkJ: expect.any(Number), impulseNs: [earth.massKg * 10, 0, 0],
      } });
      expect(accepted.snapshot.events.at(-1)!.energyJ).toBe(Math.abs(accepted.snapshot.events.at(-1)!.impulse!.externalWorkJ));
    } finally {
      dispose();
    }
  });

  it("rejects an invalid whole-world candidate without publishing an impulse event", () => {
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const earth = { ...createSolarSystem().find(({ id }) => id === "earth")!, velocityMs: [1e7, 0, 0] as const };
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [earth], settings: { gravitationalConstant: 0 }, environmentSeed: 15, revision: 1 });
      scope.messages = [];
      scope.send({ type: "MUTATE_WORLD", mutation: { type: "APPLY_IMPULSE", bodyId: earth.id, impulseNs: [earth.massKg, 0, 0] }, revision: 2 });
      expect(scope.messages).toHaveLength(1);
      expect(scope.messages[0]).toMatchObject({ type: "ERROR", rejectedRevision: 2, snapshot: { bodies: [earth], events: [] } });
    } finally {
      dispose();
    }
  });
});
