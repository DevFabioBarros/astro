import { MAX_SIMULATION_BODIES, validateSimulationState } from "./physics";
import { ATMOSPHERE_PROFILE_IDS, MAX_ATMOSPHERIC_DRY_MASS_KG, MAX_ISOTHERMAL_TEMPERATURE_K, MIN_ISOTHERMAL_TEMPERATURE_K } from "./atmosphere-model";
import { checkSolarEvolutionEligibility, getSolarEvolutionProperties, SOLAR_EVOLUTION_END_AGE_YEARS, SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG, SOLAR_EVOLUTION_MODEL, SOLAR_EVOLUTION_START_AGE_YEARS } from "./stellar-evolution";
import { createSolarSystem } from "./solar-system";
import type { CelestialBody, PhysicsSettings, SimulationSessionState, SurfaceData, SurfaceMetadata, SwarmLedger } from "./types";
import { isSimulationSessionState } from "./session-state";
import { DEFAULT_ENVIRONMENT_SEED_V1, isEnvironmentSeed, LEGACY_ENVIRONMENT_SEED_V1 } from "./world-seed";
import { isValidSpinState, RIGID_BODY_SPIN_MODEL_ID } from "./spin-model";
import { MAX_SWARM_GROUPS, MAX_SWARM_LEDGER_BYTES, SWARM_LEDGER_MODEL_ID, PHYSICAL_SWARM_MODEL_ID, validateSwarmLedger } from "./swarm-model";
import { z } from "zod";
import { MAX_SURFACE_RELIEF_M, SURFACE_GRID_CELL_COUNT, SURFACE_GRID_WIDTH, validateSurfaceData } from "./surface-state";

export const MAX_SIMULATION_SAVE_BYTES = 10 * 1024 * 1024;
const legacyBodySchema = z.object({
  id: z.string().refine((value) => value.trim().length > 0),
  name: z.string().refine((value) => value.trim().length > 0),
  kind: z.enum(["star", "planet", "moon"]),
  massKg: z.number().finite().positive(),
  radiusM: z.number().finite().positive(),
  positionM: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  velocityMs: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  surfaceTemperatureK: z.number().finite().nonnegative(),
  waterFraction: z.number().finite().min(0).max(1),
}).strict();
const bodySchema = legacyBodySchema.extend({
  bodyType: z.enum(["star", "white-dwarf", "neutron-star", "black-hole", "rocky-planet", "gas-giant", "moon", "asteroid", "comet"]).optional(),
  parentId: z.string().refine((value) => value.trim().length > 0).optional(),
}).strict();
const stellarEvolutionSchema = z.object({
  modelId: z.literal(SOLAR_EVOLUTION_MODEL.id),
  modelVersion: z.literal(SOLAR_EVOLUTION_MODEL.version),
  ageYears: z.number().finite().min(SOLAR_EVOLUTION_START_AGE_YEARS).max(SOLAR_EVOLUTION_END_AGE_YEARS),
  accretedMassKg: z.number().finite().min(0).max(SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG),
  absorbedBodyIds: z.array(z.string().refine((value) => value.trim().length > 0)).max(MAX_SIMULATION_BODIES),
  mode: z.enum(["secular", "manual"]),
}).strict().superRefine((metadata, context) => {
  if (new Set(metadata.absorbedBodyIds).size !== metadata.absorbedBodyIds.length) {
    context.addIssue({ code: "custom", message: "Ledger de engolfamento contém IDs duplicados." });
  }
});
const evolvedBodySchema = bodySchema.extend({ stellarEvolution: stellarEvolutionSchema.optional() }).strict();
const thermalBodySchema = evolvedBodySchema.extend({ thermalProfileId: z.literal("earthlike-global-mean-v1").optional() }).strict();
const waterInventorySchema = z.object({
  modelId: z.literal("water-inventory-v1"),
  escapeModelId: z.literal("water-escape-retention-500-1000k-v1"),
  dryMassKg: z.number().finite().positive(),
  dryVolumeM3: z.number().finite().positive(),
  liquidKg: z.number().finite().nonnegative(),
  iceKg: z.number().finite().nonnegative(),
  vaporKg: z.number().finite().nonnegative(),
  escapedKg: z.number().finite().nonnegative(),
}).strict();
const waterBodySchema = thermalBodySchema.extend({ waterInventory: waterInventorySchema.optional() }).strict();
const materialCompositionSchema = z.object({
  modelId: z.literal("material-composition-v1"),
  rockKg: z.number().finite().nonnegative(), ironKg: z.number().finite().nonnegative(), gasKg: z.number().finite().nonnegative(),
}).strict();
const atmosphereSchema = z.object({
  modelId: z.literal("isothermal-atmosphere-v1"),
  profileId: z.enum(ATMOSPHERE_PROFILE_IDS),
  dryGasMassKg: z.number().finite().positive().max(MAX_ATMOSPHERIC_DRY_MASS_KG),
  isothermalTemperatureK: z.number().finite().min(MIN_ISOTHERMAL_TEMPERATURE_K).max(MAX_ISOTHERMAL_TEMPERATURE_K),
}).strict();
const materialBodySchema = waterBodySchema.extend({ materials: materialCompositionSchema.optional(), atmosphere: atmosphereSchema.optional() }).strict();
const settingsSchema = z.object({ gravitationalConstant: z.number().finite().nonnegative() }).strict();
const legacyFileSchema = z.object({
  format: z.literal("astro-simulation"),
  version: z.literal(1),
  bodies: z.array(legacyBodySchema).max(MAX_SIMULATION_BODIES),
  settings: settingsSchema,
}).strict();

