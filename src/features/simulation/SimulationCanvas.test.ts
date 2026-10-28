import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { acceptSnapshotGravity, forwardSurfaceStateForScene, isOrbitalMutationPreviewCurrent } from "./SimulationCanvas";
import { SceneCaptureControl, withPhotoModeSceneVisibility } from "./scene-capture";
import { focusPlanetNavigationButton } from "./planet-navigation-focus";
import { getSimulationErrorNotice, SimulationErrorNotice } from "./simulation-error-notice";
import type { SurfaceData } from "@/simulation/types";

afterEach(() => vi.unstubAllGlobals());

describe("simulation error notice", () => {
  it.each([
    { status: "paused" as const, heading: "Simulação pausada", error: "A colisão entre buracos negros foi recusada." },
    { status: "error" as const, heading: "Simulação interrompida", error: "Falha fatal do motor." },
  ])("announces $status snapshot errors with an alert", ({ status, heading, error }) => {
    const notice = getSimulationErrorNotice({ status, error });
    const markup = renderToStaticMarkup(createElement(SimulationErrorNotice, { notice }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(`<strong>${heading}</strong>`);
    expect(markup).toContain(`<span>${error}</span>`);
  });
});

describe("scene PNG controls", () => {
  it("exposes the manual capture action and a polite live status", () => {
    const markup = renderToStaticMarkup(createElement(SceneCaptureControl, { capture: { png: async () => new Blob(), createStream: undefined } }));

    expect(markup).toContain('<button type="button">Salvar PNG da cena</button>');
    expect(markup).toContain('<button type="button">Salvar clipe de 5 s</button>');
    expect(markup).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });

  it("keeps a reachable, accessible photo mode exit and labels canvas-only captures", () => {
    const markup = renderToStaticMarkup(createElement(SceneCaptureControl, {
      capture: { png: async () => new Blob(), createStream: undefined },
      photoMode: true,
      onPhotoModeToggle: () => {},
    }));

    expect(markup).toContain('class="scene-photo-mode-toggle" aria-pressed="true">Sair do modo foto</button>');
    expect(markup).toContain("A imagem e o clipe incluem apenas a cena 3D.");
    expect(markup).toContain('role="status" aria-live="polite"');
  });
});

describe("photo mode scene visibility", () => {
  it("hides orbits and trails without changing simulation state, then restores both", () => {
    const original = { showOrbits: true, showTrails: true, simulationRunning: true, revision: 42 };

    expect(withPhotoModeSceneVisibility(original, true)).toEqual({
      showOrbits: false, showTrails: false, simulationRunning: true, revision: 42,
    });
    expect(withPhotoModeSceneVisibility(original, false)).toBe(original);
  });
});

describe("accepted scene gravity", () => {
  it("keeps initial gravity until an accepted Worker snapshot carries new settings", () => {
    const commandSettingsRef = { current: { gravitationalConstant: 6 } };
    const acceptedGravityRef = { current: commandSettingsRef.current.gravitationalConstant };
    const sceneRead = () => acceptedGravityRef.current;
    expect(sceneRead()).toBe(6);

    const settingsMutation = { type: "SET_SETTINGS" as const, settings: { gravitationalConstant: 12 }, revision: 2 };
    commandSettingsRef.current = settingsMutation.settings;
    expect(sceneRead()).toBe(6);

    acceptSnapshotGravity(acceptedGravityRef, { settings: settingsMutation.settings });
    expect(sceneRead()).toBe(12);
  });
});

describe("orbital mutation preview acceptance", () => {
  it("accepts only the current request at the accepted world revision and time", () => {
    const request = { requestId: 9, worldRevision: 4, baseTimeSeconds: 120 };
    const response = { type: "ORBITAL_MUTATION_PREVIEW" as const, version: 1 as const, ...request, result: { status: "ready" as const, candidates: [{ bodyId: "moon", positionM: [1, 2, 3] as [number, number, number], velocityMs: [4, 5, 6] as [number, number, number] }] } };

    expect(isOrbitalMutationPreviewCurrent(response, request, 4, 120)).toBe(true);
    expect(isOrbitalMutationPreviewCurrent({ ...response, requestId: 8 }, request, 4, 120)).toBe(false);
    expect(isOrbitalMutationPreviewCurrent(response, request, 5, 120)).toBe(false);
    expect(isOrbitalMutationPreviewCurrent(response, request, 4, 121)).toBe(false);
  });
});

describe("accepted scene surface sidecar", () => {
  it("keeps the scene read on accepted props when a SURFACE_STATE arrives before its snapshot", () => {
    const accepted = { earth: [{ cellIndex: 2, elevationM: 100 }] };
    const workerUpdate = { earth: [{ cellIndex: 2, elevationM: 250 }] };
    const acceptedSurfaceDataRef: { current: SurfaceData | undefined } = { current: accepted };
    const read = () => ({ surfaceData: acceptedSurfaceDataRef.current });
    const onSurfaceState = vi.fn();

    const surfaceHeatData = { earth: [{ cellIndex: 2, energyJ: 1e12 }] };
    forwardSurfaceStateForScene({ type: "SURFACE_STATE", worldRevision: 4, surfaceData: workerUpdate, surfaceHeatData }, acceptedSurfaceDataRef, onSurfaceState);

      expect(read().surfaceData).toBe(accepted);
    expect(onSurfaceState).toHaveBeenCalledWith({ type: "SURFACE_STATE", worldRevision: 4, surfaceData: workerUpdate, surfaceHeatData });
    acceptedSurfaceDataRef.current = workerUpdate;
      expect(read().surfaceData).toBe(workerUpdate);
  });
});

function createFixture({ buttonTop = 60, buttonBottom = 80, ancestorBottom = 740, ancestorOverflowX = "visible", focusWorks = true } = {}) {
  let activeElement: unknown;
  let focusOptions: FocusOptions | undefined;
  const ancestor = {
    parentElement: null,
    style: { overflowX: ancestorOverflowX, overflowY: "hidden" },
    clientLeft: 0, clientTop: 0, clientWidth: 170, clientHeight: ancestorBottom,
    getBoundingClientRect: () => ({ left: 20, right: 190, top: 0, bottom: ancestorBottom }),
  };
  const rail = {
    parentElement: ancestor,
    style: { overflowX: "auto", overflowY: "hidden" },
    scrollLeft: 0,
    clientLeft: 2, clientTop: 3, clientWidth: 200, clientHeight: 50,
    getBoundingClientRect: () => ({ left: 10, right: 220, top: 50, bottom: 103 }),
  };
  const button = {
    parentElement: rail,
    dataset: { bodyId: "body-2" },
    getBoundingClientRect: () => ({ left: 360 - rail.scrollLeft, right: 420 - rail.scrollLeft, top: buttonTop, bottom: buttonBottom }),
    focus: (options?: FocusOptions) => { focusOptions = options; if (focusWorks) activeElement = button; },
  };
  const navigation = Object.assign(rail, { querySelectorAll: () => [button] });
  const shell = { querySelector: (selector: string) => selector === ".planet-navigation" ? navigation : null };
  const host = { closest: (selector: string) => selector === ".astro-shell" ? shell : null };
  vi.stubGlobal("document", { get activeElement() { return activeElement; } });
  vi.stubGlobal("window", { innerWidth: 320, innerHeight: 740, scrollTo: vi.fn() });
  vi.stubGlobal("getComputedStyle", (element: typeof rail | typeof ancestor) => element.style);
  return { host, rail, button, ancestor, focusOptions: () => focusOptions, activeElement: () => activeElement };
}

describe("planet navigation focus fallback", () => {
  it("reveals an offscreen body inside the navigation rail before focusing it", () => {
    const fixture = createFixture();

    expect(focusPlanetNavigationButton(fixture.host as unknown as HTMLElement, "body-2")).toBe(true);
    expect(fixture.rail.scrollLeft).toBe(208);
    expect(fixture.button.getBoundingClientRect()).toEqual({ left: 152, right: 212, top: 60, bottom: 80 });
    expect(fixture.focusOptions()).toEqual({ preventScroll: true });
    expect(fixture.activeElement()).toBe(fixture.button);
  });

  it("rejects a button outside the viewport vertically", () => {
    const fixture = createFixture({ buttonTop: -10, buttonBottom: 10 });

    expect(focusPlanetNavigationButton(fixture.host as unknown as HTMLElement, "body-2")).toBe(false);
    expect(fixture.rail.scrollLeft).toBe(0);
    expect(fixture.focusOptions()).toBeUndefined();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("reveals the button inside an additional horizontal clipping ancestor", () => {
    const fixture = createFixture({ ancestorOverflowX: "hidden" });

    expect(focusPlanetNavigationButton(fixture.host as unknown as HTMLElement, "body-2")).toBe(true);
    expect(fixture.rail.scrollLeft).toBe(230);
    expect(fixture.button.getBoundingClientRect()).toEqual({ left: 130, right: 190, top: 60, bottom: 80 });
  });

  it("rejects a button vertically clipped by an ancestor beyond the rail", () => {
    const fixture = createFixture({ buttonTop: 120, buttonBottom: 160, ancestorBottom: 100 });

    expect(focusPlanetNavigationButton(fixture.host as unknown as HTMLElement, "body-2")).toBe(false);
    expect(fixture.rail.scrollLeft).toBe(0);
    expect(fixture.activeElement()).toBeUndefined();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("reports failure when focus does not transfer", () => {
    const fixture = createFixture({ focusWorks: false });

    expect(focusPlanetNavigationButton(fixture.host as unknown as HTMLElement, "body-2")).toBe(false);
    expect(fixture.focusOptions()).toEqual({ preventScroll: true });
    expect(fixture.activeElement()).toBeUndefined();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
