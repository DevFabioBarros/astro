"use client";

import { useState } from "react";
import { ATMOSPHERE_MODEL_ID, deriveAtmosphereMetrics, isIsothermalAtmosphere, MAX_ATMOSPHERIC_DRY_MASS_KG, MAX_ISOTHERMAL_TEMPERATURE_K, MIN_ISOTHERMAL_TEMPERATURE_K, type AtmosphereMetrics } from "@/simulation/atmosphere-model";
import type { AtmosphereProfileId, CelestialBody, IsothermalAtmosphere, PendingWorldMutation, WorldMutation } from "@/simulation/types";
import { formatPhysicalMeasure } from "./astronomy-units";

type AtmosphereDraft = { profileId: AtmosphereProfileId | ""; dryGasMassKg: string; isothermalTemperatureK: string };
type AtmosphereForm = { draft: AtmosphereDraft; error: string; acceptedKey: string; pending: boolean };
type AtmosphereControlProps = {
  body: CelestialBody;
  pendingMutations: readonly PendingWorldMutation[];
  gravitationalConstant: number;
  onAtmosphereChange: (mutation: Extract<WorldMutation, { type: "SET_ATMOSPHERE" }>) => string | null;
};

function acceptedKey(body: CelestialBody): string {
  const atmosphere = body.atmosphere;
  return `${body.id}:${atmosphere?.profileId ?? ""}:${atmosphere?.dryGasMassKg ?? ""}:${atmosphere?.isothermalTemperatureK ?? ""}`;
}

function atmosphereDraftFromAccepted(atmosphere: IsothermalAtmosphere | undefined): AtmosphereDraft {
  return atmosphere ? { profileId: atmosphere.profileId, dryGasMassKg: String(atmosphere.dryGasMassKg), isothermalTemperatureK: String(atmosphere.isothermalTemperatureK) }
    : { profileId: "", dryGasMassKg: "", isothermalTemperatureK: "" };
}

export function createAtmosphereMutation(bodyId: string, atmosphere: IsothermalAtmosphere | null): Extract<WorldMutation, { type: "SET_ATMOSPHERE" }> {
  return { type: "SET_ATMOSPHERE", bodyId, atmosphere };
}

export function createAtmosphereForm(body: CelestialBody, pending: boolean): AtmosphereForm {
  return { draft: atmosphereDraftFromAccepted(body.atmosphere), error: "", acceptedKey: acceptedKey(body), pending };
}

export function reconcileAtmosphereForm(form: AtmosphereForm, body: CelestialBody, pending: boolean): AtmosphereForm {
  if (form.acceptedKey !== acceptedKey(body) || (form.pending && !pending)) return createAtmosphereForm(body, pending);
  return form.pending === pending ? form : { ...form, pending };
}

function atmosphereMetricsFor(body: CelestialBody, gravitationalConstant: number): { metrics: AtmosphereMetrics | null; error: string | null } {
  if (!body.atmosphere) return { metrics: null, error: null };
  try { return { metrics: deriveAtmosphereMetrics(body, gravitationalConstant), error: null }; }
  catch { return { metrics: null, error: "Métricas indisponíveis para este estado atmosférico e G aceitos." }; }
}

function parseDraftNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function number(value: number, maximumFractionDigits = 2) { return value.toLocaleString("pt-BR", { maximumFractionDigits }); }

