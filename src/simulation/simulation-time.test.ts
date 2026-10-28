import { describe, expect, it, vi } from "vitest";
import { advanceSimulationInterval, advanceSimulationTime, DEFAULT_SIMULATION_SPEED, MAX_SIMULATION_SPEED, SIMULATION_SPEEDS } from "./simulation-time";
import { createSolarSystem } from "./solar-system";
import type { CelestialBody } from "./types";
import * as world from "./world";
import { MAX_SIMULATION_BODIES } from "./physics";
import { findSweptBlackHoleCapture } from "./collisions";
import { advanceThermalTemperatures } from "./thermal-model";
import { createMaterialCompositionCandidate } from "./body-edits";
import { MAX_SURFACE_HEAT_DATA_BYTES } from "./surface-heat";
import { adoptWaterInventory } from "./water-model";
import { createSwarmLedger, validateSwarmLedger } from "./swarm-model";

const settings = { gravitationalConstant: 6.6743e-11 };
function totalEnergy(bodies: readonly CelestialBody[]): number {
  let energy = bodies.reduce((sum, body) => sum + 0.5 * body.massKg * body.velocityMs.reduce((squared, value) => squared + value ** 2, 0), 0);
  for (let first = 0; first < bodies.length; first += 1) {
    for (let second = first + 1; second < bodies.length; second += 1) {
      const a = bodies[first]!;
      const b = bodies[second]!;
      energy -= settings.gravitationalConstant * a.massKg * b.massKg / Math.hypot(...a.positionM.map((value, axis) => value - b.positionM[axis]!));
    }
  }
  return energy;
}
function totalMomentum(bodies: readonly CelestialBody[]): [number, number, number] {
  return bodies.reduce((total, body) => total.map((value, axis) => value + body.massKg * body.velocityMs[axis]!) as [number, number, number], [0, 0, 0]);
}
function angularMomentumZ(bodies: readonly CelestialBody[]): number {
  return bodies.reduce((total, body) => total + body.massKg * (body.positionM[0] * body.velocityMs[1] - body.positionM[1] * body.velocityMs[0]), 0);
}
function bodyPositionError(first: readonly CelestialBody[], second: readonly CelestialBody[]): number {
  return Math.hypot(...first[1]!.positionM.map((value, axis) => value - second[1]!.positionM[axis]!));
}

