"use client";

import { useState } from "react";
import { formatPhysicalMeasure } from "./astronomy-units";
import { GREY_ALBEDO_LASER_PROFILE_ID, MAX_LASER_DURATION_SECONDS, MAX_LASER_ENERGY_J, MAX_LASER_POWER_W } from "@/simulation/laser-model";
import type { CelestialBody, LaserAimConfiguration } from "@/simulation/types";

type LaserDraft = { powerW: number; durationAcceptedSeconds: number };
type Props = {
  body: CelestialBody;
  laserAim: LaserAimConfiguration | null;
  disabled: boolean;
  onStartAim: (aim: LaserAimConfiguration) => string | null;
  onCancelAim: () => void;
};

export function parseLaserDraft(powerDraft: string, durationDraft: string): LaserDraft | null {
  const powerW = Number(powerDraft.trim().replace(",", "."));
  const durationAcceptedSeconds = Number(durationDraft.trim().replace(",", "."));
  const inputJ = powerW * durationAcceptedSeconds;
  if (!Number.isFinite(powerW) || powerW <= 0 || powerW > MAX_LASER_POWER_W
    || !Number.isFinite(durationAcceptedSeconds) || durationAcceptedSeconds <= 0 || durationAcceptedSeconds > MAX_LASER_DURATION_SECONDS
    || !Number.isFinite(inputJ) || inputJ <= 0 || inputJ > MAX_LASER_ENERGY_J) return null;
  return { powerW, durationAcceptedSeconds };
}

export function LaserControls({ body, laserAim, disabled, onStartAim, onCancelAim }: Props) {
  const [powerDraft, setPowerDraft] = useState("");
  const [durationDraft, setDurationDraft] = useState("");
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState("");
  const draft = parseLaserDraft(powerDraft, durationDraft);
  const aiming = laserAim?.bodyId === body.id;
  const beginAim = () => {
    if (!draft || profileId !== GREY_ALBEDO_LASER_PROFILE_ID) return;
    const errorMessage = onStartAim({ bodyId: body.id, ...draft, profileId: GREY_ALBEDO_LASER_PROFILE_ID });
    setError(errorMessage ?? "");
  };

  return <details className="advanced-controls laser-controls">
    <summary>Laser visual</summary>
    <p className="experiment-note">Somente mancha visual; não altera surfaceTemperatureK nem o T10.</p>
    {!body.materials ? <p className="experiment-note">Composição material explícita obrigatória; nenhum perfil é presumido para corpos legacy.</p> : <>
      <fieldset disabled={disabled || aiming}>
      <legend>Feixe visual no astro selecionado</legend>
      <label htmlFor="laser-power">Potência do feixe <small>W</small></label>
      <input id="laser-power" type="text" inputMode="decimal" value={powerDraft} aria-label="Potência do laser em watts"
        onChange={(event) => { setError(""); setPowerDraft(event.target.value); }} />
      <label htmlFor="laser-duration">Duração simulada aceita <small>s</small></label>
      <input id="laser-duration" type="text" inputMode="decimal" value={durationDraft} aria-label="Duração aceita do laser em segundos"
        onChange={(event) => { setError(""); setDurationDraft(event.target.value); }} />
      <label htmlFor="laser-profile">Perfil fechado</label>
      <select id="laser-profile" value={profileId} onChange={(event) => { setError(""); setProfileId(event.target.value); }}>
        <option value="">Selecione um perfil explícito</option>
        <option value={GREY_ALBEDO_LASER_PROFILE_ID}>{GREY_ALBEDO_LASER_PROFILE_ID}</option>
      </select>
      <p className="experiment-note">Albedo fixo 0,30. Limites: {formatPhysicalMeasure(MAX_LASER_POWER_W)} W, {MAX_LASER_DURATION_SECONDS} s, {formatPhysicalMeasure(MAX_LASER_ENERGY_J)} J.</p>
      {!aiming ? <button type="button" disabled={!draft || !profileId || disabled} onClick={beginAim}>Apontar laser</button> : null}
      </fieldset>
      {aiming ? <>
        <p role="status" aria-live="polite">Mira ativa em {body.name}. Clique na superfície do astro para emitir um disparo visual.</p>
        <button type="button" onClick={onCancelAim}>Cancelar mira do laser</button>
      </> : null}
      <p className="inspector-error" role="alert">{error}</p>
    </>}
  </details>;
}
