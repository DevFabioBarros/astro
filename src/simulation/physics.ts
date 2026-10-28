import { schwarzschildRadius } from "./physical-constants";
import { validateWaterInventory } from "./water-model";
import { materialCompositionVolumeM3, isMaterialComposition } from "./material-profiles";
import { getRetainedWaterKg, WATER_DENSITY_KG_M3 } from "./water-model";
import { getBodyRadiusLimitM, getWorldPositionLimitM, hasSolarEvolutionProfile, SOLAR_EVOLUTION_END_AGE_YEARS, SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG, SOLAR_EVOLUTION_START_AGE_YEARS } from "./stellar-evolution-limits";
import { isThermalProfileId, supportsThermalProfile, THERMAL_PROFILE_MAX_TEMPERATURE_K } from "./thermal-model";
import { deriveAtmosphereMetrics, validateAtmosphereState } from "./atmosphere-model";
import { isValidSpinState, validateSpinStateForBody } from "./spin-model";
import { SimulationError } from "./types";
import type { CelestialBody, PhysicsSettings, Vector3 } from "./types";

export { SimulationError } from "./types";

const kinds = new Set(["star", "planet", "moon"]);
const bodyTypes = new Set(["star", "white-dwarf", "neutron-star", "black-hole", "rocky-planet", "gas-giant", "moon", "asteroid", "comet"]);

export const MAX_MASS_KG = 1e32;
export const MAX_RADIUS_M = 1e10;
export const MAX_POSITION_COMPONENT_M = 6e12;
export const MAX_VELOCITY_MS = 1e7;
export const MAX_GRAVITATIONAL_CONSTANT = 1;
export const MAX_ACCELERATION_MS2 = 1e6;
export const MAX_SURFACE_TEMPERATURE_K = 1e9;
export const MAX_SIMULATION_BODIES = 64;

export function validateSettings(settings: PhysicsSettings): void {
  if (!Number.isFinite(settings.gravitationalConstant) || settings.gravitationalConstant < 0 || settings.gravitationalConstant > MAX_GRAVITATIONAL_CONSTANT) {
    throw new SimulationError("INVALID_SETTINGS", `Gravitational constant must be between 0 and ${MAX_GRAVITATIONAL_CONSTANT}.`);
  }
}

export function isSafeGravitationalConstant(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_GRAVITATIONAL_CONSTANT;
}

