import { MAX_SIMULATION_BODIES, SimulationError, validateBodies, validateSettings } from "./physics";
import { MAX_SIMULATION_SPEED } from "./simulation-time";
import { predictTrajectoryPreview } from "./trajectory-preview";
import { applyWorldMutation, validateWorldMutation } from "./world-mutations";
import { isSimulationSessionState } from "./session-state";
import { isEnvironmentSeed } from "./world-seed";
import { validateSurfaceData } from "./surface-state";
import { createEmptySwarmLedger, validateSwarmLedger } from "./swarm-model";
import type { CelestialBody, CollisionMode, OrbitalMutationPreviewRequest, OrbitalMutationPreviewResponse, OrbitalMutationPreviewResult, PhysicsSettings, SimulationSessionState, SimulationWorkerCommand, SurfaceData, SwarmLedger, TrajectoryPreviewRequest, TrajectoryPreviewResponse, TrajectoryPreviewResult, WorldSetOrigin } from "./types";
import type { EnvironmentSeed } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isVector3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

export function parseSimulationWorkerCommand(value: unknown): SimulationWorkerCommand | null {
  if (!isRecord(value) || !("type" in value)) return null;
  const validRevision = Number.isSafeInteger(value.revision) && (value.revision as number) > 0;
  const coalesceId = typeof value.coalesceId === "string" ? value.coalesceId : undefined;
  const validCoalesceId = value.coalesceId === undefined || coalesceId !== undefined
    && coalesceId.trim().length > 0 && coalesceId.length <= 128;
  const history = isRecord(value.history) ? value.history : undefined;
  const historyCoalesceId = typeof history?.coalesceId === "string" ? history.coalesceId : undefined;
  const validMutationHistory = value.history === undefined || history !== undefined
    && Object.keys(history).length === 1 && historyCoalesceId !== undefined
    && historyCoalesceId.trim().length > 0 && historyCoalesceId.length <= 128;
  if (value.type === "MUTATE_WORLD" && validRevision && validMutationHistory && !Object.hasOwn(value, "coalesceId")) {
    try { validateWorldMutation(value.mutation); return { type: "MUTATE_WORLD", mutation: value.mutation, revision: value.revision as number, ...(historyCoalesceId === undefined ? {} : { history: { coalesceId: historyCoalesceId } }) }; } catch { return null; }
  }
  if (value.type === "START" || value.type === "PAUSE") return { type: value.type };
  if (value.type === "SET_COLLISION_MODE" && validRevision && (value.mode === "scientific" || value.mode === "creative")
    && (value.origin === undefined || value.origin === "bootstrap")) {
    return { type: value.type, mode: value.mode, revision: value.revision as number, ...(value.origin === "bootstrap" ? { origin: "bootstrap" } : {}) };
  }
  if (value.type === "RESTORE_CHECKPOINT" && validRevision
    && typeof value.checkpointId === "string" && value.checkpointId.trim().length > 0 && value.checkpointId.length <= 128
    && (value.direction === "undo" || value.direction === "redo")
    && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0) {
    return { type: value.type, checkpointId: value.checkpointId, direction: value.direction, revision: value.revision as number, generation: value.generation as number };
  }
  if (value.type === "SET_TRAIL_SAMPLING" && typeof value.enabled === "boolean") return { type: "SET_TRAIL_SAMPLING", enabled: value.enabled };
  if (value.type === "SET_STELLAR_EVOLUTION_RUNNING" && typeof value.running === "boolean") {
    return { type: value.type, running: value.running };
  }
  if (value.type === "SET_SPEED" && typeof value.multiplier === "number"
    && Number.isFinite(value.multiplier) && value.multiplier > 0 && value.multiplier <= MAX_SIMULATION_SPEED) {
    return { type: "SET_SPEED", multiplier: value.multiplier };
  }
  if (value.type === "SET_SETTINGS" && typeof value.settings === "object" && value.settings !== null
    && validRevision && validCoalesceId) {
    try { validateSettings(value.settings as PhysicsSettings); return { type: "SET_SETTINGS", settings: value.settings as PhysicsSettings, revision: value.revision as number, ...(coalesceId === undefined ? {} : { coalesceId }) }; } catch { return null; }
  }
  if (value.type === "SET_BODIES" && Array.isArray(value.bodies)
    && Number.isSafeInteger(value.revision) && (value.revision as number) > 0) {
    try { validateBodies(value.bodies as CelestialBody[]); return { type: "SET_BODIES", bodies: value.bodies as CelestialBody[], revision: value.revision as number }; } catch { return null; }
  }
  if (value.type === "SET_WORLD" && Array.isArray(value.bodies) && validRevision
    && typeof value.settings === "object" && value.settings !== null
    && isEnvironmentSeed(value.environmentSeed)
    && ["experiment", "reset", "import", "initial"].includes(value.origin as string)
    && (value.collisionMode === undefined || value.origin === "experiment"
      && (value.collisionMode === "scientific" || value.collisionMode === "creative"))
    && (!Object.hasOwn(value, "session") || value.origin === "import" && isSimulationSessionState(value.session))) {
    try {
      validateSettings(value.settings as PhysicsSettings);
      const surfaceMetadata = (value.bodies as CelestialBody[]).flatMap(({ surface }) => surface ? [surface] : []);
      if (Object.hasOwn(value, "surfaceData") || surfaceMetadata.length > 0) {
        validateSurfaceData(value.surfaceData ?? {}, surfaceMetadata);
      }
      if (Object.hasOwn(value, "swarmLedger")) validateSwarmLedger(value.swarmLedger, value.bodies as CelestialBody[]);
      return { type: "SET_WORLD", origin: value.origin as WorldSetOrigin, bodies: value.bodies as CelestialBody[], settings: value.settings as PhysicsSettings, environmentSeed: value.environmentSeed,
        ...(Object.hasOwn(value, "surfaceData") ? { surfaceData: value.surfaceData as SurfaceData } : {}),
        swarmLedger: Object.hasOwn(value, "swarmLedger") ? value.swarmLedger as SwarmLedger : createEmptySwarmLedger(),
        ...(value.collisionMode === undefined ? {} : { collisionMode: value.collisionMode as CollisionMode }),
        ...(value.session === undefined ? {} : { session: value.session as SimulationSessionState }), revision: value.revision as number };
    } catch { return null; }
  }
  return null;
}

