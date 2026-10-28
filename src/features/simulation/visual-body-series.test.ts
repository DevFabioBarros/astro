import { describe, expect, it } from "vitest";
import { updateVisualBodySeries, updateVisualBodySeriesFromSnapshot, visualBodySeriesReducer, MAX_TRACKED_VISUAL_SERIES, MAX_VISUAL_SERIES_SAMPLES } from "./visual-body-series";
import type { CelestialBody } from "@/simulation/types";

function body(id: string, massKg: number, positionM: CelestialBody["positionM"], velocityMs: CelestialBody["velocityMs"] = [0, 0, 0]): CelestialBody {
  return { id, name: id, kind: "planet", massKg, radiusM: 1, positionM, velocityMs, surfaceTemperatureK: 100, waterFraction: 0 };
}

describe("accepted visual body series", () => {
  it("samples only present tracked bodies and derives distance to the instantaneous barycenter and kinetic energy", () => {
    const first = body("first", 1, [0, 0, 0], [2, 0, 0]);
    const second = body("second", 3, [4, 0, 0]);
    const series = updateVisualBodySeries([], ["first", "missing"], [first, second], 5);

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ bodyId: "first", retired: false, samples: [{ timeSeconds: 5,
      massKg: 1, surfaceTemperatureK: 100, distanceToBarycenterM: 3, kineticEnergyJ: 2 }] });
  });

  it("freezes the last series when a tracked body disappears without retaining a ghost body", () => {
    const first = body("first", 1, [0, 0, 0]);
    const sampled = updateVisualBodySeries([], ["first"], [first], 2);
    const retired = updateVisualBodySeries(sampled, ["first"], [], 4);

    expect(retired[0]).toMatchObject({ bodyId: "first", retired: true, samples: sampled[0]!.samples });
    expect(retired[0]).not.toHaveProperty("body");
  });

  it("bounds tracked targets and points per target", () => {
    const targets = Array.from({ length: MAX_TRACKED_VISUAL_SERIES + 3 }, (_, i) => `body-${i}`);
    let series = updateVisualBodySeries([], targets, targets.map((id) => body(id, 1, [0, 0, 0])), 0);
    for (let point = 1; point <= MAX_VISUAL_SERIES_SAMPLES + 3; point += 1) {
      series = updateVisualBodySeries(series, targets, targets.map((id) => body(id, 1, [0, 0, 0])), point);
    }

    expect(series).toHaveLength(MAX_TRACKED_VISUAL_SERIES);
    expect(series[0]!.samples).toHaveLength(MAX_VISUAL_SERIES_SAMPLES);
    expect(series[0]!.samples[0]!.timeSeconds).toBe(4);
  });

  it("does not append a duplicate accepted time", () => {
    const first = body("first", 1, [0, 0, 0]);
    const initial = updateVisualBodySeries([], ["first"], [first], 2);
    const unchanged = updateVisualBodySeries(initial, ["first"], [first], 2);
    expect(unchanged).toEqual(initial);
  });

  it("replaces a same-time accepted point when paused Undo changes the body state", () => {
    const first = body("first", 1, [0, 0, 0]);
    const initial = updateVisualBodySeries([], ["first"], [first], 2);
    const undone = updateVisualBodySeries(initial, ["first"], [{ ...first, massKg: 7, surfaceTemperatureK: 250 }], 2);

    expect(undone[0]!.samples).toHaveLength(1);
    expect(undone[0]!.samples[0]).toMatchObject({ timeSeconds: 2, massKg: 7, surfaceTemperatureK: 250 });
  });

  it("starts a fresh series session on import even when the imported body reuses an ID", () => {
    const original = body("earth", 1, [0, 0, 0]);
    const oldSeries = updateVisualBodySeries([], ["earth"], [original], 2);
    const reset = visualBodySeriesReducer(oldSeries, { type: "world-replaced" });
    const imported = visualBodySeriesReducer(reset, { type: "accepted-snapshot", trackedBodyIds: ["earth"],
      snapshot: { bodies: [{ ...original, massKg: 99 }], simulationTimeSeconds: 0, status: "paused" } });

    expect(imported).toHaveLength(1);
    expect(imported[0]!.samples).toEqual([expect.objectContaining({ timeSeconds: 0, massKg: 99 })]);
  });

  it("trims future points when accepted history moves simulation time backwards", () => {
    const first = body("first", 1, [0, 0, 0]);
    const initial = updateVisualBodySeries([], ["first"], [first], 2);
    const future = updateVisualBodySeries(initial, ["first"], [first], 4);
    const restored = updateVisualBodySeries(future, ["first"], [first], 3);

    expect(restored[0]!.samples.map(({ timeSeconds }) => timeSeconds)).toEqual([2, 3]);
  });

  it("does not sample rejected or error snapshots", () => {
    const first = body("first", 1, [0, 0, 0]);
    const previous = updateVisualBodySeries([], ["first"], [first], 2);
    expect(updateVisualBodySeriesFromSnapshot(previous, ["first"], {
      bodies: [{ ...first, surfaceTemperatureK: 900 }], simulationTimeSeconds: 4, error: "rejected", status: "paused",
    } as never)).toEqual(previous);
    expect(updateVisualBodySeriesFromSnapshot(previous, ["first"], {
      bodies: [{ ...first, surfaceTemperatureK: 900 }], simulationTimeSeconds: 4, status: "error",
    } as never)).toEqual(previous);
  });
});
