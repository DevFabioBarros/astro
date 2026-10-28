"use client";

import { useCallback, useRef, useState } from "react";
import { SaveControls } from "@/features/simulation/SaveControls";
import type { AcceptedAutosaveSnapshot } from "@/features/simulation/local-autosave";
import { isSafeGravitationalConstant } from "@/simulation/physics";
import { isIntervalWithinSimulationBudget, SIMULATION_SPEEDS } from "@/simulation/simulation-time";
import { formatAstronomicalTime, NATURAL_GRAVITY } from "./astronomy-units";
import type { CelestialBody, CollisionMode, PhysicsSettings, SimulationEvent, SimulationSnapshot, SurfaceData, SwarmLedger, WorldHistorySummary } from "@/simulation/types";
import type { SimulationSaveData } from "@/simulation/save-file";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "@/simulation/world-seed";
import { SceneAudioControl, type SceneAudioControlProps } from "./scene-audio";

type SimulationToolbarProps = {
  status: SimulationSnapshot["status"];
  playDisabled?: boolean;
  simulationTimeSeconds: number;
  collisionMode?: CollisionMode;
  acceptedCollisionMode: CollisionMode;
  collisionModePending?: boolean;
  onCollisionModeChange: (mode: CollisionMode) => void;
  speedMultiplier: number;
  bodies: readonly CelestialBody[];
  settings: PhysicsSettings;
  environmentSeed?: number;
  acceptedAutosaveSnapshot: (AcceptedAutosaveSnapshot & { surfaceData?: SurfaceData }) | null;
  displayedSurfaceData?: SurfaceData;
  displayedSwarmLedger?: SwarmLedger;
  replacementPending?: boolean;
  onAutosaveAnnouncement?: (message: string) => void;
  onToggle: () => void;
  onSpeedChange: (speed: number) => void;
  onSettingsChange: (settings: PhysicsSettings, coalesceId?: string) => string | null;
  onReset: () => void;
  onImport: (data: SimulationSaveData) => void;
  speedLimited: boolean;
  history?: WorldHistorySummary;
  historyPending?: boolean;
  historyRestoring?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  latestEvent: SimulationEvent | null;
  latestEventDescription: string;
  latestEventDetails: [string, string][] | null;
  onViewEvent?: () => void;
  sceneAudio: SceneAudioControlProps;
};

const emptyHistory: WorldHistorySummary = { generation: 0, undoCheckpointId: null, redoCheckpointId: null, actionCount: 0, bytes: 0 };

