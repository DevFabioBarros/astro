import type { SpinState } from "./spin-model";

export type BodyType = "star" | "white-dwarf" | "neutron-star" | "black-hole" | "rocky-planet" | "gas-giant" | "moon" | "asteroid" | "comet";
export type ThermalProfileId = "earthlike-global-mean-v1";
export type AtmosphereProfileId = "nitrogen-oxygen-v1" | "carbon-dioxide-v1";
export type IsothermalAtmosphere = {
  modelId: "isothermal-atmosphere-v1";
  profileId: AtmosphereProfileId;
  dryGasMassKg: number;
  isothermalTemperatureK: number;
};
export type SurfaceMetadata = {
  modelId: "sparse-relief-v1";
  seed: number;
  revision: number;
  resolution: 64;
  dataId: string;
};
export type SurfaceReliefPatch = { cellIndex: number; elevationM: number };
export type SurfaceData = Record<string, SurfaceReliefPatch[]>;
export type SurfaceHeatPatch = { modelId: "impact-surface-glow-v1"; cellIndex: number; intensity01: number; startedAtSimulationTimeSeconds: number };
export type SurfaceHeatData = Record<string, SurfaceHeatPatch[]>;
export type CollisionEnergyLedger = {
  modelId: "collision-energy-ledger-v1";
  sources: { externalJ: number; relativeKineticJ: number };
  allocations: { fragmentKineticJ: number; thermalJ: number; unresolvedJ: number };
};
export type MaterialProfileId = "rock-v1" | "iron-v1" | "water-ice-v1" | "gas-v1";
export type SwarmMassShare = { swarmId: string; massKg: number };
export type SwarmGroup = {
  id: string;
  modelId: "physical-orbital-swarm-v1";
  seed: EnvironmentSeed;
  profileId: MaterialProfileId;
  initialMassKg: number;
  externalMassInKg: number;
  externalMassOutKg: number;
  retiredMassKg: number;
};
export type SwarmLedger = {
  modelId: "physical-swarm-ledger-v1";
  nextSequence: number;
  groups: SwarmGroup[];
  bodyMassShares: Record<string, SwarmMassShare[]>;
};
export type SwarmTransfer = { swarmId: string; fromBodyIds: string[]; toBodyId: string; massKg: number; availableMassKg: number };
export type SwarmStateMessage = { type: "SWARM_STATE"; worldRevision: number; swarmLedger: SwarmLedger };
export type MaterialComposition = { modelId: "material-composition-v1"; rockKg: number; ironKg: number; gasKg: number };
export type MaterialEditMode = "mass-authoritative" | "radius-authoritative";
export type MaterialSizeMutation =
  | { type: "SET_MATERIAL_SIZE"; bodyId: string; editMode: "mass-authoritative"; massKg: number }
  | { type: "SET_MATERIAL_SIZE"; bodyId: string; editMode: "radius-authoritative"; radiusM: number };
export type BatchScaleBodiesMutation = {
  type: "BATCH_SCALE_BODIES";
  bodyIds: string[];
  energyLedger?: CollisionEnergyLedger;
  field: "massKg" | "radiusM";
  factor: 2 | 0.5;
};
export type WaterInventoryState = {
  modelId: "water-inventory-v1";
  escapeModelId: "water-escape-retention-500-1000k-v1";
  dryMassKg: number;
  dryVolumeM3: number;
  liquidKg: number;
  iceKg: number;
  vaporKg: number;
  escapedKg: number;
};

export type Vector3 = readonly [x: number, y: number, z: number];

export type StellarEvolutionMetadata = {
  modelId: "mist-v1.2-solar-1msun-nonrotating";
  modelVersion: "1.2";
  ageYears: number;
  accretedMassKg: number;
  absorbedBodyIds: string[];
  mode: "secular" | "manual";
};

