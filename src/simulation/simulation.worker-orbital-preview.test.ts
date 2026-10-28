import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorldMutation } from "./world-mutations";
import { createEmptySwarmLedger } from "./swarm-model";
import { installSimulationWorker } from "./simulation.worker";
import type { CelestialBody, SimulationSnapshot, SimulationWorkerMessage, Vector3 } from "./types";

class OrbitalPreviewWorkerScope extends EventTarget {
  messages: SimulationWorkerMessage[] = [];
  postMessage = (message: SimulationWorkerMessage) => this.messages.push(structuredClone(message));
  send(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) })); }
  latestSnapshot(): SimulationSnapshot {
    const message = this.messages.filter((item) => item.type === "SNAPSHOT").at(-1);
    if (!message || message.type !== "SNAPSHOT") throw new Error("Expected accepted snapshot");
    return message.snapshot;
  }
}

const settings = { gravitationalConstant: 6.6743e-11 };
const environmentSeed = 0x1234_5678;
const baseTimeSeconds = 42;
const primary: CelestialBody = {
  id: "primary", name: "Primary", kind: "planet", bodyType: "rocky-planet", massKg: 8e24, radiusM: 6e6,
  positionM: [1e9, -2e9, 3e9], velocityMs: [120, -30, 4], surfaceTemperatureK: 288, waterFraction: 0,
};
const mutation = {
  type: "CREATE_ORBITAL_RING" as const, primaryId: "primary", innerRadiusM: 2e7, outerRadiusM: 3e7,
  representativeCount: 4, totalMassKg: 8e12, profileId: "rock-v1" as const,
  planeNormal: [0, 0, 1] as Vector3, radialDirection: [0, 1, 0] as Vector3,
};
const cleanups: (() => void)[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function startWorker(bodies: CelestialBody[] = [primary]) {
  const scope = new OrbitalPreviewWorkerScope();
  cleanups.push(installSimulationWorker(scope as unknown as Parameters<typeof installSimulationWorker>[0]));
  scope.send({ type: "SET_WORLD", origin: "import", bodies, settings, environmentSeed, swarmLedger: createEmptySwarmLedger(),
    session: { simulationTimeSeconds: baseTimeSeconds, collisionMode: "scientific" }, revision: 1 });
  return scope;
}

describe("orbital mutation preview in the Worker", () => {
  it("dry-runs the accepted ring mutation and matches the later commit without changing accepted state", () => {
    const scope = startWorker();
    const before = scope.latestSnapshot();
    const snapshotCount = scope.messages.filter((message) => message.type === "SNAPSHOT").length;
    const request = { type: "PREVIEW_ORBITAL_MUTATION", version: 1, requestId: 1, worldRevision: 1, baseTimeSeconds, mutation };

    scope.send(request);

    const response = scope.messages.at(-1)!;
    expect(response).toMatchObject({ type: "ORBITAL_MUTATION_PREVIEW", version: 1, requestId: 1, worldRevision: 1,
      baseTimeSeconds, result: { status: "ready" } });
    if (response.type !== "ORBITAL_MUTATION_PREVIEW" || response.result?.status !== "ready") throw new Error("Expected ready preview");
    expect(scope.latestSnapshot()).toEqual(before);
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT")).toHaveLength(snapshotCount);
    expect(scope.messages.filter((message) => message.type === "SWARM_STATE")).toHaveLength(1);

    const expected = applyWorldMutation([primary], settings, mutation, {
      simulationTimeSeconds: baseTimeSeconds, swarmLedger: createEmptySwarmLedger(), environmentSeed,
    });
    scope.send({ type: "MUTATE_WORLD", mutation, revision: 2 });
    const committed = scope.latestSnapshot();
    const committedCandidates = committed.bodies.filter(({ id }) => !before.bodies.some((body) => body.id === id))
      .map(({ id, positionM, velocityMs }) => ({ bodyId: id, positionM, velocityMs }));

    expect(committedCandidates).toEqual(response.result.candidates);
    expect(committed.bodies).toEqual(expected.bodies);
    expect(scope.messages.filter((message) => message.type === "SWARM_STATE").at(-1)).toMatchObject({
      worldRevision: 2, swarmLedger: expected.swarmLedger,
    });
    expect(committed.environmentSeed).toBe(environmentSeed);
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT").at(-1)).toMatchObject({ worldRevision: 2,
      snapshot: { simulationTimeSeconds: baseTimeSeconds, history: { actionCount: (before.history?.actionCount ?? 0) + 1 } } });
  });

  it("refuses a cap64 ring atomically and returns no partial candidates", () => {
    const bodies = Array.from({ length: 61 }, (_, index) => ({
      ...primary, id: `body-${index}`, name: `Body ${index}`, massKg: 1e10, radiusM: 10,
      positionM: [index * 1e9, 0, 0] as Vector3,
    }));
    const scope = startWorker(bodies);
    const before = scope.latestSnapshot();
    const snapshotCount = scope.messages.filter((message) => message.type === "SNAPSHOT").length;

    scope.send({ type: "PREVIEW_ORBITAL_MUTATION", version: 1, requestId: 2, worldRevision: 1, baseTimeSeconds,
      mutation: { ...mutation, primaryId: "body-0" } });

    expect(scope.messages.at(-1)).toMatchObject({ type: "ORBITAL_MUTATION_PREVIEW",
      result: { status: "refused", code: "INVALID_BODY" } });
    expect(scope.latestSnapshot()).toEqual(before);
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT")).toHaveLength(snapshotCount);
  });

  it("returns a stale result while running or when accepted revision/time no longer match", () => {
    const scope = startWorker();
    scope.send({ type: "START" });
    const runningSnapshot = scope.latestSnapshot();
    scope.send({ type: "PREVIEW_ORBITAL_MUTATION", version: 1, requestId: 3, worldRevision: 1, baseTimeSeconds, mutation });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ORBITAL_MUTATION_PREVIEW", result: null });
    expect(scope.latestSnapshot()).toEqual(runningSnapshot);

    scope.send({ type: "PAUSE" });
    const pausedSnapshot = scope.latestSnapshot();
    scope.send({ type: "PREVIEW_ORBITAL_MUTATION", version: 1, requestId: 4, worldRevision: 0, baseTimeSeconds, mutation });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ORBITAL_MUTATION_PREVIEW", result: null });
    expect(scope.latestSnapshot()).toEqual(pausedSnapshot);
    scope.send({ type: "PREVIEW_ORBITAL_MUTATION", version: 1, requestId: 5, worldRevision: 1, baseTimeSeconds: baseTimeSeconds + 1, mutation });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ORBITAL_MUTATION_PREVIEW", result: null });
    expect(scope.latestSnapshot()).toEqual(pausedSnapshot);
  });
});
