import { applyWorldMutation } from "./world-mutations";
import { validateSimulationState } from "./physics";
import { advanceSimulationInterval, simulationSpeedLimitMessage } from "./simulation-time";
import { hasSolarEvolutionProfile, checkSolarEvolutionEligibility, SOLAR_EVOLUTION_END_AGE_YEARS } from "./stellar-evolution";
import { IntegrationSampleBuffer } from "./integration-sample-buffer";
import { createOrbitalMutationPreviewResponse, createTrajectoryPreviewResponse, parseOrbitalMutationPreviewRequest, parseSimulationWorkerCommand, parseTrajectoryPreviewRequest } from "./simulation-worker-protocol";
import { createWorldHistory, recordWorldHistoryAction, restoreWorldHistoryCheckpoint, startNewWorldHistoryGeneration, summarizeWorldHistory, type WorldHistory, type WorldHistoryState } from "./world-history";
import { SimulationError, batchSimulationEvents, MAX_SIMULATION_EVENTS_PER_SNAPSHOT, type CelestialBody, type PhysicsSettings, type SimulationEvent, type SimulationSnapshot, type SimulationWorkerMessage } from "./types";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "./world-seed";
import { validateSurfaceData } from "./surface-state";
import { validateSurfaceHeatData } from "./surface-heat";
import { createEmptySwarmLedger, reconcileSwarmLedger, validateSwarmLedger } from "./swarm-model";
import type { SurfaceData, SurfaceHeatData, SurfaceMetadata, SwarmLedger } from "./types";

const GRAVITATIONAL_CONSTANT = 6.6743e-11;
const TICK_INTERVAL_MS = 25;
const SNAPSHOT_INTERVAL_MS = 50;
const SOLAR_EVOLUTION_YEARS_PER_REAL_SECOND = 100_000_000;
const MAX_SOLAR_EVOLUTION_TICK_MS = TICK_INTERVAL_MS * 2;
type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: SimulationWorkerMessage): void;
};

