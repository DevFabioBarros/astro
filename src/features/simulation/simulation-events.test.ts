import { describe, expect, it } from "vitest";
import { chooseSurvivingBodyId, describeSimulationEvent, describeCollisionDetails, findNewAuthoritativeEvents, shouldRestoreAcknowledgedControlFocus } from "./simulation-events";
import type { CelestialBody, SimulationEvent, SimulationSnapshot } from "@/simulation/types";

const body = (id: string): CelestialBody => ({ id, name: id, kind: "planet", massKg: 1, radiusM: 1, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 });
const event: SimulationEvent = { id: 7, type: "explosion", timeSeconds: 12, positionM: [0, 0, 0], radiusM: 4, energyJ: 8, bodyIds: ["fragment-1", "fragment-2"] };
const snapshot = (worldRevision: number | undefined, events?: readonly SimulationEvent[]): SimulationSnapshot => ({ bodies: [], environmentSeed: 0x41535400, simulationTimeSeconds: 12, status: "running", collisionMode: "scientific", worldRevision, events });

describe("simulation event UI helpers", () => {
  it("announces only new events in current authoritative snapshots", () => {
    expect(findNewAuthoritativeEvents(snapshot(4, [event]), 4, 6)).toEqual([event]);
    expect(findNewAuthoritativeEvents(snapshot(3, [event]), 4, 6)).toEqual([]);
    expect(findNewAuthoritativeEvents(snapshot(undefined, [event]), 0, 6)).toEqual([]);
    expect(findNewAuthoritativeEvents(snapshot(4, [event]), 4, 7)).toEqual([]);
    expect(findNewAuthoritativeEvents(snapshot(5, [{ ...event, id: 1 }]), 5, -1)).toEqual([{ ...event, id: 1 }]);
  });

  it("ignores malformed event data before announcement", () => {
    const malformed = { ...event, id: "7" } as unknown as SimulationEvent;
    expect(findNewAuthoritativeEvents(snapshot(4, [malformed]), 4, 6)).toEqual([]);
  });

  it.each([
    ["zero", 0, true],
    ["right-angle boundary", Math.PI / 2, true],
    ["null angle", null, true],
    ["negative", -Number.EPSILON, false],
    ["above right angle", Math.PI / 2 + Number.EPSILON, false],
  ])("validates collision impact angle: %s", (_name, impactAngleRad, accepted) => {
    const collision: SimulationEvent = {
      ...event,
      type: "collision",
      collisionDiagnostics: { modelId: "perfectly-inelastic-merge-v1", relativeSpeedMps: 200, specificImpactEnergyJkg: 5000, impactAngleRad },
    };
    expect(findNewAuthoritativeEvents(snapshot(4, [collision]), 4, 6)).toEqual(accepted ? [collision] : []);
  });

  it("keeps legacy collision events without diagnostics", () => {
    const legacyCollision: SimulationEvent = { ...event, type: "collision" };
    expect(findNewAuthoritativeEvents(snapshot(4, [legacyCollision]), 4, 6)).toEqual([legacyCollision]);
  });

  it("sorts every unseen authoritative event by numeric ID", () => {
    const events = [{ ...event, id: 9 }, { ...event, id: 8 }, { ...event, id: 7 }];
    expect(findNewAuthoritativeEvents(snapshot(4, events), 4, 7).map(({ id }) => id)).toEqual([8, 9]);
  });

  it("tracks selection through a merge chain and ignores later unrelated merges", () => {
    const events = [
      { ...event, id: 1, type: "collision" as const, bodyIds: ["A", "B"] },
      { ...event, id: 2, type: "collision" as const, bodyIds: ["B", "C"] },
      { ...event, id: 3, type: "collision" as const, bodyIds: ["D", "E"] },
    ];
    expect(chooseSurvivingBodyId([body("C"), body("E")], "A", events)).toBe("C");
  });

  it("tracks lineage from an explosion across six fragments and a merge", () => {
    const fragments = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const events = [
      { ...event, id: 1, bodyIds: ["earth", ...fragments] },
      { ...event, id: 2, type: "collision" as const, bodyIds: ["f4", "moon"] },
    ];
    expect(chooseSurvivingBodyId([body("moon"), body("unrelated")], "earth", events)).toBe("moon");
  });

  it("keeps the selected body and does not replay seen or stale events", () => {
    const resetEvent = { ...event, id: 1 };
    expect(findNewAuthoritativeEvents(snapshot(2, [resetEvent]), 2, -1)).toEqual([resetEvent]);
    expect(findNewAuthoritativeEvents(snapshot(2, [resetEvent]), 2, 1)).toEqual([]);
    expect(findNewAuthoritativeEvents(snapshot(1, [resetEvent]), 2, -1)).toEqual([]);
    expect(chooseSurvivingBodyId([body("earth"), body("fragment-2")], "earth", [event])).toBe("earth");
  });

  it("selects a connected survivor without letting an unrelated event replace it", () => {
    const events = [
      { ...event, id: 1, type: "collision" as const, bodyIds: ["earth", "mars"] },
      { ...event, id: 2, type: "collision" as const, bodyIds: ["Jupiter", "Saturn"] },
    ];
    expect(chooseSurvivingBodyId([body("mars"), body("Saturn")], "earth", events)).toBe("mars");
  });

  it("uses friendly event copy", () => {
    expect(describeSimulationEvent({ ...event, type: "collision" })).toBe("Colisão: fusão perfeitamente inelástica.");
    expect(describeSimulationEvent(event)).toBe("Desintegração experimental.");
    expect(describeSimulationEvent({ ...event, visualEffect: "stellar-gas-expansion" })).toBe("Descarga criativa de gás; a estrela permanece intacta.");
  });

  it("announces accepted center-of-mass impulse with signed work details", () => {
    const impulse: SimulationEvent = {
      ...event,
      type: "impulse",
      energyJ: 5,
      bodyIds: ["earth"],
      impulse: { modelId: "center-of-mass-impulse-v1", deltaVelocityMs: [2, 0, -1], impulseNs: [10, 0, -5], externalWorkJ: -5 },
    };
    expect(findNewAuthoritativeEvents(snapshot(4, [impulse]), 4, 6)).toEqual([impulse]);
    expect(describeSimulationEvent(impulse)).toBe("Impulso aplicado ao centro de massa.");
    expect(describeCollisionDetails(impulse)).toEqual([
      ["Modelo", "Impulso no centro de massa (v1)"],
      ["Variação de velocidade", "2, 0, -1 m/s"],
      ["Impulso", "10, 0, -5 N·s"],
      ["Trabalho externo assinado", "-5 J"],
    ]);
    expect(findNewAuthoritativeEvents(snapshot(4, [{ ...impulse, energyJ: 6 }]), 4, 6)).toEqual([]);
  });

  it("describes an accepted laser as a visual spot and shows the closed energy ledger", () => {
    const laser: SimulationEvent = { ...event, type: "laser", energyJ: 2e9, bodyIds: ["earth"], laser: {
      modelId: "laser-energy-ledger-v1", profileId: "grey-albedo-laser-absorption-v1",
      bodyLocalDirection: [0, 0, 1], powerW: 2e8, durationAcceptedSeconds: 10, albedo: 0.3,
      inputJ: 2e9, absorbedJ: 1.4e9, reflectedJ: 0.6e9,
    } };
    expect(findNewAuthoritativeEvents(snapshot(4, [laser]), 4, 6)).toEqual([laser]);
    expect(describeSimulationEvent(laser)).toContain("não altera a temperatura");
    expect(describeCollisionDetails(laser)).toEqual([
      ["Modelo", "Absorção por albedo cinzento (v1)"],
      ["Potência", "2E8 W"],
      ["Duração simulada", "10 s"],
      ["Energia de entrada", "2E9 J"],
      ["Energia absorvida (sem T10)", "1,4E9 J"],
      ["Energia refletida", "6E8 J"],
    ]);
  });

  it("describes collision diagnostics and preserves the legacy fallback", () => {
    const collision: SimulationEvent = { ...event, type: "collision", energyJ: 1e20, collisionDiagnostics: { modelId: "perfectly-inelastic-merge-v1", relativeSpeedMps: 200, specificImpactEnergyJkg: 5000, impactAngleRad: Math.PI / 4 } };
    expect(describeCollisionDetails(collision)).toEqual([
      ["Modelo", "Fusão perfeitamente inelástica (v1)"],
      ["Velocidade relativa", "200 m/s"],
      ["Energia específica do impacto (Q_R)", "5.000 J/kg"],
      ["Ângulo de impacto", "45°"],
      ["Energia cinética relativa removida (não calor)", "1E20 J"],
    ]);
    expect(describeCollisionDetails({ ...collision, collisionDiagnostics: { ...collision.collisionDiagnostics!, impactAngleRad: null } })?.[3]).toEqual(["Ângulo de impacto", "Não informado"]);
    expect(describeCollisionDetails({ ...collision, collisionDiagnostics: undefined })).toBeNull();
    expect(describeSimulationEvent({ ...collision, collisionDiagnostics: undefined })).toBe("Colisão: fusão perfeitamente inelástica.");
  });

  it("filters creative fragments against the accepted snapshot and explains the energy split", () => {
    const collision: SimulationEvent = {
      ...event,
      type: "collision",
      bodyIds: ["earth", "mars"],
      outcome: { kind: "creative-fragmentation", modelId: "creative-fragmentation-v1", fragmentBodyIds: ["f1", "f2", "f3"], availableEnergyJ: 100, fragmentKineticEnergyJ: 60, dissipatedEnergyJ: 40 },
    };
    const extant = [body("f2")];
    expect(describeSimulationEvent(collision, extant)).toBe("Colisão criativa: fragmentação.");
    expect(describeCollisionDetails(collision, extant)).toEqual([
      ["Modelo", "Fragmentação criativa (v1)"],
      ["Fragmentos presentes", "1 de 3"],
      ["Energia disponível", "100 J"],
      ["Energia cinética dos fragmentos", "60 J"],
      ["Energia dissipada", "40 J"],
    ]);
    expect(chooseSurvivingBodyId(extant, "earth", [collision])).toBe("f2");
  });

  it("labels creative black-hole capture radius separately from the horizon", () => {
    const capture: SimulationEvent = {
      ...event,
      type: "black-hole-capture",
      energyJ: 0,
      bodyIds: ["hole", "asteroid"],
      outcome: { kind: "creative-accretion", modelId: "creative-accretion-v1", captorBodyId: "hole", absorbedBodyId: "asteroid", captureRadiusM: 1_000_000 },
    };
    expect(describeSimulationEvent(capture)).toBe("Captura criativa por buraco negro.");
    expect(describeCollisionDetails(capture)).toEqual([
      ["Modelo", "Acreção criativa (v1)"],
      ["Zona de captura criativa", "1E6 m"],
      ["Horizonte do remanescente", "4 m"],
      ["Energia radiada", "0 J (não modelada)"],
    ]);
    expect(chooseSurvivingBodyId([body("hole")], "asteroid", [capture])).toBe("hole");
  });

  it("restores focus only when the action remains focused in the page", () => {
    const control = {} as Element;
    expect(shouldRestoreAcknowledgedControlFocus(control, control, true)).toBe(true);
    expect(shouldRestoreAcknowledgedControlFocus({} as Element, control, true)).toBe(false);
    expect(shouldRestoreAcknowledgedControlFocus(control, control, false)).toBe(false);
    expect(shouldRestoreAcknowledgedControlFocus(null, null, true)).toBe(false);
  });
});
