import { describe, expect, it } from "vitest";
import { MAX_SURFACE_DATA_BYTES, MAX_SURFACE_RELIEF_M, SURFACE_GRID_CELL_COUNT, SURFACE_GRID_HEIGHT, SURFACE_GRID_WIDTH, validateSurfaceData } from "./surface-state";
import { applyImpactCrater, IMPACT_CRATER_MODEL_ID } from "./surface-patches";
import type { CelestialBody, SurfaceData, SurfaceMetadata, Vector3 } from "./types";

const settings = { gravitationalConstant: 0 };
const body = (id: string, dataId = `${id}-relief`, revision = 0): CelestialBody => ({
  id, name: id, kind: "planet", massKg: 1e24, radiusM: 6e6,
  positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0.4,
  waterInventory: { modelId: "water-inventory-v1", escapeModelId: "water-escape-retention-500-1000k-v1",
    dryMassKg: 1e24, dryVolumeM3: 1e18, liquidKg: 0, iceKg: 0, vaporKg: 0, escapedKg: 0 },
  materials: { modelId: "material-composition-v1", rockKg: 7e23, ironKg: 2e23, gasKg: 1e23 },
  atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 1e17, isothermalTemperatureK: 288 },
  surface: { modelId: "sparse-relief-v1", seed: 7, revision, resolution: 64, dataId },
});

function world(bodies = [body("target")], surfaceData: SurfaceData = { "target-relief": [] }) {
  return { bodies, settings, surfaceData };
}

function column(cellIndex: number): number { return cellIndex % SURFACE_GRID_WIDTH; }
function row(cellIndex: number): number { return Math.floor(cellIndex / SURFACE_GRID_WIDTH); }
function longitudeDirection(longitude: number): Vector3 { return [Math.cos(longitude), 0, Math.sin(longitude)]; }

