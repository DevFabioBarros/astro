export const RIGID_BODY_SPIN_MODEL_ID = "rigid-body-spin-v1" as const;
export const FULL_ROTATION_RADIANS = Math.PI * 2;

export type SpinAxisWorld = readonly [x: number, y: number, z: number];
export type SpinState = {
  modelId: typeof RIGID_BODY_SPIN_MODEL_ID;
  axisUnitWorld: SpinAxisWorld;
  phaseAtEpochRad: number;
  angularVelocityRadPerS: number;
};

export function spinStateFromPeriodAtAcceptedTime(input: {
  periodDays: number;
  inclinationDeg: number;
  simulationTimeSeconds: number;
  currentSpin?: SpinState;
}): SpinState {
  const { periodDays, inclinationDeg, simulationTimeSeconds, currentSpin } = input;
  if (!Number.isFinite(periodDays) || Math.abs(periodDays) > 1e12 || (periodDays !== 0 && Math.abs(periodDays) < 1e-9) || !Number.isFinite(inclinationDeg)
    || inclinationDeg < 0 || inclinationDeg > 180 || !Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0) {
    throw new Error("Período, inclinação e tempo aceito devem estar dentro dos limites.");
  }
  const angularVelocityRadPerS = periodDays === 0 ? 0 : FULL_ROTATION_RADIANS / (periodDays * 86400);
  if (!Number.isFinite(angularVelocityRadPerS)) throw new Error("O período produz uma velocidade angular inválida.");
  if (currentSpin && !isValidSpinState(currentSpin)) throw new Error("O estado de rotação atual é inválido.");
  const inclinationRad = inclinationDeg * Math.PI / 180;
  const azimuth = currentSpin ? Math.atan2(currentSpin.axisUnitWorld[2], currentSpin.axisUnitWorld[0]) : 0;
  const currentPhase = currentSpin ? spinPhaseAtAcceptedTimeRad(currentSpin, simulationTimeSeconds) : 0;
  const axisUnitWorld: SpinAxisWorld = [Math.sin(inclinationRad) * Math.cos(azimuth), Math.cos(inclinationRad), Math.sin(inclinationRad) * Math.sin(azimuth)];
  return {
    modelId: RIGID_BODY_SPIN_MODEL_ID,
    axisUnitWorld,
    phaseAtEpochRad: wrapAngle(currentPhase - angularVelocityRadPerS * simulationTimeSeconds),
    angularVelocityRadPerS,
  };
}

const SPIN_STATE_KEYS = ["modelId", "axisUnitWorld", "phaseAtEpochRad", "angularVelocityRadPerS"] as const;
const UNIT_AXIS_TOLERANCE = 1e-9;

export function isValidSpinState(value: unknown): value is SpinState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(state);
  if (keys.length !== SPIN_STATE_KEYS.length || keys.some((key) => typeof key !== "string" || !SPIN_STATE_KEYS.includes(key as typeof SPIN_STATE_KEYS[number]))) return false;
  if (state.modelId !== RIGID_BODY_SPIN_MODEL_ID || !Array.isArray(state.axisUnitWorld) || state.axisUnitWorld.length !== 3
    || typeof state.phaseAtEpochRad !== "number" || !Number.isFinite(state.phaseAtEpochRad)
    || typeof state.angularVelocityRadPerS !== "number" || !Number.isFinite(state.angularVelocityRadPerS)) return false;
  const axis = state.axisUnitWorld;
  return axis.every((component) => typeof component === "number" && Number.isFinite(component))
    && Math.abs(Math.hypot(axis[0] as number, axis[1] as number, axis[2] as number) - 1) <= UNIT_AXIS_TOLERANCE;
}

export function normalizeSpinAxisWorld(axis: readonly number[]): SpinAxisWorld {
  if (axis.length !== 3 || !axis.every(Number.isFinite)) throw new Error("O eixo de rotação deve ter três componentes finitos.");
  const length = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
  if (!Number.isFinite(length) || length === 0) throw new Error("O eixo de rotação não pode ser nulo.");
  return [axis[0]! / length, axis[1]! / length, axis[2]! / length];
}

export function spinPhaseAtAcceptedTimeRad(spin: SpinState, simulationTimeSeconds: number): number {
  if (!isValidSpinState(spin)) throw new Error("Estado de rotação inválido.");
  if (!Number.isFinite(simulationTimeSeconds) || simulationTimeSeconds < 0) throw new Error("O tempo simulado aceito deve ser finito e não negativo.");
  const angularVelocity = spin.angularVelocityRadPerS;
  if (angularVelocity === 0) return wrapAngle(spin.phaseAtEpochRad);
  const periodSeconds = FULL_ROTATION_RADIANS / Math.abs(angularVelocity);
  const elapsedSeconds = Number.isFinite(periodSeconds) ? simulationTimeSeconds % periodSeconds : simulationTimeSeconds;
  return wrapAngle(spin.phaseAtEpochRad + elapsedSeconds * angularVelocity);
}

export function spinEpochPhaseAtAcceptedTimeRad(phaseAtTimeRad: number, angularVelocityRadPerS: number, simulationTimeSeconds: number): number {
  if (![phaseAtTimeRad, angularVelocityRadPerS, simulationTimeSeconds].every(Number.isFinite) || simulationTimeSeconds < 0) {
    throw new Error("Fase, velocidade angular e tempo aceito devem ser finitos.");
  }
  return wrapAngle(phaseAtTimeRad - angularVelocityRadPerS * simulationTimeSeconds);
}

export function maximumStableAngularVelocityRadPerS(massKg: number, radiusM: number, gravitationalConstant: number): number {
  if (!Number.isFinite(massKg) || massKg <= 0 || !Number.isFinite(radiusM) || radiusM <= 0
    || !Number.isFinite(gravitationalConstant) || gravitationalConstant < 0) {
    throw new Error("Massa, raio e G devem ser válidos para limitar a rotação.");
  }
  if (gravitationalConstant === 0) return 0;
  const logLimit = (Math.log(gravitationalConstant) + Math.log(massKg) - 3 * Math.log(radiusM)) / 2;
  if (logLimit >= Math.log(Number.MAX_VALUE)) return Number.MAX_VALUE;
  if (logLimit <= Math.log(Number.MIN_VALUE)) return 0;
  return Math.exp(logLimit);
}

export function validateSpinStateForBody(spin: unknown, massKg: number, radiusM: number, gravitationalConstant: number): asserts spin is SpinState {
  if (!isValidSpinState(spin)) throw new Error("Estado de rotação inválido.");
  if (Math.abs(spin.angularVelocityRadPerS) > maximumStableAngularVelocityRadPerS(massKg, radiusM, gravitationalConstant)) {
    throw new Error("A velocidade angular excede o limite de estabilidade gravitacional deste astro.");
  }
}

function wrapAngle(angleRad: number): number {
  return ((angleRad % FULL_ROTATION_RADIANS) + FULL_ROTATION_RADIANS) % FULL_ROTATION_RADIANS;
}
