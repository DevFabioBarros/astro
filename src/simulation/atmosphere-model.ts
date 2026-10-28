import { SimulationError } from "./types";
import type { AtmosphereProfileId, CelestialBody, IsothermalAtmosphere } from "./types";

export const ATMOSPHERE_MODEL_ID = "isothermal-atmosphere-v1" as const;
export const MAX_ATMOSPHERIC_DRY_MASS_KG = 1e32;
export const MIN_ISOTHERMAL_TEMPERATURE_K = 1;
export const MAX_ISOTHERMAL_TEMPERATURE_K = 1_000;
export const MAX_SCALE_HEIGHT_TO_RADIUS_RATIO = 0.05;
export const UNIVERSAL_GAS_CONSTANT_J_MOL_K = 8.31446261815324;
export const WATER_VAPOR_MOLAR_MASS_KG_MOL = 0.01801528;
export const ATMOSPHERE_PROFILE_IDS = ["nitrogen-oxygen-v1", "carbon-dioxide-v1"] as const;
export const GREENHOUSE_DIAGNOSTIC_MODEL_ID = "grey-column-optical-depth-v1" as const;
// Versioned H2O coefficients are uncalibrated optical proxies, not measured spectra.
export const WATER_VAPOR_OPTICAL_PROFILE = {
  id: "water-vapor-optics-v1",
  visualExtinctionCoefficientM2Kg: 2e-5,
  longwaveAbsorptionCoefficientM2Kg: 2e-2,
} as const;

export type AtmosphereProfile = {
  id: AtmosphereProfileId;
  molarMassKgMol: number;
  visualExtinctionCoefficientM2Kg: number;
  longwaveAbsorptionCoefficientM2Kg: number;
};

// Versioned profile coefficients are uncalibrated shader and diagnostic proxies, not measured spectra.
export const ATMOSPHERE_PROFILES: Readonly<Record<AtmosphereProfileId, AtmosphereProfile>> = {
  "nitrogen-oxygen-v1": {
    id: "nitrogen-oxygen-v1", molarMassKgMol: 0.02897,
    visualExtinctionCoefficientM2Kg: 1e-5, longwaveAbsorptionCoefficientM2Kg: 5e-5,
  },
  "carbon-dioxide-v1": {
    id: "carbon-dioxide-v1", molarMassKgMol: 0.04401,
    visualExtinctionCoefficientM2Kg: 1e-4, longwaveAbsorptionCoefficientM2Kg: 1e-3,
  },
};

const profileIds = new Set<string>(ATMOSPHERE_PROFILE_IDS);

export function isIsothermalAtmosphere(value: unknown): value is IsothermalAtmosphere {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const atmosphere = value as Record<string, unknown>;
  return Reflect.ownKeys(atmosphere).length === 4
    && Reflect.ownKeys(atmosphere).every((key) => typeof key === "string"
      && ["modelId", "profileId", "dryGasMassKg", "isothermalTemperatureK"].includes(key))
    && atmosphere.modelId === ATMOSPHERE_MODEL_ID
    && typeof atmosphere.profileId === "string" && profileIds.has(atmosphere.profileId)
    && typeof atmosphere.dryGasMassKg === "number" && Number.isFinite(atmosphere.dryGasMassKg)
    && atmosphere.dryGasMassKg > 0 && atmosphere.dryGasMassKg <= MAX_ATMOSPHERIC_DRY_MASS_KG
    && typeof atmosphere.isothermalTemperatureK === "number" && Number.isFinite(atmosphere.isothermalTemperatureK)
    && atmosphere.isothermalTemperatureK >= MIN_ISOTHERMAL_TEMPERATURE_K
    && atmosphere.isothermalTemperatureK <= MAX_ISOTHERMAL_TEMPERATURE_K;
}

export function validateAtmosphereState(body: CelestialBody): void {
  if (body.atmosphere === undefined) return;
  if (!body.materials || !isIsothermalAtmosphere(body.atmosphere)) {
    throw new SimulationError("INVALID_BODY", "Atmosfera exige composição explícita e estado isotérmico válido.");
  }
}

export type AtmosphereMetrics = {
  profile: AtmosphereProfile;
  columnMassKg: number;
  effectiveMolarMassKgMol: number;
  surfaceGravityMs2: number;
  surfacePressurePa: number;
  scaleHeightM: number;
  scaleHeightToRadiusRatio: number;
  columnMassKgM2: number;
  dryColumnMassKgM2: number;
  vaporColumnMassKgM2: number;
  waterVaporOpticalProfileId: typeof WATER_VAPOR_OPTICAL_PROFILE.id;
  dryVisualOpticalDepth: number;
  vaporVisualOpticalDepth: number;
  visualOpticalDepth: number;
  visualOpacityFraction: number;
  greenhouseDiagnosticModelId: typeof GREENHOUSE_DIAGNOSTIC_MODEL_ID;
  dryLongwaveOpticalDepth: number;
  vaporLongwaveOpticalDepth: number;
  greenhouseOpticalDepth: number;
  greenhousePotentialAbsorptionFraction: number;
  pressureAtAltitudePa: (altitudeM: number) => number;
  densityAtAltitudeKgM3: (altitudeM: number) => number;
  assumptions: readonly ["thin-shell", "constant-gravity", "well-mixed-isothermal-ideal-gas"];
};

