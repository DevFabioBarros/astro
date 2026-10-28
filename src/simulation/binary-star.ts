import { BODY_TEMPLATES } from "./body-catalog";
import { NEWTONIAN_G } from "./physical-constants";
import { validateSimulationState } from "./physics";
import type { CelestialBody, PhysicsSettings } from "./types";

const AU_M = 149_597_870_700;
const settings: PhysicsSettings = { gravitationalConstant: NEWTONIAN_G };

export function createBinaryStarSystem(separationAu = 1): { bodies: CelestialBody[]; settings: PhysicsSettings } {
  if (!Number.isFinite(separationAu) || separationAu <= 0) throw new Error("Binary separation must be a finite positive number of AU.");
  const { description, type: bodyType, ...star } = BODY_TEMPLATES.find((template) => template.type === "star")!;
  void description;
  const mass = star.massKg;
  const separationM = AU_M * separationAu;
  const halfSeparation = separationM / 2;
  const halfRelativeSpeed = Math.sqrt(NEWTONIAN_G * (mass + mass) / separationM) / 2;
  const bodies: CelestialBody[] = [
    {
      ...star,
      id: "binary-star-a",
      name: "Estrela A",
      bodyType,
      positionM: [-halfSeparation, 0, 0],
      velocityMs: [0, -halfRelativeSpeed, 0],
    },
    {
      ...star,
      id: "binary-star-b",
      name: "Estrela B",
      bodyType,
      parentId: "binary-star-a",
      positionM: [halfSeparation, 0, 0],
      velocityMs: [0, halfRelativeSpeed, 0],
    },
  ];
  validateSimulationState(bodies, settings);
  return { bodies, settings: { ...settings } };
}
