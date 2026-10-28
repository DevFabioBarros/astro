import { classifyWaterPhase } from "./surface-phase";
import { SimulationError } from "./types";
import type { CelestialBody, WaterInventoryState } from "./types";

export const WATER_INVENTORY_MODEL_ID = "water-inventory-v1" as const;
export const WATER_ESCAPE_MODEL_ID = "water-escape-retention-500-1000k-v1" as const;
export const WATER_REFERENCE_LAYER_DEPTH_M = 2_700;
export const WATER_DENSITY_KG_M3 = 1_000;
export const WATER_ESCAPE_START_K = 500;
export const WATER_ESCAPE_COMPLETE_K = 1_000;

export type WaterInventoryMetrics = {
  phase: ReturnType<typeof classifyWaterPhase>;
  retainedWaterKg: number | null;
  escapedWaterKg: number | null;
  capacityKg: number | null;
  availableFraction: number | null;
  surfaceCoverageFraction: number;
  vaporFraction: number;
};

const FOUR_THIRDS_PI = 4 * Math.PI / 3;
const FOUR_PI = 4 * Math.PI;

export function sphereVolumeM3(radiusM: number): number {
  return FOUR_THIRDS_PI * radiusM ** 3;
}

export function sphereRadiusM(volumeM3: number): number {
  return Math.cbrt(volumeM3 / FOUR_THIRDS_PI);
}

export function isWaterInventorySupported(body: Pick<CelestialBody, "id" | "kind" | "bodyType">): boolean {
  if (body.kind === "star" || body.bodyType === "gas-giant" || body.bodyType === "black-hole"
    || body.bodyType === "white-dwarf" || body.bodyType === "neutron-star") return false;
  return !["jupiter", "saturn", "uranus", "neptune"].includes(body.id);
}

export function getWaterInventoryCapacityKg(body: Pick<CelestialBody, "radiusM" | "waterInventory">): number {
  const dryVolumeM3 = body.waterInventory?.dryVolumeM3 ?? sphereVolumeM3(body.radiusM);
  const dryRadiusM = sphereRadiusM(dryVolumeM3);
  return FOUR_PI * dryRadiusM ** 2 * WATER_REFERENCE_LAYER_DEPTH_M * WATER_DENSITY_KG_M3;
}

export function getRetainedWaterKg(inventory: WaterInventoryState): number {
  return inventory.liquidKg + inventory.iceKg + inventory.vaporKg;
}

export function getWaterInventoryMetrics(body: CelestialBody): WaterInventoryMetrics {
  const phase = classifyWaterPhase(body.surfaceTemperatureK);
  const inventory = body.waterInventory;
  if (!inventory) {
    return {
      phase,
      retainedWaterKg: null,
      escapedWaterKg: null,
      capacityKg: null,
      availableFraction: null,
      surfaceCoverageFraction: body.waterFraction,
      vaporFraction: phase === "vapor" ? body.waterFraction : 0,
    };
  }
  const retainedWaterKg = getRetainedWaterKg(inventory);
  const capacityKg = getWaterInventoryCapacityKg(body);
  const surfaceWaterKg = inventory.liquidKg + inventory.iceKg;
  return {
    phase,
    retainedWaterKg,
    escapedWaterKg: inventory.escapedKg,
    capacityKg,
    availableFraction: retainedWaterKg / capacityKg,
    surfaceCoverageFraction: Math.min(1, surfaceWaterKg / capacityKg),
    vaporFraction: Math.min(1, inventory.vaporKg / capacityKg),
  };
}

export function adoptWaterInventory(body: CelestialBody): CelestialBody {
  if (!isWaterInventorySupported(body)) throw new SimulationError("INVALID_BODY", "Este tipo de astro não aceita inventário de água superficial.");
  if (body.waterInventory) return body;
  const dryVolumeM3 = sphereVolumeM3(body.radiusM);
  const capacityKg = FOUR_PI * body.radiusM ** 2 * WATER_REFERENCE_LAYER_DEPTH_M * WATER_DENSITY_KG_M3;
  return setInventoryState(body, {
    modelId: WATER_INVENTORY_MODEL_ID,
    escapeModelId: WATER_ESCAPE_MODEL_ID,
    dryMassKg: body.massKg,
    dryVolumeM3,
    liquidKg: 0,
    iceKg: 0,
    vaporKg: 0,
    escapedKg: 0,
  }, body.waterFraction * capacityKg);
}

export function setWaterInventory(body: CelestialBody, retainedWaterKg: number): CelestialBody {
  if (!body.waterInventory) throw new SimulationError("INVALID_BODY", "Ative o inventário físico de água antes de editá-lo.");
  if (!Number.isFinite(retainedWaterKg) || retainedWaterKg < 0 || retainedWaterKg > getWaterInventoryCapacityKg(body)) {
    throw new SimulationError("INVALID_BODY", "A água disponível deve estar entre zero e uma camada de referência.");
  }
  return setInventoryState(body, body.waterInventory, retainedWaterKg);
}