export function parseTrajectoryPreviewRequest(value: unknown): TrajectoryPreviewRequest | null {
  if (!isRecord(value) || value.type !== "PREVIEW_TRAJECTORY" || !Number.isSafeInteger(value.requestId)
    || (value.requestId as number) < 1 || !Number.isSafeInteger(value.worldRevision) || (value.worldRevision as number) < 0
    || typeof value.baseTimeSeconds !== "number" || !Number.isFinite(value.baseTimeSeconds) || value.baseTimeSeconds < 0
    || (value.collisionMode !== "scientific" && value.collisionMode !== "creative") || !("candidate" in value)) return null;
  return value as unknown as TrajectoryPreviewRequest;
}

export function parseOrbitalMutationPreviewRequest(value: unknown): OrbitalMutationPreviewRequest | null {
  if (!isRecord(value) || Object.keys(value).length !== 6 || value.type !== "PREVIEW_ORBITAL_MUTATION" || value.version !== 1
    || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1
    || !Number.isSafeInteger(value.worldRevision) || (value.worldRevision as number) < 0
    || typeof value.baseTimeSeconds !== "number" || !Number.isFinite(value.baseTimeSeconds) || value.baseTimeSeconds < 0
    || !isRecord(value.mutation)
    || !["CREATE_ORBITAL_BODY", "SET_ORBITAL_PAIR", "CREATE_ORBITAL_RING"].includes(value.mutation.type as string)) return null;
  return value as unknown as OrbitalMutationPreviewRequest;
}

export function createOrbitalMutationPreviewResponse(
  request: OrbitalMutationPreviewRequest,
  state: { bodies: readonly CelestialBody[]; settings: PhysicsSettings; worldRevision: number; simulationTimeSeconds: number;
    swarmLedger: SwarmLedger; environmentSeed: EnvironmentSeed; paused: boolean },
): OrbitalMutationPreviewResponse {
  let result: OrbitalMutationPreviewResult = null;
  if (state.paused && request.worldRevision === state.worldRevision && request.baseTimeSeconds === state.simulationTimeSeconds) {
    try {
      const candidate = applyWorldMutation(state.bodies, state.settings, request.mutation, {
        simulationTimeSeconds: state.simulationTimeSeconds, swarmLedger: state.swarmLedger, environmentSeed: state.environmentSeed,
      });
      const previousBodies = new Map(state.bodies.map((body) => [body.id, body]));
      result = { status: "ready", candidates: candidate.bodies
        .filter((body) => previousBodies.get(body.id) !== body)
        .map(({ id, positionM, velocityMs }) => ({ bodyId: id, positionM, velocityMs })) };
    } catch (error) {
      result = { status: "refused", code: error instanceof SimulationError ? error.code : "INVALID_BODY",
        message: error instanceof Error ? error.message : "Orbital mutation was refused." };
    }
  }
  return { type: "ORBITAL_MUTATION_PREVIEW", version: 1, requestId: request.requestId,
    worldRevision: request.worldRevision, baseTimeSeconds: request.baseTimeSeconds, result };
}

