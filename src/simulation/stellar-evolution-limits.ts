import type { CelestialBody } from "./types";

export const SOLAR_EVOLUTION_START_AGE_YEARS = 4.58e9;
export const SOLAR_EVOLUTION_END_AGE_YEARS = 11_465_471_475.297028;
export const SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG = 1.9884e26;
export const SOLAR_PROFILE_MAX_RADIUS_M = 3e11;
export const SOLAR_PROFILE_MAX_POSITION_COMPONENT_M = 1e13;

export function hasSolarEvolutionProfile(body: Pick<CelestialBody, "id" | "kind" | "stellarEvolution">): boolean {
  return body.id === "sun" && body.kind === "star"
    && body.stellarEvolution?.modelId === "mist-v1.2-solar-1msun-nonrotating";
}

export function getBodyRadiusLimitM(body: Pick<CelestialBody, "id" | "kind" | "stellarEvolution">, defaultLimitM: number): number {
  return hasSolarEvolutionProfile(body) ? SOLAR_PROFILE_MAX_RADIUS_M : defaultLimitM;
}

export function getWorldPositionLimitM(bodies: readonly Pick<CelestialBody, "id" | "kind" | "stellarEvolution">[], defaultLimitM: number): number {
  return bodies.some((body) => !!body && hasSolarEvolutionProfile(body)) ? SOLAR_PROFILE_MAX_POSITION_COMPONENT_M : defaultLimitM;
}
