import { describe, expect, it } from "vitest";
import { parseOrbitalMutationPreviewRequest, parseOrbitalMutationPreviewResponse, parseSimulationWorkerCommand } from "./simulation-worker-protocol";

const mutation = { type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 6e24 };

describe("parseSimulationWorkerCommand history payloads", () => {
  it("accepts only a strict bounded batch-size mutation through the existing atomic command", () => {
    const batch = { type: "BATCH_SCALE_BODIES", bodyIds: ["earth", "mars"], field: "massKg", factor: 2 };
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: batch, revision: 2 }))
      .toEqual({ type: "MUTATE_WORLD", mutation: batch, revision: 2 });
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: { ...batch, factor: 3 }, revision: 2 })).toBeNull();
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: { ...batch, actions: [{ type: "REMOVE_BODY", bodyId: "earth" }] }, revision: 2 })).toBeNull();
  });

  it("accepts a finite nonzero impulse mutation through the existing atomic world command", () => {
    const impulse = { type: "APPLY_IMPULSE", bodyId: "earth", impulseNs: [12, -3, 0] };
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: impulse, revision: 1 }))
      .toEqual({ type: "MUTATE_WORLD", mutation: impulse, revision: 1 });
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: { ...impulse, impulseNs: [Infinity, 0, 0] }, revision: 1 })).toBeNull();
  });

  it("accepts only a bounded profiled laser mutation with normalized local aim", () => {
    const laser = { type: "APPLY_LASER", bodyId: "earth", bodyLocalDirection: [0, 0, 1], powerW: 2e8,
      durationAcceptedSeconds: 10, profileId: "grey-albedo-laser-absorption-v1" };
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: laser, revision: 3 }))
      .toEqual({ type: "MUTATE_WORLD", mutation: laser, revision: 3 });
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: { ...laser, bodyLocalDirection: [0, 0, 2] }, revision: 3 })).toBeNull();
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation: { ...laser, durationAcceptedSeconds: 61 }, revision: 3 })).toBeNull();
  });

  it("accepts nested mutation coalescing metadata", () => {
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation, revision: 1, history: { coalesceId: "mass-drag" } }))
      .toEqual({ type: "MUTATE_WORLD", mutation, revision: 1, history: { coalesceId: "mass-drag" } });
  });

  it.each([
    { history: null },
    { history: {} },
    { history: { coalesceId: " " } },
    { history: { coalesceId: "valid", extra: true } },
    { coalesceId: "legacy-top-level" },
  ])("rejects malformed or legacy mutation history metadata: %o", (metadata) => {
    expect(parseSimulationWorkerCommand({ type: "MUTATE_WORLD", mutation, revision: 1, ...metadata })).toBeNull();
  });

  it("keeps SET_SETTINGS coalescing metadata top-level", () => {
    expect(parseSimulationWorkerCommand({ type: "SET_SETTINGS", settings: { gravitationalConstant: 0 }, revision: 1, coalesceId: "settings-drag" }))
      .toEqual({ type: "SET_SETTINGS", settings: { gravitationalConstant: 0 }, revision: 1, coalesceId: "settings-drag" });
  });

  it("validates SET_WORLD settings at the protocol boundary", () => {
    const world = { type: "SET_WORLD", origin: "experiment", bodies: [], settings: { gravitationalConstant: 0 }, environmentSeed: 15, revision: 1, collisionMode: "creative" };
    expect(parseSimulationWorkerCommand(world)).toMatchObject({ type: "SET_WORLD", origin: "experiment", collisionMode: "creative" });
    expect(parseSimulationWorkerCommand({ ...world, settings: { gravitationalConstant: -1 } })).toBeNull();
    expect(parseSimulationWorkerCommand({ ...world, environmentSeed: -1 })).toBeNull();
    expect(parseSimulationWorkerCommand({ ...world, environmentSeed: 0x1_0000_0000 })).toBeNull();
  });

  it("requires a valid surface sidecar when SET_WORLD bodies reference surfaces", () => {
    const surface = { modelId: "sparse-relief-v1", seed: 7, revision: 2, resolution: 64, dataId: "earth-relief" };
    const world = { type: "SET_WORLD", origin: "import", bodies: [{
      id: "earth", name: "Earth", kind: "planet", massKg: 1e12, radiusM: 1e6,
      positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0, surface,
    }], settings: { gravitationalConstant: 0 }, environmentSeed: 15, revision: 1,
      surfaceData: { "earth-relief": [{ cellIndex: 3, elevationM: -100 }] } };
    expect(parseSimulationWorkerCommand(world)).toMatchObject({ surfaceData: world.surfaceData });
    expect(parseSimulationWorkerCommand({ ...world, surfaceData: undefined })).toBeNull();
    expect(parseSimulationWorkerCommand({ ...world, surfaceData: { orphan: [] } })).toBeNull();
    expect(parseSimulationWorkerCommand({ ...world, surfaceData: { "earth-relief": [{ cellIndex: 3, elevationM: Infinity }] } })).toBeNull();
  });
});

describe("orbital mutation preview protocol", () => {
  const request = {
    type: "PREVIEW_ORBITAL_MUTATION",
    version: 1,
    requestId: 7,
    worldRevision: 3,
    baseTimeSeconds: 42,
    mutation: { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: "earth", semiMajorAxisM: 4e8,
      planeNormal: [0, 0, 1], radialDirection: [1, 0, 0] },
  };

  it("parses a versioned orbital preview request and rejects stale or malformed envelopes", () => {
    expect(parseOrbitalMutationPreviewRequest(request)).toEqual(request);
    expect(parseOrbitalMutationPreviewRequest({ ...request, version: 2 })).toBeNull();
    expect(parseOrbitalMutationPreviewRequest({ ...request, requestId: 0 })).toBeNull();
    expect(parseOrbitalMutationPreviewRequest({ ...request, extra: true })).toBeNull();
    expect(parseOrbitalMutationPreviewRequest({ ...request, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 1 } })).toBeNull();
  });

  it("parses candidate and refusal responses without accepting malformed poses", () => {
    const response = { type: "ORBITAL_MUTATION_PREVIEW", version: 1, requestId: 7, worldRevision: 3, baseTimeSeconds: 42,
      result: { status: "ready", candidates: [{ bodyId: "moon", positionM: [1, 2, 3], velocityMs: [4, 5, 6] }] } };
    expect(parseOrbitalMutationPreviewResponse(response)).toEqual(response);
    expect(parseOrbitalMutationPreviewResponse({ ...response, result: { status: "ready", candidates: [{ ...response.result.candidates[0], velocityMs: [Infinity, 0, 0] }] } })).toBeNull();
    expect(parseOrbitalMutationPreviewResponse({ ...response, result: { status: "refused", code: "INVALID_BODY", message: "Cap excedido." } }))
      .toMatchObject({ result: { status: "refused", code: "INVALID_BODY" } });
  });
});
