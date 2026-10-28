import { describe, expect, it } from "vitest";
import { applyWorldMutation, validateWorldMutation } from "./world-mutations";
import { createEmptySwarmLedger } from "./swarm-model";
import { createOrbitalRing } from "./orbital-placement";
import { MAX_SIMULATION_BODIES } from "./physics";
import type { CelestialBody, PhysicsSettings } from "./types";

const settings: PhysicsSettings = { gravitationalConstant: 6.6743e-11 };
function planet(id: string, massKg = 8e24): CelestialBody {
  return { id, name: id, kind: "planet", bodyType: "rocky-planet", massKg, radiusM: 6e6, positionM: [1e9, 0, 0], velocityMs: [4, 5, 6], surfaceTemperatureK: 288, waterFraction: 0 };
}

describe("orbital world mutations", () => {
  it("creates a complete deterministic physical ring in one candidate", () => {
    const bodies = [planet("primary")];
    const mutation = { type: "CREATE_ORBITAL_RING", primaryId: "primary", innerRadiusM: 1e8, outerRadiusM: 1.2e8,
      representativeCount: 8, totalMassKg: 8e12, profileId: "rock-v1", planeNormal: [0, 0, 1] } as const;
    validateWorldMutation(mutation);
    const first = applyWorldMutation(bodies, settings, mutation, { swarmLedger: createEmptySwarmLedger(), environmentSeed: 123 });
    const replay = applyWorldMutation(bodies, settings, mutation, { swarmLedger: createEmptySwarmLedger(), environmentSeed: 123 });
    const particles = first.bodies.filter(({ id }) => id.includes("orbital-swarm-"));

    expect(particles).toHaveLength(8);
    expect(particles.reduce((sum, body) => sum + body.massKg, 0)).toBe(8e12);
    expect(first.swarmLedger.groups[0]?.seed).toBe(replay.swarmLedger.groups[0]?.seed);
    expect(first.swarmLedger.bodyMassShares).toEqual(replay.swarmLedger.bodyMassShares);
    const persistedGroup = first.swarmLedger.groups[0]!;
    const rebuilt = createOrbitalRing(bodies, "primary", { innerRadiusM: 1e8, outerRadiusM: 1.2e8,
      representativeCount: 8, totalMassKg: 8e12, profileId: "rock-v1", seed: persistedGroup.seed,
      planeNormal: [0, 0, 1], swarmId: persistedGroup.id }, settings);
    expect(rebuilt.particles.map(({ positionM, velocityMs }) => [positionM, velocityMs]))
      .toEqual(particles.map(({ positionM, velocityMs }) => [positionM, velocityMs]));
  });

  it("rejects the full ring when cap64 would be exceeded", () => {
    const bodies = Array.from({ length: MAX_SIMULATION_BODIES - 4 }, (_, index) => planet(`body-${index}`, 1e20));
    const ledger = createEmptySwarmLedger();
    expect(() => applyWorldMutation(bodies, settings, { type: "CREATE_ORBITAL_RING", primaryId: "body-0", innerRadiusM: 1e8,
      outerRadiusM: 2e8, representativeCount: 8, totalMassKg: 8e9, profileId: "rock-v1", planeNormal: [0, 0, 1] },
    { swarmLedger: ledger, environmentSeed: 1 })).toThrow(/64/);
    expect(bodies).toHaveLength(60);
    expect(ledger.groups).toHaveLength(0);
  });

  it("creates a catalog moon in an accepted circular orbit with one mutation", () => {
    const primary = planet("primary");
    const result = applyWorldMutation([primary], settings, { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: "primary",
      semiMajorAxisM: 4e8, planeNormal: [0, 0, 1], radialDirection: [1, 0, 0] },
    { swarmLedger: createEmptySwarmLedger(), environmentSeed: 1 });
    const moon = result.bodies.find(({ bodyType }) => bodyType === "moon")!;
    const acceptedPrimary = result.bodies.find(({ id }) => id === primary.id)!;
    const relative = moon.positionM.map((value, axis) => value - acceptedPrimary.positionM[axis]!);

    expect(moon.parentId).toBe(primary.id);
    expect(Math.hypot(...relative)).toBeCloseTo(4e8, 3);
    expect(result.swarmLedger.groups).toHaveLength(0);
  });

  it("rejects unknown own keys on orbital mutation payloads", () => {
    expect(() => validateWorldMutation({ type: "CREATE_ORBITAL_RING", primaryId: "p", innerRadiusM: 1, outerRadiusM: 2,
      representativeCount: 4, totalMassKg: 4, profileId: "rock-v1", planeNormal: [0, 0, 1], decorative: true })).toThrow();
  });
});