export type CelestialBody = {
  id: string;
  name: string;
  kind: "star" | "planet" | "moon";
  bodyType?: BodyType;
  parentId?: string;
  massKg: number;
  radiusM: number;
  positionM: Vector3;
  velocityMs: Vector3;
  surfaceTemperatureK: number;
  waterFraction: number;
  stellarEvolution?: StellarEvolutionMetadata;
  thermalProfileId?: ThermalProfileId;
  waterInventory?: WaterInventoryState;
  materials?: MaterialComposition;
  atmosphere?: IsothermalAtmosphere;
  surface?: SurfaceMetadata;
  spin?: SpinState;
};

export type PhysicsSettings = { gravitationalConstant: number };
export type EnvironmentSeed = number;
export type CollisionMode = "scientific" | "creative";
export type SimulationSessionState = { simulationTimeSeconds: number; collisionMode: CollisionMode };

export type EditableBodyField =
  | "massKg"
  | "radiusM"
  | "surfaceTemperatureK"
  | "waterFraction"
  | `positionM.${0 | 1 | 2}`
  | `velocityMs.${0 | 1 | 2}`;

export type WorldMutation =
  | { type: "CREATE_ORBITAL_BODY"; bodyType: BodyType; primaryId: string; semiMajorAxisM: number; planeNormal?: Vector3; radialDirection?: Vector3 }
  | { type: "SET_ORBITAL_PAIR"; firstBodyId: string; secondBodyId: string; separationM: number; planeNormal?: Vector3; radialDirection?: Vector3 }
  | { type: "CREATE_ORBITAL_RING"; primaryId: string; innerRadiusM: number; outerRadiusM: number; representativeCount: number; totalMassKg: number; profileId: MaterialProfileId; planeNormal?: Vector3; radialDirection?: Vector3 }
  | { type: "APPLY_IMPULSE"; bodyId: string; impulseNs: Vector3 }
  | { type: "APPLY_LASER"; bodyId: string; bodyLocalDirection: Vector3; powerW: number; durationAcceptedSeconds: number; profileId: "grey-albedo-laser-absorption-v1" }
  | { type: "EDIT_BODY"; bodyId: string; field: EditableBodyField; value: number }
  | { type: "DUPLICATE_BODY"; bodyId: string; positionM: Vector3; velocityMs?: Vector3 }
  | { type: "CREATE_BODY"; bodyType: BodyType; primaryId: string | null; positionM?: Vector3; velocityMs?: Vector3 }
  | { type: "REMOVE_BODY"; bodyId: string }
  | { type: "EXPLODE_BODY"; bodyId: string; specificEnergyJkg?: number }
  | { type: "SET_SETTINGS"; settings: PhysicsSettings }
  | { type: "SET_THERMAL_PROFILE"; bodyId: string; profileId: ThermalProfileId | null }
  | { type: "ADOPT_WATER_INVENTORY"; bodyId: string }
  | { type: "SET_WATER_INVENTORY"; bodyId: string; retainedWaterKg: number }
  | { type: "SET_MATERIAL_COMPOSITION"; bodyId: string; editMode: MaterialEditMode; dryFractions: { rock: number; iron: number; gas: number } }
  | { type: "SET_ATMOSPHERE"; bodyId: string; atmosphere: IsothermalAtmosphere | null }
  | { type: "SET_BODY_SPIN"; bodyId: string; spin: SpinState | null }
  | MaterialSizeMutation
  | BatchScaleBodiesMutation
  | { type: "INIT_SOLAR_EVOLUTION" }
  | { type: "ADVANCE_SOLAR_AGE"; ageYears: number }
  | { type: "EXIT_SOLAR_EVOLUTION" };
export type OrbitalMutationIntent = Extract<WorldMutation,
  { type: "CREATE_ORBITAL_BODY" | "SET_ORBITAL_PAIR" | "CREATE_ORBITAL_RING" }>;
export type OrbitalPlacementMutation = OrbitalMutationIntent;
export type LaserAimConfiguration = {
  bodyId: string;
  powerW: number;
  durationAcceptedSeconds: number;
  profileId: "grey-albedo-laser-absorption-v1";
};
export type PendingWorldMutation = { revision: number; mutation: WorldMutation; coalesceId?: string };
export type WorldSetOrigin = "experiment" | "reset" | "import" | "initial";
export type WorldRestoreDirection = "undo" | "redo";
export type WorldHistorySummary = {
  generation: number;
  undoCheckpointId: string | null;
  redoCheckpointId: string | null;
  actionCount: number;
  bytes: number;
};

