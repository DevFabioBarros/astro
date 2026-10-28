import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import type { CelestialBody, IsothermalAtmosphere } from "@/simulation/types";
import { deriveAtmosphereMetrics } from "@/simulation/atmosphere-model";
import { AtmosphereControl, createAtmosphereForm, createAtmosphereMutation, reconcileAtmosphereForm } from "./AtmosphereControl";
import { formatPhysicalMeasure } from "./astronomy-units";

const earth = createSolarSystem().find(({ id }) => id === "earth")!;
const materializedEarth: CelestialBody = { ...earth, materials: { modelId: "material-composition-v1", rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 } };
const acceptedAtmosphere: IsothermalAtmosphere = { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 5e18, isothermalTemperatureK: 288 };

it("marks atmosphere fields for their isolated layout and keeps every input in markup", () => {
  const markup = renderToStaticMarkup(createElement(AtmosphereControl, {
    body: materializedEarth, pendingMutations: [], gravitationalConstant: 6.6743e-11, onAtmosphereChange: () => null,
  }));

  expect(markup).toContain('class="inspector-fields atmosphere-fields"');
  expect(markup).toContain('id="atmosphere-profile"');
  expect(markup).toContain('id="atmosphere-dry-mass"');
  expect(markup).toContain('id="atmosphere-temperature"');
});

it("starts adoption blank and builds complete set and remove mutations", () => {
  expect(createAtmosphereForm(materializedEarth, false).draft).toEqual({ profileId: "", dryGasMassKg: "", isothermalTemperatureK: "" });
  expect(createAtmosphereMutation("earth", acceptedAtmosphere)).toEqual({ type: "SET_ATMOSPHERE", bodyId: "earth", atmosphere: acceptedAtmosphere });
  expect(createAtmosphereMutation("earth", null)).toEqual({ type: "SET_ATMOSPHERE", bodyId: "earth", atmosphere: null });
});

it("keeps draft while pending, then restores accepted fields after rejection", () => {
  const accepted = { ...materializedEarth, atmosphere: acceptedAtmosphere };
  const initial = createAtmosphereForm(accepted, false);
  const edited = { ...initial, draft: { profileId: "carbon-dioxide-v1" as const, dryGasMassKg: "9e18", isothermalTemperatureK: "310" }, error: "rejected" };
  const pending = reconcileAtmosphereForm({ ...edited, pending: false }, accepted, true);

  expect(pending.draft).toEqual(edited.draft);
  expect(reconcileAtmosphereForm(pending, accepted, false)).toMatchObject({
    draft: { profileId: acceptedAtmosphere.profileId, dryGasMassKg: String(acceptedAtmosphere.dryGasMassKg), isothermalTemperatureK: String(acceptedAtmosphere.isothermalTemperatureK) }, error: "", pending: false,
  });
});

it("returns draft to acknowledged atmosphere values", () => {
  const accepted = { ...materializedEarth, atmosphere: acceptedAtmosphere };
  const edited = { ...createAtmosphereForm(accepted, false), draft: { profileId: "carbon-dioxide-v1" as const, dryGasMassKg: "9e18", isothermalTemperatureK: "310" }, pending: true };
  const acknowledgedAtmosphere = { ...acceptedAtmosphere, dryGasMassKg: 8e18, isothermalTemperatureK: 300 };
  const acknowledged = reconcileAtmosphereForm(edited, { ...accepted, atmosphere: acknowledgedAtmosphere }, false);

  expect(acknowledged.draft).toEqual({ profileId: acknowledgedAtmosphere.profileId, dryGasMassKg: "8000000000000000000", isothermalTemperatureK: "300" });
  expect(acknowledged.error).toBe("");
});

it("derives accepted atmosphere metrics using the supplied accepted G", () => {
  const body = { ...materializedEarth, atmosphere: acceptedAtmosphere };
  const acceptedG = 6.6743e-11;
  const markup = renderToStaticMarkup(createElement(AtmosphereControl, {
    body,
    pendingMutations: [{ revision: 3, mutation: { type: "SET_SETTINGS", settings: { gravitationalConstant: 0 } } }],
    gravitationalConstant: acceptedG,
    onAtmosphereChange: () => null,
  }));

  expect(markup).toContain(`${formatPhysicalMeasure(deriveAtmosphereMetrics(body, acceptedG).surfacePressurePa)} Pa`);
  expect(markup).not.toContain("Métricas indisponíveis para este estado atmosférico e G aceitos.");
});

it("labels potential infrared absorption as q and explains its thermal coupling only when enabled", () => {
  const body = { ...materializedEarth, atmosphere: acceptedAtmosphere };
  const render = (thermalProfileId?: CelestialBody["thermalProfileId"]) => renderToStaticMarkup(createElement(AtmosphereControl, {
    body: { ...body, thermalProfileId }, pendingMutations: [], gravitationalConstant: 6.6743e-11, onAtmosphereChange: () => null,
  }));
  const coupledMarkup = render("earthlike-global-mean-v1");
  const uncoupledMarkup = render();

  expect(coupledMarkup).toContain("Fração óptica potencial de absorção infravermelha (q)");
  expect(coupledMarkup).toContain("q reduz a emissão T10");
  expect(coupledMarkup).toContain("grey-one-layer-back-radiation-v1");
  expect(coupledMarkup).toContain("η=0,5");
  expect(coupledMarkup).toContain("instantâneo e sem armazenamento de calor");
  expect(coupledMarkup).toContain("proxies não calibrados");
  expect(uncoupledMarkup).not.toContain("q reduz a emissão T10");
});
