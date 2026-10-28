import * as THREE from "three";
import { estimateIntegrationSampleBatchBytes, MAX_INTEGRATION_SAMPLE_BATCH_BYTES, MAX_INTEGRATION_SAMPLES_PER_BATCH, type CelestialBody, type IntegrationSampleBatchV1, type Vector3 } from "@/simulation/types";
import { findOrbitalPrimary } from "@/simulation/orbital-analysis";
import { toScenePosition } from "./scene-scale";

export const ORBIT_TRAIL_SAMPLE_INTERVAL_SECONDS = 86_400;
export const ORBIT_TRAIL_MAX_STEP_RADIANS = Math.PI / 36;
export const MAX_ORBIT_TRAIL_SAMPLES = 256;

export type OrbitTrailSample = { timeSeconds: number; positionM: Vector3 };
export type AuthoritativeOrbitSnapshot = { bodies: readonly CelestialBody[]; timeSeconds: number; revision: number; generation: number; integrationSamples?: IntegrationSampleBatchV1 };
export type OrbitTrailState = { revision: number | null; generation: number | null; lastSampleTime: number | null; trails: Record<string, OrbitTrailSample[]>; bodies: readonly CelestialBody[]; candidatePositions: Record<string, { timeSeconds: number; primaryId?: string; relativePosition: Vector3 }>; accumulatedAngles: Record<string, number>; gaps: Record<string, number[]>; truncated: Record<string, number[]> };

export function createOrbitTrailState(): OrbitTrailState {
  return { revision: null, generation: null, lastSampleTime: null, trails: {}, bodies: [], candidatePositions: {}, accumulatedAngles: {}, gaps: {}, truncated: {} };
}

export function acceptOrbitSnapshot(previous: AuthoritativeOrbitSnapshot, snapshot: Pick<AuthoritativeOrbitSnapshot, "bodies" | "timeSeconds" | "revision"> & { integrationSamples?: IntegrationSampleBatchV1 }, accepted: boolean): AuthoritativeOrbitSnapshot {
  if (!accepted) return previous;
  const previousSolarAge = previous.bodies.find(({ id }) => id === "sun")?.stellarEvolution?.ageYears;
  const nextSolarAge = snapshot.bodies.find(({ id }) => id === "sun")?.stellarEvolution?.ageYears;
  const generation = previous.generation + Number(snapshot.revision !== previous.revision || nextSolarAge !== previousSolarAge);
  if (generation !== previous.generation) return { bodies: snapshot.bodies, timeSeconds: snapshot.timeSeconds, revision: snapshot.revision, generation };
  const prior = previous.integrationSamples;
  const incoming = snapshot.integrationSamples;
  if (!prior) return { ...snapshot, ...(incoming ? { integrationSamples: incoming } : {}), generation };
  if (!incoming) return { ...snapshot, integrationSamples: prior, generation };

  const startTimeSeconds = prior.startTimeSeconds;
  const samples = [...prior.samples];
  const lastTime = startTimeSeconds + (samples.at(-1)?.offsetSeconds ?? 0);
  for (const sample of incoming.samples) {
    const timeSeconds = incoming.startTimeSeconds + sample.offsetSeconds;
    if (timeSeconds < lastTime) continue;
    const next = { ...sample, offsetSeconds: timeSeconds - startTimeSeconds };
    if (timeSeconds === lastTime) samples[samples.length - 1] = next;
    else samples.push(next);
  }
  let truncated = prior.truncated === true || incoming.truncated === true;
  while (samples.length > MAX_INTEGRATION_SAMPLES_PER_BATCH || estimateIntegrationSampleBatchBytes(samples) > MAX_INTEGRATION_SAMPLE_BATCH_BYTES) {
    if (samples.length <= 2) {
      const last = samples.at(-1);
      samples.splice(0, samples.length, ...(last && estimateIntegrationSampleBatchBytes([last]) <= MAX_INTEGRATION_SAMPLE_BATCH_BYTES ? [last] : []));
    } else {
      const count = samples.length;
      samples.splice(0, count, ...samples.filter((_, index) => index === 0 || index === count - 1 || index % 2 === 0));
    }
    truncated = true;
  }
  const integrationSamples = samples.length ? {
    version: 1 as const, startTimeSeconds, endTimeSeconds: incoming.endTimeSeconds, samples,
    ...(truncated ? { truncated: true } : {}),
  } : undefined;
  return { ...snapshot, ...(integrationSamples ? { integrationSamples } : {}), generation };
}

function validPosition(position: Vector3): boolean {
  return position.length === 3 && position.every(Number.isFinite);
}

