import { SimulationError, validateBodies, validateSettings, validateSimulationState } from "./physics";
import { validateWorldMutation } from "./world-mutations";
import { isValidSimulationEvent } from "./simulation-event-validation";
import { MAX_SIMULATION_SPEED } from "./simulation-time";
import { parseOrbitalMutationPreviewResponse, parseTrajectoryPreviewResponse } from "./simulation-worker-protocol";
import { MAX_WORLD_HISTORY_ACTIONS, MAX_WORLD_HISTORY_BYTES } from "./world-history";
import { estimateIntegrationSampleBatchBytes, MAX_INTEGRATION_SAMPLE_BATCH_BYTES, MAX_INTEGRATION_SAMPLES_PER_BATCH, type CelestialBody, type CollisionMode, type IntegrationSampleBatchV1, type OrbitalMutationPreviewRequest, type OrbitalMutationPreviewResponse, type PhysicsSettings, type SimulationEvent, type SimulationSessionState, type SimulationSnapshot, type SimulationWorkerCommand, type SurfaceData, type SurfaceStateMessage, type TrajectoryPreviewRequest, type TrajectoryPreviewResponse, type WorldHistorySummary, type WorldMutation, type WorldRestoreDirection, type WorldSetOrigin } from "./types";
import { isSimulationSessionState } from "./session-state";
import { DEFAULT_ENVIRONMENT_SEED_V1, isEnvironmentSeed, LEGACY_ENVIRONMENT_SEED_V1 } from "./world-seed";
import { isValidSurfacePayload, isWithinCombinedSurfacePayloadLimit, validateSurfaceData } from "./surface-state";
import { isValidSurfaceHeatPayload } from "./surface-heat";
import { validateSwarmLedger, validateSwarmLedgerStructure } from "./swarm-model";
import type { SwarmLedger, SwarmStateMessage } from "./types";

export interface SimulationClient {
  mutateWorld(mutation: WorldMutation, revision: number, coalesceId?: string): void;
  restoreCheckpoint(checkpointId: string, direction: WorldRestoreDirection, revision: number, generation: number): void;
  start(): void;
  pause(): void;
  setTrailSampling(enabled: boolean): void;
  setStellarEvolutionRunning(running: boolean): void;
  setSpeed(multiplier: number): void;
  setCollisionMode(mode: CollisionMode, revision: number, origin?: "bootstrap"): void;
  setSettings(settings: PhysicsSettings, revision: number, coalesceId?: string): void;
  setBodies(bodies: CelestialBody[], revision: number): void;
  setWorld(bodies: CelestialBody[], settings: PhysicsSettings, revision: number, origin: WorldSetOrigin, collisionMode?: CollisionMode, session?: SimulationSessionState, environmentSeed?: number, surfaceData?: SurfaceData, swarmLedger?: SwarmLedger): void;
  requestTrajectoryPreview(request: TrajectoryPreviewRequest): boolean;
  cancelTrajectoryPreview(requestId: number): void;
  subscribeTrajectoryPreview(listener: (response: TrajectoryPreviewResponse) => void): () => void;
  requestOrbitalMutationPreview(request: OrbitalMutationPreviewRequest): boolean;
  cancelOrbitalMutationPreview(requestId: number): void;
  subscribeOrbitalMutationPreview(listener: (response: OrbitalMutationPreviewResponse) => void): () => void;
  subscribe(listener: (snapshot: SimulationSnapshot) => void): () => void;
  subscribeRevisionOutcome(listener: (outcome: SimulationRevisionOutcome) => void): () => void;
  subscribeSurfaceState(listener: (state: SurfaceStateMessage) => void): () => void;
  subscribeSwarmState(listener: (state: SwarmStateMessage) => void): () => void;
  dispose(): void;
}

