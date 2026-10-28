import type { SimulationSnapshot } from "@/simulation/types";

type SnapshotRunningState = Pick<SimulationSnapshot, "status" | "error">;

export const snapshotStopsRunning = (snapshot: SnapshotRunningState) =>
  snapshot.status === "error" || Boolean(snapshot.error);

export const shouldResumeFromSnapshot = (snapshot: SnapshotRunningState, resumeRunning: boolean) =>
  resumeRunning && !snapshotStopsRunning(snapshot);
