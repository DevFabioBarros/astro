import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import type { CelestialBody, IsothermalAtmosphere, MaterialSizeMutation, PendingWorldMutation } from "@/simulation/types";
import { deriveAtmosphereMetrics } from "@/simulation/atmosphere-model";
import { ObjectInspector, parseImpulseDeltaVelocityDraft, readExplosionPreview, routeSizeEdit, submitImpulseToWorld, updateInspectorFieldErrors } from "./ObjectInspector";
import { DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG, getExplosionEnergyPreview } from "@/simulation/world-mutations";
import { formatPhysicalMeasure } from "./astronomy-units";
import { adoptWaterInventory, getWaterInventoryCapacityKg, getWaterInventoryMetrics, setWaterInventory, updateWaterInventoryTemperature } from "@/simulation/water-model";
import { applyWorldMutation } from "@/simulation/world-mutations";
import { MAX_VELOCITY_MS } from "@/simulation/physics";

const bodies = createSolarSystem();
const noop = () => {};
const render = (body: CelestialBody, gravitationalConstant = 6.6743e-11, canExplode = true, pendingMutations: readonly PendingWorldMutation[] = [], onMaterialSize: (mutation: MaterialSizeMutation) => null = () => null, onAtmosphereChange: (mutation: Extract<PendingWorldMutation["mutation"], { type: "SET_ATMOSPHERE" }>) => null = () => null, acceptedGravitationalConstant = gravitationalConstant) => renderToStaticMarkup(createElement(ObjectInspector, {
  body, bodies, settings: { gravitationalConstant }, acceptedGravitationalConstant, simulationTimeSeconds: 0,
  pendingMutations,
  acceptedSpin: body.spin ?? null, acceptedWorldRevision: 1, spinMutationOutcome: null, spinSnapshotReady: true, spinEditable: true,
  onEdit: () => null, onMaterialSize, onAtmosphereChange, onSpinChange: () => null, onApplyImpulse: () => null, laserAim: null,
  laserDisabled: false, onStartLaserAim: () => null, onCancelLaserAim: noop, onRemove: noop, onExplode: noop, canExplode,
  evolutionRunning: false, evolutionPending: false, mutationError: "", onSolarMutation: noop, onWaterMutation: noop,
  onSolarRunningChange: noop, onSolarReset: noop,
}));

it("parses accessible delta-v units and rejects zero, non-finite, and unbounded values", () => {
  expect(parseImpulseDeltaVelocityDraft(["1,5", "-2", "0"])).toEqual([1.5, -2, 0]);
  expect(parseImpulseDeltaVelocityDraft(["0", "0", "0"])).toBeNull();
  expect(parseImpulseDeltaVelocityDraft(["Infinity", "0", "0"])).toBeNull();
  expect(parseImpulseDeltaVelocityDraft(["1e8", "0", "0"])).toBeNull();
});

it("labels center-of-mass impulse fields in SI and documents the no-torque contract", () => {
  const markup = render(bodies.find(({ id }) => id === "earth")!);
  expect(markup).toContain("Variação de velocidade no centro de massa");
  expect(markup).toContain('aria-label="Variação Δv no eixo X em metros por segundo"');
  expect(markup).toContain("J = mΔv");
  expect(markup).toContain("Não aplica torque nem altera o eixo.");
  expect(markup).toContain("Aplicar impulso");
  expect(markup).toContain('id="impulse-error"');
  expect(markup).toContain('class="inspector-error" id="impulse-error" role="alert"');
});

it("retains a rejected final-velocity error for an accessible impulse announcement", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const nearLimit = { ...earth, velocityMs: [MAX_VELOCITY_MS - 0.5, 0, 0] as const };
  const deltaVelocity = parseImpulseDeltaVelocityDraft(["1", "0", "0"])!;
  const error = "O impulso excede os limites de velocidade ou o astro não existe mais; o último estado aceito foi mantido.";
  const result = submitImpulseToWorld("earth", deltaVelocity, (bodyId, deltaV) => {
    try {
      applyWorldMutation([nearLimit], { gravitationalConstant: 6.6743e-11 }, { type: "APPLY_IMPULSE", bodyId, impulseNs: [nearLimit.massKg * deltaV[0], nearLimit.massKg * deltaV[1], nearLimit.massKg * deltaV[2]] }, 0);
      return null;
    } catch {
      return error;
    }
  });

  expect(result).toEqual({ error, submitted: false });
  expect(parseImpulseDeltaVelocityDraft(["1e7", "0", "0"])).toEqual([MAX_VELOCITY_MS, 0, 0]);
});

