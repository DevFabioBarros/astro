import { MATERIAL_PROFILES } from "./material-profiles";
import { createCatalogBody } from "./body-catalog";
import { MAX_MASS_KG, MAX_SIMULATION_BODIES, validateSimulationState } from "./physics";
import { SimulationError } from "./types";
import type { BodyType, CelestialBody, MaterialProfileId, PhysicsSettings, Vector3 } from "./types";

export const ORBIT_INITIALIZATION_MODEL_ID = "kepler-circular-initialization-v1" as const;
export const MAX_ORBITAL_RING_PARTICLES = 32;
export const MIN_ORBITAL_RING_PARTICLES = 4;

export function createOrbitalBody(
  bodies: readonly CelestialBody[], bodyType: BodyType, primaryId: string, semiMajorAxisM: number,
  planeNormal: Vector3, radialDirection: Vector3, settings: PhysicsSettings,
): CelestialBody[] {
  const candidate = createCatalogBody(bodyType, bodies, primaryId, settings);
  return placeBodyInCircularOrbit([...bodies, candidate], candidate.id, primaryId, semiMajorAxisM, planeNormal, radialDirection, settings);
}

export function placeBodyInCircularOrbit(
  bodies: readonly CelestialBody[], bodyId: string, primaryId: string, separationM: number,
  planeNormal: Vector3, radialDirection: Vector3, settings: PhysicsSettings,
): CelestialBody[] {
  const satelliteIndex = bodies.findIndex(({ id }) => id === bodyId);
  const primaryIndex = bodies.findIndex(({ id }) => id === primaryId);
  if (satelliteIndex < 0 || primaryIndex < 0 || satelliteIndex === primaryIndex) throw new SimulationError("INVALID_BODY", "Selecione dois astros diferentes para criar a órbita.");
  const primary = bodies[primaryIndex]!;
  const satellite = bodies[satelliteIndex]!;
  const { radial, tangent } = orbitAxes(planeNormal, radialDirection);
  validateOrbitInputs(primary, satellite, separationM, settings);
  const totalMassKg = primary.massKg + satellite.massKg;
  const relativePosition = scale(radial, separationM);
  const relativeSpeed = Math.sqrt(settings.gravitationalConstant * totalMassKg / separationM);
  const relativeVelocity = scale(tangent, relativeSpeed);
  const centerPosition = weightedVector(primary.positionM, primary.massKg, satellite.positionM, satellite.massKg, totalMassKg);
  const centerVelocity = weightedVector(primary.velocityMs, primary.massKg, satellite.velocityMs, satellite.massKg, totalMassKg);
  const updated = bodies.map((body, index) => {
    if (index === primaryIndex) return { ...body, positionM: subtract(centerPosition, scale(relativePosition, satellite.massKg / totalMassKg)) as Vector3 };
    if (index === satelliteIndex) return { ...body, parentId: primary.id,
      positionM: add(centerPosition, scale(relativePosition, primary.massKg / totalMassKg)) as Vector3 };
    return body;
  });
  const next = updated.map((body, index) => {
    if (index === primaryIndex) return { ...body, velocityMs: subtract(centerVelocity, scale(relativeVelocity, satellite.massKg / totalMassKg)) as Vector3 };
    if (index === satelliteIndex) return { ...body, velocityMs: add(centerVelocity, scale(relativeVelocity, primary.massKg / totalMassKg)) as Vector3 };
    return body;
  });
  validateSimulationState(next, settings);
  return next;
}

