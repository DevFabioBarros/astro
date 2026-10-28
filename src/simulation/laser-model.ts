import { SimulationError } from "./types";
import type { CelestialBody } from "./types";

export const GREY_ALBEDO_LASER_PROFILE_ID = "grey-albedo-laser-absorption-v1" as const;
export const GREY_ALBEDO_LASER_ALBEDO = 0.3;
export const MAX_LASER_POWER_W = 1e15;
export const MAX_LASER_DURATION_SECONDS = 60;
export const MAX_LASER_ENERGY_J = 6e16;

export type LaserExposure = {
  profileId: typeof GREY_ALBEDO_LASER_PROFILE_ID;
  albedo: number;
  inputJ: number;
  absorbedJ: number;
  reflectedJ: number;
};

export function isLaserShotAllowedForRevision(
  lastShotRevision: number | null,
  requestedRevision: number,
  acceptedRevision: number,
  worldChangePending = false,
): boolean {
  return !worldChangePending && Number.isSafeInteger(requestedRevision)
    && requestedRevision === acceptedRevision && lastShotRevision !== acceptedRevision;
}

export function isNormalizedLaserDirection(value: unknown): value is readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => typeof component === "number" && Number.isFinite(component))) return false;
  const length = Math.hypot(value[0], value[1], value[2]);
  return Number.isFinite(length) && Math.abs(length - 1) <= 1e-6;
}

export function validateLaserExposureParameters(
  powerW: number,
  durationAcceptedSeconds: number,
  profileId: string,
): LaserExposure {
  if (profileId !== GREY_ALBEDO_LASER_PROFILE_ID) {
    throw new SimulationError("INVALID_BODY", "Selecione um perfil de absorção de laser conhecido.");
  }
  if (!Number.isFinite(powerW) || powerW <= 0 || powerW > MAX_LASER_POWER_W
    || !Number.isFinite(durationAcceptedSeconds) || durationAcceptedSeconds <= 0 || durationAcceptedSeconds > MAX_LASER_DURATION_SECONDS) {
    throw new SimulationError("INVALID_BODY", `Potência e duração devem ser finitas, positivas e limitadas a ${MAX_LASER_POWER_W} W e ${MAX_LASER_DURATION_SECONDS} s aceitos.`);
  }
  const inputJ = powerW * durationAcceptedSeconds;
  if (!Number.isFinite(inputJ) || inputJ <= 0 || inputJ > MAX_LASER_ENERGY_J) {
    throw new SimulationError("NUMERIC_OVERFLOW", `A energia do laser deve ser finita e no máximo ${MAX_LASER_ENERGY_J} J.`);
  }
  const absorbedJ = inputJ * (1 - GREY_ALBEDO_LASER_ALBEDO);
  const reflectedJ = inputJ - absorbedJ;
  if (![absorbedJ, reflectedJ].every(Number.isFinite) || absorbedJ + reflectedJ !== inputJ) {
    throw new SimulationError("NUMERIC_OVERFLOW", "O ledger de energia do laser não fecha numericamente.");
  }
  return { profileId: GREY_ALBEDO_LASER_PROFILE_ID, albedo: GREY_ALBEDO_LASER_ALBEDO, inputJ, absorbedJ, reflectedJ };
}

export function calculateLaserExposure(
  body: CelestialBody,
  powerW: number,
  durationAcceptedSeconds: number,
  profileId: string,
): LaserExposure {
  if (!body.materials || body.materials.modelId !== "material-composition-v1") {
    throw new SimulationError("INVALID_BODY", "O laser exige composição material explícita; corpos legacy não recebem perfil presumido.");
  }
  return validateLaserExposureParameters(powerW, durationAcceptedSeconds, profileId);
}