it("starts explicit atmosphere adoption blank and disables apply", () => {
  const earth = { ...bodies.find(({ id }) => id === "earth")!, materials: {
    modelId: "material-composition-v1" as const, rockKg: 4e24, ironKg: 2e24, gasKg: 1e24,
  } };
  const markup = render(earth);
  const applyButton = markup.match(/<button[^>]*>Adicionar atmosfera<\/button>/)?.[0] ?? "";

  expect(markup).toContain('id="atmosphere-profile"');
  expect(markup).toContain('aria-label="Massa seca atmosférica (kg)"');
  expect(markup).toContain('value=""');
  expect(applyButton).toContain('disabled=""');
  expect(markup).toContain('<option value="" disabled="" selected="">Selecione um perfil</option>');
});

it("does not infer or offer atmosphere adoption for legacy bodies", () => {
  const legacyEarth = bodies.find(({ id }) => id === "earth")!;
  const markup = render(legacyEarth);

  expect(markup).toContain("Atmosfera exige composição explícita. Materialize a composição antes de adotar uma atmosfera.");
  expect(markup).not.toContain('id="atmosphere-profile"');
  expect(markup).not.toContain("Aplicar atmosfera");
});

it("keeps atmosphere metrics on the accepted snapshot while a new draft is pending", () => {
  const accepted: CelestialBody = { ...bodies.find(({ id }) => id === "earth")!,
    materials: { modelId: "material-composition-v1", rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 },
    atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 5e18, isothermalTemperatureK: 288 } };
  const pendingAtmosphere: IsothermalAtmosphere = { ...accepted.atmosphere!, dryGasMassKg: 2e19 };
  const pending: PendingWorldMutation[] = [{ revision: 2, mutation: { type: "SET_ATMOSPHERE", bodyId: accepted.id, atmosphere: pendingAtmosphere } }];
  const metrics = deriveAtmosphereMetrics(accepted, 6.6743e-11);
  const pendingMetrics = deriveAtmosphereMetrics({ ...accepted, massKg: accepted.massKg + pendingAtmosphere.dryGasMassKg - accepted.atmosphere!.dryGasMassKg, atmosphere: pendingAtmosphere }, 6.6743e-11);
  const markup = render(accepted, 6.6743e-11, true, pending);

  expect(markup).toContain("Aguardando confirmação da atmosfera.");
  expect(markup).toContain(`${formatPhysicalMeasure(metrics.surfacePressurePa)} Pa`);
  expect(markup).not.toContain(`${formatPhysicalMeasure(pendingMetrics.surfacePressurePa)} Pa`);
});

it("uses accepted G while SET_SETTINGS is pending", () => {
  const accepted: CelestialBody = { ...bodies.find(({ id }) => id === "earth")!,
    materials: { modelId: "material-composition-v1", rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 },
    atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 5e18, isothermalTemperatureK: 288 } };
  const pendingSettings: PendingWorldMutation[] = [{ revision: 2, mutation: { type: "SET_SETTINGS", settings: { gravitationalConstant: 0 } } }];
  const metrics = deriveAtmosphereMetrics(accepted, 6.6743e-11);
  const markup = render(accepted, 0, true, pendingSettings, undefined, undefined, 6.6743e-11);

  expect(markup).toContain(`${formatPhysicalMeasure(metrics.surfacePressurePa)} Pa`);
  expect(markup).not.toContain("Métricas indisponíveis para este estado atmosférico e G aceitos.");
});

it("keeps atmosphere controls visible when accepted metrics are unavailable", () => {
  const accepted: CelestialBody = { ...bodies.find(({ id }) => id === "earth")!,
    materials: { modelId: "material-composition-v1", rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 },
    atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 5e18, isothermalTemperatureK: 288 } };
  const markup = render(accepted, 0);

  expect(markup).toContain("Métricas indisponíveis para este estado atmosférico e G aceitos.");
  expect(markup).toContain('id="atmosphere-profile"');
  expect(markup).toContain("Aplicar atmosfera");
  expect(markup).toContain("Remover atmosfera");
});