describe("astronomical simulation time", () => {
  it("reduces swarm attribution with water mass that escapes during an accepted tick", () => {
    const planet = { ...createSolarSystem()[3]!, id: "swarm-water-world", name: "Warm Swarm World",
      thermalProfileId: "earthlike-global-mean-v1" as const, surfaceTemperatureK: 750, positionM: [1e9, 0, 0] as const };
    const material = createMaterialCompositionCandidate([planet], settings, planet.id,
      "mass-authoritative", { rock: 0.7, iron: 0.3, gas: 0 })[0]!;
    const wet = adoptWaterInventory(material);
    const star: CelestialBody = { id: "heater", name: "Heater", kind: "star", bodyType: "star", massKg: 1e30,
      radiusM: 6e8, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 10_000, waterFraction: 0 };
    const swarmLedger = createSwarmLedger([wet], { environmentSeed: 7, profileId: "rock-v1", nextSequence: 0 });
    const result = advanceSimulationInterval([star, wet], { gravitationalConstant: 0 }, 3_600, 3_600, { swarmLedger });
    const accepted = result.bodies.find(({ id }) => id === wet.id)!;
    const share = result.swarmLedger.bodyMassShares[wet.id]?.[0];

    expect(accepted.waterInventory!.escapedKg).toBeGreaterThan(wet.waterInventory!.escapedKg);
    expect(accepted.massKg).toBeLessThan(wet.massKg);
    expect(share?.massKg).toBe(accepted.massKg);
    expect(result.swarmLedger.groups[0]?.externalMassOutKg).toBeGreaterThan(0);
    expect(() => validateSwarmLedger(result.swarmLedger, result.bodies)).not.toThrow();
  });

  it("rejects dense-world intervals above the pair budget before any numerical integration", () => {
    const bodies = Array.from({ length: MAX_SIMULATION_BODIES }, (_, index) => ({
      ...createSolarSystem()[3]!, id: `body-${index}`, massKg: 1,
      positionM: [index * 1e9, 0, 0] as const, velocityMs: [0, 0, 0] as const,
    }));
    const saved = structuredClone(bodies);
    const advance = vi.spyOn(world, "advanceWorld");
    try {
      expect(() => advanceSimulationTime(bodies, settings, 3_600 * 13)).toThrow("Reduza a velocidade");
      expect(advance).not.toHaveBeenCalled();
      expect(bodies).toEqual(saved);
    } finally {
      advance.mockRestore();
    }
  });
  it("offers physical time rates up to one month per real second", () => {
    expect(DEFAULT_SIMULATION_SPEED).toBe(86_400);
    expect(SIMULATION_SPEEDS.map(({ value }) => value)).toEqual([1, 60, 600, 3_600, 86_400, 604_800, 2_592_000]);
    expect(MAX_SIMULATION_SPEED).toBe(SIMULATION_SPEEDS.at(-1)?.value);
  });

  it("resolves 17 independent initial contacts in one atomic interval", () => {
    const template = createSolarSystem()[3]!;
    const bodies = Array.from({ length: 17 }, (_, pair) => [0, 1].map((side) => ({
      ...template, id: `pair-${pair}-${side}`, massKg: 1, radiusM: 1,
      positionM: [pair * 10 + side, 0, 0] as const, velocityMs: [0, 0, 0] as const,
    }))).flat();
    const result = advanceSimulationInterval(bodies, { gravitationalConstant: 0 }, 0.25, 1);

    expect(result.events).toHaveLength(17);
    expect(result.bodies).toHaveLength(17);
    expect(result.events.map(({ bodyIds }) => bodyIds)).toEqual(Array.from({ length: 17 }, (_, pair) => [`pair-${pair}-0`, `pair-${pair}-1`]));
    expect(bodies).toHaveLength(34);
  });

  it("advances a fractional interval and rolls back when a later fractional step fails", () => {
    const initial = [{ ...createSolarSystem()[3]!, id: "probe", massKg: 1, radiusM: 1,
      positionM: [0, 0, 0] as const, velocityMs: [1, 0, 0] as const }];
    const result = advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 0.25, 0.1);
    expect(result.bodies[0]?.positionM[0]).toBeCloseTo(0.25, 12);

    const advance = vi.spyOn(world, "advanceWorld").mockImplementationOnce(() => [{ ...initial[0]!, positionM: [0.1, 0, 0] }])
      .mockImplementationOnce(() => { throw new Error("fractional step failed"); });
    const saved = structuredClone(initial);
    try {
      expect(() => advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 0.25, 0.1)).toThrow("fractional step failed");
      expect(initial).toEqual(saved);
    } finally {
      advance.mockRestore();
    }
  });

  it("collects only accepted substep positions when explicitly requested", () => {
    const initial = [{ ...createSolarSystem()[3]!, id: "probe", massKg: 1, radiusM: 1,
      positionM: [0, 0, 0] as const, velocityMs: [1, 0, 0] as const }];
    const result = advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 10, 3, { captureSamples: true });

    expect(result.samples?.map(({ offsetSeconds }) => offsetSeconds)).toEqual([3, 6, 9, 10]);
    expect(result.samples?.map(({ bodies }) => bodies[0]?.positionM[0])).toEqual([3, 6, 9, 10]);
    expect(result.samples?.at(-1)?.bodies).toEqual(result.bodies.map(({ id, positionM }) => ({ id, positionM })));
    expect(advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 10, 3)).not.toHaveProperty("samples");
    expect(advanceSimulationTime(initial, { gravitationalConstant: 0 }, 10, 3)).toEqual(result.bodies);
  });

  it("caps source samples while preserving real interval endpoints", () => {
    const initial = [{ ...createSolarSystem()[3]!, id: "probe", massKg: 1, radiusM: 1,
      positionM: [0, 0, 0] as const, velocityMs: [1, 0, 0] as const }];
    const result = advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 512, 1, { captureSamples: true });
    const expectedOffsets = [1, ...Array.from({ length: 64 }, (_, index) => (index + 1) * 8)];

    expect(result.samples?.map(({ offsetSeconds }) => offsetSeconds)).toEqual(expectedOffsets);
    expect(result.samples?.map(({ bodies }) => bodies[0]?.positionM[0])).toEqual(expectedOffsets);
    expect(result.samples!.length).toBeLessThanOrEqual(128);
    expect(result.samplesTruncated).toBe(true);
    expect(result.samples?.[0]?.offsetSeconds).toBe(1);
    expect(result.samples?.at(-1)?.offsetSeconds).toBe(512);
    expect(result.samples?.at(-1)?.bodies).toEqual(result.bodies.map(({ id, positionM }) => ({ id, positionM })));
  });

  it("moves the real Solar System through a month while keeping energy and orbital radius stable", () => {
    const initial = createSolarSystem();
    const initialEnergy = totalEnergy(initial);
    let bodies = initial;
    for (let tick = 0; tick < 40; tick += 1) bodies = advanceSimulationTime(bodies, settings, MAX_SIMULATION_SPEED * 0.025);
    const earth = bodies.find(({ id }) => id === "earth")!;
    const initialEarth = initial.find(({ id }) => id === "earth")!;
    const sun = bodies.find(({ id }) => id === "sun")!;
    expect(Math.hypot(...earth.positionM.map((value, axis) => value - initialEarth.positionM[axis]!))).toBeGreaterThan(5e10);
    const orbitalRadius = Math.hypot(...earth.positionM.map((value, axis) => value - sun.positionM[axis]!));
    expect(orbitalRadius).toBeGreaterThan(1.4e11);
    expect(orbitalRadius).toBeLessThan(1.6e11);
    expect(bodies.flatMap(({ positionM, velocityMs }) => [...positionM, ...velocityMs]).every(Number.isFinite)).toBe(true);
    expect(Math.abs((totalEnergy(bodies) - initialEnergy) / initialEnergy)).toBeLessThan(1e-5);
    expect(initial.find(({ id }) => id === "earth")?.positionM).toEqual(initialEarth.positionM);
  });

  it("converges on an eccentric orbit while conserving energy, momentum, and angular momentum", () => {
    const totalMass = 1.001e24;
    const relativePosition = 1e8;
    const relativeSpeed = 1_100;
    const initial: CelestialBody[] = [
      { ...createSolarSystem()[0]!, id: "primary", massKg: 1e24, radiusM: 1e3,
        positionM: [-relativePosition * 1e21 / totalMass, 0, 0], velocityMs: [0, -relativeSpeed * 1e21 / totalMass, 0] },
      { ...createSolarSystem()[3]!, id: "orbiting", massKg: 1e21, radiusM: 1e3,
        positionM: [relativePosition * 1e24 / totalMass, 0, 0], velocityMs: [0, relativeSpeed * 1e24 / totalMass, 0] },
    ];
    const initialEnergy = totalEnergy(initial);
    const initialMomentum = totalMomentum(initial);
    const initialAngularMomentum = angularMomentumZ(initial);
    const coarse = advanceSimulationTime(initial, settings, 400, 20);
    const fine = advanceSimulationTime(initial, settings, 400, 10);
    const quarterStep = advanceSimulationTime(initial, settings, 400, 5);
    const reference = advanceSimulationTime(initial, settings, 400, 2.5);
    const coarseError = bodyPositionError(coarse, reference);
    const fineError = bodyPositionError(fine, reference);
    expect(coarseError / fineError).toBeGreaterThan(3.5);
    expect(coarseError / fineError).toBeLessThan(4.5);
    const referenceEnergy = totalEnergy(reference);
    const coarseEnergyError = Math.abs((totalEnergy(coarse) - referenceEnergy) / initialEnergy);
    const fineEnergyError = Math.abs((totalEnergy(fine) - referenceEnergy) / initialEnergy);
    const quarterStepEnergyError = Math.abs((totalEnergy(quarterStep) - referenceEnergy) / initialEnergy);
    expect(coarseEnergyError).toBeGreaterThan(fineEnergyError);
    expect(fineEnergyError).toBeGreaterThan(quarterStepEnergyError);
    expect(Math.abs((referenceEnergy - initialEnergy) / initialEnergy)).toBeLessThan(1e-8);
    const finalMomentum = totalMomentum(reference);
    expect(Math.hypot(...finalMomentum.map((value, axis) => value - initialMomentum[axis]!)) / (1e21 * relativeSpeed)).toBeLessThan(1e-12);
    expect(Math.abs((angularMomentumZ(reference) - initialAngularMomentum) / initialAngularMomentum)).toBeLessThan(1e-12);
    expect(Math.abs(Math.hypot(...reference[1]!.positionM) / relativePosition - 1)).toBeGreaterThan(1e-4);
  });

  it("uses accepted prefix time for atmospheric heating when close-encounter work reaches the budget", () => {
    const a = { ...createSolarSystem()[3]!, id: "budget-a", name: "Budget A", thermalProfileId: "earthlike-global-mean-v1" as const, massKg: 1e-30, radiusM: 1e-12, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const };
    const b = { ...a, id: "other", positionM: [1e-6, 0, 0] as const, velocityMs: [1, 0, 0] as const };
    const earth = { ...createSolarSystem()[3]!, thermalProfileId: "earthlike-global-mean-v1" as const,
      surfaceTemperatureK: 800, positionM: [1e12, 0, 0] as const };
    const materialEarth = createMaterialCompositionCandidate([earth], settings, earth.id,
      "mass-authoritative", { rock: 0.7, iron: 0.3, gas: 0 })[0]!;
    const atmosphericEarth = { ...materialEarth, massKg: materialEarth.massKg + 5e18,
      atmosphere: { modelId: "isothermal-atmosphere-v1" as const, profileId: "nitrogen-oxygen-v1" as const,
        dryGasMassKg: 5e18, isothermalTemperatureK: 288 } };
    const bodies = [a, b, atmosphericEarth];
    const saved = structuredClone(bodies);
    const result = advanceSimulationInterval(bodies, settings, 1_000, 3_600);
    expect(result.budgetLimited).toBe(true);
    expect(result.advancedSeconds).toBeGreaterThan(0);
    expect(result.advancedSeconds).toBeLessThan(1_000);
    expect(result.bodies).not.toEqual(saved);
    const expectedThermalPrefix = advanceThermalTemperatures(saved, result.bodies, result.advancedSeconds, settings.gravitationalConstant)[2]!.surfaceTemperatureK;
    const fullIntervalThermal = advanceThermalTemperatures(saved, result.bodies, 1_000, settings.gravitationalConstant)[2]!.surfaceTemperatureK;
    const noAtmosphereStart = { ...saved[2]! };
    const noAtmosphereEnd = { ...result.bodies[2]! };
    delete noAtmosphereStart.atmosphere;
    delete noAtmosphereEnd.atmosphere;
    const noAtmospherePrefix = advanceThermalTemperatures([noAtmosphereStart], [noAtmosphereEnd], result.advancedSeconds)[0]!.surfaceTemperatureK;
    expect(expectedThermalPrefix).not.toBe(fullIntervalThermal);
    expect(result.bodies[2]!.surfaceTemperatureK).toBeCloseTo(expectedThermalPrefix, 10);
    expect(expectedThermalPrefix).toBeGreaterThan(noAtmospherePrefix);
    expect(bodies).toEqual(saved);
  });

  it("sweeps a fast radius collision and merges mass, momentum, and volume", () => {
    const makeBody = (id: string, x: number, velocity: number): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000,
      positionM: [x, 0, 0], velocityMs: [velocity, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
    });
    const start = [makeBody("impact-a", -10_000, 100), makeBody("impact-b", 10_000, -100)];
    const result = advanceSimulationInterval(start, { gravitationalConstant: 0 }, 90, 1);

    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]).toMatchObject({ massKg: 2e15, velocityMs: [0, 0, 0] });
    expect(result.bodies[0]!.radiusM).toBeCloseTo(2 ** (1 / 3) * 1_000, 9);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "collision", bodyIds: ["impact-a", "impact-b"] });
    expect(result.events[0]?.collisionDiagnostics).toMatchObject({
      modelId: "perfectly-inelastic-merge-v1", relativeSpeedMps: 200,
      specificImpactEnergyJkg: 5_000,
      impactAngleRad: 0,
    });
  });

  it("returns accepted crater relief with a merge while keeping the body physics equal to the merge", () => {
    const metadata = { modelId: "sparse-relief-v1" as const, seed: 7, revision: 0, resolution: 64 as const, dataId: "impact-relief" };
    const smallerMetadata = { ...metadata, dataId: "smaller-relief" };
    const makeBody = (id: string, massKg: number, radiusM: number, positionM: CelestialBody["positionM"]): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg, radiusM, positionM,
      velocityMs: id === "large" ? [0, 0, 0] : [-10, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
      ...(id === "large" ? { surface: metadata } : { surface: smallerMetadata }),
    });
    const initial = [makeBody("large", 2e15, 1e6, [0, 0, 0]), makeBody("small", 1e15, 5e5, [1.4e6, 0, 0])];
    const sidecar = { "impact-relief": [], "smaller-relief": [] };
    const noSurface = advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 1, 1);
    const withSurface = advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 1, 1, { surfaceData: sidecar });
    const withHeat = advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 1, 1,
      { surfaceHeatData: { "impact-relief": [], "smaller-relief": [] } });

    expect(withSurface.bodies[0]).toMatchObject({ id: "large", massKg: noSurface.bodies[0]!.massKg,
      radiusM: noSurface.bodies[0]!.radiusM, surfaceTemperatureK: noSurface.bodies[0]!.surfaceTemperatureK,
      surface: { ...metadata, revision: 1 } });
    expect(Object.keys(withSurface.surfaceData ?? {})).toEqual(["impact-relief"]);
    expect(withSurface.surfaceData?.["impact-relief"]?.length).toBeGreaterThan(0);
    expect(withHeat.surfaceHeatData?.["impact-relief"]?.length).toBeGreaterThan(0);
    expect((withHeat.surfaceHeatData?.["impact-relief"]?.reduce((sum, patch) => sum + patch.energyJ, 0) ?? 0)
      / (withHeat.events[0]!.energyJ * 0.01 * Math.exp(-Math.LN2 / 86_400))).toBeCloseTo(1, 10);
    expect(withHeat.bodies[0]!.surfaceTemperatureK).toBe(initial[0]!.surfaceTemperatureK);
    expect(withHeat.surfaceHeatData?.["smaller-relief"]).toBeUndefined();
    expect(withSurface.events[0]?.outcome).toMatchObject({ kind: "perfectly-inelastic-merge", survivorBodyId: "large" });
    expect(initial[0]!.surface).toEqual(metadata);
    expect(sidecar["impact-relief"]).toEqual([]);
  });

  it("accepts a valid merge when its added visual heat would exceed the sidecar cap", () => {
    const bodies: CelestialBody[] = Array.from({ length: 64 }, (_, index) => {
      const id = index === 0 ? "heat-survivor" : index === 1 ? "heat-impact" : `heat-body-${index}`;
      const surface = { modelId: "sparse-relief-v1" as const, seed: 1, revision: 0, resolution: 64 as const, dataId: `${id}-surface` };
      return { id, name: id, kind: "planet", massKg: index === 0 ? 2e15 : index === 1 ? 1e15 : 1e12,
        radiusM: index === 0 ? 1_000 : index === 1 ? 500 : 100, positionM: index === 0 ? [0, 0, 0] : index === 1 ? [1_400, 0, 0] : [index * 1e9, 0, 0],
        velocityMs: index === 1 ? [-10, 0, 0] : [0, 0, 0], surfaceTemperatureK: 200, waterFraction: 0, surface } as CelestialBody;
    });
    const dataIds = bodies.map(({ surface }) => surface!.dataId);
    const heatData = Object.fromEntries(dataIds.map((id) => [id, [] as { cellIndex: number; energyJ: number }[]]));
    const fullGrid = Array.from({ length: 64 * 32 }, (_, cellIndex) => ({ cellIndex, energyJ: 1e50 }));
    for (const id of dataIds.slice(0, 50).filter((id) => id !== dataIds[1])) heatData[id] = id === dataIds[0]
      ? fullGrid.map(({ cellIndex }) => ({ cellIndex, energyJ: 1 })) : fullGrid;
    const topUpIds = dataIds.slice(50);
    const setTopUpCount = (count: number) => topUpIds.forEach((id, index) => {
      heatData[id] = fullGrid.slice(0, Math.max(0, Math.min(64 * 32, count - index * 64 * 32)));
    });
    let minimum = 0, maximum = topUpIds.length * 64 * 32;
    while (minimum < maximum) {
      const candidateCount = Math.ceil((minimum + maximum) / 2);
      setTopUpCount(candidateCount);
      if (new TextEncoder().encode(JSON.stringify(heatData)).byteLength < MAX_SURFACE_HEAT_DATA_BYTES - 8) minimum = candidateCount;
      else maximum = candidateCount - 1;
    }
    setTopUpCount(minimum);
    const currentHeatBytes = new TextEncoder().encode(JSON.stringify(heatData)).byteLength;
    expect(currentHeatBytes).toBeLessThan(MAX_SURFACE_HEAT_DATA_BYTES);
    expect(currentHeatBytes).toBeGreaterThan(MAX_SURFACE_HEAT_DATA_BYTES - 100);

    const result = advanceSimulationInterval(bodies, { gravitationalConstant: 0 }, 1, 1, { surfaceHeatData: heatData });

    expect(result.events[0]?.outcome).toMatchObject({ kind: "perfectly-inelastic-merge", survivorBodyId: "heat-survivor" });
    expect(result.bodies).toHaveLength(63);
    expect(result.bodies.find(({ id }) => id === "heat-survivor")?.massKg).toBe(3e15);
    expect(result.surfaceHeatData?.[dataIds[0]!]).toEqual(heatData[dataIds[0]!]!.map(({ cellIndex, energyJ }) => ({
      cellIndex, energyJ: energyJ * Math.exp(-Math.LN2 / 86_400),
    })));
  });

  it("leaves sidecar unchanged for fragmentation, capture, or contact without a valid normal", () => {
    const metadata = { modelId: "sparse-relief-v1" as const, seed: 7, revision: 0, resolution: 64 as const, dataId: "impact-relief" };
    const sidecar = { "impact-relief": [] };
    const makeBody = (id: string, massKg: number, positionM: CelestialBody["positionM"], velocityMs: CelestialBody["velocityMs"]): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg, radiusM: 1_000, positionM, velocityMs,
      surfaceTemperatureK: 200, waterFraction: 0, ...(id === "a" ? { surface: metadata } : {}),
    });
    const pair = [makeBody("a", 1e15, [-10_000, 0, 0], [100, 0, 0]), makeBody("b", 1e15, [10_000, 0, 0], [-100, 0, 0])];
    const fragmented = advanceSimulationInterval(pair, { gravitationalConstant: 0 }, 90, 1, { collisionMode: "creative", surfaceData: sidecar });
    expect(fragmented.events[0]?.outcome?.kind).toBe("creative-fragmentation");
    expect(fragmented.bodies.every(({ surface }) => surface?.revision === undefined || surface.revision === 0)).toBe(true);
    expect(fragmented.surfaceData?.["impact-relief"] ?? []).toEqual([]);

    const blackHole = { id: "a", name: "BH", kind: "star" as const, bodyType: "black-hole" as const, massKg: 1e20,
      radiusM: 2 * 6.6743e-11 * 1e20 / 299_792_458 ** 2, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const,
      surfaceTemperatureK: 0, waterFraction: 0, surface: metadata };
    const capturedRock = { id: "b", name: "Rock", kind: "planet" as const, bodyType: "asteroid" as const, massKg: 1e10, radiusM: 1,
      positionM: [1_000, 0, 0] as const, velocityMs: [-9e6, 0, 0] as const, surfaceTemperatureK: 200, waterFraction: 0,
      surface: { ...metadata, dataId: "captured-relief" } };
    const captureRadius = Math.max(50 * blackHole.radiusM, Math.sqrt(6.6743e-11 * blackHole.massKg / 1e6));
    const captureSeconds = (1_000 - captureRadius) / 9e6;
    const captured = advanceSimulationInterval([blackHole, capturedRock], { gravitationalConstant: 6.6743e-11 }, captureSeconds, 100,
      { collisionMode: "creative", surfaceData: { "impact-relief": [], "captured-relief": [] } });
    expect(captured.events[0]?.outcome?.kind).toBe("creative-accretion");
    expect(captured.bodies[0]?.surface?.revision).toBe(0);
    expect(captured.surfaceData).toEqual({ "impact-relief": [] });

    const coincident = [makeBody("a", 1e15, [0, 0, 0], [0, 0, 0]), makeBody("b", 1e15, [0, 0, 0], [0, 0, 0])];
    const invalidContact = advanceSimulationInterval(coincident, { gravitationalConstant: 0 }, 1, 1, { surfaceData: sidecar });
    expect(invalidContact.events[0]?.contact?.normalM).toBeNull();
    expect(invalidContact.surfaceData).toEqual(sidecar);
    expect(sidecar["impact-relief"]).toEqual([]);
  });

  it("creates deterministic creative fragments with bounded energy, exact mass and momentum", () => {
    const makeBody = (id: string, x: number, velocity: number): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000,
      positionM: [x, 0, 0], velocityMs: [velocity, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
    });
    const start = [makeBody("impact-a", -10_000, 100), makeBody("impact-b", 10_000, -100)];
    const options = { collisionMode: "creative" as const };
    const result = advanceSimulationInterval(start, { gravitationalConstant: 0 }, 90, 1, options);
    const event = result.events[0]!;
    const fragments = result.bodies.filter(({ id }) => event.type === "collision" && event.outcome?.kind === "creative-fragmentation"
      && event.outcome.fragmentBodyIds.includes(id));
    const momentum = fragments.reduce((total, body) => total.map((value, axis) => value + body.massKg * body.velocityMs[axis]!), [0, 0, 0]);

    expect(fragments).toHaveLength(6);
    expect(fragments.reduce((sum, body) => sum + body.massKg, 0)).toBe(2e15);
    expect(momentum).toEqual([0, 0, 0]);
    expect(event).toMatchObject({ type: "collision", outcome: { kind: "creative-fragmentation", modelId: "creative-fragmentation-v1" } });
    if (event.type !== "collision" || event.outcome?.kind !== "creative-fragmentation") throw new Error("Expected creative fragmentation");
    const kinetic = fragments.reduce((total, body) => total + 0.5 * body.massKg
      * body.velocityMs.reduce((sum, value) => sum + value ** 2, 0), 0);
    expect(event.outcome.availableEnergyJ).toBe(event.energyJ);
    expect(event.outcome.fragmentKineticEnergyJ).toBe(kinetic);
    expect(event.outcome.fragmentKineticEnergyJ).toBeLessThanOrEqual(event.outcome.availableEnergyJ);
    expect(event.outcome.dissipatedEnergyJ).toBe(event.outcome.availableEnergyJ - event.outcome.fragmentKineticEnergyJ);
    expect(result.events[0]).toEqual(advanceSimulationInterval(start, { gravitationalConstant: 0 }, 90, 1, options).events[0]);
  });

  it("falls back to merge at the body cap", () => {
    const template = createSolarSystem()[3]!;
    const pair: CelestialBody[] = [
      { ...template, id: "a", bodyType: "asteroid", massKg: 1e15, radiusM: 1, positionM: [-1, 0, 0], velocityMs: [0, 0, 0] },
      { ...template, id: "b", bodyType: "asteroid", massKg: 1e15, radiusM: 1, positionM: [1, 0, 0], velocityMs: [0, 0, 0] },
    ];
    const capped = [...pair, ...Array.from({ length: 62 }, (_, index) => ({ ...pair[0]!, id: `other-${index}`, positionM: [10 + index * 3, 0, 0] as const }))];
    const result = advanceSimulationInterval(capped, { gravitationalConstant: 0 }, 1, 1, { collisionMode: "creative" });
    expect(result.bodies).toHaveLength(63);
    expect(result.events[0]).toMatchObject({ type: "collision", outcome: { kind: "perfectly-inelastic-merge", modelId: "perfectly-inelastic-merge-v1" } });
  });

  it("captures a black hole in creative mode before the Newtonian guard, but keeps scientific mode unchanged", () => {
    const blackHole: CelestialBody = { id: "bh", name: "BH", kind: "star", bodyType: "black-hole", massKg: 1e20,
      radiusM: 2 * 6.6743e-11 * 1e20 / 299_792_458 ** 2, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 };
    const asteroid: CelestialBody = { id: "rock", name: "Rock", kind: "planet", bodyType: "asteroid", massKg: 1e10, radiusM: 1,
      positionM: [1_000, 0, 0], velocityMs: [-9e6, 0, 0], surfaceTemperatureK: 200, waterFraction: 0 };
    const captureRadius = Math.max(50 * blackHole.radiusM, Math.sqrt(6.6743e-11 * blackHole.massKg / 1e6));
    const seconds = (1_000 - captureRadius) / 9e6;
    const gravity = 6.6743e-11;
    expect(findSweptBlackHoleCapture([blackHole, asteroid], [blackHole, { ...asteroid, positionM: [captureRadius - 1, 0, 0] }], gravity)).toMatchObject({ captor: 0, absorbed: 1 });
    const result = advanceSimulationInterval([blackHole, asteroid], { gravitationalConstant: gravity }, seconds, 100, { collisionMode: "creative" });
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]).toMatchObject({ id: "bh", bodyType: "black-hole", massKg: 1e20 + 1e10 });
    expect(result.bodies[0]?.radiusM).toBe(2 * 6.6743e-11 * (1e20 + 1e10) / 299_792_458 ** 2);
    expect(result.events[0]).toMatchObject({ type: "black-hole-capture", bodyIds: ["bh", "rock"], energyJ: 0,
      outcome: { kind: "creative-accretion", modelId: "creative-accretion-v1", captureRadiusM: captureRadius } });
    const crossesScientificGuardSeconds = (1_000 - 25 * blackHole.radiusM) / 9e6;
    expect(() => advanceSimulationInterval([blackHole, asteroid], { gravitationalConstant: gravity }, crossesScientificGuardSeconds, 100))
      .toThrow(/Encontro muito próximo|Acceleration exceeds/);
  });

  it("reports grazing contact angle and identical diagnostics when body order reverses", () => {
    const x = Math.sqrt(4 - 1.5 ** 2) / 2;
    const first: CelestialBody = { id: "a", name: "a", kind: "planet", massKg: 2, radiusM: 1,
      positionM: [-x, 0.75, 0], velocityMs: [1, 0, 0], surfaceTemperatureK: 200, waterFraction: 0 };
    const second: CelestialBody = { ...first, id: "b", name: "b", massKg: 6,
      positionM: [x, -0.75, 0], velocityMs: [-1, 0, 0] };
    const forward = advanceSimulationInterval([first, second], { gravitationalConstant: 0 }, 1, 1).events[0]!;
    const reverse = advanceSimulationInterval([second, first], { gravitationalConstant: 0 }, 1, 1).events[0]!;

    expect(forward.collisionDiagnostics?.impactAngleRad).toBeCloseTo(Math.atan2(3, 2 * Math.sqrt(1.75)), 12);
    expect(reverse.collisionDiagnostics).toEqual(forward.collisionDiagnostics);
    expect(forward.energyJ).toBe(3);
    expect(forward.collisionDiagnostics?.specificImpactEnergyJkg).toBe(3 / 8);
  });

  it.each([
    ["coincident", [0, 0, 0] as const, [1, 0, 0] as const, [-1, 0, 0] as const],
    ["zero relative speed", [1, 0, 0] as const, [0, 0, 0] as const, [0, 0, 0] as const],
    ["not approaching", [1, 0, 0] as const, [1, 0, 0] as const, [-1, 0, 0] as const],
  ])("marks impact angle null for %s contact", (_label, separation, velocityA, velocityB) => {
    const a: CelestialBody = { id: "a", name: "a", kind: "planet", massKg: 1, radiusM: 1,
      positionM: separation, velocityMs: velocityA, surfaceTemperatureK: 200, waterFraction: 0 };
    const b: CelestialBody = { ...a, id: "b", positionM: [0, 0, 0], velocityMs: velocityB };
    const event = advanceSimulationInterval([a, b], { gravitationalConstant: 0 }, 1, 1).events[0]!;
    expect(event.collisionDiagnostics?.impactAngleRad).toBeNull();
  });

  it("records swept contact with pre-merge positions and then accepted merged states", () => {
    const makeBody = (id: string, x: number, velocity: number): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000,
      positionM: [x, 0, 0], velocityMs: [velocity, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
    });
    const start = [makeBody("impact-a", -10_000, 100), makeBody("impact-b", 10_000, -100)];
    const result = advanceSimulationInterval(start, { gravitationalConstant: 0 }, 120, 120, { captureSamples: true });
    const contact = result.samples?.find(({ bodies }) => bodies.length === 2
      && Math.abs(bodies[0]!.positionM[0] - bodies[1]!.positionM[0]) <= 2_000);

    expect(contact?.offsetSeconds).toBeCloseTo(result.events[0]!.timeSeconds, 12);
    expect(contact?.offsetSeconds).toBeCloseTo(90, 8);
    expect(contact?.bodies.map(({ id }) => id)).toEqual(["impact-a", "impact-b"]);
    expect(contact?.bodies[0]?.positionM[0]).toBeCloseTo(-1_000, 10);
    expect(contact?.bodies[1]?.positionM[0]).toBeCloseTo(1_000, 10);
    expect(result.samples?.at(-1)?.bodies.map(({ id }) => id)).toEqual([result.bodies[0]?.id]);
  });

  it("ends a batch at the committed topology when contact lands on the interval endpoint", () => {
    const makeBody = (id: string, x: number, velocity: number): CelestialBody => ({
      id, name: id, kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1_000,
      positionM: [x, 0, 0], velocityMs: [velocity, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
    });
    const start = [makeBody("impact-a", -10_000, 100), makeBody("impact-b", 10_000, -100)];
    const full = advanceSimulationInterval(start, { gravitationalConstant: 0 }, 120, 120, { captureSamples: true });
    const contactTime = full.events[0]!.timeSeconds;
    const endingAtContact = advanceSimulationInterval(start, { gravitationalConstant: 0 }, contactTime, 120, { captureSamples: true });

    expect(endingAtContact.bodies).toHaveLength(1);
    expect(endingAtContact.samples?.at(-1)?.offsetSeconds).toBeCloseTo(contactTime, 12);
    expect(endingAtContact.samples?.at(-1)?.bodies).toEqual(endingAtContact.bodies.map(({ id, positionM }) => ({ id, positionM })));
  });

  it("does not expose partial samples when a later substep fails", () => {
    const initial = [{ ...createSolarSystem()[3]!, id: "probe", massKg: 1, radiusM: 1,
      positionM: [0, 0, 0] as const, velocityMs: [1, 0, 0] as const }];
    const advance = vi.spyOn(world, "advanceWorld").mockImplementationOnce(() => [{ ...initial[0]!, positionM: [1, 0, 0] }])
      .mockImplementationOnce(() => { throw new Error("second substep failed"); });
    try {
      expect(() => advanceSimulationInterval(initial, { gravitationalConstant: 0 }, 2, 1, { captureSamples: true }))
        .toThrow("second substep failed");
      expect(initial[0]?.positionM).toEqual([0, 0, 0]);
    } finally {
      advance.mockRestore();
    }
  });

  it.each([["star", "planet"], ["moon", "planet"]] as const)("keeps dominant %s identity when collision input order reverses", (smallKind, largeKind) => {
    const small: CelestialBody = {
      id: "small", name: "Small", kind: smallKind, bodyType: smallKind === "star" ? "star" : "moon",
      massKg: 1e15, radiusM: 1_000, positionM: [-1_000, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 200, waterFraction: 0,
    };
    const large: CelestialBody = {
      id: "large", name: "Large", kind: largeKind, bodyType: "rocky-planet",
      massKg: 2e15, radiusM: 1_000, positionM: [1_000, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 300, waterFraction: 0,
    };
    for (const ordered of [[small, large], [large, small]]) {
      const result = advanceSimulationInterval(ordered, { gravitationalConstant: 0 }, 1, 1);
      expect(result.bodies[0]).toMatchObject({ id: "large", kind: largeKind, bodyType: large.bodyType, massKg: 3e15 });
    }
  });
});
