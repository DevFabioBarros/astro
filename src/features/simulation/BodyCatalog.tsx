"use client";

import { useEffect, useRef, useState } from "react";
import { BODY_TEMPLATES } from "@/simulation/body-catalog";
import type { BodyType, CelestialBody } from "@/simulation/types";

type BodyCatalogProps = { bodies: readonly CelestialBody[]; onStartPlacement: (type: BodyType) => string | null; onClose: () => void };

export function shortBodyName(body: Pick<CelestialBody, "name">): string {
  if (/\s+fragmento\s+\d+$/i.test(body.name)) return "Detrito";
  if (/\s+\+\s+/.test(body.name)) return "Remanescente";
  return body.name;
}

export function BodyCatalog({ bodies, onStartPlacement, onClose }: BodyCatalogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const opener = document.activeElement;
    const catalog = panel.current;
    closeButton.current?.focus();
    return () => {
      const active = document.activeElement;
      if (opener instanceof HTMLElement && opener.isConnected && (active === document.body || catalog?.contains(active))) opener.focus();
    };
  }, []);
  return <section ref={panel} className="catalog-panel" role="dialog" aria-modal="false" aria-labelledby="catalog-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <header><div><h2 id="catalog-title">Criar astro</h2><p>{bodies.length >= 64 ? "Limite de 64 astros atingido." : "Escolha um tipo; clique no espaço para posicionar. Arraste para lançar."}</p></div><button ref={closeButton} type="button" aria-label="Fechar catálogo" onClick={onClose}>×</button></header>
    <div className="catalog-grid">{BODY_TEMPLATES.map((entry) => <button key={entry.type} type="button" className="catalog-option" disabled={bodies.length >= 64} onClick={() => { const problem = onStartPlacement(entry.type); setError(problem ?? ""); if (!problem) onClose(); }}><span className={`catalog-orb swatch-type-${entry.type} catalog-type-${entry.type}`} aria-hidden="true" /><span><strong>{entry.name}</strong><small>{entry.description}</small></span></button>)}</div>
    {error ? <p className="inspector-error" role="alert">{error}</p> : null}
  </section>;
}
