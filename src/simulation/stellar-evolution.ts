// Stable Core entry point retained for Worker and UI consumers.
export {
  SOLAR_EVOLUTION_MODEL,
  SOLAR_EVOLUTION_START_AGE_YEARS,
  SOLAR_EVOLUTION_END_AGE_YEARS,
  SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG,
  SolarEvolutionError,
  getSolarEvolutionTrackSample,
  getSolarTrackKnotsBetween,
  getSolarTrackAgeAtEep,
  getSolarEvolutionProperties,
  getSolarWindMassLostKg,
  stellarLuminosityW,
  stellarIrradianceWm2,
  createSolarEvolutionCandidate,
  setSolarEvolutionModeCandidate,
} from "./stellar-evolution-model";
export type {
  SolarEvolutionStage,
  SolarTrackSample,
  SolarEvolutionProperties,
  SolarEvolutionEvent,
  SolarEvolutionEligibility,
  SolarEvolutionAgeResult,
} from "./stellar-evolution-model";
export { checkSolarEvolutionEligibility, advanceSolarEvolutionAge } from "./stellar-evolution-secular";
export { getBodyRadiusLimitM, getWorldPositionLimitM, hasSolarEvolutionProfile } from "./stellar-evolution-limits";
export { getMainSequenceProperties, MAIN_SEQUENCE_MASS_MIN_SOLAR, MAIN_SEQUENCE_MASS_MAX_SOLAR, STELLAR_STRUCTURE_MODEL_ID } from "./stellar-main-sequence";
export type { MainSequenceProperties } from "./stellar-main-sequence";
