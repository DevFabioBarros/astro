import { SimulationError, validateBodies, validateSettings } from "./physics";
import { advanceWorld } from "./world";
import { captureBlackHole, creativeCaptureRadiusM, findOverlappingPair, findSweptBlackHoleCapture, findSweptCollision, mergeCollision, resolveCreativeCollision } from "./collisions";
import { advanceThermalTemperatures } from "./thermal-model";
import { updateSurfaceAfterAcceptedCollision } from "./surface-patches";
import { updateSurfaceHeatAfterAcceptedCollision, validateSurfaceHeatData } from "./surface-heat";
import { createEmptySwarmLedger, reconcileSwarmLedger, validateSwarmLedger } from "./swarm-model";
import type { SurfaceData, SurfaceHeatData } from "./types";
import { MAX_INTEGRATION_SAMPLES_PER_BATCH, type CelestialBody, type CollisionMode, type EnvironmentSeed, type PhysicsSettings, type SimulationEvent, type SwarmLedger } from "./types";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "./world-seed";
import { isWithinCombinedSurfacePayloadLimit, validateSurfaceData } from "./surface-state";

export const DEFAULT_SIMULATION_SPEED = 86_400;
export const SIMULATION_SPEEDS = [
  { value: 1, label: "1 segundo/s" },
  { value: 60, label: "1 minuto/s" },
  { value: 600, label: "10 minutos/s" },
  { value: 3_600, label: "1 hora/s" },
  { value: 86_400, label: "1 dia/s" },
  { value: 604_800, label: "1 semana/s" },
  { value: 2_592_000, label: "1 mês/s" },
] as const;
export const MAX_SIMULATION_SPEED = 2_592_000;
const MAX_STEPS_PER_TICK = 512;
const MAX_PAIR_EVALUATIONS_PER_TICK = 100_000;
const WORK_LIMIT_MESSAGE = "Encontro próximo exige passos menores. Reduza a velocidade do tempo para continuar com segurança.";

function simulationStepBudget(bodyCount: number): number {
  const pairEvaluationsPerStep = bodyCount * (bodyCount - 1) / 2 * 6;
  return Math.min(MAX_STEPS_PER_TICK,
    pairEvaluationsPerStep > 0 ? Math.floor(MAX_PAIR_EVALUATIONS_PER_TICK / pairEvaluationsPerStep) : MAX_STEPS_PER_TICK);
}

export function isIntervalWithinSimulationBudget(bodyCount: number, seconds: number, stepCeiling: number): boolean {
  if (!Number.isSafeInteger(bodyCount) || bodyCount < 0 || !Number.isFinite(seconds) || seconds <= 0
    || !Number.isFinite(stepCeiling) || stepCeiling <= 0) return false;
  return Math.ceil(seconds / stepCeiling) <= simulationStepBudget(bodyCount);
}

export function simulationSpeedLimitMessage(bodyCount: number, multiplier: number, tickSeconds: number): string | undefined {
  const withinBudget = (speed: number) => isIntervalWithinSimulationBudget(bodyCount, speed * tickSeconds, speed <= 2_000 ? 1 : 3_600);
  if (withinBudget(multiplier)) return undefined;
  const selected = SIMULATION_SPEEDS.find(({ value }) => value === multiplier)?.label ?? `${multiplier} s/s`;
  const recovery = SIMULATION_SPEEDS.filter(({ value }) => withinBudget(value)).at(-1)?.label ?? "um ritmo menor";
  return `${selected} excede o orçamento para ${bodyCount} astros. Use até ${recovery} ou remova astros.`;
}

function safeStepSeconds(bodies: readonly CelestialBody[], settings: PhysicsSettings, ceiling: number): number {
  let step = ceiling;
  for (let first = 0; first < bodies.length; first += 1) {
    for (let second = first + 1; second < bodies.length; second += 1) {
      const a = bodies[first]!;
      const b = bodies[second]!;
      const distance = Math.hypot(...a.positionM.map((value, axis) => value - b.positionM[axis]!));
      const relativeSpeed = Math.hypot(...a.velocityMs.map((value, axis) => value - b.velocityMs[axis]!));
      const attraction = settings.gravitationalConstant * (a.massKg + b.massKg);
      // Resolve both close encounters and orbital curvature before advancing Verlet.
      if (relativeSpeed > 0) step = Math.min(step, 0.02 * distance / relativeSpeed);
      if (attraction > 0) step = Math.min(step, 0.02 * Math.sqrt(distance ** 3 / attraction));
    }
  }
  return step;
}

