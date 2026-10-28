import { describe, expect, it } from "vitest";
import { getOrbitalElements } from "./orbital-analysis";
import { NEWTONIAN_G } from "./physical-constants";
import { createSolarSystem } from "./solar-system";
import {
  advanceSolarEvolutionAge,
  checkSolarEvolutionEligibility,
  createSolarEvolutionCandidate,
  getSolarEvolutionProperties,
  getSolarTrackKnotsBetween,
  getSolarTrackAgeAtEep,
  stellarLuminosityW,
  stellarIrradianceWm2,
  SOLAR_EVOLUTION_MODEL,
  SOLAR_EVOLUTION_START_AGE_YEARS,
  SOLAR_EVOLUTION_END_AGE_YEARS,
} from "./stellar-evolution";

const settings = { gravitationalConstant: NEWTONIAN_G };

describe("solar evolutionary track", () => {
  it("anchors MIST mass, luminosity, and radius to the preset Sun at 4.58 Gyr", () => {
    const properties = getSolarEvolutionProperties(SOLAR_EVOLUTION_START_AGE_YEARS);

    expect(Math.abs(properties.massKg / 1.9884e30 - 1)).toBeLessThan(1e-14);
    expect(properties.radiusM).toBe(695700000);
    expect(properties.luminosityRatio).toBeCloseTo(1, 12);
    expect(properties.effectiveTemperatureK).toBe(5772);
    expect(properties.ageYears).toBe(4.58e9);
  });

  it("labels terminal EEP 1710 as white dwarf formation, without extended cooling", () => {
    const properties = getSolarEvolutionProperties(SOLAR_EVOLUTION_END_AGE_YEARS);

    expect(properties.primaryEep).toBe(1710);
    expect(properties.stage).toBe("white-dwarf-formation");
    expect(properties.coversExtendedWhiteDwarfCooling).toBe(false);
    const rawMassAtAnchorSolar = 0.99983891679904;
    const independentlyExpectedMassKg = 0.5398317588491387 / rawMassAtAnchorSolar * 1.9884e30;
    expect(Math.abs(properties.massKg / independentlyExpectedMassKg - 1)).toBeLessThan(1e-14);
  });

  it("keeps source knots in the requested interval and interpolates its endpoints", () => {
    const knots = getSolarTrackKnotsBetween(SOLAR_EVOLUTION_START_AGE_YEARS, SOLAR_EVOLUTION_END_AGE_YEARS);

    expect(knots.length).toBeGreaterThan(1000);
    expect(knots[0]?.ageYears).toBe(SOLAR_EVOLUTION_START_AGE_YEARS);
    expect(knots.every((knot) => knot.ageYears >= SOLAR_EVOLUTION_START_AGE_YEARS && knot.ageYears <= SOLAR_EVOLUTION_END_AGE_YEARS)).toBe(true);
    expect(knots.some((knot) => knot.primaryEep === 605)).toBe(true);
    expect(knots.some((knot) => knot.primaryEep === 808)).toBe(true);
    expect(knots.at(-1)?.primaryEep).toBe(1710);
  });


  it("bounds derived properties to the connected solar model age domain", () => {
    expect(() => getSolarEvolutionProperties(SOLAR_EVOLUTION_START_AGE_YEARS - 1)).toThrow();
    expect(() => getSolarEvolutionProperties(SOLAR_EVOLUTION_END_AGE_YEARS + 1)).toThrow();
    expect(getSolarEvolutionProperties(SOLAR_EVOLUTION_START_AGE_YEARS).ageYears).toBe(SOLAR_EVOLUTION_START_AGE_YEARS);
    expect(getSolarEvolutionProperties(SOLAR_EVOLUTION_END_AGE_YEARS).ageYears).toBe(SOLAR_EVOLUTION_END_AGE_YEARS);
  });

  it("maps EEP to real track age and derives SI luminosity and irradiance", () => {
    expect(getSolarTrackAgeAtEep(1)).toBeLessThan(SOLAR_EVOLUTION_START_AGE_YEARS);
    expect(getSolarTrackAgeAtEep(1710)).toBe(SOLAR_EVOLUTION_END_AGE_YEARS);
    const sun = createSolarEvolutionCandidate(createSolarSystem())[0]!;
    const target = { positionM: [sun.positionM[0] + 149_597_870_700, sun.positionM[1], sun.positionM[2]] as const };
    const properties = getSolarEvolutionProperties(SOLAR_EVOLUTION_START_AGE_YEARS);
    expect(Math.abs(stellarLuminosityW(sun) / properties.luminosityW - 1)).toBeLessThan(1e-12);
    expect(Math.abs(stellarIrradianceWm2(sun, target) / (properties.luminosityW / (4 * Math.PI * 149_597_870_700 ** 2)) - 1)).toBeLessThan(1e-12);
  });

  it("initializes only the exact Solar System preset and marks the Sun for secular evolution", () => {
    const initialized = createSolarEvolutionCandidate(createSolarSystem());
    const sun = initialized.find((body) => body.id === "sun")!;

    expect(sun.stellarEvolution).toEqual({
      modelId: SOLAR_EVOLUTION_MODEL.id,
      modelVersion: SOLAR_EVOLUTION_MODEL.version,
      ageYears: SOLAR_EVOLUTION_START_AGE_YEARS,
      accretedMassKg: 0,
      absorbedBodyIds: [],
      mode: "secular",
    });
    expect(sun.massKg).toBe(1.9884e30);
    expect(sun.radiusM).toBe(695700000);
    expect(sun.surfaceTemperatureK).toBe(5772);
    expect(sun.bodyType).toBe("star");
  });

  it("accepts the initialized preset and rejects a binary or edited manual world", () => {
    const world = createSolarEvolutionCandidate(createSolarSystem());

    expect(checkSolarEvolutionEligibility(world, settings, SOLAR_EVOLUTION_END_AGE_YEARS).eligible).toBe(true);
    expect(checkSolarEvolutionEligibility([...world, { ...world[0]!, id: "second-star", positionM: [1, 0, 0] }], settings, SOLAR_EVOLUTION_END_AGE_YEARS).eligible).toBe(false);
    const manual = world.map((body) => body.id === "sun"
      ? { ...body, stellarEvolution: { ...body.stellarEvolution!, mode: "manual" as const } }
      : body);
    expect(checkSolarEvolutionEligibility(manual, settings, SOLAR_EVOLUTION_END_AGE_YEARS).eligible).toBe(false);
  });

  it("advances bodies and preserves semimajor axis times total mass for the Earth-Moon group", () => {
    const world = createSolarEvolutionCandidate(createSolarSystem());
    const targetAge = 5e9;
    const result = advanceSolarEvolutionAge(world, targetAge, settings);
    const sun = result.bodies.find((body) => body.id === "sun")!;
    const initialGroup = combineEarthMoon(world);
    const finalGroup = combineEarthMoon(result.bodies);
    const initialElements = getOrbitalElements(initialGroup, world.find((body) => body.id === "sun")!, settings)!;
    const finalElements = getOrbitalElements(finalGroup, sun, settings)!;
    const after = getSolarEvolutionProperties(targetAge, sun.stellarEvolution?.accretedMassKg);
    const invariantRelativeError = Math.abs(
      finalElements.semiMajorAxisM * (sun.massKg + finalGroup.massKg)
      - initialElements.semiMajorAxisM * (world[0]!.massKg + initialGroup.massKg),
    ) / (initialElements.semiMajorAxisM * (world[0]!.massKg + initialGroup.massKg));

    expect(sun.stellarEvolution?.ageYears).toBe(targetAge);
    expect(invariantRelativeError).toBeLessThan(1e-10);
    expect(Math.abs(sun.massKg / after.massKg - 1)).toBeLessThan(1e-14);
    const wind = result.events.find((event) => event.type === "stellar-wind");
    expectMomentumClosure(world, result.bodies, wind?.type === "stellar-wind" ? wind.momentumKgMs : [0, 0, 0]);
  });

  it("walks every knot through WD formation and absorbs Earth with Moon as one group", () => {
    const world = createSolarEvolutionCandidate(createSolarSystem());
    const result = advanceSolarEvolutionAge(world, SOLAR_EVOLUTION_END_AGE_YEARS, settings);
    const sun = result.bodies.find((body) => body.id === "sun")!;
    const engulfment = result.events.find((event) => event.type === "engulfment" && event.bodyIds.includes("earth"));

    expect(sun.stellarEvolution?.ageYears).toBe(SOLAR_EVOLUTION_END_AGE_YEARS);
    expect(getSolarEvolutionProperties(sun.stellarEvolution!.ageYears).stage).toBe("white-dwarf-formation");
    expect(sun.bodyType).toBe("white-dwarf");
    if (engulfment?.type === "engulfment") {
      expect(engulfment.bodyIds).toEqual(expect.arrayContaining(["earth", "moon"]));
      expect(result.bodies.some((body) => body.id === "earth" || body.id === "moon")).toBe(false);
    } else {
      expect(result.bodies.some((body) => body.id === "earth")).toBe(true);
      expect(result.bodies.some((body) => body.id === "moon")).toBe(true);
    }
    const wind = result.events.find((event) => event.type === "stellar-wind");
    expect(wind?.type).toBe("stellar-wind");
    expect(Math.abs(wind!.massLostKg - result.stellarWindMassLostKg) / wind!.massLostKg).toBeLessThan(1e-14);
    expectMomentumClosure(world, result.bodies, wind?.type === "stellar-wind" ? wind.momentumKgMs : [0, 0, 0]);
  });


  it("keeps cumulative wind mass correct across many age advances with Earth-Moon engulfment", () => {
    const world = createSolarEvolutionCandidate(createSolarSystem());
    const oneShot = advanceSolarEvolutionAge(world, SOLAR_EVOLUTION_END_AGE_YEARS, settings);
    let stepped = world;
    let intervalWindMassKg = 0;
    const stepCount = 32;
    for (let index = 1; index <= stepCount; index += 1) {
      const ageYears = SOLAR_EVOLUTION_START_AGE_YEARS
        + (SOLAR_EVOLUTION_END_AGE_YEARS - SOLAR_EVOLUTION_START_AGE_YEARS) * index / stepCount;
      const result = advanceSolarEvolutionAge(stepped, ageYears, settings);
      intervalWindMassKg += result.stellarWindMassLostKg;
      stepped = result.bodies;
    }
    const steppedSun = stepped.find((body) => body.id === "sun")!;
    const oneShotSun = oneShot.bodies.find((body) => body.id === "sun")!;
    const relativeMassError = Math.abs(steppedSun.massKg / oneShotSun.massKg - 1);
    const relativeWindError = Math.abs(intervalWindMassKg / oneShot.stellarWindMassLostKg - 1);
    const sawEarthMoonEngulfment = oneShot.events.some((event) => event.type === "engulfment" && event.bodyIds.includes("earth") && event.bodyIds.includes("moon"));

    expect(relativeMassError).toBeLessThan(1e-12);
    expect(relativeWindError).toBeLessThan(1e-12);
    expect(sawEarthMoonEngulfment).toBe(true);
    expect(steppedSun.stellarEvolution?.ageYears).toBe(SOLAR_EVOLUTION_END_AGE_YEARS);
  });

  it("engulfs the Earth-Moon COM as one group on a close eligible orbit", () => {
    const world = makeCloseEarthMoonWorld(createSolarEvolutionCandidate(createSolarSystem()));
    const result = advanceSolarEvolutionAge(world, SOLAR_EVOLUTION_START_AGE_YEARS + 1e6, settings);
    const sun = result.bodies.find((body) => body.id === "sun")!;
    const engulfment = result.events.find((event) => event.type === "engulfment");

    expect(engulfment?.type).toBe("engulfment");
    expect(engulfment?.bodyIds).toEqual(expect.arrayContaining(["earth", "moon"]));
    expect(result.bodies.some((body) => body.id === "earth" || body.id === "moon")).toBe(false);
    expect(sun.stellarEvolution?.absorbedBodyIds).toEqual(expect.arrayContaining(["earth", "moon"]));
    const wind = result.events.find((event) => event.type === "stellar-wind");
    expectMomentumClosure(world, result.bodies, wind?.type === "stellar-wind" ? wind.momentumKgMs : [0, 0, 0]);
  });
});

