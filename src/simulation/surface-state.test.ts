import { describe, expect, it } from "vitest";
import { isSurfaceStateAcceptedAtSnapshot, isValidSurfaceMetadata, validateSurfaceData } from "./surface-state";
import { isValidSurfaceHeatPayload } from "./surface-heat";
import type { SurfaceMetadata } from "./types";

const metadata: SurfaceMetadata = {
  modelId: "sparse-relief-v1", seed: 0xffff_ffff, revision: 0, resolution: 64, dataId: "earth-relief",
};

describe("bounded sparse surface state", () => {
  it("accepts only fixed-resolution metadata with uint32 seed and safe revision", () => {
    expect(isValidSurfaceMetadata(metadata)).toBe(true);
    expect(isValidSurfaceMetadata({ ...metadata, seed: -1 })).toBe(false);
    expect(isValidSurfaceMetadata({ ...metadata, revision: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isValidSurfaceMetadata({ ...metadata, resolution: 32 })).toBe(false);
    expect(isValidSurfaceMetadata({ ...metadata, modelId: "other" })).toBe(false);
    expect(isValidSurfaceMetadata({ ...metadata, unexpected: true })).toBe(false);
  });

  it("validates sparse relief cells as unique, bounded SI values in the fixed grid", () => {
    expect(() => validateSurfaceData({ "earth-relief": [
      { cellIndex: 0, elevationM: -10_000 }, { cellIndex: 2047, elevationM: 10_000 },
    ] }, [metadata])).not.toThrow();
    expect(() => validateSurfaceData({ "earth-relief": [
      { cellIndex: 1, elevationM: 1 }, { cellIndex: 1, elevationM: 2 },
    ] }, [metadata])).toThrow();
    expect(() => validateSurfaceData({ "earth-relief": [{ cellIndex: 2048, elevationM: 0 }] }, [metadata])).toThrow();
    expect(() => validateSurfaceData({ "earth-relief": [{ cellIndex: 0, elevationM: Infinity }] }, [metadata])).toThrow();
    expect(() => validateSurfaceData({ orphan: [] }, [metadata])).toThrow();
    expect(() => validateSurfaceData({}, [metadata])).toThrow();
  });

  it("accepts heat sidecars only for the exact accepted snapshot revision", () => {
    const state = { type: "SURFACE_STATE" as const, worldRevision: 4, surfaceData: { "earth-relief": [] }, surfaceHeatData: { "earth-relief": [] } };
    expect(isSurfaceStateAcceptedAtSnapshot(state, 4, 3)).toBe(true);
    expect(isSurfaceStateAcceptedAtSnapshot(state, 5, 3)).toBe(false);
    expect(isSurfaceStateAcceptedAtSnapshot({ ...state, worldRevision: 3 }, 4, 3)).toBe(false);
  });

  it("validates bounded heat-energy patches without accepting malformed values", () => {
    expect(isValidSurfaceHeatPayload({ "earth-relief": [{ cellIndex: 42, energyJ: 1e12 }] })).toBe(true);
    expect(isValidSurfaceHeatPayload({ "earth-relief": [{ cellIndex: 2048, energyJ: 1 }] })).toBe(false);
    expect(isValidSurfaceHeatPayload({ "earth-relief": [{ cellIndex: 2, energyJ: Infinity }] })).toBe(false);
    expect(isValidSurfaceHeatPayload({ "earth-relief": [{ cellIndex: 2, energyJ: 1 }, { cellIndex: 2, energyJ: 2 }] })).toBe(false);
  });
});
