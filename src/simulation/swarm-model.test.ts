import { describe, expect, it } from "vitest";
import { createSwarmLedger, distributeSwarmShares, mergeSwarmShares, validateSwarmLedger } from "./swarm-model";
import type { CelestialBody } from "./types";

function body(id: string, massKg: number): CelestialBody {
  return { id, name: id, kind: "planet", bodyType: "asteroid", massKg, radiusM: 1, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 };
}

describe("physical swarm ledger", () => {
  it("assigns the complete representative mass exactly once", () => {
    const bodies = [body("ring-a", 2), body("ring-b", 3)];
    const ledger = createSwarmLedger(bodies, { environmentSeed: 17, profileId: "rock-v1", nextSequence: 0 });

    expect(ledger.groups[0]?.initialMassKg).toBe(5);
    expect(ledger.bodyMassShares).toEqual({ "ring-a": [{ swarmId: ledger.groups[0]?.id, massKg: 2 }], "ring-b": [{ swarmId: ledger.groups[0]?.id, massKg: 3 }] });
    expect(() => validateSwarmLedger(ledger, bodies)).not.toThrow();
  });

  it("registers a mixed merge as transfer into the swarm without adding gravity mass", () => {
    const initial = [body("ring-a", 2)];
    const ledger = createSwarmLedger(initial, { environmentSeed: 17, profileId: "rock-v1", nextSequence: 0 });
    const merged = body("ring-a", 7);
    const result = mergeSwarmShares(ledger, ["ring-a", "external"], merged, [body("ring-a", 2), body("external", 5)]);

    expect(result.ledger.bodyMassShares["ring-a"]?.[0]?.massKg).toBe(7);
    expect(result.ledger.groups[0]?.externalMassInKg).toBe(5);
    expect(result.transfers).toEqual([{ swarmId: ledger.groups[0]?.id, fromBodyIds: ["external"], toBodyId: "ring-a", massKg: 5, availableMassKg: 5 }]);
    expect(() => validateSwarmLedger(result.ledger, [merged])).not.toThrow();
  });

  it("distributes each group's attribution across fragments with an exact residual", () => {
    const source = body("ring-a", 10);
    const ledger = createSwarmLedger([source], { environmentSeed: 3, profileId: "iron-v1", nextSequence: 0 });
    const result = distributeSwarmShares(ledger, "ring-a", [body("fragment-1", 3), body("fragment-2", 7)]);

    expect(result.bodyMassShares["fragment-1"]?.[0]?.massKg).toBe(3);
    expect(result.bodyMassShares["fragment-2"]?.[0]?.massKg).toBe(7);
    expect(result.bodyMassShares["ring-a"]).toBeUndefined();
    expect(() => validateSwarmLedger(result, [body("fragment-1", 3), body("fragment-2", 7)])).not.toThrow();
  });
});