export type SimulationRevisionOutcome =
  | { type: "snapshot"; worldRevision: number }
  | { type: "error"; worldRevision?: number; rejectedRevision?: number; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseIntegrationSamples(value: unknown, simulationTimeSeconds: number): IntegrationSampleBatchV1 | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1
    || !Number.isFinite(value.startTimeSeconds) || (value.startTimeSeconds as number) < 0
    || !Number.isFinite(value.endTimeSeconds) || value.endTimeSeconds !== simulationTimeSeconds
    || (value.endTimeSeconds as number) <= (value.startTimeSeconds as number)
    || !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > MAX_INTEGRATION_SAMPLES_PER_BATCH
    || (value.truncated !== undefined && typeof value.truncated !== "boolean")) return null;
  const lastSample = value.samples.at(-1);
  if (!isRecord(lastSample) || lastSample.offsetSeconds !== (value.endTimeSeconds as number) - (value.startTimeSeconds as number)) return null;
  let previousOffset = 0;
  for (const sample of value.samples) {
    if (!isRecord(sample) || !Number.isFinite(sample.offsetSeconds) || (sample.offsetSeconds as number) <= previousOffset
      || (sample.offsetSeconds as number) > (value.endTimeSeconds as number) - (value.startTimeSeconds as number)
      || !Array.isArray(sample.bodies) || sample.bodies.length > 64) return null;
    previousOffset = sample.offsetSeconds as number;
    const ids = new Set<string>();
    for (const body of sample.bodies) {
      if (!isRecord(body) || typeof body.id !== "string" || !body.id.trim() || ids.has(body.id) || !isVector3(body.positionM)) return null;
      ids.add(body.id);
    }
  }
  const batch = value as IntegrationSampleBatchV1;
  return estimateIntegrationSampleBatchBytes(batch.samples) <= MAX_INTEGRATION_SAMPLE_BATCH_BYTES ? batch : null;
}

const emptyHistory: WorldHistorySummary = { generation: 0, undoCheckpointId: null, redoCheckpointId: null, actionCount: 0, bytes: 0 };

