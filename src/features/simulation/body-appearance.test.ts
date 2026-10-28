import { describe, expect, it } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import { schwarzschildRadius } from "@/simulation/body-catalog";
import { getSolarEvolutionProperties, getSolarTrackAgeAtEep, SOLAR_EVOLUTION_START_AGE_YEARS } from "@/simulation/stellar-evolution";
import { blackHoleVisualExtent, blackHoleVisualRadius, dominantLightSource, renderedBodyRadius, stellarColorTemperature, stellarLightIntensity, stellarVisualBrightness, stellarVisualResponse } from "./body-appearance";

describe("physical body appearance", () => {
  const sun = createSolarSystem().find((body) => body.id === "sun")!;
  it("derives a black hole horizon from mass and preserves ordinary physical radii", () => {
    const blackHole = { ...sun, id: "hole", bodyType: "black-hole" as const };
    expect(renderedBodyRadius(blackHole)).toBe(schwarzschildRadius(sun.massKg));
    expect(renderedBodyRadius({ ...blackHole, massKg: sun.massKg * 2 })).toBe(renderedBodyRadius(blackHole) * 2);
    expect(renderedBodyRadius(sun)).toBe(sun.radiusM);
  });
  it("keeps physical Rs while exposing a fixed creative visual scale and framing extent", () => {
    const blackHole = { ...sun, id: "hole", bodyType: "black-hole" as const, massKg: 8e30 };
    const radius = renderedBodyRadius(blackHole);
    expect(blackHoleVisualRadius(blackHole, "scientific")).toBe(radius);
    expect(blackHoleVisualRadius(blackHole, "creative")).toBe(radius * 8);
    expect(blackHoleVisualExtent(blackHole, "creative")).toBe(radius * 32);
    expect(blackHole.radiusM).not.toBe(blackHoleVisualRadius(blackHole, "creative"));
  });
  it("changes the illuminating star and removes direct light when none remain", () => {
    const whiteDwarf = { ...sun, id: "white-dwarf-1", bodyType: "white-dwarf" as const, radiusM: sun.radiusM / 100, surfaceTemperatureK: 10000 };
    const blackHole = { ...sun, id: "black-hole-1", bodyType: "black-hole" as const, surfaceTemperatureK: 1e9 };
    expect(dominantLightSource([whiteDwarf, blackHole, sun])?.id).toBe("sun");
    expect(dominantLightSource([whiteDwarf, blackHole])?.id).toBe(whiteDwarf.id);
    expect(dominantLightSource([blackHole])).toBeUndefined();
    expect(dominantLightSource([])).toBeUndefined();
  });
  it("maps effective temperature to warm solar, cool giant, and hot white-dwarf colors", () => {
    const sun = stellarColorTemperature(5772);
    const coolGiant = stellarColorTemperature(3500);
    const whiteDwarf = stellarColorTemperature(10000);
    expect(sun.r).toBeCloseTo(1, 2);
    expect(sun.g).toBeGreaterThan(sun.b);
    expect(coolGiant.r).toBeGreaterThan(coolGiant.b);
    expect(whiteDwarf.b).toBeGreaterThan(whiteDwarf.r);
    expect(stellarColorTemperature(0)).toEqual(stellarColorTemperature(1667));
    expect(stellarColorTemperature(1e9)).toEqual(stellarColorTemperature(25000));
  });
  it("maps relative luminosity to bounded illustrative light while preserving solar intensity", () => {
    expect(stellarLightIntensity(sun)).toBeCloseTo(3.1);
    expect(stellarLightIntensity({ ...sun, surfaceTemperatureK: 0 })).toBe(0);
    expect(stellarLightIntensity({ ...sun, radiusM: 3e11, surfaceTemperatureK: 1e9 })).toBe(12.4);
    expect(stellarLightIntensity({ ...sun, radiusM: 7e6, surfaceTemperatureK: 10000 })).toBeGreaterThan(0);
    expect(stellarLightIntensity({ ...sun, radiusM: 7e6, surfaceTemperatureK: 10000 })).toBeLessThan(3.1);
  });
  it("uses the shared derived luminosity helper for relative light", async () => {
    const { stellarLuminosityW } = await import("@/simulation/stellar-evolution");
    expect(stellarLightIntensity(sun)).toBeCloseTo(3.1);
    expect(stellarLightIntensity({ ...sun, radiusM: sun.radiusM * 2 })).toBeCloseTo(
      3.1 * Math.min(4, Math.log1p(stellarLuminosityW({ ...sun, radiusM: sun.radiusM * 2 }) / stellarLuminosityW(sun)) / Math.LN2),
    );
  });
  it("makes photosphere brightness follow accepted MIST luminosity inputs", () => {
    expect(stellarVisualBrightness(1)).toBe(1);
    expect(stellarVisualBrightness(2.06)).toBeGreaterThan(1.5);
  });
  it("maps real MIST anchor, giant, and TP-AGB checkpoints to distinct bounded responses", () => {
    const checkpoints = [SOLAR_EVOLUTION_START_AGE_YEARS, getSolarTrackAgeAtEep(605), getSolarTrackAgeAtEep(1000), getSolarTrackAgeAtEep(1338)]
      .map((age) => getSolarEvolutionProperties(age))
      .map(({ radiusM, effectiveTemperatureK }) => stellarVisualResponse({ radiusM, surfaceTemperatureK: effectiveTemperatureK }));
    expect(checkpoints[1]).not.toEqual(checkpoints[0]);
    expect(checkpoints[2]).not.toEqual(checkpoints[1]);
    expect(checkpoints[3]).not.toEqual(checkpoints[0]);
    expect(checkpoints[3]).not.toEqual(checkpoints[2]);
    expect(checkpoints[2]).toEqual(stellarVisualResponse({
      radiusM: getSolarEvolutionProperties(getSolarTrackAgeAtEep(1000)).radiusM,
      surfaceTemperatureK: getSolarEvolutionProperties(getSolarTrackAgeAtEep(1000)).effectiveTemperatureK,
    }));
    for (const response of checkpoints) {
      expect(Number.isFinite(response.surfaceActivity)).toBe(true);
      expect(Number.isFinite(response.coronaIntensity)).toBe(true);
      expect(response.surfaceActivity).toBeGreaterThanOrEqual(0);
      expect(response.surfaceActivity).toBeLessThanOrEqual(0.9);
      expect(response.coronaIntensity).toBeGreaterThanOrEqual(0);
      expect(response.coronaIntensity).toBeLessThanOrEqual(1.8);
    }
  });
});
