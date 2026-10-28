import { describe, expect, it } from "vitest";
import { createOrbitalRing, placeBodyInCircularOrbit, placeBodyPairInCircularOrbit } from "./orbital-placement";
import { advanceSimulationInterval } from "./simulation-time";
import { createSwarmLedger } from "./swarm-model";
import { MAX_SIMULATION_BODIES } from "./physics";
import type { CelestialBody, PhysicsSettings } from "./types";

const settings: PhysicsSettings = { gravitationalConstant: 6.6743e-11 };
function body(id: string, massKg: number, radiusM = 10): CelestialBody {
  return { id, name: id, kind: "planet", bodyType: "rocky-planet", massKg, radiusM, positionM: [1e9, -2e9, 3e9], velocityMs: [4, 5, 6], surfaceTemperatureK: 288, waterFraction: 0 };
}

describe("orbital placement", () => {
  it("places a body in a circular orbit while preserving pair barycenter and momentum", () => {
    const primary = body("primary", 8e24, 6e6);
    const satellite = body("satellite", 2e20, 1e5);
    const result = placeBodyInCircularOrbit([primary, satellite], satellite.id, primary.id, 4e8, [0, 0, 1], [1, 0, 0], settings);
    const nextPrimary = result.find(({ id }) => id === primary.id)!;
    const nextSatellite = result.find(({ id }) => id === satellite.id)!;
    const relative = nextSatellite.positionM.map((value, axis) => value - nextPrimary.positionM[axis]!);
    const relativeVelocity = nextSatellite.velocityMs.map((value, axis) => value - nextPrimary.velocityMs[axis]!);

    expect(Math.hypot(...relative)).toBeCloseTo(4e8, 3);
    expect(Math.hypot(...relativeVelocity)).toBeCloseTo(Math.sqrt(settings.gravitationalConstant * (primary.massKg + satellite.massKg) / 4e8), 10);
    expect((primary.massKg * nextPrimary.positionM[0]! + satellite.massKg * nextSatellite.positionM[0]!) / (primary.massKg + satellite.massKg)).toBeCloseTo(primary.positionM[0], 3);
    expect((primary.massKg * nextPrimary.velocityMs[0]! + satellite.massKg * nextSatellite.velocityMs[0]!) / (primary.massKg + satellite.massKg)).toBeCloseTo(primary.velocityMs[0], 10);
  });

  it("builds a deterministic physical ring whose representative masses sum to the requested total", () => {
    const primary = body("primary", 8e24, 6e6);
    const first = createOrbitalRing([primary], primary.id, { innerRadiusM: 1e8, outerRadiusM: 1.2e8, representativeCount: 8, totalMassKg: 8e12, profileId: "rock-v1", seed: 17, planeNormal: [0, 0, 1] }, settings);
    const replay = createOrbitalRing([primary], primary.id, { innerRadiusM: 1e8, outerRadiusM: 1.2e8, representativeCount: 8, totalMassKg: 8e12, profileId: "rock-v1", seed: 17, planeNormal: [0, 0, 1] }, settings);

    expect(first.bodies.slice(1).map(({ positionM, velocityMs }) => [positionM, velocityMs])).toEqual(replay.bodies.slice(1).map(({ positionM, velocityMs }) => [positionM, velocityMs]));
    expect(first.bodies.slice(1).reduce((sum, particle) => sum + particle.massKg, 0)).toBe(8e12);
    expect(first.bodies.slice(1).every((particle) => particle.massKg > 0 && particle.radiusM > 0)).toBe(true);
  });

  it("uses the supplied radial direction as the ring azimuth while preserving the axis presets", () => {
    const primary = body("primary", 8e24, 6e6);
    const input = { innerRadiusM: 1e8, outerRadiusM: 1.2e8, representativeCount: 8, totalMassKg: 8e12,
      profileId: "rock-v1" as const, seed: 17, planeNormal: [0, 0, 1] as const };
    const defaultAxes = createOrbitalRing([primary], primary.id, input, settings);
    const explicitPreset = createOrbitalRing([primary], primary.id, { ...input, radialDirection: [1, 0, 0] }, settings);
    const rotated = createOrbitalRing([primary], primary.id, { ...input, radialDirection: [0, 1, 0] }, settings);

    expect(explicitPreset.particles.map(({ positionM, velocityMs }) => [positionM, velocityMs]))
      .toEqual(defaultAxes.particles.map(({ positionM, velocityMs }) => [positionM, velocityMs]));
    for (let index = 0; index < defaultAxes.particles.length; index += 1) {
      const original = defaultAxes.particles[index]!;
      const turned = rotated.particles[index]!;
      expect(turned.positionM[0] - primary.positionM[0]).toBeCloseTo(-(original.positionM[1] - primary.positionM[1]), 4);
      expect(turned.positionM[1] - primary.positionM[1]).toBeCloseTo(original.positionM[0] - primary.positionM[0], 4);
      expect(turned.velocityMs[0] - primary.velocityMs[0]).toBeCloseTo(-(original.velocityMs[1] - primary.velocityMs[1]), 9);
      expect(turned.velocityMs[1] - primary.velocityMs[1]).toBeCloseTo(original.velocityMs[0] - primary.velocityMs[0], 9);
    }
  });

  it("changes the physical swarm trajectory under a nearby perturbing body reproducibly", () => {
    const primary = body("primary", 8e24, 6e6);
    const ring = createOrbitalRing([primary], primary.id, { innerRadiusM: 1e8, outerRadiusM: 1.2e8,
      representativeCount: 4, totalMassKg: 8e12, profileId: "rock-v1", seed: 17, planeNormal: [0, 0, 1] }, settings);
    const ledger = createSwarmLedger(ring.particles, { environmentSeed: 17, profileId: "rock-v1", nextSequence: 0 });
    const perturber = body("perturber", 1e22, 1e5);
    const withPerturber = [...ring.bodies, { ...perturber,
      positionM: [primary.positionM[0], primary.positionM[1] + 1.5e8, primary.positionM[2]] as const,
      velocityMs: primary.velocityMs }];
    const withoutPerturber = advanceSimulationInterval(ring.bodies, settings, 1_000, 100, { swarmLedger: ledger });
    const perturbed = advanceSimulationInterval(withPerturber, settings, 1_000, 100, { swarmLedger: ledger });
    const replay = advanceSimulationInterval(withPerturber, settings, 1_000, 100, { swarmLedger: ledger });
    const particleId = ring.particles[0]!.id;
    const basePosition = withoutPerturber.bodies.find(({ id }) => id === particleId)!.positionM;
    const perturbedPosition = perturbed.bodies.find(({ id }) => id === particleId)!.positionM;

    expect(perturbedPosition).not.toEqual(basePosition);
    expect(replay.bodies.find(({ id }) => id === particleId)!.positionM).toEqual(perturbedPosition);
  });

  it("rejects a ring that would cross the 64-body cap without returning a partial ring", () => {
    const existing = Array.from({ length: MAX_SIMULATION_BODIES - 4 }, (_, index) => body(`body-${index}`, 1e10));
    expect(() => createOrbitalRing(existing, existing[0]!.id, { innerRadiusM: 1e7, outerRadiusM: 2e7, representativeCount: 8, totalMassKg: 8e6, profileId: "rock-v1", seed: 1, planeNormal: [0, 0, 1] }, settings)).toThrow(/64/);
  });

  it("places a binary pair at its barycenter with zero net linear momentum", () => {
    const first = body("a", 7e24);
    const second = body("b", 2e24);
    const result = placeBodyPairInCircularOrbit([first, second], first.id, second.id, 1e8, [0, 0, 1], [1, 0, 0], settings);
    const a = result.find(({ id }) => id === first.id)!;
    const b = result.find(({ id }) => id === second.id)!;

    expect((a.massKg * a.positionM[0] + b.massKg * b.positionM[0]) / (a.massKg + b.massKg)).toBeCloseTo(first.positionM[0], 3);
    expect(a.massKg * a.velocityMs[0] + b.massKg * b.velocityMs[0]).toBeCloseTo((first.massKg + second.massKg) * first.velocityMs[0], 3);
  });
});
