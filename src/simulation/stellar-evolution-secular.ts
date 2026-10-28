import { getOrbitalElements } from "./orbital-analysis";
import { NEWTONIAN_G } from "./physical-constants";
import { hasSolarEvolutionProfile } from "./stellar-evolution-limits";
import { getSolarEvolutionProperties, getSolarTrackKnotsBetween, getSolarWindMassLostKg, MAX_ADIABATIC_RATIO, MAX_ACCRETED_MASS_KG, MAX_PERTURBATION_RATIO, MIN_ECCENTRICITY_FOR_PERIAPSIS_AXIS, MODEL_VERSION, PRESET_BY_ID, SECONDS_PER_YEAR, SOLAR_EVOLUTION_END_AGE_YEARS, SolarEvolutionError, INITIAL_SYSTEM_MASS_KG } from "./stellar-evolution-model";
import type { SolarEvolutionAgeResult, SolarEvolutionEligibility, SolarEvolutionEvent } from "./stellar-evolution-model";
import { add, cross, distance, dot, magnitude, orbitalGroups, scaleVector, subtract, type OrbitalGroup } from "./stellar-evolution-orbits";
import type { CelestialBody, PhysicsSettings, Vector3 } from "./types";

function validateEvolutionState(bodies: readonly CelestialBody[], settings: PhysicsSettings, targetAgeYears: number): { sun: CelestialBody; groups: OrbitalGroup[] } {
  const sun = bodies.find((body) => body.id === "sun");
  if (!sun || !hasSolarEvolutionProfile(sun) || sun.stellarEvolution?.modelVersion !== MODEL_VERSION) {
    throw new SolarEvolutionError("Este mundo não possui o perfil MIST solar reconhecido.");
  }
  if (sun.stellarEvolution.mode !== "secular") throw new SolarEvolutionError("O Sol está em modo manual; retorne ao modo secular explicitamente.");
  if (settings.gravitationalConstant !== NEWTONIAN_G) throw new SolarEvolutionError("A evolução solar exige o valor newtoniano padrão de G.");
  if (targetAgeYears < sun.stellarEvolution.ageYears || targetAgeYears > SOLAR_EVOLUTION_END_AGE_YEARS) {
    throw new SolarEvolutionError(`Idade alvo fora do domínio ${sun.stellarEvolution.ageYears}–${SOLAR_EVOLUTION_END_AGE_YEARS} anos.`);
  }
  const allowedIds = new Set(PRESET_BY_ID.keys());
  const absorbed = sun.stellarEvolution.absorbedBodyIds;
  if (new Set(absorbed).size !== absorbed.length || absorbed.some((id) => !allowedIds.has(id) || id === "sun")) {
    throw new SolarEvolutionError("O ledger de corpos absorvidos é inválido.");
  }
  const ids = new Set(bodies.map((body) => body.id));
  if (bodies.some((body) => !allowedIds.has(body.id)) || [...allowedIds].some((id) => id !== "sun" && ids.has(id) === absorbed.includes(id))) {
    throw new SolarEvolutionError("A evolução secular aceita somente o preset Solar e corpos removidos pelo ledger de engolfamento.");
  }
  if (ids.has("earth") !== ids.has("moon") || absorbed.includes("earth") !== absorbed.includes("moon")) {
    throw new SolarEvolutionError("Terra e Lua devem permanecer juntas ou ser absorvidas como um único grupo.");
  }
  for (const body of bodies) {
    if (body.id === "sun") continue;
    const preset = PRESET_BY_ID.get(body.id)!;
    if (body.kind !== preset.kind || body.massKg !== preset.massKg || body.radiusM !== preset.radiusM || body.parentId !== preset.parentId) {
      throw new SolarEvolutionError(`O corpo ${body.id} foi editado fora do preset solar suportado.`);
    }
  }
  const expectedAccretedMass = absorbed.reduce((sum, id) => sum + PRESET_BY_ID.get(id)!.massKg, 0);
  if (Math.abs(sun.stellarEvolution.accretedMassKg - expectedAccretedMass) > Math.max(1, expectedAccretedMass) * 1e-12) {
    throw new SolarEvolutionError("A massa acretada não corresponde ao ledger de corpos absorvidos.");
  }
  const expectedProperties = getSolarEvolutionProperties(sun.stellarEvolution.ageYears, expectedAccretedMass);
  const expectedBodyType = expectedProperties.primaryEep === 1710 ? "white-dwarf" : "star";
  if (sun.bodyType !== expectedBodyType) throw new SolarEvolutionError("O tipo do Sol diverge da fase MIST atual.");
  if (!relativeEqual(sun.massKg, expectedProperties.massKg) || !relativeEqual(sun.radiusM, expectedProperties.radiusM)
    || !relativeEqual(sun.surfaceTemperatureK, expectedProperties.effectiveTemperatureK)) {
    throw new SolarEvolutionError("Estado físico do Sol diverge da idade MIST e do ledger de acreção.");
  }
  const groups = orbitalGroups(bodies);
  if (!groups.length) throw new SolarEvolutionError("Nenhum grupo planetário permanece no sistema.");
  return { sun, groups };
}

