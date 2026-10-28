import { describe, expect, it } from "vitest";
import { ASTRONOMICAL_UNIT_M, contextualSliderRange, formatAstronomicalTime, formatMass, formatPhysicalMeasure, logarithmicSliderPhysicalValue, logarithmicSliderStep, logarithmicSliderValue, parseAstronomicalEdit, toDisplayUnit } from "./astronomy-units";

describe("astronomical display units", () => {
  it("gives the Sun a useful slider span while retaining extreme numeric edits", () => {
    const solarMass = 1.9884e30;
    const useful = contextualSliderRange(solarMass, solarMass, 1e32);
    const doublePosition = (Math.log10(solarMass * 2) - Math.log10(useful.min)) / (Math.log10(useful.max) - Math.log10(useful.min));
    const originalPosition = (Math.log10(solarMass) - Math.log10(useful.min)) / (Math.log10(useful.max) - Math.log10(useful.min));
    expect(doublePosition - originalPosition).toBeGreaterThan(.18);
    expect(contextualSliderRange(solarMass, 1e32, 1e32).max).toBe(1e32);
    expect(contextualSliderRange(solarMass, 1e10, 1e32).min).toBe(1e10);
  });
  it("rounds logarithmic attributes consistently for server and browser hydration", () => {
    expect(logarithmicSliderValue(63_710_084)).toBe(7.80420817769);
  });
  it("keeps sliders accurate across comet and stellar masses", () => {
    for (const mass of [1e13, 5.97217e24, 1.9884e30, 1e32]) {
      expect(logarithmicSliderPhysicalValue(logarithmicSliderValue(mass)) / mass).toBeCloseTo(1, 9);
    }
    expect(formatMass(1.9884e30)).toBe("1 massa solar");
    expect(formatMass(5.97217e24)).toBe("1 Terra");
    expect(formatMass(1e13)).toBe("1 × 10^13 kg");
  });
  it.each([["Earth", 5.97217e24], ["Sun", 1.9884e30]])("makes ArrowRight increase off-grid %s mass", (_name, mass) => {
    const min = mass / 4;
    const current = logarithmicSliderValue(mass);
    const minPosition = logarithmicSliderValue(min);
    const step = logarithmicSliderStep(min, mass);
    const stepsFromMin = (current - minPosition) / step;

    expect(stepsFromMin).toBeCloseTo(Math.round(stepsFromMin), 9);
    expect(logarithmicSliderPhysicalValue(current + step)).toBeGreaterThan(mass);
  });
  it("converts edited astronomical values to validated SI", () => {
    expect(parseAstronomicalEdit("radiusM", "6371")).toBe(6_371_000);
    expect(parseAstronomicalEdit("massKg", "5,972")).toBeCloseTo(5.972e24);
    expect(parseAstronomicalEdit("massKg", "1.988", true)).toBeCloseTo(1.988e30);
    expect(parseAstronomicalEdit("positionM.0", "1")).toBe(ASTRONOMICAL_UNIT_M);
    expect(parseAstronomicalEdit("velocityMs.1", "29.78")).toBe(29_780);
    expect(parseAstronomicalEdit("surfaceTemperatureK", "15")).toBe(288.15);
    expect(parseAstronomicalEdit("waterFraction", "70")).toBe(.7);
  });
  it("rejects invalid displayed values before changing the world", () => {
    expect(parseAstronomicalEdit("radiusM", "")).toBeNull();
    expect(parseAstronomicalEdit("massKg", "Infinity")).toBeNull();
    expect(parseAstronomicalEdit("surfaceTemperatureK", "-274")).toBeNull();
    expect(parseAstronomicalEdit("waterFraction", "101")).toBeNull();
    expect(parseAstronomicalEdit("positionM.0", "1000")).toBeNull();
  });
  it("displays physical values and time at astronomical scale", () => {
    expect(toDisplayUnit("radiusM", 6_371_000)).toBe(6371);
    expect(toDisplayUnit("positionM.0", ASTRONOMICAL_UNIT_M)).toBe(1);
    expect(toDisplayUnit("waterFraction", .7)).toBe(70);
    expect(formatAstronomicalTime(86400)).toBe("1 dia");
    expect(formatAstronomicalTime(86400 * 730.5)).toBe("2 anos");
  });
  it("keeps very small physical measures visible", () => {
    expect(formatPhysicalMeasure(0)).toBe("0");
    expect(formatPhysicalMeasure(1e-28)).not.toBe("0");
    expect(formatPhysicalMeasure(5.5)).not.toContain("E");
  });
});
