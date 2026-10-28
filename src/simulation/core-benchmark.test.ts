import { cpus } from "node:os";
import { describe, expect, it } from "vitest";
import { advanceSimulationInterval } from "./simulation-time";
import type { CelestialBody } from "./types";

const BODY_COUNTS = [20, 32, 64] as const;
const WARMUP_RUNS = 30;
const MEASURED_RUNS = 100;
const INTERVAL_SECONDS = 2_160;
const SETTINGS = { gravitationalConstant: 6.6743e-11 };

function createBenchmarkWorld(count: number): CelestialBody[] {
  const side = Math.ceil(Math.cbrt(count));
  return Array.from({ length: count }, (_, index) => {
    const x = index % side;
    const y = Math.floor(index / side) % side;
    const z = Math.floor(index / (side * side));
    return {
      id: `benchmark-${index}`,
      name: `Benchmark ${index}`,
      kind: "planet",
      bodyType: "rocky-planet",
      massKg: 1e15,
      radiusM: 100,
      positionM: [x * 1e9, y * 1e9, z * 1e9],
      velocityMs: [0, 0, 0],
      surfaceTemperatureK: 0,
      waterFraction: 0,
    };
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function benchmarkScenario(count: number) {
  const initial = createBenchmarkWorld(count);
  const repeated = createBenchmarkWorld(count);
  expect(repeated).toEqual(initial);
  expect(initial).toHaveLength(count);

  for (let first = 0; first < initial.length; first += 1) {
    for (let second = first + 1; second < initial.length; second += 1) {
      const separation = Math.hypot(...initial[first]!.positionM.map((value, axis) => value - initial[second]!.positionM[axis]!));
      expect(separation).toBeGreaterThan(initial[first]!.radiusM + initial[second]!.radiusM);
    }
  }

  const first = advanceSimulationInterval(initial, SETTINGS, INTERVAL_SECONDS);
  const second = advanceSimulationInterval(repeated, SETTINGS, INTERVAL_SECONDS);
  expect(first.events).toEqual([]);
  expect(first.bodies).toEqual(second.bodies);
  expect(first.bodies).toHaveLength(count);
}

describe("simulation core benchmark", () => {
  it("reproduces each non-colliding scenario and its interval result", () => {
    for (const count of BODY_COUNTS) benchmarkScenario(count);
  });

  it("reports interval CPU timings", () => {
    const results = BODY_COUNTS.map((count) => {
      const initial = createBenchmarkWorld(count);
      for (let run = 0; run < WARMUP_RUNS; run += 1) {
        advanceSimulationInterval(initial, SETTINGS, INTERVAL_SECONDS);
      }

      const durationsMs = Array.from({ length: MEASURED_RUNS }, () => {
        const start = performance.now();
        advanceSimulationInterval(initial, SETTINGS, INTERVAL_SECONDS);
        return performance.now() - start;
      }).sort((a, b) => a - b);

      return {
        bodies: count,
        medianMs: Number(percentile(durationsMs, 0.5).toFixed(3)),
        p95Ms: Number(percentile(durationsMs, 0.95).toFixed(3)),
      };
    });

    console.log(JSON.stringify({
      benchmark: "advanceSimulationInterval",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model ?? "unknown",
      intervalSeconds: INTERVAL_SECONDS,
      warmupRunsPerSize: WARMUP_RUNS,
      measuredRunsPerSize: MEASURED_RUNS,
      workerOverheadIncluded: false,
      results,
    }));
  }, 30_000);
});
