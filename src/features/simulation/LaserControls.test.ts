import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import { LaserControls, parseLaserDraft } from "./LaserControls";

describe("laser controls", () => {
  it("parses explicit bounded watts and accepted seconds", () => {
    expect(parseLaserDraft("200000000", "10")).toEqual({ powerW: 2e8, durationAcceptedSeconds: 10 });
    expect(parseLaserDraft("2e8", "10")).toEqual({ powerW: 2e8, durationAcceptedSeconds: 10 });
    expect(parseLaserDraft("1e16", "1")).toBeNull();
    expect(parseLaserDraft("100", "61")).toBeNull();
    expect(parseLaserDraft("Infinity", "1")).toBeNull();
  });

  it("requires explicit materialization and explains the visual-only spot", () => {
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const markup = renderToStaticMarkup(createElement(LaserControls, {
      body: earth, laserAim: null, onStartAim: vi.fn(() => null), onCancelAim: vi.fn(), disabled: false,
    }));
    expect(markup).toContain("Composição material explícita obrigatória");
    expect(markup).toContain("Somente mancha visual");
    expect(markup).toContain("não altera surfaceTemperatureK nem o T10");
    expect(markup).not.toContain('id="laser-profile"');
  });

  it("offers the closed absorption profile only for explicit materialized bodies", () => {
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const materialized = { ...earth, materials: { modelId: "material-composition-v1" as const, rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 } };
    const markup = renderToStaticMarkup(createElement(LaserControls, {
      body: materialized, laserAim: null, onStartAim: vi.fn(() => null), onCancelAim: vi.fn(), disabled: false,
    }));
    expect(markup).toContain('id="laser-profile"');
    expect(markup).toContain("grey-albedo-laser-absorption-v1");
  });

  it("keeps cancel available while a world mutation disables laser controls", () => {
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const materialized = { ...earth, materials: { modelId: "material-composition-v1" as const, rockKg: 4e24, ironKg: 2e24, gasKg: 1e24 } };
    const markup = renderToStaticMarkup(createElement(LaserControls, {
      body: materialized, laserAim: { bodyId: earth.id, powerW: 100, durationAcceptedSeconds: 1, profileId: "grey-albedo-laser-absorption-v1" },
      onStartAim: vi.fn(() => null), onCancelAim: vi.fn(), disabled: true,
    }));
    expect(markup).toMatch(/<button type="button">Cancelar mira do laser<\/button>/);
  });
});
