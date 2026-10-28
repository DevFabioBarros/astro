import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import type { PendingWorldMutation } from "@/simulation/types";
import { SpinControl } from "./SpinControl";

const earth = createSolarSystem().find(({ id }) => id === "earth")!;

it("does not infer a legacy period or inclination and requires an explicit edit", () => {
  const markup = renderToStaticMarkup(createElement(SpinControl, { body: earth, simulationTimeSeconds: 12_345,
    acceptedSpin: null, acceptedWorldRevision: 1, outcome: null, ready: true, editable: true,
    pendingMutations: [], onSpinChange: vi.fn() }));
  expect(markup).toContain('id="spin-period-days" type="number" step="any" value=""');
  expect(markup).toContain('id="spin-inclination-deg" type="number" min="0" max="180" step="any" value=""');
  expect(markup).toContain('disabled=""');
  expect(markup).toContain("Sem dados de rotação legados inferidos.");
  expect(markup).not.toContain("Remover rotação física");
});

it("shows accepted spin as period/inclination and disables edits while pending", () => {
  const body = { ...earth, spin: { modelId: "rigid-body-spin-v1" as const, axisUnitWorld: [0, Math.SQRT1_2, Math.SQRT1_2] as const,
    phaseAtEpochRad: 0, angularVelocityRadPerS: -Math.PI / 86400 } };
  const pending: PendingWorldMutation[] = [{ revision: 2, mutation: { type: "SET_BODY_SPIN", bodyId: earth.id, spin: body.spin } }];
  const markup = renderToStaticMarkup(createElement(SpinControl, { body, simulationTimeSeconds: 100,
    acceptedSpin: body.spin, acceptedWorldRevision: 1, outcome: null, ready: true, editable: true,
    pendingMutations: pending, onSpinChange: vi.fn() }));
  expect(markup).toContain('value="-2"');
  expect(markup).toContain('value="45"');
  expect(markup).toContain("Aguardando confirmação da rotação.");
  expect(markup).toContain("Remover rotação física");
});