export function updateOrbitTrails(state: OrbitTrailState, bodies: readonly CelestialBody[], timeSeconds: number, revision: number, generation: number, gravitationalConstant = 6.6743e-11, integrationSamples?: IntegrationSampleBatchV1): OrbitTrailState {
  const reset = state.revision !== revision || state.generation !== generation;
  const trails = reset ? {} : Object.fromEntries(Object.entries(state.trails).filter(([id]) => bodies.some((body) => body.id === id)));
  const priorTrailTimes = Object.fromEntries(Object.entries(trails).map(([id, samples]) => [id, samples.at(-1)?.timeSeconds]));
  const currentIds = new Set(bodies.map(({ id }) => id));
  const candidatePositions = reset ? {} : Object.fromEntries(Object.entries(state.candidatePositions).filter(([id]) => currentIds.has(id)));
  const accumulatedAngles = reset ? {} : Object.fromEntries(Object.entries(state.accumulatedAngles).filter(([id]) => currentIds.has(id)));
  const gaps = reset ? {} : Object.fromEntries(Object.entries(state.gaps).filter(([id]) => currentIds.has(id)));
  const truncated = reset ? {} : Object.fromEntries(Object.entries(state.truncated).filter(([id]) => currentIds.has(id)));
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return reset ? { revision, generation, lastSampleTime: null, trails, bodies, candidatePositions, accumulatedAngles, gaps, truncated } : { ...state, trails };
  let didSample = false;
  const record = (candidateBodies: readonly CelestialBody[], candidateTime: number, sampledIds?: ReadonlySet<string>, force = false) => {
    for (const body of candidateBodies) {
      if ((sampledIds && !sampledIds.has(body.id)) || !validPosition(body.positionM)) continue;
      const samples = trails[body.id] ?? (trails[body.id] = []);
      const previous = samples.at(-1);
      if (previous && candidateTime <= previous.timeSeconds) continue;
      const primary = findOrbitalPrimary(body, candidateBodies, { gravitationalConstant });
      if (sampledIds && primary && !sampledIds.has(primary.id)) continue;
      const priorCandidate = candidatePositions[body.id];
      if (integrationSamples && priorCandidate && candidateTime <= priorCandidate.timeSeconds) continue;
      const relativePosition = primary ? body.positionM.map((value, axis) => value - primary.positionM[axis]!) as unknown as Vector3 : body.positionM;
      candidatePositions[body.id] = { timeSeconds: candidateTime, ...(primary ? { primaryId: primary.id } : {}), relativePosition: [...relativePosition] as unknown as Vector3 };
      if (force) {
        samples.push({ timeSeconds: candidateTime, positionM: [...body.positionM] as unknown as Vector3 });
        didSample = true;
        accumulatedAngles[body.id] = 0;
      } else if (!integrationSamples) {
        let interval = ORBIT_TRAIL_SAMPLE_INTERVAL_SECONDS;
        if (primary) {
          const r = body.positionM.map((value, axis) => value - primary.positionM[axis]!);
          const v = body.velocityMs.map((value, axis) => value - primary.velocityMs[axis]!);
          const radiusSquared = r.reduce((sum, value) => sum + value * value, 0);
          const angularMomentum = Math.hypot(r[1]! * v[2]! - r[2]! * v[1]!, r[2]! * v[0]! - r[0]! * v[2]!, r[0]! * v[1]! - r[1]! * v[0]!);
          const angularRate = radiusSquared > 0 ? angularMomentum / radiusSquared : 0;
          if (angularRate > 0) interval = Math.min(interval, ORBIT_TRAIL_MAX_STEP_RADIANS / angularRate);
        }
        if (!previous || candidateTime - previous.timeSeconds >= interval) {
          samples.push({ timeSeconds: candidateTime, positionM: [...body.positionM] as unknown as Vector3 });
          didSample = true;
          accumulatedAngles[body.id] = 0;
        }
      } else {
        if (priorCandidate && priorCandidate.primaryId !== primary?.id) accumulatedAngles[body.id] = 0;
        else if (primary && priorCandidate && candidateTime > priorCandidate.timeSeconds) {
          const a = priorCandidate.relativePosition, b = relativePosition;
          const dot = a.reduce((sum, value, axis) => sum + value * b[axis]!, 0);
          const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
          accumulatedAngles[body.id] = (accumulatedAngles[body.id] ?? 0) + Math.atan2(Math.hypot(...cross), dot);
        }
        if (!previous || candidateTime - previous.timeSeconds >= ORBIT_TRAIL_SAMPLE_INTERVAL_SECONDS
          || (primary && (accumulatedAngles[body.id] ?? 0) >= ORBIT_TRAIL_MAX_STEP_RADIANS - 1e-10)) {
          samples.push({ timeSeconds: candidateTime, positionM: [...body.positionM] as unknown as Vector3 });
          didSample = true;
          accumulatedAngles[body.id] = 0;
        }
      }
      if (samples.length > MAX_ORBIT_TRAIL_SAMPLES) {
        samples.splice(0, samples.length - MAX_ORBIT_TRAIL_SAMPLES);
        (truncated[body.id] ??= []).push(samples[0]!.timeSeconds);
      }
    }
  };

  let topologyChanged = false;
  if (integrationSamples && integrationSamples.endTimeSeconds <= timeSeconds) {
    let previousSample: { timeSeconds: number; bodies: readonly { id: string; positionM: Vector3 }[] } | undefined;
    for (const sample of integrationSamples.samples) {
      const sampleTime = integrationSamples.startTimeSeconds + sample.offsetSeconds;
      const currentSample = { timeSeconds: sampleTime, bodies: sample.bodies };
      const priorBodies = previousSample?.bodies ?? state.bodies;
      const topologyChange = priorBodies.map(({ id }) => id).join("\0") !== currentSample.bodies.map(({ id }) => id).join("\0");
      const sampledPositions = new Map(sample.bodies.map(({ id, positionM }) => [id, positionM]));
      const candidateBodies = bodies.map((body) => sampledPositions.has(body.id) ? { ...body, positionM: sampledPositions.get(body.id)! } : body);
      const sampledIds = new Set(sampledPositions.keys());
      if (Number.isFinite(sampleTime) && sampleTime <= timeSeconds) {
        if (topologyChange) {
          topologyChanged = true;
          const boundaries = previousSample ? [previousSample, currentSample] : [currentSample];
          for (const boundary of boundaries) {
            const boundaryTime = boundary.timeSeconds;
            for (const { id, positionM } of boundary.bodies) {
              if (!currentIds.has(id)) continue;
              const template = bodies.find((body) => body.id === id) ?? state.bodies.find((body) => body.id === id);
              if (!template) continue;
              const samples = trails[id] ?? (trails[id] = []);
              if (!samples.some((entry) => entry.timeSeconds === boundaryTime)) {
                samples.push({ timeSeconds: boundaryTime, positionM: [...positionM] as unknown as Vector3 });
                samples.sort((a, b) => a.timeSeconds - b.timeSeconds);
                didSample = true;
                if (samples.length > MAX_ORBIT_TRAIL_SAMPLES) { samples.splice(0, samples.length - MAX_ORBIT_TRAIL_SAMPLES); (truncated[id] ??= []).push(samples[0]!.timeSeconds); }
              }
            }
          }
          for (const { id } of sample.bodies) {
            if (!currentIds.has(id)) continue;
            const boundaryTime = previousSample?.timeSeconds ?? priorTrailTimes[id] ?? sampleTime;
            (gaps[id] ??= []).push(boundaryTime);
          }
        } else record(candidateBodies, sampleTime, sampledIds);
      }
      previousSample = currentSample;
    }
  }
  record(bodies, timeSeconds, undefined, topologyChanged);
  if (integrationSamples?.truncated) {
    for (const id of Object.keys(trails)) {
      const candidates = integrationSamples.samples.flatMap(({ offsetSeconds, bodies: sampledBodies }) => {
        const point = sampledBodies.find((body) => body.id === id);
        return point ? [{ timeSeconds: integrationSamples.startTimeSeconds + offsetSeconds, positionM: point.positionM }] : [];
      });
      if (candidates.length) (truncated[id] ??= []).push(candidates[0]!.timeSeconds);
      for (let index = 1; index < candidates.length; index += 1) (gaps[id] ??= []).push(candidates[index - 1]!.timeSeconds);
    }
  }
  for (const id of Object.keys(trails)) {
    const oldest = trails[id]![0]?.timeSeconds ?? Infinity, newest = trails[id]!.at(-1)?.timeSeconds ?? -Infinity;
    gaps[id] = (gaps[id] ?? []).filter((time) => time >= oldest && time <= newest).slice(-MAX_ORBIT_TRAIL_SAMPLES);
    truncated[id] = (truncated[id] ?? []).filter((time) => time >= oldest && time <= newest).slice(-MAX_ORBIT_TRAIL_SAMPLES);
  }
  if (!didSample && !reset) return { ...state, trails, bodies, candidatePositions, accumulatedAngles, gaps, truncated };
  return { revision, generation, lastSampleTime: didSample ? timeSeconds : reset ? null : state.lastSampleTime, trails, bodies, candidatePositions, accumulatedAngles, gaps, truncated };
}

