import type { SimulationSessionState } from "./types";

export function isSimulationSessionState(value: unknown): value is SimulationSessionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return Object.keys(session).length === 2
    && typeof session.simulationTimeSeconds === "number" && Number.isFinite(session.simulationTimeSeconds) && session.simulationTimeSeconds >= 0
    && (session.collisionMode === "scientific" || session.collisionMode === "creative");
}
