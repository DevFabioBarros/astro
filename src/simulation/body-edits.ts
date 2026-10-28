import { getBodyType, schwarzschildRadius } from "./body-catalog";
import { validateSimulationState } from "./physics";
import { getBodyRadiusLimitM, getWorldPositionLimitM } from "./stellar-evolution-limits";
import { getSolarEvolutionProperties } from "./stellar-evolution";
import { getMainSequenceProperties, MAIN_SEQUENCE_MASS_MAX_SOLAR, MAIN_SEQUENCE_MASS_MIN_SOLAR, SOLAR_MASS_KG } from "./stellar-main-sequence";
import type { CelestialBody, EditableBodyField, PhysicsSettings } from "./types";
import { getWaterInventoryCapacityKg, setWaterInventory, updateWaterInventoryMass, updateWaterInventoryRadius, updateWaterInventoryTemperature } from "./water-model";
import { MAX_MASS_KG, MAX_POSITION_COMPONENT_M, MAX_RADIUS_M, MAX_SURFACE_TEMPERATURE_K, MAX_VELOCITY_MS } from "./physics";
import { calculateDryMaterialVolumeM3, materialCompositionFromFractions, materialCompositionVolumeM3, type DryMaterialFractions } from "./material-profiles";
import { getRetainedWaterKg, WATER_DENSITY_KG_M3, getWaterInventoryMetrics } from "./water-model";
import { SimulationError } from "./types";

function gameplayWaterRetentionV1(temperatureK: number): number {
  const progress = Math.max(0, Math.min(1, (temperatureK - 373.15) / (378.15 - 373.15)));
  return 1 - progress * progress * (3 - 2 * progress);
}

export function parseBodyEdit(
  field: EditableBodyField,
  text: string,
  limits: { maxRadiusM?: number; maxPositionComponentM?: number } = {},
): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (field === "massKg" && (value <= 0 || value > MAX_MASS_KG)) return null;
  if (field === "radiusM" && (value <= 0 || value > (limits.maxRadiusM ?? MAX_RADIUS_M))) return null;
  if (field === "surfaceTemperatureK" && (value < 0 || value > MAX_SURFACE_TEMPERATURE_K)) return null;
  if (field === "waterFraction" && (value < 0 || value > 1)) return null;
  if (field.startsWith("positionM.") && Math.abs(value) > (limits.maxPositionComponentM ?? MAX_POSITION_COMPONENT_M)) return null;
  if (field.startsWith("velocityMs.") && Math.abs(value) > MAX_VELOCITY_MS) return null;
  return value;
}

export function createBodyEditCandidate(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
  selectedBodyId: string,
  field: EditableBodyField,
  value: number,
): CelestialBody[] {
  const nextBodies = bodies.map((body) => {
    if (body.id !== selectedBodyId) return body;
    if (body.stellarEvolution?.mode === "secular") {
      throw new Error("Pause ou encerre a evolução solar antes de editar o Sol manualmente.");
    }
    if (body.materials && (field === "massKg" || field === "radiusM")) {
      throw new SimulationError("INVALID_BODY", "Use SET_MATERIAL_SIZE para preservar as frações da composição material.");
    }
    const blackHole = getBodyType(body) === "black-hole";
    if (blackHole && field === "surfaceTemperatureK" && value !== 0) {
      throw new Error("Buracos negros não têm temperatura de superfície editável.");
    }
    if (blackHole && field === "waterFraction") {
      throw new Error("Buracos negros não têm água de superfície editável.");
    }
    if (blackHole && (field === "massKg" || field === "radiusM")) {
      const massKg = field === "massKg" ? value : body.massKg;
      return { ...body, massKg, radiusM: schwarzschildRadius(massKg), surfaceTemperatureK: 0 };
    }
    let candidate: CelestialBody;
    if (field === "massKg" && body.waterInventory) {
      candidate = updateWaterInventoryMass(body, value);
    } else if (field === "radiusM" && body.waterInventory) {
      candidate = updateWaterInventoryRadius(body, value);
    } else if (field === "waterFraction" && body.waterInventory) {
      candidate = setWaterInventory(body, value * getWaterInventoryCapacityKg(body));
    } else if (field === "surfaceTemperatureK" && body.waterInventory) {
      candidate = updateWaterInventoryTemperature(body, value);
    } else if (field === "massKg" && getBodyType(body) === "star") {
      if (body.stellarEvolution && getSolarEvolutionProperties(body.stellarEvolution.ageYears).stage !== "main-sequence") {
        throw new Error("A relação de sequência principal não se aplica ao estágio atual da trilha solar.");
      }
      const properties = getMainSequenceProperties(value);
      const manualBody = { ...body };
      delete manualBody.stellarEvolution;
      candidate = { ...manualBody, massKg: value, radiusM: properties.radiusM, surfaceTemperatureK: properties.effectiveTemperatureK };
    } else if (field === "massKg" || field === "radiusM" || field === "surfaceTemperatureK" || field === "waterFraction") {
      candidate = { ...body, [field]: value };
    } else {
      const [property, axisText] = field.split(".") as ["positionM" | "velocityMs", string];
      const vector = [...body[property]] as [number, number, number];
      vector[Number(axisText)] = value;
      candidate = { ...body, [property]: vector };
    }
    if (field === "surfaceTemperatureK" && !body.waterInventory && !body.thermalProfileId) candidate.waterFraction = Math.min(body.waterFraction, gameplayWaterRetentionV1(value));
    if (blackHole) candidate.surfaceTemperatureK = 0;
    if (candidate.kind === "star"
      && ["star", "white-dwarf", "neutron-star"].includes(getBodyType(candidate))
      && candidate.radiusM <= schwarzschildRadius(candidate.massKg)) {
      const blackHole: CelestialBody = { ...candidate, bodyType: "black-hole", radiusM: schwarzschildRadius(candidate.massKg), surfaceTemperatureK: 0 };
      delete blackHole.stellarEvolution;
      return blackHole;
    }
    return candidate;
  });
  validateSimulationState(nextBodies, settings);
  return nextBodies;
}

