import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { VisualBodySeriesPanel } from "./VisualBodySeriesPanel";

it("keeps session charts collapsed by default and exposes accessible kinetic-energy values", () => {
  const markup = renderToStaticMarkup(createElement(VisualBodySeriesPanel, { series: [{ bodyId: "earth", retired: true,
    samples: [
      { timeSeconds: 5, massKg: 5, surfaceTemperatureK: 288, distanceToBarycenterM: 12, kineticEnergyJ: 40 },
      { timeSeconds: 10, massKg: 5, surfaceTemperatureK: 288, distanceToBarycenterM: 12, kineticEnergyJ: 42 },
    ] }] }));

  expect(markup).toContain("Séries visuais da sessão");
  expect(markup).toContain("Dados transitórios de snapshots aceitos");
  expect(markup).toContain("Energia cinética");
  expect(markup).toContain("42 J");
  expect(markup).toContain("40 J");
  expect(markup).toContain("5 s");
  expect(markup).toContain("10 s");
  expect(markup).toContain("encerrado");
});
