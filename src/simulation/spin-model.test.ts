import { describe, expect, it } from "vitest";
import {
  FULL_ROTATION_RADIANS,
  RIGID_BODY_SPIN_MODEL_ID,
  isValidSpinState,
  maximumStableAngularVelocityRadPerS,
  normalizeSpinAxisWorld,
  spinPhaseAtAcceptedTimeRad,
  spinStateFromPeriodAtAcceptedTime,
  validateSpinStateForBody,
  type SpinState,
} from "./spin-model";

const spin: SpinState = {
  modelId: RIGID_BODY_SPIN_MODEL_ID,
  axisUnitWorld: [0, 0, 1],
  phaseAtEpochRad: Math.PI / 4,
  angularVelocityRadPerS: Math.PI / 2,
};

describe("rigid-body-spin-v1", () => {
  it("validates a strict SI state and requires a normalized world axis", () => {
    expect(isValidSpinState(spin)).toBe(true);
    expect(isValidSpinState({ ...spin, axisUnitWorld: [0, 0, 2] })).toBe(false);
    expect(isValidSpinState({ ...spin, angularVelocityRadPerS: Infinity })).toBe(false);
    expect(isValidSpinState({ ...spin, extra: true })).toBe(false);
    expect(isValidSpinState({ ...spin, modelId: "rigid-body-spin-v2" })).toBe(false);
  });

  it("normalizes finite nonzero axes and rejects invalid axes", () => {
    expect(normalizeSpinAxisWorld([0, 3, 4])).toEqual([0, 0.6, 0.8]);
    expect(() => normalizeSpinAxisWorld([0, 0, 0])).toThrow();
    expect(() => normalizeSpinAxisWorld([0, Number.NaN, 1])).toThrow();
  });

  it("derives phase only from accepted simulation seconds and wraps either direction", () => {
    expect(spinPhaseAtAcceptedTimeRad(spin, 0)).toBeCloseTo(Math.PI / 4);
    expect(spinPhaseAtAcceptedTimeRad(spin, 2)).toBeCloseTo(5 * Math.PI / 4);
    expect(spinPhaseAtAcceptedTimeRad(spin, 4)).toBeCloseTo(Math.PI / 4);
    expect(spinPhaseAtAcceptedTimeRad({ ...spin, angularVelocityRadPerS: -Math.PI / 2 }, 2)).toBeCloseTo(5 * Math.PI / 4);
    expect(() => spinPhaseAtAcceptedTimeRad(spin, -1)).toThrow();
    expect(() => spinPhaseAtAcceptedTimeRad(spin, Infinity)).toThrow();
  });

  it("limits angular speed to the Newtonian surface break-up rate", () => {
    const massKg = 5.97217e24, radiusM = 6_371_008.4, gravitationalConstant = 6.6743e-11;
    const expected = Math.sqrt(gravitationalConstant * massKg / radiusM ** 3);
    const maximum = maximumStableAngularVelocityRadPerS(massKg, radiusM, gravitationalConstant);
    expect(maximum).toBeCloseTo(expected, 14);
    expect(maximumStableAngularVelocityRadPerS(massKg, radiusM, 0)).toBe(0);
    expect(() => maximumStableAngularVelocityRadPerS(0, radiusM, gravitationalConstant)).toThrow();
    expect(() => validateSpinStateForBody(spin, massKg, radiusM, gravitationalConstant)).toThrow(/limite de estabilidade/);
    expect(() => validateSpinStateForBody({ ...spin, angularVelocityRadPerS: 0 }, massKg, radiusM, gravitationalConstant)).not.toThrow();
    expect(FULL_ROTATION_RADIANS).toBe(2 * Math.PI);
  });

  it("builds explicit period/inclination edits at accepted time without inferring legacy orientation", () => {
    const configured = spinStateFromPeriodAtAcceptedTime({ periodDays: 2, inclinationDeg: 30, simulationTimeSeconds: 86400 });
    expect(configured.axisUnitWorld[0]).toBeCloseTo(0.5);
    expect(configured.axisUnitWorld[1]).toBeCloseTo(Math.sqrt(3) / 2);
    expect(spinPhaseAtAcceptedTimeRad(configured, 86400)).toBeCloseTo(0);
    const edited = spinStateFromPeriodAtAcceptedTime({ periodDays: 4, inclinationDeg: 60, simulationTimeSeconds: 86400, currentSpin: configured });
    expect(spinPhaseAtAcceptedTimeRad(edited, 86400)).toBeCloseTo(spinPhaseAtAcceptedTimeRad(configured, 86400));
    expect(edited.angularVelocityRadPerS).toBeCloseTo(Math.PI / (2 * 86400));
    expect(spinStateFromPeriodAtAcceptedTime({ periodDays: 0, inclinationDeg: 0, simulationTimeSeconds: 86400 }).angularVelocityRadPerS).toBe(0);
  });
});
