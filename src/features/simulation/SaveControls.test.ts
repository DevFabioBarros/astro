import { describe, expect, it } from "vitest";
import { decodeSimulation } from "@/simulation/save-file";
import { createSolarSystem } from "@/simulation/solar-system";
import { encodeSimulationForExport } from "./SaveControls";

const settings = { gravitationalConstant: 6.6743e-11 };

describe("simulation export snapshot selection", () => {
  it("uses the displayed replacement seed with the displayed world before the first accepted snapshot", () => {
    const displayed = { bodies: createSolarSystem(), settings, simulationTimeSeconds: 0, collisionMode: "scientific" as const, environmentSeed: 0xfeed1234 };
    const decoded = decodeSimulation(encodeSimulationForExport(null, displayed));

    expect(decoded).toMatchObject({ bodies: displayed.bodies, settings, environmentSeed: displayed.environmentSeed });
  });

  it("uses the accepted seed together with the accepted world when available", () => {
    const acceptedBodies = createSolarSystem().slice(0, 1);
    const accepted = { bodies: acceptedBodies, settings, simulationTimeSeconds: 12, collisionMode: "creative" as const,
      environmentSeed: 22, status: "paused" as const, worldRevision: 3, sequence: 1 };
    const displayed = { bodies: createSolarSystem(), settings, simulationTimeSeconds: 0, collisionMode: "scientific" as const, environmentSeed: 11 };

    expect(decodeSimulation(encodeSimulationForExport(accepted, displayed))).toMatchObject({
      bodies: acceptedBodies, environmentSeed: 22, session: { simulationTimeSeconds: 12, collisionMode: "creative" },
    });
  });

  it("keeps accepted sidecar data paired with its body packet and uses displayed pending data before acknowledgement", () => {
    const surface = { modelId: "sparse-relief-v1" as const, seed: 4, revision: 1, resolution: 64 as const, dataId: "earth-relief" };
    const acceptedBodies = [{ ...createSolarSystem()[3]!, surface }];
    const acceptedSurfaceData = { "earth-relief": [{ cellIndex: 8, elevationM: 900 }] };
    const accepted = { bodies: acceptedBodies, settings, simulationTimeSeconds: 12, collisionMode: "creative" as const,
      environmentSeed: 22, status: "paused" as const, worldRevision: 3, sequence: 1, surfaceData: acceptedSurfaceData };
    const displayed = { bodies: acceptedBodies, settings, simulationTimeSeconds: 0, collisionMode: "scientific" as const,
      environmentSeed: 11, surfaceData: { "earth-relief": [{ cellIndex: 8, elevationM: 2_000 }] } };

    expect(decodeSimulation(encodeSimulationForExport(accepted, displayed)).surfaceData).toEqual(acceptedSurfaceData);
    expect(decodeSimulation(encodeSimulationForExport(null, displayed)).surfaceData).toEqual(displayed.surfaceData);
  });
});