export function parseOrbitalMutationPreviewResponse(value: unknown): OrbitalMutationPreviewResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 6 || value.type !== "ORBITAL_MUTATION_PREVIEW" || value.version !== 1
    || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1
    || !Number.isSafeInteger(value.worldRevision) || (value.worldRevision as number) < 0
    || typeof value.baseTimeSeconds !== "number" || !Number.isFinite(value.baseTimeSeconds) || value.baseTimeSeconds < 0) return null;
  if (value.result === null) return value as unknown as OrbitalMutationPreviewResponse;
  if (!isRecord(value.result)) return null;
  if (value.result.status === "ready") {
    const candidates = value.result.candidates;
    if (Object.keys(value.result).length !== 2 || !Array.isArray(candidates) || candidates.length > MAX_SIMULATION_BODIES) return null;
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (!isRecord(candidate) || Object.keys(candidate).length !== 3 || typeof candidate.bodyId !== "string"
        || !candidate.bodyId.trim() || ids.has(candidate.bodyId) || !isVector3(candidate.positionM) || !isVector3(candidate.velocityMs)) return null;
      ids.add(candidate.bodyId);
    }
    return value as unknown as OrbitalMutationPreviewResponse;
  }
  const errorCodes = ["INVALID_SETTINGS", "INVALID_BODY", "INVALID_TIME_STEP", "COINCIDENT_BODIES", "UNSUPPORTED_COLLISION", "NUMERIC_OVERFLOW"];
  if (value.result.status === "refused" && Object.keys(value.result).length === 3
    && errorCodes.includes(value.result.code as string) && typeof value.result.message === "string"
    && value.result.message.trim().length > 0 && value.result.message.length <= 1_000) return value as unknown as OrbitalMutationPreviewResponse;
  return null;
}

export function createTrajectoryPreviewResponse(
  request: TrajectoryPreviewRequest,
  state: { bodies: readonly CelestialBody[]; settings: PhysicsSettings; worldRevision: number; simulationTimeSeconds: number; collisionMode: CollisionMode; paused: boolean },
): TrajectoryPreviewResponse {
  const isCurrent = state.paused && request.worldRevision === state.worldRevision
    && request.baseTimeSeconds === state.simulationTimeSeconds && request.collisionMode === state.collisionMode;
  return {
    type: "TRAJECTORY_PREVIEW",
    requestId: request.requestId,
    worldRevision: request.worldRevision,
    baseTimeSeconds: request.baseTimeSeconds,
    collisionMode: request.collisionMode,
    preview: isCurrent ? predictTrajectoryPreview(state.bodies, state.settings, request.candidate, state.collisionMode) : null,
  };
}

function parseTrajectoryPreview(value: unknown): TrajectoryPreviewResult | null {
  if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 1 || value.points.length > 64
    || !value.points.every(isVector3)) return null;
  let contact: TrajectoryPreviewResult["contact"] = null;
  if (value.contact !== null) {
    if (!isRecord(value.contact) || !Number.isFinite(value.contact.timeSeconds) || (value.contact.timeSeconds as number) < 0
      || (value.contact.timeSeconds as number) > 3_600 || !isVector3(value.contact.positionM)
      || !Array.isArray(value.contact.bodyIds) || value.contact.bodyIds.length !== 2
      || value.contact.bodyIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(value.contact.bodyIds).size !== 2) return null;
    contact = { timeSeconds: value.contact.timeSeconds as number, positionM: value.contact.positionM, bodyIds: value.contact.bodyIds as string[] };
  }
  return { points: value.points, contact } as TrajectoryPreviewResult;
}

export function parseTrajectoryPreviewResponse(value: unknown): TrajectoryPreviewResponse | null {
  if (!isRecord(value) || value.type !== "TRAJECTORY_PREVIEW"
    || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1
    || !Number.isSafeInteger(value.worldRevision) || (value.worldRevision as number) < 0
    || !Number.isFinite(value.baseTimeSeconds) || (value.baseTimeSeconds as number) < 0
    || (value.collisionMode !== "scientific" && value.collisionMode !== "creative")) return null;
  const preview = value.preview === null ? null : parseTrajectoryPreview(value.preview);
  if (value.preview !== null && preview === null) return null;
  return { ...value, preview } as TrajectoryPreviewResponse;
}
