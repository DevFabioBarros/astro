import { describe, expect, it, vi } from "vitest";
import { createSimulationClient } from "./simulation-client";
import { MAX_SIMULATION_SPEED } from "./simulation-time";
import type { CelestialBody, SimulationSnapshot } from "./types";

class TestWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();

  send(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const body: CelestialBody = {
  id: "earth",
  name: "Earth",
  kind: "planet",
  massKg: 5.972e24,
  radiusM: 6.371e6,
  positionM: [0, 0, 0],
  velocityMs: [0, 0, 0],
  surfaceTemperatureK: 288,
  waterFraction: 0.7,
};
const defaults = { environmentSeed: 0x4c454701, history: { generation: 0, undoCheckpointId: null, redoCheckpointId: null, actionCount: 0, bytes: 0 }, presentationEpoch: 0 };

describe("createSimulationClient", () => {
  it("validates intentional mutations before posting monotonically revised commands", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const mutation = { type: "EDIT_BODY" as const, bodyId: "earth", field: "massKg" as const, value: 6e24 };
    client.mutateWorld(mutation, 1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "MUTATE_WORLD", mutation, revision: 1 });
    expect(() => client.mutateWorld(mutation, 1)).toThrow(/revision/);
    expect(() => client.mutateWorld({ ...mutation, value: -1 }, 2)).toThrow();
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });

  it("passes custom explosion energy through the existing mutation client", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const mutation = { type: "EXPLODE_BODY" as const, bodyId: "earth", specificEnergyJkg: 2e6 };

    client.mutateWorld(mutation, 1);

    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "MUTATE_WORLD", mutation, revision: 1 });
    expect(() => client.mutateWorld({ ...mutation, specificEnergyJkg: Number.POSITIVE_INFINITY }, 2)).toThrow();
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });

  it("sends mutation history coalescing metadata in the nested wire shape", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const mutation = { type: "EDIT_BODY" as const, bodyId: "earth", field: "massKg" as const, value: 6e24 };

    client.mutateWorld(mutation, 1, "mass-drag");

    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "MUTATE_WORLD", mutation, revision: 1, history: { coalesceId: "mass-drag" } });
  });

  it("accepts astronomical time rates and rejects unsupported rates", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    client.setSpeed(MAX_SIMULATION_SPEED);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    expect(() => client.setSpeed(MAX_SIMULATION_SPEED + 1)).toThrow();
  });
  it("validates and sends bodies with settings as one world command", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const bodies = [body, { ...body, id: "moon", positionM: [1e9, 0, 0] as const }];
    const settings = { gravitationalConstant: 1e-12 };

    client.setWorld(bodies, settings, 1, "initial");

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SET_WORLD", bodies, settings, environmentSeed: 0x41535400, revision: 1, origin: "initial" });
    expect(() => client.setWorld([body, { ...body, id: "moon" }], settings, 2, "initial")).toThrow();
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });

  it("sends replacement sidecars and publishes only revision-bound SURFACE_STATE messages", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const surface = { modelId: "sparse-relief-v1" as const, seed: 7, revision: 0, resolution: 64 as const, dataId: "earth-relief" };
    const bodies = [{ ...body, surface }];
    const surfaceData = { "earth-relief": [{ cellIndex: 2, elevationM: -500 }] };
    const surfaceHeatData = { "earth-relief": [{ cellIndex: 2, energyJ: 1e12 }] };
    const listener = vi.fn();
    client.subscribeSurfaceState(listener);

    client.setWorld(bodies, { gravitationalConstant: 0 }, 1, "import", undefined, undefined, 15, surfaceData);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "SET_WORLD", origin: "import", bodies,
      settings: { gravitationalConstant: 0 }, environmentSeed: 15, surfaceData, revision: 1 });
    worker.send({ type: "SURFACE_STATE", worldRevision: 0, surfaceData, surfaceHeatData });
    expect(listener).not.toHaveBeenCalled();
    worker.send({ type: "SURFACE_STATE", worldRevision: 1, surfaceData, surfaceHeatData });
    expect(listener).toHaveBeenCalledWith({ type: "SURFACE_STATE", worldRevision: 1, surfaceData, surfaceHeatData });
    worker.send({ type: "SURFACE_STATE", worldRevision: 1, surfaceData, surfaceHeatData: { "earth-relief": [{ cellIndex: 2, energyJ: Infinity }] } });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("sends controls and body updates to the worker", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);

    client.start();
    client.pause();
    client.setStellarEvolutionRunning(true);
    client.setStellarEvolutionRunning(false);
    client.setSpeed(10);
    client.setCollisionMode("creative", 1);
    client.setSettings({ gravitationalConstant: 0 }, 2);
    client.setBodies([body], 3);

    expect(worker.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "START" },
      { type: "PAUSE" },
      { type: "SET_STELLAR_EVOLUTION_RUNNING", running: true },
      { type: "SET_STELLAR_EVOLUTION_RUNNING", running: false },
      { type: "SET_SPEED", multiplier: 10 },
      { type: "SET_COLLISION_MODE", mode: "creative", revision: 1 },
      { type: "SET_SETTINGS", settings: { gravitationalConstant: 0 }, revision: 2 },
      { type: "SET_BODIES", bodies: [body], revision: 3 },
    ]);
  });

  it("sends trail sampling visibility as a worker control", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);

    client.setTrailSampling(false);
    client.setTrailSampling(true);

    expect(worker.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "SET_TRAIL_SAMPLING", enabled: false },
      { type: "SET_TRAIL_SAMPLING", enabled: true },
    ]);
  });

  it("requests a correlated trajectory preview without publishing it as a snapshot", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const snapshotListener = vi.fn();
    const previewListener = vi.fn();
    client.subscribe(snapshotListener);
    client.subscribeTrajectoryPreview(previewListener);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 5, status: "paused" } });
    const candidate = { ...body, id: "placement-ghost", name: "Preview", positionM: [10, 0, 0] as const, velocityMs: [-1, 0, 0] as const };
    const request = { requestId: 41, worldRevision: 0, baseTimeSeconds: 5, collisionMode: "scientific" as const, candidate };

    expect(client.requestTrajectoryPreview(request)).toBe(true);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "PREVIEW_TRAJECTORY", ...request });
    const preview = { points: [[10, 0, 0], [1, 0, 0]], contact: { timeSeconds: 8, positionM: [1, 0, 0], bodyIds: ["earth", "placement-ghost"] } };
    worker.send({ type: "TRAJECTORY_PREVIEW", requestId: 41, worldRevision: 0, baseTimeSeconds: 5, collisionMode: "scientific", preview });

    expect(previewListener).toHaveBeenCalledWith({ type: "TRAJECTORY_PREVIEW", requestId: 41, worldRevision: 0,
      baseTimeSeconds: 5, collisionMode: "scientific", preview });
    expect(snapshotListener).toHaveBeenCalledOnce();
  });

  it("requests a revision-bound orbital mutation preview and publishes only its typed result", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const snapshotListener = vi.fn();
    const previewListener = vi.fn();
    client.subscribe(snapshotListener);
    client.subscribeOrbitalMutationPreview(previewListener);
    worker.send({ type: "SNAPSHOT", worldRevision: 3, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 42, status: "paused", worldRevision: 3 } });
    const request = { type: "PREVIEW_ORBITAL_MUTATION" as const, version: 1 as const, requestId: 71,
      worldRevision: 3, baseTimeSeconds: 42,
      mutation: { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 4e8,
        planeNormal: [0, 0, 1] as const, radialDirection: [1, 0, 0] as const } };

    expect(client.requestOrbitalMutationPreview(request)).toBe(true);
    expect(worker.postMessage).toHaveBeenLastCalledWith(request);
    const response = { type: "ORBITAL_MUTATION_PREVIEW" as const, version: 1 as const, requestId: 71,
      worldRevision: 3, baseTimeSeconds: 42,
      result: { status: "ready" as const, candidates: [{ bodyId: "moon-1", positionM: [1, 2, 3] as const, velocityMs: [4, 5, 6] as const }] } };
    worker.send(response);

    expect(previewListener).toHaveBeenCalledWith(response);
    expect(snapshotListener).toHaveBeenCalledOnce();
  });

  it("drops orbital preview replies after the accepted revision changes", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const previewListener = vi.fn();
    client.subscribeOrbitalMutationPreview(previewListener);
    worker.send({ type: "SNAPSHOT", worldRevision: 3, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 42, status: "paused", worldRevision: 3 } });
    const request = { type: "PREVIEW_ORBITAL_MUTATION" as const, version: 1 as const, requestId: 72,
      worldRevision: 3, baseTimeSeconds: 42,
      mutation: { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 4e8,
        planeNormal: [0, 0, 1] as const, radialDirection: [1, 0, 0] as const } };
    expect(client.requestOrbitalMutationPreview(request)).toBe(true);
    worker.send({ type: "SNAPSHOT", worldRevision: 4, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 42, status: "paused", worldRevision: 4 } });
    worker.send({ type: "ORBITAL_MUTATION_PREVIEW", version: 1, requestId: 72, worldRevision: 3,
      baseTimeSeconds: 42, result: { status: "ready", candidates: [{ bodyId: "moon-1", positionM: [1, 2, 3], velocityMs: [4, 5, 6] }] } });

    expect(previewListener).not.toHaveBeenCalled();
  });

  it("rejects orbital preview requests unless revision, time, and paused state are accepted", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const request = { type: "PREVIEW_ORBITAL_MUTATION" as const, version: 1 as const, requestId: 73,
      worldRevision: 3, baseTimeSeconds: 42,
      mutation: { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 4e8,
        planeNormal: [0, 0, 1] as const, radialDirection: [1, 0, 0] as const } };

    worker.send({ type: "SNAPSHOT", worldRevision: 3, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 42, status: "running", worldRevision: 3 } });
    expect(client.requestOrbitalMutationPreview(request)).toBe(false);
    worker.send({ type: "SNAPSHOT", worldRevision: 3, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 42, status: "paused", worldRevision: 3 } });
    expect(client.requestOrbitalMutationPreview({ ...request, worldRevision: 2 })).toBe(false);
    expect(client.requestOrbitalMutationPreview({ ...request, baseTimeSeconds: 43 })).toBe(false);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("keeps a valid paused trajectory preview when simulation speed changes", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const previewListener = vi.fn();
    client.subscribeTrajectoryPreview(previewListener);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 5, status: "paused" } });
    const request = { requestId: 51, worldRevision: 0, baseTimeSeconds: 5, collisionMode: "scientific" as const,
      candidate: { ...body, id: "placement-ghost" } };

    expect(client.requestTrajectoryPreview(request)).toBe(true);
    client.setSpeed(60);
    worker.send({ type: "TRAJECTORY_PREVIEW", requestId: 51, worldRevision: 0, baseTimeSeconds: 5,
      collisionMode: "scientific", preview: null });

    expect(previewListener).toHaveBeenCalledWith(expect.objectContaining({ requestId: 51, preview: null }));
  });

  it("drops responses from superseded trajectory preview requests", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const previewListener = vi.fn();
    client.subscribeTrajectoryPreview(previewListener);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 5, status: "paused" } });
    const candidate = { ...body, id: "placement-ghost" };
    const request = { worldRevision: 0, baseTimeSeconds: 5, collisionMode: "scientific" as const, candidate };

    expect(client.requestTrajectoryPreview({ ...request, requestId: 41 })).toBe(true);
    expect(client.requestTrajectoryPreview({ ...request, requestId: 42 })).toBe(true);
    worker.send({ type: "TRAJECTORY_PREVIEW", requestId: 41, worldRevision: 0, baseTimeSeconds: 5,
      collisionMode: "scientific", preview: null });
    worker.send({ type: "TRAJECTORY_PREVIEW", requestId: 42, worldRevision: 0, baseTimeSeconds: 5,
      collisionMode: "scientific", preview: null });

    expect(previewListener).toHaveBeenCalledOnce();
    expect(previewListener).toHaveBeenCalledWith(expect.objectContaining({ requestId: 42 }));
  });

  it("drops cancelled or out-of-date trajectory previews without raising world errors", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const snapshotListener = vi.fn();
    const previewListener = vi.fn();
    client.subscribe(snapshotListener);
    client.subscribeTrajectoryPreview(previewListener);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 0, status: "paused" } });
    const candidate = { ...body, id: "placement-ghost" };
    const request = { worldRevision: 0, baseTimeSeconds: 0, collisionMode: "scientific" as const, candidate };

    expect(client.requestTrajectoryPreview({ ...request, requestId: 7 })).toBe(true);
    client.cancelTrajectoryPreview(7);
    worker.send({ type: "TRAJECTORY_PREVIEW", requestId: 7, worldRevision: 0, baseTimeSeconds: 0,
      collisionMode: "scientific", preview: null });
    expect(client.requestTrajectoryPreview({ ...request, requestId: 7 })).toBe(false);
    expect(client.requestTrajectoryPreview({ ...request, requestId: 8 })).toBe(true);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 1, status: "paused" } });
    worker.send({ type: "TRAJECTORY_PREVIEW", requestId: 8, worldRevision: 0, baseTimeSeconds: 0,
      collisionMode: "scientific", preview: null });

    expect(previewListener).not.toHaveBeenCalled();
    expect(snapshotListener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paused", simulationTimeSeconds: 1 }));
  });

  it("does not request previews from a stale, running, or mismatched collision state", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 0, status: "running" } });
    const candidate = { ...body, id: "placement-ghost" };

    expect(client.requestTrajectoryPreview({ requestId: 1, worldRevision: 0, baseTimeSeconds: 0, collisionMode: "scientific", candidate })).toBe(false);
    worker.send({ type: "SNAPSHOT", worldRevision: 1, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 0, status: "paused" } });
    expect(client.requestTrajectoryPreview({ requestId: 2, worldRevision: 0, baseTimeSeconds: 0, collisionMode: "scientific", candidate })).toBe(false);
    expect(client.requestTrajectoryPreview({ requestId: 3, worldRevision: 1, baseTimeSeconds: 1, collisionMode: "scientific", candidate })).toBe(false);
    worker.send({ type: "SNAPSHOT", worldRevision: 1, settings: { gravitationalConstant: 0 },
      snapshot: { bodies: [body], simulationTimeSeconds: 0, status: "paused", collisionMode: "creative" } });
    expect(client.requestTrajectoryPreview({ requestId: 4, worldRevision: 1, baseTimeSeconds: 0, collisionMode: "scientific", candidate })).toBe(false);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("delivers worker snapshots and worker errors to subscribers", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    const snapshot = { bodies: [body], simulationTimeSeconds: 60, status: "running" } as const;

    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot });
    worker.send({ type: "ERROR", message: "invalid worker message" });

    expect(listener).toHaveBeenNthCalledWith(1, { ...snapshot, ...defaults, collisionMode: "scientific", speedLimited: false, worldRevision: 0 });
    expect(listener).toHaveBeenNthCalledWith(2, {
      ...defaults,
      bodies: [body],
      simulationTimeSeconds: 60,
      status: "error",
      collisionMode: "scientific",
      speedLimited: false,
      worldRevision: 0,
      error: "invalid worker message",
    });
  });

  it("ignores snapshots older than the latest world command", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);

    client.setBodies([{ ...body, massKg: 6e24 }], 1);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 1, status: "running", integrationSamples: {
      version: 1, startTimeSeconds: 0, endTimeSeconds: 1, samples: [{ offsetSeconds: 1, bodies: [{ id: "earth", positionM: [1, 0, 0] }] }],
    } } });
    worker.send({ type: "SNAPSHOT", worldRevision: 1, snapshot: { bodies: [{ ...body, massKg: 6e24 }], simulationTimeSeconds: 0, status: "running" } });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ bodies: [{ ...body, massKg: 6e24 }], simulationTimeSeconds: 0 }));
  });

  it("ignores stale worker errors and publishes errors with the current revision", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    client.setBodies([body], 2);

    worker.send({ type: "ERROR", worldRevision: 1, message: "stale" });
    expect(listener).not.toHaveBeenCalled();
    worker.send({ type: "ERROR", worldRevision: 2, message: "current" });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", error: "current", worldRevision: 2 }));
  });

  it("rejects invalid speed and malformed worker snapshots", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);

    expect(() => client.setSpeed(Number.NaN)).toThrow();
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: "bad", simulationTimeSeconds: 0, status: "running" } });
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 0, status: "paused", stellarEvolutionRunning: "yes" } });

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("allows zero gravity and rejects negative or non-finite gravity", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    client.setSettings({ gravitationalConstant: 0 }, 1);
    expect(() => client.setSettings({ gravitationalConstant: -1 }, 2)).toThrow();
    expect(() => client.setSettings({ gravitationalConstant: Number.NaN }, 2)).toThrow();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SET_SETTINGS", settings: { gravitationalConstant: 0 }, revision: 1 });
  });

  it("unsubscribes and terminates on disposal", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);

    client.dispose();
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 0, status: "paused" } });
    client.start();

    expect(listener).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
  it("protects snapshots from mutation by subscribers", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    let received: SimulationSnapshot | undefined;
    client.subscribe((snapshot) => { received = snapshot; });
    const snapshot = { bodies: [structuredClone(body)], simulationTimeSeconds: 60, status: "running" };
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot });
    expect(() => { received!.bodies[0]!.massKg = 1; }).toThrow();
    expect(Reflect.set(received!.bodies[0]!.positionM, "0", 99)).toBe(false);
    expect(() => { received!.bodies.length = 0; }).toThrow();
    expect(() => { received!.status = "error"; }).toThrow();
    expect(received).toEqual({ ...snapshot, ...defaults, collisionMode: "scientific", speedLimited: false, worldRevision: 0 });
    expect(JSON.parse(JSON.stringify(received))).toEqual({ ...snapshot, ...defaults, collisionMode: "scientific", speedLimited: false, worldRevision: 0 });
  });
  it("accepts and freezes bounded versioned integration samples while keeping legacy snapshots valid", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    let received: SimulationSnapshot | undefined;
    client.subscribe((snapshot) => { received = snapshot; });
    const batch = { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: [
      { offsetSeconds: 1, bodies: [{ id: "earth", positionM: [1, 2, 3] as const }] },
      { offsetSeconds: 3, bodies: [{ id: "earth", positionM: [3, 2, 1] as const }] },
    ] } as const;
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 3, status: "running", integrationSamples: batch } });

    expect(received?.integrationSamples).toEqual(batch);
    expect(Reflect.set(received!.integrationSamples!.samples[0]!.bodies[0]!.positionM, "0", 9)).toBe(false);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 3, status: "running" } });
    expect(received).not.toHaveProperty("integrationSamples");
  });

  it("rejects malformed or oversized integration batches atomically", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    const invalid = [
      { version: 2, startTimeSeconds: 0, endTimeSeconds: 3, samples: [] },
      { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: [{ offsetSeconds: 3, bodies: [] }, { offsetSeconds: 2, bodies: [] }] },
      { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: [{ offsetSeconds: 2, bodies: [] }] },
      { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: [{ offsetSeconds: 2, bodies: [{ id: "earth", positionM: [0, Number.NaN, 0] }] }] },
      { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: [{ offsetSeconds: 2, bodies: [{ id: "earth", positionM: [0, 0, 0] }, { id: "earth", positionM: [1, 1, 1] }] }] },
      { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: Array.from({ length: 129 }, (_, index) => ({ offsetSeconds: index / 43, bodies: [] })) },
      { version: 1, startTimeSeconds: 0, endTimeSeconds: 3, samples: [{ offsetSeconds: 3, bodies: Array.from({ length: 7 }, (_, bodyIndex) => ({ id: `${bodyIndex}-${"x".repeat(38_000)}`, positionM: [0, 0, 0] })) }] },
    ];
    for (const integrationSamples of invalid) {
      worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 3, status: "running", integrationSamples } });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    }
  });
  it("validates and freezes transient event data from worker snapshots", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    let received: SimulationSnapshot | undefined;
    client.subscribe((snapshot) => { received = snapshot; });
    const event = { id: 1, type: "collision" as const, timeSeconds: 10, positionM: [0, 0, 0] as const, radiusM: 2, energyJ: 4, bodyIds: ["a", "b"] };
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 10, status: "running", events: [event] } });

    expect(received?.events).toEqual([event]);
    expect(() => { received!.events![0]!.bodyIds.push("x"); }).toThrow();
    const impulse = { id: 2, type: "impulse" as const, timeSeconds: 10, positionM: [0, 0, 0] as const, radiusM: 2,
      energyJ: 5, bodyIds: ["earth"], impulse: { modelId: "center-of-mass-impulse-v1", deltaVelocityMs: [1, 0, 0] as const,
        impulseNs: [5, 0, 0] as const, externalWorkJ: -5 } };
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 10, status: "running", events: [impulse] } });
    expect(received?.events).toEqual([impulse]);
    expect(() => { (received!.events![0]!.impulse!.deltaVelocityMs as unknown as number[])[0] = 8; }).toThrow();
    expect(() => { (received!.events![0]!.impulse!.impulseNs as unknown as number[])[0] = 8; }).toThrow();
    const laser = { id: 3, type: "laser" as const, timeSeconds: 10, positionM: [0, 0, 0] as const, radiusM: 2,
      energyJ: 2e9, bodyIds: ["earth"], laser: { modelId: "laser-energy-ledger-v1",
        profileId: "grey-albedo-laser-absorption-v1", bodyLocalDirection: [0, 1, 0] as const,
        powerW: 2e8, durationAcceptedSeconds: 10, albedo: 0.3, inputJ: 2e9, absorbedJ: 1.4e9, reflectedJ: 0.6e9 } };
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 10, status: "running", events: [laser] } });
    expect(received?.events).toEqual([laser]);
    expect(() => { (received!.events![0]!.laser!.bodyLocalDirection as unknown as number[])[1] = 0; }).toThrow();
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 10, status: "running", events: [{ ...event, energyJ: Number.NaN }] } });
    expect(received?.status).toBe("error");
  });

  it("accepts legacy collision events and validates optional collision diagnostics", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    const base = { id: 1, type: "collision", timeSeconds: 1, positionM: [0, 0, 0], radiusM: 1, energyJ: 1, bodyIds: ["a", "b"] };
    const send = (event: unknown) => worker.send({ type: "SNAPSHOT", worldRevision: 0,
      snapshot: { bodies: [body], simulationTimeSeconds: 1, status: "paused", events: [event] } });

    send(base);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ events: [base] }));
    const diagnostics = { modelId: "perfectly-inelastic-merge-v1", relativeSpeedMps: 2,
      specificImpactEnergyJkg: 0.5, impactAngleRad: null };
    send({ ...base, collisionDiagnostics: diagnostics });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ events: [expect.objectContaining({ collisionDiagnostics: diagnostics })] }));
    send({ ...base, collisionDiagnostics: { ...diagnostics, impactAngleRad: Math.PI / 2 } });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paused" }));
    const contact = { pointM: [1, 0, 0], normalM: [1, 0, 0], relativeVelocityMs: [-2, 0, 0] };
    send({ ...base, contact });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ events: [expect.objectContaining({ contact })] }));
    const acceptedContact = listener.mock.calls.at(-1)?.[0]?.events?.[0]?.contact;
    expect(() => acceptedContact.pointM.push(9)).toThrow();

    for (const invalid of [
      null,
      { ...diagnostics, modelId: "unknown" },
      { ...diagnostics, relativeSpeedMps: -1 },
      { ...diagnostics, relativeSpeedMps: Number.POSITIVE_INFINITY },
      { ...diagnostics, specificImpactEnergyJkg: Number.NaN },
      { ...diagnostics, impactAngleRad: -0.1 },
      { ...diagnostics, impactAngleRad: Math.PI / 2 + Number.EPSILON * 4 },
      { ...diagnostics, impactAngleRad: Number.POSITIVE_INFINITY },
      { ...diagnostics, impactAngleRad: "0" },
    ]) {
      send({ ...base, collisionDiagnostics: invalid });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    }
    for (const contact of [
      null,
      { pointM: [Number.NaN, 0, 0], normalM: null, relativeVelocityMs: [0, 0, 0] },
      { pointM: [0, 0, 0], normalM: [0.5, 0, 0], relativeVelocityMs: [0, 0, 0] },
      { pointM: [0, 0, 0], normalM: null, relativeVelocityMs: [Number.POSITIVE_INFINITY, 0, 0] },
    ]) {
      send({ ...base, contact });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    }
    send({ ...base, type: "explosion", contact });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("accepts creative collision and black-hole capture outcomes, freezes IDs, rejects malformed outcomes", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    let received: SimulationSnapshot | undefined;
    client.subscribe((snapshot) => { received = snapshot; });
    const fragments = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const fragmentation = { id: 1, type: "collision", timeSeconds: 1, positionM: [0, 0, 0], radiusM: 2, energyJ: 10,
      bodyIds: ["a", "b"], outcome: { kind: "creative-fragmentation", modelId: "creative-fragmentation-v1", fragmentBodyIds: fragments,
        availableEnergyJ: 10, fragmentKineticEnergyJ: 6, dissipatedEnergyJ: 4 } };
    const capture = { id: 2, type: "black-hole-capture", timeSeconds: 2, positionM: [0, 0, 0], radiusM: 3, energyJ: 0,
      bodyIds: ["bh", "rock"], outcome: { kind: "creative-accretion", modelId: "creative-accretion-v1", captorBodyId: "bh", absorbedBodyId: "rock", captureRadiusM: 100 } };
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 2, status: "paused", events: [fragmentation, capture] } });
    expect(received?.events).toEqual([fragmentation, capture]);
    const outcome = received!.events![0]!.outcome;
    if (outcome?.kind !== "creative-fragmentation") throw new Error("Expected fragmentation outcome");
    expect(Reflect.set(outcome.fragmentBodyIds, "0", "bad")).toBe(false);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 2, status: "paused", events: [
      { ...fragmentation, outcome: { ...fragmentation.outcome, fragmentKineticEnergyJ: 11, dissipatedEnergyJ: 0 } },
    ] } });
    expect(received?.status).toBe("error");
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 2, status: "paused", events: [
      { ...capture, bodyIds: ["wrong", "rock"] },
    ] } });
    expect(received?.status).toBe("error");
  });

  it("propagates worker transport and deserialization errors", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    worker.dispatchEvent(new MessageEvent("messageerror"));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    worker.postMessage.mockImplementation(() => { throw new Error("transport failed"); });
    client.start();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", error: "transport failed" }));
  });

  it("removes subscriptions independently and disposes only once", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    unsubscribe();
    worker.send({ type: "ERROR", message: "failed" });
    client.dispose();
    client.dispose();
    client.subscribe(listener);
    worker.dispatchEvent(new MessageEvent("messageerror"));
    expect(listener).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("keeps the last valid world when worker data is invalid or the worker fails", () => {
    const worker = new TestWorker();
    const client = createSimulationClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    worker.send({ type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [body], simulationTimeSeconds: 60, status: "running" } });
    for (const message of [null, { type: "OTHER" }, { type: "ERROR", message: 123 },
      { type: "SNAPSHOT", worldRevision: 0, snapshot: { bodies: [{ ...body, massKg: -1 }], simulationTimeSeconds: 0, status: "running" } }]) {
      worker.send(message);
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ bodies: [body], simulationTimeSeconds: 60, status: "error", worldRevision: 0 }));
    }
    worker.dispatchEvent(Object.assign(new Event("error"), { message: "Worker crashed" }));
    expect(listener).toHaveBeenLastCalledWith({
      bodies: [body], environmentSeed: 0x4c454701, simulationTimeSeconds: 60, status: "error", collisionMode: "scientific", speedLimited: false,
      history: { generation: 0, undoCheckpointId: null, redoCheckpointId: null, actionCount: 0, bytes: 0 },
      presentationEpoch: 0, worldRevision: 0, error: "Worker crashed",
    });
  });
});