it("explains material size derivation and preservation of the T11 escape ledger", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const waterBody = updateWaterInventoryTemperature(
    setWaterInventory(adoptWaterInventory(earth), getWaterInventoryCapacityKg(earth) * 0.4), 900,
  );
  const materialized = { ...waterBody, materials: {
    modelId: "material-composition-v1" as const, rockKg: 4e24, ironKg: 2e24, gasKg: 1e24,
  } };
  const markup = render(materialized);

  expect(getWaterInventoryMetrics(waterBody).escapedWaterKg).toBeGreaterThan(0);
  expect(markup).toContain("Editar massa recalcula o raio; editar raio recalcula a massa.");
  expect(markup).toContain("Frações secas, fases da água e o ledger de água escapada são preservados.");
});

it("routes material mass and radius edits to their matching authoritative mutation", () => {
  const earth = { ...bodies.find(({ id }) => id === "earth")!, materials: {
    modelId: "material-composition-v1" as const, rockKg: 4e24, ironKg: 2e24, gasKg: 1e24,
  } };
  const onEdit = vi.fn(() => null);
  const onMaterialSize = vi.fn(() => null);

  routeSizeEdit(earth, "massKg", 8e24, onEdit, onMaterialSize);
  routeSizeEdit(earth, "radiusM", 7e6, onEdit, onMaterialSize);

  expect(onMaterialSize.mock.calls).toEqual([
    [{ type: "SET_MATERIAL_SIZE", bodyId: "earth", editMode: "mass-authoritative", massKg: 8e24 }, undefined],
    [{ type: "SET_MATERIAL_SIZE", bodyId: "earth", editMode: "radius-authoritative", radiusM: 7e6 }, undefined],
  ]);
  expect(onEdit).not.toHaveBeenCalled();
});

it("keeps legacy size edits on EDIT_BODY", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const onEdit = vi.fn(() => null);
  const onMaterialSize = vi.fn(() => null);

  routeSizeEdit(earth, "massKg", 8e24, onEdit, onMaterialSize);

  expect(onEdit).toHaveBeenCalledWith("massKg", 8e24, undefined);
  expect(onMaterialSize).not.toHaveBeenCalled();
});

it("shows diameter and Newtonian surface measures with orbital distance", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const markup = render(earth);

  expect(markup).toContain("Diâmetro");
  expect(markup).toContain("Distância até Sol");
  expect(markup).toContain("Densidade média");
  expect(markup).toContain("Gravidade superficial");
  expect(markup).toContain("Velocidade de escape");
  expect(markup).toContain("m/s²");
  expect(markup).toContain("km/s");
});

it("starts derived measurements collapsed and keeps their approximation note visible", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const markup = render(earth);

  expect(markup).toContain('<details class="advanced-controls derived-measurements"><summary>Medidas derivadas</summary>');
  expect(markup).toContain('<p class="experiment-note">Densidade, gravidade e escape usam esfera ideal; gravidade usa G configurado.</p>');
});

it("uses the configured gravitational constant for surface gravity and escape speed", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const markup = render(earth, 0);

  expect(markup).toContain("Gravidade superficial</dt><dd>0 m/s²");
  expect(markup).toContain("Velocidade de escape</dt><dd>0 km/s");
});

it("hides Newtonian surface gravity and escape speed for a black hole", () => {
  const blackHole = { ...bodies[0]!, id: "black-hole", name: "Buraco negro", bodyType: "black-hole" as const };
  const markup = render(blackHole);

  expect(markup).toContain("Limite do modelo: com gravidade ativa, encontros abaixo de 50 Rs são recusados; não há relatividade geral.");
  expect(markup).not.toContain("Gravidade superficial");
  expect(markup).not.toContain("Velocidade de escape");
});

it("locks solar mass, radius and temperature until explicit exit from the track", () => {
  const sun = bodies.find(({ id }) => id === "sun")!;
  const evolvingSun = {
    ...sun,
    stellarEvolution: {
      modelId: "mist-v1.2-solar-1msun-nonrotating" as const,
      modelVersion: "1.2" as const,
      ageYears: 4.58e9,
      accretedMassKg: 0,
      absorbedBodyIds: [],
      mode: "secular" as const,
    },
  };
  const markup = render(evolvingSun);

  expect(markup).toContain("Saia da evolução solar para editar massa, raio ou temperatura.");
  expect(markup).toContain("Saia da evolução solar para editar.");
  expect(markup).toContain("Define o tamanho e o contato.");
  expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
});

it("shows Core-derived explosion preview and explicit energy limits", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const preview = getExplosionEnergyPreview(earth, { gravitationalConstant: 6.6743e-11 });
  const markup = render(earth);

  expect(markup).toContain("Energia específica da fragmentação (J/kg)");
  expect(markup).toContain(`value="${DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG}"`);
  expect(markup).toContain(`${formatPhysicalMeasure(preview.kickSpeedMs / 1000)} km/s`);
  expect(markup).toContain("Energia cinética de ejeção K");
  expect(markup).toContain("Energia de ligação gravitacional");
  expect(markup).toContain("não é limiar calibrado");
  expect(markup).toContain("energia total não é conservada");
});