export function SimulationToolbar({ status, playDisabled = false, simulationTimeSeconds, collisionMode = "scientific", acceptedCollisionMode, collisionModePending = false, onCollisionModeChange, speedMultiplier, bodies, settings, environmentSeed = DEFAULT_ENVIRONMENT_SEED_V1, acceptedAutosaveSnapshot, displayedSurfaceData, displayedSwarmLedger, replacementPending = false, onAutosaveAnnouncement, onToggle, onSpeedChange, onSettingsChange, onReset, onImport, speedLimited, history = emptyHistory, historyPending = false, historyRestoring = false, onUndo, onRedo, latestEvent, latestEventDescription, latestEventDetails, onViewEvent, sceneAudio }: SimulationToolbarProps) {
  const gravityCoalesceId = useRef<string | null>(null);
  const [gravityText, setGravityText] = useState<string | null>(null);
  const [gravityError, setGravityError] = useState("");
  const [autosaveAnnouncement, setAutosaveAnnouncement] = useState("");
  const announceAutosave = useCallback((message: string) => {
    if (onAutosaveAnnouncement) onAutosaveAnnouncement(message);
    else setAutosaveAnnouncement(message);
  }, [onAutosaveAnnouncement]);
  const gravityCoalesceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedOptions = SIMULATION_SPEEDS.filter(({ value }) => value <= 86_400).map((speed) => ({
    ...speed,
    unavailable: !isIntervalWithinSimulationBudget(bodies.length, speed.value * 0.025, speed.value <= 2_000 ? 1 : 3_600),
  }));
  const customSpeed = speedMultiplier <= 86_400 && speedMultiplier !== 1 / 60 && !speedOptions.some(({ value }) => value === speedMultiplier) ? speedMultiplier : null;
  const customSpeedLabel = customSpeed === null ? null : customSpeed >= 60 && customSpeed % 60 === 0 ? `${customSpeed / 60} min/s` : `${customSpeed} s/s`;
  const speedBudgetMessage = speedOptions.some(({ unavailable }) => unavailable)
    ? `Para ${bodies.length} astros, os presets desabilitados excedem o orçamento de integração em um tick de 25 ms.`
    : "";
  const displayedGravity = gravityText ?? String(Number((settings.gravitationalConstant / NATURAL_GRAVITY).toPrecision(8)));
  const commitGravity = () => {
    const value = Number(displayedGravity.replace(",", ".")) * NATURAL_GRAVITY;
    if (!displayedGravity.trim() || !isSafeGravitationalConstant(value)) {
      setGravityError("Use uma intensidade válida, a partir de zero.");
      return;
    }
    const error = onSettingsChange({ gravitationalConstant: value });
    setGravityError(error ?? "");
    if (!error) setGravityText(null);
  };
  const clearGravityCoalescing = () => {
    if (gravityCoalesceTimer.current) clearTimeout(gravityCoalesceTimer.current);
    gravityCoalesceTimer.current = null;
    gravityCoalesceId.current = null;
  };
  const endGravityKeySequence = () => {
    const id = gravityCoalesceId.current;
    if (!id) return;
    if (gravityCoalesceTimer.current) clearTimeout(gravityCoalesceTimer.current);
    gravityCoalesceTimer.current = setTimeout(() => {
      if (gravityCoalesceId.current === id) gravityCoalesceId.current = null;
      gravityCoalesceTimer.current = null;
    }, 300);
  };
  return <section className="transport" aria-label="Controles da simulação" data-simulation-status={status}>
    {!onAutosaveAnnouncement ? <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{autosaveAnnouncement}</span> : null}
    <button className="transport-play" type="button" onClick={onToggle} disabled={playDisabled} aria-label={status === "running" ? "Pausar" : "Retomar"}><span aria-hidden="true">{status === "running" ? "Ⅱ" : "▶"}</span><span>{status === "running" ? "Pausar" : "Retomar"}</span></button>
    <div className="transport-control"><label htmlFor="simulation-speed">Ritmo</label><select id="simulation-speed" aria-label="Passagem do tempo" aria-describedby={[speedBudgetMessage ? "speed-budget-hint" : "", speedLimited ? "speed-limited-hint" : ""].filter(Boolean).join(" ") || undefined} value={speedMultiplier} onChange={(event) => onSpeedChange(Number(event.target.value))}><option value={1 / 60}>1/60 s/s — tempo reduzido</option>{customSpeed !== null ? <option value={customSpeed}>{customSpeedLabel}</option> : null}{speedOptions.map(({ value, label, unavailable }) => <option key={value} value={value} disabled={unavailable}>{unavailable ? `${label} — indisponível: orçamento excedido` : label}</option>)}</select>{speedLimited ? <small id="speed-limited-hint" className="speed-limited-indicator">Ritmo adaptado</small> : null}{speedBudgetMessage ? <small id="speed-budget-hint">{speedBudgetMessage}</small> : null}</div>
    <div className="transport-time"><span>Tempo</span><strong>{formatAstronomicalTime(simulationTimeSeconds)}</strong></div>
    <button type="button" className="reset-system" aria-label="Reiniciar simulação" onClick={onReset}><span aria-hidden="true">↺</span> Reiniciar<span className="reset-label-wide"> simulação</span></button>
    <details className="transport-more" aria-busy={historyPending}>
      <summary aria-label="Mais controles">Mais</summary>
      <div className="transport-more-menu">
        <label className="transport-control collision-mode-control" aria-busy={collisionModePending}>Modo de colisão
          <select aria-describedby="collision-mode-help collision-mode-pending" disabled={collisionModePending} value={acceptedCollisionMode} onChange={(event) => onCollisionModeChange(event.currentTarget.value as CollisionMode)}>
            <option value="scientific">Física</option>
            <option value="creative">Criativa</option>
          </select>
          <span id="collision-mode-help">Física permite resultado de fusão do Core; Criativa gera fragmentos experimentais.</span>
          <span id="collision-mode-pending" role="status" aria-live="polite">{collisionModePending ? "Aguardando confirmação do Worker…" : ""}</span>
        </label>
        {historyRestoring ? <p role="status" aria-live="polite">Aguardando confirmação do Worker…</p> : null}
        <button type="button" aria-label="Desfazer ação" title="Desfazer ação" disabled={historyPending || !history.undoCheckpointId} onClick={onUndo}>Desfazer</button>
        <button type="button" aria-label="Refazer ação" title="Refazer ação" disabled={historyPending || !history.redoCheckpointId} onClick={onRedo}>Refazer</button>
        <SceneAudioControl {...sceneAudio} />
        <SaveControls bodies={bodies} settings={settings} environmentSeed={environmentSeed} simulationTimeSeconds={simulationTimeSeconds} collisionMode={collisionMode} acceptedSnapshot={acceptedAutosaveSnapshot} displayedSurfaceData={displayedSurfaceData} displayedSwarmLedger={displayedSwarmLedger} replacementPending={replacementPending} onAutosaveAnnouncement={announceAutosave} onImport={onImport} />
        {latestEvent ? <details className="latest-event-details"><summary>Último evento</summary><p>{latestEventDescription}</p><button className="event-view-button" type="button" onClick={() => onViewEvent?.()}>Ver acontecimento</button>{latestEventDetails ? <dl>{latestEventDetails.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}<p className="collision-visual-note">Efeito visual ilustrativo; não representa ejeção física.</p></details> : null}
        <details className="gravity-settings">
          <summary>Gravidade</summary>
          <div className="gravity-popover">
            <label className="transport-control gravity-control">Intensidade da gravidade (× natural)<input aria-describedby={gravityError ? "gravity-error" : "gravity-hint"} aria-invalid={Boolean(gravityError)} inputMode="decimal" onBlur={commitGravity} onChange={(event) => setGravityText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} value={displayedGravity} /></label>
            <input type="range" aria-label="Arrastar intensidade da gravidade" min="0" max="10" step="0.05" value={Math.min(10, settings.gravitationalConstant / NATURAL_GRAVITY)} onPointerDown={() => { clearGravityCoalescing(); gravityCoalesceId.current = `gravity:${crypto.randomUUID()}`; }} onPointerUp={clearGravityCoalescing} onPointerCancel={clearGravityCoalescing} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return; if (gravityCoalesceTimer.current) clearTimeout(gravityCoalesceTimer.current); gravityCoalesceTimer.current = null; gravityCoalesceId.current ??= `gravity:${crypto.randomUUID()}`; }} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) endGravityKeySequence(); }} onBlur={clearGravityCoalescing} onChange={(event) => { const error = onSettingsChange({ gravitationalConstant: Number(event.target.value) * NATURAL_GRAVITY }, gravityCoalesceId.current ?? undefined); setGravityError(error ?? ""); if (!error) setGravityText(null); }} />
            <p id="gravity-hint">1× é a gravidade natural. 0 desliga a atração.</p>
            {gravityError ? <span className="field-error" id="gravity-error" role="alert">{gravityError}</span> : null}
          </div>
        </details>
      </div>
    </details>
  </section>;
}
