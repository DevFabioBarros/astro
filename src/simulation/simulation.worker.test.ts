import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSimulationWorker } from "./simulation.worker";
import { createSimulationClient } from "./simulation-client";
import { createSolarSystem } from "./solar-system";
import { advanceSimulationInterval, MAX_SIMULATION_SPEED } from "./simulation-time";
import { advanceThermalTemperatures } from "./thermal-model";
import { MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG } from "./world-mutations";
import { decodeSimulation, encodeSimulation } from "./save-file";
import { MAX_WORLD_HISTORY_BYTES } from "./world-history";
import { estimateIntegrationSampleBatchBytes, MAX_INTEGRATION_SAMPLE_BATCH_BYTES, type CelestialBody, type SimulationSnapshot, type SimulationWorkerMessage } from "./types";

class TestWorkerScope extends EventTarget {
  messages: SimulationWorkerMessage[] = [];
  revision = 0;
  postMessage = (message: SimulationWorkerMessage) => { this.messages.push(structuredClone(message)); };
  send(data: unknown) {
    const command = data as Record<string, unknown> | null;
    if (command && ["SET_SETTINGS", "SET_BODIES", "SET_WORLD", "SET_COLLISION_MODE", "RESTORE_CHECKPOINT", "MUTATE_WORLD"].includes(String(command.type))) {
      const revision = typeof command.revision === "number" ? command.revision : this.revision + 1;
      this.revision = Math.max(this.revision, revision);
      data = { ...command, ...(command.type === "SET_WORLD" && command.origin === undefined ? { origin: "initial" } : {}), revision };
    }
    this.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
  }
  latest(): SimulationSnapshot {
    const message = this.messages.filter((item) => item.type === "SNAPSHOT").at(-1);
    if (!message) throw new Error("Expected a snapshot");
    return message.snapshot;
  }
}

class BridgeWorker extends EventTarget {
  scope!: TestWorkerScope;
  postMessage(data: unknown) { this.scope.send(data); }
  terminate() {}
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) })); }
}

