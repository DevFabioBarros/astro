import { describe, expect, it } from "vitest";
import { resolvePendingWorldMutations, resolveSimulationWorldUpdate } from "./simulation-world-sync";
import type { CelestialBody, PendingWorldMutation, PhysicsSettings } from "@/simulation/types";

const body: CelestialBody = {
  id: "earth", name: "Earth", kind: "planet", massKg: 1e12, radiusM: 1,
  positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0,
};
const settings: PhysicsSettings = { gravitationalConstant: 0 };

describe("resolveSimulationWorldUpdate", () => {
  it("preserves batched edits, creates, removals and settings in revision order", () => {
    const mutations: PendingWorldMutation[] = [
      { revision: 4, mutation: { type: "REMOVE_BODY", bodyId: "earth" } },
      { revision: 2, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 2e12 } },
      { revision: 5, mutation: { type: "SET_SETTINGS", settings: { gravitationalConstant: 1e-10 } } },
      { revision: 3, mutation: { type: "CREATE_BODY", bodyType: "moon", primaryId: "earth" } },
    ];
    const submitted = resolvePendingWorldMutations(mutations, 1);
    expect(submitted.map((entry) => entry.revision)).toEqual([2, 3, 4, 5]);
    expect(submitted.map((entry) => entry.mutation.type)).toEqual(["EDIT_BODY", "CREATE_BODY", "REMOVE_BODY", "SET_SETTINGS"]);
    expect(mutations.map((entry) => entry.revision)).toEqual([4, 2, 5, 3]);
    expect(resolvePendingWorldMutations(mutations, 5)).toEqual([]);
    expect(resolvePendingWorldMutations(mutations.filter((entry) => entry.revision > 3), 5)).toEqual([]);
    expect(resolvePendingWorldMutations([...mutations, { revision: 6, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "radiusM", value: 4 } }], 5).map((entry) => entry.revision)).toEqual([6]);
  });

  it("never replaces worker positions from optimistic props when a mutation queue is provided, including after acknowledgement", () => {
    const edited = [{ ...body, massKg: 2e12 }];
    const state = {
      worldRevision: 2, lastSentRevision: 1,
      previousBodies: [body], previousSettings: settings, workerSnapshotBodies: [body],
    };
    const mutations: PendingWorldMutation[] = [{ revision: 2, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "massKg", value: 2e12 } }];
    expect(resolveSimulationWorldUpdate(edited, { gravitationalConstant: 1e-10 }, { ...state, mutations })).toBeNull();
    expect(resolveSimulationWorldUpdate(edited, { gravitationalConstant: 1e-10 }, { ...state, mutations: [] })).toBeNull();
  });
  it("uses settings-only command for a G change and does not echo snapshots", () => {
    const bodies = [body];
    const nextSettings = { gravitationalConstant: 1e-10 };
    const state = { worldRevision: 2, lastSentRevision: 1, previousBodies: bodies, previousSettings: settings, workerSnapshotBodies: bodies };

    expect(resolveSimulationWorldUpdate(bodies, nextSettings, state)).toEqual({ type: "SET_SETTINGS", settings: nextSettings });
    expect(resolveSimulationWorldUpdate(state.workerSnapshotBodies, settings, state)).toBeNull();
  });

  it("uses one atomic command when imported bodies and settings change together", () => {
    const importedBodies = [body, { ...body, id: "moon", positionM: [1e9, 0, 0] as const }];
    const importedSettings = { gravitationalConstant: 1e-12 };
    const previousBodies = [body];

    expect(resolveSimulationWorldUpdate(importedBodies, importedSettings, {
      worldRevision: 2, lastSentRevision: 1,
      worldReplacementRevision: 2, worldReplacementOrigin: "import",
      previousBodies, previousSettings: settings, workerSnapshotBodies: previousBodies,
    })).toEqual({ type: "SET_WORLD", bodies: importedBodies, settings: importedSettings, environmentSeed: 0x41535400, origin: "import" });
  });

  it("carries the replacement surface sidecar in the same SET_WORLD packet", () => {
    const surfaceData = { "earth-relief": [{ cellIndex: 2, elevationM: 500 }] };
    const importedBodies = [{ ...body, surface: { modelId: "sparse-relief-v1" as const, seed: 4, revision: 1, resolution: 64 as const, dataId: "earth-relief" } }];
    expect(resolveSimulationWorldUpdate(importedBodies, settings, {
      worldRevision: 2, lastSentRevision: 1, worldReplacementRevision: 2, worldReplacementOrigin: "import",
      previousBodies: [body], previousSettings: settings, workerSnapshotBodies: [body],
      worldReplacementSurfaceData: surfaceData,
    })).toMatchObject({ type: "SET_WORLD", surfaceData });
  });

  it("uses bodies-only command when only bodies change", () => {
    const nextBodies = [{ ...body, name: "Earth edited" }];
    expect(resolveSimulationWorldUpdate(nextBodies, settings, {
      worldRevision: 2, lastSentRevision: 1,
      previousBodies: [body], previousSettings: settings, workerSnapshotBodies: null,
    })).toEqual({ type: "SET_BODIES", bodies: nextBodies });
  });

  it("does not echo an older React snapshot after Worker references advanced at the same revision", () => {
    const renderedSnapshot = [{ ...body, positionM: [10, 0, 0] as const }];
    const latestWorkerSnapshot = [{ ...body, positionM: [20, 0, 0] as const }];
    expect(resolveSimulationWorldUpdate(renderedSnapshot, { ...settings }, {
      worldRevision: 1, lastSentRevision: 1,
      previousBodies: latestWorkerSnapshot,
      previousSettings: settings,
      workerSnapshotBodies: latestWorkerSnapshot,
    })).toBeNull();
  });

  it("does not resend the optimistic render or rollback of an already submitted revision", () => {
    const edited = [{ ...body, massKg: 2e12 }];
    const state = {
      worldRevision: 2, lastSentRevision: 2,
      previousBodies: [body], previousSettings: settings, workerSnapshotBodies: [body],
    };
    expect(resolveSimulationWorldUpdate(edited, settings, state)).toBeNull();
    expect(resolveSimulationWorldUpdate([body], settings, state)).toBeNull();
    expect(resolveSimulationWorldUpdate(edited, settings, { ...state, worldRevision: 1 })).toBeNull();
  });
});
