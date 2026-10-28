"use client";

import { useEffect, useRef, useState } from "react";
import { getBodyEditLimits, getBodyMassLimits } from "@/simulation/body-edits";
import { BODY_TEMPLATES, getBodyType, schwarzschildRadius } from "@/simulation/body-catalog";
import { findOrbitalPrimary, getOrbitalElements } from "@/simulation/orbital-analysis";
import { MAX_MASS_KG, MAX_SURFACE_TEMPERATURE_K, MAX_VELOCITY_MS } from "@/simulation/physics";
import { classifyWaterPhase } from "@/simulation/surface-phase";
import { getWaterInventoryCapacityKg, getWaterInventoryMetrics, isWaterInventorySupported } from "@/simulation/water-model";
import { getSolarEvolutionProperties, stellarIrradianceWm2, stellarLuminosityW } from "@/simulation/stellar-evolution";
import { supportsThermalProfile, THERMAL_PROFILE_MAX_TEMPERATURE_K } from "@/simulation/thermal-model";
import { DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG, MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG, getExplosionEnergyPreview, type ExplosionEnergyPreview } from "@/simulation/world-mutations";
import { SolarEvolutionControls } from "./SolarEvolutionControls";
import { OrbitalReadout } from "./OrbitalReadout";
import { AtmosphereControl } from "./AtmosphereControl";
import { SpinControl, type SpinMutationOutcome } from "./SpinControl";
import { LaserControls } from "./LaserControls";
import { SurfaceSummary } from "./SurfaceSummary";
import { shortBodyName } from "./BodyCatalog";
import { ASTRONOMICAL_UNIT_M, contextualSliderRange, formatMass, formatPhysicalMeasure, logarithmicSliderPhysicalValue, logarithmicSliderStep, logarithmicSliderValue, parseAstronomicalEdit, toDisplayUnit } from "./astronomy-units";
import type { CelestialBody, EditableBodyField, LaserAimConfiguration, MaterialSizeMutation, PendingWorldMutation, PhysicsSettings, ThermalProfileId, Vector3, WorldMutation } from "@/simulation/types";
import type { SpinState } from "@/simulation/spin-model";

type ObjectInspectorProps = {
  body: CelestialBody;
  simulationTimeSeconds: number;
  bodies: readonly CelestialBody[];
  pendingMutations: readonly PendingWorldMutation[];
  worldTransitionPending?: boolean;
  impulsePauseRequired?: boolean;
  settings: PhysicsSettings; acceptedGravitationalConstant: number;
  onEdit: (field: EditableBodyField, value: number, coalesceId?: string) => string | null;
  onMaterialSize: (mutation: MaterialSizeMutation, coalesceId?: string) => string | null; onAtmosphereChange: (mutation: Extract<WorldMutation, { type: "SET_ATMOSPHERE" }>) => string | null;
  onSpinChange: (mutation: Extract<WorldMutation, { type: "SET_BODY_SPIN" }>) => string | null;
  acceptedSpin: SpinState | null;
  acceptedWorldRevision: number | null;
  spinMutationOutcome: SpinMutationOutcome | null;
  spinSnapshotReady: boolean;
  spinEditable: boolean;
  onApplyImpulse: (bodyId: string, deltaVelocityMs: Vector3) => string | null;
  laserAim: LaserAimConfiguration | null;
  laserDisabled: boolean;
  onStartLaserAim: (aim: LaserAimConfiguration) => string | null;
  onCancelLaserAim: () => void;
  onRemove: () => void;
  onExplode: (specificEnergyJkg?: number) => void;
  canExplode: boolean;
  evolutionRunning: boolean;
  evolutionPending: boolean;
  mutationError: string;
  onSolarMutation: (mutation: WorldMutation) => void;
  onWaterMutation: (mutation: Extract<WorldMutation, { type: "ADOPT_WATER_INVENTORY" | "SET_WATER_INVENTORY" }>, coalesceId?: string) => void;
  onThermalProfileChange?: (bodyId: string, profileId: ThermalProfileId | null) => void;
  onSolarRunningChange: (running: boolean) => void;
  onSolarReset: () => void;
};
type InspectorField = { name: string; label: string; unit: string; field: EditableBodyField; value: number };
const formatInputValue = (value: number) => String(Number(value.toPrecision(8)));
const number = (value: number, maximumFractionDigits = 2) => value.toLocaleString("pt-BR", { maximumFractionDigits });
const phaseNames = { ice: "Gelo", liquid: "Água líquida", vapor: "Vapor de água", unsupported: "Fase indefinida" } as const;
function spectralClassFromTemperature(temperatureK: number): string {
  if (temperatureK >= 30000) return "O";
  if (temperatureK >= 10000) return "B";
  if (temperatureK >= 7500) return "A";
  if (temperatureK >= 6000) return "F";
  if (temperatureK >= 5200) return "G";
  if (temperatureK >= 3700) return "K";
  return "M";
}

export function updateInspectorFieldErrors(errors: Readonly<Record<string, string>>, key: string, error: string | null): Record<string, string> {
  if (error) return { ...errors, [key]: error };
  if (!Object.hasOwn(errors, key)) return { ...errors };
  const next = { ...errors };
  delete next[key];
  return next;
}

export function parseImpulseDeltaVelocityDraft(values: readonly string[]): Vector3 | null {
  if (values.length !== 3) return null;
  const components = values.map((value) => Number(value.trim().replace(",", ".")));
  if (!components.every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_VELOCITY_MS)
    || components.every((value) => value === 0)) return null;
  return components as unknown as Vector3;
}

export function submitImpulseToWorld(bodyId: string, deltaVelocityMs: Vector3,
  onApply: ObjectInspectorProps["onApplyImpulse"]): { error: string | null; submitted: boolean } {
  const error = onApply(bodyId, deltaVelocityMs);
  return { error, submitted: error === null };
}