export function validateBodies(bodies: readonly CelestialBody[]): void {
  if (bodies.length > MAX_SIMULATION_BODIES) {
    throw new SimulationError("INVALID_BODY", `A simulação aceita até ${MAX_SIMULATION_BODIES} astros.`);
  }
  const positionLimitM = getWorldPositionLimitM(bodies, MAX_POSITION_COMPONENT_M);
  const ids = new Set<string>();

  for (const body of bodies) {
    if (!body || typeof body.id !== "string" || !body.id.trim() || ids.has(body.id)) {
      throw new SimulationError("INVALID_BODY", "Each body must have a unique, non-empty ID.");
    }
    ids.add(body.id);

    if (typeof body.name !== "string" || !body.name.trim() || !kinds.has(body.kind)) {
      throw new SimulationError("INVALID_BODY", `Body ${body.id} must have a name and supported kind.`);
    }
    if (body.bodyType !== undefined && (!bodyTypes.has(body.bodyType)
      || (["star", "white-dwarf", "neutron-star", "black-hole"].includes(body.bodyType) ? body.kind !== "star" : body.bodyType === "moon" ? body.kind !== "moon" : body.kind !== "planet"))) {
      throw new SimulationError("INVALID_BODY", "O tipo do astro não corresponde à sua categoria.");
    }
    if (body.parentId !== undefined && (typeof body.parentId !== "string" || !body.parentId.trim() || body.parentId === body.id)) {
      throw new SimulationError("INVALID_BODY", "O centro de órbita deve ser outro astro válido.");
    }
    const radiusLimitM = getBodyRadiusLimitM(body, MAX_RADIUS_M);
    if (!Number.isFinite(body.massKg) || body.massKg <= 0 || body.massKg > MAX_MASS_KG || !Number.isFinite(body.radiusM) || body.radiusM <= 0 || body.radiusM > radiusLimitM) {
      throw new SimulationError("INVALID_BODY", `Body ${body.id} mass must be in (0, ${MAX_MASS_KG}] kg and radius in (0, ${radiusLimitM}] m.`);
    }
    if (body.stellarEvolution !== undefined && (!hasSolarEvolutionProfile(body)
      || body.stellarEvolution.modelVersion !== "1.2"
      || !Number.isFinite(body.stellarEvolution.ageYears) || body.stellarEvolution.ageYears < SOLAR_EVOLUTION_START_AGE_YEARS || body.stellarEvolution.ageYears > SOLAR_EVOLUTION_END_AGE_YEARS
      || !Number.isFinite(body.stellarEvolution.accretedMassKg) || body.stellarEvolution.accretedMassKg < 0 || body.stellarEvolution.accretedMassKg > SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG
      || !Array.isArray(body.stellarEvolution.absorbedBodyIds)
      || body.stellarEvolution.absorbedBodyIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(body.stellarEvolution.absorbedBodyIds).size !== body.stellarEvolution.absorbedBodyIds.length
      || (body.stellarEvolution.mode !== "secular" && body.stellarEvolution.mode !== "manual"))) {
      throw new SimulationError("INVALID_BODY", "Solar evolution metadata is invalid or attached to an unsupported body.");
    }
    if (body.bodyType === "black-hole" && Math.abs(body.radiusM - schwarzschildRadius(body.massKg)) > schwarzschildRadius(body.massKg) * 1e-9) {
      throw new SimulationError("INVALID_BODY", "O raio de um buraco negro deve corresponder à sua massa (2GM/c²).");
    }
    if (!isVector3(body.positionM) || !isVector3(body.velocityMs)) {
      throw new SimulationError("INVALID_BODY", `Body ${body.id} must have finite position and velocity vectors.`);
    }
    if (body.positionM.some((value) => Math.abs(value) > positionLimitM)
      || body.velocityMs.some((value) => Math.abs(value) > MAX_VELOCITY_MS)) {
      throw new SimulationError("INVALID_BODY", `Body ${body.id} exceeds supported position limit ${positionLimitM} m or velocity limit ${MAX_VELOCITY_MS} m/s.`);
    }
    if (!Number.isFinite(body.surfaceTemperatureK) || body.surfaceTemperatureK < 0 || body.surfaceTemperatureK > MAX_SURFACE_TEMPERATURE_K) {
      throw new SimulationError("INVALID_BODY", `Body ${body.id} temperature must be between 0 and ${MAX_SURFACE_TEMPERATURE_K} K.`);
    }
    if (body.thermalProfileId !== undefined && (!isThermalProfileId(body.thermalProfileId)
      || !supportsThermalProfile(body) || body.surfaceTemperatureK > THERMAL_PROFILE_MAX_TEMPERATURE_K)) {
      throw new SimulationError("INVALID_BODY", "O perfil térmico exige um corpo rochoso compatível e temperatura de até 1.000 K.");
    }
    if (body.spin !== undefined && !isValidSpinState(body.spin)) {
      throw new SimulationError("INVALID_BODY", "O estado de rotação física é inválido.");
    }
    if (!Number.isFinite(body.waterFraction) || body.waterFraction < 0 || body.waterFraction > 1) {
      throw new SimulationError("INVALID_BODY", `Body ${body.id} water fraction must be between 0 and 1.`);
    }
    validateWaterInventory(body);
    validateAtmosphereState(body);
    if (body.materials !== undefined) {
      const materials = body.materials;
      if (!isMaterialComposition(materials) || body.kind === "star" || body.bodyType === "gas-giant"
        || body.bodyType === "black-hole" || body.bodyType === "white-dwarf" || body.bodyType === "neutron-star") {
        throw new SimulationError("INVALID_BODY", "A composição de materiais é inválida ou incompatível com este astro.");
      }
      const dryMassKg = materials.rockKg + materials.ironKg + materials.gasKg;
      const atmosphericDryGasKg = body.atmosphere?.dryGasMassKg ?? 0;
      const retainedWaterKg = body.waterInventory ? getRetainedWaterKg(body.waterInventory) : 0;
      const expectedDryMassKg = body.waterInventory?.dryMassKg ?? body.massKg - retainedWaterKg;
      const expectedRadiusM = Math.cbrt(3 * (materialCompositionVolumeM3(materials) + retainedWaterKg / WATER_DENSITY_KG_M3) / (4 * Math.PI));
      if (![dryMassKg, expectedRadiusM].every(Number.isFinite)
        || Math.abs(dryMassKg + atmosphericDryGasKg - expectedDryMassKg) > Math.max(1, expectedDryMassKg) * 1e-10
        || Math.abs(body.massKg - (expectedDryMassKg + retainedWaterKg)) > Math.max(1, body.massKg) * 1e-10
        || Math.abs(body.radiusM - expectedRadiusM) > Math.max(1, expectedRadiusM) * 1e-9) {
        throw new SimulationError("INVALID_BODY", "Massa ou raio diverge da composição de materiais aceita.");
      }
    }
  }

}

