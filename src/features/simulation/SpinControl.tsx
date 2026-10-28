"use client";

import { useEffect, useState } from "react";
import type { CelestialBody, PendingWorldMutation, WorldMutation } from "@/simulation/types";
import { FULL_ROTATION_RADIANS, spinStateFromPeriodAtAcceptedTime, type SpinState } from "@/simulation/spin-model";

export type SpinMutationOutcome = {
  bodyId: string;
  mutationRevision: number;
  resolutionWorldRevision: number;
  status: "accepted" | "rejected" | "superseded";
  expectedSpin: SpinState | null;
  message?: string;
};

type SpinControlProps = {
  body: CelestialBody;
  acceptedSpin: SpinState | null;
  acceptedWorldRevision: number | null;
  outcome: SpinMutationOutcome | null;
  ready: boolean;
  editable: boolean;
  simulationTimeSeconds: number;
  pendingMutations: readonly PendingWorldMutation[];
  onSpinChange: (mutation: Extract<WorldMutation, { type: "SET_BODY_SPIN" }>) => string | null;
};

function draftsFor(spin: SpinState | null): { period: string; inclination: string } {
  if (!spin) return { period: "", inclination: "" };
  return {
    period: spin.angularVelocityRadPerS === 0 ? "0" : String(FULL_ROTATION_RADIANS / spin.angularVelocityRadPerS / 86400),
    inclination: String(Math.acos(Math.max(-1, Math.min(1, spin.axisUnitWorld[1]))) * 180 / Math.PI),
  };
}

function sameSpinConfiguration(left: SpinState | null, right: SpinState | null): boolean {
  if (left === null || right === null) return left === right;
  const velocityTolerance = Math.max(1e-30, Math.max(Math.abs(left.angularVelocityRadPerS), Math.abs(right.angularVelocityRadPerS)) * 1e-12);
  return Math.abs(left.angularVelocityRadPerS - right.angularVelocityRadPerS) <= velocityTolerance
    && left.axisUnitWorld.every((value, index) => Math.abs(value - right.axisUnitWorld[index]!) <= 1e-12);
}

