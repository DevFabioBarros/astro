import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { BatchScaleControls } from "./BatchScaleControls";

it("offers bounded, labeled batch size actions with selected count", () => {
  const markup = renderToStaticMarkup(createElement(BatchScaleControls, {
    selectedBodyIds: ["one", "two", "three"], disabled: false, onApply: vi.fn(),
  }));

  expect(markup).toContain('aria-label="Edição múltipla"');
  expect(markup).toContain("3 astros selecionados");
  expect(markup).toContain("×2 massa");
  expect(markup).toContain("÷2 raio");
  expect(markup).toContain("Sem expressões; uma edição inválida cancela o lote inteiro.");
});