export function AtmosphereControl({ body, pendingMutations, gravitationalConstant, onAtmosphereChange }: AtmosphereControlProps) {
  const pending = pendingMutations.some(({ mutation }) => mutation.type === "SET_ATMOSPHERE" && mutation.bodyId === body.id);
  const [storedForm, setForm] = useState(() => createAtmosphereForm(body, pending));
  const form = reconcileAtmosphereForm(storedForm, body, pending);
  if (form !== storedForm) setForm(form);
  const setDraft = (update: (draft: AtmosphereDraft) => AtmosphereDraft) => setForm((current) => ({ ...current, draft: update(current.draft) }));
  const setError = (error: string) => setForm((current) => ({ ...current, error }));
  const dryMassKg = parseDraftNumber(form.draft.dryGasMassKg);
  const temperatureK = parseDraftNumber(form.draft.isothermalTemperatureK);
  const atmosphere: IsothermalAtmosphere | null = form.draft.profileId && dryMassKg !== null && temperatureK !== null
    ? { modelId: ATMOSPHERE_MODEL_ID, profileId: form.draft.profileId, dryGasMassKg: dryMassKg, isothermalTemperatureK: temperatureK } : null;
  const valid = Boolean(body.materials && atmosphere && isIsothermalAtmosphere(atmosphere));
  const result = atmosphereMetricsFor(body, gravitationalConstant);
  const apply = () => { if (atmosphere && isIsothermalAtmosphere(atmosphere)) setError(onAtmosphereChange(createAtmosphereMutation(body.id, atmosphere)) ?? ""); };

  if (!body.materials) return <section className="inspector-control-group" aria-labelledby="atmosphere-controls-title">
    <h3 id="atmosphere-controls-title">Atmosfera</h3><p className="experiment-note">Atmosfera exige composição explícita. Materialize a composição antes de adotar uma atmosfera.</p>
  </section>;

  return <section className="inspector-control-group" aria-labelledby="atmosphere-controls-title" aria-busy={pending}>
    <h3 id="atmosphere-controls-title">Atmosfera</h3>{pending ? <p className="mutation-pending" role="status" aria-live="polite" aria-atomic="true">Aguardando confirmação da atmosfera.</p> : null}
    <div className="inspector-fields atmosphere-fields">
      <div className="edit-field"><label htmlFor="atmosphere-profile">Perfil atmosférico</label><select id="atmosphere-profile" aria-label="Perfil atmosférico" aria-describedby="atmosphere-hint" value={form.draft.profileId} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, profileId: event.target.value as AtmosphereProfileId | "" }))}><option value="" disabled>Selecione um perfil</option><option value="nitrogen-oxygen-v1">Nitrogênio e oxigênio · isotérmico</option><option value="carbon-dioxide-v1">Dióxido de carbono · isotérmico</option></select></div>
      <div className="edit-field"><label htmlFor="atmosphere-dry-mass">Massa seca atmosférica<small>kg</small></label><input id="atmosphere-dry-mass" aria-label="Massa seca atmosférica (kg)" aria-invalid={Boolean(form.error)} aria-describedby="atmosphere-hint atmosphere-error" inputMode="decimal" type="text" value={form.draft.dryGasMassKg} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, dryGasMassKg: event.target.value }))} /></div>
      <div className="edit-field"><label htmlFor="atmosphere-temperature">Temperatura isotérmica<small>K</small></label><input id="atmosphere-temperature" aria-label="Temperatura isotérmica atmosférica (K)" aria-invalid={Boolean(form.error)} aria-describedby="atmosphere-hint atmosphere-error" inputMode="decimal" type="text" value={form.draft.isothermalTemperatureK} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, isothermalTemperatureK: event.target.value }))} /></div>
    </div>
    <p id="atmosphere-hint" className="experiment-note">Modelo isotérmico de gás ideal: casca fina, gravidade constante e mistura uniforme. Faixas: massa seca até {formatPhysicalMeasure(MAX_ATMOSPHERIC_DRY_MASS_KG)} kg; temperatura de {MIN_ISOTHERMAL_TEMPERATURE_K} a {MAX_ISOTHERMAL_TEMPERATURE_K} K.</p>
    {result.metrics ? <dl className="object-facts" aria-label="Métricas da atmosfera aceita">
      <div><dt>Pressão superficial aproximada</dt><dd>{formatPhysicalMeasure(result.metrics.surfacePressurePa)} Pa</dd></div>
      <div><dt>Altura de escala aproximada</dt><dd>{formatPhysicalMeasure(result.metrics.scaleHeightM / 1000)} km</dd></div>
      <div><dt>Densidade superficial aproximada</dt><dd>{formatPhysicalMeasure(result.metrics.densityAtAltitudeKgM3(0))} kg/m³</dd></div>
      <div><dt>Massa molar efetiva</dt><dd>{formatPhysicalMeasure(result.metrics.effectiveMolarMassKgMol)} kg/mol</dd></div>
      <div><dt>Opacidade visual · diagnóstico</dt><dd>{number(result.metrics.visualOpacityFraction * 100)}%</dd></div>
      <div><dt>Fração óptica potencial de absorção infravermelha (q)</dt><dd>{number(result.metrics.greenhousePotentialAbsorptionFraction * 100)}%</dd></div>
    </dl> : result.error ? <p className="experiment-note" role="status">{result.error}</p> : null}
    {body.thermalProfileId && body.atmosphere ? <p className="experiment-note">q reduz a emissão T10 no modelo grey-one-layer-back-radiation-v1 (η=0,5), instantâneo e sem armazenamento de calor. Coeficientes são proxies não calibrados.</p> : null}
    {body.atmosphere ? <p className="experiment-note">Remover a atmosfera também retira sua massa seca da massa gravitante total.</p> : null}
    {form.error ? <p id="atmosphere-error" className="inspector-error" role="alert">{form.error}</p> : <span className="visually-hidden" id="atmosphere-error" />}
    <div className="body-actions"><button type="button" disabled={!valid || pending} onClick={apply}>{body.atmosphere ? "Aplicar atmosfera" : "Adicionar atmosfera"}</button>{body.atmosphere ? <button type="button" disabled={pending} onClick={() => setError(onAtmosphereChange(createAtmosphereMutation(body.id, null)) ?? "")}>Remover atmosfera</button> : null}</div>
  </section>;
}
