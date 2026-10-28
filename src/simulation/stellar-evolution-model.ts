import solarTrack from "./solar-track-v1.json";
import { hasSolarEvolutionProfile, SOLAR_EVOLUTION_END_AGE_YEARS, SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG as MAX_SOLAR_EVOLUTION_ACCRETED_MASS_KG, SOLAR_EVOLUTION_START_AGE_YEARS, SOLAR_PROFILE_MAX_POSITION_COMPONENT_M, SOLAR_PROFILE_MAX_RADIUS_M } from "./stellar-evolution-limits";
import { createSolarSystem } from "./solar-system";
import type { CelestialBody, Vector3 } from "./types";

export const MODEL_ID = "mist-v1.2-solar-1msun-nonrotating" as const;
export const MODEL_VERSION = "1.2" as const;
export const SOLAR_MASS_KG = 1.9884e30;
const SOLAR_RADIUS_M = 695_700_000;
const SOLAR_TEMPERATURE_K = 5772;
const STEFAN_BOLTZMANN_W_M2_K4 = 5.670374419e-8;
export const SECONDS_PER_YEAR = 31_557_600;
export const MAX_ACCRETED_MASS_KG = MAX_SOLAR_EVOLUTION_ACCRETED_MASS_KG;
export const MAX_PERTURBATION_RATIO = 0.01;
export const MAX_ADIABATIC_RATIO = 0.1;
export const MIN_ECCENTRICITY_FOR_PERIAPSIS_AXIS = 1e-9;
const PRIMARY_EEPS = solarTrack.metadata.primaryEeps;
const SOLAR_PRESET = createSolarSystem();
export const PRESET_BY_ID = new Map(SOLAR_PRESET.map((body) => [body.id, body]));
export const INITIAL_SYSTEM_MASS_KG = SOLAR_PRESET.reduce((sum, body) => sum + body.massKg, 0);

export const SOLAR_EVOLUTION_MODEL = {
  id: MODEL_ID,
  version: MODEL_VERSION,
  sourceUrl: solarTrack.metadata.sourceUrl,
  sourceArchiveSha256: solarTrack.metadata.sourceArchiveSha256,
  sourceTrackSha256: solarTrack.metadata.sourceTrackSha256,
  sourceMember: solarTrack.metadata.sourceMember,
  initialMassSolar: 1,
  metallicityFeH: 0,
  alphaFe: 0,
  rotationVcrit: 0,
  sourcePointCount: solarTrack.metadata.sourceHeader.pointCount,
  sourceEepCount: solarTrack.metadata.sourceHeader.eepCount,
  sourceColumnCount: solarTrack.metadata.sourceHeader.columnCount,
  primaryEeps: PRIMARY_EEPS,
  maxRadiusM: SOLAR_PROFILE_MAX_RADIUS_M,
  maxPositionComponentM: SOLAR_PROFILE_MAX_POSITION_COMPONENT_M,
} as const;

export { SOLAR_EVOLUTION_START_AGE_YEARS, SOLAR_EVOLUTION_END_AGE_YEARS };
export const SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG = MAX_ACCRETED_MASS_KG;

export type SolarEvolutionStage =
  | "main-sequence"
  | "red-giant-branch"
  | "core-helium-burning"
  | "early-asymptotic-giant-branch"
  | "thermally-pulsing-asymptotic-giant-branch"
  | "post-asymptotic-giant-branch"
  | "white-dwarf-formation";

export type SolarTrackSample = {
  ageYears: number;
  trackEep: number;
  primaryEep?: number;
  massSolar: number;
  logLuminositySolar: number;
  logRadiusSolar: number;
  fspsPhase: number;
  stage: SolarEvolutionStage;
};

export type SolarEvolutionProperties = SolarTrackSample & {
  massKg: number;
  radiusM: number;
  luminosityRatio: number;
  luminosityW: number;
  effectiveTemperatureK: number;
  coversExtendedWhiteDwarfCooling: false;
};

export type SolarEvolutionEvent =
  | { type: "stellar-wind"; ageFromYears: number; ageToYears: number; massLostKg: number; momentumKgMs: Vector3 }
  | { type: "engulfment"; ageYears: number; bodyIds: string[]; massAccretedKg: number; momentumKgMs: Vector3 };

export type SolarEvolutionEligibility = {
  eligible: boolean;
  reason?: string;
  maxPerturbationRatio?: number;
  maxAdiabaticRatio?: number;
};

export type SolarEvolutionAgeResult = {
  bodies: CelestialBody[];
  events: SolarEvolutionEvent[];
  stellarWindMassLostKg: number;
};