export function placeBodyPairInCircularOrbit(
  bodies: readonly CelestialBody[], firstBodyId: string, secondBodyId: string, separationM: number,
  planeNormal: Vector3, radialDirection: Vector3, settings: PhysicsSettings,
): CelestialBody[] {
  const firstIndex = bodies.findIndex(({ id }) => id === firstBodyId);
  const secondIndex = bodies.findIndex(({ id }) => id === secondBodyId);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) throw new SimulationError("INVALID_BODY", "Selecione dois astros diferentes para formar o par.");
  const first = bodies[firstIndex]!;
  const second = bodies[secondIndex]!;
  const { radial, tangent } = orbitAxes(planeNormal, radialDirection);
  validateOrbitInputs(first, second, separationM, settings);
  const totalMassKg = first.massKg + second.massKg;
  const relativePosition = scale(radial, separationM);
  const relativeVelocity = scale(tangent, Math.sqrt(settings.gravitationalConstant * totalMassKg / separationM));
  const centerPosition = weightedVector(first.positionM, first.massKg, second.positionM, second.massKg, totalMassKg);
  const centerVelocity = weightedVector(first.velocityMs, first.massKg, second.velocityMs, second.massKg, totalMassKg);
  const next = bodies.map((body, index) => {
    if (index === firstIndex) return { ...body, parentId: second.id,
      positionM: subtract(centerPosition, scale(relativePosition, second.massKg / totalMassKg)) as Vector3,
      velocityMs: subtract(centerVelocity, scale(relativeVelocity, second.massKg / totalMassKg)) as Vector3 };
    if (index === secondIndex) return { ...body, parentId: first.id,
      positionM: add(centerPosition, scale(relativePosition, first.massKg / totalMassKg)) as Vector3,
      velocityMs: add(centerVelocity, scale(relativeVelocity, first.massKg / totalMassKg)) as Vector3 };
    return body;
  });
  validateSimulationState(next, settings);
  return next;
}

export function createOrbitalRing(
  bodies: readonly CelestialBody[], primaryId: string,
  input: { innerRadiusM: number; outerRadiusM: number; representativeCount: number; totalMassKg: number; profileId: MaterialProfileId; seed: number; planeNormal?: Vector3; radialDirection?: Vector3; swarmId?: string },
  settings: PhysicsSettings,
): { bodies: CelestialBody[]; swarmId: string; particles: CelestialBody[] } {
  const primary = bodies.find(({ id }) => id === primaryId);
  if (!primary) throw new SimulationError("INVALID_BODY", "Astro primário do anel não existe.");
  if (bodies.length + input.representativeCount > MAX_SIMULATION_BODIES) throw new SimulationError("INVALID_BODY", `O anel excederia o limite de ${MAX_SIMULATION_BODIES} astros; nada foi criado.`);
  if (!(settings.gravitationalConstant > 0) || !Number.isFinite(settings.gravitationalConstant)) throw new SimulationError("INVALID_SETTINGS", "Órbita exige gravidade positiva.");
  if (!Number.isFinite(input.innerRadiusM) || !Number.isFinite(input.outerRadiusM) || input.innerRadiusM <= 0
    || input.outerRadiusM <= input.innerRadiusM || !Number.isFinite(input.totalMassKg) || input.totalMassKg <= 0
    || input.totalMassKg > MAX_MASS_KG || !Number.isSafeInteger(input.representativeCount)
    || input.representativeCount < MIN_ORBITAL_RING_PARTICLES || input.representativeCount > MAX_ORBITAL_RING_PARTICLES
    || input.representativeCount % 2 !== 0 || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff
    || !Object.hasOwn(MATERIAL_PROFILES, input.profileId)) throw new SimulationError("INVALID_BODY", "Parâmetros do anel orbital são inválidos.");
  const planeNormal = input.planeNormal ?? [0, 0, 1];
  const radialDirection = input.radialDirection ?? [1, 0, 0];
  const { radial: referenceRadial, tangent: referenceTangent } = orbitAxes(planeNormal, radialDirection);
  const normal = normalize(planeNormal);
  const rng = createSeededRandom(input.seed);
  const densityKgM3 = MATERIAL_PROFILES[input.profileId].densityKgM3.nominal;
  const swarmId = input.swarmId ?? `orbital-swarm-${input.seed}`;
  const pairCount = input.representativeCount / 2;
  const masses = new Array<number>(input.representativeCount);
  let assignedMassKg = 0;
  for (let pair = 0; pair < pairCount; pair += 1) {
    const pairMassKg = pair === pairCount - 1 ? input.totalMassKg - assignedMassKg : input.totalMassKg / pairCount;
    const massKg = pairMassKg / 2;
    masses[pair * 2] = massKg;
    masses[pair * 2 + 1] = massKg;
    assignedMassKg += massKg * 2;
  }
  const angularOffset = rng() * Math.PI * 2;
  const particles: CelestialBody[] = [];
  for (let pair = 0; pair < pairCount; pair += 1) {
    const radiusM = input.innerRadiusM + (input.outerRadiusM - input.innerRadiusM) * rng();
    const angle = angularOffset + Math.PI * pair / pairCount;
    const radial = normalize(add(scale(referenceRadial, Math.cos(angle)), scale(referenceTangent, Math.sin(angle))));
    const tangent = normalize(cross(normal, radial));
    const firstIndex = pair * 2;
    const secondIndex = firstIndex + 1;
    for (const index of [firstIndex, secondIndex]) {
      const sign = index === firstIndex ? 1 : -1;
      const massKg = masses[index]!;
      const particleRadiusM = Math.cbrt(3 * massKg / (4 * Math.PI * densityKgM3));
      if (!(radiusM > primary.radiusM + particleRadiusM)) throw new SimulationError("INVALID_BODY", "O anel deve ficar fora do raio físico do primário.");
      const direction = scale(radial, sign);
      const tangentDirection = scale(tangent, sign);
      const orbitalSpeed = Math.sqrt(settings.gravitationalConstant * (primary.massKg + massKg) / radiusM);
      const serial = index + 1;
      const id = `${swarmId}-particle-${serial}`;
      if (bodies.some((body) => body.id === id)) throw new SimulationError("INVALID_BODY", "O ID determinístico do enxame já existe.");
      particles.push({ id, name: `Partícula ${serial} do anel`, kind: "planet", bodyType: "asteroid", parentId: primary.id,
        massKg, radiusM: particleRadiusM,
        positionM: add(primary.positionM, scale(direction, radiusM)) as Vector3,
        velocityMs: add(primary.velocityMs, scale(tangentDirection, orbitalSpeed)) as Vector3,
        surfaceTemperatureK: 150, waterFraction: 0 });
    }
  }
  const allBodies = [...bodies, ...particles];
  for (let first = 0; first < particles.length; first += 1) {
    for (let second = first + 1; second < particles.length; second += 1) {
      const a = particles[first]!, b = particles[second]!;
      const distance = Math.hypot(...a.positionM.map((value, axis) => value - b.positionM[axis]!));
      if (distance <= a.radiusM + b.radiusM) throw new SimulationError("INVALID_BODY", "As partículas do anel se sobrepõem; aumente a largura ou reduza a massa.");
    }
  }
  validateSimulationState(allBodies, settings);
  return { bodies: allBodies, swarmId, particles };
}

