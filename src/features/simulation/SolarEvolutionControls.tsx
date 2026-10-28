"use client";

import { useState } from "react";
import type { CelestialBody } from "@/simulation/types";
import {
  getSolarEvolutionProperties,
  getSolarTrackKnotsBetween,
  SOLAR_EVOLUTION_END_AGE_YEARS,
  SOLAR_EVOLUTION_MODEL,
  SOLAR_EVOLUTION_START_AGE_YEARS,
  stellarLuminosityW,
  type SolarEvolutionStage,
} from "@/simulation/stellar-evolution";
import { formatMass } from "./astronomy-units";

type SolarEvolutionControlsProps = {
  body: CelestialBody;
  bodies: readonly CelestialBody[];
  evolutionRunning: boolean;
  evolutionPending: boolean;
  onInitialize: () => void;
  onAdvanceAge: (ageYears: number) => void;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onExitManual: () => void;
  mutationError: string;
};

const ASTRONOMICAL_UNIT_M = 149_597_870_700;
const SOLAR_REFERENCE = getSolarEvolutionProperties(SOLAR_EVOLUTION_START_AGE_YEARS);
const stageLabels: Record<SolarEvolutionStage, string> = {
  "main-sequence": "Sequência principal",
  "red-giant-branch": "Ramo das gigantes vermelhas",
  "core-helium-burning": "Queima de hélio no núcleo",
  "early-asymptotic-giant-branch": "Início do ramo assintótico das gigantes",
  "thermally-pulsing-asymptotic-giant-branch": "Ramo assintótico com pulsos térmicos",
  "post-asymptotic-giant-branch": "Após o ramo assintótico",
  "white-dwarf-formation": "Início da formação da anã branca",
};
const solarMilestones = getSolarTrackKnotsBetween(
  SOLAR_EVOLUTION_START_AGE_YEARS,
  SOLAR_EVOLUTION_END_AGE_YEARS,
).filter((sample) => sample.primaryEep !== undefined);

const formatNumber = (value: number, maximumFractionDigits = 2) => value.toLocaleString("pt-BR", { maximumFractionDigits });
const formatAge = (ageYears: number) => `${formatNumber(ageYears / 1e9, 3)} Gyr`;

