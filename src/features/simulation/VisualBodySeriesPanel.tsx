"use client";

import { memo, useState } from "react";
import type { VisualBodySeries, VisualBodySeriesSample } from "./visual-body-series";

const MAX_VISIBLE_SAMPLES_PER_BODY = 32;

const metrics = [
  { key: "massKg", label: "Massa", unit: "kg" },
  { key: "surfaceTemperatureK", label: "Temperatura de superfície", unit: "K" },
  { key: "distanceToBarycenterM", label: "Distância ao baricentro instantâneo", unit: "m" },
  { key: "kineticEnergyJ", label: "Energia cinética", unit: "J" },
] as const;

function display(value: number, unit: string) {
  return `${value.toLocaleString("pt-BR", { maximumSignificantDigits: 5 })} ${unit}`;
}

const VisualSeriesRow = memo(function VisualSeriesRow({ bodyId, retired, sample }: {
  bodyId: string;
  retired: boolean;
  sample: VisualBodySeriesSample;
}) {
  return <tr>
    <th scope="row">{bodyId}</th><td>{display(sample.timeSeconds, "s")}</td><td>{display(sample.massKg, "kg")}</td><td>{display(sample.surfaceTemperatureK, "K")}</td><td>{display(sample.distanceToBarycenterM, "m")}</td><td>{display(sample.kineticEnergyJ, "J")}</td><td>{retired ? "encerrado" : "acompanhado"}</td>
  </tr>;
});

const VisualBodySeriesContent = memo(function VisualBodySeriesContent({ series }: { series: readonly VisualBodySeries[] }) {
  return <>
    <p>Dados transitórios de snapshots aceitos. Energia cinética não é energia total.</p>
    {metrics.map((metric) => <section key={metric.key} aria-label={metric.label}>
      <h3>{metric.label}</h3>
      <div className="visual-series-charts">{series.map((track) => {
        const values = track.samples.map((sample) => sample[metric.key]);
        const minimum = Math.min(...values), maximum = Math.max(...values);
        const points = values.map((value, index) => `${values.length < 2 ? 50 : index / (values.length - 1) * 100},${95 - (maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum)) * 90}`).join(" ");
        return <figure key={track.bodyId}><figcaption>{track.bodyId}{track.retired ? " (encerrado)" : ""}</figcaption><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${track.bodyId}: gráfico de ${metric.label}`}><polyline points={points} /></svg></figure>;
      })}</div>
    </section>)}
    <table>
      <caption>Últimas {MAX_VISIBLE_SAMPLES_PER_BODY} amostras por astro; os gráficos mantêm a janela completa.</caption>
      <thead><tr><th scope="col">Alvo</th><th scope="col">Tempo simulado</th><th scope="col">Massa</th><th scope="col">Temperatura</th><th scope="col">Distância ao baricentro</th><th scope="col">Energia cinética</th><th scope="col">Estado</th></tr></thead>
      <tbody>{series.flatMap((track) => track.samples.slice(-MAX_VISIBLE_SAMPLES_PER_BODY).map((sample) => <VisualSeriesRow key={`${track.bodyId}-${sample.timeSeconds}`} bodyId={track.bodyId} retired={track.retired} sample={sample} />))}</tbody>
    </table>
  </>;
});

export function VisualBodySeriesPanel({ series }: { series: readonly VisualBodySeries[] }) {
  const [open, setOpen] = useState(false);
  if (!series.length) return null;
  return <details className="visual-body-series" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Séries visuais da sessão</summary>
    {open ? <VisualBodySeriesContent series={series} /> : null}
  </details>;
}