export function updateWaterInventoryTemperature(body: CelestialBody, temperatureK: number): CelestialBody {
  if (!body.waterInventory) return { ...body, surfaceTemperatureK: temperatureK };
  if (!Number.isFinite(temperatureK) || temperatureK < 0) throw new SimulationError("INVALID_BODY", "Temperatura inválida para o inventário de água.");
  const inventory = body.waterInventory;
  const previousRetainedKg = getRetainedWaterKg(inventory);
  const totalWaterKg = previousRetainedKg + inventory.escapedKg;
  const retainedWaterKg = Math.min(previousRetainedKg, totalWaterKg * retainedFractionAtTemperature(temperatureK));
  return setInventoryState({ ...body, surfaceTemperatureK: temperatureK }, inventory, retainedWaterKg, totalWaterKg);
}

export function updateWaterInventoryMass(body: CelestialBody, totalMassKg: number): CelestialBody {
  if (!body.waterInventory) return { ...body, massKg: totalMassKg };
  const retainedWaterKg = getRetainedWaterKg(body.waterInventory);
  const dryMassKg = totalMassKg - retainedWaterKg;
  if (!(dryMassKg > 0) || !Number.isFinite(dryMassKg)) {
    throw new SimulationError("INVALID_BODY", "A massa total deve continuar maior que a água retida.");
  }
  return { ...body, massKg: totalMassKg, waterInventory: { ...body.waterInventory, dryMassKg } };
}

export function updateWaterInventoryRadius(body: CelestialBody, totalRadiusM: number): CelestialBody {
  if (!body.waterInventory) return { ...body, radiusM: totalRadiusM };
  const totalVolumeM3 = sphereVolumeM3(totalRadiusM);
  const waterVolumeM3 = getRetainedWaterKg(body.waterInventory) / WATER_DENSITY_KG_M3;
  const dryVolumeM3 = totalVolumeM3 - waterVolumeM3;
  if (!(dryVolumeM3 > 0) || !Number.isFinite(dryVolumeM3)) {
    throw new SimulationError("INVALID_BODY", "O raio deve comportar o núcleo seco e a água retida.");
  }
  return setInventoryState(body, { ...body.waterInventory, dryVolumeM3 }, getRetainedWaterKg(body.waterInventory),
    body.waterInventory.escapedKg + getRetainedWaterKg(body.waterInventory), totalRadiusM);
}

export function scaleWaterInventory(body: CelestialBody, fraction: number): WaterInventoryState | undefined {
  if (!body.waterInventory) return undefined;
  return {
    ...body.waterInventory,
    dryMassKg: body.waterInventory.dryMassKg * fraction,
    dryVolumeM3: body.waterInventory.dryVolumeM3 * fraction,
    liquidKg: body.waterInventory.liquidKg * fraction,
    iceKg: body.waterInventory.iceKg * fraction,
    vaporKg: body.waterInventory.vaporKg * fraction,
    escapedKg: body.waterInventory.escapedKg * fraction,
  };
}

export function combineWaterInventories(first: CelestialBody, second: CelestialBody, merged: CelestialBody): CelestialBody {
  if (!first.waterInventory && !second.waterInventory) return merged;
  const firstInventory = first.waterInventory ?? dryInventory(first);
  const secondInventory = second.waterInventory ?? dryInventory(second);
  const combined: WaterInventoryState = {
    modelId: WATER_INVENTORY_MODEL_ID,
    escapeModelId: WATER_ESCAPE_MODEL_ID,
    dryMassKg: firstInventory.dryMassKg + secondInventory.dryMassKg,
    dryVolumeM3: firstInventory.dryVolumeM3 + secondInventory.dryVolumeM3,
    liquidKg: firstInventory.liquidKg + secondInventory.liquidKg,
    iceKg: firstInventory.iceKg + secondInventory.iceKg,
    vaporKg: firstInventory.vaporKg + secondInventory.vaporKg,
    escapedKg: firstInventory.escapedKg + secondInventory.escapedKg,
  };
  return updateWaterInventoryTemperature({ ...merged, waterInventory: combined }, merged.surfaceTemperatureK);
}

