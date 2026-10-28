import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const controlCapture = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./OrbitalPlacementControls", () => ({ OrbitalPlacementControls: (props: Record<string, unknown>) => { controlCapture.props = props; return null; } }));
import { createExperimentPreset, SimulationExperimentsDock } from "./SimulationExperimentsDock";

describe("simulation experiment presets", () => {
  it("starts an Earth–Mars collision with a four-second contact window", () => {
    const preset = createExperimentPreset("earth-mars");
    const earth = preset.bodies.find(({ id }) => id === "earth")!;
    const mars = preset.bodies.find(({ id }) => id === "mars")!;
    const gap = Math.hypot(...earth.positionM.map((value, axis) => value - mars.positionM[axis]!)) - earth.radiusM - mars.radiusM;
    const relativeSpeed = Math.hypot(...earth.velocityMs.map((value, axis) => value - mars.velocityMs[axis]!));

    expect(preset.bodies.map(({ id }) => id)).toEqual(["earth", "mars"]);
    expect(relativeSpeed).toBeCloseTo(50_000, 6);
    expect(gap / relativeSpeed / preset.speed).toBeCloseTo(4, 0);
    expect(preset.collisionMode).toBe("creative");
  });

  it("builds a guarded creative black-hole capture scene", () => {
    const preset = createExperimentPreset("black-hole");
    const hole = preset.bodies.find(({ bodyType }) => bodyType === "black-hole")!;
    const intruder = preset.bodies.find(({ id }) => id === "capture-asteroid")!;
    const distance = Math.hypot(...hole.positionM.map((value, axis) => value - intruder.positionM[axis]!));

    expect(preset.settings.gravitationalConstant).toBe(0);
    expect(distance).toBeGreaterThan(hole.radiusM * 100);
    expect(intruder.velocityMs[0]).toBeLessThan(0);
    expect(preset.collisionMode).toBe("creative");
  });

  it("makes the Sun visibly extreme without changing its identity", () => {
    const preset = createExperimentPreset("extreme-sun");
    const sun = preset.bodies.find(({ id }) => id === "sun")!;
    expect(sun.massKg).toBeGreaterThan(5e30);
    expect(sun.radiusM).toBeGreaterThan(1e9);
    expect(sun.surfaceTemperatureK).toBeGreaterThan(8_000);
    expect(preset.selectedBodyId).toBe("sun");
  });

  it("passes the current orbital draft, preview, and lifecycle callbacks to placement controls", () => {
    const body = { id: "earth", name: "Terra", kind: "planet" as const, massKg: 6e24, radiusM: 6e6,
      positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 };
    const mutation = { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 4e8,
      planeNormal: [0, 0, 1] as const, radialDirection: [1, 0, 0] as const };
    const intent = { mutation, worldRevision: 3, baseTimeSeconds: 42 };
    const preview = { response: { type: "ORBITAL_MUTATION_PREVIEW" as const, version: 1 as const, requestId: 9,
      worldRevision: 3, baseTimeSeconds: 42, result: { status: "ready" as const, candidates: [] } }, mutation };
    const callbacks = { onStartOrbitalPlacement: vi.fn(), onDraftOrbitalMutation: vi.fn(),
      onCancelOrbitalPlacement: vi.fn(), onConfirmOrbitalPlacement: vi.fn() };
    controlCapture.props = null;
    renderToStaticMarkup(createElement(SimulationExperimentsDock, {
      selectedBody: body, bodies: [body], selectedBodyIds: [body.id], gravitationalConstant: 6.6743e-11,
      collisionMode: "scientific", busy: false, scenarioBusy: false, canExplode: true, canDuplicate: true, activeExperiment: null,
      onCreate: vi.fn(), onDuplicate: vi.fn(), onDisintegrate: vi.fn(), onEditProperties: vi.fn(),
      onRunExperiment: vi.fn(), onResetExperiment: vi.fn(), orbitalPlacement: intent, orbitalPreview: preview, ...callbacks,
    }));

    expect(controlCapture.props).toMatchObject({ orbitalPlacement: intent, orbitalPreview: preview,
      onStartPlacement: callbacks.onStartOrbitalPlacement, onDraftMutation: callbacks.onDraftOrbitalMutation,
      onCancelPlacement: callbacks.onCancelOrbitalPlacement, onConfirmPlacement: callbacks.onConfirmOrbitalPlacement });
  });
});
