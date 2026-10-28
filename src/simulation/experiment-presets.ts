import { createCatalogBody } from "./body-catalog";
import { createBinaryStarSystem } from "./binary-star";
import { NEWTONIAN_G } from "./physical-constants";
import { createSolarSystem } from "./solar-system";
import { isEnvironmentSeed } from "./world-seed";
import type { CelestialBody, PhysicsSettings, Vector3 } from "./types";

export type ExperimentId = "earth-mars" | "black-hole" | "extreme-sun" | "binary-stars" | "eclipse" | "displaced-moon" | "oblique-impact";

export type ExperimentPreset = {
  environmentSeed: number;
  bodies: CelestialBody[];
  settings: PhysicsSettings;
  selectedBodyId: string;
  speed: number;
  viewMode: "focus" | "system";
  collisionMode: "scientific" | "creative";
  showOrbits?: boolean;
  showTrails?: boolean;
  openInspector?: boolean;
};

export const EXPERIMENT_ENVIRONMENT_SEEDS_V1: Readonly<Record<ExperimentId, number>> = Object.freeze({
  "earth-mars": 0x41535401,
  "black-hole": 0x41535402,
  "extreme-sun": 0x41535403,
  "binary-stars": 0x41535404,
  eclipse: 0x41535405,
  "displaced-moon": 0x41535406,
  "oblique-impact": 0x41535407,
});

export type ExperimentScenario = {
  id: ExperimentId;
  title: string;
  description: string;
  expectedDuration: string;
  technicalDetails: string;
};

export const EXPERIMENT_SCENARIOS: readonly ExperimentScenario[] = [
  { id: "binary-stars", title: "Dança binária", description: "Duas estrelas giram em torno do mesmo centro.", expectedDuration: "≈23 s por volta simulada", technicalDetails: "Duas estrelas iguais em órbita circular. O período é de cerca de 23 dias simulados, a 1 dia por segundo." },
  { id: "earth-mars", title: "Terra e Marte", description: "Dois planetas seguem para um encontro frontal.", expectedDuration: "≈4 s até o impacto", technicalDetails: "Velocidade relativa inicial de 50 km/s, centro de massa preservado e colisão criativa." },
  { id: "black-hole", title: "Captura pelo buraco negro", description: "Um asteroide cruza a zona de captura.", expectedDuration: "≈4 s até a captura", technicalDetails: "A gravidade newtoniana é desligada nesta demonstração. A captura usa uma zona de jogo; não simula relatividade." },
  { id: "extreme-sun", title: "Sol extremo", description: "Aumente o efeito da estrela sobre o Sistema Solar.", expectedDuration: "Livre", technicalDetails: "O preset usa 8 massas solares, raio 3 vezes maior e temperatura de 9.000 K. Não representa evolução estelar." },
  { id: "eclipse", title: "Eclipse solar", description: "Lua alinhada entre a Terra e o Sol.", expectedDuration: "Alinhado ao iniciar", technicalDetails: "Cena reduzida a Sol, Terra e Lua. A Lua começa a 384.400 km da Terra; órbitas seguem a gravidade N-body." },
  { id: "displaced-moon", title: "Lua mais distante", description: "Veja como uma órbita maior muda a dança do par.", expectedDuration: "≈50 s por volta", technicalDetails: "Cena Terra–Lua isolada. A separação inicial é 1,5 vezes a distância média, com velocidade circular aproximada." },
  { id: "oblique-impact", title: "Impacto de raspão", description: "Terra e Marte se encontram de lado.", expectedDuration: "≈4 s até o impacto", technicalDetails: "Velocidade relativa inicial de 50 km/s e deslocamento lateral igual a 38% da soma dos raios. O resultado segue a regra de colisão criativa." },
];

const NATURAL_SETTINGS: PhysicsSettings = { gravitationalConstant: NEWTONIAN_G };
const AU_M = 149_597_870_700;
const LUNAR_DISTANCE_M = 384_400_000;
const ZERO: Vector3 = [0, 0, 0];
const ECLIPTIC_NORMAL: Vector3 = [0, 0, 1];

function subtract(a: Vector3, b: Vector3): Vector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vector3, b: Vector3): Vector3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(vector: Vector3, amount: number): Vector3 { return [vector[0] * amount, vector[1] * amount, vector[2] * amount]; }
function cross(a: Vector3, b: Vector3): Vector3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(vector: Vector3): Vector3 { const length = Math.hypot(...vector); return length > 0 ? scale(vector, 1 / length) : [1, 0, 0]; }
function weightedCenter(a: Vector3, massA: number, b: Vector3, massB: number, totalMass: number): Vector3 {
  return add(scale(a, massA / totalMass), scale(b, massB / totalMass));
}

