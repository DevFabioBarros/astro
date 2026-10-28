import { describe, expect, it } from "vitest";
import { advanceSimulationInterval } from "./simulation-time";
import { createSolarSystem } from "./solar-system";

describe("T13 visual heat collision regression", () => {
  it("accepts a duplicated Earth overlap with bounded accepted-time glow", () => {
    const solarSystem = createSolarSystem();
    const earth = solarSystem.find(({ id }) => id === "earth")!;
    const surface = { modelId: "sparse-relief-v1" as const, seed: 123, revision: 0, resolution: 64 as const, dataId: "earth-relief" };
    const materializedEarth = { ...earth, surface };
    const duplicate = { ...materializedEarth, id: "earth-copy-1", name: "Earth (copy 1)",
      positionM: [earth.positionM[0] + 11_600_000, earth.positionM[1], earth.positionM[2]] as const };
    const bodies = solarSystem.map((body) => body.id === earth.id ? materializedEarth : body);
    bodies.push(duplicate);
    const result = advanceSimulationInterval(bodies, { gravitationalConstant: 0 }, 1, 1, {
        simulationTimeSeconds: 86_400,
        surfaceData: { [surface.dataId]: [] },
        surfaceHeatData: { [surface.dataId]: [] },
      });

    expect(result.events[0]?.outcome).toMatchObject({ kind: "perfectly-inelastic-merge", survivorBodyId: "earth" });
    expect(result.surfaceHeatData?.[surface.dataId]).toEqual([]);
  });
});
