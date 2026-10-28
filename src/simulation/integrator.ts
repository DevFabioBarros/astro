import { calculateAccelerations, SimulationError } from "./physics";
import type { CelestialBody, PhysicsSettings, Vector3 } from "./types";

export function velocityVerletStep(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
  dtSeconds: number,
): CelestialBody[] {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    throw new SimulationError("INVALID_TIME_STEP", "Time step must be finite and greater than zero.");
  }

  const initialAccelerations = calculateAccelerations(bodies, settings);
  const movedBodies = bodies.map((body, index) => {
    const acceleration = initialAccelerations[index]!;
    const positionM = body.positionM.map((position, axis) =>
      position + body.velocityMs[axis]! * dtSeconds + 0.5 * acceleration[axis]! * dtSeconds * dtSeconds,
    ) as unknown as Vector3;

    if (!positionM.every(Number.isFinite)) {
      throw new SimulationError("NUMERIC_OVERFLOW", `Position for ${body.id} is not finite after the time step.`);
    }
    return { ...body, positionM };
  });
  const finalAccelerations = calculateAccelerations(movedBodies, settings);

  const nextBodies = movedBodies.map((body, index) => {
    const initial = initialAccelerations[index]!;
    const final = finalAccelerations[index]!;
    const velocityMs = body.velocityMs.map((velocity, axis) =>
      velocity + 0.5 * (initial[axis]! + final[axis]!) * dtSeconds,
    ) as unknown as Vector3;

    if (!velocityMs.every(Number.isFinite)) {
      throw new SimulationError("NUMERIC_OVERFLOW", `Velocity for ${body.id} is not finite after the time step.`);
    }
    return { ...body, velocityMs };
  });
  calculateAccelerations(nextBodies, settings);
  return nextBodies;
}
