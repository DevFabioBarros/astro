import { describe, expect, it } from "vitest";
import { isValidSimulationEvent } from "./simulation-event-validation";
import { advanceSimulationInterval } from "./simulation-time";
import { createSwarmLedger } from "./swarm-model";
import type { CelestialBody } from "./types";

const event = {
  id: 1, type: "impulse", timeSeconds: 2, positionM: [1, 2, 3], radiusM: 4, energyJ: 5, bodyIds: ["moon"],
  impulse: { modelId: "center-of-mass-impulse-v1", deltaVelocityMs: [-1, 0, 0], impulseNs: [-10, 0, 0], externalWorkJ: -5 },
};

describe("accepted impulse event validation", () => {
  it("accepts one center-of-mass impulse with signed work and bounded energy magnitude", () => {
    expect(isValidSimulationEvent(event)).toBe(true);
  });

  it("rejects mismatched energy, missing impulse vector, and multiple targets", () => {
    expect(isValidSimulationEvent({ ...event, energyJ: 4 })).toBe(false);
    expect(isValidSimulationEvent({ ...event, impulse: { ...event.impulse, deltaVelocityMs: [0, Number.NaN, 0] } })).toBe(false);
    expect(isValidSimulationEvent({ ...event, bodyIds: ["moon", "earth"] })).toBe(false);
  });
});

describe("accepted laser energy ledger validation", () => {
  const laser = { id: 2, type: "laser", timeSeconds: 2, positionM: [1, 2, 3], radiusM: 4,
    energyJ: 2e9, bodyIds: ["moon"], laser: { modelId: "laser-energy-ledger-v1",
      profileId: "grey-albedo-laser-absorption-v1", bodyLocalDirection: [0, 0, 1],
      powerW: 2e8, durationAcceptedSeconds: 10, albedo: 0.3, inputJ: 2e9,
      absorbedJ: 1.4e9, reflectedJ: 0.6e9 } };

  it("accepts a normalized body-local direction and a closed bounded ledger", () => {
    expect(isValidSimulationEvent(laser)).toBe(true);
  });

  it("rejects an unclosed ledger, non-normalized direction, or excessive power", () => {
    expect(isValidSimulationEvent({ ...laser, laser: { ...laser.laser, reflectedJ: 1 } })).toBe(false);
    expect(isValidSimulationEvent({ ...laser, laser: { ...laser.laser, bodyLocalDirection: [0, 0, 2] } })).toBe(false);
    expect(isValidSimulationEvent({ ...laser, laser: { ...laser.laser, powerW: 1e16 } })).toBe(false);
  });
});

describe("accepted swarm mass transfer validation", () => {
  const collision = { id: 3, type: "collision", timeSeconds: 5, positionM: [0, 0, 0], radiusM: 2, energyJ: 0,
    bodyIds: ["particle", "remnant"], swarmTransfers: [{ swarmId: "orbital-swarm-1", fromBodyIds: ["particle"], toBodyId: "remnant", massKg: 10, availableMassKg: 10 }] };
  const capture = { id: 4, type: "black-hole-capture", timeSeconds: 6, positionM: [0, 0, 0], radiusM: 2, energyJ: 0,
    bodyIds: ["bh", "particle"], outcome: { kind: "creative-accretion", modelId: "creative-accretion-v1", captorBodyId: "bh", absorbedBodyId: "particle", captureRadiusM: 5 },
    swarmTransfers: [{ swarmId: "orbital-swarm-1", fromBodyIds: ["particle"], toBodyId: "bh", massKg: 10, availableMassKg: 10 }] };

  it("accepts bounded positive transfers for fusion and capture participants", () => {
    expect(isValidSimulationEvent(collision)).toBe(true);
    expect(isValidSimulationEvent(capture)).toBe(true);
  });

  it("rejects invalid, duplicate, out-of-event, oversized, or misplaced transfer sources", () => {
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [{ ...collision.swarmTransfers[0], massKg: 0 }] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [{ ...collision.swarmTransfers[0], fromBodyIds: ["particle", "particle"] }] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [{ ...collision.swarmTransfers[0], fromBodyIds: ["unknown"] }] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [{ ...collision.swarmTransfers[0], extra: true }] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [collision.swarmTransfers[0], collision.swarmTransfers[0]] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [{ ...collision.swarmTransfers[0], fromBodyIds: Array.from({ length: 65 }, (_, index) => `body-${index}`) }] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, swarmTransfers: [{ ...collision.swarmTransfers[0], massKg: 11 }] })).toBe(false);
    expect(isValidSimulationEvent({ ...collision, type: "explosion", swarmTransfers: collision.swarmTransfers })).toBe(false);
  });

  it("validates a real merge-to-six-fragments transfer from one source", () => {
    const makeBody = (id: string, x: number, velocity: number): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000,
      positionM: [x, 0, 0], velocityMs: [velocity, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
    });
    const first = makeBody("source-a", -10_000, 100);
    const second = makeBody("source-b", 10_000, -100);
    const ledger = createSwarmLedger([first], { environmentSeed: 11, profileId: "rock-v1", nextSequence: 0 });
    const result = advanceSimulationInterval([first, second], { gravitationalConstant: 0 }, 90, 1,
      { collisionMode: "creative", swarmLedger: ledger });
    const event = result.events[0]!;
    if (event.type !== "collision" || event.outcome?.kind !== "creative-fragmentation") throw new Error("Esperava fusão seguida de fragmentação.");

    const outgoing = event.swarmTransfers!.filter(({ fromBodyIds }) => fromBodyIds[0] === "source-a");
    expect(outgoing).toHaveLength(6);
    expect(new Set(outgoing.map(({ toBodyId }) => toBodyId)).size).toBe(6);
    expect(outgoing.reduce((sum, transfer) => sum + transfer.massKg, 0)).toBe(2e15);
    expect(outgoing.every((transfer) => transfer.availableMassKg === 2e15)).toBe(true);
    expect(isValidSimulationEvent({ ...event, id: 9 })).toBe(true);
    const overdrawn = outgoing.map((transfer, index) => index < 2 ? { ...transfer, massKg: 1.2e15 } : transfer);
    expect(isValidSimulationEvent({ ...event, id: 10,
      swarmTransfers: [...event.swarmTransfers!.filter(({ fromBodyIds }) => fromBodyIds[0] !== "source-a"), ...overdrawn] })).toBe(false);
  });
});
