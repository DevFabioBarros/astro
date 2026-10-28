import type { CelestialBody, CollisionMode, PendingWorldMutation, PhysicsSettings, SimulationSessionState, SurfaceData, SwarmLedger, WorldSetOrigin } from "@/simulation/types";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "@/simulation/world-seed";

type SimulationWorldSyncState = {
  worldRevision: number;
  lastSentRevision: number;
  previousBodies: readonly CelestialBody[];
  previousSettings: PhysicsSettings;
  environmentSeed?: number;
  workerSnapshotBodies: readonly CelestialBody[] | null;
  worldReplacementRevision?: number | null;
  worldReplacementOrigin?: WorldSetOrigin;
  worldReplacementCollisionMode?: CollisionMode;
  worldReplacementSession?: SimulationSessionState;
  worldReplacementEnvironmentSeed?: number;
  worldReplacementSurfaceData?: SurfaceData;
  worldReplacementSwarmLedger?: SwarmLedger;
  acceptedSwarmLedger?: SwarmLedger;
  surfaceData?: SurfaceData;
  mutations?: readonly PendingWorldMutation[];
};

export type SimulationWorldUpdate =
  | { type: "SET_BODIES"; bodies: CelestialBody[] }
  | { type: "SET_SETTINGS"; settings: PhysicsSettings }
  | { type: "SET_WORLD"; bodies: CelestialBody[]; settings: PhysicsSettings; environmentSeed: number; surfaceData?: SurfaceData; swarmLedger?: SwarmLedger; origin: WorldSetOrigin; collisionMode?: CollisionMode; session?: SimulationSessionState };

/** Preserve every action when React batches several slider or creation events. */
export function resolvePendingWorldMutations(mutations: readonly PendingWorldMutation[], lastSentRevision: number): PendingWorldMutation[] {
  return mutations.filter((entry) => entry.revision > lastSentRevision).sort((a, b) => a.revision - b.revision);
}

export function resolveSimulationWorldUpdate(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
  state: SimulationWorldSyncState,
): SimulationWorldUpdate | null {
  // React can render an older snapshot after the Worker has advanced these references.
  // Only a new page revision authorizes sending a mutation back to the Worker.
  if (state.worldRevision <= state.lastSentRevision) return null;
  if (state.worldReplacementRevision === state.worldRevision) return {
    type: "SET_WORLD", bodies: [...bodies], settings,
    environmentSeed: state.worldReplacementEnvironmentSeed ?? state.environmentSeed ?? DEFAULT_ENVIRONMENT_SEED_V1,
    origin: state.worldReplacementOrigin ?? "reset",
    ...(state.worldReplacementCollisionMode ? { collisionMode: state.worldReplacementCollisionMode } : {}),
    ...(state.worldReplacementSession ? { session: state.worldReplacementSession } : {}),
    ...(state.worldReplacementSurfaceData === undefined ? {} : { surfaceData: state.worldReplacementSurfaceData }),
    ...(state.worldReplacementSwarmLedger === undefined ? {} : { swarmLedger: state.worldReplacementSwarmLedger }),
  };
  // Queued actions own ordinary edits; optimistic body arrays must never reset live orbits.
  if (state.mutations !== undefined) return null;
  const settingsChanged = settings !== state.previousSettings;
  const bodiesChanged = bodies !== state.previousBodies && bodies !== state.workerSnapshotBodies;
  if (!bodiesChanged && !settingsChanged) return null;
  if (bodiesChanged && settingsChanged) return { type: "SET_WORLD", bodies: [...bodies], settings,
    environmentSeed: state.environmentSeed ?? DEFAULT_ENVIRONMENT_SEED_V1,
    ...(state.surfaceData === undefined ? {} : { surfaceData: state.surfaceData }),
    ...(state.acceptedSwarmLedger === undefined ? {} : { swarmLedger: state.acceptedSwarmLedger }), origin: "reset" };
  if (bodiesChanged) return { type: "SET_BODIES", bodies: [...bodies] };
  return { type: "SET_SETTINGS", settings };
}
