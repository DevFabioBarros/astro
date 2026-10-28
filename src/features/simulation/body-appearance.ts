import type { CelestialBody } from "@/simulation/types";
import type { CollisionMode } from "@/simulation/types";
import { getBodyType, isLuminousBody, schwarzschildRadius } from "@/simulation/body-catalog";
import { stellarLuminosityW } from "@/simulation/stellar-evolution";

/** Kim et al. Planckian-locus spline approximation, converted to sRGB; visual only. */
export function stellarColorTemperature(temperatureK: number): { r: number; g: number; b: number } {
  // The published spline is defined on 1667–25000 K; clamp appearance, never physical Teff.
  const kelvin = Math.min(25000, Math.max(1667, temperatureK));
  const t = kelvin / 1000;
  const x = t <= 4 ? -0.2661239e9 / kelvin ** 3 - 0.2343589e6 / kelvin ** 2 + 0.8776956e3 / kelvin + 0.179910 : -3.0258469e9 / kelvin ** 3 + 2.1070379e6 / kelvin ** 2 + 0.2226347e3 / kelvin + 0.240390;
  const y = t <= 2.222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  const z = 1 - x - y;
  const X = x / y, Z = z / y;
  const linear = [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
  const positive = linear.map((channel) => Math.max(0, channel));
  const scale = Math.max(...positive, 1);
  const srgb = positive.map((channel) => {
    const value = channel / scale;
    return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  });
  return { r: srgb[0]!, g: srgb[1]!, b: srgb[2]! };
}

/** Bounded artistic scaling from solar-relative R²Teff⁴; not photometric intensity. */
export function stellarVisualBrightness(luminosityRatio: number): number {
  return luminosityRatio > 0 ? Math.min(4, Math.log1p(luminosityRatio) / Math.LN2) : 0;
}

export function stellarVisualResponse(body: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK">): { surfaceActivity: number; coronaIntensity: number } {
  if (!(body.radiusM > 0 && body.surfaceTemperatureK > 0)) return { surfaceActivity: 0, coronaIntensity: 0 };
  const luminosityRatio = stellarLuminosityW(body) / stellarLuminosityW({ radiusM: 695700000, surfaceTemperatureK: 5772 });
  // Artistic saturation uses no track maximum or physical stage threshold.
  const radiusLog = Math.max(0, Math.log(body.radiusM / 695700000));
  const temperatureLog = Math.abs(Math.log(body.surfaceTemperatureK / 5772));
  const luminosityLog = Math.max(0, Math.log(luminosityRatio));
  const radiusSignal = radiusLog / (1 + radiusLog);
  const temperatureSignal = temperatureLog / (1 + temperatureLog);
  const luminositySignal = luminosityLog / (1 + luminosityLog);
  const evolutionSignal = 0.5 * radiusSignal + 0.25 * temperatureSignal + 0.25 * luminositySignal;
  return { surfaceActivity: Math.min(0.9, 0.34 + 0.56 * evolutionSignal), coronaIntensity: Math.min(1.8, 1 + 0.8 * evolutionSignal) };
}

export function stellarLightIntensity(body: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK">): number {
  const luminosityRatio = stellarLuminosityW(body) / stellarLuminosityW({ radiusM: 695700000, surfaceTemperatureK: 5772 });
  return 3.1 * stellarVisualBrightness(luminosityRatio);
}

/** The horizon uses its physical radius; the surrounding disk is illustrative. */
export function renderedBodyRadius(body: CelestialBody): number {
  return getBodyType(body) === "black-hole" ? schwarzschildRadius(body.massKg) : body.radiusM;
}

// Creative presentation scale only; mass, Rs, gravity, and capture radius remain physical.
export const CREATIVE_BLACK_HOLE_HORIZON_SCALE = 8;
export const CREATIVE_BLACK_HOLE_DISK_EXTENT_SCALE = 32;

export function blackHoleVisualRadius(body: CelestialBody, mode: CollisionMode = "scientific"): number {
  return renderedBodyRadius(body) * (mode === "creative" && getBodyType(body) === "black-hole" ? CREATIVE_BLACK_HOLE_HORIZON_SCALE : 1);
}

export function blackHoleVisualExtent(body: CelestialBody, mode: CollisionMode = "scientific"): number {
  return renderedBodyRadius(body) * (mode === "creative" && getBodyType(body) === "black-hole" ? CREATIVE_BLACK_HOLE_DISK_EXTENT_SCALE : 1);
}

export function bodyAppearanceKey(body: CelestialBody, mode: CollisionMode = "scientific"): string {
  return `${body.kind}:${getBodyType(body)}:${getBodyType(body) === "black-hole" ? mode : ""}`;
}

export function dominantLightSource(bodies: readonly CelestialBody[]): CelestialBody | undefined {
  return bodies.filter(isLuminousBody).reduce<CelestialBody | undefined>((brightest, body) => {
    const luminosity = (candidate: CelestialBody) => candidate.radiusM ** 2 * candidate.surfaceTemperatureK ** 4;
    return !brightest || luminosity(body) > luminosity(brightest) ? body : brightest;
  }, undefined);
}