function isVector3(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function calculateAccelerations(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
): Vector3[] {
  validateSettings(settings);
  validateBodies(bodies);
  for (const body of bodies) {
    if (!body.spin) continue;
    try {
      validateSpinStateForBody(body.spin, body.massKg, body.radiusM, settings.gravitationalConstant);
    } catch (error) {
      throw new SimulationError("INVALID_BODY", error instanceof Error ? error.message : "O spin excede o limite de estabilidade.");
    }
  }
  const accelerations = bodies.map((): [number, number, number] => [0, 0, 0]);
  const gravitationalConstant = settings.gravitationalConstant;

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const first = bodies[i]!;
      const second = bodies[j]!;
      const dx = second.positionM[0] - first.positionM[0];
      const dy = second.positionM[1] - first.positionM[1];
      const dz = second.positionM[2] - first.positionM[2];
      const distance = Math.hypot(dx, dy, dz);

      if (!Number.isFinite(distance)) {
        throw new SimulationError("NUMERIC_OVERFLOW", `Separation between ${first.id} and ${second.id} is not representable.`);
      }
      if (distance === 0) {
        throw new SimulationError("COINCIDENT_BODIES", `Bodies ${first.id} and ${second.id} occupy the same position.`);
      }
      if (gravitationalConstant > 0 && ((first.bodyType === "black-hole" && distance <= 50 * schwarzschildRadius(first.massKg))
        || (second.bodyType === "black-hole" && distance <= 50 * schwarzschildRadius(second.massKg)))) {
        throw new SimulationError("NUMERIC_OVERFLOW", "Encontro muito próximo de um buraco negro: o modelo newtoniano não representa relatividade. Afaste os astros ou reinicie.");
      }
      if (gravitationalConstant === 0) continue;

      const firstStrength = (gravitationalConstant * second.massKg) / distance / distance;
      const secondStrength = (gravitationalConstant * first.massKg) / distance / distance;
      const pair = [dx / distance, dy / distance, dz / distance];

      for (let axis = 0; axis < 3; axis += 1) {
        accelerations[i]![axis] += pair[axis]! * firstStrength;
        accelerations[j]![axis] -= pair[axis]! * secondStrength;
        if (!Number.isFinite(accelerations[i]![axis]) || !Number.isFinite(accelerations[j]![axis])) {
          throw new SimulationError("NUMERIC_OVERFLOW", `Acceleration for ${first.id} or ${second.id} is not finite.`);
        }
      }

      if (Math.hypot(...accelerations[i]!) > MAX_ACCELERATION_MS2 || Math.hypot(...accelerations[j]!) > MAX_ACCELERATION_MS2) {
        throw new SimulationError("NUMERIC_OVERFLOW", `Acceleration exceeds the supported ${MAX_ACCELERATION_MS2} m/s² timestep envelope.`);
      }
    }
  }

  return accelerations;
}

export function validateSimulationState(bodies: readonly CelestialBody[], settings: PhysicsSettings): void {
  calculateAccelerations(bodies, settings);
  for (const body of bodies) {
    if (body.atmosphere) deriveAtmosphereMetrics(body, settings.gravitationalConstant);
  }
}
