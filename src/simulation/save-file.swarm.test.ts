import { describe, expect, it } from "vitest";
import { encodeSimulation, decodeSimulation } from "./save-file";
import { createSwarmLedger } from "./swarm-model";
import type { CelestialBody, PhysicsSettings } from "./types";

const settings: PhysicsSettings = { gravitationalConstant: 0 };
const body: CelestialBody = { id: "physical-particle", name: "Particle", kind: "planet", bodyType: "asteroid", massKg: 1e12,
  radiusM: 1000, positionM: [1e8, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 150, waterFraction: 0 };

describe("swarm save v11", () => {
  it("emits strict v11 only for a physical swarm and round trips its mass ledger", () => {
    const swarmLedger = createSwarmLedger([body], { environmentSeed: 91, profileId: "rock-v1", nextSequence: 0 });
    const text = encodeSimulation([body], settings, undefined, 12, undefined, swarmLedger);
    const encoded = JSON.parse(text);
    const decoded = decodeSimulation(text);

    expect(encoded.version).toBe(11);
    expect(decoded.environmentSeed).toBe(12);
    expect(decoded.swarmLedger).toEqual(swarmLedger);
    expect(decoded.swarmLedger?.groups[0]?.seed).toBe(swarmLedger.groups[0]?.seed);
    expect(decoded.swarmLedger?.groups[0]?.seed).not.toBe(decoded.environmentSeed);
    expect(() => decodeSimulation(JSON.stringify({ ...encoded, extra: true }))).toThrow();
    expect(() => decodeSimulation(JSON.stringify({ ...encoded, world: { ...encoded.world, unknown: 1 } }))).toThrow();
  });

  it("keeps empty-ledger worlds on the current non-swarm save version", () => {
    expect(JSON.parse(encodeSimulation([body], settings, undefined, 12, undefined,
      { modelId: "physical-swarm-ledger-v1", nextSequence: 0, groups: [], bodyMassShares: {} })).version).toBe(8);
  });
});
