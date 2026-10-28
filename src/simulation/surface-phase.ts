export type WaterPhase = "ice" | "liquid" | "vapor" | "unsupported";

export function classifyWaterPhase(temperatureK: number): WaterPhase {
  if (!Number.isFinite(temperatureK) || temperatureK < 0) return "unsupported";
  if (temperatureK < 273.15) return "ice";
  if (temperatureK < 373.15) return "liquid";
  return "vapor";
}
