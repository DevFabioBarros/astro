import { describe, expect, it } from "vitest";
import { captureBlackHole, mergeCollision } from "./collisions";
import { materialCompositionFromFractions, calculateMaterialRadiusM } from "./material-profiles";
import { createSwarmLedger, validateSwarmLedger } from "./swarm-model";
import type { CelestialBody, PhysicsSettings } from "./types";

const settings: PhysicsSettings = { gravitationalConstant: 6.6743e-11 };
function rocky(id: string, massKg: number, x: number): CelestialBody {
  const fractions = { rock: 1, iron: 0, gas: 0 };
  return { id, name: id, kind: "planet", bodyType: "asteroid", massKg,
    radiusM: calculateMaterialRadiusM(massKg, fractions), positionM: [x, 0, 0], velocityMs: [0, 0, 0],
    surfaceTemperatureK: 150, waterFraction: 0, materials: materialCompositionFromFractions(massKg, fractions) };
}

describe("physical swarm collision transfers", () => {
  it("merges compatible material mass into an existing group without double counting", () => {
    const member = rocky("ring-a", 2e10, 0);
    const external = rocky("external", 1e10, member.radiusM);
    const ledger = createSwarmLedger([member], { environmentSeed: 7, profileId: "rock-v1", nextSequence: 0 });

    const result = mergeCollision([member, external], 0, 1, settings, ledger);
    const remnant = result.bodies.find(({ id }) => id === member.id)!;
    const group = result.swarmLedger!.groups[0]!;

    expect(remnant.massKg).toBe(member.massKg + external.massKg);
    expect(result.swarmLedger!.bodyMassShares[remnant.id]?.reduce((sum, share) => sum + share.massKg, 0)).toBe(remnant.massKg);
    expect(group.initialMassKg + group.externalMassInKg).toBe(remnant.massKg);
    expect(result.event.swarmTransfers).toContainEqual({ swarmId: group.id, fromBodyIds: [external.id], toBodyId: remnant.id,
      massKg: external.massKg, availableMassKg: external.massKg });
    validateSwarmLedger(result.swarmLedger, result.bodies);
  });

  it("captures a materialized swarm member into a black hole while retaining total mass and attribution", () => {
    const member = rocky("ring-a", 2e10, 100);
    const blackHole: CelestialBody = { id: "bh", name: "BH", kind: "star", bodyType: "black-hole", massKg: 1e20,
      radiusM: 2 * 6.6743e-11 * 1e20 / (299_792_458 ** 2), positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 };
    const ledger = createSwarmLedger([member], { environmentSeed: 7, profileId: "rock-v1", nextSequence: 0 });

    const result = captureBlackHole([blackHole, member], 0, 1, 200, settings, ledger);
    const remnant = result.bodies[0]!;

    expect(remnant.massKg).toBe(blackHole.massKg + member.massKg);
    expect(remnant).not.toHaveProperty("materials");
    expect(result.swarmLedger.bodyMassShares[blackHole.id]?.[0]?.massKg).toBe(remnant.massKg);
    expect(result.event.swarmTransfers?.some((transfer) => transfer.fromBodyIds.includes(member.id) && transfer.toBodyId === blackHole.id)).toBe(true);
    validateSwarmLedger(result.swarmLedger, result.bodies);
  });
});
