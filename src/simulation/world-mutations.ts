import { BODY_TEMPLATES, createCatalogBody, getBodyType } from "./body-catalog";
import { createBodyEditCandidate, createMaterialCompositionCandidate, createMaterialSizeCandidate, parseBodyEdit } from "./body-edits";
import { removeBodyFromWorld } from "./orbital-analysis";
import { advanceSolarEvolutionAge, createSolarEvolutionCandidate, setSolarEvolutionModeCandidate, SOLAR_EVOLUTION_END_AGE_YEARS, SOLAR_EVOLUTION_START_AGE_YEARS } from "./stellar-evolution";
import { MAX_MASS_KG, MAX_POSITION_COMPONENT_M, MAX_SIMULATION_BODIES, MAX_VELOCITY_MS, SimulationError, validateSettings, validateSimulationState } from "./physics";
import { isThermalProfileId, supportsThermalProfile } from "./thermal-model";
import { adoptWaterInventory, scaleWaterInventory, setWaterInventory, updateWaterInventoryTemperature } from "./water-model";
import { isIsothermalAtmosphere } from "./atmosphere-model";
import { isValidSpinState, spinEpochPhaseAtAcceptedTimeRad, spinPhaseAtAcceptedTimeRad } from "./spin-model";
import { applyCenterOfMassImpulse, CENTER_OF_MASS_IMPULSE_MODEL_ID } from "./impulse-model";
import { calculateLaserExposure, GREY_ALBEDO_LASER_PROFILE_ID, isNormalizedLaserDirection, validateLaserExposureParameters } from "./laser-model";
import { addSwarmGroup, createEmptySwarmLedger, deriveSwarmSeedV1, distributeSwarmShares, duplicateSwarmBody, rescaleSwarmBody, retireSwarmBodies, validateSwarmLedger } from "./swarm-model";
import { createOrbitalBody, createOrbitalRing, placeBodyPairInCircularOrbit } from "./orbital-placement";
import { DEFAULT_ENVIRONMENT_SEED_V1, isEnvironmentSeed } from "./world-seed";
import type { BatchScaleBodiesMutation, CelestialBody, EditableBodyField, EnvironmentSeed, PhysicsSettings, SimulationEvent, SwarmLedger, WorldMutation } from "./types";

const EXPLOSION_FRAGMENT_COUNT = 6;
const DEFAULT_ORBITAL_PLANE_NORMAL: [number, number, number] = [0, 0, 1];
const DEFAULT_ORBITAL_RADIAL_DIRECTION: [number, number, number] = [1, 0, 0];
export const DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG = 1e6;
export const MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG = 0.5 * MAX_VELOCITY_MS ** 2;
export const MAX_BATCH_SCALE_TARGETS = 16;

export type ExplosionEnergyPreview = {
  specificEnergyJkg: number;
  kickSpeedMs: number;
  ejectaKineticEnergyJ: number;
  gravitationalBindingEnergyJ: number;
};

function validateExplosionSpecificEnergy(specificEnergyJkg: unknown): asserts specificEnergyJkg is number {
  if (typeof specificEnergyJkg !== "number" || !Number.isFinite(specificEnergyJkg)
    || specificEnergyJkg <= 0 || specificEnergyJkg > MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG) {
    throw new SimulationError("INVALID_BODY", `A energia específica deve ser positiva e no máximo ${MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG} J/kg.`);
  }
}

/** Uniform-sphere self-binding magnitude for reference, not a disruption or escape threshold. */
export function getExplosionEnergyPreview(
  body: Pick<CelestialBody, "massKg" | "radiusM">,
  settings: PhysicsSettings,
  specificEnergyJkg = DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG,
): ExplosionEnergyPreview {
  validateSettings(settings);
  validateExplosionSpecificEnergy(specificEnergyJkg);
  if (!Number.isFinite(body.massKg) || body.massKg <= 0 || !Number.isFinite(body.radiusM) || body.radiusM <= 0) {
    throw new SimulationError("INVALID_BODY", "Massa e raio devem ser finitos e positivos para estimar a explosão.");
  }
  const kickSpeedMs = Math.sqrt(2 * specificEnergyJkg);
  const ejectaKineticEnergyJ = body.massKg * specificEnergyJkg;
  const gravitationalBindingEnergyJ = 3 * settings.gravitationalConstant * body.massKg ** 2 / (5 * body.radiusM);
  if (![kickSpeedMs, ejectaKineticEnergyJ, gravitationalBindingEnergyJ].every(Number.isFinite)) {
    throw new SimulationError("NUMERIC_OVERFLOW", "A energia de explosão não é representável.");
  }
  return { specificEnergyJkg, kickSpeedMs, ejectaKineticEnergyJ, gravitationalBindingEnergyJ };
}