const fileSchema = z.union([legacyFileSchema, legacyFileSchema.extend({ version: z.literal(2), bodies: z.array(bodySchema).max(MAX_SIMULATION_BODIES) }).strict()]);
const evolvedFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(3),
  bodies: z.array(evolvedBodySchema).max(MAX_SIMULATION_BODIES).refine((bodies) => bodies.some((body) => body.stellarEvolution !== undefined)),
  settings: settingsSchema,
}).strict();
const sessionSchema = z.object({
  simulationTimeSeconds: z.number().finite().nonnegative(),
  collisionMode: z.enum(["scientific", "creative"]),
}).strict();
const sessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(4),
  world: z.object({ bodies: z.array(evolvedBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema }).strict(),
  session: sessionSchema.optional(),
}).strict();
const thermalSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(5),
  world: z.object({ bodies: z.array(thermalBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema }).strict(),
  session: sessionSchema.optional(),
}).strict();
const waterSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(6),
  world: z.object({ bodies: z.array(waterBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema }).strict(),
  session: sessionSchema.optional(),
}).strict();
const materialSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(7),
  world: z.object({ bodies: z.array(materialBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema }).strict(),
  session: sessionSchema.optional(),
}).strict();
const seededSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(8),
  world: z.object({ bodies: z.array(materialBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema,
    environmentSeed: z.number().int().min(0).max(0xffff_ffff) }).strict(),
  session: sessionSchema.optional(),
}).strict();
const surfaceMetadataSchema = z.object({ modelId: z.literal("sparse-relief-v1"), seed: z.number().int().min(0).max(0xffff_ffff),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), resolution: z.literal(SURFACE_GRID_WIDTH),
  dataId: z.string().refine((value) => !!value.trim() && value.length <= 128) }).strict();
const surfacePatchSchema = z.object({ cellIndex: z.number().int().min(0).max(SURFACE_GRID_CELL_COUNT - 1),
  elevationM: z.number().finite().min(-MAX_SURFACE_RELIEF_M).max(MAX_SURFACE_RELIEF_M) }).strict();
const surfaceBodySchema = materialBodySchema.extend({ surface: surfaceMetadataSchema.optional() }).strict();
const surfaceSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(9),
  world: z.object({ bodies: z.array(surfaceBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema,
    environmentSeed: z.number().int().min(0).max(0xffff_ffff),
    surfaceData: z.record(z.string(), z.array(surfacePatchSchema).max(SURFACE_GRID_CELL_COUNT)) }).strict(),
  session: sessionSchema.optional(),
}).strict();
const spinStateSchema = z.object({
  modelId: z.literal(RIGID_BODY_SPIN_MODEL_ID),
  axisUnitWorld: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  phaseAtEpochRad: z.number().finite(),
  angularVelocityRadPerS: z.number().finite(),
}).strict().refine(isValidSpinState);
const spinBodySchema = surfaceBodySchema.extend({ spin: spinStateSchema.optional() }).strict();
const spinSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(10),
  world: z.object({ bodies: z.array(spinBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema,
    environmentSeed: z.number().int().min(0).max(0xffff_ffff),
    surfaceData: z.record(z.string(), z.array(surfacePatchSchema).max(SURFACE_GRID_CELL_COUNT)).optional() }).strict(),
  session: sessionSchema.optional(),
}).strict();