export function deriveAtmosphereMetrics(body: CelestialBody, gravitationalConstant: number): AtmosphereMetrics {
  const atmosphere = body.atmosphere;
  if (!atmosphere || !isIsothermalAtmosphere(atmosphere) || !body.materials) {
    throw new SimulationError("INVALID_BODY", "Métricas atmosféricas exigem estado isotérmico materializado.");
  }
  if (!Number.isFinite(gravitationalConstant) || gravitationalConstant <= 0) {
    throw new SimulationError("INVALID_BODY", "A aproximação hidrostática exige gravidade superficial positiva.");
  }
  const profile = ATMOSPHERE_PROFILES[atmosphere.profileId];
  const vaporKg = body.waterInventory?.vaporKg ?? 0;
  const columnMassKg = atmosphere.dryGasMassKg + vaporKg;
  const moleAmountMol = atmosphere.dryGasMassKg / profile.molarMassKgMol + vaporKg / WATER_VAPOR_MOLAR_MASS_KG_MOL;
  const effectiveMolarMassKgMol = columnMassKg / moleAmountMol;
  const surfaceGravityMs2 = gravitationalConstant * body.massKg / body.radiusM ** 2;
  const surfacePressurePa = columnMassKg * surfaceGravityMs2 / (4 * Math.PI * body.radiusM ** 2);
  const scaleHeightM = UNIVERSAL_GAS_CONSTANT_J_MOL_K * atmosphere.isothermalTemperatureK
    / (effectiveMolarMassKgMol * surfaceGravityMs2);
  const scaleHeightToRadiusRatio = scaleHeightM / body.radiusM;
  if (![columnMassKg, moleAmountMol, effectiveMolarMassKgMol, surfaceGravityMs2, surfacePressurePa,
    scaleHeightM, scaleHeightToRadiusRatio]
    .every((value) => Number.isFinite(value) && value > 0)) {
    throw new SimulationError("NUMERIC_OVERFLOW", "O estado hidrostático está fora do domínio numérico.");
  }
  if (scaleHeightToRadiusRatio > MAX_SCALE_HEIGHT_TO_RADIUS_RATIO) {
    throw new SimulationError("INVALID_BODY", "A escala de altura excede o domínio de casca fina (H/radius ≤ 0,05).");
  }
  const columnMassKgM2 = columnMassKg / (4 * Math.PI * body.radiusM ** 2);
  const dryColumnMassKgM2 = atmosphere.dryGasMassKg / (4 * Math.PI * body.radiusM ** 2);
  const vaporColumnMassKgM2 = vaporKg / (4 * Math.PI * body.radiusM ** 2);
  const dryVisualOpticalDepth = profile.visualExtinctionCoefficientM2Kg * dryColumnMassKgM2;
  const vaporVisualOpticalDepth = WATER_VAPOR_OPTICAL_PROFILE.visualExtinctionCoefficientM2Kg * vaporColumnMassKgM2;
  const visualOpticalDepth = dryVisualOpticalDepth + vaporVisualOpticalDepth;
  const dryLongwaveOpticalDepth = profile.longwaveAbsorptionCoefficientM2Kg * dryColumnMassKgM2;
  const vaporLongwaveOpticalDepth = WATER_VAPOR_OPTICAL_PROFILE.longwaveAbsorptionCoefficientM2Kg * vaporColumnMassKgM2;
  const greenhouseOpticalDepth = dryLongwaveOpticalDepth + vaporLongwaveOpticalDepth;
  const visualOpacityFraction = 1 - Math.exp(-visualOpticalDepth);
  const greenhousePotentialAbsorptionFraction = 1 - Math.exp(-greenhouseOpticalDepth);
  if (![columnMassKgM2, dryColumnMassKgM2, vaporColumnMassKgM2, dryVisualOpticalDepth, vaporVisualOpticalDepth,
    visualOpticalDepth, dryLongwaveOpticalDepth, vaporLongwaveOpticalDepth, greenhouseOpticalDepth, visualOpacityFraction,
    greenhousePotentialAbsorptionFraction].every(Number.isFinite)) {
    throw new SimulationError("NUMERIC_OVERFLOW", "As métricas ópticas atmosféricas não são representáveis.");
  }
  const pressureAtAltitudePa = (altitudeM: number) => {
    if (!Number.isFinite(altitudeM) || altitudeM < 0) throw new SimulationError("INVALID_BODY", "Altitude deve ser finita e não negativa.");
    return surfacePressurePa * Math.exp(-altitudeM / scaleHeightM);
  };
  return {
    profile, columnMassKg, effectiveMolarMassKgMol, surfaceGravityMs2, surfacePressurePa, scaleHeightM,
    scaleHeightToRadiusRatio, columnMassKgM2, dryColumnMassKgM2, vaporColumnMassKgM2,
    waterVaporOpticalProfileId: WATER_VAPOR_OPTICAL_PROFILE.id,
    dryVisualOpticalDepth, vaporVisualOpticalDepth, visualOpticalDepth, visualOpacityFraction,
    greenhouseDiagnosticModelId: GREENHOUSE_DIAGNOSTIC_MODEL_ID,
    dryLongwaveOpticalDepth, vaporLongwaveOpticalDepth, greenhouseOpticalDepth,
    greenhousePotentialAbsorptionFraction,
    pressureAtAltitudePa,
    densityAtAltitudeKgM3: (altitudeM) => pressureAtAltitudePa(altitudeM) * effectiveMolarMassKgMol
      / (UNIVERSAL_GAS_CONSTANT_J_MOL_K * atmosphere.isothermalTemperatureK),
    assumptions: ["thin-shell", "constant-gravity", "well-mixed-isothermal-ideal-gas"],
  };
}