export function createOrbitTrailLine(): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((MAX_ORBIT_TRAIL_SAMPLES + 1) * 2 * 3), 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x8ed6ff, transparent: true, opacity: 0.92, depthWrite: false }));
}

export function addOrbitTrailToScene(scene: THREE.Scene): THREE.LineSegments {
  const line = createOrbitTrailLine();
  scene.add(line);
  return line;
}

export function refreshOrbitTrailLine(line: THREE.LineSegments, samples: readonly OrbitTrailSample[], tip: Vector3 | undefined, origin: Vector3, truncated: readonly number[] = [], gaps: readonly number[] = []): void {
  const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  const points = samples.map(({ positionM }) => toScenePosition(positionM, origin));
  if (tip && points.length < MAX_ORBIT_TRAIL_SAMPLES + 1) points.push([...tip] as [number, number, number]);
  const drawPositions: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    if (gaps.includes(samples[index - 1]?.timeSeconds ?? Number.NaN) || truncated.includes(samples[index - 1]?.timeSeconds ?? Number.NaN)) continue;
    drawPositions.push(...points[index - 1]!, ...points[index]!);
  }
  drawPositions.forEach((_, index) => { if (index % 3 === 0) positions.setXYZ(index / 3, drawPositions[index]!, drawPositions[index + 1]!, drawPositions[index + 2]!); });
  positions.needsUpdate = true;
  line.geometry.setDrawRange(0, drawPositions.length / 3);
  line.geometry.computeBoundingSphere();
}