export function SolarEvolutionControls({ body, bodies, evolutionRunning, evolutionPending, onInitialize, onAdvanceAge, onStart, onPause, onReset, onExitManual, mutationError }: SolarEvolutionControlsProps) {
  const metadata = body.stellarEvolution;
  const ageYears = metadata?.ageYears ?? null;
  const [ageControls, setAgeControls] = useState({ acceptedAge: ageYears, error: mutationError, requestedAge: ageYears, pending: false, submittedAge: null as number | null });
  if (ageControls.acceptedAge !== ageYears || ageControls.error !== mutationError) {
    const acceptedAge = ageYears ?? SOLAR_EVOLUTION_START_AGE_YEARS;
    setAgeControls({ acceptedAge: ageYears, error: mutationError, requestedAge: acceptedAge, pending: false, submittedAge: null });
  }
  if (body.id !== "sun" || body.kind !== "star") return null;
  if (body.bodyType === "black-hole" && !metadata) {
    return <p className="experiment-note">O modelo MIST de 1 M☉ não se aplica a este buraco negro.</p>;
  }

  const hasSolarModel = metadata?.modelId === SOLAR_EVOLUTION_MODEL.id && metadata.modelVersion === SOLAR_EVOLUTION_MODEL.version;
  const track = hasSolarModel && metadata.mode === "secular"
    ? getSolarEvolutionProperties(metadata.ageYears, metadata.accretedMassKg)
    : null;
  const effectiveTemperatureK = body.surfaceTemperatureK;
  const luminosityW = stellarLuminosityW(body);
  const luminositySolar = luminosityW / SOLAR_REFERENCE.luminosityW;
  const radiusSolar = body.radiusM / SOLAR_REFERENCE.radiusM;
  const fluxAtOneAu = luminosityW / (4 * Math.PI * ASTRONOMICAL_UNIT_M ** 2);
  const isManual = hasSolarModel && metadata.mode === "manual";
  const agePending = ageControls.pending;
  const requestedAge = ageControls.requestedAge;
  const requestAge = (targetAgeYears: number) => {
    if (ageControls.submittedAge === targetAgeYears) return;
    setAgeControls((current) => ({ ...current, requestedAge: targetAgeYears, pending: true, submittedAge: targetAgeYears }));
    onAdvanceAge(targetAgeYears);
  };
  const commitRequestedAge = () => {
    const targetAgeYears = ageControls.requestedAge;
    if (targetAgeYears !== null && targetAgeYears !== ageYears && ageControls.submittedAge !== targetAgeYears) requestAge(targetAgeYears);
  };
  const futureMilestones = track ? solarMilestones.filter(({ ageYears: milestoneAge }) => milestoneAge > track.ageYears) : [];
  const status = isManual
    ? "Modo manual. A trilha evolutiva está interrompida."
    : track
      ? evolutionRunning ? "Evolução ativa. O movimento orbital está pausado." : "Evolução pausada."
      : "Modelo solar ainda não iniciado.";

  return (
    <details className="advanced-controls" open>
      <summary>Evolução do Sol</summary>
      <p role="status" aria-live="polite">{agePending ? "Aguardando confirmação do Worker; as propriedades mostradas ainda são do último snapshot aceito." : evolutionPending ? "Aguardando confirmação do estado do relógio pelo Worker." : status}</p>
      <dl className="object-facts">
        <div><dt>Estágio</dt><dd>{track ? stageLabels[track.stage] : isManual ? "Experimento manual" : "Sem modelo evolutivo"}</dd></div>
        <div><dt>Massa</dt><dd>{formatMass(body.massKg)}</dd></div>
        <div><dt>Raio (R☉)</dt><dd>{formatNumber(radiusSolar)}</dd></div>
        <div><dt>Luminosidade (L☉)</dt><dd>{formatNumber(luminositySolar)}</dd></div>
        <div><dt>Teff</dt><dd>{formatNumber(effectiveTemperatureK, 0)} K</dd></div>
        <div><dt>Fluxo bolométrico a 1 UA</dt><dd>{formatNumber(fluxAtOneAu)} W/m²</dd></div>
      </dl>

      {ageYears !== null ? <p>{isManual ? "Última idade da trilha" : "Idade evolutiva"}: {formatAge(ageYears)}</p> : null}
      {track && !evolutionRunning && track.ageYears < SOLAR_EVOLUTION_END_AGE_YEARS ? <div className="drag-control">
        <div className="drag-heading"><label htmlFor="solar-evolution-age">Avançar idade</label><output htmlFor="solar-evolution-age">{formatAge(track.ageYears)}</output></div>
        <input
          id="solar-evolution-age"
          type="range"
          aria-label="Idade da evolução solar"
          aria-valuetext={formatAge(track.ageYears)}
          aria-describedby="solar-evolution-age-hint"
          min={track.ageYears}
          max={SOLAR_EVOLUTION_END_AGE_YEARS}
          step="any"
          value={requestedAge ?? track.ageYears}
          disabled={agePending || evolutionPending}
          onChange={(event) => {
            const requested = Number(event.currentTarget.value);
            setAgeControls((current) => ({ ...current, requestedAge: requested }));
          }}
          onPointerUp={commitRequestedAge}
          onKeyUp={commitRequestedAge}
          onBlur={commitRequestedAge}
        />
        <p id="solar-evolution-age-hint">A idade avança na trilha MIST. O relógio orbital permanece pausado.</p>
        {futureMilestones.length > 0 ? <details className="advanced-controls">
          <summary>Marcos fornecidos pelo modelo</summary>
          <div className="mass-shortcuts solar-milestones">
            {futureMilestones.map(({ ageYears: milestoneAge, stage }, index) => (
              <button key={`${milestoneAge}-${index}`} type="button" disabled={agePending || evolutionPending} onClick={() => requestAge(milestoneAge)} aria-label={`Avançar até ${stageLabels[stage]}, ${formatAge(milestoneAge)}`}>
                {stageLabels[stage]} · {formatAge(milestoneAge)}
              </button>
            ))}
          </div>
        </details> : null}
      </div> : null}

      <div className="body-actions">
        {!metadata ? <button type="button" className="add-planet" disabled={evolutionPending} onClick={onInitialize}>Iniciar modelo solar</button> : null}
        {track && !evolutionRunning && track.ageYears < SOLAR_EVOLUTION_END_AGE_YEARS ? <button type="button" className="add-planet" disabled={agePending || evolutionPending} onClick={onStart}>Iniciar evolução</button> : null}
        {evolutionRunning ? <button type="button" className="transport-play" disabled={evolutionPending} onClick={onPause}>Pausar evolução</button> : null}
        {track ? <button type="button" className="remove-body" disabled={evolutionRunning || evolutionPending} onClick={onExitManual}>Sair da evolução para editar</button> : null}
        <button type="button" className="remove-body" onClick={onReset} aria-label={`Reset Solar. Substitui todo o sistema atual de ${bodies.length} astros pelo preset.`}>
          Reset Solar · substitui todo o sistema
        </button>
      </div>

      {track ? <p className="experiment-note">A evolução secular aproxima mudanças baricêntricas; não representa as fases nem a posição real das órbitas ao longo de Gyr. A absorção por contato é geométrica e aproximada.</p> : null}
      {track?.stage === "white-dwarf-formation" ? <p className="experiment-note">Este ponto marca o início da formação da anã branca. A trilha não modela seu resfriamento.</p> : null}
      <p className="experiment-note">Fonte: <a href={SOLAR_EVOLUTION_MODEL.sourceUrl} target="_blank" rel="noreferrer">trilha MIST 1 M☉</a>, domínio {formatAge(SOLAR_EVOLUTION_START_AGE_YEARS)}–{formatAge(SOLAR_EVOLUTION_END_AGE_YEARS)}. Não há intervalo de incerteza calculado na interface; fora da faixa não há extrapolação.</p>
      <p className="experiment-note">O fluxo bolométrico a 1 UA é uma estimativa geométrica; não calcula clima.</p>
    </details>
  );
}
