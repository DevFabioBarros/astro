import { velocityVerletStep } from "./integrator";
import { SimulationError, validateBodies, validateSettings } from "./physics";
import type { CelestialBody, PhysicsSettings } from "./types";

export { SimulationError } from "./types";

export function advanceWorld(
  bodies: readonly CelestialBody[],
  settings: PhysicsSettings,
  dtSeconds: number,
): CelestialBody[] {
  validateBodies(bodies);
  validateSettings(settings);
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    throw new SimulationError("INVALID_TIME_STEP", "Time step must be finite and greater than zero.");
  }

  return velocityVerletStep(bodies, settings, dtSeconds);
}