function validateOrbitInputs(first: CelestialBody, second: CelestialBody, separationM: number, settings: PhysicsSettings): void {
  if (!(settings.gravitationalConstant > 0) || !Number.isFinite(settings.gravitationalConstant)) throw new SimulationError("INVALID_SETTINGS", "Órbita exige gravidade positiva.");
  if (!Number.isFinite(separationM) || separationM <= first.radiusM + second.radiusM) throw new SimulationError("INVALID_BODY", "A separação orbital deve exceder os dois raios físicos.");
  if (!Number.isFinite(first.massKg + second.massKg)) throw new SimulationError("INVALID_BODY", "Massa do par orbital inválida.");
}

function orbitAxes(planeNormal: Vector3, radialDirection: Vector3): { radial: Vector3; tangent: Vector3 } {
  const normal = normalize(planeNormal);
  const radialInput = vector(radialDirection);
  const projected = subtract(radialInput, scale(normal, dot(radialInput, normal)));
  const radial = normalize(projected);
  return { radial, tangent: normalize(cross(normal, radial)) };
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

function vector(value: Vector3): Vector3 {
  if (!value.every(Number.isFinite)) throw new SimulationError("INVALID_BODY", "Direção orbital deve ser finita.");
  return value;
}
function normalize(value: Vector3): Vector3 {
  const magnitude = Math.hypot(...value);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) throw new SimulationError("INVALID_BODY", "Vetor orbital deve ter direção não nula.");
  return scale(value, 1 / magnitude) as Vector3;
}
function dot(a: Vector3, b: Vector3): number { return a.reduce((sum, value, axis) => sum + value * b[axis]!, 0); }
function cross(a: Vector3, b: Vector3): Vector3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function scale(value: Vector3, scalar: number): Vector3 { return value.map((component) => component * scalar) as unknown as Vector3; }
function add(a: Vector3, b: Vector3): Vector3 { return a.map((value, axis) => value + b[axis]!) as unknown as Vector3; }
function subtract(a: Vector3, b: Vector3): Vector3 { return a.map((value, axis) => value - b[axis]!) as unknown as Vector3; }
function weightedVector(a: Vector3, aMass: number, b: Vector3, bMass: number, totalMass: number): Vector3 { return a.map((value, axis) => (aMass * value + bMass * b[axis]!) / totalMass) as unknown as Vector3; }
