import type { SimulationSnapshot, TrajectoryPreviewRequest } from "@/simulation/types";

type PreviewBasis = Pick<TrajectoryPreviewRequest, "worldRevision" | "baseTimeSeconds" | "collisionMode">;

export function isTrajectoryPreviewCurrent(basis: PreviewBasis, snapshot: SimulationSnapshot): boolean {
  return snapshot.worldRevision === basis.worldRevision
    && snapshot.simulationTimeSeconds === basis.baseTimeSeconds
    && snapshot.collisionMode === basis.collisionMode
    && snapshot.status === "paused"
    && !snapshot.stellarEvolutionRunning;
}
