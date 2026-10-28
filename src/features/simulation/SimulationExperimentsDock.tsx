"use client";

import { useEffect, useRef } from "react";
import type { CelestialBody } from "@/simulation/types";
import { OrbitalPlacementControls } from "./OrbitalPlacementControls";
import type { BoundOrbitalPreview, OrbitalPlacementIntent } from "./OrbitalPlacementControls";
import type { OrbitalPlacementMutation } from "@/simulation/types";
import { EXPERIMENT_SCENARIOS } from "@/simulation/experiment-presets";
import type { ExperimentId as ScenarioId } from "@/simulation/experiment-presets";

export { createExperimentPreset } from "@/simulation/experiment-presets";
export type { ExperimentId, ExperimentPreset } from "@/simulation/experiment-presets";

type SimulationExperimentsDockProps = {
  selectedBody: CelestialBody | undefined;
  bodies: readonly CelestialBody[];
  selectedBodyIds: readonly string[];
  gravitationalConstant: number;
  collisionMode: "scientific" | "creative";
  busy: boolean;
  scenarioBusy: boolean;
  canExplode: boolean;
  canDuplicate: boolean;
  activeExperiment: ScenarioId | null;
  onCreate: () => void;
  onDuplicate: () => void;
  onDisintegrate: () => void;
  onEditProperties: () => void;
  onRunExperiment: (id: ScenarioId) => void;
  onResetExperiment: () => void;
  orbitalPlacement?: OrbitalPlacementIntent | null;
  orbitalPreview?: BoundOrbitalPreview | null;
  orbitalPreviewState?: "idle" | "scheduled" | "calculating" | "unavailable";
  onStartOrbitalPlacement?: (mutation: OrbitalPlacementMutation) => void;
  onDraftOrbitalMutation?: (mutation: OrbitalPlacementMutation | null) => void;
  onCancelOrbitalPlacement?: () => void;
  onConfirmOrbitalPlacement?: (mutation: OrbitalPlacementMutation, requestId: number) => void;
};

function ScenarioThumbnail({ id }: { id: ScenarioId }) {
  return <svg className="experiment-scenario-art" viewBox="0 0 120 64" aria-hidden="true" focusable="false">
    {id === "binary-stars" ? <>
      <ellipse cx="60" cy="32" rx="37" ry="15" fill="none" stroke="#6b93b0" strokeWidth="1.2" />
      <circle cx="42" cy="32" r="8" fill="#f2bb67" /><circle cx="78" cy="32" r="8" fill="#b5d9ea" />
      <path d="M31 15 25 12M89 49l6 3" stroke="#d9e6ef" strokeWidth="1.5" />
    </> : null}
    {id === "earth-mars" ? <>
      <path d="M22 32h76" stroke="#e7b766" strokeWidth="1.5" strokeDasharray="3 4" />
      <circle cx="27" cy="32" r="12" fill="#458bb2" /><path d="M20 29q5-8 11-3l3 6-7 8-7-3z" fill="#72b98d" />
      <circle cx="93" cy="32" r="8" fill="#d77d59" /><path d="M82 27h-5m0 0 4-3m-4 3 4 3" stroke="#f1d0a4" strokeWidth="1.5" />
    </> : null}
    {id === "black-hole" ? <>
      <ellipse cx="58" cy="34" rx="32" ry="9" fill="none" stroke="#e7a75f" strokeWidth="4" opacity=".75" transform="rotate(-12 58 34)" />
      <circle cx="58" cy="32" r="11" fill="#02050c" stroke="#9bb5c5" strokeWidth="1" />
      <circle cx="99" cy="18" r="4" fill="#c7d8e5" /><path d="m95 22-12 5" stroke="#d7a860" strokeWidth="1.3" />
    </> : null}
    {id === "extreme-sun" ? <>
      <circle cx="60" cy="32" r="16" fill="#f4b858" opacity=".25" /><circle cx="60" cy="32" r="10" fill="#ffd46e" />
      <ellipse cx="60" cy="32" rx="43" ry="19" fill="none" stroke="#71889d" strokeWidth="1" />
      <circle cx="100" cy="27" r="3.5" fill="#82b9cf" /><path d="M60 7v-4M60 57v4M35 13l-3-3m56 39 3 3" stroke="#f2b85c" />
    </> : null}
    {id === "eclipse" ? <>
      <circle cx="35" cy="32" r="16" fill="#f1b75c" /><circle cx="71" cy="32" r="11" fill="#4d9bb9" />
      <path d="M65 26q6-6 12 0l3 7-8 7-7-4z" fill="#73b58b" />
      <circle cx="94" cy="32" r="4" fill="#d4e2e8" /><path d="M52 32h36" stroke="#f5ddaa" strokeWidth="1" strokeDasharray="2 3" />
    </> : null}
    {id === "displaced-moon" ? <>
      <circle cx="47" cy="34" r="13" fill="#438bb1" /><path d="M39 32q5-8 10-4l3 7-7 7-6-4z" fill="#77b88e" />
      <ellipse cx="50" cy="34" rx="42" ry="21" fill="none" stroke="#658aa2" strokeWidth="1" />
      <circle cx="91" cy="34" r="5" fill="#d3dbe0" /><circle cx="22" cy="15" r="1" fill="#c7d9e2" />
    </> : null}
    {id === "oblique-impact" ? <>
      <path d="M21 50 95 15" stroke="#e8b46b" strokeWidth="1.5" strokeDasharray="3 4" />
      <circle cx="36" cy="42" r="11" fill="#438bb1" /><path d="M29 40q5-8 10-4l3 7-7 6-6-3z" fill="#77b88e" />
      <circle cx="82" cy="22" r="8" fill="#d77d59" /><path d="m73 25-6 3m0 0 4-4m-4 4 5 2" stroke="#f1d0a4" strokeWidth="1.4" />
    </> : null}
  </svg>;
}

