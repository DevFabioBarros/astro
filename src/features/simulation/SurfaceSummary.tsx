import type { CelestialBody } from "@/simulation/types";
import { formatPhysicalMeasure } from "./astronomy-units";

const atmosphereNames = {
  "nitrogen-oxygen-v1": "Nitrogênio e oxigênio",
  "carbon-dioxide-v1": "Dióxido de carbono",
} as const;

export function SurfaceSummary({ body }: { body: CelestialBody }) {
  return <details className="advanced-controls surface-summary">
    <summary>Superfície</summary>
    <dl className="object-facts" aria-label="Estado aceito da superfície">
      {body.waterInventory ? <>
        <div><dt>Água líquida</dt><dd>{formatPhysicalMeasure(body.waterInventory.liquidKg)} kg</dd></div>
        <div><dt>Gelo</dt><dd>{formatPhysicalMeasure(body.waterInventory.iceKg)} kg</dd></div>
        <div><dt>Vapor</dt><dd>{formatPhysicalMeasure(body.waterInventory.vaporKg)} kg</dd></div>
      </> : <div><dt>Água</dt><dd>Estado legado</dd></div>}
      {body.atmosphere ? <div><dt>Atmosfera</dt><dd>{atmosphereNames[body.atmosphere.profileId]}</dd></div> : null}
      <div><dt>Relevo</dt><dd>{body.surface ? `Visual · revisão ${body.surface.revision}` : "Sem relevo salvo"}</dd></div>
    </dl>
    {!body.waterInventory ? <p className="experiment-note">A composição da água não é inferida neste estado legado.</p> : null}
    <p className="experiment-note">Relevo, crateras e lava são visuais; não alteram o raio físico.</p>
  </details>;
}