const swarmLedgerSchema = z.object({
  modelId: z.literal(SWARM_LEDGER_MODEL_ID),
  nextSequence: z.number().int().min(0).max(MAX_SWARM_GROUPS),
  groups: z.array(z.object({ id: z.string().min(1).max(96), modelId: z.literal(PHYSICAL_SWARM_MODEL_ID),
    seed: z.number().int().min(0).max(0xffff_ffff), profileId: z.enum(["rock-v1", "iron-v1", "water-ice-v1", "gas-v1"]),
    initialMassKg: z.number().finite().positive(), externalMassInKg: z.number().finite().nonnegative(),
    externalMassOutKg: z.number().finite().nonnegative(), retiredMassKg: z.number().finite().nonnegative() }).strict()).max(MAX_SWARM_GROUPS),
  bodyMassShares: z.record(z.string().min(1).max(128), z.array(z.object({ swarmId: z.string().min(1).max(96), massKg: z.number().finite().positive() }).strict()).min(1).max(MAX_SWARM_GROUPS)),
}).strict().superRefine((ledger, context) => {
  if (Object.keys(ledger.bodyMassShares).length > MAX_SIMULATION_BODIES
    || new TextEncoder().encode(JSON.stringify(ledger)).byteLength > MAX_SWARM_LEDGER_BYTES) context.addIssue({ code: "custom", message: "Ledger de enxame excede os limites." });
});
const swarmSessionFileSchema = z.object({
  format: z.literal("astro-simulation"), version: z.literal(11),
  world: z.object({ bodies: z.array(spinBodySchema).max(MAX_SIMULATION_BODIES), settings: settingsSchema,
    environmentSeed: z.number().int().min(0).max(0xffff_ffff),
    surfaceData: z.record(z.string(), z.array(surfacePatchSchema).max(SURFACE_GRID_CELL_COUNT)).optional(),
    swarmLedger: swarmLedgerSchema }).strict(),
  session: sessionSchema.optional(),
}).strict();

export type SimulationSaveData = { bodies: CelestialBody[]; settings: PhysicsSettings; environmentSeed: number; session?: SimulationSessionState; surfaceData?: SurfaceData; swarmLedger?: SwarmLedger };

export function encodeSimulation(bodies: readonly CelestialBody[], settings: PhysicsSettings, session?: SimulationSessionState, environmentSeed = DEFAULT_ENVIRONMENT_SEED_V1, surfaceData?: SurfaceData, swarmLedger?: SwarmLedger): string {
  validateSimulationState(bodies, settings);
  validateEvolutionMetadata(bodies, settings);
  if (!isEnvironmentSeed(environmentSeed)) throw new Error("A seed do ambiente deve ser um inteiro uint32.");
  if (session !== undefined && !isSimulationSessionState(session)) throw new Error("O estado da sessão contém dados inválidos.");
  const surfaceMetadata = bodies.flatMap(({ surface }) => surface ? [surface as SurfaceMetadata] : []);
  const hasSurfaceState = surfaceMetadata.length > 0 || surfaceData !== undefined;
  if (hasSurfaceState) validateSurfaceData(surfaceData ?? {}, surfaceMetadata);
  const hasSwarmState = Boolean(swarmLedger?.groups.length);
  if (swarmLedger !== undefined) validateSwarmLedger(swarmLedger, bodies);
  const hasSpin = bodies.some((body) => body.spin !== undefined);
  const text = JSON.stringify(hasSwarmState
    ? { format: "astro-simulation", version: 11, world: { bodies, settings, environmentSeed, ...(hasSurfaceState ? { surfaceData: surfaceData ?? {} } : {}), swarmLedger }, ...(session ? { session } : {}) }
    : hasSpin
    ? { format: "astro-simulation", version: 10, world: { bodies, settings, environmentSeed, ...(hasSurfaceState ? { surfaceData: surfaceData ?? {} } : {}) }, ...(session ? { session } : {}) }
    : hasSurfaceState
      ? { format: "astro-simulation", version: 9, world: { bodies, settings, environmentSeed, surfaceData: surfaceData ?? {} }, ...(session ? { session } : {}) }
      : { format: "astro-simulation", version: 8, world: { bodies, settings, environmentSeed }, ...(session ? { session } : {}) });
  if (new TextEncoder().encode(text).byteLength > MAX_SIMULATION_SAVE_BYTES) {
    throw new Error("O arquivo excede o limite de 10 MiB.");
  }
  return text;
}