export function checkSolarEvolutionEligibility(
  bodies: readonly CelestialBody[], settings: PhysicsSettings, targetAgeYears: number,
): SolarEvolutionEligibility {
  try {
    const { sun, groups } = validateEvolutionState(bodies, settings, targetAgeYears);
    const startAge = sun.stellarEvolution!.ageYears;
    const knots = getSolarTrackKnotsBetween(startAge, targetAgeYears);
    let maxPerturbationRatio = 0;
    let maxAdiabaticRatio = 0;
    for (const group of groups) {
      let orbit = getOrbitalElements(groupBody(group), sun, settings);
      if (!orbit?.bound || !Number.isFinite(orbit.semiMajorAxisM) || orbit.eccentricity >= 1) {
        return { eligible: false, reason: `Grupo ${group.bodyIds.join("+")} não tem órbita heliocêntrica ligada.` };
      }
      for (let index = 1; index < knots.length; index += 1) {
        const previous = knots[index - 1]!;
        const next = knots[index]!;
        const durationYears = next.ageYears - previous.ageYears;
        if (durationYears <= 0) continue;
        const starMassStart = getSolarEvolutionProperties(previous.ageYears, sun.stellarEvolution!.accretedMassKg).massKg;
        const starMassEnd = getSolarEvolutionProperties(next.ageYears, sun.stellarEvolution!.accretedMassKg).massKg;
        const totalMassStart = starMassStart + group.massKg;
        const totalMassEnd = starMassEnd + group.massKg;
        const scaledA: number = orbit.semiMajorAxisM * totalMassStart / totalMassEnd;
        const periodYears = 2 * Math.PI * Math.sqrt(scaledA ** 3 / (NEWTONIAN_G * totalMassEnd)) / SECONDS_PER_YEAR;
        const ratio = periodYears * Math.abs(starMassEnd - starMassStart) / durationYears / starMassEnd;
        maxAdiabaticRatio = Math.max(maxAdiabaticRatio, ratio);
        if (ratio > MAX_ADIABATIC_RATIO) {
          return { eligible: false, reason: `Perda de massa não adiabática no trecho ${previous.ageYears}–${next.ageYears} anos para ${group.bodyIds.join("+")}.`, maxAdiabaticRatio };
        }
        orbit = { ...orbit, semiMajorAxisM: scaledA };
      }
      const perturbationRatio = getPerturbationRatio(group, groups, sun);
      maxPerturbationRatio = Math.max(maxPerturbationRatio, perturbationRatio);
      if (perturbationRatio > MAX_PERTURBATION_RATIO) {
        return { eligible: false, reason: `Perturbação sobre ${group.bodyIds.join("+")} excede 1% da atração solar.`, maxPerturbationRatio, maxAdiabaticRatio };
      }
    }
    return { eligible: true, maxPerturbationRatio, maxAdiabaticRatio };
  } catch (error) {
    return { eligible: false, reason: error instanceof Error ? error.message : "Estado solar inelegível." };
  }
}