export type SimulationEvent = {
  id: number;
  type: "collision" | "explosion" | "black-hole-capture" | "impulse" | "laser";
  timeSeconds: number;
  positionM: Vector3;
  radiusM: number;
  energyJ: number;
  bodyIds: string[];
  visualEffect?: "stellar-gas-expansion";
  impulse?: {
    modelId: "center-of-mass-impulse-v1";
    deltaVelocityMs: Vector3;
    impulseNs: Vector3;
    externalWorkJ: number;
  };
  laser?: {
    modelId: "laser-energy-ledger-v1";
    profileId: "grey-albedo-laser-absorption-v1";
    bodyLocalDirection: Vector3;
    powerW: number;
    durationAcceptedSeconds: number;
    albedo: number;
    inputJ: number;
    absorbedJ: number;
    reflectedJ: number;
  };
  /** Physical mass attribution moved by a fusion or capture; body mass is never counted twice. */
  swarmTransfers?: SwarmTransfer[];
  /** Collision-only geometry before resolution; absent on legacy events. */
  contact?: {
    pointM: Vector3;
    normalM: Vector3 | null;
    relativeVelocityMs: Vector3;
  };
  collisionDiagnostics?: {
    modelId: "perfectly-inelastic-merge-v1";
    relativeSpeedMps: number;
    specificImpactEnergyJkg: number;
    impactAngleRad: number | null;
  };
  outcome?:
    | { kind: "creative-fragmentation"; modelId: "creative-fragmentation-v1"; fragmentBodyIds: string[]; availableEnergyJ: number; fragmentKineticEnergyJ: number; dissipatedEnergyJ: number }
    | { kind: "perfectly-inelastic-merge"; modelId: "perfectly-inelastic-merge-v1"; survivorBodyId: string }
    | { kind: "creative-accretion"; modelId: "creative-accretion-v1"; captorBodyId: string; absorbedBodyId: string; captureRadiusM: number };
};

export const MAX_SIMULATION_EVENTS_PER_SNAPSHOT = 16;

export function batchSimulationEvents(events: readonly SimulationEvent[]): SimulationEvent[][] {
  const batches: SimulationEvent[][] = [];
  for (let index = 0; index < events.length; index += MAX_SIMULATION_EVENTS_PER_SNAPSHOT) {
    batches.push(events.slice(index, index + MAX_SIMULATION_EVENTS_PER_SNAPSHOT));
  }
  return batches;
}

export type SimulationSnapshot = {
  environmentSeed: EnvironmentSeed;
  swarmLedger?: SwarmLedger;
  bodies: CelestialBody[];
  simulationTimeSeconds: number;
  status: "running" | "paused" | "error";
  worldRevision?: number;
  settings?: PhysicsSettings;
  error?: string;
  events?: readonly SimulationEvent[];
  integrationSamples?: IntegrationSampleBatchV1;
  stellarEvolutionRunning?: boolean;
  speedLimited?: boolean;
  collisionMode: CollisionMode;
  history?: WorldHistorySummary;
  presentationEpoch?: number;
};
export type SurfaceStateMessage = { type: "SURFACE_STATE"; worldRevision: number; surfaceData: SurfaceData; surfaceHeatData: SurfaceHeatData };

export type TrajectoryPreviewRequest = {
  requestId: number;
  worldRevision: number;
  baseTimeSeconds: number;
  collisionMode: CollisionMode;
  candidate: CelestialBody;
};

export type TrajectoryPreviewResult = {
  points: Vector3[];
  contact: { timeSeconds: number; positionM: Vector3; bodyIds: string[] } | null;
};

export type TrajectoryPreviewResponse = {
  type: "TRAJECTORY_PREVIEW";
  requestId: number;
  worldRevision: number;
  baseTimeSeconds: number;
  collisionMode: CollisionMode;
  preview: TrajectoryPreviewResult | null;
};