export type IntegrationSubstepSample = {
  offsetSeconds: number;
  bodies: { id: string; positionM: CelestialBody["positionM"] }[];
};
type RetainedSubstepSample = { sample: IntegrationSubstepSample; index: number; required: boolean };
export type SimulationAdvanceResult = { bodies: CelestialBody[]; swarmLedger: SwarmLedger; events: Omit<SimulationEvent, "id">[]; advancedSeconds: number; budgetLimited: boolean; samples?: IntegrationSubstepSample[]; samplesTruncated?: boolean; surfaceData?: SurfaceData; surfaceHeatData?: SurfaceHeatData };

function interpolateBodies(start: readonly CelestialBody[], end: readonly CelestialBody[], fraction: number): CelestialBody[] {
  return start.map((body, index) => {
    const next = end[index]!;
    return {
      ...next,
      positionM: body.positionM.map((value, axis) => value + (next.positionM[axis]! - value) * fraction) as unknown as CelestialBody["positionM"],
      velocityMs: body.velocityMs.map((value, axis) => value + (next.velocityMs[axis]! - value) * fraction) as unknown as CelestialBody["velocityMs"],
    };
  });
}

/** Advances the requested interval atomically, reporting collisions with elapsed interval time. */
export function advanceSimulationInterval(
  initialBodies: readonly CelestialBody[], settings: PhysicsSettings, seconds: number, stepCeiling = 3_600,
  options: { captureSamples?: boolean; collisionMode?: CollisionMode; environmentSeed?: EnvironmentSeed; simulationTimeSeconds?: number; surfaceData?: SurfaceData; surfaceHeatData?: SurfaceHeatData; swarmLedger?: SwarmLedger } = {},
): SimulationAdvanceResult {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(stepCeiling) || stepCeiling <= 0) {
    throw new SimulationError("INVALID_TIME_STEP", "Time interval and integration ceiling must be finite and positive.");
  }
  validateBodies(initialBodies);
  validateSettings(settings);
  let swarmLedger = options.swarmLedger ?? createEmptySwarmLedger();
  validateSwarmLedger(swarmLedger, initialBodies);
  const initialSimulationTimeSeconds = options.simulationTimeSeconds ?? 0;
  if (!Number.isFinite(initialSimulationTimeSeconds) || initialSimulationTimeSeconds < 0) {
    throw new SimulationError("INVALID_TIME_STEP", "O tempo aceito inicial da superfície é inválido.");
  }
  if (options.surfaceData !== undefined) validateSurfaceData(options.surfaceData, initialBodies.flatMap(({ surface }) => surface ? [surface] : []));
  if (options.surfaceHeatData !== undefined) {
    validateSurfaceHeatData(options.surfaceHeatData, initialBodies.flatMap(({ surface }) => surface ? [surface.dataId] : []));
  }
  if ((options.surfaceData !== undefined || options.surfaceHeatData !== undefined)
    && !isWithinCombinedSurfacePayloadLimit(options.surfaceData ?? {}, options.surfaceHeatData ?? {})) {
    throw new SimulationError("INVALID_BODY", "O payload combinado de superfície excede 4 MiB.");
  }
  if (!isIntervalWithinSimulationBudget(initialBodies.length, seconds, stepCeiling)) {
    throw new SimulationError("INVALID_TIME_STEP", WORK_LIMIT_MESSAGE);
  }
  // One step scans pairs once here and three times in velocity-Verlet validation/acceleration.
  const stepBudget = simulationStepBudget(initialBodies.length);
  const sampleRetentionLimit = MAX_INTEGRATION_SAMPLES_PER_BATCH - 2;
  let bodies = [...initialBodies];
  let surfaceData = options.surfaceData;
  let surfaceHeatData = options.surfaceHeatData;
  let remaining = seconds;
  let elapsed = 0;
  const events: SimulationAdvanceResult["events"] = [];
  let retainedSamples = options.captureSamples ? [] as RetainedSubstepSample[] : undefined;
  let samplesTruncated = false;
  let sampleCount = 0;
  let sampleStride = 1;
  let lastSampleOffset: number | undefined;
  const recordSample = (offsetSeconds: number, sampleBodies: readonly CelestialBody[], required = false) => {
    if (!retainedSamples) return;
    const duplicateOffset = lastSampleOffset === offsetSeconds;
    if (!duplicateOffset) sampleCount += 1;
    lastSampleOffset = offsetSeconds;
    if (!duplicateOffset) {
      while (retainedSamples.length >= sampleRetentionLimit) {
        sampleStride *= 2;
        retainedSamples = retainedSamples.filter(({ index, required: retainedRequired }) => index === 1 || retainedRequired || index % sampleStride === 0);
        samplesTruncated = true;
      }
    }
    if (!required && sampleCount !== 1 && sampleCount % sampleStride !== 0) {
      samplesTruncated = true;
      return;
    }
    const sample = { offsetSeconds, bodies: sampleBodies.map(({ id, positionM }) => ({ id, positionM: [...positionM] as unknown as CelestialBody["positionM"] })) };
    if (retainedSamples.at(-1)?.sample.offsetSeconds === offsetSeconds) retainedSamples[retainedSamples.length - 1] = { sample, index: sampleCount, required };
    else retainedSamples.push({ sample, index: sampleCount, required });
  };
  const result = (budgetLimited: boolean): SimulationAdvanceResult => {
    if (elapsed > 0) recordSample(elapsed, bodies, true);
    const samples = elapsed > 0 ? retainedSamples?.map(({ sample }) => sample).filter(({ offsetSeconds }) => offsetSeconds > 0) : undefined;
    return { bodies, swarmLedger, events, advancedSeconds: elapsed, budgetLimited,
      ...(samples ? { samples, ...(samplesTruncated ? { samplesTruncated: true } : {}) } : {}),
      ...(surfaceData === undefined ? {} : { surfaceData }), ...(surfaceHeatData === undefined ? {} : { surfaceHeatData }) };
  };
  const acceptCollision = (beforeBodies: readonly CelestialBody[], collision: {
    bodies: CelestialBody[];
    swarmLedger?: SwarmLedger;
    event: Pick<SimulationEvent, "bodyIds" | "contact" | "outcome" | "energyJ">;
  }, eventTimeSeconds: number) => {
    if (collision.swarmLedger) swarmLedger = collision.swarmLedger;
    let acceptedBodies = collision.bodies;
    try {
      if (surfaceData !== undefined) {
        const updated = updateSurfaceAfterAcceptedCollision(beforeBodies, collision.bodies, collision.event, settings,
          options.environmentSeed ?? DEFAULT_ENVIRONMENT_SEED_V1, surfaceData);
        surfaceData = updated.surfaceData;
        acceptedBodies = updated.bodies;
      }
      if (surfaceHeatData !== undefined) surfaceHeatData = updateSurfaceHeatAfterAcceptedCollision(beforeBodies, acceptedBodies,
        collision.event, surfaceHeatData, eventTimeSeconds);
      if ((surfaceData !== undefined || surfaceHeatData !== undefined)
        && !isWithinCombinedSurfacePayloadLimit(surfaceData ?? {}, surfaceHeatData ?? {})) {
        throw new Error("O payload combinado de relevo e brilho excede 4 MiB.");
      }
    } catch (error) {
      throw new SimulationError("UNSUPPORTED_COLLISION", `A colisão foi recusada sem alterar o estado aceito: ${error instanceof Error ? error.message : "estado de superfície inválido."}`);
    }
    return acceptedBodies;
  };
  const advanceAcceptedTemperatures = (startBodies: readonly CelestialBody[], endBodies: readonly CelestialBody[], seconds: number) => {
    const advanced = advanceThermalTemperatures(startBodies, endBodies, seconds, settings.gravitationalConstant);
    if (advanced.some((body, index) => body.massKg !== startBodies[index]?.massKg)) {
      swarmLedger = reconcileSwarmLedger(swarmLedger, startBodies, advanced);
    }
    return advanced;
  };
  let steps = 0;
  while (remaining > 0) {
    let preStepCapture: ReturnType<typeof findSweptBlackHoleCapture>;
    if (options.collisionMode === "creative") {
      let captured = false;
      for (let captor = 0; captor < bodies.length && !captured; captor += 1) {
        if (bodies[captor]!.bodyType !== "black-hole") continue;
        for (let absorbed = 0; absorbed < bodies.length; absorbed += 1) {
          if (absorbed === captor || bodies[absorbed]!.bodyType === "black-hole") continue;
          const captureRadiusM = creativeCaptureRadiusM(bodies[captor]!, bodies[absorbed]!, settings.gravitationalConstant);
          const distance = Math.hypot(...bodies[captor]!.positionM.map((value, axis) => value - bodies[absorbed]!.positionM[axis]!));
          if (distance > captureRadiusM * (1 + 1e-6)) continue;
          const result = captureBlackHole(bodies, captor, absorbed, captureRadiusM, settings, swarmLedger);
          bodies = acceptCollision(bodies, result, initialSimulationTimeSeconds + elapsed);
          events.push({ ...result.event, timeSeconds: elapsed });
          captured = true;
          break;
        }
      }
      if (captured) continue;
    }
    const overlap = findOverlappingPair(bodies);
    if (overlap) {
      const collision = options.collisionMode === "creative"
        ? resolveCreativeCollision(bodies, overlap[0], overlap[1], settings, swarmLedger)
        : mergeCollision(bodies, overlap[0], overlap[1], settings, swarmLedger);
      bodies = acceptCollision(bodies, collision, initialSimulationTimeSeconds + elapsed);
      events.push({ ...collision.event, timeSeconds: elapsed });
      continue;
    }
    if (steps >= stepBudget) return result(true);
    let step = Math.min(remaining, safeStepSeconds(bodies, settings, stepCeiling));
    if (!Number.isFinite(step) || step <= 0 || remaining - step === remaining) {
      throw new SimulationError("INVALID_TIME_STEP", "Não foi possível resolver este encontro com segurança. Reduza a velocidade do tempo.");
    }
    if (options.collisionMode === "creative") {
      const linearEnd = bodies.map((body) => ({ ...body,
        positionM: body.positionM.map((value, axis) => value + body.velocityMs[axis]! * step) as unknown as CelestialBody["positionM"] }));
      preStepCapture = findSweptBlackHoleCapture(bodies, linearEnd, settings.gravitationalConstant);
      if (preStepCapture) step *= preStepCapture.fraction * (1 - 1e-6);
      if (step <= 0 || remaining - step === remaining) throw new SimulationError("INVALID_TIME_STEP", "Não foi possível resolver a captura criativa com segurança.");
    }
    const nextBodies = advanceWorld(bodies, settings, step);
    steps += 1;
    const sweptCapture = options.collisionMode === "creative" ? findSweptBlackHoleCapture(bodies, nextBodies, settings.gravitationalConstant) : undefined;
    const collision = findSweptCollision(bodies, nextBodies);
    const capture = sweptCapture ?? (preStepCapture &&
      Math.hypot(...nextBodies[preStepCapture.captor]!.positionM.map((value, axis) => value - nextBodies[preStepCapture.absorbed]!.positionM[axis]!))
        <= preStepCapture.captureRadiusM * (1 + 1e-6) ? { ...preStepCapture, fraction: 1 } : undefined);
    if (capture && (!collision || capture.fraction <= collision.fraction)) {
      const consumed = step * capture.fraction;
      bodies = advanceAcceptedTemperatures(bodies, interpolateBodies(bodies, nextBodies, capture.fraction), consumed);
      recordSample(elapsed + consumed, bodies, true);
      const result = captureBlackHole(bodies, capture.captor, capture.absorbed, capture.captureRadiusM, settings, swarmLedger);
      bodies = acceptCollision(bodies, result, initialSimulationTimeSeconds + elapsed + consumed);
      elapsed += consumed;
      remaining -= consumed;
      events.push({ ...result.event, timeSeconds: elapsed });
    } else if (collision) {
      const consumed = step * collision.fraction;
      bodies = advanceAcceptedTemperatures(bodies, interpolateBodies(bodies, nextBodies, collision.fraction), consumed);
      recordSample(elapsed + consumed, bodies, true);
      const merged = options.collisionMode === "creative"
        ? resolveCreativeCollision(bodies, collision.first, collision.second, settings, swarmLedger)
        : mergeCollision(bodies, collision.first, collision.second, settings, swarmLedger);
      bodies = acceptCollision(bodies, merged, initialSimulationTimeSeconds + elapsed + consumed);
      elapsed += consumed;
      remaining -= consumed;
      events.push({ ...merged.event, timeSeconds: elapsed });
    } else {
      bodies = advanceAcceptedTemperatures(bodies, nextBodies, step);
      remaining -= step;
      elapsed += step;
      recordSample(elapsed, bodies);
    }
  }
  return result(false);
}

/** Compatibility API for callers that only need the final body state. */
export function advanceSimulationTime(
  initialBodies: readonly CelestialBody[], settings: PhysicsSettings, seconds: number, stepCeiling = 3_600,
): CelestialBody[] {
  return advanceSimulationInterval(initialBodies, settings, seconds, stepCeiling).bodies;
}