export type WorldMutationContext = { simulationTimeSeconds?: number; swarmLedger?: SwarmLedger; environmentSeed?: EnvironmentSeed };
export type WorldMutationResult = { bodies: CelestialBody[]; settings: PhysicsSettings; swarmLedger: SwarmLedger; event?: Omit<SimulationEvent, "id" | "timeSeconds"> };

export function createExplosionCandidate(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
  bodyId: string,
  specificEnergyJkg = DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG,
): WorldMutationResult {
  const body = bodies.find((candidate) => candidate.id === bodyId);
  if (!body) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
  if (body.spin) {
    throw new SimulationError("UNSUPPORTED_COLLISION", "A fragmentação de um astro com rotação física explícita aguarda um ledger de momento angular. O último estado aceito foi mantido.");
  }
  const bodyType = getBodyType(body);
  if (["black-hole", "neutron-star", "white-dwarf"].includes(bodyType)) {
    throw new SimulationError("INVALID_BODY", "Astros compactos não podem ser fragmentados neste experimento.");
  }
  if (body.kind === "star" && bodyType === "star") {
    validateSettings(settings);
    validateExplosionSpecificEnergy(specificEnergyJkg);
    validateSimulationState(bodies, settings);
    return { bodies: [...bodies], settings, swarmLedger: createEmptySwarmLedger(), event: {
      type: "explosion", positionM: body.positionM, radiusM: body.radiusM,
      energyJ: 0, bodyIds: [bodyId], visualEffect: "stellar-gas-expansion",
    } };
  }
  if (bodies.length + EXPLOSION_FRAGMENT_COUNT - 1 > MAX_SIMULATION_BODIES) {
    throw new SimulationError("INVALID_BODY", `A fragmentação excederia o limite de ${MAX_SIMULATION_BODIES} astros.`);
  }

  const { kickSpeedMs } = getExplosionEnergyPreview(body, settings, specificEnergyJkg);
  const fragmentMass = body.massKg / EXPLOSION_FRAGMENT_COUNT;
  const fragmentMasses = Array.from({ length: EXPLOSION_FRAGMENT_COUNT - 1 }, () => fragmentMass);
  fragmentMasses.push(body.massKg - fragmentMass * (EXPLOSION_FRAGMENT_COUNT - 1));
  const fragmentRadius = body.radiusM / Math.cbrt(EXPLOSION_FRAGMENT_COUNT);
  // Preserve the profile's areal thermal reservoir as total fragment area grows.
  const fragmentTemperatureK = body.thermalProfileId
    ? body.surfaceTemperatureK / Math.cbrt(EXPLOSION_FRAGMENT_COUNT)
    : body.surfaceTemperatureK;
  const offset = fragmentRadius * 2;
  const kickSpeed = kickSpeedMs;
  if (!Number.isFinite(offset) || !Number.isFinite(kickSpeed)) {
    throw new SimulationError("NUMERIC_OVERFLOW", "A energia de fragmentação não é representável.");
  }

  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
  const existingIds = new Set(bodies.map(({ id }) => id));
  let generation = 1;
  let fragmentIds: string[];
  do {
    fragmentIds = directions.map((_, index) => `${body.id}-fragment-${generation}-${index + 1}`);
    generation += 1;
  } while (fragmentIds.some((id) => existingIds.has(id)));

  const weightedOffset = directions.reduce((sum, direction, index) => sum.map((value, axis) => value
    + fragmentMasses[index]! * direction[axis]! * offset / body.massKg), [0, 0, 0]);
  const weightedKick = directions.reduce((sum, direction, index) => sum.map((value, axis) => value
    + fragmentMasses[index]! * direction[axis]! * kickSpeed / body.massKg), [0, 0, 0]);
  const balancedKicks = directions.map((direction) => direction.map((value, axis) => value * kickSpeed - weightedKick[axis]!));
  for (let axis = 0; axis < 3; axis += 1) {
    const precedingMomentum = fragmentMasses.slice(0, -1).reduce((sum, mass, index) => sum
      + mass * (body.velocityMs[axis]! + balancedKicks[index]![axis]!), 0);
    balancedKicks[EXPLOSION_FRAGMENT_COUNT - 1]![axis] = (body.massKg * body.velocityMs[axis]! - precedingMomentum)
      / fragmentMasses[EXPLOSION_FRAGMENT_COUNT - 1]! - body.velocityMs[axis]!;
  }
  const fragments: CelestialBody[] = directions.map((direction, index) => {
    const positionM = body.positionM.map((value, axis) => value + direction[axis]! * offset - weightedOffset[axis]!) as [number, number, number];
    const velocityMs = body.velocityMs.map((value, axis) => value + balancedKicks[index]![axis]!) as [number, number, number];
    if (positionM.some((value) => Math.abs(value) > MAX_POSITION_COMPONENT_M)
      || velocityMs.some((value) => Math.abs(value) > MAX_VELOCITY_MS)) {
      throw new SimulationError("INVALID_BODY", "A fragmentação excederia os limites de posição ou velocidade.");
    }
    const fragment: CelestialBody = {
      ...body,
      id: fragmentIds[index]!,
      name: `${body.name} fragmento ${index + 1}`,
      massKg: fragmentMasses[index]!,
      radiusM: fragmentRadius,
      surfaceTemperatureK: fragmentTemperatureK,
      positionM,
      velocityMs,
    };
    if (body.materials) {
      const fraction = fragmentMasses[index]! / body.massKg;
      fragment.materials = {
        ...body.materials,
        rockKg: body.materials.rockKg * fraction,
        ironKg: body.materials.ironKg * fraction,
        gasKg: body.materials.gasKg * fraction,
      };
    }
    if (body.atmosphere) {
      const fraction = fragmentMasses[index]! / body.massKg;
      fragment.atmosphere = { ...body.atmosphere, dryGasMassKg: body.atmosphere.dryGasMassKg * fraction };
    }
    const waterInventory = scaleWaterInventory(body, fragmentMasses[index]! / body.massKg);
    if (!waterInventory) return fragment;
    fragment.waterInventory = waterInventory;
    return updateWaterInventoryTemperature(fragment, fragmentTemperatureK);
  });
  const remaining = removeBodyFromWorld(bodies, bodyId);
  const candidate = [...remaining, ...fragments];
  validateSimulationState(candidate, settings);
  const energyJ = fragments.reduce((sum, fragment) => sum + 0.5 * fragment.massKg
    * fragment.velocityMs.reduce((speedSquared, velocity, axis) => speedSquared + (velocity - body.velocityMs[axis]!) ** 2, 0), 0);
  if (!Number.isFinite(energyJ)) throw new SimulationError("NUMERIC_OVERFLOW", "A energia de fragmentação não é representável.");
  return {
    bodies: candidate,
    settings,
    swarmLedger: createEmptySwarmLedger(),
    event: { type: "explosion", positionM: body.positionM, radiusM: body.radiusM, energyJ, bodyIds: [bodyId, ...fragmentIds] },
  };
}

