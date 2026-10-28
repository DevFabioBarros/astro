import { parseBodyEdit } from "@/simulation/body-edits";
import type { EditableBodyField } from "@/simulation/types";

export const ASTRONOMICAL_UNIT_M = 149_597_870_700;
export const NATURAL_GRAVITY = 6.6743e-11;

export function formatMass(massKg: number): string {
  const solar = massKg / 1.9884e30;
  if (solar >= 0.01) return `${solar.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} ${solar === 1 ? "massa solar" : "massas solares"}`;
  const earth = massKg / 5.97217e24;
  if (earth >= 0.01) return `${earth.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} ${earth === 1 ? "Terra" : "Terras"}`;
  const exponent = Math.floor(Math.log10(massKg));
  return `${(massKg / 10 ** exponent).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} × 10^${exponent} kg`;
}

export function formatPhysicalMeasure(value: number): string {
  const absolute = Math.abs(value);
  return value.toLocaleString("pt-BR", {
    maximumSignificantDigits: 4,
    notation: absolute !== 0 && (absolute < 0.01 || absolute >= 1e6) ? "scientific" : "standard",
  });
}

export function logarithmicSliderValue(value: number): number { return Number(Math.log10(value).toPrecision(12)); }
export function logarithmicSliderStep(minimum: number, current: number): number {
  const span = logarithmicSliderValue(current) - logarithmicSliderValue(minimum);
  return span > 0 ? span / Math.max(1, Math.ceil(span / 0.005)) : 0.005;
}
export function logarithmicSliderPhysicalValue(value: number): number { return 10 ** value; }

export function contextualSliderRange(anchor: number, current: number, maximum: number): { min: number; max: number } {
  return { min: Math.min(anchor / 4, current), max: Math.min(maximum, Math.max(anchor * 10, current)) };
}

export function toDisplayUnit(field: EditableBodyField, value: number, stellar = false): number {
  if (field === "massKg") return value / (stellar ? 1e30 : 1e24);
  if (field === "radiusM" || field.startsWith("velocityMs.")) return value / 1000;
  if (field.startsWith("positionM.")) return value / ASTRONOMICAL_UNIT_M;
  if (field === "surfaceTemperatureK") return value - 273.15;
  if (field === "waterFraction") return value * 100;
  return value;
}

export function parseAstronomicalEdit(field: EditableBodyField, text: string, stellar = false, limits?: { maxRadiusM?: number; maxPositionComponentM?: number }): number | null {
  if (!text.trim()) return null;
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  let si = value;
  if (field === "massKg") si *= stellar ? 1e30 : 1e24;
  else if (field === "radiusM" || field.startsWith("velocityMs.")) si *= 1000;
  else if (field.startsWith("positionM.")) si *= ASTRONOMICAL_UNIT_M;
  else if (field === "surfaceTemperatureK") si += 273.15;
  else if (field === "waterFraction") si /= 100;
  return parseBodyEdit(field, String(si), limits);
}

export function formatAstronomicalTime(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 365.25) return `${(days / 365.25).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${days === 365.25 ? "ano" : "anos"}`;
  return `${days.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${days === 1 ? "dia" : "dias"}`;
}