function createImpactPreset(impactParameterFraction: number): Omit<ExperimentPreset, "environmentSeed"> {
  const solar = createSolarSystem();
  const earth = solar.find(({ id }) => id === "earth")!;
  const mars = solar.find(({ id }) => id === "mars")!;
  const relativeSpeed = 50_000;
  const speed = 50;
  const contactRadius = earth.radiusM + mars.radiusM;
  const impactParameter = contactRadius * impactParameterFraction;
  const horizontalContactDistance = Math.sqrt(contactRadius ** 2 - impactParameter ** 2);
  const separation = horizontalContactDistance + relativeSpeed * speed * 4;
  const totalMass = earth.massKg + mars.massKg;
  const relativePosition: Vector3 = [separation, impactParameter, 0];
  const relativeVelocity: Vector3 = [-relativeSpeed, 0, 0];
  return {
    bodies: [
      { ...earth, positionM: scale(relativePosition, -mars.massKg / totalMass), velocityMs: scale(relativeVelocity, -mars.massKg / totalMass) },
      { ...mars, positionM: scale(relativePosition, earth.massKg / totalMass), velocityMs: scale(relativeVelocity, earth.massKg / totalMass) },
    ],
    settings: NATURAL_SETTINGS,
    selectedBodyId: "earth",
    speed,
    viewMode: "system",
    collisionMode: "creative",
  };
}

function createMoonPreset(eclipse: boolean): Omit<ExperimentPreset, "environmentSeed"> {
  const solar = createSolarSystem();
  const sun = solar.find(({ id }) => id === "sun")!;
  const earth = solar.find(({ id }) => id === "earth")!;
  const moon = solar.find(({ id }) => id === "moon")!;
  const sunward = normalize(subtract(sun.positionM, earth.positionM));
  const radial = eclipse ? sunward : normalize(cross(ECLIPTIC_NORMAL, sunward));
  const distance = eclipse ? LUNAR_DISTANCE_M : LUNAR_DISTANCE_M * 1.5;
  const totalMass = earth.massKg + moon.massKg;
  const centerPosition = weightedCenter(earth.positionM, earth.massKg, moon.positionM, moon.massKg, totalMass);
  const centerVelocity = weightedCenter(earth.velocityMs, earth.massKg, moon.velocityMs, moon.massKg, totalMass);
  const relativePosition = scale(radial, distance);
  const tangent = normalize(cross(ECLIPTIC_NORMAL, radial));
  const relativeVelocity = scale(tangent, Math.sqrt(NEWTONIAN_G * totalMass / distance));
  const newEarth: CelestialBody = {
    ...earth,
    positionM: subtract(centerPosition, scale(relativePosition, moon.massKg / totalMass)),
    velocityMs: subtract(centerVelocity, scale(relativeVelocity, moon.massKg / totalMass)),
  };
  const newMoon: CelestialBody = {
    ...moon,
    parentId: earth.id,
    positionM: add(centerPosition, scale(relativePosition, earth.massKg / totalMass)),
    velocityMs: add(centerVelocity, scale(relativeVelocity, earth.massKg / totalMass)),
  };

  return {
    bodies: eclipse ? [sun, newEarth, newMoon] : [newEarth, newMoon],
    settings: NATURAL_SETTINGS,
    selectedBodyId: "earth",
    speed: 86_400,
    viewMode: "system",
    collisionMode: "scientific",
    showOrbits: true,
    showTrails: false,
  };
}

export function createExperimentPreset(id: ExperimentId): ExperimentPreset {
  const seeded = (preset: Omit<ExperimentPreset, "environmentSeed">): ExperimentPreset => {
    const environmentSeed = EXPERIMENT_ENVIRONMENT_SEEDS_V1[id];
    if (!isEnvironmentSeed(environmentSeed)) throw new Error("A seed do experimento é inválida.");
    return { ...preset, environmentSeed };
  };
  switch (id) {
    case "binary-stars": {
      const { bodies, settings } = createBinaryStarSystem(0.2);
      return seeded({ bodies, settings, selectedBodyId: "binary-star-b", speed: 86_400, viewMode: "system", collisionMode: "scientific", showOrbits: true, showTrails: true, openInspector: true });
    }
    case "earth-mars": return seeded(createImpactPreset(0));
    case "oblique-impact": return seeded(createImpactPreset(0.38));
    case "eclipse": return seeded(createMoonPreset(true));
    case "displaced-moon": return seeded(createMoonPreset(false));
    case "black-hole": {
      const settings = { gravitationalConstant: 0 };
      const blackHole = createCatalogBody("black-hole", [], null, settings);
      const asteroid = createCatalogBody("asteroid", [], null, settings);
      const intruder: CelestialBody = { ...asteroid, id: "capture-asteroid", name: "Asteroide de teste", positionM: [3_500_000, 0, 0], velocityMs: [-50_000, 0, 0] };
      return seeded({ bodies: [{ ...blackHole, id: "experiment-black-hole", name: "Buraco negro", positionM: ZERO }, intruder], settings, selectedBodyId: "experiment-black-hole", speed: 10, viewMode: "system", collisionMode: "creative" });
    }
    case "extreme-sun": {
      const bodies = createSolarSystem();
      const sun = bodies.find(({ id }) => id === "sun")!;
      sun.massKg *= 8;
      sun.radiusM *= 3;
      sun.surfaceTemperatureK = 9_000;
      return seeded({ bodies, settings: NATURAL_SETTINGS, selectedBodyId: "sun", speed: 86_400, viewMode: "focus", collisionMode: "creative" });
    }
    default: throw new Error("Cenário desconhecido.");
  }
}