describe("impact-crater-visual-v1", () => {
  it("applies deterministic signed relief and increments only the target surface revision", () => {
    const before = world();
    const untouched = structuredClone(before);
    const first = applyImpactCrater(before, "target", [1, 0, 0], 1e5);
    const second = applyImpactCrater(before, "target", [1, 0, 0], 1e5);
    const target = first.bodies[0]!;
    const elevations = first.surfaceData["target-relief"]!.map(({ elevationM }) => elevationM);

    expect(IMPACT_CRATER_MODEL_ID).toBe("impact-crater-visual-v1");
    expect(first).toEqual(second);
    expect(before).toEqual(untouched);
    expect(target.surface?.revision).toBe(1);
    expect(target).toMatchObject({ massKg: before.bodies[0]!.massKg, radiusM: before.bodies[0]!.radiusM,
      surfaceTemperatureK: before.bodies[0]!.surfaceTemperatureK, waterInventory: before.bodies[0]!.waterInventory,
      materials: before.bodies[0]!.materials, atmosphere: before.bodies[0]!.atmosphere });
    expect(elevations.some((elevation) => elevation < 0)).toBe(true);
    expect(elevations.some((elevation) => elevation > 0)).toBe(true);
    validateSurfaceData(first.surfaceData, first.bodies.flatMap(({ surface }) => surface ? [surface] : []));
  });

  it("wraps a crater across the longitude seam", () => {
    const result = applyImpactCrater(world(), "target", longitudeDirection(Math.PI - 0.001), 1e5);
    const touchedColumns = new Set(result.surfaceData["target-relief"]!.map(({ cellIndex }) => column(cellIndex)));

    expect(touchedColumns.has(0)).toBe(true);
    expect(touchedColumns.has(SURFACE_GRID_WIDTH - 1)).toBe(true);
  });

  it("maps a polar impact deterministically without duplicate or out-of-grid cells", () => {
    const north = applyImpactCrater(world(), "target", [0, 1, 0], 1e5).surfaceData["target-relief"]!;
    const south = applyImpactCrater(world(), "target", [0, -1, 0], 1e5).surfaceData["target-relief"]!;
    const northRows = new Set(north.map(({ cellIndex }) => row(cellIndex)));
    const southRows = new Set(south.map(({ cellIndex }) => row(cellIndex)));

    expect(north.length).toBeGreaterThan(0);
    expect(south.length).toBeGreaterThan(0);
    expect(northRows.has(SURFACE_GRID_HEIGHT - 1)).toBe(true);
    expect(southRows.has(0)).toBe(true);
    expect(new Set(north.map(({ cellIndex }) => cellIndex)).size).toBe(north.length);
    expect(north.every(({ cellIndex }) => cellIndex >= 0 && cellIndex < SURFACE_GRID_CELL_COUNT)).toBe(true);
  });

  it("combines overlapping craters by cell while preserving existing relief", () => {
    const first = applyImpactCrater(world(), "target", [1, 0, 0], 1e5);
    const second = applyImpactCrater(first, "target", longitudeDirection(0.18), 2e5);
    const patches = second.surfaceData["target-relief"]!;

    expect(patches.length).toBeGreaterThan(first.surfaceData["target-relief"]!.length);
    expect(new Set(patches.map(({ cellIndex }) => cellIndex)).size).toBe(patches.length);
    expect(second.bodies[0]!.surface?.revision).toBe(2);
    expect(patches.some(({ elevationM }) => Math.abs(elevationM) > MAX_SURFACE_RELIEF_M)).toBe(false);
  });

  it("copies a shared dataset before patching so another body keeps its surface", () => {
    const shared = { modelId: "sparse-relief-v1" as const, seed: 7, revision: 0, resolution: 64 as const, dataId: "shared-relief" };
    const initial = world([body("target", shared.dataId), { ...body("other", shared.dataId), surface: shared }], { [shared.dataId]: [] });
    const result = applyImpactCrater(initial, "target", [1, 0, 0], 1e5);

    expect(result.bodies[0]!.surface?.dataId).not.toBe(shared.dataId);
    expect(result.bodies[1]!.surface).toEqual(shared);
    expect(result.surfaceData[shared.dataId]).toEqual([]);
    expect(result.surfaceData[result.bodies[0]!.surface!.dataId]).toBeDefined();
  });

  it("rejects invalid directions, radius, revision, relief and aggregate payload size atomically", () => {
    const invalidDirections = [[0, 0, 0], [2, 0, 0], [Number.NaN, 0, 0]] as unknown as Vector3[];
    for (const direction of invalidDirections) {
      const before = world();
      expect(() => applyImpactCrater(before, "target", direction, 1e5)).toThrow();
      expect(before.surfaceData["target-relief"]).toEqual([]);
      expect(before.bodies[0]!.surface?.revision).toBe(0);
    }
    expect(() => applyImpactCrater(world(), "target", [1, 0, 0], 6e6)).toThrow();
    expect(() => applyImpactCrater(world([body("target", "target-relief", Number.MAX_SAFE_INTEGER)]), "target", [1, 0, 0], 1e5)).toThrow();

    const reliefOverflow = world([body("target")], { "target-relief": Array.from({ length: SURFACE_GRID_CELL_COUNT }, (_, cellIndex) => ({ cellIndex, elevationM: -MAX_SURFACE_RELIEF_M })) });
    expect(() => applyImpactCrater(reliefOverflow, "target", [1, 0, 0], 1e5)).toThrow();
    expect(reliefOverflow.bodies[0]!.surface?.revision).toBe(0);

    const bodies = Array.from({ length: 45 }, (_, index) => body(`body-${index}`));
    const data: SurfaceData = Object.fromEntries(bodies.map(({ surface }) => [surface!.dataId, []]));
    for (let bodyIndex = 1; bodyIndex < bodies.length - 1; bodyIndex += 1) {
      data[bodies[bodyIndex]!.surface!.dataId] = Array.from({ length: SURFACE_GRID_CELL_COUNT }, (_, cellIndex) => ({ cellIndex, elevationM: 9_999_999.123456 }));
    }
    const targetDataId = bodies[0]!.surface!.dataId;
    const availableCells = Array.from({ length: SURFACE_GRID_CELL_COUNT }, (_, cellIndex) => cellIndex)
      .filter((cellIndex) => cellIndex < 800 || cellIndex > 1_300);
    let minimum = 0;
    let maximum = availableCells.length;
    while (minimum < maximum) {
      const candidateCount = Math.ceil((minimum + maximum) / 2);
      data[targetDataId] = availableCells.slice(0, candidateCount).map((cellIndex) => ({ cellIndex, elevationM: 0 }));
      if (JSON.stringify(data).length < MAX_SURFACE_DATA_BYTES) minimum = candidateCount;
      else maximum = candidateCount - 1;
    }
    data[targetDataId] = availableCells.slice(0, minimum).map((cellIndex) => ({ cellIndex, elevationM: 0 }));
    const finalDataId = bodies[bodies.length - 1]!.surface!.dataId;
    let finalMinimum = 0;
    let finalMaximum = SURFACE_GRID_CELL_COUNT;
    while (finalMinimum < finalMaximum) {
      const candidateCount = Math.ceil((finalMinimum + finalMaximum) / 2);
      data[finalDataId] = Array.from({ length: candidateCount }, (_, cellIndex) => ({ cellIndex, elevationM: 0 }));
      if (JSON.stringify(data).length < MAX_SURFACE_DATA_BYTES) finalMinimum = candidateCount;
      else finalMaximum = candidateCount - 1;
    }
    data[finalDataId] = Array.from({ length: finalMinimum }, (_, cellIndex) => ({ cellIndex, elevationM: 0 }));
    const nearLimit = { bodies, settings, surfaceData: data };
    validateSurfaceData(data, bodies.flatMap(({ surface }) => surface ? [surface] : []));
    const before = structuredClone(nearLimit);
    expect(() => applyImpactCrater(nearLimit, "body-0", [1, 0, 0], 1e5)).toThrow();
    expect(nearLimit).toEqual(before);
  });
});
