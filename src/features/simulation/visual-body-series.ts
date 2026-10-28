import type { CelestialBody, SimulationSnapshot } from "@/simulation/types";

export const MAX_TRACKED_VISUAL_SERIES = 16;
export const MAX_VISUAL_SERIES_SAMPLES = 256;

export type VisualBodySeriesSample = {
  timeSeconds: number;
  massKg: number;
  surfaceTemperatureK: number;
  distanceToBarycenterM: number;
  kineticEnergyJ: number;
};

export type VisualBodySeries = {
  bodyId: string;
  retired: boolean;
  samples: VisualBodySeriesSample[];
};

export type VisualBodySeriesAction =
  | { type: "world-replaced" }
  | { type: "accepted-snapshot"; trackedBodyIds: readonly string[]; snapshot: Pick<SimulationSnapshot, "bodies" | "simulationTimeSeconds" | "status" | "error"> };

export function visualBodySeriesReducer(previous: VisualBodySeries[], action: VisualBodySeriesAction): VisualBodySeries[] {
  if (action.type === "world-replaced") return [];
  return updateVisualBodySeriesFromSnapshot(previous, action.trackedBodyIds, action.snapshot);
}

export function updateVisualBodySeriesFromSnapshot(
  previous: readonly VisualBodySeries[],
  trackedBodyIds: readonly string[],
  snapshot: Pick<SimulationSnapshot, "bodies" | "simulationTimeSeconds" | "status" | "error">,
): VisualBodySeries[] {
  if (snapshot.error || snapshot.status === "error") return [...previous];
  return updateVisualBodySeries(previous, trackedBodyIds, snapshot.bodies, snapshot.simulationTimeSeconds);
}

export function updateVisualBodySeries(
  previous: readonly VisualBodySeries[],
  trackedBodyIds: readonly string[],
  bodies: readonly CelestialBody[],
  timeSeconds: number,
): VisualBodySeries[] {
  const byId = new Map(previous.slice(0, MAX_TRACKED_VISUAL_SERIES).map((series) => [series.bodyId, series]));
  const bodyById = new Map(bodies.map((body) => [body.id, body]));
  for (const id of trackedBodyIds) {
    if (byId.size >= MAX_TRACKED_VISUAL_SERIES) break;
    if (!byId.has(id) && bodyById.has(id)) byId.set(id, { bodyId: id, retired: false, samples: [] });
  }

  const totalMassKg = bodies.reduce((sum, body) => sum + body.massKg, 0);
  const barycenter = [0, 1, 2].map((axis) => totalMassKg > 0
    ? bodies.reduce((sum, body) => sum + body.massKg * body.positionM[axis]!, 0) / totalMassKg
    : 0);

  return [...byId.values()].map((series) => {
    const body = bodyById.get(series.bodyId);
    if (!body) return { ...series, retired: true, samples: series.samples };
    if (series.retired) return series;
    const samplesAtAcceptedTime = series.samples.filter((sample) => sample.timeSeconds <= timeSeconds);
    const acceptedLast = samplesAtAcceptedTime.at(-1);
    if (acceptedLast && timeSeconds < acceptedLast.timeSeconds) {
      return samplesAtAcceptedTime.length === series.samples.length ? series : { ...series, samples: samplesAtAcceptedTime };
    }
    const speedSquared = body.velocityMs.reduce((sum, speed) => sum + speed ** 2, 0);
    const sample = {
      timeSeconds,
      massKg: body.massKg,
      surfaceTemperatureK: body.surfaceTemperatureK,
      distanceToBarycenterM: Math.hypot(...body.positionM.map((value, axis) => value - barycenter[axis]!)),
      kineticEnergyJ: 0.5 * body.massKg * speedSquared,
    };
    if (acceptedLast && timeSeconds === acceptedLast.timeSeconds) {
      return { bodyId: series.bodyId, retired: false, samples: [...samplesAtAcceptedTime.slice(0, -1), sample] };
    }
    const samples = [...samplesAtAcceptedTime, sample].slice(-MAX_VISUAL_SERIES_SAMPLES);
    return { bodyId: series.bodyId, retired: false, samples };
  });
}
