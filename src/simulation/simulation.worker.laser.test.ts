import { describe, expect, it } from "vitest";
import { applyWorldMutation } from "./world-mutations";
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

describe("worker discrete laser transaction", () => {
  it("publishes the laser ledger only in an accepted paused snapshot without changing temperature", () => {
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const body = applyWorldMutation([earth], { gravitationalConstant: 0 }, { type: "SET_MATERIAL_COMPOSITION",
      bodyId: earth.id, editMode: "mass-authoritative", dryFractions: { rock: 1, iron: 0, gas: 0 } }).bodies[0]!;
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [body], settings: { gravitationalConstant: 0 }, environmentSeed: 15, revision: 1 });
      scope.messages = [];
      scope.send({ type: "MUTATE_WORLD", mutation: { type: "APPLY_LASER", bodyId: earth.id,
        bodyLocalDirection: [0, 1, 0], powerW: 2e8, durationAcceptedSeconds: 10,
        profileId: "grey-albedo-laser-absorption-v1" }, revision: 2 });
      const accepted = scope.messages.find((message) => (message as { type: string }).type === "SNAPSHOT") as {
        snapshot: { status: string; bodies: typeof body[]; events: { type: string; laser?: { modelId: string; inputJ: number; absorbedJ: number; reflectedJ: number } }[] };
      };
      expect(accepted.snapshot.status).toBe("paused");
      expect(accepted.snapshot.bodies[0]?.surfaceTemperatureK).toBe(body.surfaceTemperatureK);
      expect(accepted.snapshot.events.at(-1)).toMatchObject({ type: "laser", bodyIds: [earth.id], laser: {
        modelId: "laser-energy-ledger-v1", inputJ: 2e9, absorbedJ: 1.4e9, reflectedJ: 0.6e9,
      } });
    } finally { dispose(); }
  });

  it("rejects legacy bodies without publishing a laser event", () => {
    const scope = new TestWorkerScope();
    const dispose = installSimulationWorker(scope);
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    try {
      scope.send({ type: "SET_WORLD", origin: "initial", bodies: [earth], settings: { gravitationalConstant: 0 }, environmentSeed: 15, revision: 1 });
      scope.messages = [];
      scope.send({ type: "MUTATE_WORLD", mutation: { type: "APPLY_LASER", bodyId: earth.id,
        bodyLocalDirection: [0, 1, 0], powerW: 2e8, durationAcceptedSeconds: 10,
        profileId: "grey-albedo-laser-absorption-v1" }, revision: 2 });
      expect(scope.messages[0]).toMatchObject({ type: "ERROR", rejectedRevision: 2, snapshot: { bodies: [earth], events: [] } });
    } finally { dispose(); }
  });
});