const body: CelestialBody = {
  id: "earth", name: "Earth", kind: "planet", massKg: 1e12, radiusM: 1,
  positionM: [0, 0, 0], velocityMs: [1, 0, 0], surfaceTemperatureK: 288, waterFraction: 0,
};
const cleanups: (() => void)[] = [];
function createScope() {
  const scope = new TestWorkerScope();
  cleanups.push(installSimulationWorker(scope as unknown as Parameters<typeof installSimulationWorker>[0]));
  return scope;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

describe("simulation worker", () => {
  it("restores explosion bodies atomically, pauses clocks, clears transient events, and redoes without replay", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: body.id } });
    const explosion = scope.latest().events?.at(-1);
    expect(explosion).toMatchObject({ type: "explosion", bodyIds: expect.arrayContaining([body.id]) });
    expect(explosion?.bodyIds).toHaveLength(7);
    expect(new Set(explosion?.bodyIds).size).toBe(7);

    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const beforeUndo = scope.latest();
    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: beforeUndo.history!.undoCheckpointId!, direction: "undo", generation: beforeUndo.history!.generation });
    const undone = scope.latest();
    expect(undone).toMatchObject({ status: "paused", simulationTimeSeconds: 0, events: [] });
    expect(undone.stellarEvolutionRunning).toBeUndefined();
    expect(undone.bodies.map(({ id }) => id)).toEqual([body.id]);
    expect(undone.presentationEpoch).toBe(beforeUndo.presentationEpoch! + 1);

    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: undone.history!.redoCheckpointId!, direction: "redo", generation: undone.history!.generation });
    const redone = scope.latest();
    expect(redone.bodies).toHaveLength(6);
    expect(redone.events).toEqual([]);
    expect(redone.status).toBe("paused");
    expect(redone.presentationEpoch).toBe(undone.presentationEpoch! + 1);

    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: redone.bodies[0]!.id } });
    expect(scope.latest().events?.at(-1)?.id).toBeGreaterThan(explosion!.id);
  });

  it("records experiments as undoable replacements but treats reset, import, and legacy bodies replacement as barriers", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "massKg", value: 2e12 } });
    const beforeExperiment = scope.latest();
    scope.send({ type: "SET_WORLD", origin: "experiment", bodies: [{ ...body, massKg: 3e12 }], settings: { gravitationalConstant: 0 }, collisionMode: "creative" });
    const experiment = scope.latest();
    expect(experiment).toMatchObject({ collisionMode: "creative", simulationTimeSeconds: 0 });
    expect(experiment.history!.generation).toBe(beforeExperiment.history!.generation);
    expect(experiment.history!.actionCount).toBe(2);

    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: experiment.history!.undoCheckpointId!, direction: "undo", generation: experiment.history!.generation });
    expect(scope.latest()).toMatchObject({ collisionMode: "scientific", bodies: [{ massKg: 2e12 }] });
    const beforeReset = scope.latest();
    scope.send({ type: "SET_WORLD", origin: "reset", bodies: [body], settings: { gravitationalConstant: 0 } });
    expect(scope.latest().history).toMatchObject({ generation: beforeReset.history!.generation + 1, actionCount: 0, undoCheckpointId: null, redoCheckpointId: null });
    const beforeBodiesReplacement = scope.latest();
    scope.send({ type: "SET_BODIES", bodies: [{ ...body, massKg: 4e12 }] });
    expect(scope.latest().history!.generation).toBe(beforeBodiesReplacement.history!.generation + 1);
    expect(scope.latest().history!.actionCount).toBe(0);
  });

  it("records collision mode as a revisioned action and preserves history on rejected mutations", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_COLLISION_MODE", mode: "creative" });
    const accepted = scope.latest();
    expect(accepted).toMatchObject({ collisionMode: "creative", history: { actionCount: 1 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "REMOVE_BODY", bodyId: "missing" } });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", snapshot: { history: accepted.history, collisionMode: "creative" } });
  });

  it("coalesces mutation history using nested wire metadata", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "massKg", value: 2e12 }, history: { coalesceId: "mass-drag" } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "radiusM", value: 2 }, history: { coalesceId: "mass-drag" } });

    const edited = scope.latest();
    expect(edited.history?.actionCount).toBe(1);
    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: edited.history!.undoCheckpointId!, direction: "undo", generation: edited.history!.generation });
    expect(scope.latest().bodies).toEqual([body]);
  });

  it("undoes and redoes water adoption without losing its accepted inventory", () => {
    const scope = createScope();
    const wetBody = { ...body, waterFraction: 0.7 };
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [wetBody], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "ADOPT_WATER_INVENTORY", bodyId: wetBody.id } });
    const adopted = scope.latest();
    expect(adopted.bodies[0]!.waterInventory?.liquidKg).toBeGreaterThan(0);

    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: adopted.history!.undoCheckpointId!, direction: "undo", generation: adopted.history!.generation });
    expect(scope.latest().bodies[0]!.waterInventory).toBeUndefined();
    scope.send({ type: "RESTORE_CHECKPOINT", checkpointId: scope.latest().history!.redoCheckpointId!, direction: "redo", generation: adopted.history!.generation });
    expect(scope.latest().bodies[0]!.waterInventory).toEqual(adopted.bodies[0]!.waterInventory);
  });

  it("rejects an oversized history action without committing or stopping the Worker", () => {
    const scope = createScope();
    const sun: CelestialBody = {
      ...body,
      id: "sun",
      name: "Sol",
      kind: "star",
      massKg: 1.9884e30,
      radiusM: 695700000,
      stellarEvolution: {
        modelId: "mist-v1.2-solar-1msun-nonrotating",
        modelVersion: "1.2",
        ageYears: 4.58e9,
        accretedMassKg: 0,
        absorbedBodyIds: ["x".repeat(MAX_WORLD_HISTORY_BYTES / 2)],
        mode: "manual",
      },
    };
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: [sun], settings: { gravitationalConstant: 0 } });
    const before = scope.latest();

    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: "sun", field: "positionM.0", value: 1 } });

    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", snapshot: { status: "paused", bodies: [sun], history: before.history } });
    scope.send({ type: "SET_BODIES", bodies: [body] });
    expect(scope.latest()).toMatchObject({ status: "paused", bodies: [body] });
  });

  it("applies delayed slider mutations on authoritative positions and counts pending time", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "massKg", value: body.massKg * 2 } });
    expect(scope.latest().simulationTimeSeconds).toBe(10);
    expect(scope.latest().bodies[0]!.positionM).toEqual([10, 0, 0]);
    clock.mockReturnValue(200);
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "radiusM", value: 5 } });
    expect(scope.latest().simulationTimeSeconds).toBe(20);
    expect(scope.latest().bodies[0]).toMatchObject({ positionM: [20, 0, 0], massKg: body.massKg * 2, radiusM: 5 });
    clock.mockReturnValue(300);
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "REMOVE_BODY", bodyId: "missing" } });
    const rejection = scope.messages.at(-1)!;
    expect(rejection).toMatchObject({ type: "ERROR", rejectedRevision: 4, snapshot: { simulationTimeSeconds: 30, bodies: [{ positionM: [30, 0, 0] }] } });
    clock.mockReturnValue(400);
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "massKg", value: body.massKg * 3 } });
    expect(scope.latest().simulationTimeSeconds).toBe(40);
    expect(scope.latest().bodies[0]).toMatchObject({ positionM: [40, 0, 0], massKg: body.massKg * 3 });
    clock.mockRestore();
  });

  it("answers paused trajectory previews from an isolated candidate without committing state or event IDs", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    const accepted = structuredClone(scope.latest());
    const acceptedMessageCount = scope.messages.length;
    const candidate = { ...body, id: "placement-ghost", name: "Preview", positionM: [10, 0, 0] as const, velocityMs: [-1, 0, 0] as const };

    scope.send({ type: "PREVIEW_TRAJECTORY", requestId: 11, worldRevision: 1, baseTimeSeconds: 0,
      collisionMode: "scientific", candidate });

    const previewMessages = scope.messages.slice(acceptedMessageCount);
    const response = previewMessages.at(-1);
    expect(response).toMatchObject({ type: "TRAJECTORY_PREVIEW", requestId: 11, worldRevision: 1,
      baseTimeSeconds: 0, collisionMode: "scientific", preview: { contact: { bodyIds: ["earth", "placement-ghost"] } } });
    expect(previewMessages.some((message) => message.type === "SNAPSHOT")).toBe(false);
    expect(scope.latest()).toEqual(accepted);
    expect(scope.messages.some((message) => message.type === "ERROR")).toBe(false);

    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: "earth", specificEnergyJkg: 1e6 } });
    expect(scope.latest().events?.[0]?.id).toBe(1);
  });

  it("matches relative preview contact time to the accepted absolute collision time", () => {
    const scope = createScope();
    const baseTimeSeconds = 1_234.5;
    const target = { ...body, velocityMs: [0, 0, 0] as const };
    const candidate = { ...body, id: "placement-ghost", name: "Preview", positionM: [10, 0, 0] as const, velocityMs: [-1, 0, 0] as const };
    scope.send({ type: "SET_WORLD", origin: "import", bodies: [target], settings: { gravitationalConstant: 0 },
      session: { simulationTimeSeconds: baseTimeSeconds, collisionMode: "scientific" } });
    const paused = scope.latest();
    scope.send({ type: "PREVIEW_TRAJECTORY", requestId: 42, worldRevision: scope.revision,
      baseTimeSeconds, collisionMode: "scientific", candidate });

    const previewMessage = scope.messages.filter((message) => message.type === "TRAJECTORY_PREVIEW").at(-1);
    expect(previewMessage).toMatchObject({ type: "TRAJECTORY_PREVIEW", requestId: 42,
      worldRevision: scope.revision, baseTimeSeconds, collisionMode: "scientific" });
    if (previewMessage?.type !== "TRAJECTORY_PREVIEW" || !previewMessage.preview?.contact) throw new Error("Expected predicted contact");
    const predictedRelativeSeconds = previewMessage.preview.contact.timeSeconds;
    expect(previewMessage.preview.contact.bodyIds).toEqual(["earth", "placement-ghost"]);

    scope.send({ type: "SET_BODIES", bodies: [target, candidate] });
    scope.send({ type: "SET_SPEED", multiplier: 1_000 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const acceptedCollision = scope.latest().events?.find((event) => event.type === "collision");

    expect(acceptedCollision).toMatchObject({ type: "collision", bodyIds: ["earth", "placement-ghost"] });
    // Zero-G linear fixture with symmetric radii: tolerance measures solver agreement, not range clipping.
    expect(Math.abs((baseTimeSeconds + predictedRelativeSeconds) - acceptedCollision!.timeSeconds)).toBeLessThanOrEqual(1e-6);
  });

  it("returns an empty trajectory preview for stale, invalid, or running requests without worker errors", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    const candidate = { ...body, id: "placement-ghost", positionM: [10, 0, 0] as const, velocityMs: [0, 0, 0] as const };
    const sendPreview = (requestId: number, overrides: Record<string, unknown> = {}) => scope.send({ type: "PREVIEW_TRAJECTORY",
      requestId, worldRevision: 1, baseTimeSeconds: 0, collisionMode: "scientific", candidate, ...overrides });

    sendPreview(12, { worldRevision: 0 });
    sendPreview(13, { collisionMode: "creative" });
    sendPreview(14, { candidate: { ...candidate, massKg: -1 } });
    scope.send({ type: "START" });
    sendPreview(15);

    const previews = scope.messages.filter((message) => message.type === "TRAJECTORY_PREVIEW");
    expect(previews.map((message) => message.type === "TRAJECTORY_PREVIEW" ? message.preview : undefined)).toEqual([null, null, null, null]);
    expect(scope.messages.some((message) => message.type === "ERROR")).toBe(false);
  });

  it("preserves elapsed time and unedited phase-space coordinates after changing central mass", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 } });
    scope.send({ type: "SET_SPEED", multiplier: 86400 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(1000);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(50);
    const before = scope.latest();
    const edited = before.bodies.map((body) => body.id === "sun" ? { ...body, massKg: body.massKg * 2 } : body);
    scope.send({ type: "SET_BODIES", bodies: edited });
    vi.advanceTimersByTime(50);
    const after = scope.latest();
    expect(after.simulationTimeSeconds).toBe(before.simulationTimeSeconds);
    expect(after.simulationTimeSeconds).toBe(86400);
    expect(after.bodies).toEqual(edited);
    scope.send({ type: "SET_WORLD", bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 } });
    vi.advanceTimersByTime(50);
    expect(scope.latest().simulationTimeSeconds).toBe(0);
  });

  it("advances solar age on its own worker clock and blocks orbital restart until paused", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "INIT_SOLAR_EVOLUTION" } });
    const initial = scope.latest();
    scope.send({ type: "SET_STELLAR_EVOLUTION_RUNNING", running: true });
    vi.advanceTimersByTime(100);
    const evolving = scope.latest();
    expect(evolving.stellarEvolutionRunning).toBe(true);
    expect(evolving.status).toBe("paused");
    expect(evolving.simulationTimeSeconds).toBe(initial.simulationTimeSeconds);
    expect(evolving.bodies.find(({ id }) => id === "sun")!.stellarEvolution!.ageYears)
      .toBeGreaterThan(initial.bodies.find(({ id }) => id === "sun")!.stellarEvolution!.ageYears);

    scope.send({ type: "START" });
    expect(scope.latest()).toMatchObject({ status: "paused", stellarEvolutionRunning: true });
    scope.send({ type: "SET_STELLAR_EVOLUTION_RUNNING", running: false });
    expect(scope.latest().status).toBe("paused");
    expect(scope.latest().stellarEvolutionRunning ?? false).toBe(false);
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    expect(scope.latest().status).toBe("running");
    expect(scope.latest().stellarEvolutionRunning ?? false).toBe(false);
  });

  it("pauses the orbital ticker before initializing or seeking solar age", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 } });
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "INIT_SOLAR_EVOLUTION" } });
    const pausedAt = scope.latest().simulationTimeSeconds;
    expect(scope.latest().status).toBe("paused");
    expect(scope.latest().stellarEvolutionRunning ?? false).toBe(false);
    vi.advanceTimersByTime(500);
    expect(scope.latest().simulationTimeSeconds).toBe(pausedAt);
  });

  it("keeps the solar clock running when SET_BODIES candidate fails full-state validation", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 } });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "INIT_SOLAR_EVOLUTION" } });
    scope.send({ type: "SET_STELLAR_EVOLUTION_RUNNING", running: true });
    const acceptedAge = scope.latest().bodies.find(({ id }) => id === "sun")!.stellarEvolution!.ageYears;
    const acceptedSun = scope.latest().bodies.find(({ id }) => id === "sun")!;
    const invalidBodies = scope.latest().bodies.map((body) => body.id === "mercury"
      ? { ...body, positionM: [acceptedSun.positionM[0] + 1, acceptedSun.positionM[1], acceptedSun.positionM[2]] as const }
      : body);

    scope.send({ type: "SET_BODIES", bodies: invalidBodies });
    const rejection = scope.messages.at(-1);
    expect(rejection).toMatchObject({ type: "ERROR", snapshot: { stellarEvolutionRunning: true } });
    const ageAfterReject = rejection?.type === "ERROR"
      ? rejection.snapshot?.bodies.find(({ id }) => id === "sun")!.stellarEvolution!.ageYears ?? acceptedAge
      : acceptedAge;
    const rejectedSun = rejection?.type === "ERROR" ? rejection.snapshot?.bodies.find(({ id }) => id === "sun") : undefined;
    const rejectedMercury = rejection?.type === "ERROR" ? rejection.snapshot?.bodies.find(({ id }) => id === "mercury") : undefined;
    expect(Math.hypot(...rejectedMercury!.positionM.map((value, axis) => value - rejectedSun!.positionM[axis]!))).toBeGreaterThan(1e9);
    expect(ageAfterReject).toBeGreaterThanOrEqual(acceptedAge);
    vi.advanceTimersByTime(100);
    const after = scope.latest();
    expect(after.stellarEvolutionRunning).toBe(true);
    expect(after.bodies.find(({ id }) => id === "sun")!.stellarEvolution!.ageYears).toBeGreaterThan(ageAfterReject);
    expect(after.simulationTimeSeconds).toBe(0);
  });

  it("advances one month per real second without leaving an integration backlog", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: createSolarSystem() });
    scope.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(1_000);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(50);
    const snapshot = scope.latest();
    expect(snapshot.status).toBe("paused");
    expect(snapshot.simulationTimeSeconds).toBe(MAX_SIMULATION_SPEED);
    expect(snapshot.bodies.find(({ id }) => id === "earth")?.positionM).not.toEqual(createSolarSystem().find(({ id }) => id === "earth")?.positionM);
    expect(scope.messages.filter(({ type }) => type === "ERROR")).toEqual([]);
  });

  it("publishes accepted substep samples in the matching periodic snapshot", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const snapshot = scope.latest();

    expect(snapshot.integrationSamples).toMatchObject({
      version: 1, startTimeSeconds: 0, endTimeSeconds: snapshot.simulationTimeSeconds,
      samples: expect.arrayContaining([expect.objectContaining({ offsetSeconds: 1 })]),
    });
    expect(snapshot.integrationSamples?.samples.at(-1)?.offsetSeconds).toBe(snapshot.simulationTimeSeconds);
  });

  it("flushes pending samples before disabling trail sampling and resumes on enable", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "SET_TRAIL_SAMPLING", enabled: false });
    const flushed = scope.messages.filter((message) => message.type === "SNAPSHOT" && message.snapshot.integrationSamples);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ snapshot: { integrationSamples: { endTimeSeconds: 2.5 } } });

    vi.advanceTimersByTime(50);
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT" && message.snapshot.integrationSamples)).toHaveLength(1);
    scope.send({ type: "SET_TRAIL_SAMPLING", enabled: true });
    vi.advanceTimersByTime(50);
    expect(scope.latest().integrationSamples?.samples.length).toBeGreaterThan(0);
  });

  it("keeps trail sampling disabled when the integration tick fails during disable", () => {
    const scope = createScope();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    scope.send({ type: "START" });
    clock.mockReturnValue(100_000);
    scope.send({ type: "SET_TRAIL_SAMPLING", enabled: false });
    const rollback = scope.messages.findLast((message) => message.type === "ERROR");
    expect(rollback).toMatchObject({ type: "ERROR", snapshot: { status: "error", simulationTimeSeconds: 0 } });

    scope.send({ type: "SET_SPEED", multiplier: 60 });
    scope.send({ type: "START" });
    clock.mockReturnValue(100_100);
    vi.advanceTimersByTime(50);
    expect(scope.latest().status).toBe("running");
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT" && message.snapshot.integrationSamples)).toHaveLength(0);
    clock.mockRestore();
  });

  it("bounds and marks truncated samples without failing a valid integration tick", () => {
    const first: CelestialBody = { ...body, id: "first", positionM: [-34_000_000_000, 0, 0], velocityMs: [-5_000_000, 0, 0] };
    const second: CelestialBody = { ...body, id: "second", positionM: [34_000_000_000, 0, 0], velocityMs: [5_000_000, 0, 0] };
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [first, second], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const snapshot = scope.latest();

    expect(snapshot.status).toBe("running");
    expect(snapshot.integrationSamples?.samples.length).toBeLessThanOrEqual(128);
    expect(snapshot.integrationSamples?.truncated).toBe(true);
    expect(scope.messages.filter(({ type }) => type === "ERROR")).toEqual([]);
  });

  it("caps estimated batch bytes when body IDs make samples large", () => {
    const longIdBody = { ...body, id: "x".repeat(120_000) };
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [longIdBody], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const batch = scope.latest().integrationSamples;

    expect(scope.latest().status).toBe("running");
    expect(batch?.truncated).toBe(true);
    expect(estimateIntegrationSampleBatchBytes(batch!.samples)).toBeLessThanOrEqual(MAX_INTEGRATION_SAMPLE_BATCH_BYTES);
  });

  it.each([
    ["MUTATE_WORLD", (revision: number) => ({ type: "MUTATE_WORLD", mutation: { type: "EDIT_BODY", bodyId: body.id, field: "massKg", value: 2 }, revision })],
    ["SET_SETTINGS", (revision: number) => ({ type: "SET_SETTINGS", settings: { gravitationalConstant: 1e-12 }, revision })],
    ["SET_BODIES", (revision: number) => ({ type: "SET_BODIES", bodies: [{ ...body, name: "Updated" }], revision })],
  ] as const)("discards pending samples before %s changes revision", (_type, createCommand) => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    const before = scope.messages.length;
    scope.send(createCommand(2));
    const emitted = scope.messages.slice(before);

    expect(emitted.filter((message) => message.type === "SNAPSHOT" && message.worldRevision === 1 && message.snapshot.integrationSamples)).toHaveLength(0);
  });

  it("discards pending samples when a revision-changing mutation is rejected", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    const before = scope.messages.length;
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "REMOVE_BODY", bodyId: "missing" }, revision: 2 });
    const emitted = scope.messages.slice(before);

    expect(emitted.filter((message) => message.type === "SNAPSHOT" && message.worldRevision === 1 && message.snapshot.integrationSamples)).toHaveLength(0);
    expect(emitted.at(-1)).toMatchObject({ type: "ERROR", rejectedRevision: 2, worldRevision: 2 });
  });

  it("does not deliver old-revision samples through the client bridge", () => {
    const scope = createScope();
    const bridge = new BridgeWorker();
    bridge.scope = scope;
    const workerPost: (message: SimulationWorkerMessage) => void = scope.postMessage;
    scope.postMessage = (message) => { workerPost(message); bridge.receive(message); };
    const client = createSimulationClient(bridge as unknown as Worker);
    const snapshots: SimulationSnapshot[] = [];
    client.subscribe((snapshot) => snapshots.push(snapshot));
    client.setWorld([body], { gravitationalConstant: 0 }, 1, "initial");
    client.setSpeed(100);
    client.start();
    vi.advanceTimersByTime(25);
    client.mutateWorld({ type: "EDIT_BODY", bodyId: body.id, field: "massKg", value: 2 }, 2);

    expect(snapshots.some((snapshot) => snapshot.worldRevision === 1 && snapshot.integrationSamples)).toBe(false);
    expect(snapshots.at(-1)).toMatchObject({ worldRevision: 2, bodies: [{ massKg: 2 }] });
    client.dispose();
  });

  it("clears pending sample batches on SET_WORLD and excludes failed ticks from rollback snapshots", () => {
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(25);
    expect(scope.latest()).not.toHaveProperty("integrationSamples");

    const largeTick = createScope();
    const bodies = [{ ...body, velocityMs: [0, 0, 0] as const }];
    largeTick.send({ type: "SET_BODIES", bodies });
    largeTick.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    largeTick.send({ type: "START" });
    vi.spyOn(performance, "now").mockReturnValue(100_000);
    largeTick.send({ type: "PAUSE" });
    const rollback = largeTick.messages.find((message) => message.type === "ERROR");
    expect(rollback?.type === "ERROR" ? rollback.snapshot : undefined).not.toHaveProperty("integrationSamples");
    vi.restoreAllMocks();
  });

  it("reports excessive work atomically and resumes after selecting a safe speed", () => {
    const scope = createScope();
    const bodies = [{ ...body, velocityMs: [0, 0, 0] as const }];
    scope.send({ type: "SET_BODIES", bodies });
    scope.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    scope.send({ type: "START" });
    // A suspended background tab can exceed the bounded integration budget.
    const clock = vi.spyOn(performance, "now").mockReturnValue(100_000);
    scope.send({ type: "PAUSE" });
    expect(scope.messages.find(({ type }) => type === "ERROR")).toMatchObject({ type: "ERROR", snapshot: { bodies, simulationTimeSeconds: 0, status: "error" } });
    scope.send({ type: "SET_SPEED", multiplier: 60 });
    scope.send({ type: "START" });
    clock.mockReturnValue(100_100);
    vi.advanceTimersByTime(100);
    expect(scope.latest()).toMatchObject({ simulationTimeSeconds: 6, status: "running" });
    clock.mockRestore();
  });

  it("rejects a speed above the 64-body tick budget without replacing the accepted speed", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const scope = createScope();
    const bodies = Array.from({ length: 64 }, (_, index) => ({ ...body, id: `body-${index}`,
      positionM: [index * 1e9, 0, 0] as const, velocityMs: [0, 0, 0] as const }));
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_BODIES", bodies });
    scope.send({ type: "SET_SPEED", multiplier: 86_400 });
    scope.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.stringContaining("64 astros"), snapshot: { status: "paused", bodies } });

    scope.send({ type: "START" });
    clock.mockReturnValue(50);
    scope.send({ type: "PAUSE" });
    expect(scope.latest()).toMatchObject({ simulationTimeSeconds: 4_320, bodies });
    clock.mockRestore();
  });

  it("keeps all 17 accepted collision events in bounded snapshots at one revision", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const scope = createScope();
    const bodies = Array.from({ length: 17 }, (_, pair) => [0, 1].map((side) => ({
      ...body, id: `pair-${pair}-${side}`, radiusM: 1,
      positionM: [pair * 10 + side, 0, 0] as const, velocityMs: [0, 0, 0] as const,
    }))).flat();
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_BODIES", bodies });
    scope.send({ type: "SET_SPEED", multiplier: 60 });
    scope.send({ type: "START" });
    clock.mockReturnValue(50);
    scope.send({ type: "PAUSE" });

    const collisionSnapshots = scope.messages.filter((message) => message.type === "SNAPSHOT"
      && message.snapshot.events?.length);
    const sentEvents = collisionSnapshots.flatMap((message) => message.type === "SNAPSHOT" ? message.snapshot.events ?? [] : []);
    expect(sentEvents.map(({ id }) => id)).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    const latestRevision = scope.messages.filter((message) => message.type === "SNAPSHOT").at(-1)?.worldRevision;
    expect(collisionSnapshots.every((message) => message.type === "SNAPSHOT" && message.worldRevision === latestRevision)).toBe(true);
    expect(scope.latest().bodies).toHaveLength(17);
  });

  it("rejects body changes that would make the accepted speed exceed the new tick budget", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: [{ ...body, velocityMs: [0, 0, 0] as const }] });
    scope.send({ type: "SET_SPEED", multiplier: MAX_SIMULATION_SPEED });
    const crowded = Array.from({ length: 64 }, (_, index) => ({ ...body, id: `body-${index}`,
      positionM: [index * 1e9, 0, 0] as const, velocityMs: [0, 0, 0] as const }));
    scope.send({ type: "SET_BODIES", bodies: crowded });

    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.stringContaining("1 semana/s"), snapshot: { bodies: [{ id: body.id }] } });
    scope.send({ type: "SET_SPEED", multiplier: 604_800 });
    scope.send({ type: "SET_BODIES", bodies: crowded });
    vi.advanceTimersByTime(50);
    expect(scope.messages.at(-1)?.type).toBe("SNAPSHOT");
    expect(scope.latest().bodies).toHaveLength(64);
  });

  it("advances fractional simulation seconds at the 1/60 s/s rate", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const scope = createScope();
    const slowBody = { ...body, velocityMs: [1, 0, 0] as const };
    scope.send({ type: "SET_WORLD", bodies: [slowBody], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 1 / 60 });
    scope.send({ type: "START" });
    clock.mockReturnValue(1_000);
    scope.send({ type: "PAUSE" });

    expect(scope.latest().simulationTimeSeconds).toBeCloseTo(1 / 60, 12);
    expect(scope.latest().bodies[0]?.positionM[0]).toBeCloseTo(1 / 60, 12);
    clock.mockRestore();
  });

  it("moves continuously at 1 s/s across four 25 ms worker ticks", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const scope = createScope();
    scope.send({ type: "SET_WORLD", bodies: [{ ...body, velocityMs: [1, 0, 0] as const }], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_SPEED", multiplier: 1 });
    scope.send({ type: "START" });
    for (const now of [25, 50, 75, 100]) {
      clock.mockReturnValue(now);
      vi.advanceTimersByTime(25);
    }

    expect(scope.latest().simulationTimeSeconds).toBeCloseTo(0.1, 12);
    expect(scope.latest().bodies[0]?.positionM[0]).toBeCloseTo(0.1, 12);
    clock.mockRestore();
  });

  it("commits only budget-limited orbital time and matching thermal state, then stays paused", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const scope = createScope();
    const solar = createSolarSystem();
    const sun = { ...solar[0]!, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const };
    const earth = { ...solar.find(({ id }) => id === "earth")!, thermalProfileId: "earthlike-global-mean-v1" as const,
      positionM: [149_597_870_700, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 350 };
    const satellite: CelestialBody = { id: "near-earth", name: "Near Earth", kind: "planet", bodyType: "asteroid",
      massKg: 1e12, radiusM: 500, positionM: [149_597_870_700, 10_000_000, 0], velocityMs: [0, 1_000, 0],
      surfaceTemperatureK: 0, waterFraction: 0 };
    const fillers: CelestialBody[] = Array.from({ length: 61 }, (_, index) => ({ ...satellite, id: `filler-${index}`,
      name: `Filler ${index}`, positionM: [300_000_000_000 + index * 1_000_000_000, -300_000_000_000, 100_000_000_000],
      velocityMs: [0, 0, 0] }));
    const initialBodies = [sun, earth, satellite, ...fillers];
    scope.send({ type: "SET_WORLD", origin: "initial", bodies: initialBodies, settings: { gravitationalConstant: 0 } });
    expect(scope.latest().bodies).toHaveLength(64);
    scope.send({ type: "SET_SPEED", multiplier: 60_480 });
    scope.send({ type: "START" });
    clock.mockReturnValue(70);
    scope.send({ type: "PAUSE" });
    clock.mockReturnValue(120);
    vi.advanceTimersByTime(50);

    const accepted = scope.latest();
    const requestedSeconds = 0.07 * 60_480;
    const acceptedEarth = accepted.bodies.find(({ id }) => id === "earth")!;
    const expectedPrefix = advanceSimulationInterval(initialBodies, { gravitationalConstant: 0 }, requestedSeconds, 3_600);
    const expectedBodies = expectedPrefix.bodies;
    const expectedEarth = expectedBodies.find(({ id }) => id === "earth")!;
    const requestedDurationEarth = advanceThermalTemperatures(initialBodies, expectedBodies, requestedSeconds).find(({ id }) => id === "earth")!;
    expect(initialBodies).toHaveLength(64);
    expect(expectedPrefix.budgetLimited).toBe(true);
    expect(accepted).toMatchObject({ status: "paused", speedLimited: true });
    expect(accepted.simulationTimeSeconds).toBeGreaterThan(0);
    expect(accepted.simulationTimeSeconds).toBeLessThan(requestedSeconds);
    expect(accepted.simulationTimeSeconds).toBeCloseTo(expectedPrefix.advancedSeconds, 12);
    expect(acceptedEarth.surfaceTemperatureK).toBe(expectedEarth.surfaceTemperatureK);
    expect(Math.abs(acceptedEarth.surfaceTemperatureK - requestedDurationEarth.surfaceTemperatureK)).toBeGreaterThan(1e-4);

    const acceptedTime = accepted.simulationTimeSeconds;
    const acceptedTemperature = acceptedEarth.surfaceTemperatureK;
    clock.mockReturnValue(2_000);
    vi.advanceTimersByTime(1_000);
    expect(scope.latest().simulationTimeSeconds).toBe(acceptedTime);
    expect(scope.latest().bodies.find(({ id }) => id === "earth")!.surfaceTemperatureK).toBe(acceptedTemperature);
    clock.mockRestore();
  });

  it("commits explosion events, keeps rejected mutations ghost-free, and clears events on SET_WORLD", () => {
    const scope = createScope();
    const planet: CelestialBody = {
      ...body, bodyType: "rocky-planet", massKg: 1e20, radiusM: 1e5,
      positionM: [0, 0, 0], velocityMs: [0, 0, 0],
    };
    const compact: CelestialBody = {
      ...body, id: "white-dwarf", name: "White dwarf", kind: "star", bodyType: "white-dwarf",
      massKg: 1.19304e30, radiusM: 6_371_000, positionM: [1e9, 0, 0], velocityMs: [0, 0, 0],
    };
    const settings = { gravitationalConstant: 0 };
    scope.send({ type: "SET_WORLD", bodies: [planet, compact], settings });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: planet.id } });
    const committed = scope.latest().events;
    expect(committed).toHaveLength(1);
    expect(committed?.[0]).toMatchObject({ id: 1, type: "explosion", energyJ: expect.any(Number), bodyIds: expect.arrayContaining([planet.id]) });

    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: compact.id } });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", rejectedRevision: 3 });
    expect(scope.latest().events).toEqual(committed);

    scope.send({ type: "SET_WORLD", bodies: [planet], settings });
    vi.advanceTimersByTime(50);
    expect(scope.latest().events).toEqual([]);
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: planet.id } });
    expect(scope.latest().events?.[0]?.id).toBe(2);
  });

  it("commits custom ejecta energy and rolls back invalid energy without ghost events", () => {
    const scope = createScope();
    const planet: CelestialBody = {
      ...body, bodyType: "rocky-planet", massKg: 1e20, radiusM: 1e5,
      positionM: [0, 0, 0], velocityMs: [0, 0, 0],
    };
    const settings = { gravitationalConstant: 0 };
    const specificEnergyJkg = 2e6;
    scope.send({ type: "SET_WORLD", bodies: [planet], settings });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: planet.id, specificEnergyJkg } });
    const committed = scope.latest();
    expect(Math.abs(committed.events![0]!.energyJ / (planet.massKg * specificEnergyJkg) - 1)).toBeLessThan(1e-12);

    scope.send({ type: "MUTATE_WORLD", mutation: {
      type: "EXPLODE_BODY", bodyId: planet.id,
      specificEnergyJkg: MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG * 2,
    } });
    expect(scope.messages.at(-1)).toMatchObject({
      type: "ERROR", rejectedRevision: 3,
      snapshot: { bodies: committed.bodies, events: committed.events },
    });

    const tooFast = { ...planet, velocityMs: [1e7 - 100, 0, 0] as const };
    scope.send({ type: "SET_WORLD", bodies: [tooFast], settings });
    scope.send({ type: "MUTATE_WORLD", mutation: { type: "EXPLODE_BODY", bodyId: tooFast.id, specificEnergyJkg: 1e6 } });
    expect(scope.messages.at(-1)).toMatchObject({
      type: "ERROR", rejectedRevision: 5,
      snapshot: { bodies: [tooFast], events: [] },
    });
  });

  it("merges swept collisions and bounds the event buffer to the latest 16 IDs", () => {
    const scope = createScope();
    const makePair = (index: number): CelestialBody[] => ["a", "b"].map((suffix, side) => ({
      ...body, id: `pair-${index}-${suffix}`, name: `Pair ${index} ${suffix}`, bodyType: "asteroid",
      massKg: 1e15, radiusM: 1_000, positionM: [index * 5_000 + (side === 0 ? -500 : 500), 0, 0], velocityMs: [0, 0, 0],
    }));
    scope.send({ type: "SET_SPEED", multiplier: 600 });
    scope.send({ type: "SET_BODIES", bodies: Array.from({ length: 17 }, (_, index) => makePair(index)).flat(), revision: 1 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(50);
    expect(scope.latest().bodies).toHaveLength(17);
    expect(scope.latest().events).toHaveLength(16);
    expect(scope.latest().events?.map(({ id }) => id)).toEqual(Array.from({ length: 16 }, (_, index) => index + 2));
  });

  it("publishes collision diagnostics only after merge commit and keeps failed contact ghost-free", () => {
    const scope = createScope();
    const makePair = (massKg: number): CelestialBody[] => [
      { ...body, id: "a", massKg, radiusM: 1, positionM: [-0.9, 0, 0], velocityMs: [0, 0, 0] },
      { ...body, id: "b", massKg, radiusM: 1, positionM: [0.9, 0, 0], velocityMs: [0, 0, 0] },
    ];
    scope.send({ type: "SET_WORLD", bodies: makePair(1e32), settings: { gravitationalConstant: 0 } });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "PAUSE" });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", snapshot: { bodies: makePair(1e32), events: [] } });

    scope.send({ type: "SET_WORLD", bodies: makePair(1), settings: { gravitationalConstant: 0 } });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(25);
    expect(scope.latest().bodies).toHaveLength(1);
    expect(scope.latest().events?.[0]).toMatchObject({
      type: "collision", collisionDiagnostics: { modelId: "perfectly-inelastic-merge-v1", relativeSpeedMps: 0,
        specificImpactEnergyJkg: 0, impactAngleRad: null },
    });
  });

  it("accepts creative collision mode and resets it on SET_WORLD", () => {
    const scope = createScope();
    scope.send({ type: "SET_COLLISION_MODE", mode: "creative" });
    expect(scope.latest().collisionMode).toBe("creative");
    scope.send({ type: "SET_WORLD", bodies: [body], settings: { gravitationalConstant: 0 } });
    vi.advanceTimersByTime(50);
    expect(scope.latest().collisionMode).toBe("scientific");
  });

  it("publishes creative fragmentation only with committed fragments in the same snapshot", () => {
    const scope = createScope();
    const pair: CelestialBody[] = [
      { ...body, id: "a", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000, positionM: [-500, 0, 0], velocityMs: [100, 0, 0] },
      { ...body, id: "b", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000, positionM: [500, 0, 0], velocityMs: [-100, 0, 0] },
    ];
    scope.send({ type: "SET_WORLD", bodies: pair, settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_COLLISION_MODE", mode: "creative" });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const snapshot = scope.latest();
    const event = snapshot.events?.find(({ type }) => type === "collision");
    expect(event?.outcome).toMatchObject({ kind: "creative-fragmentation", modelId: "creative-fragmentation-v1" });
    if (event?.outcome?.kind !== "creative-fragmentation") throw new Error("Expected creative fragmentation");
    expect(event.outcome.fragmentBodyIds).toHaveLength(6);
    expect(snapshot.bodies.map(({ id }) => id)).toEqual(expect.arrayContaining(event.outcome.fragmentBodyIds));
    expect(snapshot.collisionMode).toBe("creative");
    const saved = decodeSimulation(encodeSimulation(snapshot.bodies, { gravitationalConstant: 0 }));
    expect(saved.bodies.map(({ id }) => id)).toEqual(snapshot.bodies.map(({ id }) => id));
  });

  it("commits creative black-hole capture and publishes its event after the accepted body state", () => {
    const scope = createScope();
    const blackHole: CelestialBody = { id: "bh", name: "BH", kind: "star", bodyType: "black-hole", massKg: 1e20,
      radiusM: 2 * 6.6743e-11 * 1e20 / 299_792_458 ** 2, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 };
    const rock: CelestialBody = { ...body, id: "rock", bodyType: "asteroid", massKg: 1e10, radiusM: 1,
      positionM: [1_000, 0, 0], velocityMs: [-9e6, 0, 0] };
    scope.send({ type: "SET_WORLD", bodies: [blackHole, rock], settings: { gravitationalConstant: 6.6743e-11 } });
    scope.send({ type: "SET_COLLISION_MODE", mode: "creative" });
    scope.send({ type: "SET_SPEED", multiplier: 1 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    const snapshot = scope.latest();
    expect(snapshot.bodies).toHaveLength(1);
    expect(snapshot.bodies[0]).toMatchObject({ id: "bh", bodyType: "black-hole", massKg: 1e20 + 1e10 });
    expect(snapshot.bodies[0]?.radiusM).toBe(2 * 6.6743e-11 * (1e20 + 1e10) / 299_792_458 ** 2);
    expect(snapshot.events?.at(-1)).toMatchObject({ type: "black-hole-capture", energyJ: 0, bodyIds: ["bh", "rock"],
      outcome: { kind: "creative-accretion", modelId: "creative-accretion-v1", captorBodyId: "bh", absorbedBodyId: "rock" } });
    expect(snapshot.collisionMode).toBe("creative");
    const saved = decodeSimulation(encodeSimulation(snapshot.bodies, { gravitationalConstant: 6.6743e-11 }));
    expect(saved.bodies).toEqual(snapshot.bodies);
  });

  it("rolls back creative capture that exceeds mass limits without publishing an event", () => {
    const scope = createScope();
    const massKg = 1e32;
    const blackHole: CelestialBody = { id: "bh", name: "BH", kind: "star", bodyType: "black-hole", massKg,
      radiusM: 2 * 6.6743e-11 * massKg / 299_792_458 ** 2, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 };
    const rock: CelestialBody = { ...body, id: "rock", bodyType: "asteroid", massKg, radiusM: 1,
      positionM: [1, 0, 0], velocityMs: [0, 0, 0] };
    scope.send({ type: "SET_WORLD", bodies: [blackHole, rock], settings: { gravitationalConstant: 0 } });
    scope.send({ type: "SET_COLLISION_MODE", mode: "creative" });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "PAUSE" });
    const failure = scope.messages.findLast((message) => message.type === "ERROR");
    expect(failure).toMatchObject({ type: "ERROR", snapshot: { status: "error", bodies: [blackHole, rock], events: [], collisionMode: "creative" } });
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT").flatMap((message) => message.snapshot.events ?? [])).toEqual([]);
  });
  it("rolls a rejected settings revision back and keeps later snapshots flowing", () => {
    const scope = createScope();
    const bridge = new BridgeWorker();
    bridge.scope = scope;
    const workerPost: (message: SimulationWorkerMessage) => void = scope.postMessage;
    scope.postMessage = (message) => {
      workerPost(message);
      bridge.receive(message);
    };
    const client = createSimulationClient(bridge as unknown as Worker);
    const snapshots: SimulationSnapshot[] = [];
    client.subscribe((snapshot) => snapshots.push(snapshot));
    const bodies = [
      { ...body, massKg: 1e32 },
      { ...body, id: "moon", massKg: 1e32, positionM: [1e7, 0, 0] as const },
    ];

    client.setWorld(bodies, { gravitationalConstant: 0 }, 1, "initial");
    client.setSpeed(100);
    client.start();
    vi.advanceTimersByTime(25);
    client.setSettings({ gravitationalConstant: 2e-12 }, 2);

    const rejection = scope.messages.at(-1);
    expect(rejection).toMatchObject({ type: "ERROR", rejectedRevision: 2 });
    expect(scope.messages.some((message) => message.type === "SNAPSHOT" && message.worldRevision === 1 && message.snapshot.integrationSamples)).toBe(false);
    expect(snapshots.at(-1)).toMatchObject({
      bodies: rejection?.type === "ERROR" ? rejection.snapshot?.bodies : undefined,
      settings: { gravitationalConstant: 0 }, worldRevision: 2, status: "running", error: expect.any(String),
    });
    client.pause();
    vi.advanceTimersByTime(50);
    const laterSnapshot = scope.messages.findLast((message) => message.type === "SNAPSHOT");
    expect(laterSnapshot).toMatchObject({ type: "SNAPSHOT", worldRevision: 2 });
    const sampledBodyIds = laterSnapshot?.type === "SNAPSHOT"
      ? laterSnapshot.snapshot.integrationSamples?.samples.flatMap((sample) => sample.bodies.map(({ id }) => id)) ?? []
      : [];
    expect(new Set(sampledBodyIds)).toEqual(new Set([body.id, "moon"]));
    client.start();
    vi.advanceTimersByTime(50);
    expect(snapshots.at(-1)).toMatchObject({
      bodies: expect.arrayContaining(bodies.map(({ id, massKg }) => expect.objectContaining({ id, massKg }))),
      settings: { gravitationalConstant: 0 }, worldRevision: 2, status: "running",
    });
    expect(snapshots.at(-1)?.error).toBeUndefined();
    client.dispose();
  });

  it("rolls back individually valid bodies rejected by combined acceleration", () => {
    const scope = createScope();
    const bridge = new BridgeWorker();
    bridge.scope = scope;
    const workerPost: (message: SimulationWorkerMessage) => void = scope.postMessage;
    scope.postMessage = (message) => {
      workerPost(message);
      bridge.receive(message);
    };
    const client = createSimulationClient(bridge as unknown as Worker);
    const snapshots: SimulationSnapshot[] = [];
    client.subscribe((snapshot) => snapshots.push(snapshot));
    const settings = { gravitationalConstant: 2e-12 };
    const acceptedBodies = [{ ...body, massKg: 1e32 }];
    const rejectedBodies = [
      ...acceptedBodies,
      { ...body, id: "moon", massKg: 1e32, positionM: [1e7, 0, 0] as const },
    ];

    client.setWorld(acceptedBodies, settings, 1, "initial");
    client.setSpeed(100);
    client.start();
    vi.advanceTimersByTime(25);
    client.setBodies(rejectedBodies, 2);

    expect(scope.messages.some((message) => message.type === "SNAPSHOT" && message.worldRevision === 1 && message.snapshot.integrationSamples)).toBe(false);
    const rejection = scope.messages.at(-1);
    expect(snapshots.at(-1)).toMatchObject({
      bodies: rejection?.type === "ERROR" ? rejection.snapshot?.bodies : undefined,
      settings, worldRevision: 2, status: "running", error: expect.any(String),
    });
    client.pause();
    vi.advanceTimersByTime(50);
    const laterSnapshot = scope.messages.findLast((message) => message.type === "SNAPSHOT");
    expect(laterSnapshot).toMatchObject({ type: "SNAPSHOT", worldRevision: 2 });
    const sampledBodyIds = laterSnapshot?.type === "SNAPSHOT"
      ? laterSnapshot.snapshot.integrationSamples?.samples.flatMap((sample) => sample.bodies.map(({ id }) => id)) ?? []
      : [];
    expect(sampledBodyIds).toContain(body.id);
    expect(sampledBodyIds).not.toContain("moon");
    client.start();
    vi.advanceTimersByTime(50);
    expect(snapshots.at(-1)).toMatchObject({
      bodies: expect.arrayContaining(acceptedBodies.map(({ id, massKg }) => expect.objectContaining({ id, massKg }))),
      settings, worldRevision: 2, status: "running",
    });
    expect(snapshots.at(-1)?.error).toBeUndefined();
    client.dispose();
  });

  it("echoes world revisions and rejects commands older than the applied revision", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", revision: 2, bodies: [body] });
    expect(scope.messages.at(-1)).toMatchObject({ type: "SNAPSHOT", worldRevision: 2 });

    scope.send({ type: "SET_BODIES", revision: 1, bodies: [{ ...body, massKg: 2e12 }] });

    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
    expect(scope.latest().bodies).toEqual([body]);
    expect(scope.messages.filter((message) => message.type === "SNAPSHOT").at(-1)).toMatchObject({ worldRevision: 2 });
  });

  it("rolls back a world rejected by full-state validation", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", revision: 1, bodies: [body] });
    scope.send({ type: "SET_SPEED", multiplier: 100 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "SET_WORLD", revision: 2, settings: { gravitationalConstant: 6.6743e-11 }, bodies: [
      body, { ...body, id: "moon", massKg: 1e32, positionM: [1, 0, 0] },
    ] });
    const rejection = scope.messages.at(-1);
    expect(rejection).toMatchObject({ type: "ERROR", worldRevision: 2 });
    expect(scope.messages.some((message) => message.type === "SNAPSHOT" && message.worldRevision === 1 && message.snapshot.integrationSamples)).toBe(false);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(50);
    const laterSnapshot = scope.messages.findLast((message) => message.type === "SNAPSHOT");
    expect(laterSnapshot).toMatchObject({ type: "SNAPSHOT", worldRevision: 2,
      snapshot: { bodies: rejection?.type === "ERROR" ? rejection.snapshot?.bodies : undefined } });
    const sampledBodyIds = laterSnapshot?.type === "SNAPSHOT"
      ? laterSnapshot.snapshot.integrationSamples?.samples.flatMap((sample) => sample.bodies.map(({ id }) => id)) ?? []
      : [];
    expect(sampledBodyIds).toContain(body.id);
    expect(sampledBodyIds).not.toContain("moon");
  });

  it("preserves simulation time when only gravitational settings change", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: [body] });
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(100);
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 1e-10 } });
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(50);
    expect(scope.latest().simulationTimeSeconds).toBe(4);
  });

  it("replaces bodies and settings atomically when separate body update would be rejected", () => {
    const scope = createScope();
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 1 } });
    scope.send({ type: "SET_BODIES", bodies: [body] });
    const importedBodies = [
      { ...body, id: "a", massKg: 1e32, positionM: [0, 0, 0] as const },
      { ...body, id: "b", massKg: 1e32, positionM: [1e7, 0, 0] as const },
    ];

    scope.send({ type: "SET_WORLD", bodies: [body, { ...body, id: "duplicate" }], settings: { gravitationalConstant: 1e-12 } });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
    vi.advanceTimersByTime(50);
    expect(scope.latest().bodies).toEqual([body]);
    scope.send({ type: "SET_BODIES", bodies: importedBodies });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
    scope.send({ type: "SET_WORLD", bodies: importedBodies, settings: { gravitationalConstant: 1e-12 } });
    vi.advanceTimersByTime(50);
    expect(scope.latest().bodies).toEqual(importedBodies);

    scope.send({ type: "SET_BODIES", bodies: importedBodies.map((candidate) => ({ ...candidate, name: `${candidate.name}!` })) });
    vi.advanceTimersByTime(50);
    expect(scope.latest().bodies[0]?.name).toBe("Earth!");
    expect(scope.messages.filter((message) => message.type === "ERROR")).toHaveLength(2);
  });

  it("applies valid body candidates and rejects unsafe candidates without replacing the world", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: [body] });
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 1 } });
    expect(scope.messages.at(-1)).toMatchObject({ type: "SNAPSHOT" });
    const validBodies = [
      { ...body, id: "a", massKg: 1e32, positionM: [-6e12, -6e12, -6e12] as const },
      { ...body, id: "b", massKg: 1e32, positionM: [6e12, 6e12, 6e12] as const },
    ];
    scope.send({ type: "SET_BODIES", bodies: validBodies });
    vi.advanceTimersByTime(50);
    expect(scope.latest().bodies).toEqual(validBodies);

    scope.send({ type: "SET_BODIES", bodies: [
      { ...validBodies[0]!, positionM: [0, 0, 0] },
      { ...validBodies[1]!, positionM: [1e9, 0, 0] },
    ] });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
    vi.advanceTimersByTime(50);
    expect(scope.latest().bodies).toEqual(validBodies);
    expect(scope.latest().status).toBe("paused");
  });

  it("rejects incompatible settings before mutating its Solar System state", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: createSolarSystem() });
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 1 } });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
    const errorsBeforeResume = scope.messages.filter((message) => message.type === "ERROR").length;
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    expect(scope.messages.filter((message) => message.type === "ERROR")).toHaveLength(errorsBeforeResume);
    expect(scope.latest().status).toBe("running");
  });

  it("rejects incompatible body candidates before replacing the current world", () => {
    const scope = createScope();
    scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant: 1 } });
    scope.send({ type: "SET_BODIES", bodies: [body] });
    const unsafeBodies = [
      { ...body, id: "a", massKg: 1e32, positionM: [0, 0, 0] as const },
      { ...body, id: "b", massKg: 1e32, positionM: [1e9, 0, 0] as const },
    ];
    scope.send({ type: "SET_BODIES", bodies: unsafeBodies });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
    scope.send({ type: "PAUSE" });
    expect(scope.latest().bodies).toEqual([body]);
  });

  it("acknowledges each accepted whole-world replacement in a rapid command burst", () => {
    const scope = createScope();
    const sentAt: number[] = [];
    const postMessage = scope.postMessage;
    scope.postMessage = (message) => {
      if (message.type === "SNAPSHOT") sentAt.push(performance.now());
      return postMessage(message);
    };
    scope.send({ type: "START" });
    for (let index = 0; index < 20; index++) {
      scope.send({ type: "PAUSE" });
      scope.send({ type: "SET_BODIES", bodies: [{ ...body, name: `Earth ${index}` }] });
    }
    expect(sentAt).toHaveLength(21);
    expect(sentAt.every((time) => time === 0)).toBe(true);
    expect(scope.latest()).toMatchObject({ bodies: [{ ...body, name: "Earth 19" }], simulationTimeSeconds: 0,
      status: "paused", events: [], collisionMode: "scientific", history: { generation: 20, actionCount: 0 }, presentationEpoch: 20 });
  });

  it("pauses without advancing and resumes without counting paused wall time", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: [body] });
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(100);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(50);
    const paused = scope.latest();
    vi.advanceTimersByTime(1000);
    expect(scope.latest()).toEqual(paused);
    expect(paused).toMatchObject({ simulationTimeSeconds: 4, status: "paused" });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(50);
    expect(scope.latest()).toMatchObject({ simulationTimeSeconds: 6, status: "running" });
  });

  it("keeps integration identical for the same simulated duration at different speeds", () => {
    const worlds = [40, 80].map((multiplier) => {
      const scope = createScope();
      scope.send({ type: "SET_BODIES", bodies: [body, { ...body, id: "moon", positionM: [100, 0, 0] }] });
      scope.send({ type: "SET_SPEED", multiplier });
      scope.send({ type: "START" });
      vi.advanceTimersByTime(multiplier === 40 ? 100 : 50);
      scope.send({ type: "PAUSE" });
      vi.advanceTimersByTime(50);
      return scope.latest();
    });
    expect(worlds[0]?.simulationTimeSeconds).toBe(4);
    expect(worlds[1]).toEqual(worlds[0]);
  });

  it("accounts for elapsed time with the old speed before a speed change", () => {
    const scope = createScope();
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(10);
    scope.send({ type: "SET_SPEED", multiplier: 80 });
    vi.advanceTimersByTime(15);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(35);
    expect(scope.latest().simulationTimeSeconds).toBeCloseTo(1.6, 12);
  });

  it("applies editable gravitational settings to the next integration step", () => {
    const worlds = [0, 1e-10].map((gravitationalConstant) => {
      const scope = createScope();
      scope.send({ type: "SET_BODIES", bodies: [
        { ...body, massKg: 1e24 },
        { ...body, id: "moon", massKg: 1e24, positionM: [1e9, 0, 0], velocityMs: [0, 0, 0] },
      ] });
      scope.send({ type: "SET_SETTINGS", settings: { gravitationalConstant } });
      scope.send({ type: "SET_SPEED", multiplier: 200 });
      scope.send({ type: "START" });
      vi.advanceTimersByTime(100);
      scope.send({ type: "PAUSE" });
      vi.advanceTimersByTime(50);
      return scope.latest();
    });
    expect(worlds[0]?.bodies[0]?.positionM[0]).toBeCloseTo(20, 8);
    expect(worlds[1]?.bodies[0]?.positionM[0]).toBeGreaterThan(worlds[0]!.bodies[0]!.positionM[0]);
  });

  it("includes elapsed time before a pause between scheduled ticks", () => {
    const scope = createScope();
    scope.send({ type: "SET_SPEED", multiplier: 200 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(10);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(40);
    expect(scope.latest()).toMatchObject({ simulationTimeSeconds: 2, status: "paused" });
  });

  it("preserves fractional elapsed time during legacy phase-space replacement", () => {
    const scope = createScope();
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(10);
    scope.send({ type: "SET_BODIES", bodies: [body] });
    vi.advanceTimersByTime(15);
    scope.send({ type: "PAUSE" });
    vi.advanceTimersByTime(35);
    expect(scope.latest()).toMatchObject({
      bodies: [{ ...body, positionM: [0.6, 0, 0] }], simulationTimeSeconds: 1, status: "paused", events: [],
      integrationSamples: { version: 1, startTimeSeconds: 0.4, endTimeSeconds: 1, samples: [{ offsetSeconds: 0.6 }] },
    });
  });

  it.each([null, {}, { type: "NOPE" }, { type: "SET_SPEED", multiplier: Infinity },
    { type: "SET_SETTINGS", settings: { gravitationalConstant: -1 } },
    { type: "SET_SPEED", multiplier: 0 }, { type: "SET_BODIES", bodies: [null] },
    { type: "SET_BODIES", bodies: [{ ...body, massKg: -1 }] }])(
    "rejects invalid commands without changing the world: %j", (command) => {
      const scope = createScope();
      scope.send({ type: "SET_BODIES", bodies: [body] });
      scope.send(command);
      expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.any(String) });
      scope.send({ type: "PAUSE" });
      expect(scope.latest()).toMatchObject({ bodies: [body], simulationTimeSeconds: 0, status: "paused", events: [], collisionMode: "scientific",
        history: { generation: 1, actionCount: 0 }, presentationEpoch: 1 });
    },
  );

  it("limits periodic snapshots to 20 per second and leaves old snapshots unchanged", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: [body] });
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    const first = scope.latest();
    scope.messages = [];
    vi.advanceTimersByTime(1000);
    expect(scope.messages).toHaveLength(20);
    expect(first.bodies[0]?.positionM).toEqual([0, 0, 0]);
    expect(scope.latest().bodies[0]?.positionM).toEqual([40, 0, 0]);
    expect(JSON.parse(JSON.stringify(scope.latest()))).toEqual(scope.latest());
  });

  it("rejects an invalid body candidate before replacing the current world", () => {
    const scope = createScope();
    scope.send({ type: "SET_BODIES", bodies: [body] });
    scope.send({ type: "SET_BODIES", bodies: [body, { ...body, id: "moon" }] });
    expect(scope.messages.at(-1)).toMatchObject({ type: "ERROR", message: expect.stringContaining("same position") });
    scope.send({ type: "SET_SPEED", multiplier: 40 });
    scope.send({ type: "START" });
    vi.advanceTimersByTime(25);
    scope.send({ type: "PAUSE" });
    expect(scope.latest()).toMatchObject({ bodies: [body], simulationTimeSeconds: 0, status: "paused" });
  });

  it("disposes timers and its command listener", () => {
    const scope = createScope();
    scope.send({ type: "START" });
    scope.send({ type: "PAUSE" });
    cleanups.at(-1)!();
    const count = scope.messages.length;
    vi.advanceTimersByTime(100);
    scope.send({ type: "PAUSE" });
    expect(scope.messages).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});