it.each(["", "NaN", "Infinity", "-Infinity"]) ("rejects invalid explosion draft %j without throwing", (draft) => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const result = readExplosionPreview(earth, { gravitationalConstant: 6.6743e-11 }, draft);

  expect(result.preview).toBeNull();
  expect(result.error).toBeTruthy();
});

it("shows an error and disables explosion when a finite body cannot produce a representable preview", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const extremeEarth = { ...earth, massKg: Number.MAX_VALUE };
  const markup = render(extremeEarth);

  expect(markup).toContain("Não foi possível estimar a fragmentação:");
  expect(markup).toContain('id="explode-astro"');
  expect(markup).toContain('disabled=""');
});

it("keeps compact objects unavailable for explosion", () => {
  const blackHole = { ...bodies[0]!, id: "black-hole", name: "Buraco negro", bodyType: "black-hole" as const };
  const markup = render(blackHole, 6.6743e-11, false);

  expect(markup).toContain('id="explode-astro"');
  expect(markup).toContain('disabled=""');
  expect(markup).toContain("Fragmentação indisponível para astros compactos.");
  expect(markup).not.toContain("Energia específica da fragmentação");
});

it.each(["star", "white-dwarf", "neutron-star"] as const)("keeps temperature editable and omits water controls for luminous %s", (bodyType) => {
  const star = { ...bodies[0]!, bodyType, kind: "star" as const };
  const markup = render(star);

  expect(markup).toContain('aria-label="Temperatura"');
  expect(markup).toContain('aria-label="Temperatura (°C)"');
  expect(markup).not.toContain('aria-label="Água"');
  expect(markup).not.toContain("Água<small>%</small>");
  expect(markup).not.toContain("class=\"phase phase-");
});

it("hides black-hole temperature and water while keeping horizon radius read-only", () => {
  const blackHole = { ...bodies[0]!, id: "black-hole", name: "Buraco negro", bodyType: "black-hole" as const };
  const markup = render(blackHole);

  expect(markup).not.toContain('aria-label="Temperatura"');
  expect(markup).not.toContain('aria-label="Temperatura (°C)"');
  expect(markup).not.toContain('aria-label="Água"');
  expect(markup).not.toContain("class=\"phase phase-");
  expect(markup).toContain('aria-label="Horizonte de eventos"');
  expect(markup).toContain('aria-label="Horizonte de eventos (km)"');
  const horizonInput = markup.match(/<input[^>]*aria-label="Horizonte de eventos \(km\)"[^>]*>/)?.[0];
  const horizonSlider = markup.match(/<input[^>]*aria-label="Horizonte de eventos"[^>]*>/)?.[0];
  expect(horizonInput).toContain('disabled=""');
  expect(horizonSlider).toContain('disabled=""');
});

it.each(["earth", "moon"])("keeps water controls and phase for editable planetary body %s", (id) => {
  const body = bodies.find((candidate) => candidate.id === id)!;
  const markup = render(body);

  expect(markup).toContain('aria-label="Água"');
  expect(markup).toContain('aria-label="Água (%)"');
  expect(markup).toContain('class="phase phase-');
});

it("keeps water and temperature sliders present and accessible", () => {
  const markup = render(bodies.find(({ id }) => id === "earth")!);
  const waterSlider = markup.match(/<input[^>]*type="range"[^>]*aria-label="Água"[^>]*>/)?.[0] ?? "";
  const temperatureSlider = markup.match(/<input[^>]*type="range"[^>]*aria-label="Temperatura"[^>]*>/)?.[0] ?? "";

  expect(waterSlider).toContain('aria-describedby="hint-water edit-error-water"');
  expect(temperatureSlider).toContain('aria-describedby="hint-temperature edit-error-temperature"');
});

it("connects exact inputs and sliders to their field-specific error descriptions", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const markup = render(earth);

  expect(markup).toContain('aria-describedby="hint-mass edit-error-mass"');
  expect(markup).toContain('aria-describedby="edit-error-mass"');
  expect(markup).toContain('<label for="field-mass">');
  expect(markup).toContain('id="field-mass"');
  expect(markup).toContain('id="edit-error-mass"');
});