function isZeroPeriodText(value: string): boolean {
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

export function SpinControl({ body, acceptedSpin, acceptedWorldRevision, outcome, ready, editable, simulationTimeSeconds, pendingMutations, onSpinChange }: SpinControlProps) {
  const acceptedDrafts = draftsFor(acceptedSpin);
  const [periodDraft, setPeriodDraft] = useState(acceptedDrafts.period);
  const [inclinationDraft, setInclinationDraft] = useState(acceptedDrafts.inclination);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = pendingMutations.some(({ mutation }) => mutation.type === "SET_BODY_SPIN" && mutation.bodyId === body.id);
  const periodDays = Number(periodDraft);
  const inclinationDeg = Number(inclinationDraft);
  const validPeriod = periodDraft.trim() !== "" && Number.isFinite(periodDays)
    && (periodDays === 0 ? isZeroPeriodText(periodDraft) : Math.abs(periodDays) >= 1e-9 && Math.abs(periodDays) <= 1e12);
  const validInclination = inclinationDraft.trim() !== "" && Number.isFinite(inclinationDeg) && inclinationDeg >= 0 && inclinationDeg <= 180;
  const validDraft = validPeriod && validInclination;
  const outcomeRevisionCurrent = outcome?.status === "rejected"
    ? acceptedWorldRevision !== null && acceptedWorldRevision <= outcome.resolutionWorldRevision
    : outcome?.resolutionWorldRevision === acceptedWorldRevision;
  const currentOutcome = outcome?.bodyId === body.id && outcomeRevisionCurrent ? outcome : null;
  const outcomeKey = currentOutcome ? `${currentOutcome.mutationRevision}:${currentOutcome.status}` : "";
  const outcomeMessage = currentOutcome?.message ?? "";
  const acceptedSpinSignature = acceptedSpin ? `${acceptedSpin.angularVelocityRadPerS}:${acceptedSpin.axisUnitWorld.join(":")}` : "none";

  useEffect(() => {
    if (pending) return;
    setPeriodDraft(acceptedDrafts.period);
    setInclinationDraft(acceptedDrafts.inclination);
    setActionError("");
    if (currentOutcome?.status === "superseded" && sameSpinConfiguration(acceptedSpin, currentOutcome.expectedSpin)) {
      setNotice(outcomeMessage || "Alteração sem confirmação; valores do snapshot aceito restaurados.");
    } else if (currentOutcome?.status === "rejected" && sameSpinConfiguration(acceptedSpin, currentOutcome.expectedSpin)) {
      setActionError(outcomeMessage || "O Worker recusou a rotação; os valores aceitos foram restaurados.");
    } else if (currentOutcome?.status === "accepted" && sameSpinConfiguration(acceptedSpin, currentOutcome.expectedSpin)) {
      setNotice("Rotação confirmada pelo snapshot aceito.");
    } else {
      setNotice("");
    }
  }, [body.id, acceptedDrafts.period, acceptedDrafts.inclination, acceptedSpinSignature, acceptedWorldRevision, outcomeKey, outcomeMessage, pending]);

  const describeDraftChange = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setActionError("");
    setNotice("");
  };
  const submit = (spin: SpinState | null) => {
    const error = onSpinChange({ type: "SET_BODY_SPIN", bodyId: body.id, spin });
    setActionError(error ?? "");
    setNotice("");
  };
  const apply = () => {
    if (!validDraft || pending || !ready || !editable) return;
    try {
      const spin = spinStateFromPeriodAtAcceptedTime({ periodDays, inclinationDeg, simulationTimeSeconds, ...(acceptedSpin ? { currentSpin: acceptedSpin } : {}) });
      submit(spin);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível definir a rotação.");
    }
  };
  const disabled = pending || !ready || !editable;
  const periodInvalid = periodDraft.trim() !== "" && !validPeriod;
  const inclinationInvalid = inclinationDraft.trim() !== "" && !validInclination;
  const describedBy = "spin-period-help spin-feedback";

  return <section className="inspector-control-group" aria-labelledby="spin-controls-title" aria-busy={pending || !ready}>
    <h3 id="spin-controls-title">Rotação física</h3>
    <p className="experiment-note">Período assinado em dias (0 = sem rotação); inclinação do eixo ao +Y do mundo. A fase avança com tempo simulado aceito.</p>
    {!ready ? <p role="status" aria-live="polite">Aguardando rotação aceita pelo Worker.</p> : null}
    {ready && !editable ? <p role="status">Rotação indisponível para membros de enxame físico.</p> : null}
    <div className="inspector-fields">
      <label htmlFor="spin-period-days">Período de rotação (dias)</label>
      <input id="spin-period-days" type="number" step="any" min="-1e12" max="1e12" value={periodDraft} onChange={(event) => describeDraftChange(setPeriodDraft)(event.target.value)} disabled={disabled} aria-invalid={periodInvalid || Boolean(actionError)} aria-describedby={describedBy} />
      <label htmlFor="spin-inclination-deg">Inclinação do eixo (°)</label>
      <input id="spin-inclination-deg" type="number" min="0" max="180" step="any" value={inclinationDraft} onChange={(event) => describeDraftChange(setInclinationDraft)(event.target.value)} disabled={disabled} aria-invalid={inclinationInvalid || Boolean(actionError)} aria-describedby="spin-inclination-help spin-feedback" />
    </div>
    <p id="spin-period-help">0 ou de ±1e-9 a ±1e12 dias; negativo indica rotação retrógrada.</p>
    <p id="spin-inclination-help">0° a 180°, medidos do eixo +Y do mundo.</p>
    <button type="button" onClick={apply} disabled={!validDraft || disabled}>{acceptedSpin ? "Aplicar rotação" : "Definir rotação física"}</button>
    {acceptedSpin ? <button type="button" onClick={() => submit(null)} disabled={disabled} aria-describedby="spin-feedback">Remover rotação física</button> : null}
    <p id="spin-feedback" role={actionError ? "alert" : "status"} aria-live={actionError ? "assertive" : "polite"}>
      {pending ? "Aguardando confirmação do Worker; valores ainda não aceitos." : actionError || notice || ""}
    </p>
  </section>;
}
