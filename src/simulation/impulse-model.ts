import { MAX_VELOCITY_MS } from "./physics";
import { SimulationError } from "./types";
import type { CelestialBody, Vector3 } from "./types";

export const CENTER_OF_MASS_IMPULSE_MODEL_ID = "center-of-mass-impulse-v1" as const;

export function applyCenterOfMassImpulse(body: CelestialBody, impulseNs: Vector3): {
  body: CelestialBody; deltaVelocityMs: Vector3; impulseNs: Vector3; externalWorkJ: number;
} {
  const components: readonly number[] = impulseNs;
  if (components.length !== 3 || !components.every(Number.isFinite) || components.every((value) => value === 0)) {
    throw new SimulationError("INVALID_BODY", "O impulso deve ser um vetor finito e não nulo.");
  }
  if (!Number.isFinite(body.massKg) || body.massKg <= 0) throw new SimulationError("INVALID_BODY", "A massa do alvo deve ser positiva para aplicar o impulso.");

  const deltaVelocityMs = impulseNs.map((component) => component / body.massKg) as unknown as Vector3;
  if (deltaVelocityMs.some((component) => !Number.isFinite(component) || Math.abs(component) > MAX_VELOCITY_MS)
    || deltaVelocityMs.every((component) => component === 0)) {
    throw new SimulationError("INVALID_BODY", "A variação de velocidade derivada do impulso excede o limite suportado.");
  }
  const externalWorkJ = body.velocityMs.reduce((sum, velocity, axis) => sum + velocity * impulseNs[axis]!, 0)
    + impulseNs.reduce((sum, component) => sum + component * component, 0) / (2 * body.massKg);
  const velocityMs = body.velocityMs.map((velocity, axis) => velocity + deltaVelocityMs[axis]!) as unknown as Vector3;
  if (![externalWorkJ, ...velocityMs].every(Number.isFinite)) {
    throw new SimulationError("NUMERIC_OVERFLOW", "O impulso excede o limite numérico.");
  }
  return { body: { ...body, velocityMs }, deltaVelocityMs, impulseNs, externalWorkJ };
}
