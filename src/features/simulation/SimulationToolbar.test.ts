import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import type { SceneAudioControlProps } from "./scene-audio";
import { SimulationToolbar } from "./SimulationToolbar";

const audio: SceneAudioControlProps = {
  enabled: false, muted: false, volume: 0.35, reducedMotion: false, failed: false,
  onEnable: () => {}, onDisable: () => {}, onMute: () => {}, onVolumeChange: () => {},
};
const renderToolbar = (bodies = createSolarSystem(), speedMultiplier = 86_400, speedLimited = false, sceneAudio = audio) => renderToStaticMarkup(createElement(SimulationToolbar, {
  status: "paused", simulationTimeSeconds: 0, speedMultiplier,
  acceptedCollisionMode: "scientific", onCollisionModeChange: () => {},
  bodies, settings: { gravitationalConstant: 6.6743e-11 },
  acceptedAutosaveSnapshot: null,
  speedLimited, latestEvent: null, latestEventDescription: "", latestEventDetails: null,
  onToggle: () => {}, onSpeedChange: () => {}, onSettingsChange: () => null,
  onReset: () => {}, onImport: () => {}, sceneAudio,
}));

it("keeps sound opt-in and labels the cues as illustrative without vacuum propagation", () => {
  const markup = renderToolbar();

  expect(markup).toContain('aria-pressed="false">Ativar sons cinematográficos</button>');
  expect(markup).toContain("Pistas cinematográficas ilustrativas; não modelam propagação sonora no vácuo.");
  expect(markup).toContain("Som desativado. Ative por gesto para ouvir pistas.");
  expect(markup).not.toContain("Volume dos sons ilustrativos");
});

it("offers mute and volume controls only after opt-in", () => {
  const markup = renderToolbar(createSolarSystem(), 86_400, false, { ...audio, enabled: true });

  expect(markup).toContain('aria-pressed="true">Desativar sons</button>');
  expect(markup).toContain('aria-pressed="false">Silenciar</button>');
  expect(markup).toContain('aria-label="Volume dos sons ilustrativos"');
});

it("announces when cinematic audio could not be activated", () => {
  const markup = renderToolbar(createSolarSystem(), 86_400, false, { ...audio, failed: true });

  expect(markup).toContain("Não foi possível ativar o áudio neste navegador ou dispositivo.");
  expect(markup).toContain('role="status" aria-live="polite"');
});

it("does not expose the removed impact-lab action or copy", () => {
  const markup = renderToolbar();

  expect(markup).not.toContain('aria-label="Laboratório de impactos"');
  expect(markup).not.toContain("Laboratório de impactos");
});

it.each(["running", "paused", "error"] as const)("exposes the exact simulation status: %s", (status) => {
  const markup = renderToStaticMarkup(createElement(SimulationToolbar, {
    status, simulationTimeSeconds: 0, speedMultiplier: 86_400,
    acceptedCollisionMode: "scientific", onCollisionModeChange: () => {},
    bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 },
    acceptedAutosaveSnapshot: null,
    speedLimited: false, latestEvent: null, latestEventDescription: "", latestEventDetails: null,
    onToggle: () => {}, onSpeedChange: () => {}, onSettingsChange: () => null,
    onReset: () => {}, onImport: () => {},
    sceneAudio: audio,
  }));

  expect(markup).toContain(`data-simulation-status="${status}"`);
});

it("disables orbital resume while solar evolution is running", () => {
  const markup = renderToStaticMarkup(createElement(SimulationToolbar, {
    status: "paused", playDisabled: true, simulationTimeSeconds: 0, speedMultiplier: 1,
    acceptedCollisionMode: "scientific", onCollisionModeChange: () => {},
    bodies: createSolarSystem(), settings: { gravitationalConstant: 6.6743e-11 },
    acceptedAutosaveSnapshot: null,
    speedLimited: false, latestEvent: null, latestEventDescription: "", latestEventDetails: null,
    onToggle: () => {}, onSpeedChange: () => {}, onSettingsChange: () => null,
    onReset: () => {}, onImport: () => {},
    sceneAudio: audio,
  }));

  expect(markup).toContain("aria-label=\"Retomar\"");
  expect(markup).toContain("class=\"transport-play\" type=\"button\" disabled=\"\"");
});

it("disables over-budget speed presets for 64 bodies and explains why", () => {
  const solarSystem = createSolarSystem();
  const bodies = [...solarSystem, ...Array.from({ length: 54 }, (_, index) => ({
    ...solarSystem[0]!, id: `extra-${index}`, name: `Extra ${index}`,
  }))];
  const markup = renderToolbar(bodies, 86_400);
  const tenMinutesPreset = markup.match(/<option[^>]*value="600"[^>]*>[^<]*<\/option>/)?.[0];
  const hourPreset = markup.match(/<option[^>]*value="3600"[^>]*>[^<]*<\/option>/)?.[0];
  const dayPreset = markup.match(/<option[^>]*value="86400"[^>]*>[^<]*<\/option>/)?.[0];

  expect(tenMinutesPreset).toContain("disabled=\"\"");
  expect(hourPreset).not.toContain("disabled=\"\"");
  expect(dayPreset).not.toContain("disabled=\"\"");
  expect(dayPreset).toContain("selected=\"\"");
  expect(markup).toContain('aria-describedby="speed-budget-hint"');
  expect(markup).toContain("tick de 25 ms");
});

it("keeps the one-day preset enabled for the standard solar-system body count", () => {
  const markup = renderToolbar(createSolarSystem(), 86_400);
  const dayPreset = markup.match(/<option[^>]*value="86400"[^>]*>[^<]*<\/option>/)?.[0];

  expect(dayPreset).not.toContain("disabled=\"\"");
  expect(dayPreset).toContain("selected=\"\"");
});

it("announces adapted simulation speed and describes the speed control", () => {
  const markup = renderToolbar(createSolarSystem(), 86_400, true);

  expect(markup).toContain(">Ritmo adaptado</small>");
  expect(markup).toContain('id="speed-limited-hint"');
  expect(markup).toContain('aria-describedby="speed-limited-hint"');
});
