import { describe, expect, it } from "vitest";
import { predictTrajectoryPreview } from "./trajectory-preview";
import { schwarzschildRadius } from "./physical-constants";
import { MAX_SIMULATION_BODIES } from "./physics";
import type { CelestialBody, CollisionMode, PhysicsSettings, Vector3 } from "./types";

const zeroGravity: PhysicsSettings = { gravitationalConstant: 0 };

function body(id: string, positionM: Vector3, velocityMs: Vector3 = [0, 0, 0], radiusM = 1, massKg = 1): CelestialBody {
  return {
    id,
    name: id,
    kind: "planet",
    bodyType: "asteroid",
    massKg,
    radiusM,
    positionM,
    velocityMs,
    surfaceTemperatureK: 300,
    waterFraction: 0,
  };
}

describe("predictTrajectoryPreview", () => {
  it("returns the candidate's accepted path without mutating inputs or exposing events", () => {
    const bodies = [body("anchor", [100, 0, 0])];
    const candidate = body("preview-probe", [0, 0, 0], [1, 0, 0]);
    const originalBodies = structuredClone(bodies);
    const originalCandidate = structuredClone(candidate);

    const result = predictTrajectoryPreview(bodies, zeroGravity, candidate, "scientific", 10);

    expect(result).not.toBeNull();
    expect(result!.points[0]).toEqual(candidate.positionM);
    expect(result!.points.at(-1)).toEqual([10, 0, 0]);
    expect(result!.points.length).toBeGreaterThan(2);
    expect(result!.contact).toBeNull();
    expect(Object.keys(result!)).toEqual(["points", "contact"]);
    expect(bodies).toEqual(originalBodies);
    expect(candidate).toEqual(originalCandidate);
  });

  it("reports the first contact involving the candidate and includes its marker in the path", () => {
    const bodies = [
      body("target", [0, 0, 0]),
      body("unrelated-a", [100, 0, 0]),
      body("unrelated-b", [101, 0, 0]),
    ];
    const candidate = body("preview-probe", [-10, 0, 0], [2, 0, 0]);

    const result = predictTrajectoryPreview(bodies, zeroGravity, candidate, "scientific", 10);

    expect(result).not.toBeNull();
    expect(result!.contact).toMatchObject({
      timeSeconds: expect.any(Number),
      positionM: expect.any(Array),
      bodyIds: ["preview-probe", "target"],
    });
    expect(result!.contact!.timeSeconds).toBeCloseTo(4, 2);
    expect(result!.contact!.positionM[0]).toBeCloseTo(-1, 2);
    expect(result!.points[0]).toEqual(candidate.positionM);
    expect(result!.points).toContainEqual(result!.contact!.positionM);
    expect(result!.contact).not.toHaveProperty("id");
    expect(result!).not.toHaveProperty("events");
  });

  it("reports creative black-hole capture as candidate contact", () => {
    const blackHole = body("black-hole", [0, 0, 0], [0, 0, 0], schwarzschildRadius(1e20), 1e20);
    const candidate = body("preview-probe", [-1e-4, 0, 0], [1e-5, 0, 0], 1e-10);
    const star = { ...blackHole, kind: "star" as const, bodyType: "black-hole" as const };

    const result = predictTrajectoryPreview([star], zeroGravity, candidate, "creative", 10);

    expect(result?.contact?.bodyIds).toEqual(["black-hole", "preview-probe"]);
    expect(result?.contact?.timeSeconds).toBeGreaterThan(0);
    expect(result?.points).toContainEqual(result?.contact?.positionM);
  });

  it("defaults to 3600 seconds and caps larger requested horizons at 3600", () => {
    const candidate = body("preview-probe", [0, 0, 0], [1, 0, 0]);

    const defaultHorizon = predictTrajectoryPreview([], zeroGravity, candidate, "scientific");
    const cappedHorizon = predictTrajectoryPreview([], zeroGravity, candidate, "scientific", 7_200);

    expect(defaultHorizon?.points.at(-1)).toEqual([3_600, 0, 0]);
    expect(cappedHorizon?.points.at(-1)).toEqual([3_600, 0, 0]);
    for (const horizon of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(predictTrajectoryPreview([], zeroGravity, candidate, "scientific", horizon)).toBeNull();
    }
  });

  it("hides nonconverged and invalid previews", () => {
    const candidate = body("preview-probe", [0, 0, 0]);
    const budgetLimited = predictTrajectoryPreview(
      [body("anchor", [-100, 0, 0])],
      zeroGravity,
      body("preview-fast", [0, 0, 0], [1e7, 0, 0]),
      "scientific",
    );
    const duplicateId = predictTrajectoryPreview([candidate], zeroGravity, candidate, "scientific", 1);
    const invalidBody = { ...candidate, positionM: [Number.NaN, 0, 0] as Vector3 };
    const invalidSettings = { gravitationalConstant: -1 };
    const fullWorld = Array.from({ length: MAX_SIMULATION_BODIES }, (_, index) =>
      body(`body-${index}`, [1_000 + index * 10, 0, 0]));

    expect(budgetLimited).toBeNull();
    expect(duplicateId).toBeNull();
    expect(predictTrajectoryPreview(fullWorld, zeroGravity, candidate, "scientific", 1)).toBeNull();
    expect(predictTrajectoryPreview([], zeroGravity, invalidBody, "scientific", 1)).toBeNull();
    expect(predictTrajectoryPreview([], invalidSettings, candidate, "scientific", 1)).toBeNull();
    expect(predictTrajectoryPreview([], zeroGravity, candidate, "unsupported" as CollisionMode, 1)).toBeNull();
  });

  it("decimates long paths to 64 points while preserving endpoints and contact", () => {
    const candidate = body("preview-probe", [0, 0, 0], [1e7, 0, 0], 1e6);
    const target = body("target", [36_000_000_000, 0, 0], [0, 0, 0], 1e6);

    const result = predictTrajectoryPreview([target], zeroGravity, candidate, "scientific", 3_600);

    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(64);
    expect(result!.points[0]).toEqual(candidate.positionM);
    expect(result!.points.at(-1)).toEqual([36_000_000_000, 0, 0]);
    expect(result!.contact).not.toBeNull();
    expect(result!.points).toContainEqual(result!.contact!.positionM);
  });

  it("keeps candidate paths stable when equivalent bodies arrive in a different order", () => {
    const left = body("left", [-1_000, 0, 0], [0, 0, 0], 1, 1e15);
    const right = body("right", [1_000, 0, 0], [0, 0, 0], 1, 1e15);
    const candidate = body("preview-probe", [0, 0, 0], [0, 10, 0], 1, 1e15);

    const forward = predictTrajectoryPreview([left, right], { gravitationalConstant: 6.6743e-11 }, candidate, "scientific", 5);
    const reversed = predictTrajectoryPreview([right, left], { gravitationalConstant: 6.6743e-11 }, candidate, "scientific", 5);

    expect(forward).not.toBeNull();
    expect(reversed).not.toBeNull();
    expect(reversed!.points).toHaveLength(forward!.points.length);
    for (const [index, point] of forward!.points.entries()) {
      point.forEach((value, axis) => expect(reversed!.points[index]![axis]).toBeCloseTo(value, 10));
    }
  });
});
