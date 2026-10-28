import { SimulationError } from "./types";

export const MAIN_SEQUENCE_MASS_MIN_SOLAR = 0.179;
export const MAIN_SEQUENCE_MASS_MAX_SOLAR = 31;
export const STELLAR_STRUCTURE_MODEL_ID = "eker-2018-main-sequence-solar-anchored-v1" as const;

export const SOLAR_MASS_KG = 1.9884e30;
const SOLAR_RADIUS_M = 695_700_000;
const SOLAR_TEMPERATURE_K = 5772;
const STEFAN_BOLTZMANN_W_M2_K4 = 5.670374419e-8;
const SOLAR_LUMINOSITY_W = 4 * Math.PI * STEFAN_BOLTZMANN_W_M2_K4 * SOLAR_RADIUS_M ** 2 * SOLAR_TEMPERATURE_K ** 4;
const MASS_BREAKS = [0.45, 0.72, 1.05, 2.4, 7, 31] as const;
const MLR_EXPONENTS = [2.028, 4.572, 5.743, 4.329, 3.967, 2.865] as const;

export type MainSequenceProperties = {
  modelId: typeof STELLAR_STRUCTURE_MODEL_ID;
  luminosityW: number;
  radiusM: number;
  effectiveTemperatureK: number;
};

function exponentForMass(massSolar: number): number {
  const index = MASS_BREAKS.findIndex((upper, index) => index < MLR_EXPONENTS.length && massSolar <= upper);
  return MLR_EXPONENTS[index < 0 ? MLR_EXPONENTS.length - 1 : index]!;
}

function logLuminosityRatio(massSolar: number): number {
  let cursor = 1;
  let logRatio = 0;
  const direction = Math.sign(massSolar - cursor);
  while (direction && cursor !== massSolar) {
    const candidates = MASS_BREAKS.filter((point) => direction > 0 ? point > cursor && point < massSolar : point < cursor && point > massSolar);
    const next = candidates.length ? (direction > 0 ? Math.min(...candidates) : Math.max(...candidates)) : massSolar;
    logRatio += exponentForMass((cursor + next) / 2) * Math.log10(next / cursor);
    cursor = next;
  }
  return logRatio;
}

function lowMassRadiusRatio(massSolar: number): number {
  const radiusSolar = 0.438 * massSolar ** 2 + 0.479 * massSolar + 0.075;
  const solarFitRadius = 0.438 + 0.479 + 0.075;
  return radiusSolar / solarFitRadius;
}

export function getMainSequenceProperties(massKg: number): MainSequenceProperties {
  const massSolar = massKg / SOLAR_MASS_KG;
  if (!Number.isFinite(massSolar) || massSolar < MAIN_SEQUENCE_MASS_MIN_SOLAR || massSolar > MAIN_SEQUENCE_MASS_MAX_SOLAR) {
    throw new SimulationError("INVALID_BODY", `A relação estelar de sequência principal aceita ${MAIN_SEQUENCE_MASS_MIN_SOLAR}–${MAIN_SEQUENCE_MASS_MAX_SOLAR} massas solares.`);
  }

  const luminosityW = SOLAR_LUMINOSITY_W * 10 ** logLuminosityRatio(massSolar);
  const lowRadiusRatio = lowMassRadiusRatio(Math.min(massSolar, 1.5));
  const lowTemperatureK = SOLAR_TEMPERATURE_K * (luminosityW / SOLAR_LUMINOSITY_W / lowRadiusRatio ** 2) ** 0.25;
  let radiusM: number;
  let effectiveTemperatureK: number;

  if (massSolar <= 1.5) {
    radiusM = SOLAR_RADIUS_M * lowRadiusRatio;
    effectiveTemperatureK = lowTemperatureK;
  } else {
    const logMass = Math.log10(massSolar);
    const highTemperatureK = 10 ** (-0.170 * logMass ** 2 + 0.888 * logMass + 3.671);
    const blend = Math.max(0, Math.min(1, (massSolar - 1.5) / 0.1));
    const smoothBlend = blend * blend * (3 - 2 * blend);
    effectiveTemperatureK = 10 ** (Math.log10(lowTemperatureK) * (1 - smoothBlend) + Math.log10(highTemperatureK) * smoothBlend);
    radiusM = Math.sqrt(luminosityW / (4 * Math.PI * STEFAN_BOLTZMANN_W_M2_K4 * effectiveTemperatureK ** 4));
  }

  if (![luminosityW, radiusM, effectiveTemperatureK].every(Number.isFinite) || radiusM <= 0 || effectiveTemperatureK <= 0) {
    throw new SimulationError("NUMERIC_OVERFLOW", "As propriedades estelares derivadas não são representáveis.");
  }
  return { modelId: STELLAR_STRUCTURE_MODEL_ID, luminosityW, radiusM, effectiveTemperatureK };
}