export function validateWorldMutation(input: unknown): asserts input is WorldMutation {
  if (typeof input !== "object" || input === null) throw new SimulationError("INVALID_BODY", "A alteração solicitada é inválida.");
  const value = input as Record<string, unknown>;
  const idValid = typeof value.bodyId === "string" && value.bodyId.trim().length > 0;
  const validVector = (vector: unknown, limit: number) => Array.isArray(vector) && vector.length === 3
    && vector.every((component) => typeof component === "number" && Number.isFinite(component) && Math.abs(component) <= limit);
  const exactOrbitalKeys = (keys: readonly string[]) => {
    const ownKeys = Reflect.ownKeys(value);
    const hasNormal = Object.hasOwn(value, "planeNormal");
    const hasRadial = Object.hasOwn(value, "radialDirection");
    return hasNormal === hasRadial && ownKeys.length === keys.length + (hasNormal ? 2 : 0)
      && ownKeys.every((key) => typeof key === "string" && (keys.includes(key) || key === "planeNormal" || key === "radialDirection"));
  };
  const validOrbitalAxes = () => {
    const hasNormal = Object.hasOwn(value, "planeNormal");
    const hasRadial = Object.hasOwn(value, "radialDirection");
    if (!hasNormal && !hasRadial) return true;
    if (!hasNormal || !hasRadial || !validVector(value.planeNormal, 1e9) || !validVector(value.radialDirection, 1e9)) return false;
    const normal = value.planeNormal as [number, number, number];
    const radial = value.radialDirection as [number, number, number];
    const normalMagnitude = Math.hypot(...normal);
    const radialMagnitude = Math.hypot(...radial);
    const dot = normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2];
    return normalMagnitude > 0 && radialMagnitude > 0 && Math.abs(dot) <= normalMagnitude * radialMagnitude * 1e-9;
  };
  if (value.type === "CREATE_ORBITAL_BODY" && exactOrbitalKeys(["type", "bodyType", "primaryId", "semiMajorAxisM"])
    && BODY_TEMPLATES.some((entry) => entry.type === value.bodyType) && typeof value.primaryId === "string" && value.primaryId.trim()
    && typeof value.semiMajorAxisM === "number" && Number.isFinite(value.semiMajorAxisM)
    && validOrbitalAxes()) return;
  if (value.type === "SET_ORBITAL_PAIR" && exactOrbitalKeys(["type", "firstBodyId", "secondBodyId", "separationM"])
    && typeof value.firstBodyId === "string" && !!value.firstBodyId.trim() && typeof value.secondBodyId === "string" && !!value.secondBodyId.trim()
    && value.firstBodyId !== value.secondBodyId && typeof value.separationM === "number" && Number.isFinite(value.separationM)
    && validOrbitalAxes()) return;
  if (value.type === "CREATE_ORBITAL_RING" && exactOrbitalKeys(["type", "primaryId", "innerRadiusM", "outerRadiusM", "representativeCount", "totalMassKg", "profileId"])
    && typeof value.primaryId === "string" && !!value.primaryId.trim()
    && typeof value.innerRadiusM === "number" && Number.isFinite(value.innerRadiusM)
    && typeof value.outerRadiusM === "number" && Number.isFinite(value.outerRadiusM)
    && Number.isSafeInteger(value.representativeCount) && typeof value.totalMassKg === "number" && Number.isFinite(value.totalMassKg)
    && typeof value.profileId === "string" && ["rock-v1", "iron-v1", "water-ice-v1", "gas-v1"].includes(value.profileId)
    && validOrbitalAxes()) return;
  if (value.type === "BATCH_SCALE_BODIES") {
    const ownKeys = Reflect.ownKeys(value);
    const exact = ownKeys.length === 4 && ownKeys.every((key) => typeof key === "string"
      && ["type", "bodyIds", "field", "factor"].includes(key));
    const ids = value.bodyIds;
    if (exact && Array.isArray(ids) && ids.length >= 2 && ids.length <= MAX_BATCH_SCALE_TARGETS
      && ids.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 128)
      && new Set(ids).size === ids.length && (value.field === "massKg" || value.field === "radiusM")
      && (value.factor === 2 || value.factor === 0.5)) return;
  }
  if ((value.type === "REMOVE_BODY" || value.type === "EXPLODE_BODY") && idValid) {
    if (value.type === "EXPLODE_BODY" && value.specificEnergyJkg !== undefined) {
      validateExplosionSpecificEnergy(value.specificEnergyJkg);
    }
    return;
  }
  if (value.type === "DUPLICATE_BODY" && idValid
    && validVector(value.positionM, MAX_POSITION_COMPONENT_M)
    && (value.velocityMs === undefined || validVector(value.velocityMs, MAX_VELOCITY_MS))) return;
  if (value.type === "CREATE_BODY" && BODY_TEMPLATES.some((entry) => entry.type === value.bodyType)
    && (value.primaryId === null || typeof value.primaryId === "string" && value.primaryId.trim())) {
    if ((value.positionM === undefined || validVector(value.positionM, MAX_POSITION_COMPONENT_M))
      && (value.velocityMs === undefined || validVector(value.velocityMs, MAX_VELOCITY_MS))) return;
  }
  if (value.type === "SET_SETTINGS" && typeof value.settings === "object" && value.settings !== null) {
    validateSettings(value.settings as PhysicsSettings); return;
  }
  if (value.type === "SET_THERMAL_PROFILE" && idValid && (value.profileId === null || isThermalProfileId(value.profileId))) return;
  if ((value.type === "ADOPT_WATER_INVENTORY" || value.type === "SET_WATER_INVENTORY") && idValid) {
    if (value.type === "ADOPT_WATER_INVENTORY") return;
    if (typeof value.retainedWaterKg === "number" && Number.isFinite(value.retainedWaterKg)
      && value.retainedWaterKg >= 0 && value.retainedWaterKg <= MAX_MASS_KG) return;
  }
  if (value.type === "SET_MATERIAL_COMPOSITION" && idValid
    && (value.editMode === "mass-authoritative" || value.editMode === "radius-authoritative")
    && typeof value.dryFractions === "object" && value.dryFractions !== null) {
    const fractions = value.dryFractions as Record<string, unknown>;
    const parts = [fractions.rock, fractions.iron, fractions.gas];
    if (Object.keys(fractions).sort().join(",") === "gas,iron,rock"
      && parts.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 1)
      && Math.abs((fractions.rock as number) + (fractions.iron as number) + (fractions.gas as number) - 1) <= 1e-12) return;
  }
  if (value.type === "SET_ATMOSPHERE" && idValid) {
    const ownKeys = Reflect.ownKeys(value);
    const exactMutation = ownKeys.length === 3 && ownKeys.every((key) => typeof key === "string"
      && ["type", "bodyId", "atmosphere"].includes(key));
    if (exactMutation && (value.atmosphere === null || isIsothermalAtmosphere(value.atmosphere))) return;
  }
  if (value.type === "SET_BODY_SPIN" && idValid) {
    const ownKeys = Reflect.ownKeys(value);
    const exactMutation = ownKeys.length === 3 && ownKeys.every((key) => typeof key === "string"
      && ["type", "bodyId", "spin"].includes(key));
    if (exactMutation && (value.spin === null || isValidSpinState(value.spin))) return;
  }
  if (value.type === "APPLY_IMPULSE" && idValid) {
    const ownKeys = Reflect.ownKeys(value);
    const exactMutation = ownKeys.length === 3 && ownKeys.every((key) => typeof key === "string"
      && ["type", "bodyId", "impulseNs"].includes(key));
    const impulseNs = value.impulseNs;
    if (exactMutation && Array.isArray(impulseNs) && impulseNs.length === 3
      && impulseNs.every((component) => typeof component === "number" && Number.isFinite(component))
      && impulseNs.some((component) => component !== 0)) return;
  }
  if (value.type === "APPLY_LASER" && idValid) {
    const ownKeys = Reflect.ownKeys(value);
    const exactMutation = ownKeys.length === 6 && ownKeys.every((key) => typeof key === "string"
      && ["type", "bodyId", "bodyLocalDirection", "powerW", "durationAcceptedSeconds", "profileId"].includes(key));
    if (exactMutation && value.profileId === GREY_ALBEDO_LASER_PROFILE_ID && isNormalizedLaserDirection(value.bodyLocalDirection)) {
      try {
        validateLaserExposureParameters(value.powerW as number, value.durationAcceptedSeconds as number, value.profileId);
        return;
      } catch { /* Reject the whole malformed mutation below. */ }
    }
  }
  if (value.type === "SET_MATERIAL_SIZE" && idValid) {
    const expectedKeys = value.editMode === "mass-authoritative"
      ? ["type", "bodyId", "editMode", "massKg"]
      : value.editMode === "radius-authoritative"
        ? ["type", "bodyId", "editMode", "radiusM"]
        : null;
    const ownKeys = Reflect.ownKeys(value);
    const hasExactKeys = expectedKeys !== null && ownKeys.length === expectedKeys.length
      && ownKeys.every((key) => typeof key === "string" && expectedKeys.includes(key));
    if (hasExactKeys && value.editMode === "mass-authoritative" && typeof value.massKg === "number"
      && parseBodyEdit("massKg", String(value.massKg)) !== null) return;
    if (hasExactKeys && value.editMode === "radius-authoritative" && typeof value.radiusM === "number"
      && parseBodyEdit("radiusM", String(value.radiusM)) !== null) return;
  }
  if (value.type === "EDIT_BODY" && idValid && typeof value.field === "string"
    && /^(massKg|radiusM|surfaceTemperatureK|waterFraction|positionM\.[012]|velocityMs\.[012])$/.test(value.field)
    && typeof value.value === "number" && parseBodyEdit(value.field as EditableBodyField, String(value.value)) !== null) return;
  if (value.type === "INIT_SOLAR_EVOLUTION" || value.type === "EXIT_SOLAR_EVOLUTION") return;
  if (value.type === "ADVANCE_SOLAR_AGE" && typeof value.ageYears === "number"
    && Number.isFinite(value.ageYears) && value.ageYears >= SOLAR_EVOLUTION_START_AGE_YEARS
    && value.ageYears <= SOLAR_EVOLUTION_END_AGE_YEARS) return;
  throw new SimulationError("INVALID_BODY", "A alteração solicitada contém parâmetros inválidos.");
}