export function decodeSimulation(text: string): SimulationSaveData {
  if (new TextEncoder().encode(text).byteLength > MAX_SIMULATION_SAVE_BYTES) {
    throw new Error("O arquivo excede o limite de 10 MiB.");
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("O arquivo não contém JSON válido.");
  }

  const version = typeof input === "object" && input !== null ? (input as Record<string, unknown>).version : undefined;
  if (version === 11) {
    const result = swarmSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings, environmentSeed, surfaceData, swarmLedger } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
      if (surfaceData !== undefined || bodies.some(({ surface }) => surface !== undefined)) validateSurfaceData(surfaceData ?? {}, bodies.flatMap(({ surface }) => surface ? [surface] : []));
      validateSwarmLedger(swarmLedger, bodies);
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos ou excede os limites de enxame/superfície.");
    }
    return { bodies, settings, environmentSeed, swarmLedger,
      ...(surfaceData === undefined ? {} : { surfaceData }), ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 10) {
    const result = spinSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings, environmentSeed, surfaceData } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
      if (surfaceData !== undefined || bodies.some(({ surface }) => surface !== undefined)) {
        validateSurfaceData(surfaceData ?? {}, bodies.flatMap(({ surface }) => surface ? [surface] : []));
      }
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos ou excede os limites de superfície.");
    }
    return { bodies, settings, environmentSeed, ...(surfaceData === undefined ? {} : { surfaceData }), ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 9) {
    const result = surfaceSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings, environmentSeed, surfaceData } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
      validateSurfaceData(surfaceData, bodies.flatMap(({ surface }) => surface ? [surface] : []));
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos ou excede os limites de superfície.");
    }
    return { bodies, settings, environmentSeed, surfaceData, ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 8) {
    const result = seededSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings, environmentSeed } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos.");
    }
    return { bodies, settings, environmentSeed, ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 7) {
    const result = materialSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos.");
    }
    return { bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1, ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 6) {
    const result = waterSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos.");
    }
    return { bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1, ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 5) {
    const result = thermalSessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos.");
    }
    return { bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1, ...(result.data.session ? { session: result.data.session } : {}) };
  }
  if (version === 4) {
    const result = sessionFileSchema.safeParse(input);
    if (!result.success) throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
    const { bodies, settings } = result.data.world;
    try {
      validateSimulationState(bodies, settings);
      validateEvolutionMetadata(bodies, settings);
    } catch {
      throw new Error("O arquivo de simulação contém dados inválidos.");
    }
    return { bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1, ...(result.data.session ? { session: result.data.session } : {}) };
  }
  const result = version === 3 ? evolvedFileSchema.safeParse(input) : fileSchema.safeParse(input);
  if (!result.success) {
    if (version !== 1 && version !== 2 && version !== 3) throw new Error("Versão de arquivo não suportada.");
    throw new Error("O arquivo de simulação contém dados inválidos ou incompletos.");
  }

  const { bodies, settings } = result.data;
  try {
    validateSimulationState(bodies, settings);
    if (version === 3) validateEvolutionMetadata(bodies, settings);
  } catch {
    throw new Error("O arquivo de simulação contém dados inválidos.");
  }
  return { bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1 };
}

function validateEvolutionMetadata(bodies: readonly CelestialBody[], settings: PhysicsSettings): void {
  const sun = bodies.find((body) => body.stellarEvolution !== undefined);
  if (!sun?.stellarEvolution) return;
  const { ageYears, accretedMassKg, absorbedBodyIds, mode } = sun.stellarEvolution;
  if (!Number.isFinite(ageYears) || ageYears < SOLAR_EVOLUTION_START_AGE_YEARS || ageYears > SOLAR_EVOLUTION_END_AGE_YEARS
    || !Number.isFinite(accretedMassKg) || accretedMassKg < 0 || accretedMassKg > SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG) {
    throw new Error("Metadata solar fora dos limites do modelo.");
  }
  const presetMasses = new Map(createSolarSystem().map((body) => [body.id, body.massKg]));
  const expectedAccretedMass = absorbedBodyIds.reduce((sum, id) => {
    const mass = presetMasses.get(id);
    if (mass === undefined || id === "sun" || bodies.some((body) => body.id === id)) throw new Error("Ledger de engolfamento inválido.");
    return sum + mass;
  }, 0);
  if (Math.abs(accretedMassKg - expectedAccretedMass) > Math.max(1, expectedAccretedMass) * 1e-12) {
    throw new Error("Massa acumulada não corresponde ao ledger de engolfamento.");
  }
  if (mode === "manual") return;
  const properties = getSolarEvolutionProperties(ageYears, accretedMassKg);
  const expectedBodyType = properties.primaryEep === 1710 ? "white-dwarf" : "star";
  if (sun.bodyType !== expectedBodyType || !checkSolarEvolutionEligibility(bodies, settings, ageYears).eligible) {
    throw new Error("Estado secular diverge do modelo solar ou não é elegível.");
  }
}
