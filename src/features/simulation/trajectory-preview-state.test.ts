import { expect, it } from "vitest";
import type { CollisionMode, SimulationSnapshot } from "@/simulation/types";
import { isTrajectoryPreviewCurrent } from "./trajectory-preview-state";

const preview = { worldRevision: 4, baseTimeSeconds: 12, collisionMode: "scientific" as CollisionMode };
const snapshot = (overrides: Partial<SimulationSnapshot> = {}): SimulationSnapshot => ({
  bodies: [], environmentSeed: 0x41535400, simulationTimeSeconds: 12, status: "paused", collisionMode: "scientific", speedLimited: false,
  worldRevision: 4, ...overrides,
});

it("keeps a trajectory preview only for its exact accepted paused snapshot", () => {
  expect(isTrajectoryPreviewCurrent(preview, snapshot())).toBe(true);
  expect(isTrajectoryPreviewCurrent(preview, snapshot({ worldRevision: 5 }))).toBe(false);
  expect(isTrajectoryPreviewCurrent(preview, snapshot({ simulationTimeSeconds: 13 }))).toBe(false);
  expect(isTrajectoryPreviewCurrent(preview, snapshot({ collisionMode: "creative" }))).toBe(false);
  expect(isTrajectoryPreviewCurrent(preview, snapshot({ status: "running" }))).toBe(false);
  expect(isTrajectoryPreviewCurrent(preview, snapshot({ stellarEvolutionRunning: true }))).toBe(false);
});