function combineEarthMoon(bodies: ReturnType<typeof createSolarSystem>) {
  const earth = bodies.find((body) => body.id === "earth")!;
  const moon = bodies.find((body) => body.id === "moon")!;
  const massKg = earth.massKg + moon.massKg;
  return {
    ...earth,
    massKg,
    positionM: earth.positionM.map((value, axis) => (value * earth.massKg + moon.positionM[axis]! * moon.massKg) / massKg) as [number, number, number],
    velocityMs: earth.velocityMs.map((value, axis) => (value * earth.massKg + moon.velocityMs[axis]! * moon.massKg) / massKg) as [number, number, number],
  };
}


function expectMomentumClosure(
  before: ReturnType<typeof createSolarSystem>,
  after: ReturnType<typeof createSolarSystem>,
  windMomentum: readonly [number, number, number],
) {
  const beforeP = totalMomentum(before);
  const afterP = totalMomentum(after);
  const expected = beforeP.map((value, axis) => value - windMomentum[axis]!) as [number, number, number];
  const scale = Math.max(...expected.map(Math.abs), 1);
  expect(Math.max(...afterP.map((value, axis) => Math.abs(value - expected[axis]!))) / scale).toBeLessThan(1e-12);
}

function totalMomentum(bodies: ReturnType<typeof createSolarSystem>) {
  return bodies.reduce((sum, body) => sum.map((value, axis) => value + body.massKg * body.velocityMs[axis]!) as [number, number, number], [0, 0, 0] as [number, number, number]);
}