export function advanceSolarEvolutionAge(
  bodies: readonly CelestialBody[], targetAgeYears: number, settings: PhysicsSettings,
): SolarEvolutionAgeResult {
  const eligibility = checkSolarEvolutionEligibility(bodies, settings, targetAgeYears);
  if (!eligibility.eligible) throw new SolarEvolutionError(eligibility.reason ?? "Estado solar inelegível.");
  const candidate: CelestialBody[] = bodies.map((body) => ({
    ...body,
    positionM: [...body.positionM] as Vector3,
    velocityMs: [...body.velocityMs] as Vector3,
    ...(body.stellarEvolution ? { stellarEvolution: { ...body.stellarEvolution, absorbedBodyIds: [...body.stellarEvolution.absorbedBodyIds] } } : {}),
  }));
  const events: SolarEvolutionEvent[] = [];
  let stellarWindMassLostKg = 0;
  let stellarWindMomentumKgMs: Vector3 = [0, 0, 0];
  const initialStar = candidate.find((body) => body.id === "sun")!;
  const initialAge = initialStar.stellarEvolution!.ageYears;
  const samples = getSolarTrackKnotsBetween(initialAge, targetAgeYears);
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const next = samples[index]!;
    const star = candidate.find((body) => body.id === "sun")!;
    const metadata = star.stellarEvolution!;
    const momentumBefore = systemMomentum(candidate);
    const starVelocityBefore = star.velocityMs;
    const starBefore = { ...star, positionM: [...star.positionM] as Vector3, velocityMs: [...star.velocityMs] as Vector3 };
    const beforeProperties = getSolarEvolutionProperties(previous.ageYears, metadata.accretedMassKg);
    const afterProperties = getSolarEvolutionProperties(next.ageYears, metadata.accretedMassKg);
    const windMassThisKnotKg = beforeProperties.massKg - afterProperties.massKg;
    const windMomentumThisKnotKgMs = scaleVector(starVelocityBefore, windMassThisKnotKg);
    const groups = orbitalGroups(candidate);
    const transformed = new Map<string, { positionM: Vector3; velocityMs: Vector3; crossing?: { ageYears: number; periapsisPositionM: Vector3; periapsisVelocityMs: Vector3 } }>();
    for (const group of groups) {
      const elements = getOrbitalElements(groupBody(group), starBefore, settings);
      if (!elements?.bound || !Number.isFinite(elements.semiMajorAxisM)) throw new SolarEvolutionError(`Órbita de ${group.bodyIds.join("+")} deixou de ser elíptica.`);
      const muBefore = NEWTONIAN_G * (beforeProperties.massKg + group.massKg);
      const muAfter = NEWTONIAN_G * (afterProperties.massKg + group.massKg);
      const scale = muBefore / muAfter;
      const relativePosition = subtract(group.positionM, starBefore.positionM);
      const relativeVelocity = subtract(group.velocityMs, starBefore.velocityMs);
      const radius = magnitude(relativePosition);
      const radial = scaleVector(relativePosition, 1 / radius);
      const angularMomentum = cross(relativePosition, relativeVelocity);
      const h = magnitude(angularMomentum);
      const normal = scaleVector(angularMomentum, 1 / h);
      const tangent = cross(normal, radial);
      const radialSpeed = dot(relativeVelocity, radial) * muAfter / muBefore;
      const transverseSpeed = h / (radius * scale);
      const nextPosition = add(starBefore.positionM, scaleVector(relativePosition, scale));
      const nextVelocity = add(starBefore.velocityMs, add(scaleVector(radial, radialSpeed), scaleVector(tangent, transverseSpeed)));
      const crossingAge = findEngulfmentCrossingAge(elements.periapsisM, muBefore, group, previous.ageYears, next.ageYears, metadata.accretedMassKg);
      const crossing = crossingAge === undefined ? undefined : getPeriapsisState(group, starBefore, muBefore, crossingAge, metadata.accretedMassKg);
      transformed.set(group.bodyIds[0]!, { positionM: nextPosition, velocityMs: nextVelocity, ...(crossing ? { crossing: { ageYears: crossingAge!, ...crossing } } : {}) });
    }

    const absorbedGroups = groups.filter((group) => transformed.get(group.bodyIds[0]!)?.crossing)
      .sort((a, b) => transformed.get(a.bodyIds[0]!)!.crossing!.ageYears - transformed.get(b.bodyIds[0]!)!.crossing!.ageYears);
    for (const group of groups) {
      if (absorbedGroups.some((absorbed) => absorbed.bodyIds[0] === group.bodyIds[0])) continue;
      const state = transformed.get(group.bodyIds[0])!;
      for (const id of group.bodyIds) {
        const body = candidate.find((entry) => entry.id === id)!;
        const oldGroup = group;
        const offsetPosition = subtract(body.positionM, oldGroup.positionM);
        const offsetVelocity = subtract(body.velocityMs, oldGroup.velocityMs);
        body.positionM = add(state.positionM, offsetPosition);
        body.velocityMs = add(state.velocityMs, offsetVelocity);
      }
    }

    for (const group of absorbedGroups) {
      const crossing = transformed.get(group.bodyIds[0]!)!.crossing!;
      const currentMetadata = star.stellarEvolution!;
      const atCrossing = getSolarEvolutionProperties(crossing.ageYears, currentMetadata.accretedMassKg);
      const crossingSunMass = atCrossing.massKg;
      let absorbedMass = 0;
      let addedPositionMoment: Vector3 = [0, 0, 0];
      let addedMomentum: Vector3 = [0, 0, 0];
      for (const id of group.bodyIds) {
        const body = candidate.find((entry) => entry.id === id)!;
        const position = add(star.positionM, add(crossing.periapsisPositionM, subtract(body.positionM, group.positionM)));
        const velocity = add(star.velocityMs, add(crossing.periapsisVelocityMs, subtract(body.velocityMs, group.velocityMs)));
        absorbedMass += body.massKg;
        addedPositionMoment = add(addedPositionMoment, scaleVector(position, body.massKg));
        addedMomentum = add(addedMomentum, scaleVector(velocity, body.massKg));
      }
      if (currentMetadata.accretedMassKg + absorbedMass > MAX_ACCRETED_MASS_KG) {
        throw new SolarEvolutionError("A acreção excederia 1e-4 da massa solar inicial; avanço rejeitado atomicamente.");
      }
      const previousSunPosition = star.positionM;
      const previousSunVelocity = star.velocityMs;
      const totalMass = crossingSunMass + absorbedMass;
      const totalPositionMoment = add(scaleVector(previousSunPosition, crossingSunMass), addedPositionMoment);
      const totalMomentum = add(scaleVector(previousSunVelocity, crossingSunMass), addedMomentum);
      star.massKg = totalMass;
      star.positionM = scaleVector(totalPositionMoment, 1 / totalMass);
      star.velocityMs = scaleVector(totalMomentum, 1 / totalMass);
      star.radiusM = atCrossing.radiusM;
      star.surfaceTemperatureK = atCrossing.effectiveTemperatureK;
      star.stellarEvolution = {
        ...currentMetadata,
        ageYears: crossing.ageYears,
        accretedMassKg: currentMetadata.accretedMassKg + absorbedMass,
        absorbedBodyIds: [...currentMetadata.absorbedBodyIds, ...group.bodyIds].sort(),
      };
      for (let bodyIndex = candidate.length - 1; bodyIndex >= 0; bodyIndex -= 1) {
        if (group.bodyIds.includes(candidate[bodyIndex]!.id)) candidate.splice(bodyIndex, 1);
      }
      const recoilPosition = subtract(star.positionM, previousSunPosition);
      const recoilVelocity = subtract(star.velocityMs, previousSunVelocity);
      for (const body of candidate) {
        if (body.id === "sun") continue;
        body.positionM = add(body.positionM, recoilPosition);
        body.velocityMs = add(body.velocityMs, recoilVelocity);
      }
      events.push({ type: "engulfment", ageYears: crossing.ageYears, bodyIds: [...group.bodyIds], massAccretedKg: absorbedMass, momentumKgMs: addedMomentum });
    }

    const updatedStar = candidate.find((body) => body.id === "sun")!;
    const updatedMetadata = updatedStar.stellarEvolution!;
    const endpointProperties = getSolarEvolutionProperties(next.ageYears, updatedMetadata.accretedMassKg);
    updatedStar.massKg = endpointProperties.massKg;
    updatedStar.radiusM = endpointProperties.radiusM;
    updatedStar.surfaceTemperatureK = endpointProperties.effectiveTemperatureK;
    updatedMetadata.ageYears = next.ageYears;
    updatedStar.bodyType = endpointProperties.primaryEep === 1710 ? "white-dwarf" : "star";
    const momentumAfter = systemMomentum(candidate);
    const targetMomentum = subtract(momentumBefore, windMomentumThisKnotKgMs);
    const activeMassForBoost = candidate.reduce((sum, body) => sum + body.massKg, 0);
    const velocityBoost = scaleVector(subtract(targetMomentum, momentumAfter), 1 / activeMassForBoost);
    for (const body of candidate) body.velocityMs = add(body.velocityMs, velocityBoost);
    stellarWindMassLostKg += windMassThisKnotKg;
    stellarWindMomentumKgMs = add(stellarWindMomentumKgMs, windMomentumThisKnotKgMs);
    const perturbation = maxWorldPerturbation(candidate);
    if (perturbation > MAX_PERTURBATION_RATIO) {
      throw new SolarEvolutionError(`Perturbação excedeu 1% no EEP ${next.trackEep}; avanço rejeitado atomicamente.`);
    }
  }

  const finalStar = candidate.find((body) => body.id === "sun")!;
  finalStar.stellarEvolution!.ageYears = targetAgeYears;
  const finalProperties = getSolarEvolutionProperties(targetAgeYears, finalStar.stellarEvolution!.accretedMassKg);
  finalStar.massKg = finalProperties.massKg;
  finalStar.radiusM = finalProperties.radiusM;
  finalStar.surfaceTemperatureK = finalProperties.effectiveTemperatureK;
  finalStar.bodyType = finalProperties.primaryEep === 1710 ? "white-dwarf" : "star";
  events.push({ type: "stellar-wind", ageFromYears: initialAge, ageToYears: targetAgeYears, massLostKg: getSolarWindMassLostKg(targetAgeYears) - getSolarWindMassLostKg(initialAge), momentumKgMs: stellarWindMomentumKgMs });
  const activeMassKg = candidate.reduce((sum, body) => sum + body.massKg, 0);
  const cumulativeWindMassLostKg = getSolarWindMassLostKg(targetAgeYears);
  if (Math.abs(activeMassKg + cumulativeWindMassLostKg - INITIAL_SYSTEM_MASS_KG) > INITIAL_SYSTEM_MASS_KG * 1e-10) {
    throw new SolarEvolutionError("Ledger de massa ativo + vento não fecha; avanço rejeitado atomicamente.");
  }
  return { bodies: candidate, events, stellarWindMassLostKg };
}