export function routeSizeEdit(body: CelestialBody, field: EditableBodyField, value: number,
  onEdit: ObjectInspectorProps["onEdit"], onMaterialSize: ObjectInspectorProps["onMaterialSize"], coalesceId?: string): string | null {
  if (body.materials && (field === "massKg" || field === "radiusM")) return onMaterialSize(field === "massKg"
    ? { type: "SET_MATERIAL_SIZE", bodyId: body.id, editMode: "mass-authoritative", massKg: value }
    : { type: "SET_MATERIAL_SIZE", bodyId: body.id, editMode: "radius-authoritative", radiusM: value }, coalesceId);
  return onEdit(field, value, coalesceId);
}

export function readExplosionPreview(body: CelestialBody, settings: PhysicsSettings, draft: string): { preview: ExplosionEnergyPreview | null; error: string } {
  try {
    const specificEnergyJkg = Number(draft.trim().replace(",", "."));
    return { preview: getExplosionEnergyPreview(body, settings, specificEnergyJkg), error: "" };
  } catch (error) {
    return { preview: null, error: error instanceof Error ? error.message : "Valor não representável para este astro." };
  }
}

export function ObjectInspector({ body, bodies, pendingMutations, worldTransitionPending = false, impulsePauseRequired = false, settings, acceptedGravitationalConstant, simulationTimeSeconds, onEdit, onMaterialSize, onAtmosphereChange, onSpinChange, acceptedSpin, acceptedWorldRevision, spinMutationOutcome, spinSnapshotReady, spinEditable, onApplyImpulse, laserAim, laserDisabled, onStartLaserAim, onCancelLaserAim, onRemove, onExplode, canExplode, evolutionRunning, evolutionPending, mutationError, onSolarMutation, onWaterMutation, onThermalProfileChange = () => {}, onSolarRunningChange, onSolarReset }: ObjectInspectorProps) {
  const sliderCoalesceIds = useRef(new Map<string, string>());
  const sliderCoalesceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState("");
  const [advancedDisclosure, setAdvancedDisclosure] = useState({ bodyId: body.id, open: false });
  const advancedOpen = advancedDisclosure.bodyId === body.id && advancedDisclosure.open;
  const [sliderDrafts, setSliderDrafts] = useState<Record<string, number>>({});
  const [waterSliderDraft, setWaterSliderDraft] = useState<number | null>(null);
  const [explosionEnergyDraft, setExplosionEnergyDraft] = useState(String(DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG));
  const [impulseDraft, setImpulseDraft] = useState(["0", "0", "0"]);
  const [impulseError, setImpulseError] = useState("");
  const pendingEdits = new Map<EditableBodyField, { revision: number; value: number }>();
  for (const { revision, mutation } of pendingMutations) {
    if (mutation.type === "EDIT_BODY" && mutation.bodyId === body.id) {
      const previous = pendingEdits.get(mutation.field); if (!previous || revision > previous.revision) pendingEdits.set(mutation.field, { revision, value: mutation.value });
    } else if (mutation.type === "SET_MATERIAL_SIZE" && mutation.bodyId === body.id) {
      const field = mutation.editMode === "mass-authoritative" ? "massKg" : "radiusM";
      const value = mutation.editMode === "mass-authoritative" ? mutation.massKg : mutation.radiusM;
      const previous = pendingEdits.get(field); if (!previous || revision > previous.revision) pendingEdits.set(field, { revision, value });
    }
  }
  const [temperatureMaximum] = useState(Math.min(body.thermalProfileId ? THERMAL_PROFILE_MAX_TEMPERATURE_K : MAX_SURFACE_TEMPERATURE_K, Math.max(1000, body.surfaceTemperatureK * 3)));
  const [massAnchor] = useState(body.massKg);
  const [radiusAnchor] = useState(body.radiusM);
  const stellar = body.kind === "star";
  const bodyType = getBodyType(body);
  const modeledWater = body.waterInventory !== undefined;
  const waterMetrics = stellar ? null : getWaterInventoryMetrics(body);
  const waterCapacityKg = modeledWater ? getWaterInventoryCapacityKg(body) : 0;
  const acceptedWaterKg = waterMetrics?.retainedWaterKg ?? 0;
  const waterInventoryPending = pendingMutations.some(({ mutation }) =>
    (mutation.type === "ADOPT_WATER_INVENTORY" || mutation.type === "SET_WATER_INVENTORY") && mutation.bodyId === body.id);
  const waterSliderValue = waterInventoryPending ? waterSliderDraft ?? acceptedWaterKg : acceptedWaterKg;
  const canModelWater = !stellar && !modeledWater && isWaterInventorySupported(body);
  const mainSequenceStar = stellar && bodyType === "star";
  const mainSequenceMassLimits = getBodyMassLimits(body);
  const editLimits = getBodyEditLimits(bodies, body);
  const massRange = mainSequenceStar
    ? { min: mainSequenceMassLimits.minMassKg, max: mainSequenceMassLimits.maxMassKg }
    : contextualSliderRange(massAnchor, body.massKg, mainSequenceMassLimits.maxMassKg);
  const radiusRange = contextualSliderRange(radiusAnchor, body.radiusM, editLimits.maxRadiusM);
  const blackHole = bodyType === "black-hole";
  const thermalProfileSupported = supportsThermalProfile(body);
  const impulsePending = pendingMutations.some(({ mutation }) => mutation.type === "APPLY_IMPULSE" && mutation.bodyId === body.id);
  const impulseQueuedChangesPending = (pendingMutations.length > 0 || worldTransitionPending) && !impulsePending && !impulsePauseRequired;
  const parsedImpulse = parseImpulseDeltaVelocityDraft(impulseDraft);
  const applyImpulse = () => {
    if (!parsedImpulse) return;
    const result = submitImpulseToWorld(body.id, parsedImpulse, onApplyImpulse);
    setImpulseError(result.error ?? "");
  };
  const thermalProfilePending = pendingMutations.some(({ mutation }) => mutation.type === "SET_THERMAL_PROFILE" && mutation.bodyId === body.id);
  const advancedActivity = pendingMutations.some(({ mutation }) => "bodyId" in mutation && mutation.bodyId === body.id)
    || Boolean(mutationError) || Boolean(laserAim) || evolutionRunning || evolutionPending || impulsePending
    || impulsePauseRequired || waterInventoryPending || thermalProfilePending || Boolean(impulseError)
    || spinMutationOutcome?.bodyId === body.id && (spinMutationOutcome.status === "rejected" || spinMutationOutcome.status === "superseded");
  const advancedDisclosureOpen = advancedOpen || advancedActivity;
  const solarTrackLocked = body.stellarEvolution?.mode === "secular";
  const postMainSequenceMassLocked = mainSequenceStar && body.stellarEvolution !== undefined
    && getSolarEvolutionProperties(body.stellarEvolution.ageYears).stage !== "main-sequence";
  const manualCollapseHint = mainSequenceStar && !solarTrackLocked && !postMainSequenceMassLocked
    ? `Raio ≤ ${formatPhysicalMeasure(schwarzschildRadius(body.massKg) / 1000)} km para compactar. Modelo não rotante.`
    : null;
  const mainSequenceMassLocked = solarTrackLocked || postMainSequenceMassLocked;
  const stellarMassRangeError = "A sequência principal aceita massas entre 0,179 e 31 M☉ (Eker 2018).";
  const primary = findOrbitalPrimary(body, bodies, settings);
  const orbit = primary ? getOrbitalElements(body, primary, settings) : undefined;
  const distance = primary ? Math.hypot(...body.positionM.map((value, axis) => value - primary.positionM[axis]!)) / ASTRONOMICAL_UNIT_M : null;
  const irradiance = body.kind === "planet" && primary?.kind === "star" ? stellarIrradianceWm2(primary, body) : null;
  const speed = Math.hypot(...body.velocityMs.map((value, axis) => value - (primary?.velocityMs[axis] ?? 0))) / 1000;
  const diameterKm = 2 * body.radiusM / 1000;
  const meanDensityKgM3 = 3 * body.massKg / (4 * Math.PI * body.radiusM ** 3);
  const surfaceGravityMs2 = settings.gravitationalConstant * body.massKg / body.radiusM ** 2;
  const escapeSpeedKms = Math.sqrt(2 * settings.gravitationalConstant * body.massKg / body.radiusM) / 1000;
  const mainSequenceLuminosityW = mainSequenceStar ? stellarLuminosityW(body) : null;
  const mainSequenceSpectralClass = mainSequenceStar ? spectralClassFromTemperature(body.surfaceTemperatureK) : null;
  const explosionResult = canExplode && !mainSequenceStar ? readExplosionPreview(body, settings, explosionEnergyDraft) : { preview: null, error: "" };
  const currentWaterPhase = modeledWater && waterMetrics
    ? acceptedWaterKg === 0 ? "dry" : waterMetrics.phase
    : body.waterFraction === 0 ? "dry" : classifyWaterPhase(body.surfaceTemperatureK);
  const currentWaterPhaseLabel = modeledWater && waterMetrics
    ? acceptedWaterKg === 0 ? "Sem água retida" : phaseNames[waterMetrics.phase]
    : body.waterFraction === 0 ? "Sem água na superfície" : phaseNames[classifyWaterPhase(body.surfaceTemperatureK)];
  const mainFields: InspectorField[] = [
    { name: "mass", label: "Massa", unit: stellar ? "×10³⁰ kg" : "×10²⁴ kg", field: "massKg", value: body.massKg },
    { name: "radius", label: blackHole ? "Horizonte de eventos" : "Raio", unit: "km", field: "radiusM", value: body.radiusM },
    ...(!blackHole ? [{ name: "temperature", label: "Temperatura", unit: "°C", field: "surfaceTemperatureK" as const, value: body.surfaceTemperatureK }] : []),
    ...(!stellar && !modeledWater ? [{ name: "water", label: "Água", unit: "%", field: "waterFraction" as const, value: body.waterFraction }] : []),
  ];
  const advancedFields: InspectorField[] = [
    ...body.positionM.map((value, axis) => ({ name: `position-${axis}`, label: `Posição ${["X", "Y", "Z"][axis]}`, unit: "UA", field: `positionM.${axis}` as EditableBodyField, value })),
    ...body.velocityMs.map((value, axis) => ({ name: `velocity-${axis}`, label: `Velocidade ${["X", "Y", "Z"][axis]}`, unit: "km/s", field: `velocityMs.${axis}` as EditableBodyField, value })),
  ];
  const reportError = (key: string, error: string | null) => {
    setFieldErrors((current) => updateInspectorFieldErrors(current, key, error));
    setEditError(error ?? "");
  };
  const edit = (field: EditableBodyField, key: string, text: string) => {
    const value = parseAstronomicalEdit(field, text, stellar, editLimits);
    const outsideMainSequenceMassRange = field === "massKg" && mainSequenceStar && value !== null
      && (value < mainSequenceMassLimits.minMassKg || value > mainSequenceMassLimits.maxMassKg);
    const outsideThermalProfileRange = field === "surfaceTemperatureK" && body.thermalProfileId !== undefined
      && value !== null && value > THERMAL_PROFILE_MAX_TEMPERATURE_K;
    const error = value === null
      ? "Use um valor válido. O astro continua com o último valor aceito."
      : outsideMainSequenceMassRange ? stellarMassRangeError
        : outsideThermalProfileRange ? "O perfil térmico aceita até 1.000 K."
          : routeSizeEdit(body, field, value, onEdit, onMaterialSize);
    reportError(key, error);
    if (error) return;
    setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    setSliderDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
  };
  const renderField = ({ name, label, unit, field, value }: InspectorField) => {
    const pendingValue = pendingEdits.get(field)?.value;
    const displayedValue = pendingValue ?? value;
    return <div className="edit-field" aria-busy={pendingValue !== undefined} key={name}>
      <label htmlFor={`field-${name}`}><span>{label}<small>{unit}</small></span></label>
      <input id={`field-${name}`} disabled={(blackHole && field === "radiusM") || (solarTrackLocked && ["radiusM", "surfaceTemperatureK"].includes(field)) || (mainSequenceMassLocked && field === "massKg")} aria-busy={pendingValue !== undefined} aria-invalid={Boolean(fieldErrors[name])} aria-label={`${label} (${unit})`} aria-describedby={`edit-error-${name}`} inputMode="decimal" onBlur={(event) => { if (Object.hasOwn(drafts, name)) edit(field, name, event.target.value); }} onChange={(event) => setDrafts((current) => ({ ...current, [name]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} type="text" value={drafts[name] ?? formatInputValue(toDisplayUnit(field, displayedValue, stellar))} />
      {pendingValue !== undefined ? <span className="field-pending">Aplicando… {number(toDisplayUnit(field, pendingValue, stellar))} {unit}</span> : null}
      <span className="field-error" id={`edit-error-${name}`} role="alert">{fieldErrors[name] ?? ""}</span>
    </div>;
  };
  const renderKelvinField = () => <div className="edit-field" key="temperature-k">
    <label htmlFor="field-temperature-k"><span>Temperatura exata<small>K</small></span></label>
    <input id="field-temperature-k" disabled={solarTrackLocked} aria-label="Temperatura exata (K)" aria-invalid={Boolean(fieldErrors["temperature-k"])} aria-describedby="edit-error-temperature-k" inputMode="decimal" type="text" value={drafts["temperature-k"] ?? formatInputValue(body.surfaceTemperatureK)} onChange={(event) => setDrafts((current) => ({ ...current, "temperature-k": event.target.value }))} onBlur={(event) => {
      if (!Object.hasOwn(drafts, "temperature-k")) return;
      const value = Number(event.target.value.trim().replace(",", "."));
      const error = !event.target.value.trim() || !Number.isFinite(value)
        ? "Use uma temperatura válida. O último valor aceito foi mantido."
        : body.thermalProfileId && value > THERMAL_PROFILE_MAX_TEMPERATURE_K
          ? "O perfil térmico aceita até 1.000 K."
          : onEdit("surfaceTemperatureK", value);
      reportError("temperature-k", error);
      if (!error) setDrafts((current) => { const next = { ...current }; delete next["temperature-k"]; return next; });
    }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <span className="field-error" id="edit-error-temperature-k">{fieldErrors["temperature-k"] ?? ""}</span>
  </div>;
  const sliders = [
    { key: "mass", label: "Massa", field: "massKg" as const, value: body.massKg, min: massRange.min, max: massRange.max, logarithmic: true, format: formatMass, hint: body.materials ? "Ajustar massa recalcula o raio." : mainSequenceStar ? solarTrackLocked ? "Saia da evolução solar para editar." : postMainSequenceMassLocked ? "Eker 2018 cobre a sequência principal." : "Ajusta raio e temperatura; mantém idade e fase." : "O movimento atual é preservado." },
    { key: "radius", label: blackHole ? "Horizonte de eventos" : "Tamanho", field: "radiusM" as const, value: body.radiusM, min: radiusRange.min, max: radiusRange.max, logarithmic: true, format: (value: number) => `${number(value / 1000)} km de raio`, hint: body.materials ? "Ajustar raio recalcula a massa." : blackHole ? "Calculado pela massa." : manualCollapseHint ?? "Define tamanho e contato." },
    ...(!blackHole ? [{ key: "temperature", label: body.thermalProfileId ? "Temperatura média" : "Temperatura", field: "surfaceTemperatureK" as const, value: body.surfaceTemperatureK, min: 0, max: body.thermalProfileId ? THERMAL_PROFILE_MAX_TEMPERATURE_K : Math.max(temperatureMaximum, body.surfaceTemperatureK), logarithmic: false, format: (value: number) => `${number(value - 273.15, 0)} °C`, hint: body.thermalProfileId ? "A temperatura média segue a luz estelar." : !stellar && body.waterFraction > 0 ? "Acima de 100 °C, água pode escapar. O frio não repõe; Oceano adiciona." : "Ajusta a temperatura da superfície." }] : []),
    ...(!stellar && !modeledWater ? [{ key: "water", label: "Água", field: "waterFraction" as const, value: body.waterFraction, min: 0, max: 1, logarithmic: false, format: (value: number) => `${number(value * 100, 0)}%`, hint: "Controla a cobertura de água." }] : []),
  ].sort((first, second) => ["water", "temperature", "radius", "mass"].indexOf(first.key) - ["water", "temperature", "radius", "mass"].indexOf(second.key));
  const surfaceSliders = sliders.filter(({ key }) => key === "water" || key === "temperature");
  const shapeSliders = sliders.filter(({ key }) => key === "radius" || key === "mass");
  const comparableBodies = bodies.filter(({ name }) => !/\s+fragmento\s+\d+$/i.test(name)).sort((first, second) => second.radiusM - first.radiusM);
  const pendingFieldLabels = [...sliders, ...advancedFields].filter(({ field }) => pendingEdits.has(field)).map(({ label }) => label);
  const comparisonLogs = comparableBodies.map(({ radiusM }) => Math.log10(radiusM));
  const smallestComparisonLog = Math.min(...comparisonLogs);
  const largestComparisonLog = Math.max(...comparisonLogs);
  const beginSliderGesture = (key: string) => {
    const timer = sliderCoalesceTimers.current.get(key);
    if (timer) clearTimeout(timer);
    sliderCoalesceTimers.current.delete(key);
    sliderCoalesceIds.current.set(key, `inspector:${crypto.randomUUID()}`);
  };
  const deferSliderCoalesceEnd = (key: string) => {
    const id = sliderCoalesceIds.current.get(key);
    if (!id) return;
    const timer = sliderCoalesceTimers.current.get(key);
    if (timer) clearTimeout(timer);
    sliderCoalesceTimers.current.set(key, setTimeout(() => {
      if (sliderCoalesceIds.current.get(key) === id) sliderCoalesceIds.current.delete(key);
      sliderCoalesceTimers.current.delete(key);
    }, 300));
  };
  const renderSlider = ({ key, label, field, value, min, max, logarithmic, format, hint }: typeof sliders[number]) => {
    const draft = sliderDrafts[key];
    const pendingValue = pendingEdits.get(field)?.value;
    const shown = draft ?? pendingValue ?? value;
    const toSlider = logarithmic ? logarithmicSliderValue : key === "temperature" ? (input: number) => input - 273.15 : (input: number) => input;
    const locked = (solarTrackLocked && ["radiusM", "surfaceTemperatureK"].includes(field)) || (mainSequenceMassLocked && field === "massKg");
    return <div className={`drag-control${fieldErrors[key] ? " is-invalid" : ""}`} aria-busy={pendingValue !== undefined} key={key}><div className="drag-heading"><label htmlFor={`slider-${key}`}>{label}</label><output htmlFor={`slider-${key}`}>{format(shown)}</output></div>{pendingValue !== undefined ? <span className="field-pending">Aplicando… {format(pendingValue)}</span> : null}{key === "temperature" ? <p id={`hint-${key}`} className="temperature-retention-note">{hint}</p> : null}<input id={`slider-${key}`} type="range" aria-label={label} aria-valuetext={format(shown)} aria-busy={pendingValue !== undefined} aria-invalid={Boolean(fieldErrors[key])} aria-describedby={`hint-${key} edit-error-${key}`} disabled={(blackHole && field === "radiusM") || locked} min={toSlider(min)} max={toSlider(max)} step={logarithmic ? logarithmicSliderStep(min, shown) : field === "waterFraction" ? .01 : key === "temperature" ? .05 : 1} value={toSlider(shown)} onChange={(event) => {
      const numeric = Number(event.target.value);
      const physicalValue = logarithmic ? logarithmicSliderPhysicalValue(numeric) : key === "temperature" ? numeric + 273.15 : numeric;
      const physical = field === "massKg" && mainSequenceStar
        ? Math.min(mainSequenceMassLimits.maxMassKg, Math.max(mainSequenceMassLimits.minMassKg, physicalValue))
        : physicalValue;
      const outsideMainSequenceMassRange = field === "massKg" && mainSequenceStar
        && (physical < mainSequenceMassLimits.minMassKg || physical > mainSequenceMassLimits.maxMassKg);
      const error = outsideMainSequenceMassRange ? stellarMassRangeError : routeSizeEdit(body, field, physical, onEdit, onMaterialSize, sliderCoalesceIds.current.get(key));
      setSliderDrafts((current) => { const next = { ...current }; if (error) next[key] = physical; else delete next[key]; return next; });
      setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
      reportError(key, error);
    }} onPointerDown={() => beginSliderGesture(key)} onPointerUp={() => deferSliderCoalesceEnd(key)} onPointerCancel={() => deferSliderCoalesceEnd(key)} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
      const timer = sliderCoalesceTimers.current.get(key);
      if (timer) clearTimeout(timer);
      sliderCoalesceTimers.current.delete(key);
      if (!sliderCoalesceIds.current.has(key)) sliderCoalesceIds.current.set(key, `inspector:${crypto.randomUUID()}`);
    }} onKeyUp={(event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) deferSliderCoalesceEnd(key);
    }} onBlur={() => deferSliderCoalesceEnd(key)} /><span className="field-error" id={`edit-error-${key}`}>{fieldErrors[key] ?? ""}</span>{key === "water" || key === "temperature" ? <div className="environment-presets" aria-label={key === "water" ? "Presets de água" : "Presets de temperatura"}>{(key === "water" ? [{ label: "Seco", ariaLabel: "Superfície seca, 0% de água", value: 0 }, { label: "Oceano", ariaLabel: "Oceano, 100% de água", value: 1 }] : [{ label: "Frio · −23 °C", ariaLabel: "Frio, 250 K", value: 250 }, { label: "Ambiente · 25 °C", ariaLabel: "Temperatura ambiente, 25 graus Celsius", value: 298.15 }, { label: "Quente · 127 °C", ariaLabel: "Quente, 400 K", value: 400 }]).map((preset) => <button key={preset.label} type="button" disabled={locked} aria-label={preset.ariaLabel} onClick={() => { const error = onEdit(field, preset.value); reportError(key, error); setSliderDrafts((current) => { const next = { ...current }; if (error) next[key] = preset.value; else delete next[key]; return next; }); }}>{preset.label}</button>)}</div> : null}{key === "mass" ? <div className="mass-shortcuts" aria-label="Comparar com a massa ao selecionar">{[1, 2, 10].map((multiple) => <button key={multiple} type="button" disabled={locked || massAnchor * multiple > (mainSequenceStar ? mainSequenceMassLimits.maxMassKg : MAX_MASS_KG) || (mainSequenceStar && massAnchor * multiple < mainSequenceMassLimits.minMassKg)} aria-label={`${multiple} vezes a massa inicial`} onClick={() => {
      const physical = massAnchor * multiple;
      const error = routeSizeEdit(body, "massKg", physical, onEdit, onMaterialSize);
      setSliderDrafts((current) => { const next = { ...current }; if (error) next.mass = physical; else delete next.mass; return next; });
      setDrafts((current) => { const next = { ...current }; delete next.mass; return next; });
      reportError("mass", error);
    }}>{multiple}×</button>)}<span>massa inicial</span></div> : null}{key !== "temperature" ? <p id={`hint-${key}`}>{hint}</p> : null}</div>;
  };
  const waterInventoryControl = modeledWater && waterMetrics
    ? <section className="inspector-control-group water-inventory-control" aria-labelledby="water-inventory-title" aria-busy={waterInventoryPending}>
      <h3 id="water-inventory-title">Inventário de água</h3>
      <div className="drag-control">
        <div className="drag-heading"><label htmlFor="water-inventory-slider">Água disponível</label><output htmlFor="water-inventory-slider">{formatPhysicalMeasure(waterSliderValue)} kg</output></div>
        {waterInventoryPending ? <p className="mutation-pending" role="status" aria-live="polite">Aguardando confirmação do inventário de água.</p> : null}
        <input id="water-inventory-slider" type="range" aria-label="Água disponível" aria-valuetext={`${formatPhysicalMeasure(waterSliderValue)} kg`} aria-busy={waterInventoryPending} aria-describedby="water-inventory-hint" min={0} max={waterCapacityKg} step={waterCapacityKg / 100} value={waterSliderValue} onChange={(event) => {
          const retainedWaterKg = Number(event.target.value);
          setWaterSliderDraft(retainedWaterKg);
          onWaterMutation({ type: "SET_WATER_INVENTORY", bodyId: body.id, retainedWaterKg }, sliderCoalesceIds.current.get("water-inventory"));
        }} onPointerDown={() => beginSliderGesture("water-inventory")} onPointerUp={() => deferSliderCoalesceEnd("water-inventory")} onPointerCancel={() => deferSliderCoalesceEnd("water-inventory")} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
          const timer = sliderCoalesceTimers.current.get("water-inventory");
          if (timer) clearTimeout(timer);
          sliderCoalesceTimers.current.delete("water-inventory");
          if (!sliderCoalesceIds.current.has("water-inventory")) sliderCoalesceIds.current.set("water-inventory", `inspector:${crypto.randomUUID()}`);
        }} onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) deferSliderCoalesceEnd("water-inventory");
        }} onBlur={() => deferSliderCoalesceEnd("water-inventory")} />
        <p id="water-inventory-hint">O limite corresponde a uma camada global de referência de 2.700 m.</p>
      </div>
      <dl className="object-facts water-inventory-metrics" aria-label="Métricas aceitas do inventário de água">
        <div><dt>Cobertura da superfície</dt><dd>{number(waterMetrics.surfaceCoverageFraction * 100)}%</dd></div>
        <div><dt>Água retida</dt><dd>{formatPhysicalMeasure(acceptedWaterKg)} kg</dd></div>
        <div><dt>Água escapada</dt><dd>{formatPhysicalMeasure(waterMetrics.escapedWaterKg ?? 0)} kg</dd></div>
      </dl>
    </section>
    : canModelWater
      ? <section className="inspector-control-group water-inventory-control" aria-labelledby="water-inventory-title" aria-busy={waterInventoryPending}>
        <h3 id="water-inventory-title">Inventário de água</h3>
        <p className="experiment-note">Isso acrescenta massa de água e aumenta o raio físico.</p>
        <button type="button" disabled={waterInventoryPending} onClick={() => onWaterMutation({ type: "ADOPT_WATER_INVENTORY", bodyId: body.id })}>Modelar inventário atual</button>
        {waterInventoryPending ? <p className="mutation-pending" role="status" aria-live="polite">Aguardando confirmação do inventário de água.</p> : null}
      </section>
      : null;
  return <section className="inspector" aria-labelledby="inspector-title" aria-busy={pendingEdits.size > 0}>
    <div className="inspector-heading"><div><p className="object-kind">{BODY_TEMPLATES.find((entry) => entry.type === bodyType)?.name}</p><h2 id="inspector-title" title={body.name} aria-label={body.name}>{shortBodyName(body)}</h2></div><span className={`inspector-orb body-swatch swatch-${body.id} ${body.bodyType ? `swatch-type-${bodyType}` : ""}`} aria-hidden="true" /></div>
    <div className="inspector-fields">{mainFields.filter(({ field }) => field === "radiusM").map(renderField)}</div>
    {pendingFieldLabels.length ? <p className="mutation-pending" role="status" aria-live="polite" aria-atomic="true">Aplicando alterações: {pendingFieldLabels.join(", ")}.</p> : null}
    <SurfaceSummary body={body} />
    <details className="advanced-controls derived-measurements"><summary>Medidas derivadas</summary><dl className="object-facts"><div><dt>Diâmetro</dt><dd>{formatPhysicalMeasure(diameterKm)} km</dd></div>{mainSequenceStar ? <><div><dt>Raio</dt><dd>{formatPhysicalMeasure(body.radiusM / 1000)} km</dd></div><div><dt>Teff</dt><dd>{formatPhysicalMeasure(body.surfaceTemperatureK)} K</dd></div><div><dt>Luminosidade</dt><dd>{formatPhysicalMeasure(mainSequenceLuminosityW!)} W</dd></div><div><dt>Classe espectral aprox.</dt><dd>{mainSequenceSpectralClass}</dd></div></> : null}{primary ? <div><dt>Distância até {primary.name}</dt><dd>{distance! < .01 ? `${formatPhysicalMeasure(distance! * ASTRONOMICAL_UNIT_M / 1000)} km` : `${formatPhysicalMeasure(distance!)} UA`}</dd></div> : null}<div><dt>{primary ? "Velocidade relativa" : "Velocidade"}</dt><dd>{formatPhysicalMeasure(speed)} km/s</dd></div><div><dt>Densidade média</dt><dd>{formatPhysicalMeasure(meanDensityKgM3)} kg/m³</dd></div>{!blackHole ? <><div><dt>Gravidade superficial</dt><dd>{formatPhysicalMeasure(surfaceGravityMs2)} m/s²</dd></div><div><dt>Velocidade de escape</dt><dd>{formatPhysicalMeasure(escapeSpeedKms)} km/s</dd></div></> : null}{irradiance !== null ? <div><dt>Irradiância bolométrica</dt><dd>{formatPhysicalMeasure(irradiance)} W/m²</dd></div> : null}</dl><p className="experiment-note">Medidas estelares derivadas do último snapshot aceito.</p><p className="experiment-note">Densidade, gravidade e escape usam esfera ideal; gravidade usa G configurado.</p>{blackHole ? <p className="experiment-note">Limite do modelo: com gravidade ativa, encontros abaixo de 50 Rs são recusados; não há relatividade geral.</p> : null}{solarTrackLocked ? <p className="experiment-note">Saia da evolução solar para editar massa, raio ou temperatura.</p> : null}{postMainSequenceMassLocked ? <p className="experiment-note">O modelo de massa manual cobre apenas a sequência principal.</p> : null}</details>
    {primary && orbit ? <><p className="orbital-context">{orbit.bound ? `Em órbita de ${primary.name}` : `Trajetória de escape de ${primary.name}`}. {bodyType === "moon" ? "Sem seu planeta, a lua continua com sua velocidade e a atração dos outros astros." : "Mude a massa e acompanhe a nova trajetória."}</p><OrbitalReadout body={body} primary={primary} settings={settings} /></> : null}
    <div className="inspector-control-groups">
      {surfaceSliders.length ? <section className="inspector-control-group" aria-labelledby="surface-controls-title"><h3 id="surface-controls-title">Água e temperatura</h3><div className="drag-controls">{surfaceSliders.map(renderSlider)}</div></section> : null}
      <section className="inspector-control-group" aria-labelledby="shape-controls-title"><h3 id="shape-controls-title">Tamanho e massa</h3>{body.materials ? <p className="experiment-note">Composição seca e água escapada são preservadas.</p> : null}<div className="drag-controls">{shapeSliders.map(renderSlider)}</div></section>
    </div>
    {modeledWater && waterMetrics ? <p className="accepted-surface-state">Água retida: {formatPhysicalMeasure(acceptedWaterKg)} kg.</p> : null}
    {body.atmosphere ? <p className="accepted-surface-state">Atmosfera ativa no estado aceito.</p> : null}
    <details className="size-comparison">
      <summary>Comparar tamanhos</summary>
      <p>Raio em escala logarítmica. Só compara tamanhos; não altera a cena nem a física.</p>
      <ol aria-label="Corpos ordenados do maior para o menor raio">
        {comparableBodies.map((comparedBody) => {
          const logRadius = Math.log10(comparedBody.radiusM);
          const fraction = largestComparisonLog === smallestComparisonLog ? 1 : (logRadius - smallestComparisonLog) / (largestComparisonLog - smallestComparisonLog);
          const width = `${Math.max(5, fraction * 100)}%`;
          return <li key={comparedBody.id} title={comparedBody.name}>
            <span className="size-comparison-name">{shortBodyName(comparedBody)}</span>
            <span className="size-comparison-track" aria-hidden="true"><span style={{ width }} /></span>
            <span className="size-comparison-value">{formatPhysicalMeasure(comparedBody.radiusM / 1000)} km</span>
          </li>;
        })}
      </ol>
    </details>
    {Object.keys(fieldErrors).length > 0 ? <p className="inspector-error" role="alert">{editError || Object.values(fieldErrors).at(-1) || "Um valor não foi aplicado. Corrija o campo destacado."}</p> : null}
    {mutationError ? <p className="inspector-error" role="alert">{mutationError}</p> : null}
    {!stellar ? <div className={`phase phase-${currentWaterPhase}`}>{currentWaterPhaseLabel}</div> : null}
    <details className="advanced-controls inspector-advanced" open={advancedDisclosureOpen} aria-busy={advancedActivity} onToggle={(event) => {
      if (advancedActivity && !event.currentTarget.open) { setAdvancedDisclosure({ bodyId: body.id, open: true }); return; }
      setAdvancedDisclosure({ bodyId: body.id, open: event.currentTarget.open });
    }}>
      <summary>Avançado</summary>
      <details className="advanced-controls"><summary>Digitar valores</summary><p>Valores exatos em unidades práticas.</p><div className="inspector-fields">{mainFields.filter(({ field }) => field !== "radiusM").map(renderField)}</div></details>
      <details className="advanced-controls"><summary>Valores avançados</summary><p>Posição e velocidade em unidades convertidas; temperatura em Kelvin.</p><div className="inspector-fields">{advancedFields.map(renderField)}{!blackHole ? renderKelvinField() : null}</div></details>
      <div className="inspector-control-groups">{waterInventoryControl}<AtmosphereControl body={body} pendingMutations={pendingMutations} gravitationalConstant={acceptedGravitationalConstant} onAtmosphereChange={onAtmosphereChange} /><SpinControl body={body} acceptedSpin={acceptedSpin} acceptedWorldRevision={acceptedWorldRevision} outcome={spinMutationOutcome} ready={spinSnapshotReady} editable={spinEditable} simulationTimeSeconds={simulationTimeSeconds} pendingMutations={pendingMutations} onSpinChange={onSpinChange} />
        {thermalProfileSupported ? <section className="thermal-profile-control"><div><strong>{body.thermalProfileId ? "Temperatura automática" : "Temperatura manual"}</strong><p>{body.thermalProfileId ? "A luz estelar aquece; o corpo esfria ao se afastar." : "Ative um balanço térmico global simples."}</p><details><summary>Limites</summary><p>Temperatura média, sem estações ou clima local. Perfil aproximado; satura em 1.000 K.</p></details></div><button type="button" aria-pressed={Boolean(body.thermalProfileId)} disabled={thermalProfilePending || (!body.thermalProfileId && body.surfaceTemperatureK > THERMAL_PROFILE_MAX_TEMPERATURE_K)} onClick={() => onThermalProfileChange(body.id, body.thermalProfileId ? null : "earthlike-global-mean-v1")}>{body.thermalProfileId ? "Voltar ao manual" : "Ativar balanço térmico"}</button></section> : null}
      </div>
      <SolarEvolutionControls body={body} bodies={bodies} evolutionRunning={evolutionRunning} evolutionPending={evolutionPending} mutationError="" onInitialize={() => onSolarMutation({ type: "INIT_SOLAR_EVOLUTION" })} onAdvanceAge={(ageYears) => onSolarMutation({ type: "ADVANCE_SOLAR_AGE", ageYears })} onStart={() => onSolarRunningChange(true)} onPause={() => onSolarRunningChange(false)} onReset={onSolarReset} onExitManual={() => onSolarMutation({ type: "EXIT_SOLAR_EVOLUTION" })} />
      <div className="body-actions">
        <LaserControls body={body} laserAim={laserAim} disabled={laserDisabled} onStartAim={onStartLaserAim} onCancelAim={onCancelLaserAim} />
        <details className="advanced-controls"><summary>Impulso</summary><fieldset className="impulse-controls" disabled={pendingMutations.length > 0 || worldTransitionPending || impulsePauseRequired}><legend>Variação de velocidade</legend>
          {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis} htmlFor={`impulse-dv-${axis.toLowerCase()}`}>Δv {axis} <small>m/s</small>
            <input id={`impulse-dv-${axis.toLowerCase()}`} type="text" inputMode="decimal" value={impulseDraft[index]} aria-label={`Variação Δv no eixo ${axis} em metros por segundo`}
              onChange={(event) => { setImpulseError(""); setImpulseDraft((draft) => draft.map((value, component) => component === index ? event.target.value : value)); }} />
          </label>)}
          <p className="experiment-note" id="impulse-description">Aplica Δv ao centro de massa; não altera o eixo. Limite: {formatPhysicalMeasure(MAX_VELOCITY_MS)} m/s por componente.</p>
          <button type="button" onClick={applyImpulse} disabled={!parsedImpulse || pendingMutations.length > 0 || worldTransitionPending || impulsePauseRequired} aria-describedby="impulse-description impulse-error">Aplicar impulso</button>
          <p className="inspector-error" id="impulse-error" role="alert">{impulseError}</p>
          {impulsePending ? <p role="status" aria-live="polite">Aguardando confirmação do impulso.</p> : null}
          {impulsePauseRequired && !impulsePending ? <p role="status" aria-live="polite">Pause e aguarde a evolução solar antes do impulso.</p> : null}
          {impulseQueuedChangesPending ? <p role="status" aria-live="polite">Aguarde alterações pendentes antes do impulso.</p> : null}
        </fieldset></details>
        {canExplode && !mainSequenceStar ? <details className="advanced-controls"><summary>Energia e prévia</summary><div className="explosion-energy">
          <label htmlFor="explosion-specific-energy">Energia específica <small>J/kg</small></label>
          <input id="explosion-specific-energy" aria-label="Energia específica da fragmentação (J/kg)" type="text" inputMode="decimal" value={explosionEnergyDraft} aria-invalid={Boolean(explosionResult.error)} aria-describedby={explosionResult.error ? "explosion-energy-hint explosion-energy-error" : "explosion-energy-hint"} onChange={(event) => setExplosionEnergyDraft(event.target.value)} />
          <p id="explosion-energy-hint" className="experiment-note">Padrão {formatPhysicalMeasure(DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG)} J/kg; máximo {formatPhysicalMeasure(MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG)} J/kg.</p>
          {explosionResult.error ? <p id="explosion-energy-error" className="inspector-error" role="alert">Prévia indisponível: {explosionResult.error}</p> : explosionResult.preview ? <>
            <dl className="explosion-preview" aria-label="Prévia da fragmentação" aria-live="polite" aria-atomic="true">
              <div><dt>Velocidade inicial</dt><dd>{formatPhysicalMeasure(explosionResult.preview.kickSpeedMs / 1000)} km/s</dd></div>
              <div><dt>Energia cinética de ejeção</dt><dd>{formatPhysicalMeasure(explosionResult.preview.ejectaKineticEnergyJ)} J</dd></div>
              <div><dt>Energia de ligação</dt><dd>{formatPhysicalMeasure(explosionResult.preview.gravitationalBindingEnergyJ)} J</dd></div>
            </dl>
            <p className="experiment-note">A ligação usa esfera homogênea; a fragmentação acrescenta energia externa.</p>
          </> : null}
        </div></details> : null}
        <button id="explode-astro" className="explode-body" type="button" onClick={() => { if (mainSequenceStar) onExplode(); else if (explosionResult.preview) onExplode(explosionResult.preview.specificEnergyJkg); }} disabled={!canExplode || (!mainSequenceStar && !explosionResult.preview)} aria-label="Explodir astro" aria-describedby="explode-description">Explodir astro</button>
        <p className="experiment-note" id="explode-description">{mainSequenceStar ? "Descarga criativa; a estrela permanece intacta." : canExplode ? "Fragmentação experimental em seis partes." : "Fragmentação indisponível para astros compactos."}</p>
        <details className="advanced-controls"><summary>Sobre Explodir</summary><p>{mainSequenceStar ? "Gás ilustrativo; não representa destruição nem supernova natural." : canExplode ? "Energia externa; não representa supernova." : "Astros compactos não fragmentam neste experimento."}</p></details>
        <button className="remove-body" type="button" onClick={onRemove}>Remover {body.name}</button>
      </div>
      <p className="phase-note">Fases da água são aproximadas a 1 atm.</p>
    </details>
  </section>;
}
