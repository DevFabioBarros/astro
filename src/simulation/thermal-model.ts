import { SimulationError } from "./types";
import type { CelestialBody, ThermalProfileId } from "./types";
import { updateWaterInventoryTemperature } from "./water-model";
import { deriveAtmosphereMetrics } from "./atmosphere-model";

export const EARTHLIKE_GLOBAL_MEAN_PROFILE = {
  id: "earthlike-global-mean-v1",
  bondAlbedo: 0.3,
  effectiveEmissivity: 0.612,
  heatCapacityJm2K: 5e8,
  redistributionFactor: 1,
} as const satisfies { id: ThermalProfileId; bondAlbedo: number; effectiveEmissivity: number; heatCapacityJm2K: number; redistributionFactor: number };

export const THERMAL_PROFILE_MAX_TEMPERATURE_K = 1_000;
export const GREY_ONE_LAYER_BACK_RADIATION_PROFILE = {
  id: "grey-one-layer-back-radiation-v1",
  backRadiationFraction: 0.5,
} as const;
const STEFAN_BOLTZMANN_W_M2_K4 = 5.670374419e-8;
const FOUR_PI = 4 * Math.PI;

export function isThermalProfileId(value: unknown): value is ThermalProfileId {
  return value === EARTHLIKE_GLOBAL_MEAN_PROFILE.id;
}

export function supportsThermalProfile(body: Pick<CelestialBody, "id" | "kind" | "bodyType">): boolean {
  const legacyGasGiant = ["jupiter", "saturn", "uranus", "neptune"].includes(body.id);
  return (body.kind === "planet" && (body.bodyType === "rocky-planet"
    || body.bodyType === undefined && !legacyGasGiant
    || body.bodyType === "asteroid" || body.bodyType === "comet"))
    || (body.kind === "moon" && (body.bodyType === undefined || ["moon", "asteroid", "comet"].includes(body.bodyType)));
}

function absorbedFluxWm2(body: CelestialBody, sources: readonly CelestialBody[]): number {
  let flux = 0;
  for (const source of sources) {
    if (source.id === body.id || source.kind !== "star" || source.bodyType === "black-hole") continue;
    const luminosityW = FOUR_PI * source.radiusM ** 2 * STEFAN_BOLTZMANN_W_M2_K4 * source.surfaceTemperatureK ** 4;
    if (luminosityW === 0) continue;
    const distanceM = Math.hypot(...source.positionM.map((value, axis) => value - body.positionM[axis]!));
    if (!(distanceM > 0) || !Number.isFinite(distanceM)) {
      throw new SimulationError("NUMERIC_OVERFLOW", "Irradiância térmica exige distância estelar finita e positiva.");
    }
    flux += (1 - EARTHLIKE_GLOBAL_MEAN_PROFILE.bondAlbedo) * luminosityW
      / (FOUR_PI * distanceM ** 2 * 4 * EARTHLIKE_GLOBAL_MEAN_PROFILE.redistributionFactor);
    if (!Number.isFinite(flux)) throw new SimulationError("NUMERIC_OVERFLOW", "Fluxo térmico não é representável.");
  }
  return flux;
}

function implicitTemperatureStep(
  initialK: number, absorbedWm2: number, elapsedSeconds: number,
  emissivity: number = EARTHLIKE_GLOBAL_MEAN_PROFILE.effectiveEmissivity,
): number {
  if (initialK === 0 && absorbedWm2 === 0) return 0;
  const capacity = EARTHLIKE_GLOBAL_MEAN_PROFILE.heatCapacityJm2K;
  const residual = (temperatureK: number) => temperatureK - initialK
    - elapsedSeconds / capacity * (absorbedWm2 - emissivity * STEFAN_BOLTZMANN_W_M2_K4 * temperatureK ** 4);
  let low = 0;
  let high = THERMAL_PROFILE_MAX_TEMPERATURE_K;
  const ceilingResidual = residual(high);
  if (!Number.isFinite(ceilingResidual)) throw new SimulationError("NUMERIC_OVERFLOW", "O balanço térmico não é representável.");
  // shortcut: cap at 1,000 K and leave excess flux unresolved; upgrade with an energy ledger.
  if (ceilingResidual < 0) return high;
  for (let iteration = 0; iteration < 56; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (residual(midpoint) > 0) high = midpoint;
    else low = midpoint;
  }
  return (low + high) / 2;
}

/** Advances opted-in global-mean temperatures over the same accepted orbital substep. */
export function advanceThermalTemperatures(
  startBodies: readonly CelestialBody[],
  endBodies: readonly CelestialBody[],
  elapsedSeconds: number,
  gravitationalConstant?: number,
): CelestialBody[] {
  if (elapsedSeconds <= 0) return [...endBodies];
  const previousById = new Map(startBodies.map((body) => [body.id, body]));
  return endBodies.map((body) => {
    if (!body.thermalProfileId) return body;
    const previous = previousById.get(body.id);
    if (!previous?.thermalProfileId) return body;
    const startFlux = absorbedFluxWm2(previous, startBodies);
    const endFlux = absorbedFluxWm2(body, endBodies);
    const meanFlux = startFlux / 2 + endFlux / 2;
    if (!previous.atmosphere || !body.atmosphere) {
      return updateWaterInventoryTemperature(body, implicitTemperatureStep(previous.surfaceTemperatureK, meanFlux, elapsedSeconds));
    }
    if (gravitationalConstant === undefined) {
      throw new SimulationError("INVALID_SETTINGS", "O acoplamento atmosférico exige G aceito pelo mundo.");
    }
    // Isothermal temperature sets atmospheric structure only; it does not enter this radiative closure.
    const q = deriveAtmosphereMetrics(previous, gravitationalConstant).greenhousePotentialAbsorptionFraction;
    const effectiveEmissivity = EARTHLIKE_GLOBAL_MEAN_PROFILE.effectiveEmissivity
      * (1 - GREY_ONE_LAYER_BACK_RADIATION_PROFILE.backRadiationFraction * q);
    return updateWaterInventoryTemperature(body,
      implicitTemperatureStep(previous.surfaceTemperatureK, meanFlux, elapsedSeconds, effectiveEmissivity));
  });
}
