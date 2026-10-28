import { describe, expect, it } from "vitest";
import { classifyWaterPhase } from "./surface-phase";

describe("classifyWaterPhase at standard atmospheric pressure", () => {
  it.each([
    [0, "ice"],
    [273.14, "ice"],
    [273.15, "liquid"],
    [373.14, "liquid"],
    [373.15, "vapor"],
    [Number.NaN, "unsupported"],
    [Number.POSITIVE_INFINITY, "unsupported"],
    [-1, "unsupported"],
  ] as const)("classifies %s K as %s", (temperatureK, phase) => {
    expect(classifyWaterPhase(temperatureK)).toBe(phase);
  });
});