export function applyWorldMutation(bodies: readonly CelestialBody[], settings: PhysicsSettings, mutation: WorldMutation, context: number | WorldMutationContext = 0): WorldMutationResult {
  validateWorldMutation(mutation);
  const options: WorldMutationContext = typeof context === "number" ? { simulationTimeSeconds: context } : context;
  const simulationTimeSeconds = options.simulationTimeSeconds ?? 0;
  let swarmLedger = options.swarmLedger ?? createEmptySwarmLedger();
  const environmentSeed = isEnvironmentSeed(options.environmentSeed) ? options.environmentSeed : DEFAULT_ENVIRONMENT_SEED_V1;
  let nextBodies = [...bodies];
  let nextSettings = settings;
  let event: WorldMutationResult["event"];
  if (mutation.type === "BATCH_SCALE_BODIES") {
    nextBodies = applyBatchScale(bodies, settings, mutation);
  } else if (mutation.type === "EDIT_BODY" || mutation.type === "REMOVE_BODY") {
    if (!bodies.some((body) => body.id === mutation.bodyId)) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    nextBodies = mutation.type === "EDIT_BODY" ? createBodyEditCandidate(bodies, settings, mutation.bodyId, mutation.field, mutation.value) : removeBodyFromWorld(bodies, mutation.bodyId);
    if (mutation.type === "REMOVE_BODY") swarmLedger = retireSwarmBodies(swarmLedger, [mutation.bodyId]);
  } else if (mutation.type === "APPLY_IMPULSE") {
    const target = bodies.find((candidate) => candidate.id === mutation.bodyId);
    if (!target) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    const impulse = applyCenterOfMassImpulse(target, mutation.impulseNs);
    nextBodies = bodies.map((candidate) => candidate.id === mutation.bodyId ? impulse.body : candidate);
    event = {
      type: "impulse", positionM: target.positionM, radiusM: target.radiusM,
      energyJ: Math.abs(impulse.externalWorkJ), bodyIds: [target.id],
      impulse: { modelId: CENTER_OF_MASS_IMPULSE_MODEL_ID, deltaVelocityMs: impulse.deltaVelocityMs,
        impulseNs: impulse.impulseNs, externalWorkJ: impulse.externalWorkJ },
    };
  } else if (mutation.type === "APPLY_LASER") {
    const target = bodies.find((candidate) => candidate.id === mutation.bodyId);
    if (!target) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    const exposure = calculateLaserExposure(target, mutation.powerW, mutation.durationAcceptedSeconds, mutation.profileId);
    nextBodies = [...bodies];
    event = {
      type: "laser", positionM: target.positionM, radiusM: target.radiusM,
      energyJ: exposure.inputJ, bodyIds: [target.id],
      laser: {
        modelId: "laser-energy-ledger-v1", profileId: exposure.profileId,
        bodyLocalDirection: mutation.bodyLocalDirection, powerW: mutation.powerW,
        durationAcceptedSeconds: mutation.durationAcceptedSeconds, albedo: exposure.albedo,
        inputJ: exposure.inputJ, absorbedJ: exposure.absorbedJ, reflectedJ: exposure.reflectedJ,
      },
    };
  } else if (mutation.type === "EXPLODE_BODY") {
    const candidate = createExplosionCandidate(bodies, settings, mutation.bodyId, mutation.specificEnergyJkg);
    nextBodies = candidate.bodies;
    const fragments = nextBodies.filter((body) => body.id.startsWith(`${mutation.bodyId}-fragment-`));
    swarmLedger = distributeSwarmShares(swarmLedger, mutation.bodyId, fragments, nextBodies);
    event = candidate.event;
  } else if (mutation.type === "CREATE_BODY") {
    const pose = mutation.positionM || mutation.velocityMs
      ? {
          positionM: mutation.positionM ?? [0, 0, 0],
          velocityMs: mutation.velocityMs ?? [0, 0, 0],
        } as const
      : undefined;
    nextBodies.push(createCatalogBody(mutation.bodyType, bodies, mutation.primaryId, settings, pose));
  } else if (mutation.type === "DUPLICATE_BODY") {
    const source = bodies.find((body) => body.id === mutation.bodyId);
    if (!source) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    if (bodies.length >= MAX_SIMULATION_BODIES) throw new SimulationError("INVALID_BODY", `A simulação aceita até ${MAX_SIMULATION_BODIES} astros.`);
    let serial = 1;
    let id: string, name: string;
    do {
      id = `${source.id}-copy-${serial}`;
      name = `${source.name} (cópia ${serial})`;
      serial += 1;
    } while (bodies.some((body) => body.id === id || body.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()));
    const duplicate: CelestialBody = {
      ...source,
      bodyType: source.bodyType ?? getBodyType(source),
      id,
      name,
      positionM: mutation.positionM,
      velocityMs: mutation.velocityMs ?? source.velocityMs,
      ...(source.waterInventory ? { waterInventory: { ...source.waterInventory } } : {}),
    };
    delete duplicate.parentId;
    delete duplicate.stellarEvolution;
    nextBodies.push(duplicate);
    swarmLedger = duplicateSwarmBody(swarmLedger, source.id, duplicate);
  } else if (mutation.type === "CREATE_ORBITAL_BODY") {
    nextBodies = createOrbitalBody(bodies, mutation.bodyType, mutation.primaryId, mutation.semiMajorAxisM,
      mutation.planeNormal ?? DEFAULT_ORBITAL_PLANE_NORMAL, mutation.radialDirection ?? DEFAULT_ORBITAL_RADIAL_DIRECTION, settings);
  } else if (mutation.type === "SET_ORBITAL_PAIR") {
    nextBodies = placeBodyPairInCircularOrbit(bodies, mutation.firstBodyId, mutation.secondBodyId,
      mutation.separationM, mutation.planeNormal ?? DEFAULT_ORBITAL_PLANE_NORMAL, mutation.radialDirection ?? DEFAULT_ORBITAL_RADIAL_DIRECTION, settings);
  } else if (mutation.type === "CREATE_ORBITAL_RING") {
    const sequence = swarmLedger.nextSequence;
    const groupId = `orbital-swarm-${sequence + 1}`;
    const created = createOrbitalRing(bodies, mutation.primaryId, {
      innerRadiusM: mutation.innerRadiusM, outerRadiusM: mutation.outerRadiusM,
      representativeCount: mutation.representativeCount, totalMassKg: mutation.totalMassKg,
      profileId: mutation.profileId, seed: deriveSwarmSeedV1(environmentSeed, sequence),
      planeNormal: mutation.planeNormal, radialDirection: mutation.radialDirection, swarmId: groupId,
    }, settings);
    nextBodies = created.bodies;
    swarmLedger = addSwarmGroup(swarmLedger, created.particles, { environmentSeed, profileId: mutation.profileId });
  } else if (mutation.type === "SET_MATERIAL_SIZE") {
    nextBodies = createMaterialSizeCandidate(bodies, settings, mutation.bodyId, mutation.editMode,
      mutation.editMode === "mass-authoritative" ? mutation.massKg : mutation.radiusM);
  } else if (mutation.type === "SET_MATERIAL_COMPOSITION") {
    nextBodies = createMaterialCompositionCandidate(bodies, settings, mutation.bodyId, mutation.editMode, mutation.dryFractions);
  } else if (mutation.type === "SET_ATMOSPHERE") {
    const body = bodies.find((candidate) => candidate.id === mutation.bodyId);
    if (!body) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    if (!body.materials) throw new SimulationError("INVALID_BODY", "Atmosfera exige composição explícita; adote composição antes de editar.");
    const materialDryMassKg = body.materials.rockKg + body.materials.ironKg + body.materials.gasKg;
    const dryMassKg = materialDryMassKg + (mutation.atmosphere?.dryGasMassKg ?? 0);
    const retainedWaterKg = body.waterInventory
      ? body.waterInventory.liquidKg + body.waterInventory.iceKg + body.waterInventory.vaporKg : 0;
    nextBodies = bodies.map((candidate) => {
      if (candidate.id !== mutation.bodyId) return candidate;
      const updated = { ...candidate, massKg: dryMassKg + retainedWaterKg };
      if (mutation.atmosphere) updated.atmosphere = mutation.atmosphere;
      else delete updated.atmosphere;
      if (updated.waterInventory) updated.waterInventory = { ...updated.waterInventory, dryMassKg };
      return updated;
    });
  } else if (mutation.type === "SET_BODY_SPIN") {
    const source = bodies.find((candidate) => candidate.id === mutation.bodyId);
    if (!source) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    if (swarmLedger.bodyMassShares[source.id]?.length) {
      throw new SimulationError("UNSUPPORTED_COLLISION", "A rotação explícita de uma partícula do enxame aguarda ledger de momento angular. Nenhuma alteração foi aplicada.");
    }
    const acceptedPhase = source.spin ? spinPhaseAtAcceptedTimeRad(source.spin, simulationTimeSeconds) : 0;
    const rebasedSpin = mutation.spin ? { ...mutation.spin, phaseAtEpochRad: spinEpochPhaseAtAcceptedTimeRad(
      acceptedPhase, mutation.spin.angularVelocityRadPerS, simulationTimeSeconds) } : null;
    nextBodies = bodies.map((candidate) => {
      if (candidate.id !== mutation.bodyId) return candidate;
      const updated = { ...candidate };
      if (!rebasedSpin) delete updated.spin;
      else updated.spin = rebasedSpin;
      return updated;
    });
  } else if (mutation.type === "SET_THERMAL_PROFILE") {
    const body = bodies.find((candidate) => candidate.id === mutation.bodyId);
    if (!body) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    if (mutation.profileId !== null && !supportsThermalProfile(body)) {
      throw new SimulationError("INVALID_BODY", "O perfil térmico está disponível somente para superfícies rochosas.");
    }
    nextBodies = bodies.map((candidate) => {
      if (candidate.id !== mutation.bodyId) return candidate;
      const updated = { ...candidate };
      if (mutation.profileId === null) delete updated.thermalProfileId;
      else updated.thermalProfileId = mutation.profileId;
      return updated;
    });
  } else if (mutation.type === "ADOPT_WATER_INVENTORY" || mutation.type === "SET_WATER_INVENTORY") {
    const body = bodies.find((candidate) => candidate.id === mutation.bodyId);
    if (!body) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
    const updated = mutation.type === "ADOPT_WATER_INVENTORY"
      ? adoptWaterInventory(body)
      : setWaterInventory(body, mutation.retainedWaterKg);
    nextBodies = bodies.map((candidate) => candidate.id === mutation.bodyId ? updated : candidate);
  } else if (mutation.type === "SET_SETTINGS") nextSettings = mutation.settings;
  else if (mutation.type === "INIT_SOLAR_EVOLUTION") nextBodies = createSolarEvolutionCandidate(bodies);
  else if (mutation.type === "ADVANCE_SOLAR_AGE") nextBodies = advanceSolarEvolutionAge(bodies, mutation.ageYears, settings).bodies;
  else if (mutation.type === "EXIT_SOLAR_EVOLUTION") nextBodies = setSolarEvolutionModeCandidate(bodies, "manual");
  for (const body of nextBodies) {
    const previous = bodies.find(({ id }) => id === body.id);
    if (previous && previous.massKg !== body.massKg) swarmLedger = rescaleSwarmBody(swarmLedger, body.id, previous.massKg, body.massKg);
  }
  validateSwarmLedger(swarmLedger, nextBodies);
  validateSimulationState(nextBodies, nextSettings);
  return event ? { bodies: nextBodies, settings: nextSettings, swarmLedger, event } : { bodies: nextBodies, settings: nextSettings, swarmLedger };
}

function applyBatchScale(bodies: readonly CelestialBody[], settings: PhysicsSettings, mutation: BatchScaleBodiesMutation): CelestialBody[] {
  const replacements = new Map<string, CelestialBody>();
  for (const bodyId of mutation.bodyIds) {
    const body = bodies.find((candidate) => candidate.id === bodyId);
    if (!body) throw new SimulationError("INVALID_BODY", "Um dos astros do lote não existe mais. Nenhuma alteração foi aplicada.");
    const field = mutation.field;
    const value = body[field] * mutation.factor;
    const replacement = body.materials
      ? createMaterialSizeCandidate([body], settings, body.id, field === "massKg" ? "mass-authoritative" : "radius-authoritative", value)[0]!
      : createBodyEditCandidate([body], settings, body.id, field, value)[0]!;
    replacements.set(bodyId, replacement);
  }
  const candidate = bodies.map((body) => replacements.get(body.id) ?? body);
  validateSimulationState(candidate, settings);
  return candidate;
}