export function SimulationExperimentsDock({ selectedBody, bodies, selectedBodyIds, gravitationalConstant, collisionMode, busy, scenarioBusy, canExplode, canDuplicate, activeExperiment, onCreate, onDuplicate, onDisintegrate, onEditProperties, onRunExperiment, onResetExperiment, orbitalPlacement = null, orbitalPreview = null, orbitalPreviewState = "idle", onStartOrbitalPlacement, onDraftOrbitalMutation, onCancelOrbitalPlacement, onConfirmOrbitalPlacement }: SimulationExperimentsDockProps) {
  const examplesRef = useRef<HTMLDetailsElement>(null);
  const toolsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!orbitalPlacement && !orbitalPreview) return;
    examplesRef.current?.setAttribute("open", "");
    toolsRef.current?.setAttribute("open", "");
  }, [orbitalPlacement, orbitalPreview]);
  const closeScenarios = () => {
    const focusWasInside = examplesRef.current?.contains(document.activeElement) ?? false;
    toolsRef.current?.removeAttribute("open");
    examplesRef.current?.removeAttribute("open");
    if (focusWasInside) examplesRef.current?.querySelector("summary")?.focus();
  };
  const runScenario = (id: ScenarioId) => { closeScenarios(); onRunExperiment(id); };
  const resetScenario = () => { closeScenarios(); onResetExperiment(); };
  const primaryScenarios = EXPERIMENT_SCENARIOS.filter(({ id }) => id === "earth-mars" || id === "black-hole");
  const otherScenarios = EXPERIMENT_SCENARIOS.filter(({ id }) => id !== "earth-mars" && id !== "black-hole");
  return <section className="experiment-dock" aria-label="Experimentos">
    <div className="experiment-primary-actions" aria-label="Experiências em destaque">
      {primaryScenarios.map((scenario) => {
        const isActive = activeExperiment === scenario.id;
        const title = scenario.id === "earth-mars" ? "Impacto Terra–Marte" : "Buraco negro";
        const subtitle = scenario.id === "earth-mars" ? "Choque entre planetas" : "Captura de um asteroide";
        return <article className="experiment-primary-card" data-active={isActive || undefined} key={scenario.id}>
          <button type="button" className="experiment-primary-action" disabled={scenarioBusy} aria-label={`${isActive ? "Executar novamente" : "Iniciar"}: ${title}`} aria-pressed={isActive} onClick={() => runScenario(scenario.id)}>
            <ScenarioThumbnail id={scenario.id} />
            <span className="experiment-primary-copy"><strong>{title}</strong><small>{subtitle}</small></span>
          </button>
          {isActive ? <div className="experiment-primary-active"><span>Ativo</span><button type="button" disabled={scenarioBusy} aria-label={`Reiniciar exemplo: ${title}`} onClick={resetScenario}>Reiniciar</button></div> : null}
        </article>;
      })}
    </div>
    <details ref={examplesRef} className="experiment-explanation experiment-scenario-panel">
      <summary>Mais experiências</summary>
      <div className="experiment-scenario-content">
        <button type="button" className="experiment-scenario-close" onClick={closeScenarios}>Fechar</button>
        <p className="experiment-scenario-intro">Outros cenários e ferramentas.</p>
        <div className="experiment-scenario-list" aria-label="Cenas prontas">
          {otherScenarios.map((scenario) => {
            const isActive = activeExperiment === scenario.id;
            return <article className="experiment-scenario-card" data-scenario={scenario.id} data-active={isActive || undefined} key={scenario.id}>
              <div className="experiment-scenario-heading">
                <ScenarioThumbnail id={scenario.id} />
                <div className="experiment-scenario-copy">
                  <h3>{scenario.title}</h3>
                  <p>{scenario.description}</p>
                </div>
              </div>
              <div className="experiment-scenario-meta">
                <span>Tempo esperado: {scenario.expectedDuration}</span>
                {isActive ? <span className="experiment-scenario-active">Ativo</span> : null}
              </div>
              <div className="experiment-scenario-actions">
                <button type="button" disabled={scenarioBusy} aria-label={`Iniciar ${scenario.title}`} aria-pressed={isActive} onClick={() => runScenario(scenario.id)}>{isActive ? "Executar novamente" : "Iniciar"}</button>
                {isActive ? <button type="button" disabled={scenarioBusy} aria-label={`Reiniciar exemplo: ${scenario.title}`} onClick={resetScenario}>Reiniciar</button> : null}
              </div>
              <details className="experiment-scenario-details">
                <summary>Detalhes técnicos</summary>
                <p>{scenario.technicalDetails}</p>
              </details>
            </article>;
          })}
        </div>
        <details ref={toolsRef} className="experiment-tools-panel">
          <summary>Ferramentas</summary>
          <div className="experiment-actions">
            <button type="button" disabled={busy} onClick={() => { closeScenarios(); onCreate(); }} aria-label="Criar astro livre">
              <span aria-hidden="true">＋</span><span><strong>Criar astro</strong></span>
            </button>
            <button type="button" disabled={busy || !selectedBody || !canDuplicate} onClick={() => { closeScenarios(); onDuplicate(); }} aria-label={`Duplicar ${selectedBody?.name ?? "astro selecionado"}`} title={`Duplicar ${selectedBody?.name ?? "astro selecionado"}`}>
              <span aria-hidden="true">⧉</span><span><strong>Duplicar</strong></span>
            </button>
            <button type="button" className="disintegrate-action" disabled={busy || !canExplode} onClick={() => { closeScenarios(); onDisintegrate(); }} aria-label={`Explodir ${selectedBody?.name ?? "astro selecionado"}`} title={`Explodir ${selectedBody?.name ?? "astro selecionado"}`}>
              <span aria-hidden="true">✹</span><span><strong>Explodir</strong></span>
            </button>
            <button type="button" disabled={busy || !selectedBody} onClick={() => { closeScenarios(); onEditProperties(); }} aria-label={`Editar massa e propriedades de ${selectedBody?.name ?? "astro selecionado"}`} title={`Editar massa e propriedades de ${selectedBody?.name ?? "astro selecionado"}`}>
              <span aria-hidden="true">◉</span><span><strong>Massa</strong></span>
            </button>
            <span className={`sandbox-indicator${collisionMode === "creative" ? " is-ready" : ""}`} aria-label={collisionMode === "creative" ? "Sandbox criativa ativa" : "Colisões em modo científico"}>
              <i aria-hidden="true" />{collisionMode === "creative" ? "Sandbox criativa" : "Colisões físicas"}
            </span>
          </div>
          <OrbitalPlacementControls bodies={bodies} selectedBodyIds={selectedBodyIds} gravitationalConstant={gravitationalConstant} disabled={busy} orbitalPlacement={orbitalPlacement} orbitalPreview={orbitalPreview} orbitalPreviewState={orbitalPreviewState} onStartPlacement={onStartOrbitalPlacement} onDraftMutation={onDraftOrbitalMutation} onCancelPlacement={onCancelOrbitalPlacement} onConfirmPlacement={onConfirmOrbitalPlacement} />
        </details>
        <details className="experiment-scenario-details experiment-scenario-limits">
          <summary>Limites do sandbox</summary>
          <p>As cenas substituem o universo atual. Reiniciar simulação restaura o Sistema Solar.</p>
          <p>Partículas são efeitos visuais; não representam ejeção física. O disco do buraco negro é ampliado por arte.</p>
          <p>O motor limita a aceleração a 1.000.000 m/s². Se uma criação for recusada, afaste a câmera.</p>
        </details>
      </div>
    </details>
  </section>;
}
