import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spinPhaseAtAcceptedTimeRad, type SpinState } from "./spin-model";
import { installSimulationWorker } from "./simulation.worker";
import type { CelestialBody, SimulationWorkerMessage } from "./types";

class SpinWorkerScope extends EventTarget {
  messages: SimulationWorkerMessage[] = [];
  postMessage = (message: SimulationWorkerMessage) => { this.messages.push(structuredClone(message)); };
  send(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) })); }
  latestSnapshot() {
    const message = this.messages.filter((entry) => entry.type === "SNAPSHOT").at(-1);
    if (!message || message.type !== "SNAPSHOT") throw new Error("Worker did not publish a snapshot.");
    return message.snapshot;
  }
}

let cleanup: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); });

it("rebases a running spin mutation after the accepted Worker tick", () => {
  const scope = new SpinWorkerScope();
  cleanup = installSimulationWorker(scope as unknown as Parameters<typeof installSimulationWorker>[0]);
  const initialSpin: SpinState = { modelId: "rigid-body-spin-v1", axisUnitWorld: [0, 1, 0], phaseAtEpochRad: 0.4, angularVelocityRadPerS: 0.0002 };
  const body: CelestialBody = { id: "spin-worker", name: "Spin Worker", kind: "planet", bodyType: "rocky-planet",
    massKg: 6e24, radiusM: 6e6, positionM: [1e9, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0, spin: initialSpin };
  const settings = { gravitationalConstant: 6.6743e-11 };
  scope.send({ type: "SET_WORLD", origin: "import", bodies: [body], settings, environmentSeed: 1,
    session: { simulationTimeSeconds: 0, collisionMode: "scientific" }, revision: 1 });
  scope.send({ type: "START" });
  vi.advanceTimersByTime(50);
  const beforeMutation = scope.latestSnapshot();
  vi.advanceTimersByTime(10);
  const replacement: SpinState = { ...initialSpin, phaseAtEpochRad: 0, angularVelocityRadPerS: 0.0001 };
  scope.send({ type: "MUTATE_WORLD", revision: 2, mutation: { type: "SET_BODY_SPIN", bodyId: body.id, spin: replacement } });
  const committed = scope.latestSnapshot();
  expect(committed.simulationTimeSeconds).toBeGreaterThan(beforeMutation.simulationTimeSeconds);
  expect(spinPhaseAtAcceptedTimeRad(committed.bodies[0]!.spin!, committed.simulationTimeSeconds))
    .toBeCloseTo(spinPhaseAtAcceptedTimeRad(initialSpin, committed.simulationTimeSeconds), 12);
});

it("starts first spin adoption at phase zero at the running commit time", () => {
  const scope = new SpinWorkerScope();
  cleanup = installSimulationWorker(scope as unknown as Parameters<typeof installSimulationWorker>[0]);
  const body: CelestialBody = { id: "spin-adoption", name: "Spin Adoption", kind: "planet", bodyType: "rocky-planet",
    massKg: 6e24, radiusM: 6e6, positionM: [1e9, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 };
  scope.send({ type: "SET_WORLD", origin: "import", bodies: [body], settings: { gravitationalConstant: 6.6743e-11 },
    environmentSeed: 1, session: { simulationTimeSeconds: 0, collisionMode: "scientific" }, revision: 1 });
  scope.send({ type: "START" });
  vi.advanceTimersByTime(50);
  const beforeMutation = scope.latestSnapshot();
  vi.advanceTimersByTime(10);
  const requestedSpin: SpinState = { modelId: "rigid-body-spin-v1", axisUnitWorld: [0, 1, 0],
    phaseAtEpochRad: 0.7, angularVelocityRadPerS: 0.0001 };
  scope.send({ type: "MUTATE_WORLD", revision: 2,
    mutation: { type: "SET_BODY_SPIN", bodyId: body.id, spin: requestedSpin } });
  const committed = scope.latestSnapshot();

  expect(committed.simulationTimeSeconds).toBeGreaterThan(beforeMutation.simulationTimeSeconds);
  expect(committed.bodies[0]!.spin).toBeDefined();
  expect(spinPhaseAtAcceptedTimeRad(committed.bodies[0]!.spin!, committed.simulationTimeSeconds)).toBeCloseTo(0, 12);
});