export function validateWaterInventory(body: CelestialBody): void {
  const inventory = body.waterInventory;
  if (!inventory) return;
  const values = [inventory.dryMassKg, inventory.dryVolumeM3, inventory.liquidKg, inventory.iceKg, inventory.vaporKg, inventory.escapedKg];
  const keys = Object.keys(inventory).sort();
  if (!isWaterInventorySupported(body) || inventory.modelId !== WATER_INVENTORY_MODEL_ID || inventory.escapeModelId !== WATER_ESCAPE_MODEL_ID
    || keys.join(",") !== "dryMassKg,dryVolumeM3,escapeModelId,escapedKg,iceKg,liquidKg,modelId,vaporKg"
    || !values.every((value) => Number.isFinite(value) && value >= 0)
    || inventory.dryMassKg <= 0 || inventory.dryVolumeM3 <= 0) {
    throw new SimulationError("INVALID_BODY", "O inventário de água é inválido ou incompatível com este astro.");
  }
  const retained = getRetainedWaterKg(inventory);
  const expectedMass = inventory.dryMassKg + retained;
  const expectedRadius = sphereRadiusM(inventory.dryVolumeM3 + retained / WATER_DENSITY_KG_M3);
  const metrics = getWaterInventoryMetrics(body);
  const retentionLimitKg = (retained + inventory.escapedKg) * retainedFractionAtTemperature(body.surfaceTemperatureK);
  const retentionToleranceKg = Math.max(1, retained) * 1e-10;
  const expectedSurface = metrics.phase === "liquid" || metrics.phase === "ice"
    ? Math.min(1, retained / metrics.capacityKg!)
    : 0;
  if (![retained, expectedMass, expectedRadius, metrics.capacityKg, expectedSurface].every(Number.isFinite)
    || !close(body.massKg, expectedMass) || !close(body.radiusM, expectedRadius)
    || !close(body.waterFraction, expectedSurface)) {
    throw new SimulationError("INVALID_BODY", "Massa, raio ou cobertura diverge do inventário de água.");
  }
  if (retained > retentionLimitKg + retentionToleranceKg) {
    throw new SimulationError("INVALID_BODY", "A água retida excede o limite de retenção térmica.");
  }
  const phaseMass = metrics.phase === "ice" ? inventory.iceKg
    : metrics.phase === "liquid" ? inventory.liquidKg
      : metrics.phase === "vapor" ? inventory.vaporKg : Number.NaN;
  if (metrics.phase === "unsupported" || !close(phaseMass, retained)) {
    throw new SimulationError("INVALID_BODY", "As fases não particionam a água retida conforme a temperatura aceita.");
  }
}

function setInventoryState(
  body: CelestialBody,
  previous: WaterInventoryState,
  requestedWaterKg: number,
  totalWaterKg?: number,
  radiusOverrideM?: number,
): CelestialBody {
  if (!Number.isFinite(requestedWaterKg) || requestedWaterKg < 0) throw new SimulationError("INVALID_BODY", "A massa de água deve ser finita e não negativa.");
  const totalEverKg = totalWaterKg ?? previous.escapedKg + getRetainedWaterKg(previous) + Math.max(0, requestedWaterKg - getRetainedWaterKg(previous));
  const retentionLimitedKg = Math.min(requestedWaterKg, totalEverKg * retainedFractionAtTemperature(body.surfaceTemperatureK));
  const escaped = totalEverKg - retentionLimitedKg;
  const phase = classifyWaterPhase(body.surfaceTemperatureK);
  if (phase === "unsupported") throw new SimulationError("INVALID_BODY", "Temperatura sem fase de água suportada.");
  const inventory: WaterInventoryState = {
    ...previous,
    liquidKg: phase === "liquid" ? retentionLimitedKg : 0,
    iceKg: phase === "ice" ? retentionLimitedKg : 0,
    vaporKg: phase === "vapor" ? retentionLimitedKg : 0,
    escapedKg: escaped,
  };
  const massKg = inventory.dryMassKg + retentionLimitedKg;
  const volumeM3 = inventory.dryVolumeM3 + retentionLimitedKg / WATER_DENSITY_KG_M3;
  const radiusM = radiusOverrideM ?? sphereRadiusM(volumeM3);
  const capacityKg = getWaterInventoryCapacityKg({ radiusM: sphereRadiusM(inventory.dryVolumeM3), waterInventory: inventory });
  const surfaceWaterKg = phase === "ice" || phase === "liquid" ? retentionLimitedKg : 0;
  return {
    ...body,
    massKg,
    radiusM,
    waterFraction: Math.min(1, surfaceWaterKg / capacityKg),
    waterInventory: inventory,
  };
}

function dryInventory(body: CelestialBody): WaterInventoryState {
  return {
    modelId: WATER_INVENTORY_MODEL_ID,
    escapeModelId: WATER_ESCAPE_MODEL_ID,
    dryMassKg: body.massKg,
    dryVolumeM3: sphereVolumeM3(body.radiusM),
    liquidKg: 0,
    iceKg: 0,
    vaporKg: 0,
    escapedKg: 0,
  };
}

function retainedFractionAtTemperature(temperatureK: number): number {
  const progress = Math.max(0, Math.min(1, (temperatureK - WATER_ESCAPE_START_K) / (WATER_ESCAPE_COMPLETE_K - WATER_ESCAPE_START_K)));
  return 1 - progress * progress * (3 - 2 * progress);
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-10;
}