function parseHistorySummary(value: unknown): WorldHistorySummary | null {
  if (value === undefined) return { ...emptyHistory };
  if (!isRecord(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
    || !Number.isSafeInteger(value.actionCount) || (value.actionCount as number) < 0 || (value.actionCount as number) > MAX_WORLD_HISTORY_ACTIONS
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 || (value.bytes as number) > MAX_WORLD_HISTORY_BYTES
    || !(value.undoCheckpointId === null || typeof value.undoCheckpointId === "string" && value.undoCheckpointId.length > 0 && value.undoCheckpointId.length <= 128)
    || !(value.redoCheckpointId === null || typeof value.redoCheckpointId === "string" && value.redoCheckpointId.length > 0 && value.redoCheckpointId.length <= 128)) return null;
  if ((value.actionCount === 0) !== (value.undoCheckpointId === null && value.redoCheckpointId === null)) return null;
  if ((value.actionCount as number) > 0 && (value.undoCheckpointId === null && value.redoCheckpointId === null)) return null;
  if ((value.actionCount as number) > 0 && (value.bytes as number) === 0) return null;
  return value as WorldHistorySummary;
}

function parseSnapshot(value: unknown): SimulationSnapshot | null {
  const environmentSeed = isRecord(value) && value.environmentSeed !== undefined ? value.environmentSeed : LEGACY_ENVIRONMENT_SEED_V1;
  if (!isRecord(value) || !Array.isArray(value.bodies)
    || !Number.isFinite(value.simulationTimeSeconds) || (value.simulationTimeSeconds as number) < 0
    || !["running", "paused", "error"].includes(value.status as string)
    || !isEnvironmentSeed(environmentSeed)
    || (value.error !== undefined && typeof value.error !== "string")
    || (value.stellarEvolutionRunning !== undefined && typeof value.stellarEvolutionRunning !== "boolean")
    || (value.speedLimited !== undefined && typeof value.speedLimited !== "boolean")
    || (value.events !== undefined && (!Array.isArray(value.events) || value.events.length > 16
      || value.events.some((event) => !isValidSimulationEvent(event))))) return null;

  const history = parseHistorySummary(value.history);
  if (!history || (value.presentationEpoch !== undefined
    && (!Number.isSafeInteger(value.presentationEpoch) || (value.presentationEpoch as number) < 0))) return null;

  const integrationSamples = parseIntegrationSamples(value.integrationSamples, value.simulationTimeSeconds as number);
  if (integrationSamples === null) return null;

  try {
    validateBodies(value.bodies as CelestialBody[]);
    if (value.settings !== undefined) validateSimulationState(value.bodies as CelestialBody[], value.settings as PhysicsSettings);
    if (value.swarmLedger !== undefined) validateSwarmLedger(value.swarmLedger, value.bodies as CelestialBody[]);
  } catch {
    return null;
  }
  const collisionMode = value.collisionMode === undefined ? "scientific" : value.collisionMode;
  if (collisionMode !== "scientific" && collisionMode !== "creative") return null;
  return { ...value, environmentSeed, collisionMode, speedLimited: value.speedLimited === true, history,
    presentationEpoch: value.presentationEpoch === undefined ? 0 : value.presentationEpoch as number,
    ...(integrationSamples ? { integrationSamples } : {}) } as SimulationSnapshot;
}

function freezeSwarmLedger(ledger: SwarmLedger): SwarmLedger {
  for (const group of ledger.groups) Object.freeze(group);
  Object.freeze(ledger.groups);
  for (const shares of Object.values(ledger.bodyMassShares)) {
    for (const share of shares) Object.freeze(share);
    Object.freeze(shares);
  }
  Object.freeze(ledger.bodyMassShares);
  return Object.freeze(ledger);
}

function isVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function createSimulationClient(worker: Worker): SimulationClient {
  const listeners = new Set<(snapshot: SimulationSnapshot) => void>();
  const revisionOutcomeListeners = new Set<(outcome: SimulationRevisionOutcome) => void>();
  const surfaceStateListeners = new Set<(state: SurfaceStateMessage) => void>();
  const swarmStateListeners = new Set<(state: SwarmStateMessage) => void>();
  const trajectoryPreviewListeners = new Set<(response: TrajectoryPreviewResponse) => void>();
  const pendingTrajectoryPreviews = new Map<number, Omit<TrajectoryPreviewRequest, "candidate">>();
  const orbitalMutationPreviewListeners = new Set<(response: OrbitalMutationPreviewResponse) => void>();
  const pendingOrbitalMutationPreviews = new Map<number, Pick<OrbitalMutationPreviewRequest, "requestId" | "worldRevision" | "baseTimeSeconds">>();
  let snapshot: SimulationSnapshot = { bodies: [], environmentSeed: LEGACY_ENVIRONMENT_SEED_V1, simulationTimeSeconds: 0, status: "paused", collisionMode: "scientific", history: emptyHistory, presentationEpoch: 0 };
  let latestRevision = 0;
  let latestSurfaceStateRevision = -1;
  let latestSwarmStateRevision = -1;
  let acceptedSwarmLedger: SwarmLedger | undefined;
  let latestTrajectoryPreviewRequestId = 0;
  let latestOrbitalMutationPreviewRequestId = 0;
  let disposed = false;

  const emitRevisionOutcome = (outcome: SimulationRevisionOutcome) => {
    const frozenOutcome = Object.freeze({ ...outcome });
    const listenersAtReceipt = [...revisionOutcomeListeners];
    queueMicrotask(() => {
      for (const listener of listenersAtReceipt) {
        if (disposed || !revisionOutcomeListeners.has(listener)) continue;
        try { listener(frozenOutcome); } catch { /* Revision observers cannot affect snapshot acceptance. */ }
      }
    });
  };

  const publish = (next: SimulationSnapshot) => {
    for (const body of next.bodies) {
      Object.freeze(body.positionM);
      Object.freeze(body.velocityMs);
      if (body.waterInventory) Object.freeze(body.waterInventory);
      Object.freeze(body);
    }
    Object.freeze(next.bodies);
    if (next.swarmLedger) freezeSwarmLedger(next.swarmLedger);
    for (const event of next.events ?? []) {
      Object.freeze(event.positionM);
      Object.freeze(event.bodyIds);
      if (event.contact) {
        Object.freeze(event.contact.pointM);
        if (event.contact.normalM) Object.freeze(event.contact.normalM);
        Object.freeze(event.contact.relativeVelocityMs);
        Object.freeze(event.contact);
      }
      if (event.impulse) {
        Object.freeze(event.impulse.deltaVelocityMs);
        Object.freeze(event.impulse.impulseNs);
        Object.freeze(event.impulse);
      }
    if (event.laser) {
      Object.freeze(event.laser.bodyLocalDirection);
      Object.freeze(event.laser);
    }
      if (event.collisionDiagnostics) Object.freeze(event.collisionDiagnostics);
      if (event.energyLedger) {
        Object.freeze(event.energyLedger.sources);
        Object.freeze(event.energyLedger.allocations);
        Object.freeze(event.energyLedger);
      }
      if (event.outcome && "fragmentBodyIds" in event.outcome) Object.freeze(event.outcome.fragmentBodyIds);
      if (event.outcome) Object.freeze(event.outcome);
      Object.freeze(event as SimulationEvent);
    }
    if (next.events) Object.freeze(next.events);
    if (next.history) Object.freeze(next.history);
    if (next.integrationSamples) {
      for (const sample of next.integrationSamples.samples) {
        for (const body of sample.bodies) {
          Object.freeze(body.positionM);
          Object.freeze(body);
        }
        Object.freeze(sample.bodies);
        Object.freeze(sample);
      }
      Object.freeze(next.integrationSamples.samples);
      Object.freeze(next.integrationSamples);
    }
    snapshot = Object.freeze(next);
    const acceptedRevision = snapshot.worldRevision ?? 0;
    for (const [requestId, request] of pendingTrajectoryPreviews) {
      if (request.worldRevision !== acceptedRevision || request.baseTimeSeconds !== snapshot.simulationTimeSeconds
        || request.collisionMode !== snapshot.collisionMode || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) {
        pendingTrajectoryPreviews.delete(requestId);
      }
    }
    for (const [requestId, request] of pendingOrbitalMutationPreviews) {
      if (request.worldRevision !== acceptedRevision || request.baseTimeSeconds !== snapshot.simulationTimeSeconds
        || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) pendingOrbitalMutationPreviews.delete(requestId);
    }
    for (const listener of listeners) listener(snapshot);
  };
  const publishError = (message: string, worldRevision = latestRevision) => publish({ ...snapshot, status: "error", error: message, worldRevision });
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isRecord(event.data)) {
      publishError("Worker sent an invalid message.");
    } else if (event.data.type === "SWARM_STATE") {
      if (Object.keys(event.data).length !== 3 || !Number.isSafeInteger(event.data.worldRevision)
        || (event.data.worldRevision as number) < 1 || (event.data.worldRevision as number) < latestSwarmStateRevision
        || (event.data.worldRevision as number) > latestRevision) return;
      try {
        validateSwarmLedgerStructure(event.data.swarmLedger);
        const state = event.data as unknown as SwarmStateMessage;
        acceptedSwarmLedger = freezeSwarmLedger(structuredClone(state.swarmLedger));
        latestSwarmStateRevision = state.worldRevision;
        if ((snapshot.worldRevision ?? -1) === state.worldRevision) {
          validateSwarmLedger(state.swarmLedger, snapshot.bodies);
          publish({ ...snapshot, swarmLedger: acceptedSwarmLedger });
        }
        for (const listener of swarmStateListeners) listener(state);
      } catch { return; }
    } else if (event.data.type === "SURFACE_STATE") {
      if (Object.keys(event.data).length !== 4 || !Number.isSafeInteger(event.data.worldRevision)
        || (event.data.worldRevision as number) < 1 || (event.data.worldRevision as number) > latestRevision
        || (event.data.worldRevision as number) < latestSurfaceStateRevision || !isValidSurfacePayload(event.data.surfaceData)
        || !isValidSurfaceHeatPayload(event.data.surfaceHeatData)
        || !isWithinCombinedSurfacePayloadLimit(event.data.surfaceData, event.data.surfaceHeatData)) return;
      const surfaceState = event.data as unknown as SurfaceStateMessage;
      for (const patches of Object.values(surfaceState.surfaceData)) {
        for (const patch of patches) Object.freeze(patch);
        Object.freeze(patches);
      }
      for (const patches of Object.values(surfaceState.surfaceHeatData)) {
        for (const patch of patches) Object.freeze(patch);
        Object.freeze(patches);
      }
      Object.freeze(surfaceState.surfaceData);
      Object.freeze(surfaceState.surfaceHeatData);
      Object.freeze(surfaceState);
      latestSurfaceStateRevision = surfaceState.worldRevision;
      for (const listener of surfaceStateListeners) listener(surfaceState);
    } else if (event.data.type === "TRAJECTORY_PREVIEW") {
      const response = parseTrajectoryPreviewResponse(event.data);
      if (!response) return;
      const request = pendingTrajectoryPreviews.get(response.requestId);
      if (!request) return;
      pendingTrajectoryPreviews.delete(response.requestId);
      const acceptedRevision = snapshot.worldRevision ?? 0;
      if (response.worldRevision !== request.worldRevision || response.baseTimeSeconds !== request.baseTimeSeconds
        || response.collisionMode !== request.collisionMode || response.worldRevision !== acceptedRevision
        || latestRevision > acceptedRevision || snapshot.simulationTimeSeconds !== response.baseTimeSeconds
        || snapshot.collisionMode !== response.collisionMode || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) return;
      const preview = response.preview;
      if (preview) {
        preview.points.forEach((point) => Object.freeze(point));
        Object.freeze(preview.points);
        if (preview.contact) {
          Object.freeze(preview.contact.positionM);
          Object.freeze(preview.contact.bodyIds);
          Object.freeze(preview.contact);
        }
        Object.freeze(preview);
      }
      Object.freeze(response);
      for (const listener of trajectoryPreviewListeners) listener(response);
    } else if (event.data.type === "ORBITAL_MUTATION_PREVIEW") {
      const response = parseOrbitalMutationPreviewResponse(event.data);
      if (!response) return;
      const request = pendingOrbitalMutationPreviews.get(response.requestId);
      if (!request) return;
      pendingOrbitalMutationPreviews.delete(response.requestId);
      const acceptedRevision = snapshot.worldRevision ?? 0;
      if (response.worldRevision !== request.worldRevision || response.baseTimeSeconds !== request.baseTimeSeconds
        || response.worldRevision !== acceptedRevision || latestRevision > acceptedRevision
        || snapshot.simulationTimeSeconds !== response.baseTimeSeconds || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) return;
      if (response.result?.status === "ready") {
        for (const candidate of response.result.candidates) {
          Object.freeze(candidate.positionM);
          Object.freeze(candidate.velocityMs);
          Object.freeze(candidate);
        }
        Object.freeze(response.result.candidates);
      }
      if (response.result) Object.freeze(response.result);
      Object.freeze(response);
      for (const listener of orbitalMutationPreviewListeners) listener(response);
    } else if (event.data.type === "SNAPSHOT") {
      if (!Number.isSafeInteger(event.data.worldRevision) || (event.data.worldRevision as number) > latestRevision) return;
      const revision = event.data.worldRevision as number;
      const next = parseSnapshot(event.data.snapshot);
      if (!next) {
        publishError("Worker sent an invalid simulation snapshot.");
        return;
      }
      let candidate: SimulationSnapshot;
      try {
        if (isRecord(event.data.settings)) validateSimulationState(next.bodies, event.data.settings as PhysicsSettings);
        const swarmLedger = next.swarmLedger ?? (latestSwarmStateRevision === revision ? acceptedSwarmLedger : undefined);
        if (swarmLedger) validateSwarmLedger(swarmLedger, next.bodies);
        candidate = { ...next, ...(swarmLedger ? { swarmLedger } : {}),
          ...(isRecord(event.data.settings) ? { settings: event.data.settings as PhysicsSettings } : {}), worldRevision: revision };
      } catch {
        publishError("Worker sent invalid simulation settings.");
        return;
      }
      const rawSnapshot = isRecord(event.data.snapshot) ? event.data.snapshot : undefined;
      const hasErrorPayload = rawSnapshot?.error !== undefined;
      const hasRejectedRevisionPayload = rawSnapshot && Object.hasOwn(rawSnapshot, "rejectedRevision");
      if (hasErrorPayload || hasRejectedRevisionPayload) {
        const rejectedRevision = Number.isSafeInteger(rawSnapshot?.rejectedRevision)
          ? rawSnapshot.rejectedRevision as number : undefined;
        if (rejectedRevision !== undefined) {
          emitRevisionOutcome({ type: "error", worldRevision: revision, rejectedRevision,
            message: typeof rawSnapshot?.error === "string" ? rawSnapshot.error : "Worker rejected the world mutation." });
        }
        return;
      }
      emitRevisionOutcome({ type: "snapshot", worldRevision: revision });
      if (revision < latestRevision) return;
      publish(candidate);
    } else if (event.data.type === "ERROR") {
      const worldRevision = Number.isSafeInteger(event.data.worldRevision) ? event.data.worldRevision as number : undefined;
      const rejectedRevision = Number.isSafeInteger(event.data.rejectedRevision) ? event.data.rejectedRevision as number : undefined;
      if ((worldRevision !== undefined && worldRevision > latestRevision)
        || (rejectedRevision !== undefined && rejectedRevision > latestRevision)) return;
      emitRevisionOutcome({ type: "error", ...(worldRevision === undefined ? {} : { worldRevision }),
        ...(rejectedRevision === undefined ? {} : { rejectedRevision }),
        message: typeof event.data.message === "string" ? event.data.message : "Worker sent an invalid message." });
      if (typeof event.data.message !== "string") {
        publishError("Worker sent an invalid message.");
        return;
      }
      const revision = Number.isSafeInteger(event.data.worldRevision) ? event.data.worldRevision as number : latestRevision;
      if (revision >= latestRevision) {
        const state = parseSnapshot(event.data.snapshot);
        if (state && (!Number.isSafeInteger(event.data.rejectedRevision) || revision === event.data.rejectedRevision)) {
          latestRevision = revision;
          const swarmLedger = state.swarmLedger ?? (latestSwarmStateRevision === revision ? acceptedSwarmLedger : undefined);
          if (swarmLedger) validateSwarmLedger(swarmLedger, state.bodies);
          publish({ ...state, ...(swarmLedger ? { swarmLedger } : {}), worldRevision: revision, error: event.data.message });
        } else if (Number.isSafeInteger(event.data.rejectedRevision)) {
          publishError("Worker sent an invalid rollback snapshot.");
        } else {
          publishError(event.data.message, revision);
        }
      }
    } else {
      publishError("Worker sent an invalid message.");
    }
  };
  const onError = (event: ErrorEvent) => publishError(event.message || "Simulation worker failed.");
  const onMessageError = () => publishError("Simulation worker message could not be deserialized.");
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);

  const post = (message: SimulationWorkerCommand) => {
    if (disposed) return;
    try {
      worker.postMessage(message);
    } catch (error) {
      publishError(error instanceof Error ? error.message : "Simulation worker message could not be sent.");
    }
  };

  return {
    mutateWorld(mutation, revision, coalesceId) {
      validateWorldMutation(mutation);
      if (!Number.isSafeInteger(revision) || revision <= latestRevision) throw new SimulationError("INVALID_SETTINGS", "World revision must increase.");
      if (coalesceId !== undefined && (typeof coalesceId !== "string" || !coalesceId.trim() || coalesceId.length > 128)) throw new SimulationError("INVALID_SETTINGS", "History coalescing id is invalid.");
      latestRevision = revision;
      post({ type: "MUTATE_WORLD", mutation, revision, ...(coalesceId === undefined ? {} : { history: { coalesceId } }) });
    },
    restoreCheckpoint(checkpointId, direction, revision, generation) {
      if (typeof checkpointId !== "string" || !checkpointId.trim() || checkpointId.length > 128
        || (direction !== "undo" && direction !== "redo") || !Number.isSafeInteger(generation) || generation < 0
        || !Number.isSafeInteger(revision) || revision <= latestRevision) throw new SimulationError("INVALID_SETTINGS", "Checkpoint restore request is invalid.");
      latestRevision = revision;
      post({ type: "RESTORE_CHECKPOINT", checkpointId, direction, revision, generation });
    },
    start: () => post({ type: "START" }),
    pause: () => post({ type: "PAUSE" }),
    setTrailSampling: (enabled) => post({ type: "SET_TRAIL_SAMPLING", enabled }),
    setStellarEvolutionRunning: (running) => post({ type: "SET_STELLAR_EVOLUTION_RUNNING", running }),
    setSpeed(multiplier) {
      if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > MAX_SIMULATION_SPEED) {
        throw new SimulationError("INVALID_SETTINGS", `Simulation speed must be finite and in (0, ${MAX_SIMULATION_SPEED}].`);
      }
      post({ type: "SET_SPEED", multiplier });
    },
    setCollisionMode(mode, revision, origin) {
      if (mode !== "scientific" && mode !== "creative") throw new SimulationError("INVALID_SETTINGS", "Collision mode is invalid.");
      if (!Number.isSafeInteger(revision) || revision <= latestRevision) throw new SimulationError("INVALID_SETTINGS", "World revision must increase.");
      if (origin !== undefined && origin !== "bootstrap") throw new SimulationError("INVALID_SETTINGS", "Collision mode origin is invalid.");
      latestRevision = revision;
      post({ type: "SET_COLLISION_MODE", mode, revision, ...(origin === undefined ? {} : { origin }) });
    },
    setSettings(settings, revision, coalesceId) {
      validateSettings(settings);
      if (!Number.isSafeInteger(revision) || revision <= latestRevision) throw new SimulationError("INVALID_SETTINGS", "World revision must increase.");
      if (coalesceId !== undefined && (typeof coalesceId !== "string" || !coalesceId.trim() || coalesceId.length > 128)) throw new SimulationError("INVALID_SETTINGS", "History coalescing id is invalid.");
      latestRevision = revision;
      post({ type: "SET_SETTINGS", settings, revision, ...(coalesceId === undefined ? {} : { coalesceId }) });
    },
    setBodies(bodies, revision) {
      validateBodies(bodies);
      if (!Number.isSafeInteger(revision) || revision <= latestRevision) throw new SimulationError("INVALID_SETTINGS", "World revision must increase.");
      latestRevision = revision;
      post({ type: "SET_BODIES", bodies, revision });
    },
    setWorld(bodies, settings, revision, origin, collisionMode, session, environmentSeed = DEFAULT_ENVIRONMENT_SEED_V1, surfaceData, swarmLedger) {
      validateSimulationState(bodies, settings);
      if (!isEnvironmentSeed(environmentSeed)) throw new SimulationError("INVALID_SETTINGS", "Environment seed must be an unsigned 32-bit integer.");
      if (!Number.isSafeInteger(revision) || revision <= latestRevision) throw new SimulationError("INVALID_SETTINGS", "World revision must increase.");
      if (!["experiment", "reset", "import", "initial"].includes(origin)
        || collisionMode !== undefined && ((origin !== "experiment") || collisionMode !== "scientific" && collisionMode !== "creative")
        || session !== undefined && (origin !== "import" || !isSimulationSessionState(session))) {
        throw new SimulationError("INVALID_SETTINGS", "World replacement origin is invalid.");
      }
      const surfaceMetadata = bodies.flatMap(({ surface }) => surface ? [surface] : []);
      if (surfaceData !== undefined || surfaceMetadata.length > 0) validateSurfaceData(surfaceData ?? {}, surfaceMetadata);
      if (swarmLedger !== undefined) validateSwarmLedger(swarmLedger, bodies);
      latestRevision = revision;
      latestSwarmStateRevision = -1;
      acceptedSwarmLedger = undefined;
      post({ type: "SET_WORLD", origin, bodies, settings, environmentSeed, ...(surfaceData === undefined ? {} : { surfaceData }), ...(swarmLedger === undefined ? {} : { swarmLedger }), ...(collisionMode === undefined ? {} : { collisionMode }), ...(session === undefined ? {} : { session }), revision });
    },
    requestTrajectoryPreview(request) {
      if (disposed || !Number.isSafeInteger(request.requestId) || request.requestId < 1
        || !Number.isSafeInteger(request.worldRevision) || request.worldRevision < 0
        || !Number.isFinite(request.baseTimeSeconds) || request.baseTimeSeconds < 0
        || (request.collisionMode !== "scientific" && request.collisionMode !== "creative")
        || request.requestId <= latestTrajectoryPreviewRequestId || pendingTrajectoryPreviews.has(request.requestId) || snapshot.worldRevision === undefined
        || request.worldRevision !== snapshot.worldRevision || latestRevision > snapshot.worldRevision
        || request.baseTimeSeconds !== snapshot.simulationTimeSeconds || request.collisionMode !== snapshot.collisionMode
        || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) return false;
      try { validateBodies([...snapshot.bodies, request.candidate]); } catch { return false; }
      pendingTrajectoryPreviews.clear();
      pendingTrajectoryPreviews.set(request.requestId, {
        requestId: request.requestId,
        worldRevision: request.worldRevision,
        baseTimeSeconds: request.baseTimeSeconds,
        collisionMode: request.collisionMode,
      });
      try {
        worker.postMessage({ type: "PREVIEW_TRAJECTORY", ...request });
        latestTrajectoryPreviewRequestId = request.requestId;
        return true;
      } catch {
        pendingTrajectoryPreviews.delete(request.requestId);
        return false;
      }
    },
    cancelTrajectoryPreview(requestId) {
      pendingTrajectoryPreviews.delete(requestId);
    },
    subscribeTrajectoryPreview(listener) {
      if (disposed) return () => {};
      trajectoryPreviewListeners.add(listener);
      return () => trajectoryPreviewListeners.delete(listener);
    },
    requestOrbitalMutationPreview(request) {
      if (disposed || request.type !== "PREVIEW_ORBITAL_MUTATION" || request.version !== 1
        || !Number.isSafeInteger(request.requestId) || request.requestId < 1
        || !Number.isSafeInteger(request.worldRevision) || request.worldRevision < 0
        || !Number.isFinite(request.baseTimeSeconds) || request.baseTimeSeconds < 0
        || request.requestId <= latestOrbitalMutationPreviewRequestId || pendingOrbitalMutationPreviews.has(request.requestId)
        || snapshot.worldRevision === undefined || request.worldRevision !== snapshot.worldRevision || latestRevision > snapshot.worldRevision
        || request.baseTimeSeconds !== snapshot.simulationTimeSeconds || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) return false;
      try { validateWorldMutation(request.mutation); } catch { return false; }
      if (!["CREATE_ORBITAL_BODY", "SET_ORBITAL_PAIR", "CREATE_ORBITAL_RING"].includes(request.mutation.type)) return false;
      pendingOrbitalMutationPreviews.clear();
      pendingOrbitalMutationPreviews.set(request.requestId, { requestId: request.requestId,
        worldRevision: request.worldRevision, baseTimeSeconds: request.baseTimeSeconds });
      try {
        worker.postMessage(request);
        latestOrbitalMutationPreviewRequestId = request.requestId;
        return true;
      } catch {
        pendingOrbitalMutationPreviews.delete(request.requestId);
        return false;
      }
    },
    cancelOrbitalMutationPreview(requestId) {
      pendingOrbitalMutationPreviews.delete(requestId);
    },
    subscribeOrbitalMutationPreview(listener) {
      if (disposed) return () => {};
      orbitalMutationPreviewListeners.add(listener);
      return () => orbitalMutationPreviewListeners.delete(listener);
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeRevisionOutcome(listener) {
      if (disposed) return () => {};
      revisionOutcomeListeners.add(listener);
      return () => revisionOutcomeListeners.delete(listener);
    },
    subscribeSurfaceState(listener) {
      if (disposed) return () => {};
      surfaceStateListeners.add(listener);
      return () => surfaceStateListeners.delete(listener);
    },
    subscribeSwarmState(listener) {
      if (disposed) return () => {};
      swarmStateListeners.add(listener);
      return () => swarmStateListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      revisionOutcomeListeners.clear();
      surfaceStateListeners.clear();
      swarmStateListeners.clear();
      trajectoryPreviewListeners.clear();
      pendingTrajectoryPreviews.clear();
      orbitalMutationPreviewListeners.clear();
      pendingOrbitalMutationPreviews.clear();
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      worker.terminate();
    },
  };
}
