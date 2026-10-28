import { validateSimulationState, SimulationError, MAX_SIMULATION_BODIES, MAX_POSITION_COMPONENT_M } from "./physics";
import type { BodyType, CelestialBody, PhysicsSettings } from "./types";

import { schwarzschildRadius } from "./physical-constants";
export { NEWTONIAN_G, LIGHT_SPEED_MS, schwarzschildRadius } from "./physical-constants";

type BodyTemplate = Pick<CelestialBody, "name" | "kind" | "massKg" | "radiusM" | "surfaceTemperatureK" | "waterFraction"> & { type: BodyType; description: string };
export const BODY_TEMPLATES: readonly BodyTemplate[] = [
  { type: "star", name: "Estrela", description: "Uma estrela como o Sol", kind: "star", massKg: 1.9884e30, radiusM: 695700000, surfaceTemperatureK: 5772, waterFraction: 0 },
  { type: "white-dwarf", name: "Anã branca", description: "Massa estelar no tamanho da Terra", kind: "star", massKg: 1.19304e30, radiusM: 6371000, surfaceTemperatureK: 10000, waterFraction: 0 },
  { type: "neutron-star", name: "Estrela de nêutrons", description: "Um remanescente compacto de 12 km", kind: "star", massKg: 2.78376e30, radiusM: 12000, surfaceTemperatureK: 600000, waterFraction: 0 },
  { type: "black-hole", name: "Buraco negro", description: "Dez massas solares e um horizonte de eventos", kind: "star", massKg: 1.9884e31, radiusM: schwarzschildRadius(1.9884e31), surfaceTemperatureK: 0, waterFraction: 0 },
  { type: "rocky-planet", name: "Planeta rochoso", description: "Um mundo como a Terra", kind: "planet", massKg: 5.97217e24, radiusM: 6371008.4, surfaceTemperatureK: 288, waterFraction: 0.71 },
  { type: "gas-giant", name: "Gigante gasoso", description: "Um planeta como Júpiter", kind: "planet", massKg: 1.898125e27, radiusM: 69911000, surfaceTemperatureK: 163, waterFraction: 0 },
  { type: "moon", name: "Lua", description: "Um satélite em torno de um planeta", kind: "moon", massKg: 7.346e22, radiusM: 1737400, surfaceTemperatureK: 253, waterFraction: 0 },
  { type: "asteroid", name: "Asteroide", description: "Um pequeno mundo como Ceres", kind: "planet", massKg: 9.3835e20, radiusM: 469700, surfaceTemperatureK: 167, waterFraction: 0 },
  { type: "comet", name: "Cometa", description: "Um núcleo de gelo e rocha", kind: "planet", massKg: 1e13, radiusM: 2000, surfaceTemperatureK: 120, waterFraction: 0.5 },
];
export function getBodyType(body: CelestialBody): BodyType {
  return body.bodyType ?? (body.kind === "star" ? "star" : body.kind === "moon" ? "moon" : ["jupiter", "saturn", "uranus", "neptune"].includes(body.id) ? "gas-giant" : "rocky-planet");
}
export function isLuminousBody(body: CelestialBody): boolean { return body.kind === "star" && getBodyType(body) !== "black-hole"; }

export function createCatalogBody(
  type: BodyType,
  bodies: readonly CelestialBody[],
  primaryId: string | null,
  settings: PhysicsSettings,
  pose?: Pick<CelestialBody, "positionM" | "velocityMs">,
): CelestialBody {
  const template = BODY_TEMPLATES.find((entry) => entry.type === type);
  if (!template) throw new SimulationError("INVALID_BODY", "Escolha um tipo de astro válido.");
  if (bodies.length >= MAX_SIMULATION_BODIES) throw new SimulationError("INVALID_BODY", "A simulação aceita até 64 astros.");
  let serial = 1;
  while (bodies.some((body) => body.id === `${type}-${serial}`)) serial += 1;
  const { type: bodyType, description, ...properties } = template;
  void description;
  const base: CelestialBody = { ...properties, bodyType, id: `${type}-${serial}`, name: `${properties.name} ${serial}`, positionM: [0, 0, 0], velocityMs: [0, 0, 0] };
  if (pose) {
    const candidate: CelestialBody = { ...base, ...pose };
    validateSimulationState([...bodies, candidate], settings);
    return candidate;
  }
  if (!bodies.length) {
    if (type === "moon") throw new SimulationError("INVALID_BODY", "Crie um planeta antes de adicionar uma lua.");
    validateSimulationState([base], settings); return base;
  }
  const selected = bodies.find((body) => body.id === primaryId);
  if (primaryId !== null && !selected) throw new SimulationError("INVALID_BODY", "O centro de órbita não existe mais.");
  if (type === "moon" && selected && selected.kind !== "planet") throw new SimulationError("INVALID_BODY", "Escolha um planeta para criar uma lua.");
  const moonPrimary = selected ?? bodies.find((body) => body.id === "earth") ?? bodies.find((body) => body.kind === "planet");
  if (type === "moon" && !moonPrimary) throw new SimulationError("INVALID_BODY", "Crie um planeta antes de adicionar uma lua.");
  const primary = type === "moon" ? moonPrimary! : selected ?? bodies.reduce((a, b) => a.massKg > b.massKg ? a : b);
  const orbiting = type === "moon" || primaryId !== null;
  let minimum = Math.max((primary.radiusM + base.radiusM) * 4, Math.sqrt(settings.gravitationalConstant * (primary.massKg + base.massKg) / 100), type === "moon" && primary.kind === "planet" ? 384400000 : 149597870700);
  if (type === "moon" && primary.kind === "planet") {
    const star = bodies.filter((body) => body.id !== primary.id && body.massKg > primary.massKg).sort((a, b) => b.massKg - a.massKg)[0];
    if (star) {
      const hill = Math.hypot(...primary.positionM.map((value, axis) => value - star.positionM[axis]!)) * Math.cbrt(primary.massKg / (3 * star.massKg));
      minimum = Math.min(minimum, hill * 0.3);
      if (minimum < (primary.radiusM + base.radiusM) * 3) throw new SimulationError("INVALID_BODY", "Este planeta não tem espaço para uma órbita lunar estável. Escolha outro planeta.");
    }
  }
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const angle = attempt * 2.399963229728653;
    const radius = minimum * (type === "moon" && primary.kind === "planet" ? 1 : 1 + Math.floor(attempt / 12) * 0.35);
    const positionM = [primary.positionM[0] + radius * Math.cos(angle), primary.positionM[1] + radius * Math.sin(angle), primary.positionM[2]] as const;
    if (positionM.some((value) => Math.abs(value) > MAX_POSITION_COMPONENT_M)) continue;
    if (bodies.some((body) => Math.hypot(...positionM.map((value, axis) => value - body.positionM[axis]!)) < (body.radiusM + base.radiusM) * 3)) continue;
    const speed = Math.sqrt(settings.gravitationalConstant * (primary.massKg + base.massKg) / radius);
    const candidate: CelestialBody = { ...base, ...(orbiting ? { parentId: primary.id } : {}), positionM, velocityMs: orbiting ? [primary.velocityMs[0] - speed * Math.sin(angle), primary.velocityMs[1] + speed * Math.cos(angle), primary.velocityMs[2]] : [0, 0, 0] };
    try { validateSimulationState([...bodies, candidate], settings); return candidate; } catch { /* Try another safe placement without changing existing bodies. */ }
  }
  throw new SimulationError("INVALID_BODY", "Não há espaço seguro para este astro aqui. Escolha outro centro de órbita.");
}