export function installSimulationWorker(scope: WorkerScope): () => void {
  let settings: PhysicsSettings = { gravitationalConstant: GRAVITATIONAL_CONSTANT };
  let environmentSeed = DEFAULT_ENVIRONMENT_SEED_V1;
  let surfaceData: SurfaceData = {};
  let surfaceHeatData: SurfaceHeatData = {};
  let swarmLedger: SwarmLedger = createEmptySwarmLedger();
  let swarmStateDirty = true;
  let swarmStateRevision = -1;
  let surfaceStateDirty = false;
  let bodies: CelestialBody[] = [];
  let status: SimulationSnapshot["status"] = "paused";
  let speedLimited = false;
  let stellarEvolutionRunning = false, trailSamplingEnabled = true;
  let collisionMode: SimulationSnapshot["collisionMode"] = "scientific";
  let simulationTimeSeconds = 0;
  let speedMultiplier = 1;
  let worldRevision = 0;
  let history: WorldHistory = createWorldHistory();
  let presentationEpoch = 0;
  let events: SimulationEvent[] = [];
  const integrationSampleBuffer = new IntegrationSampleBuffer();
  let nextEventId = 1;
  let accumulatedSeconds = 0;
  let lastEvolutionTick = 0;
  let lastTick = 0;
  let lastSnapshot = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (message: SimulationWorkerMessage) => scope.postMessage(message);
  const snapshotState = (revision = worldRevision): SimulationSnapshot => ({ bodies, settings, environmentSeed, swarmLedger, simulationTimeSeconds, status, worldRevision: revision, events, collisionMode,
    history: summarizeWorldHistory(history), presentationEpoch, ...(speedLimited ? { speedLimited: true } : {}), ...(stellarEvolutionRunning ? { stellarEvolutionRunning: true } : {}) });
  const currentHistoryState = (): WorldHistoryState => ({ bodies, settings, environmentSeed, simulationTimeSeconds, collisionMode, surfaceData, swarmLedger });
  const surfaceMetadata = (worldBodies: readonly CelestialBody[]): SurfaceMetadata[] => worldBodies.flatMap(({ surface }) => surface ? [surface] : []);
  const surfaceDataForBodies = (worldBodies: readonly CelestialBody[]): { data: SurfaceData; changed: boolean } => {
    const ids = new Set(surfaceMetadata(worldBodies).map(({ dataId }) => dataId));
    const currentIds = Object.keys(surfaceData);
    if (currentIds.length === ids.size && currentIds.every((id) => ids.has(id))) return { data: surfaceData, changed: false };
    const data = Object.fromEntries(currentIds.filter((id) => ids.has(id)).map((id) => [id, surfaceData[id]!]));
    validateSurfaceData(data, surfaceMetadata(worldBodies));
    return { data, changed: true };
  };
  const surfaceHeatDataForBodies = (worldBodies: readonly CelestialBody[], clear = false): { data: SurfaceHeatData; changed: boolean } => {
    const ids = [...new Set(surfaceMetadata(worldBodies).map(({ dataId }) => dataId))];
    const currentIds = Object.keys(surfaceHeatData);
    if (!clear && currentIds.length === ids.length && currentIds.every((id) => ids.includes(id))) return { data: surfaceHeatData, changed: false };
    const data = Object.fromEntries(ids.map((id) => [id, clear ? [] : surfaceHeatData[id] ?? []]));
    validateSurfaceHeatData(data, ids);
    return { data, changed: true };
  };
  const sendSurfaceState = () => {
    send({ type: "SURFACE_STATE", worldRevision, surfaceData: structuredClone(surfaceData), surfaceHeatData: structuredClone(surfaceHeatData) });
    surfaceStateDirty = false;
  };
  const sendSwarmState = () => {
    if (!swarmStateDirty && swarmStateRevision === worldRevision) return;
    send({ type: "SWARM_STATE", worldRevision, swarmLedger: structuredClone(swarmLedger) });
    swarmStateDirty = false;
    swarmStateRevision = worldRevision;
  };
  const recordAction = (before: WorldHistoryState, after: WorldHistoryState, coalesceId?: string): WorldHistory => {
    const result = recordWorldHistoryAction(history, before, after, coalesceId);
    if (!result.ok) throw new Error(result.reason === "checkpoint-too-large"
      ? "A ação excede o limite de memória do histórico e foi rejeitada."
      : "O agrupamento de histórico é inválido.");
    return result.history;
  };
  const publishEvent = (event: Omit<SimulationEvent, "id" | "timeSeconds">, timeSeconds: number): SimulationEvent => {
    const published = { ...event, id: nextEventId++, timeSeconds };
    events = [...events, published].slice(-MAX_SIMULATION_EVENTS_PER_SNAPSHOT);
    return published;
  };
  const sendError = (message: string, revision = worldRevision) => {
    sendSwarmState();
    send({ type: "ERROR", message, worldRevision: revision, snapshot: snapshotState(revision) });
  };
  const rejectWorld = (message: string, revision: number) => {
    worldRevision = revision;
    sendSwarmState();
    send({ type: "ERROR", message, worldRevision, rejectedRevision: revision,
      snapshot: snapshotState(worldRevision) });
  };
  const cancelPendingSnapshot = () => {
    if (snapshotTimer !== undefined) clearTimeout(snapshotTimer);
    snapshotTimer = undefined;
  };
  const sendSnapshot = (force = false, eventBatches?: readonly SimulationEvent[][]): void => {
    const remaining = SNAPSHOT_INTERVAL_MS - (performance.now() - lastSnapshot);
    if (remaining > 0 && !force) {
      if (snapshotTimer === undefined) snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        if (timer !== undefined) tick();
        else sendSnapshot();
      }, remaining);
      return;
    }
    cancelPendingSnapshot();
    if (surfaceStateDirty) sendSurfaceState();
    if (swarmStateDirty || swarmStateRevision !== worldRevision) sendSwarmState();
    lastSnapshot = performance.now();
    const integrationSamples = integrationSampleBuffer.toBatch(simulationTimeSeconds);
    const batches = eventBatches ?? [events];
    batches.forEach((snapshotEvents, index) => send({ type: "SNAPSHOT", worldRevision, settings, snapshot: { bodies, environmentSeed,
      simulationTimeSeconds, status, events: snapshotEvents,
      ...(index === batches.length - 1 && integrationSamples ? { integrationSamples } : {}),
      collisionMode, history: summarizeWorldHistory(history), presentationEpoch,
      ...(speedLimited ? { speedLimited: true } : {}), ...(stellarEvolutionRunning ? { stellarEvolutionRunning: true } : {}) } }));
    if (integrationSamples) integrationSampleBuffer.clear(simulationTimeSeconds);
  };
  const flushIntegrationSamples = () => {
    if (integrationSampleBuffer.hasSamples) sendSnapshot(true);
  };
  const hasSimulationError = () => status === "error";
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const tick = (): void => {
    const now = performance.now();
    if (stellarEvolutionRunning) {
      const sun = bodies.find((body) => hasSolarEvolutionProfile(body));
      if (!sun?.stellarEvolution) {
        stellarEvolutionRunning = false;
        stop();
        sendError("O perfil solar evolutivo não está mais disponível.");
        return;
      }
      const elapsedSeconds = Math.min(Math.max(0, now - lastEvolutionTick), MAX_SOLAR_EVOLUTION_TICK_MS) / 1000;
      lastEvolutionTick = now;
      const ageYears = Math.min(
        sun.stellarEvolution.ageYears + elapsedSeconds * SOLAR_EVOLUTION_YEARS_PER_REAL_SECOND,
        SOLAR_EVOLUTION_END_AGE_YEARS,
      );
      try {
        const candidate = applyWorldMutation(bodies, settings, { type: "ADVANCE_SOLAR_AGE", ageYears }, { swarmLedger, environmentSeed });
        bodies = candidate.bodies;
        if (ageYears >= SOLAR_EVOLUTION_END_AGE_YEARS) {
          stellarEvolutionRunning = false;
          stop();
        }
      } catch (error) {
        stellarEvolutionRunning = false;
        stop();
        status = "error";
        sendError(error instanceof Error ? error.message : "Solar evolution failed.");
        return;
      }
      if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS) sendSnapshot();
      return;
    }
    accumulatedSeconds += Math.max(0, now - lastTick) / 1000 * speedMultiplier;
    lastTick = now;
    try {
      let surfaceChanged = false, heatChanged = false;
      const seconds = accumulatedSeconds;
      if (seconds > 0) {
        const intervalStartSeconds = simulationTimeSeconds;
        const result = advanceSimulationInterval(bodies, settings, seconds, speedMultiplier <= 2_000 ? 1 : 3_600,
          { captureSamples: trailSamplingEnabled, collisionMode, environmentSeed, simulationTimeSeconds, surfaceData, surfaceHeatData, swarmLedger });
        surfaceChanged = result.surfaceData !== undefined && result.surfaceData !== surfaceData;
        heatChanged = result.surfaceHeatData !== undefined && result.surfaceHeatData !== surfaceHeatData;
        bodies = result.bodies;
        if (result.swarmLedger !== swarmLedger) swarmStateDirty = true;
        swarmLedger = result.swarmLedger;
        surfaceData = result.surfaceData ?? surfaceData;
        surfaceHeatData = result.surfaceHeatData ?? surfaceHeatData;
        simulationTimeSeconds += result.advancedSeconds;
        if (result.advancedSeconds > 0) integrationSampleBuffer.append(result.samples ?? [], intervalStartSeconds, result.samplesTruncated);
        accumulatedSeconds = 0;
        speedLimited = result.budgetLimited;
        const committedEvents = result.events.map((event) => publishEvent(event, intervalStartSeconds + event.timeSeconds));
        if (surfaceChanged || heatChanged) surfaceStateDirty = true;
        if (surfaceChanged || heatChanged) sendSurfaceState();
        if (committedEvents.length > MAX_SIMULATION_EVENTS_PER_SNAPSHOT) {
          sendSnapshot(true, batchSimulationEvents(committedEvents));
          return;
        }
      }
      if (surfaceChanged) {
        sendSnapshot(true);
      } else if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
        sendSnapshot();
      }
    } catch (error) {
      speedLimited = false;
      stop();
      cancelPendingSnapshot();
      integrationSampleBuffer.clear(simulationTimeSeconds);
      if (error instanceof SimulationError && error.code === "UNSUPPORTED_COLLISION") {
        accumulatedSeconds = 0;
        status = "paused";
        sendError(error.message);
        return;
      }
      status = "error";
      sendError(error instanceof Error ? error.message : "Simulation failed.");
    }
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    const raw = event.data as Record<string, unknown> | null;
    if (raw && typeof raw === "object" && raw.type === "PREVIEW_TRAJECTORY") {
      const request = parseTrajectoryPreviewRequest(raw);
      if (!request) return;
      send(createTrajectoryPreviewResponse(request, { bodies, settings, worldRevision, simulationTimeSeconds, collisionMode,
        paused: status === "paused" && timer === undefined && !stellarEvolutionRunning }));
      return;
    }
    if (raw && typeof raw === "object" && raw.type === "PREVIEW_ORBITAL_MUTATION") {
      const request = parseOrbitalMutationPreviewRequest(raw);
      if (!request) return;
      send(createOrbitalMutationPreviewResponse(request, { bodies, settings, worldRevision, simulationTimeSeconds,
        swarmLedger, environmentSeed, paused: status === "paused" && timer === undefined && !stellarEvolutionRunning }));
      return;
    }
    const command = parseSimulationWorkerCommand(event.data);
    if (!command) {
      const raw = event.data as Record<string, unknown> | null;
      if (raw && typeof raw === "object" && (raw.type === "MUTATE_WORLD" || raw.type === "SET_WORLD")
        && Number.isSafeInteger(raw.revision) && (raw.revision as number) > worldRevision) {
        rejectWorld("A alteração solicitada contém parâmetros inválidos.", raw.revision as number);
      } else sendError("Worker received an invalid command.");
      return;
    }
    if (command.type === "SET_SETTINGS" || command.type === "SET_BODIES" || command.type === "SET_WORLD"
      || command.type === "SET_COLLISION_MODE" || command.type === "RESTORE_CHECKPOINT" || command.type === "MUTATE_WORLD") {
      if (command.revision <= worldRevision) {
        sendError("Worker received an outdated world revision.");
        return;
      }
    }
    if (command.type === "MUTATE_WORLD") {
      if (timer !== undefined) tick();
      if (hasSimulationError()) { rejectWorld("A simulação foi pausada antes da alteração. Reduza o tempo ou reinicie.", command.revision); return; }
      integrationSampleBuffer.clear(simulationTimeSeconds);
      try {
        const before = currentHistoryState();
        const candidate = applyWorldMutation(bodies, settings, command.mutation, { simulationTimeSeconds, swarmLedger, environmentSeed });
        const nextSurfaces = surfaceDataForBodies(candidate.bodies);
        validateSurfaceData(nextSurfaces.data, surfaceMetadata(candidate.bodies));
        const nextHeat = surfaceHeatDataForBodies(candidate.bodies);
        const speedLimitMessage = simulationSpeedLimitMessage(candidate.bodies.length, speedMultiplier, TICK_INTERVAL_MS / 1_000);
        if (speedLimitMessage) throw new Error(speedLimitMessage);
        const nextHistory = recordAction(before, {
          bodies: candidate.bodies,
          settings: candidate.settings,
          environmentSeed,
          simulationTimeSeconds,
          collisionMode,
          surfaceData: nextSurfaces.data,
          swarmLedger: candidate.swarmLedger,
        }, command.history?.coalesceId);
        if (timer !== undefined && !stellarEvolutionRunning
          && (command.mutation.type === "INIT_SOLAR_EVOLUTION" || command.mutation.type === "ADVANCE_SOLAR_AGE")) {
          stop();
          status = "paused";
          accumulatedSeconds = 0;
          lastTick = performance.now();
        }
        if (stellarEvolutionRunning) {
          stop();
          status = "paused";
        }
        bodies = candidate.bodies;
        if (candidate.swarmLedger !== swarmLedger) swarmStateDirty = true;
        swarmLedger = candidate.swarmLedger;
        settings = candidate.settings;
        surfaceData = nextSurfaces.data;
        surfaceHeatData = nextHeat.data;
        history = nextHistory;
        stellarEvolutionRunning = false;
        worldRevision = command.revision;
        if (candidate.event) publishEvent(candidate.event, simulationTimeSeconds);
        if (nextSurfaces.changed || nextHeat.changed) sendSurfaceState();
        sendSnapshot(true);
      } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Não foi possível aplicar a alteração.", command.revision);
      }
    } else if (command.type === "START") {
      if (stellarEvolutionRunning) {
        sendError("Pause a evolução solar antes de retomar o movimento orbital.");
        return;
      }
      if (timer !== undefined) return;
      if (status === "error") accumulatedSeconds = 0;
      status = "running";
      speedLimited = false;
      lastTick = performance.now();
      timer = setInterval(tick, TICK_INTERVAL_MS);
      sendSnapshot();
    } else if (command.type === "PAUSE") {
      if (timer !== undefined) tick();
      stop();
      stellarEvolutionRunning = false;
      if (status !== "error") status = "paused";
      sendSnapshot();
    } else if (command.type === "SET_SPEED") {
      if (timer !== undefined) tick();
      if (status === "error") accumulatedSeconds = 0;
      const limitMessage = simulationSpeedLimitMessage(bodies.length, command.multiplier, TICK_INTERVAL_MS / 1_000);
      if (limitMessage) { sendError(limitMessage); return; }
      speedMultiplier = command.multiplier;
      speedLimited = false;
    } else if (command.type === "SET_COLLISION_MODE") {
      if (timer !== undefined) tick();
      if (hasSimulationError()) { rejectWorld("Simulation failed before collision mode could be applied.", command.revision); return; }
      try {
        const before = currentHistoryState();
        const nextHistory = command.origin === "bootstrap" ? history : recordAction(before, { ...before, collisionMode: command.mode });
        history = nextHistory;
        collisionMode = command.mode;
        worldRevision = command.revision;
        sendSnapshot(true);
      } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Collision mode could not be applied.", command.revision);
      }
    } else if (command.type === "RESTORE_CHECKPOINT") {
      const restored = restoreWorldHistoryCheckpoint(history, command.checkpointId, command.direction, command.generation);
      if (!restored.ok) { rejectWorld("Checkpoint is stale or is no longer adjacent.", command.revision); return; }
      try {
        validateSimulationState(restored.checkpoint.bodies, restored.checkpoint.settings);
        validateSurfaceData(restored.checkpoint.surfaceData, surfaceMetadata(restored.checkpoint.bodies));
        if (!Number.isFinite(restored.checkpoint.simulationTimeSeconds) || restored.checkpoint.simulationTimeSeconds < 0
          || (restored.checkpoint.collisionMode !== "scientific" && restored.checkpoint.collisionMode !== "creative")) {
          throw new Error("Checkpoint state is invalid.");
        }
        stop();
        status = "paused";
        stellarEvolutionRunning = false;
        accumulatedSeconds = 0;
        speedLimited = false;
        lastTick = performance.now();
        lastEvolutionTick = lastTick;
        cancelPendingSnapshot();
        bodies = restored.checkpoint.bodies;
        swarmLedger = restored.checkpoint.swarmLedger ?? createEmptySwarmLedger();
        validateSwarmLedger(swarmLedger, bodies);
        swarmStateDirty = true;
        settings = restored.checkpoint.settings;
        surfaceData = restored.checkpoint.surfaceData;
        surfaceHeatData = surfaceHeatDataForBodies(restored.checkpoint.bodies, true).data;
        environmentSeed = restored.checkpoint.environmentSeed;
        simulationTimeSeconds = restored.checkpoint.simulationTimeSeconds;
        collisionMode = restored.checkpoint.collisionMode;
        history = restored.history;
        events = [];
        integrationSampleBuffer.clear(simulationTimeSeconds);
        presentationEpoch += 1;
        worldRevision = command.revision;
        sendSurfaceState();
        sendSnapshot(true);
      } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Checkpoint could not be restored.", command.revision);
      }
    } else if (command.type === "SET_TRAIL_SAMPLING" && command.enabled !== trailSamplingEnabled) {
      if (!command.enabled) {
        if (timer !== undefined) tick();
        trailSamplingEnabled = false;
        if (hasSimulationError()) { integrationSampleBuffer.clear(simulationTimeSeconds); return; }
        flushIntegrationSamples();
      }
      trailSamplingEnabled = command.enabled;
    } else if (command.type === "SET_STELLAR_EVOLUTION_RUNNING") {
      if (command.running) {
        if (!bodies.some(hasSolarEvolutionProfile)
          || !checkSolarEvolutionEligibility(bodies, settings, bodies.find(hasSolarEvolutionProfile)!.stellarEvolution!.ageYears).eligible) {
          sendError("O estado atual não permite executar a evolução solar.");
          return;
        }
        if (timer !== undefined) tick();
        if (hasSimulationError()) return;
        stop();
        accumulatedSeconds = 0;
        status = "paused";
        lastEvolutionTick = performance.now();
        timer = setInterval(tick, TICK_INTERVAL_MS);
      } else if (stellarEvolutionRunning) {
        tick();
        stop();
        if (status !== "error") status = "paused";
      }
      stellarEvolutionRunning = command.running;
      lastTick = performance.now();
      if (command.running) lastEvolutionTick = performance.now();
      sendSnapshot(true);
    } else if (command.type === "SET_WORLD") {
      try { validateSimulationState(command.bodies, command.settings); } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate world is invalid.", command.revision); return;
      }
      const nextSurfaceData = structuredClone(command.surfaceData ?? {});
      try { validateSurfaceData(nextSurfaceData, surfaceMetadata(command.bodies)); } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate surface state is invalid.", command.revision); return;
      }
      const nextHeat = surfaceHeatDataForBodies(command.bodies, true);
      const nextSwarmLedger = command.swarmLedger ?? createEmptySwarmLedger();
      try { validateSwarmLedger(nextSwarmLedger, command.bodies); } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate swarm ledger is invalid.", command.revision); return;
      }
      const speedLimitMessage = simulationSpeedLimitMessage(command.bodies.length, speedMultiplier, TICK_INTERVAL_MS / 1_000);
      if (speedLimitMessage) { rejectWorld(speedLimitMessage, command.revision); return; }
      const nextCollisionMode = command.origin === "experiment" ? command.collisionMode ?? collisionMode
        : command.origin === "import" ? command.session?.collisionMode ?? "scientific" : "scientific";
      const nextSimulationTimeSeconds = command.origin === "import" ? command.session?.simulationTimeSeconds ?? 0 : 0;
      let nextHistory: WorldHistory;
      try {
        nextHistory = command.origin === "experiment"
          ? recordAction(currentHistoryState(), { bodies: command.bodies, settings: command.settings, environmentSeed: command.environmentSeed, simulationTimeSeconds: 0, collisionMode: nextCollisionMode, surfaceData: nextSurfaceData, swarmLedger: nextSwarmLedger })
          : startNewWorldHistoryGeneration(history);
      } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "World replacement could not be recorded.", command.revision); return;
      }
      stop();
      status = "paused";
      integrationSampleBuffer.clear(nextSimulationTimeSeconds);
      worldRevision = command.revision;
      bodies = command.bodies;
      swarmLedger = nextSwarmLedger;
      swarmStateDirty = true;
      surfaceData = nextSurfaceData;
      surfaceHeatData = nextHeat.data;
      settings = command.settings;
      environmentSeed = command.environmentSeed;
      collisionMode = nextCollisionMode;
      history = nextHistory;
      speedLimited = false;
      stellarEvolutionRunning = false;
      events = [];
      accumulatedSeconds = 0;
      simulationTimeSeconds = nextSimulationTimeSeconds;
      lastTick = performance.now();
      lastEvolutionTick = lastTick;
      presentationEpoch += 1;
      sendSurfaceState();
      sendSnapshot(true);
    } else if (command.type === "SET_SETTINGS") {
      try { validateSimulationState(bodies, command.settings); } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate settings are invalid.", command.revision); return;
      }
      if (timer !== undefined) tick();
      if (hasSimulationError()) {
        rejectWorld("Simulation failed before settings could be applied.", command.revision);
        return;
      }
      try { validateSimulationState(bodies, command.settings); } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate settings are invalid.", command.revision); return;
      }
      try {
        const before = currentHistoryState();
        const nextHistory = recordAction(before, { ...before, settings: command.settings }, command.coalesceId);
        integrationSampleBuffer.clear(simulationTimeSeconds);
        settings = command.settings;
        if (stellarEvolutionRunning) {
          stop();
          stellarEvolutionRunning = false;
          status = "paused";
        }
        history = nextHistory;
        worldRevision = command.revision;
        sendSnapshot(true);
      } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Settings could not be applied.", command.revision);
      }
    } else if (command.type === "SET_BODIES") {
      // Legacy whole-body replacement: account for elapsed time, then replace the supplied phase space.
      if (timer !== undefined) tick();
      if (hasSimulationError()) { rejectWorld("Simulation failed before bodies could be applied.", command.revision); return; }
      const wasEvolving = stellarEvolutionRunning;
      try { validateSimulationState(command.bodies, settings); } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate bodies are invalid.", command.revision); return;
      }
      let nextSurfaces: { data: SurfaceData; changed: boolean };
      let nextHeat: { data: SurfaceHeatData; changed: boolean };
      try {
        nextSurfaces = surfaceDataForBodies(command.bodies);
        validateSurfaceData(nextSurfaces.data, surfaceMetadata(command.bodies));
        nextHeat = surfaceHeatDataForBodies(command.bodies);
      } catch (error) {
        rejectWorld(error instanceof Error ? error.message : "Candidate surface state is invalid.", command.revision); return;
      }
      let nextSwarmLedger: SwarmLedger;
      try { nextSwarmLedger = reconcileSwarmLedger(swarmLedger, bodies, command.bodies); }
      catch (error) { rejectWorld(error instanceof Error ? error.message : "Candidate swarm state is invalid.", command.revision); return; }
      const speedLimitMessage = simulationSpeedLimitMessage(command.bodies.length, speedMultiplier, TICK_INTERVAL_MS / 1_000);
      if (speedLimitMessage) { rejectWorld(speedLimitMessage, command.revision); return; }
      let nextHistory: WorldHistory;
      try { nextHistory = startNewWorldHistoryGeneration(history); }
      catch (error) { rejectWorld(error instanceof Error ? error.message : "History generation could not be reset.", command.revision); return; }
      if (wasEvolving) {
        stop();
        status = "paused";
      }
      integrationSampleBuffer.clear(simulationTimeSeconds);
      bodies = command.bodies;
      swarmLedger = nextSwarmLedger;
      swarmStateDirty = true;
      surfaceData = nextSurfaces.data;
      surfaceHeatData = nextHeat.data;
      history = nextHistory;
      speedLimited = false;
      stellarEvolutionRunning = false;
      events = [];
      worldRevision = command.revision;
      lastTick = performance.now();
      presentationEpoch += 1;
      if (nextSurfaces.changed || nextHeat.changed) sendSurfaceState();
      if (status !== "error") sendSnapshot(true);
    }
  };
  scope.addEventListener("message", onMessage);
  return () => {
    stop();
    cancelPendingSnapshot();
    scope.removeEventListener("message", onMessage);
  };
}
if (typeof self !== "undefined" && !("document" in self)) {
  installSimulationWorker(self as unknown as WorkerScope);
}