it("updates one field error without clearing errors on other controls", () => {
  const first = updateInspectorFieldErrors({}, "mass", "Massa fora do limite.");
  const both = updateInspectorFieldErrors(first, "radius", "Raio fora do limite.");
  const cleared = updateInspectorFieldErrors(both, "mass", null);

  expect(both).toEqual({ mass: "Massa fora do limite.", radius: "Raio fora do limite." });
  expect(cleared).toEqual({ radius: "Raio fora do limite." });
});

it("shows the newest pending field value and marks it busy until a snapshot resolves it", () => {
  const earth = { ...bodies.find(({ id }) => id === "earth")!, waterFraction: 0.2 };
  const pendingMutations: PendingWorldMutation[] = [
    { revision: 4, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "waterFraction", value: 0.9 } },
    { revision: 3, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "waterFraction", value: 0.8 } },
    { revision: 5, mutation: { type: "EDIT_BODY", bodyId: "sun", field: "waterFraction", value: 0.1 } },
  ];
  const markup = render(earth, 6.6743e-11, true, pendingMutations);

  expect(markup).toContain("90%");
  expect(markup).toContain('value="0.9"');
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain("Aplicando… 90%");
  expect(markup).toContain("Aplicando alterações: Água.");
});

it("shows only accepted field values after resolution and ignores pending edits for another body", () => {
  const earth = { ...bodies.find(({ id }) => id === "earth")!, waterFraction: 0.2 };
  const pendingEarthEdit: PendingWorldMutation[] = [
    { revision: 3, mutation: { type: "EDIT_BODY", bodyId: "earth", field: "waterFraction", value: 0.9 } },
  ];
  const rejectedMarkup = render(earth);
  const acceptedMarkup = render({ ...earth, waterFraction: 0.9 });
  const otherBodyMarkup = render(bodies.find(({ id }) => id === "sun")!, 6.6743e-11, true, pendingEarthEdit);

  expect(rejectedMarkup).toContain("20%");
  expect(rejectedMarkup).not.toContain("Aplicando…");
  expect(acceptedMarkup).toContain("90%");
  expect(acceptedMarkup).not.toContain("Aplicando…");
  expect(otherBodyMarkup).not.toContain("Aplicando…");
  expect(otherBodyMarkup).not.toContain('aria-busy="true"');
});

it("keeps legacy water in its old controls until explicit modeling and explains the physical change", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const markup = render(earth);

  expect(markup).toContain('aria-label="Água (%)"');
  expect(markup).toContain("Modelar inventário atual");
  expect(markup).toContain("Isso acrescenta massa de água e aumenta o raio físico.");
  expect(markup).not.toContain("Água retida");
});

it("shows modeled water metrics and the accepted inventory while an update is pending", () => {
  const earth = bodies.find(({ id }) => id === "earth")!;
  const capacityKg = getWaterInventoryCapacityKg(earth);
  const initial = setWaterInventory(adoptWaterInventory(earth), capacityKg * 0.4);
  const heated = updateWaterInventoryTemperature(initial, 900);
  const accepted = updateWaterInventoryTemperature(heated, earth.surfaceTemperatureK);
  const metrics = getWaterInventoryMetrics(accepted);
  const pendingTargetKg = capacityKg * 0.8;
  const pendingMutations: PendingWorldMutation[] = [
    { revision: 2, mutation: { type: "SET_WATER_INVENTORY", bodyId: earth.id, retainedWaterKg: pendingTargetKg } },
  ];
  const markup = render(accepted, 6.6743e-11, true, pendingMutations);
  const slider = markup.match(/<input[^>]*aria-label="Água disponível"[^>]*>/)?.[0] ?? "";

  expect(metrics.retainedWaterKg).toBeGreaterThan(0);
  expect(metrics.escapedWaterKg).toBeGreaterThan(0);
  expect(markup).toContain("Cobertura da superfície");
  expect(markup).toContain("Água líquida");
  expect(markup).toContain("Água retida");
  expect(markup).toContain(`${formatPhysicalMeasure(metrics.retainedWaterKg!)} kg`);
  expect(markup).toContain("Água escapada");
  expect(markup).toContain(`${formatPhysicalMeasure(metrics.escapedWaterKg!)} kg`);
  expect(slider).toContain('min="0"');
  expect(slider).toContain(`max="${capacityKg}"`);
  expect(slider).toContain(`value="${metrics.retainedWaterKg}"`);
  expect(slider).not.toContain(`value="${pendingTargetKg}"`);
  expect(slider).not.toContain('disabled=""');
});


