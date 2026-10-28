import type { CelestialBody, MaterialComposition, MaterialProfileId } from "./types";
export type { MaterialProfileId } from "./types";

export const MATERIAL_COMPOSITION_MODEL_ID = "material-composition-v1" as const;
export const MATERIAL_PROFILE_IDS = ["rock-v1", "iron-v1", "water-ice-v1", "gas-v1"] as const;

export type MaterialProfile = {
  id: MaterialProfileId;
  densityKgM3: { nominal: number; min: number; max: number };
  specificHeatJkgK: { nominal: number; min: number; max: number };
  albedoFraction: { nominal: number; min: number; max: number };
};

// Model anchors are broad proxies, not universal values for natural mixtures.
export const MATERIAL_PROFILES: Readonly<Record<MaterialProfileId, MaterialProfile>> = {
  "rock-v1": { id: "rock-v1", densityKgM3: { nominal: 3_000, min: 2_500, max: 4_000 }, specificHeatJkgK: { nominal: 790, min: 500, max: 1_500 }, albedoFraction: { nominal: 0.25, min: 0, max: 1 } },
  "iron-v1": { id: "iron-v1", densityKgM3: { nominal: 7_870, min: 7_000, max: 8_100 }, specificHeatJkgK: { nominal: 449, min: 350, max: 800 }, albedoFraction: { nominal: 0.2, min: 0, max: 1 } },
  // Density matches T11's effective water density; this is not a literal ice density.
  "water-ice-v1": { id: "water-ice-v1", densityKgM3: { nominal: 1_000, min: 917, max: 1_000 }, specificHeatJkgK: { nominal: 2_100, min: 1_900, max: 4_200 }, albedoFraction: { nominal: 0.6, min: 0, max: 1 } },
  "gas-v1": { id: "gas-v1", densityKgM3: { nominal: 1_326, min: 0.1, max: 5_000 }, specificHeatJkgK: { nominal: 13_000, min: 5_000, max: 20_000 }, albedoFraction: { nominal: 0.34, min: 0, max: 1 } },
};

export type DryMaterialFractions = { rock: number; iron: number; gas: number };

export function calculateDryMaterialVolumeM3(massKg: number, fractions: DryMaterialFractions): number {
  return massKg * (fractions.rock / MATERIAL_PROFILES["rock-v1"].densityKgM3.nominal
    + fractions.iron / MATERIAL_PROFILES["iron-v1"].densityKgM3.nominal
    + fractions.gas / MATERIAL_PROFILES["gas-v1"].densityKgM3.nominal);
}

export function calculateMaterialRadiusM(massKg: number, fractions: DryMaterialFractions, retainedWaterKg = 0): number {
  const volumeM3 = calculateDryMaterialVolumeM3(massKg, fractions) + retainedWaterKg / MATERIAL_PROFILES["water-ice-v1"].densityKgM3.nominal;
  return Math.cbrt(3 * volumeM3 / (4 * Math.PI));
}

export function isMaterialComposition(value: unknown): value is MaterialComposition {
  if (!value || typeof value !== "object") return false;
  const material = value as Record<string, unknown>;
  return Object.keys(material).sort().join(",") === "gasKg,ironKg,modelId,rockKg"
    && material.modelId === MATERIAL_COMPOSITION_MODEL_ID
    && [material.rockKg, material.ironKg, material.gasKg].every((component) => typeof component === "number" && Number.isFinite(component) && component >= 0);
}

export function getMaterialCompositionView(body: Pick<CelestialBody, "materials" | "waterInventory">) {
  const waterKg = body.waterInventory
    ? body.waterInventory.liquidKg + body.waterInventory.iceKg + body.waterInventory.vaporKg
    : 0;
  return body.materials ? { ...body.materials, waterKg } : undefined;
}

export function materialCompositionFromFractions(dryMassKg: number, fractions: DryMaterialFractions): MaterialComposition {
  const rockKg = dryMassKg * fractions.rock;
  const ironKg = dryMassKg * fractions.iron;
  return { modelId: MATERIAL_COMPOSITION_MODEL_ID, rockKg, ironKg, gasKg: dryMassKg - rockKg - ironKg };
}

export function materialCompositionVolumeM3(materials: MaterialComposition): number {
  return materials.rockKg / MATERIAL_PROFILES["rock-v1"].densityKgM3.nominal
    + materials.ironKg / MATERIAL_PROFILES["iron-v1"].densityKgM3.nominal
    + materials.gasKg / MATERIAL_PROFILES["gas-v1"].densityKgM3.nominal;
}