export function getBodyEditLimits(bodies: readonly CelestialBody[], body: CelestialBody): { maxRadiusM: number; maxPositionComponentM: number } {
  return {
    maxRadiusM: getBodyRadiusLimitM(body, MAX_RADIUS_M),
    maxPositionComponentM: getWorldPositionLimitM(bodies, MAX_POSITION_COMPONENT_M),
  };
}

export function getBodyMassLimits(body: CelestialBody): { minMassKg: number; maxMassKg: number } {
  if (body.kind === "star" && getBodyType(body) === "star") {
    return {
      minMassKg: MAIN_SEQUENCE_MASS_MIN_SOLAR * SOLAR_MASS_KG,
      maxMassKg: MAIN_SEQUENCE_MASS_MAX_SOLAR * SOLAR_MASS_KG,
    };
  }
  return { minMassKg: Number.MIN_VALUE, maxMassKg: MAX_MASS_KG };
}

export function updateBodyEditErrors(errors: readonly string[], key: string, invalid: boolean): string[] {
  if (invalid) return errors.includes(key) ? [...errors] : [...errors, key];
  return errors.filter((error) => error !== key);
}

export function createMaterialCompositionCandidate(
  bodies: readonly CelestialBody[], settings: PhysicsSettings, selectedBodyId: string,
  editMode: "mass-authoritative" | "radius-authoritative", fractions: DryMaterialFractions,
): CelestialBody[] {
  const sum = fractions.rock + fractions.iron + fractions.gas;
  if (Object.keys(fractions).sort().join(",") !== "gas,iron,rock"
    || ![fractions.rock, fractions.iron, fractions.gas].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || Math.abs(sum - 1) > 1e-12
    || (editMode !== "mass-authoritative" && editMode !== "radius-authoritative")) {
    throw new SimulationError("INVALID_BODY", "Frações de material inválidas; informe rocha, ferro e gás entre zero e um, com soma igual a um.");
  }
  let found = false;
  const nextBodies = bodies.map((body) => {
    if (body.id !== selectedBodyId) return body;
    found = true;
    if (body.kind === "star" || ["black-hole", "white-dwarf", "neutron-star", "gas-giant"].includes(getBodyType(body))) {
      throw new SimulationError("INVALID_BODY", "A composição T12 só se aplica a superfícies planetárias rochosas ou lunares.");
    }
    const retainedWaterKg = body.waterInventory ? getRetainedWaterKg(body.waterInventory) : 0;
    let dryMassKg = (body.waterInventory?.dryMassKg ?? body.massKg) - (body.atmosphere?.dryGasMassKg ?? 0);
    let dryVolumeM3: number;
    if (editMode === "mass-authoritative") {
      dryVolumeM3 = calculateDryMaterialVolumeM3(dryMassKg, fractions);
    } else {
      dryVolumeM3 = 4 * Math.PI * body.radiusM ** 3 / 3 - retainedWaterKg / WATER_DENSITY_KG_M3;
      dryMassKg = dryVolumeM3 / calculateDryMaterialVolumeM3(1, fractions);
    }
    const materials = materialCompositionFromFractions(dryMassKg, fractions);
    const candidate: CelestialBody = {
      ...body,
      massKg: dryMassKg + (body.atmosphere?.dryGasMassKg ?? 0) + retainedWaterKg,
      radiusM: Math.cbrt(3 * (dryVolumeM3 + retainedWaterKg / WATER_DENSITY_KG_M3) / (4 * Math.PI)),
      materials,
      ...(body.waterInventory ? { waterInventory: { ...body.waterInventory, dryMassKg: dryMassKg + (body.atmosphere?.dryGasMassKg ?? 0), dryVolumeM3 } } : {}),
    };
    if (editMode === "radius-authoritative") candidate.radiusM = body.radiusM;
    if (candidate.waterInventory) candidate.waterFraction = getWaterInventoryMetrics(candidate).surfaceCoverageFraction;
    return candidate;
  });
  if (!found) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
  validateSimulationState(nextBodies, settings);
  return nextBodies;
}