export type OrbitalMutationPreviewRequest = {
  type: "PREVIEW_ORBITAL_MUTATION";
  version: 1;
  requestId: number;
  worldRevision: number;
  baseTimeSeconds: number;
  mutation: OrbitalMutationIntent;
};

export type OrbitalMutationPreviewCandidate = { bodyId: string; positionM: Vector3; velocityMs: Vector3 };
export type OrbitalMutationPreviewResult =
  | { status: "ready"; candidates: OrbitalMutationPreviewCandidate[] }
  | { status: "refused"; code: SimulationErrorCode; message: string }
  | null;
export type OrbitalMutationPreviewResponse = {
  type: "ORBITAL_MUTATION_PREVIEW";
  version: 1;
  requestId: number;
  worldRevision: number;
  baseTimeSeconds: number;
  result: OrbitalMutationPreviewResult;
};

export type IntegrationSampleBatchV1 = {
  version: 1;
  startTimeSeconds: number;
  endTimeSeconds: number;
  samples: readonly {
    offsetSeconds: number;
    bodies: readonly { id: string; positionM: Vector3 }[];
  }[];
  truncated?: boolean;
};

export const MAX_INTEGRATION_SAMPLES_PER_BATCH = 128;
export const MAX_INTEGRATION_SAMPLE_BATCH_BYTES = 512 * 1024;

export function estimateIntegrationSampleBytes(sample: IntegrationSampleBatchV1["samples"][number]): number {
  return 32 + sample.bodies.reduce((total, body) => total + 64 + body.id.length * 2, 0);
}

export function estimateIntegrationSampleBatchBytes(samples: IntegrationSampleBatchV1["samples"]): number {
  return 32 + samples.reduce((total, sample) => total + estimateIntegrationSampleBytes(sample), 0);
}

export type SimulationWorkerCommand =
  | ({ type: "PREVIEW_TRAJECTORY" } & TrajectoryPreviewRequest)
  | OrbitalMutationPreviewRequest
  | { type: "SET_COLLISION_MODE"; mode: CollisionMode; revision: number; origin?: "bootstrap" }
  | { type: "MUTATE_WORLD"; mutation: WorldMutation; revision: number; history?: { coalesceId: string } }
  | { type: "RESTORE_CHECKPOINT"; checkpointId: string; direction: WorldRestoreDirection; revision: number; generation: number }
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "SET_TRAIL_SAMPLING"; enabled: boolean }
  | { type: "SET_STELLAR_EVOLUTION_RUNNING"; running: boolean }
  | { type: "SET_SPEED"; multiplier: number }
  | { type: "SET_SETTINGS"; settings: PhysicsSettings; revision: number; coalesceId?: string }
  | { type: "SET_BODIES"; bodies: CelestialBody[]; revision: number }
  | { type: "SET_WORLD"; origin: WorldSetOrigin; bodies: CelestialBody[]; settings: PhysicsSettings; environmentSeed: EnvironmentSeed; surfaceData?: SurfaceData; swarmLedger?: SwarmLedger; collisionMode?: CollisionMode; session?: SimulationSessionState; revision: number };

export type SimulationWorkerMessage =
  | { type: "SNAPSHOT"; worldRevision: number; settings: PhysicsSettings; snapshot: SimulationSnapshot }
  | SwarmStateMessage
  | SurfaceStateMessage
  | TrajectoryPreviewResponse
  | OrbitalMutationPreviewResponse
  | { type: "ERROR"; message: string; worldRevision?: number; rejectedRevision?: number; snapshot?: SimulationSnapshot };

export type SimulationErrorCode =
  | "INVALID_SETTINGS"
  | "INVALID_BODY"
  | "INVALID_TIME_STEP"
  | "COINCIDENT_BODIES"
  | "UNSUPPORTED_COLLISION"
  | "NUMERIC_OVERFLOW";

export class SimulationError extends Error {
  constructor(readonly code: SimulationErrorCode, message: string) {
    super(message);
    this.name = "SimulationError";
  }
}