function findEngulfmentCrossingAge(periapsisAtStartM: number, muAtStart: number, group: OrbitalGroup, startAge: number, endAge: number, accretedMassKg: number): number | undefined {
  const clearance = (ageYears: number) => {
    const mass = getSolarEvolutionProperties(ageYears, accretedMassKg).massKg;
    const mu = NEWTONIAN_G * (mass + group.massKg);
    return periapsisAtStartM * muAtStart / mu - getSolarEvolutionProperties(ageYears, accretedMassKg).radiusM - group.radiusExtentM;
  };
  const leftClearance = clearance(startAge);
  const rightClearance = clearance(endAge);
  if (leftClearance <= 0) return startAge;
  if (rightClearance > 0) return undefined;
  let low = startAge;
  let high = endAge;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = (low + high) / 2;
    if (clearance(middle) > 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function getPeriapsisState(group: OrbitalGroup, sun: CelestialBody, muAtStart: number, ageYears: number, accretedMassKg: number): { periapsisPositionM: Vector3; periapsisVelocityMs: Vector3 } {
  const r = subtract(group.positionM, sun.positionM);
  const v = subtract(group.velocityMs, sun.velocityMs);
  const hVector = cross(r, v);
  const h = magnitude(hVector);
  const normal = scaleVector(hVector, 1 / h);
  const mu = NEWTONIAN_G * (getSolarEvolutionProperties(ageYears, accretedMassKg).massKg + group.massKg);
  const eccentricityVector = subtract(scaleVector(cross(v, hVector), 1 / muAtStart), scaleVector(r, 1 / magnitude(r)));
  const eccentricity = magnitude(eccentricityVector);
  const periapsisDirection = eccentricity > MIN_ECCENTRICITY_FOR_PERIAPSIS_AXIS
    ? scaleVector(eccentricityVector, 1 / eccentricity)
    : scaleVector(r, 1 / magnitude(r));
  const periapsis = h ** 2 / (mu * (1 + eccentricity));
  const tangent = cross(normal, periapsisDirection);
  return {
    periapsisPositionM: scaleVector(periapsisDirection, periapsis),
    periapsisVelocityMs: scaleVector(tangent, h / periapsis),
  };
}

function systemMomentum(bodies: readonly CelestialBody[]): Vector3 {
  return bodies.reduce((sum, body) => add(sum, scaleVector(body.velocityMs, body.massKg)), [0, 0, 0] as Vector3);
}

function maxWorldPerturbation(bodies: readonly CelestialBody[]): number {
  const sun = bodies.find((body) => body.id === "sun");
  if (!sun) return Infinity;
  const groups = orbitalGroups(bodies);
  return Math.max(0, ...groups.map((group) => getPerturbationRatio(group, groups, sun)));
}

function getPerturbationRatio(group: OrbitalGroup, groups: readonly OrbitalGroup[], sun: CelestialBody): number {
  const r = distance(group.positionM, sun.positionM);
  if (r === 0) return Infinity;
  const solarAcceleration = NEWTONIAN_G * sun.massKg / r ** 2;
  const perturbingAcceleration = groups.filter((other) => other !== group).reduce((sum, other) => {
    const separation = distance(group.positionM, other.positionM);
    return sum + NEWTONIAN_G * other.massKg / separation ** 2;
  }, 0);
  return perturbingAcceleration / solarAcceleration;
}

function groupBody(group: OrbitalGroup): CelestialBody {
  return { id: group.bodyIds[0]!, name: group.bodyIds.join("+"), kind: "planet", massKg: group.massKg, radiusM: group.radiusExtentM, positionM: group.positionM, velocityMs: group.velocityMs, surfaceTemperatureK: 0, waterFraction: 0 };
}

function relativeEqual(a: number, b: number): boolean { return Math.abs(a / b - 1) <= 1e-10; }