function makeCloseEarthMoonWorld(bodies: ReturnType<typeof createSolarSystem>) {
  const sun = bodies.find((body) => body.id === "sun")!;
  const earthMoon = combineEarthMoon(bodies);
  let outerIndex = 0;
  return bodies.map((body) => {
    if (body.id === "sun") return body;
    if (body.id === "earth" || body.id === "moon") {
      const movedCenter = [5e8, 0, 0] as const;
      const circularSpeed = Math.sqrt(NEWTONIAN_G * sun.massKg / 5e8);
      const positionOffset = body.positionM.map((value, axis) => value - earthMoon.positionM[axis]!) as [number, number, number];
      const velocityOffset = body.velocityMs.map((value, axis) => value - earthMoon.velocityMs[axis]!) as [number, number, number];
      return {
        ...body,
        positionM: body.id === "earth"
          ? sun.positionM.map((value, axis) => value + movedCenter[axis]! + positionOffset[axis]!) as [number, number, number]
          : sun.positionM.map((value, axis) => value + movedCenter[axis]! + positionOffset[axis]!) as [number, number, number],
        velocityMs: sun.velocityMs.map((value, axis) => value + (axis === 1 ? circularSpeed : 0) + velocityOffset[axis]!) as [number, number, number],
      };
    }
    const angle = 2 * Math.PI * outerIndex / 8;
    outerIndex += 1;
    const radius = 4e12;
    const speed = Math.sqrt(NEWTONIAN_G * sun.massKg / radius);
    return {
      ...body,
      positionM: [sun.positionM[0] + radius * Math.cos(angle), sun.positionM[1] + radius * Math.sin(angle), sun.positionM[2]] as [number, number, number],
      velocityMs: [sun.velocityMs[0] - speed * Math.sin(angle), sun.velocityMs[1] + speed * Math.cos(angle), sun.velocityMs[2]] as [number, number, number],
    };
  });
}