export function createMaterialSizeCandidate(
  bodies: readonly CelestialBody[], settings: PhysicsSettings, selectedBodyId: string,
  editMode: "mass-authoritative" | "radius-authoritative", value: number,
): CelestialBody[] {
  if (!Number.isFinite(value) || value <= 0
    || (editMode !== "mass-authoritative" && editMode !== "radius-authoritative")) {
    throw new SimulationError("INVALID_BODY", "O tamanho material solicitado está fora dos limites.");
  }
  let found = false;
  const nextBodies = bodies.map((body) => {
    if (body.id !== selectedBodyId) return body;
    found = true;
    if (!body.materials) throw new SimulationError("INVALID_BODY", "SET_MATERIAL_SIZE exige composição explícita. Use SET_MATERIAL_COMPOSITION antes de editar o tamanho.");
    const dryMassBeforeKg = body.materials.rockKg + body.materials.ironKg + body.materials.gasKg;
    const fractions = {
      rock: body.materials.rockKg / dryMassBeforeKg,
      iron: body.materials.ironKg / dryMassBeforeKg,
      gas: body.materials.gasKg / dryMassBeforeKg,
    };
    const retainedWaterKg = body.waterInventory ? getRetainedWaterKg(body.waterInventory) : 0;
    const atmosphericDryGasKg = body.atmosphere?.dryGasMassKg ?? 0;
    let dryMassKg: number;
    let dryVolumeM3: number;
    let massKg: number;
    let radiusM: number;
    if (editMode === "mass-authoritative") {
      massKg = value;
      dryMassKg = massKg - retainedWaterKg - atmosphericDryGasKg;
      if (!(dryMassKg > 0)) throw new SimulationError("INVALID_BODY", "A massa total deve continuar maior que a água retida.");
      const materials = materialCompositionFromFractions(dryMassKg, fractions);
      dryVolumeM3 = materialCompositionVolumeM3(materials);
      radiusM = Math.cbrt(3 * (dryVolumeM3 + retainedWaterKg / WATER_DENSITY_KG_M3) / (4 * Math.PI));
    } else {
      radiusM = value;
      dryVolumeM3 = 4 * Math.PI * radiusM ** 3 / 3 - retainedWaterKg / WATER_DENSITY_KG_M3;
      const specificVolumeM3Kg = calculateDryMaterialVolumeM3(1, fractions);
      dryMassKg = dryVolumeM3 / specificVolumeM3Kg;
      massKg = dryMassKg + atmosphericDryGasKg + retainedWaterKg;
      if (!(dryVolumeM3 > 0) || !(dryMassKg > 0) || !Number.isFinite(massKg)) {
        throw new SimulationError("INVALID_BODY", "O raio alvo não comporta a água retida e uma composição seca válida.");
      }
    }
    const candidate: CelestialBody = {
      ...body, massKg, radiusM,
      materials: materialCompositionFromFractions(dryMassKg, fractions),
      ...(body.waterInventory ? { waterInventory: { ...body.waterInventory, dryMassKg: dryMassKg + atmosphericDryGasKg, dryVolumeM3 } } : {}),
    };
    if (candidate.waterInventory) candidate.waterFraction = getWaterInventoryMetrics(candidate).surfaceCoverageFraction;
    return candidate;
  });
  if (!found) throw new SimulationError("INVALID_BODY", "Este astro não existe mais. Selecione outro astro.");
  validateSimulationState(nextBodies, settings);
  return nextBodies;
}
