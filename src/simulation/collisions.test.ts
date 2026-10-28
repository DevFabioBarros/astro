import { describe, expect, it } from "vitest";
import { captureBlackHole, findOverlappingPair, findSweptCollision, mergeCollision } from "./collisions";
import { createSolarSystem } from "./solar-system";
import { adoptWaterInventory } from "./water-model";
import type { CelestialBody, Vector3 } from "./types";

const body = (id: string, positionM: Vector3): CelestialBody => ({
  id, name: id, kind: "planet", massKg: 1, radiusM: 1,
  positionM, velocityMs: [0, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
});

describe("findSweptCollision", () => {
  it("detects two moving bodies crossing without overlapping at either endpoint", () => {
    const start = [body("a", [-10, 0, 0]), body("b", [10, 0, 0])];
    const end = [body("a", [10, 0, 0]), body("b", [-10, 0, 0])];

    expect(findOverlappingPair(start)).toBeUndefined();
    expect(findOverlappingPair(end)).toBeUndefined();
    const collision = findSweptCollision(start, end);
    expect(collision).toMatchObject({ first: 0, second: 1 });
    expect(collision!.fraction).toBeCloseTo(0.45, 12);
  });

  it("detects tangential contact between separated endpoints", () => {
    const start = [body("a", [-10, 2, 0]), body("b", [0, 0, 0])];
    const end = [body("a", [10, 2, 0]), body("b", [0, 0, 0])];

    expect(findOverlappingPair(start)).toBeUndefined();
    expect(findOverlappingPair(end)).toBeUndefined();
    expect(findSweptCollision(start, end)).toEqual({ first: 0, second: 1, fraction: 0.5 });
  });

  it("rejects a near miss outside the combined radii", () => {
    const start = [body("a", [-10, 2.001, 0]), body("b", [0, 0, 0])];
    const end = [body("a", [10, 2.001, 0]), body("b", [0, 0, 0])];

    expect(findSweptCollision(start, end)).toBeUndefined();
  });

  it("rejects equal parallel motion even when absolute segments overlap", () => {
    const start = [body("a", [-10, 0, 0]), body("b", [0, 0, 0])];
    const end = [body("a", [10, 0, 0]), body("b", [20, 0, 0])];

    expect(findSweptCollision(start, end)).toBeUndefined();
  });
});

describe("explicit spin collision boundary", () => {
  it("refuses merge and creative capture until angular momentum has a collision ledger", () => {
    const spinning = { ...body("spin", [0, 0, 0]), spin: {
      modelId: "rigid-body-spin-v1" as const, axisUnitWorld: [0, 1, 0] as const, phaseAtEpochRad: 0, angularVelocityRadPerS: 0,
    } };
    const plain = body("plain", [1, 0, 0]);
    const refused = (operation: () => unknown) => {
      try { operation(); throw new Error("Esperava recusa recuperável da colisão."); }
      catch (error) {
        expect(error).toMatchObject({ code: "UNSUPPORTED_COLLISION" });
        expect(error instanceof Error ? error.message : "").toMatch(/rotação física explícita.*ledger de momento angular/);
      }
    };
    refused(() => mergeCollision([spinning, plain], 0, 1, { gravitationalConstant: 0 }));
    const blackHole = { ...body("bh", [0, 0, 0]), bodyType: "black-hole" as const, massKg: 1e20, radiusM: 1e-7 };
    refused(() => captureBlackHole([blackHole, spinning], 0, 1, 1, { gravitationalConstant: 0 }));
  });
});

describe("mergeCollision", () => {
  it("refuses materialized and mixed collisions before changing known component mass", () => {
    const material = { ...body("material", [0, 0, 0]), materials: { modelId: "material-composition-v1" as const, rockKg: 0.6, ironKg: 0.3, gasKg: 0.1 } };
    const legacy = body("legacy", [0, 0, 0]);

    expect(() => mergeCollision([material, legacy], 0, 1, { gravitationalConstant: 0 })).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_COLLISION", message: expect.stringContaining("Adote composição T12 no corpo legacy"),
    }));
    expect(() => mergeCollision([material, { ...material, id: "material-2" }], 0, 1, { gravitationalConstant: 0 })).toThrow(expect.objectContaining({ code: "UNSUPPORTED_COLLISION" }));
  });

  it("refuses creative capture of a materialized body", () => {
    const sun = createSolarSystem()[0]!;
    const captor = { ...sun, bodyType: "black-hole" as const };
    const material = { ...body("material", [1, 0, 0]), materials: { modelId: "material-composition-v1" as const, rockKg: 0.6, ironKg: 0.3, gasKg: 0.1 } };

    expect(() => captureBlackHole([captor, material], 0, 1, 100, { gravitationalConstant: 0 })).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_COLLISION", message: expect.stringContaining("T13"),
    }));
  });

  it("classifies black hole contact as an unsupported collision model", () => {
    const first = { ...body("bh-a", [0, 0, 0]), kind: "star" as const, bodyType: "black-hole" as const };
    const second = { ...body("bh-b", [0, 0, 0]), kind: "star" as const, bodyType: "black-hole" as const };
    let caught: unknown;

    try {
      mergeCollision([first, second], 0, 1, { gravitationalConstant: 0 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "SimulationError",
      code: "UNSUPPORTED_COLLISION",
      message: "Colisão entre buracos negros não é suportada. A execução foi pausada no último estado aceito; edite posição/velocidade ou troque o cenário antes de retomar.",
    });
  });

  it("records facing-surface contact independently of the merged center of mass", () => {
    const first = { ...body("a", [1, 2, 3]), radiusM: 2, velocityMs: [3, -2, 1] as Vector3 };
    const second = { ...body("b", [4, 6, 3]), massKg: 3, radiusM: 3, velocityMs: [-1, 4, 2] as Vector3 };
    const { event } = mergeCollision([first, second], 0, 1, { gravitationalConstant: 0 });

    expect(event.bodyIds).toEqual(["a", "b"]);
    expect(event.positionM).toEqual([3.25, 5, 3]);
    expect(event.contact).toMatchObject({ normalM: [0.6, 0.8, 0], relativeVelocityMs: [-4, 6, 1] });
    expect(event.contact?.pointM[0]).toBeCloseTo(2.2, 12);
    expect(event.contact?.pointM[1]).toBeCloseTo(3.6, 12);
    expect(event.contact?.pointM[2]).toBe(3);
    const reversed = mergeCollision([second, first], 0, 1, { gravitationalConstant: 0 }).event;
    expect(reversed.contact?.pointM).toEqual(event.contact?.pointM);
    expect(reversed.contact?.normalM).toEqual([-0.6, -0.8, 0]);
    expect(reversed.contact?.relativeVelocityMs).toEqual([4, -6, -1]);
  });

  it("uses the midpoint of facing surfaces for initial overlap", () => {
    const first = { ...body("a", [0, 0, 0]), radiusM: 4 };
    const second = body("b", [2, 0, 0]);
    const { event } = mergeCollision([first, second], 0, 1, { gravitationalConstant: 0 });

    expect(event.contact).toEqual({ pointM: [2.5, 0, 0], normalM: [1, 0, 0], relativeVelocityMs: [0, 0, 0] });
    expect(event.positionM).toEqual([1, 0, 0]);
  });

  it("uses the event position and no normal for coincident centers", () => {
    const first = { ...body("a", [7, -2, 4]), velocityMs: [1, 2, 3] as Vector3 };
    const second = { ...body("b", [7, -2, 4]), massKg: 3, radiusM: 2 };
    const { event } = mergeCollision([first, second], 0, 1, { gravitationalConstant: 0 });

    expect(event.contact).toEqual({ pointM: event.positionM, normalM: null, relativeVelocityMs: [-1, -2, -3] });
  });

  it("removes solar-track metadata from a merged star", () => {
    const sun = {
      ...createSolarSystem()[0]!,
      stellarEvolution: {
        modelId: "mist-v1.2-solar-1msun-nonrotating" as const,
        modelVersion: "1.2" as const,
        ageYears: 4.58e9,
        accretedMassKg: 0,
        absorbedBodyIds: [],
        mode: "manual" as const,
      },
    };
    const impactor = {
      ...body("impactor", [sun.positionM[0] + sun.radiusM + 1e6, sun.positionM[1], sun.positionM[2]]),
      massKg: 1e24,
      radiusM: 1e6,
    };

    const result = mergeCollision([sun, impactor], 0, 1, { gravitationalConstant: 6.6743e-11 });
    const mergedSun = result.bodies.find(({ id }) => id === sun.id)!;

    expect(mergedSun.stellarEvolution).toBeUndefined();
    expect(mergedSun.massKg).toBe(sun.massKg + impactor.massKg);
  });

  it("conserves modeled water mass and volume when merging with a legacy body", () => {
    const modeled = adoptWaterInventory({ ...body("modeled", [0, 0, 0]), massKg: 1e20, radiusM: 1e6, waterFraction: 0.2, surfaceTemperatureK: 288 });
    const legacy = { ...body("legacy", [1e7, 0, 0]), massKg: 2e20, radiusM: 2e6, waterFraction: 0.8 };
    const { bodies } = mergeCollision([modeled, legacy], 0, 1, { gravitationalConstant: 0 });
    const merged = bodies[0]!;
    const retainedWaterKg = merged.waterInventory!.liquidKg + merged.waterInventory!.iceKg + merged.waterInventory!.vaporKg;

    expect(merged.massKg).toBeCloseTo(modeled.massKg + legacy.massKg, 6);
    expect(Math.abs(merged.radiusM ** 3 / (modeled.radiusM ** 3 + legacy.radiusM ** 3) - 1)).toBeLessThan(1e-12);
    expect(merged.waterInventory!.dryMassKg + retainedWaterKg).toBeCloseTo(merged.massKg, 6);
    expect(merged.waterInventory!.liquidKg + merged.waterInventory!.iceKg + merged.waterInventory!.vaporKg)
      .toBeCloseTo(modeled.waterInventory!.liquidKg + modeled.waterInventory!.iceKg + modeled.waterInventory!.vaporKg, 6);
  });
});