export class SolarEvolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolarEvolutionError";
  }
}

function sourceRow(index: number): SolarTrackSample {
  const row = solarTrack.rows[index]!;
  const trackEep = index + 1;
  const primaryEep = PRIMARY_EEPS.includes(trackEep) ? trackEep : undefined;
  return {
    ageYears: row[0],
    trackEep,
    ...(primaryEep === undefined ? {} : { primaryEep }),
    massSolar: row[1],
    logLuminositySolar: row[2],
    logRadiusSolar: row[3],
    fspsPhase: row[4],
    stage: stageForEep(trackEep),
  };
}

function stageForEep(eep: number): SolarEvolutionStage {
  if (eep >= 1710) return "white-dwarf-formation";
  if (eep >= 1409) return "post-asymptotic-giant-branch";
  if (eep >= 808) return "thermally-pulsing-asymptotic-giant-branch";
  if (eep >= 707) return "early-asymptotic-giant-branch";
  if (eep >= 631) return "core-helium-burning";
  if (eep >= 454) return "red-giant-branch";
  return "main-sequence";
}

function lowerBoundAge(ageYears: number): number {
  let low = 0;
  let high = solarTrack.rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (solarTrack.rows[middle]![0] < ageYears) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function getSolarEvolutionTrackSample(ageYears: number): SolarTrackSample {
  if (!Number.isFinite(ageYears) || ageYears < solarTrack.rows[0]![0] || ageYears > SOLAR_EVOLUTION_END_AGE_YEARS) {
    throw new SolarEvolutionError(`Idade fora da trilha MIST: ${ageYears} anos.`);
  }
  const rightIndex = lowerBoundAge(ageYears);
  if (rightIndex === 0) return sourceRow(0);
  if (rightIndex >= solarTrack.rows.length) return sourceRow(solarTrack.rows.length - 1);
  const right = solarTrack.rows[rightIndex]!;
  if (right[0] === ageYears) return sourceRow(rightIndex);
  const left = solarTrack.rows[rightIndex - 1]!;
  const fraction = (ageYears - left[0]) / (right[0] - left[0]);
  const trackEep = rightIndex + fraction;
  const primaryEep = Number.isInteger(trackEep) && PRIMARY_EEPS.includes(trackEep) ? trackEep : undefined;
  return {
    ageYears,
    trackEep,
    ...(primaryEep === undefined ? {} : { primaryEep }),
    massSolar: lerp(left[1], right[1], fraction),
    logLuminositySolar: lerp(left[2], right[2], fraction),
    logRadiusSolar: lerp(left[3], right[3], fraction),
    fspsPhase: fraction < 1 ? left[4] : right[4],
    stage: stageForEep(trackEep),
  };
}

export function getSolarTrackAgeAtEep(trackEep: number): number {
  if (!Number.isFinite(trackEep) || trackEep < 1 || trackEep > solarTrack.rows.length) {
    throw new SolarEvolutionError(`EEP fora da trilha MIST: ${trackEep}.`);
  }
  const leftIndex = Math.floor(trackEep) - 1;
  const fraction = trackEep - Math.floor(trackEep);
  if (fraction === 0) return solarTrack.rows[leftIndex]![0];
  return lerp(solarTrack.rows[leftIndex]![0], solarTrack.rows[leftIndex + 1]![0], fraction);
}

export function getSolarTrackKnotsBetween(startAgeYears: number, endAgeYears: number): SolarTrackSample[] {
  if (endAgeYears < startAgeYears) throw new SolarEvolutionError("A idade final deve ser posterior à idade inicial.");
  const start = getSolarEvolutionTrackSample(startAgeYears);
  const end = getSolarEvolutionTrackSample(endAgeYears);
  const firstInterior = lowerBoundAge(startAgeYears);
  const knots = [start];
  for (let index = firstInterior; index < solarTrack.rows.length; index += 1) {
    const ageYears = solarTrack.rows[index]![0];
    if (ageYears >= endAgeYears) break;
    if (ageYears > startAgeYears) knots.push(sourceRow(index));
  }
  if (endAgeYears !== startAgeYears) knots.push(end);
  return knots;
}

const ANCHOR_SAMPLE = getSolarEvolutionTrackSample(SOLAR_EVOLUTION_START_AGE_YEARS);
const ANCHOR_LUMINOSITY_W = 4 * Math.PI * STEFAN_BOLTZMANN_W_M2_K4 * SOLAR_RADIUS_M ** 2 * SOLAR_TEMPERATURE_K ** 4;

export function getSolarEvolutionProperties(ageYears: number, accretedMassKg = 0): SolarEvolutionProperties {
  if (!Number.isFinite(ageYears) || ageYears < SOLAR_EVOLUTION_START_AGE_YEARS || ageYears > SOLAR_EVOLUTION_END_AGE_YEARS) {
    throw new SolarEvolutionError(`Idade fora do domínio evolutivo solar: ${ageYears} anos.`);
  }
  if (!Number.isFinite(accretedMassKg) || accretedMassKg < 0 || accretedMassKg > MAX_ACCRETED_MASS_KG) {
    throw new SolarEvolutionError("A massa acumulada por acreção excede o limite do modelo solar.");
  }
  const sample = getSolarEvolutionTrackSample(ageYears);
  const luminosityRatio = 10 ** (sample.logLuminositySolar - ANCHOR_SAMPLE.logLuminositySolar);
  const radiusRatio = 10 ** (sample.logRadiusSolar - ANCHOR_SAMPLE.logRadiusSolar);
  const radiusM = SOLAR_RADIUS_M * radiusRatio;
  const effectiveTemperatureK = SOLAR_TEMPERATURE_K * (luminosityRatio / radiusRatio ** 2) ** 0.25;
  return {
    ...sample,
    massKg: SOLAR_MASS_KG * sample.massSolar / ANCHOR_SAMPLE.massSolar + accretedMassKg,
    radiusM,
    luminosityRatio,
    luminosityW: ANCHOR_LUMINOSITY_W * luminosityRatio,
    effectiveTemperatureK,
    coversExtendedWhiteDwarfCooling: false,
  };
}

export function stellarLuminosityW(star: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK">): number {
  if (!Number.isFinite(star.radiusM) || star.radiusM <= 0 || !Number.isFinite(star.surfaceTemperatureK) || star.surfaceTemperatureK < 0) {
    throw new SolarEvolutionError("Raio e temperatura estelares devem ser finitos para derivar luminosidade.");
  }
  return 4 * Math.PI * STEFAN_BOLTZMANN_W_M2_K4 * star.radiusM ** 2 * star.surfaceTemperatureK ** 4;
}

export function stellarIrradianceWm2(
  star: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK" | "positionM">,
  target: Pick<CelestialBody, "positionM">,
): number {
  const distanceM = Math.hypot(...star.positionM.map((value, axis) => value - target.positionM[axis]!));
  if (!Number.isFinite(distanceM) || distanceM <= 0) throw new SolarEvolutionError("A distância estrela-alvo deve ser positiva e finita.");
  return stellarLuminosityW(star) / (4 * Math.PI * distanceM ** 2);
}

export function getSolarWindMassLostKg(ageYears: number): number {
  return SOLAR_MASS_KG - getSolarEvolutionProperties(ageYears).massKg;
}

export function createSolarEvolutionCandidate(bodies: readonly CelestialBody[]): CelestialBody[] {
  const expectedIds = [...PRESET_BY_ID.keys()].sort();
  const actualIds = bodies.map(({ id }) => id).sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new SolarEvolutionError("A evolução solar exige o preset Sol, oito planetas e Lua, sem corpos extras.");
  }
  for (const body of bodies) {
    const preset = PRESET_BY_ID.get(body.id)!;
    if (body.kind !== preset.kind || body.massKg !== preset.massKg || body.radiusM !== preset.radiusM || body.stellarEvolution) {
      throw new SolarEvolutionError("Restaure massas e raios do preset antes de iniciar a evolução solar.");
    }
  }
  return bodies.map((body) => body.id === "sun"
    ? {
      ...body,
      massKg: SOLAR_MASS_KG,
      radiusM: SOLAR_RADIUS_M,
      surfaceTemperatureK: SOLAR_TEMPERATURE_K,
      bodyType: "star",
      stellarEvolution: {
        modelId: MODEL_ID,
        modelVersion: MODEL_VERSION,
        ageYears: SOLAR_EVOLUTION_START_AGE_YEARS,
        accretedMassKg: 0,
        absorbedBodyIds: [],
        mode: "secular",
      },
    }
    : body);
}

export function setSolarEvolutionModeCandidate(bodies: readonly CelestialBody[], mode: "secular" | "manual"): CelestialBody[] {
  if (!bodies.some((body) => hasSolarEvolutionProfile(body))) throw new SolarEvolutionError("Este mundo não possui um perfil solar para mudar de modo.");
  return bodies.map((body) => body.id === "sun" && body.stellarEvolution
    ? { ...body, stellarEvolution: { ...body.stellarEvolution, absorbedBodyIds: [...body.stellarEvolution.absorbedBodyIds], mode } }
    : body);
}


function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
