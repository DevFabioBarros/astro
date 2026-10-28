"use client";

import { useState } from "react";
import type { BatchScaleBodiesMutation } from "@/simulation/types";

type Props = { selectedBodyIds: readonly string[]; disabled: boolean; onApply: (mutation: BatchScaleBodiesMutation) => string | null };

export function BatchScaleControls({ selectedBodyIds, disabled, onApply }: Props) {
  const [error, setError] = useState("");
  const apply = (field: BatchScaleBodiesMutation["field"], factor: BatchScaleBodiesMutation["factor"]) => {
    const message = onApply({ type: "BATCH_SCALE_BODIES", bodyIds: [...selectedBodyIds], field, factor });
    setError(message ?? "");
  };
  if (selectedBodyIds.length < 2) return null;
  return <section className="inspector-control-group batch-scale-controls" aria-label="Edição múltipla">
    <h2>Edição múltipla</h2>
    <p>{selectedBodyIds.length} astros selecionados</p>
    <p>Massa (kg) e raio (m); fator ×2 ou ÷2.</p>
    <div className="batch-scale-actions">
      <button type="button" disabled={disabled} onClick={() => apply("massKg", 2)}>×2 massa</button>
      <button type="button" disabled={disabled} onClick={() => apply("massKg", 0.5)}>÷2 massa</button>
      <button type="button" disabled={disabled} onClick={() => apply("radiusM", 2)}>×2 raio</button>
      <button type="button" disabled={disabled} onClick={() => apply("radiusM", 0.5)}>÷2 raio</button>
    </div>
    {selectedBodyIds.length > 16 ? <p role="status">Selecione no máximo 16 astros para editar em lote.</p> : null}
    <p>Sem expressões; uma edição inválida cancela o lote inteiro.</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
