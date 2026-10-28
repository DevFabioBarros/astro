import { describe, expect, it } from "vitest";
import type { CelestialBody, SimulationEvent } from "./types";
import { debrisBodyIdsFromEvents, isDebrisBody } from "./body-identity";

function makeEvent(overrides: Partial<SimulationEvent>): SimulationEvent {
  return {
    id: 1,
    type: "explosion",
    timeSeconds: 0,
    positionM: [0, 0, 0],
    radiusM: 1,
    energyJ: 0,
    bodyIds: ["source"],
    ...overrides,
  };
}

function makeBody(overrides: Partial<CelestialBody>): CelestialBody {
  return {
    id: "body",
    name: "Astro",
    kind: "planet",
    massKg: 1,
    radiusM: 1,
    positionM: [0, 0, 0],
    velocityMs: [0, 0, 0],
    surfaceTemperatureK: 300,
    waterFraction: 0,
    ...overrides,
  };
}

describe("body debris identity", () => {
  it("uses accepted fragment IDs from manual and creative collisions, excluding sources", () => {
    const events: SimulationEvent[] = [
      makeEvent({ bodyIds: ["earth", "manual-1", "manual-2"] }),
      makeEvent({
        id: 2,
        type: "collision",
        bodyIds: ["mars", "jupiter", "collision-1"],
        outcome: {
          kind: "creative-fragmentation",
          modelId: "creative-fragmentation-v1",
          fragmentBodyIds: ["collision-1", "collision-2"],
          availableEnergyJ: 10,
          fragmentKineticEnergyJ: 4,
          dissipatedEnergyJ: 6,
        },
      }),
    ];

    expect([...debrisBodyIdsFromEvents(events)]).toEqual(["manual-1", "manual-2", "collision-1", "collision-2"]);
  });

  it("never treats a stellar gas expansion as debris", () => {
    const event = makeEvent({ bodyIds: ["sun", "gas-shell"], visualEffect: "stellar-gas-expansion" });

    expect(debrisBodyIdsFromEvents([event]).size).toBe(0);
  });

  it("keeps accepted debris hidden after rename by ID, without matching similar names or IDs", () => {
    const acceptedIds = debrisBodyIdsFromEvents([makeEvent({ bodyIds: ["source", "accepted-fragment-id"] })]);

    expect(isDebrisBody(makeBody({ id: "accepted-fragment-id", name: "Renamed asteroid" }), acceptedIds)).toBe(true);
    expect(isDebrisBody(makeBody({ id: "imported-asteroid", name: "Asteroide fragmento 2" }), acceptedIds)).toBe(false);
    expect(isDebrisBody(makeBody({ id: "earth-fragment-1-2", name: "Fragmento de Terra 2" }), new Set())).toBe(false);
    expect(isDebrisBody(makeBody({ id: "rock-1", name: "Astro fragmento 2 extra" }), new Set())).toBe(false);
  });
});
