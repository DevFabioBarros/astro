import { advanceSimulationInterval } from "./simulation-time";
import type { CelestialBody, CollisionMode, PhysicsSettings, SimulationEvent, Vector3 } from "./types";

const DEFAULT_HORIZON_SECONDS = 3_600;
const MAX_TRAJECTORY_POINTS = 64;

export type TrajectoryPreview = {
  points: Vector3[];
  contact: { timeSeconds: number; positionM: Vector3; bodyIds: string[] } | null;
};

type TimedPoint = { timeSeconds: number; positionM: Vector3 };

function copyBody(body: CelestialBody): CelestialBody {
  return {
    ...body,
    positionM: [...body.positionM] as unknown as Vector3,
    velocityMs: [...body.velocityMs] as unknown as Vector3,
    ...(body.stellarEvolution ? {
      stellarEvolution: { ...body.stellarEvolution, absorbedBodyIds: [...body.stellarEvolution.absorbedBodyIds] },
    } : {}),
  };
}

function copyVector(value: Vector3): Vector3 | null {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? [...value] as unknown as Vector3
    : null;
}

function isCandidateContact(event: Omit<SimulationEvent, "id">, candidateId: string): boolean {
  return (event.type === "collision" || event.type === "black-hole-capture")
    && Array.isArray(event.bodyIds) && event.bodyIds.includes(candidateId);
}

function decimatePoints(points: readonly TimedPoint[], contactIndex: number | null): Vector3[] {
  if (points.length <= MAX_TRAJECTORY_POINTS) return points.map(({ positionM }) => positionM);

  const selected = Array.from({ length: MAX_TRAJECTORY_POINTS }, (_, index) =>
    Math.round(index * (points.length - 1) / (MAX_TRAJECTORY_POINTS - 1)));
  if (contactIndex !== null && !selected.includes(contactIndex)) {
    let replacement = 1;
    for (let index = 2; index < selected.length - 1; index += 1) {
      if (Math.abs(selected[index]! - contactIndex) < Math.abs(selected[replacement]! - contactIndex)) replacement = index;
    }
    selected[replacement] = contactIndex;
  }
  return [...new Set(selected)].sort((first, second) => first - second).map((index) => points[index]!.positionM);
}

export function predictTrajectoryPreview(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
  candidate: CelestialBody,
  collisionMode: CollisionMode,
  horizonSeconds = DEFAULT_HORIZON_SECONDS,
): TrajectoryPreview | null {
  if (!Number.isFinite(horizonSeconds) || horizonSeconds <= 0
    || (collisionMode !== "scientific" && collisionMode !== "creative")) return null;

  const horizon = Math.min(horizonSeconds, DEFAULT_HORIZON_SECONDS);
  try {
    const previewCandidate = copyBody(candidate);
    const initialBodies = [...bodies.map(copyBody), previewCandidate];
    const result = advanceSimulationInterval(initialBodies, { ...settings }, horizon, DEFAULT_HORIZON_SECONDS,
      { captureSamples: true, collisionMode });
    const timeTolerance = Math.max(1e-9, horizon * 1e-12);
    if (result.budgetLimited || !Number.isFinite(result.advancedSeconds)
      || Math.abs(result.advancedSeconds - horizon) > timeTolerance) return null;

    const event = result.events.find((entry) => isCandidateContact(entry, previewCandidate.id));
    let contact: TrajectoryPreview["contact"] = null;
    if (event) {
      const positionM = copyVector(event.positionM);
      if (!positionM || !Number.isFinite(event.timeSeconds) || event.timeSeconds < 0 || event.timeSeconds > result.advancedSeconds + timeTolerance) return null;
      contact = { timeSeconds: event.timeSeconds, positionM, bodyIds: [...event.bodyIds].sort() };
    }

    const points: TimedPoint[] = [{ timeSeconds: 0, positionM: [...previewCandidate.positionM] as unknown as Vector3 }];
    let previousSampleTime = 0;
    for (const sample of result.samples ?? []) {
      if (!Number.isFinite(sample.offsetSeconds) || sample.offsetSeconds < previousSampleTime
        || sample.offsetSeconds > result.advancedSeconds + timeTolerance) return null;
      previousSampleTime = sample.offsetSeconds;
      const sampledCandidate = sample.bodies.find(({ id }) => id === previewCandidate.id);
      if (!sampledCandidate) continue;
      const positionM = copyVector(sampledCandidate.positionM);
      if (!positionM) return null;
      points.push({ timeSeconds: sample.offsetSeconds, positionM });
    }
    if (!contact && points.length === 1) return null;

    let contactIndex: number | null = null;
    if (contact) {
      contactIndex = points.findIndex(({ timeSeconds }, index) => index > 0 && timeSeconds >= contact!.timeSeconds);
      if (contactIndex < 0) contactIndex = points.length;
      points.splice(contactIndex, 0, { timeSeconds: contact.timeSeconds, positionM: contact.positionM });
    }

    return { points: decimatePoints(points, contactIndex), contact };
  } catch {
    return null;
  }
}
