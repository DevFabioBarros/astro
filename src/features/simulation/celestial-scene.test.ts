import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { addOrbitTrailToScene, refreshOrbitTrailLine } from "./orbit-trails";
import { createCelestialScene, type CelestialSceneState } from "./celestial-scene";
import { createOrbitPaths, refreshOrbitPaths } from "./orbit-paths";
import { createSolarSystem } from "@/simulation/solar-system";
import { createCatalogBody } from "@/simulation/body-catalog";
import { NEWTONIAN_G } from "@/simulation/physical-constants";
import type { CelestialBody, SimulationEvent, SurfaceHeatPatch, SurfaceReliefPatch } from "@/simulation/types";
import type { SceneEclipseLight } from "./scene-lighting";
import * as sceneLabels from "./scene-labels";
import { SceneEventEffects } from "./scene-events";
import { getSafeCameraViewport } from "./camera-focus";

const sceneCapture = vi.hoisted(() => ({
  scene: null as import("three").Scene | null,
  camera: null as import("three").PerspectiveCamera | null,
  target: null as import("three").Vector3 | null,
  cursor: null as import("three").Vector3 | null,
  sphereLoadFails: false,
  maxTextureSize: 2048,
  environmentResolutions: [] as boolean[],
  environmentSeeds: [] as number[],
  environmentGroups: [] as import("three").Group[],
  environmentDisposals: 0,
  visualCreations: [] as Array<{ bodyId: string; highResolution: boolean; patchCount: number; patchElevations: number[] }>,
  surfaceHeatUpdates: [] as Array<{ bodyId: string; patches: readonly SurfaceHeatPatch[] }>,
  visualDisposals: [] as string[],
  rockSurfaceApplications: [] as string[],
  rockAssetsPromise: null as Promise<import("./rock-assets").RockSurfaceAssets | undefined> | null,
  resizeObserver: null as ResizeObserverCallback | null,
  bodyGeometries: [] as import("three").BufferGeometry[],
  canvasListeners: new Map<string, EventListener[]>(),
  bodyGroups: new Map<string, import("three").Group>(),
  eclipseLighting: new Map<string, SceneEclipseLight[]>(),
  atmosphereMetrics: new Map<string, unknown>(),
  rotations: [] as Array<{ body: CelestialBody; simulationTime: number; appearanceBody: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK">; animateSurface: boolean }>,
  canvas: null as { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } | null,
  renders: 0,
  controlsEnabled: true,
}));
vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual, WebGLRenderer: class {
    domElement = {
      tabIndex: 0, className: "", style: { touchAction: "" }, setAttribute() {}, remove() {}, focus() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }),
      addEventListener: (name: string, listener: EventListener) => { const listeners = sceneCapture.canvasListeners.get(name) ?? []; listeners.push(listener); sceneCapture.canvasListeners.set(name, listeners); },
      removeEventListener: (name: string, listener: EventListener) => { sceneCapture.canvasListeners.set(name, (sceneCapture.canvasListeners.get(name) ?? []).filter((entry) => entry !== listener)); },
    };
    constructor() { sceneCapture.canvas = this.domElement; }
    capabilities = { get maxTextureSize() { return sceneCapture.maxTextureSize; }, getMaxAnisotropy: () => 1 };
    info = { render: { calls: 1, triangles: 0 }, memory: { geometries: 1, textures: 0 } };
    setPixelRatio() {} getPixelRatio() { return 1; } setSize() {} render(scene: THREE.Scene, camera: THREE.Camera) { sceneCapture.renders += 1; sceneCapture.scene = scene; sceneCapture.camera = camera as THREE.PerspectiveCamera; } dispose() {} forceContextLoss() {}
  } };
});
vi.mock("./scene-labels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scene-labels")>();
  return { ...actual, layoutFocusLabel: vi.fn(actual.layoutFocusLabel), layoutSceneLabels: vi.fn(actual.layoutSceneLabels) };
});
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  return { OrbitControls: class {
    target = new Vector3(); cursor = new Vector3();
    get enabled() { return sceneCapture.controlsEnabled; }
    set enabled(value: boolean) { sceneCapture.controlsEnabled = value; }
    constructor() { sceneCapture.target = this.target; sceneCapture.cursor = this.cursor; }
    addEventListener() {} removeEventListener() {} update() {} dispose() {}
  } };
});
vi.mock("three/addons/loaders/GLTFLoader.js", async () => {
  const { Group, Mesh, SphereGeometry, MeshBasicMaterial } = await import("three");
  return { GLTFLoader: class {
    async loadAsync() {
      if (sceneCapture.sphereLoadFails) throw new Error("model unavailable");
      const scene = new Group(); scene.add(new Mesh(new SphereGeometry(1, 8, 4), new MeshBasicMaterial())); return { scene };
    }
  } };
});
vi.mock("./celestial-environment", async () => {
  const { Group } = await import("three");
  return { createCelestialEnvironment: (_scene: THREE.Scene, highResolution: boolean, seed: number) => {
    sceneCapture.environmentResolutions.push(highResolution);
    sceneCapture.environmentSeeds.push(seed);
    const group = new Group();
    sceneCapture.environmentGroups.push(group);
    _scene.add(group);
  return { group, dispose() { sceneCapture.environmentDisposals += 1; } };
  } };
});
vi.mock("./celestial-bodies", async () => {
  const { Group, Mesh, MeshBasicMaterial } = await import("three");
  return {
    createBodyVisual: (body: CelestialBody, geometry: THREE.BufferGeometry, _anisotropy: number, highResolution = false,
      _collisionMode: unknown, _rockAssets: unknown, _rockyFragment: boolean, surfacePatches?: readonly SurfaceReliefPatch[]) => {
      sceneCapture.bodyGeometries.push(geometry);
      sceneCapture.visualCreations.push({ bodyId: body.id, highResolution, patchCount: surfacePatches?.length ?? 0,
        patchElevations: surfacePatches?.map(({ elevationM }) => elevationM) ?? [] });
      const group = new Group(), material = new MeshBasicMaterial(), surface = new Mesh(geometry, material);
      surface.userData.bodyId = body.id;
      group.add(surface);
      if (body.id === "saturn") {
        const ring = new Mesh(new THREE.RingGeometry(1.24, 2.32, 24), material);
        ring.userData.bodyId = body.id;
        ring.userData.bodyPickExtentMultiplier = 2.32;
        ring.rotation.x = 0.47;
        group.add(ring);
      }
      sceneCapture.bodyGroups.set(body.id, group);
      return { group, surface, setEclipseLighting: (lights: readonly SceneEclipseLight[]) => sceneCapture.eclipseLighting.set(body.id, lights.map((light) => ({ ...light }))), setAtmosphereMetrics: (metrics: unknown) => sceneCapture.atmosphereMetrics.set(body.id, metrics), setSurfaceHeat: (patches: readonly SurfaceHeatPatch[]) => sceneCapture.surfaceHeatUpdates.push({ bodyId: body.id, patches }), dispose: () => { sceneCapture.visualDisposals.push(body.id); material.dispose(); } };
    },
    applyRockSurfaceAssetsToVisual: (body: CelestialBody) => {
      if (["earth", "moon", "mars", "venus", "mercury"].includes(body.id)) return false;
      sceneCapture.rockSurfaceApplications.push(body.id);
      return true;
    },
    rotateBody: (_visual: { group: THREE.Group }, body: CelestialBody, simulationTime: number, appearanceBody: Pick<CelestialBody, "radiusM" | "surfaceTemperatureK"> = body, animateSurface = true) => {
      sceneCapture.rotations.push({ body, simulationTime, appearanceBody, animateSurface });
    },
  };
});
vi.mock("./rock-assets", () => ({ loadRockSurfaceAssets: () => sceneCapture.rockAssetsPromise ?? Promise.resolve(undefined) }));
vi.mock("./orbit-paths", async (original) => {
  const actual = await original<typeof import("./orbit-paths")>();
  return { ...actual, createOrbitPaths: vi.fn(actual.createOrbitPaths), refreshOrbitPaths: vi.fn(actual.refreshOrbitPaths) };
});

afterEach(() => { sceneCapture.sphereLoadFails = false; sceneCapture.maxTextureSize = 2048; sceneCapture.environmentResolutions = []; sceneCapture.environmentSeeds = []; sceneCapture.environmentGroups = []; sceneCapture.environmentDisposals = 0; sceneCapture.visualCreations = []; sceneCapture.surfaceHeatUpdates = []; sceneCapture.visualDisposals = []; sceneCapture.rockSurfaceApplications = []; sceneCapture.rockAssetsPromise = null; sceneCapture.resizeObserver = null; sceneCapture.bodyGeometries = []; sceneCapture.canvasListeners.clear(); sceneCapture.bodyGroups.clear(); sceneCapture.eclipseLighting.clear(); sceneCapture.atmosphereMetrics.clear(); sceneCapture.rotations = []; sceneCapture.canvas = null; sceneCapture.camera = null; sceneCapture.target = null; sceneCapture.cursor = null; sceneCapture.renders = 0; sceneCapture.controlsEnabled = true; vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("visual body picking", () => {
  it("selects Saturn from a visible ring hit outside its sphere", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem(), selected = vi.fn();
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "saturn", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "focus", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect: selected, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      frame(1000);
      const group = sceneCapture.bodyGroups.get("saturn")!;
      const ring = group.children.find((child) => child.userData.bodyPickExtentMultiplier === 2.32) as THREE.Mesh;
      const camera = sceneCapture.camera!;
      camera.position.copy(group.position).add(new THREE.Vector3(0, 0, group.scale.x * 8));
      camera.lookAt(group.position);
      camera.near = Math.max(1e-9, group.scale.x * 0.001);
      camera.far = Math.max(1, group.scale.x * 100);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      ring.updateWorldMatrix(true, false);
      const point = ring.localToWorld(new THREE.Vector3(1.78, 0, 0)).project(camera);
      const event = {
        clientX: (point.x + 1) * 512, clientY: (1 - point.y) * 384, pointerId: 1,
        pointerType: "mouse", buttons: 0, isPrimary: true, target: sceneCapture.canvas,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      } as unknown as PointerEvent;
      sceneCapture.canvasListeners.get("pointerdown")?.forEach((listener) => listener(event));
      sceneCapture.canvasListeners.get("pointerup")?.forEach((listener) => listener(event));

      expect(selected).toHaveBeenCalledWith("saturn");
    } finally { dispose(); }
  });

  it.each(["system", "focus"] as const)("retains an orbital draft on pointerup and clears it on pointercancel without committing in %s mode", async (viewMode) => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const primary = createSolarSystem()[3]!;
    const state: CelestialSceneState = {
      bodies: [primary], selectedBodyId: primary.id, gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode, viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies: [primary], timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
      orbitalPlacement: { mutation: { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: primary.id, semiMajorAxisM: 1e9, planeNormal: [0, 1, 0], radialDirection: [1, 0, 0] }, worldRevision: 1, baseTimeSeconds: 0 },
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const drafts = vi.fn(), committed = vi.fn();
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody: committed, onDraftMutation: drafts, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      const group = sceneCapture.bodyGroups.get(primary.id)!;
      const camera = sceneCapture.camera!;
      camera.position.copy(group.position).add(new THREE.Vector3(0, 0, group.scale.x * 8));
      camera.lookAt(group.position);
      camera.near = Math.max(1e-9, group.scale.x * 0.001);
      camera.far = Math.max(1, group.scale.x * 100);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      group.updateWorldMatrix(true, false);
      const surfaceFront = (group.children[0] as THREE.Mesh).localToWorld(new THREE.Vector3(0, 0, 1)).project(camera);
      const centerX = (surfaceFront.x + 1) * 512, centerY = (1 - surfaceFront.y) * 384;
      const pointerEvent = (x: number, y = centerY) => ({ clientX: x, clientY: y, pointerId: 7, pointerType: "mouse", buttons: 1, isPrimary: true, target: sceneCapture.canvas,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} } as unknown as PointerEvent);
      const fire = (type: string, event: PointerEvent) => sceneCapture.canvasListeners.get(type)?.forEach((listener) => listener(event));
      fire("pointerdown", pointerEvent(centerX));
      expect(sceneCapture.controlsEnabled).toBe(false);
      fire("pointermove", pointerEvent(centerX + 40));
      fire("pointerup", pointerEvent(centerX + 40));

      expect(drafts).toHaveBeenLastCalledWith(expect.objectContaining({ type: "CREATE_ORBITAL_BODY", primaryId: primary.id, planeNormal: expect.any(Array), radialDirection: expect.any(Array) }));
      expect(sceneCapture.controlsEnabled).toBe(true);
      expect(committed).not.toHaveBeenCalled();
      const draftCount = drafts.mock.calls.length;
      fire("pointerdown", pointerEvent(centerX));
      fire("pointermove", pointerEvent(centerX + 40));
      const callsBeforeChangedViewUp = drafts.mock.calls.length;
      state.viewRequest = 1;
      fire("pointerup", pointerEvent(centerX + 40));
      expect(drafts.mock.calls.slice(callsBeforeChangedViewUp).filter(([draft]) => draft !== null)).toHaveLength(0);
      expect(drafts).toHaveBeenLastCalledWith(null);
      expect(committed).not.toHaveBeenCalled();

      fire("pointerdown", pointerEvent(centerX));
      fire("pointermove", pointerEvent(centerX + 40));
      fire("pointercancel", pointerEvent(centerX + 40));
      expect(drafts).toHaveBeenLastCalledWith(null);
      expect(drafts.mock.calls.length).toBeGreaterThan(draftCount);
      expect(sceneCapture.controlsEnabled).toBe(true);
      expect(committed).not.toHaveBeenCalled();
    } finally { dispose(); }
  });
});

describe("orbital mutation preview ghosts", () => {
  it("renders only current Core candidates as disposable non-pickable ghosts", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const primary = createSolarSystem()[3]!;
    let state: CelestialSceneState = {
      bodies: [primary], selectedBodyId: primary.id, gravity: NEWTONIAN_G, simulationTime: 20, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 4, simulationRunning: false,
      historySnapshot: { bodies: [primary], timeSeconds: 20, revision: 4, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
      orbitalPreview: { type: "ORBITAL_MUTATION_PREVIEW", version: 1, requestId: 3, worldRevision: 4, baseTimeSeconds: 20,
        result: { status: "ready", candidates: [{ bodyId: "preview-moon", positionM: [4e8, 0, 0], velocityMs: [0, 1, 0] }] } },
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      const previewGroup = sceneCapture.scene!.getObjectByName("orbital-mutation-preview-ghosts") as THREE.Group;
      const ghost = previewGroup.children[0] as THREE.Mesh;
      const disposeGeometry = vi.spyOn(ghost.geometry, "dispose"), disposeMaterial = vi.spyOn(ghost.material as THREE.Material, "dispose");
      expect(ghost.name).toBe("orbital-preview:preview-moon");
      expect(ghost.userData.nonPickable).toBe(true);
      expect(sceneCapture.bodyGroups.has("preview-moon")).toBe(false);

      state = { ...state, orbitalPreview: { ...state.orbitalPreview!, worldRevision: 3 } };
      frame(16);
      expect(previewGroup.children).toHaveLength(0);
      expect(disposeGeometry).toHaveBeenCalledOnce();
      expect(disposeMaterial).toHaveBeenCalledOnce();
    } finally { dispose(); }
  });
});

describe("accepted surface relief", () => {
  it("forwards accepted patches and refreshes a visual on payload update and removal", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const metadata = { modelId: "sparse-relief-v1" as const, seed: 7, revision: 1, resolution: 64 as const, dataId: "scene-relief" };
    const body = { ...createSolarSystem()[3]!, id: "scene-relief", surface: metadata };
    let state: CelestialSceneState = {
      bodies: [body], selectedBodyId: body.id, gravity: 0, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies: [body], timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0,
      collisionMode: "scientific", rotatingFrame: false, surfaceData: { "scene-relief": [{ cellIndex: 1, elevationM: 100 }] }, surfaceHeatData: { "scene-relief": [] },
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      expect(sceneCapture.visualCreations.at(-1)).toMatchObject({ bodyId: body.id, patchCount: 1, patchElevations: [100] });
      state = { ...state, surfaceHeatData: { "scene-relief": [{ cellIndex: 4, energyJ: 1e15 }] } };
      frame(12);
      expect(sceneCapture.surfaceHeatUpdates.at(-1)).toEqual({ bodyId: body.id, patches: [{ cellIndex: 4, energyJ: 1e15 }] });
      expect(sceneCapture.visualCreations).toHaveLength(1);
      state = { ...state, surfaceData: { "scene-relief": [{ cellIndex: 1, elevationM: 200 }] } };
      frame(25);
      expect(sceneCapture.visualCreations).toHaveLength(2);
      expect(sceneCapture.visualCreations.at(-1)).toMatchObject({ bodyId: body.id, patchCount: 1, patchElevations: [200] });
      expect(sceneCapture.visualDisposals).toContain(body.id);
      state = { ...state, bodies: [{ ...body, surface: { ...metadata, revision: 2 } }], surfaceData: { "scene-relief": [] } };
      frame(50);
      expect(sceneCapture.visualCreations).toHaveLength(3);
      expect(sceneCapture.visualCreations.at(-1)).toMatchObject({ bodyId: body.id, patchCount: 0, patchElevations: [] });
    } finally { dispose(); }
  });

  it("keeps the focused body label mounted while its surface visual is refreshed", async () => {
    const buttons: Array<{ className: string; removed: boolean; remove(): void }> = [];
    let activeElement: unknown;
    const node = (tag = "div") => {
      const element = {
        style: { cssText: "" }, dataset: {}, className: "", removed: false,
        appendChild() {}, append() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} },
        remove() { this.removed = true; if (activeElement === this) activeElement = undefined; },
      };
      if (tag === "button") buttons.push(element);
      return element;
    };
    vi.stubGlobal("document", {
      createElement: node,
      createElementNS: (_namespace: string, tag: string) => node(tag),
      get activeElement() { return activeElement; },
      set activeElement(value: unknown) { activeElement = value; },
    });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const metadata = { modelId: "sparse-relief-v1" as const, seed: 7, revision: 1, resolution: 64 as const, dataId: "focused-relief" };
    const body = { ...createSolarSystem()[3]!, id: "focused-relief", surface: metadata };
    let state: CelestialSceneState = {
      bodies: [body], selectedBodyId: body.id, gravity: 0, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies: [body], timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0,
      collisionMode: "scientific", rotatingFrame: false, surfaceData: { "focused-relief": [{ cellIndex: 1, elevationM: 100 }] },
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      const bodyLabels = () => buttons.filter((button) => button.className === "scene-body-label");
      const focusedLabel = bodyLabels()[0]!;
      activeElement = focusedLabel;
      state = { ...state, surfaceData: { "focused-relief": [{ cellIndex: 1, elevationM: 200 }] } };
      frame(25);

      expect(bodyLabels()).toHaveLength(1);
      expect(focusedLabel.removed).toBe(false);
      expect(document.activeElement).toBe(focusedLabel);
      expect(sceneCapture.visualCreations).toHaveLength(2);
    } finally { dispose(); }
  });
});

describe("replaced body appearance", () => {
  it("resets the displayed radius cache when a visual replacement is accepted", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    let state: CelestialSceneState = {
      bodies: [earth], selectedBodyId: earth.id, gravity: NEWTONIAN_G, simulationTime: 0,
      showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1,
      historySnapshot: { bodies: [earth], timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0,
      collisionMode: "scientific", rotatingFrame: false, simulationRunning: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      frame(0);
      const expandedEarth = { ...earth, bodyType: "gas-giant" as const, radiusM: earth.radiusM * 2 };
      state = { ...state, bodies: [expandedEarth], revision: 2, historySnapshot: { bodies: [expandedEarth], timeSeconds: 0, revision: 2, generation: 0 } };
      frame(16);

      const latestAppearance = sceneCapture.rotations.filter((entry) => entry.body.id === earth.id).at(-1)?.appearanceBody;
      expect(latestAppearance?.radiusM).toBe(expandedEarth.radiusM);
    } finally { dispose(); }
  });
});

describe("accepted thermal and spin presentation", () => {
  it("forwards accepted appearance and uses accepted spin time while running and paused", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const initialBodies = createSolarSystem().map((body) => body.id === "earth"
      ? { ...body, thermalProfileId: "earthlike-global-mean-v1" as const, surfaceTemperatureK: 288,
        spin: { modelId: "rigid-body-spin-v1" as const, axisUnitWorld: [0, 1, 0] as const, phaseAtEpochRad: 0, angularVelocityRadPerS: 2 * Math.PI / 86_164 } }
      : body);
    let state: CelestialSceneState = {
      bodies: initialBodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies: initialBodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      sceneCapture.rotations = [];
      const acceptedEarth = { ...initialBodies.find((body) => body.id === "earth")!, surfaceTemperatureK: 310 };
      const acceptedBodies = initialBodies.map((body) => body.id === "earth" ? acceptedEarth : body);
      state = {
        ...state, bodies: acceptedBodies, simulationTime: 600, simulationRunning: true,
        historySnapshot: { bodies: acceptedBodies, timeSeconds: 600, revision: 1, generation: 0 },
      };
      frame(16);
      expect(sceneCapture.rotations.slice().reverse().find(({ body }) => body.id === "earth")).toMatchObject({
        body: acceptedEarth,
        simulationTime: 600,
        appearanceBody: { radiusM: acceptedEarth.radiusM, surfaceTemperatureK: 310 },
      });
      expect(sceneCapture.rotations.slice().reverse().find(({ body }) => body.id === "earth")?.simulationTime).toBe(600);
      state = { ...state, simulationRunning: false };
      frame(33);
      expect(sceneCapture.rotations.slice().reverse().find(({ body }) => body.id === "earth")?.simulationTime).toBe(600);
    } finally { dispose(); }
  });
});

describe("focused black-hole appearance", () => {
  it("updates the same body's envelope once, then preserves manual pan and zoom", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const earth = { ...createSolarSystem().find((body) => body.id === "earth")!, positionM: [0, 0, 0] as const };
    let state: CelestialSceneState = {
      bodies: [earth], selectedBodyId: earth.id, gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "focus", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies: [earth], timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      frame(1000);
      const camera = sceneCapture.camera!, target = sceneCapture.target!, cursor = sceneCapture.cursor!;
      const earthFitDistance = camera.position.distanceTo(target);
      const earthEnvelope = sceneCapture.bodyGroups.get(earth.id)!.scale.x;
      const hole = { ...earth, bodyType: "black-hole" as const };
      state = { ...state, bodies: [hole], revision: 2, historySnapshot: { bodies: [hole], timeSeconds: 0, revision: 2, generation: 0 } };
      frame(1016);
      frame(1900);

      expect(sceneCapture.bodyGroups.get(earth.id)!.scale.x).not.toBe(earthEnvelope);
      const holeEnvelope = sceneCapture.bodyGroups.get(earth.id)!.scale.x;
      const refitDistance = camera.position.distanceTo(target);
      expect(Math.abs(refitDistance - earthFitDistance)).toBeGreaterThan(earthFitDistance * 0.5);

      const pan = new THREE.Vector3(0.012, 0.018, -0.006);
      target.add(pan); cursor.add(pan); camera.position.add(pan);
      camera.position.sub(target).multiplyScalar(1.7).add(target);
      const manualPosition = camera.position.clone(), manualTarget = target.clone(), manualCursor = cursor.clone();
      state = { ...state, revision: 3, historySnapshot: { bodies: [hole], timeSeconds: 0, revision: 3, generation: 0 } };
      frame(2000);

      expect(camera.position.distanceTo(manualPosition)).toBeLessThan(1e-10);
      expect(target.distanceTo(manualTarget)).toBeLessThan(1e-10);
      expect(cursor.distanceTo(manualCursor)).toBeLessThan(1e-10);
      expect(camera.position.distanceTo(target)).toBeCloseTo(manualPosition.distanceTo(manualTarget));
      expect(sceneCapture.bodyGroups.get(earth.id)!.scale.x).toBe(holeEnvelope);
    } finally { dispose(); }
  });
});

describe("focused neutron-star framing", () => {
  it("fits the physical neutron-star surface inside the useful safe viewport", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    let resize: ResizeObserverCallback = () => {};
    const observedTargets: Element[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe(target: Element) { observedTargets.push(target); } disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const solarSystem = createSolarSystem();
    const neutronStar = createCatalogBody("neutron-star", solarSystem, "sun", { gravitationalConstant: NEWTONIAN_G });
    const bodies = [...solarSystem, neutronStar];
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "sun", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const makeOverlay = (left: number, top: number, width: number, height: number) => ({ ...node(), getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height, width, height }) });
    const overlays = new Map([
      [".object-rail", makeOverlay(1052, 138, 360, 650)],
      [".planet-navigation", makeOverlay(28, 721, 1046, 67)],
      [".scene-tools", makeOverlay(30, 82, 650, 44)],
      [".experiment-dock", makeOverlay(18, 138, 164, 350)],
    ]);
    const shell = { querySelector: (selector: string) => overlays.get(selector), querySelectorAll: () => [...overlays.values()] };
    const host = { ...node(), clientWidth: 1440, clientHeight: 900, closest: (selector: string) => selector === ".astro-shell" ? shell : null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1440, width: 1440, height: 900, bottom: 900 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(observedTargets).toEqual([host, ...overlays.values()]);
      resize(observedTargets.map((target) => ({ target }) as ResizeObserverEntry), {} as ResizeObserver);
      frame(0);
      frame(1000);
      state = { ...state, viewMode: "focus", viewRequest: 1 };
      frame(1016);
      frame(1900);
      state = { ...state, selectedBodyId: neutronStar.id, viewMode: "system", viewRequest: 2 };
      frame(1916);
      frame(2800);
      state = { ...state, viewMode: "focus", viewRequest: 3 };
      frame(2816);
      frame(3700);

      const group = sceneCapture.bodyGroups.get(neutronStar.id)!;
      const surface = group.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh;
      const camera = sceneCapture.camera!;
      const target = sceneCapture.target!;
      const safeViewport = getSafeCameraViewport(host as unknown as HTMLElement);
      expect(safeViewport).toEqual({ left: 206, top: 148, right: 1022, bottom: 696 });
      camera.updateMatrixWorld(true);
      surface.updateWorldMatrix(true, false);
      surface.geometry.computeBoundingSphere();
      const surfaceRadius = group.scale.x * surface.geometry.boundingSphere!.radius;
      const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const center = surface.getWorldPosition(new THREE.Vector3());
      const left = center.clone().addScaledVector(cameraRight, -surfaceRadius).project(camera);
      const right = center.clone().addScaledVector(cameraRight, surfaceRadius).project(camera);
      const projectedSurfaceDiameter = Math.abs(right.x - left.x) * host.clientWidth / 2;
      const usefulViewport = Math.min(safeViewport.right - safeViewport.left, safeViewport.bottom - safeViewport.top);
      const diameterFraction = projectedSurfaceDiameter / usefulViewport;
      expect(target.distanceTo(group.position)).toBeLessThan(1e-10);
      expect(diameterFraction).toBeGreaterThanOrEqual(0.5);
      expect(diameterFraction).toBeLessThanOrEqual(0.95);
      expect(neutronStar.radiusM).toBe(12_000);
      expect(group.scale.x).toBe(neutronStar.radiusM * 1e-9);
    } finally { dispose(); }
  });
});

describe("active scene label placement", () => {
  it("passes the safe effect viewport to collision scaling in focus mode", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const earth = { ...createSolarSystem().find((body) => body.id === "earth")!, positionM: [0, 0, 0] as const };
    const bodies = [earth];
    const collision: SimulationEvent = { id: 81, type: "collision", timeSeconds: 0, positionM: [0, 0, 0], radiusM: 1e6, energyJ: 1e20, bodyIds: [earth.id, "mars"] };
    const state: CelestialSceneState = {
      bodies, selectedBodyId: earth.id, gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "focus", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [collision], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 320, clientHeight: 740, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 740, bottom: 740 }) };
    const update = vi.spyOn(SceneEventEffects.prototype, "update");
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      expect(update.mock.calls.at(-1)?.[3]).toEqual(expect.objectContaining({ left: 30, top: 142, right: 290, width: 320, height: 740 }));
    } finally { dispose(); }
  });

  it("hides a focused label when no non-overlapping slot fits", async () => {
    const created: Array<{ className?: string; style: Record<string, string>; attributes: Map<string, string> }> = [];
    const node = () => {
      const element = {
        style: { cssText: "" } as Record<string, string>, attributes: new Map<string, string>(), dataset: {},
        appendChild() {}, append() {}, remove() {}, setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} },
      };
      created.push(element);
      return element;
    };
    let activeElement: unknown;
    vi.stubGlobal("document", { createElement: node, createElementNS: node, get activeElement() { return activeElement; } });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    const bodies = [{ ...earth, positionM: [0, 0, 0] as const }];
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 320, clientHeight: 740, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 740, bottom: 740 }) };
    const navigationButton = {};
    let label: (typeof created)[number] | undefined;
    const focusTransfers: Array<{ bodyId: string; labelDisplay: string | undefined }> = [];
    vi.mocked(sceneLabels.layoutFocusLabel).mockReturnValueOnce(null);
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, {
      read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {},
      onFocusNavigationFallback: (bodyId: string) => {
        focusTransfers.push({ bodyId, labelDisplay: label?.style.display });
        activeElement = navigationButton;
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      label = created.find((element) => element.className === "scene-body-label" && element.attributes.get("aria-label") === `Selecionar ${earth.name}`)!;
      expect(label.style.display).toBe("block");
      activeElement = label;
      state.viewMode = "focus";
      frame(16);

      expect(vi.mocked(sceneLabels.layoutFocusLabel)).toHaveBeenCalled();
      expect(focusTransfers).toEqual([{ bodyId: earth.id, labelDisplay: "block" }]);
      expect(activeElement).toBe(navigationButton);
      expect(label.style.display).toBe("none");
    } finally { dispose(); }
  });

  it("clamps long keyboard-focused labels when their placement slot disappears", async () => {
    const created: Array<{ className?: string; style: Record<string, string>; attributes: Map<string, string>; tabIndex?: number }> = [];
    const node = () => {
      const element = {
        style: { cssText: "" } as Record<string, string>, attributes: new Map<string, string>(), dataset: {},
        appendChild() {}, append() {}, remove() {}, setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} },
      };
      created.push(element);
      return element;
    };
    const longName = "A very long body name that exceeds a narrow canvas";
    let activeElement: unknown;
    vi.stubGlobal("document", { createElement: node, createElementNS: node, get activeElement() { return activeElement ?? created.find((element) => element.className === "scene-body-label" && element.attributes.get("aria-label") === `Selecionar ${longName}`); } });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    let resize: ResizeObserverCallback = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    const bodies = [{ ...earth, positionM: [0, 0, 0] as const }, { ...earth, id: "keyboard", name: longName, positionM: [0, 0, 0] as const }];
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    let width = 400, height = 400;
    const host = {
      ...node(), get clientWidth() { return width; }, get clientHeight() { return height; }, closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height, bottom: height }),
    };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      const label = created.find((element) => element.className === "scene-body-label" && element.attributes.get("aria-label") === `Selecionar ${longName}`)!;
      activeElement = label;
      expect(label.style.left).not.toBe("");
      expect(label.style.top).not.toBe("");
      const previousLeft = label.style.left;
      const previousTop = label.style.top;

      width = 60;
      height = 24;
      resize([{ target: host } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      vi.mocked(sceneLabels.layoutSceneLabels).mockReturnValueOnce([]);
      frame(16);

      expect(label.style.display).toBe("block");
      expect(label.style.opacity).toBe("1");
      expect(label.tabIndex).toBe(0);
      expect(label.style.maxWidth).toBe(`${width}px`);
      expect(label.style.overflow).toBe("hidden");
      expect(label.style.textOverflow).toBe("ellipsis");
      expect(label.style.whiteSpace).toBe("nowrap");
      expect(label.style.left).toBe("30px");
      expect(label.style.top).toBe("12px");
      expect(label.style.left).not.toBe(previousLeft);
      expect(label.style.top).not.toBe(previousTop);
      const safeLabelWidth = Number.parseFloat(label.style.maxWidth);
      expect(safeLabelWidth).toBeLessThanOrEqual(width);
      expect(Number.parseFloat(label.style.left) - safeLabelWidth / 2).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(label.style.left) + safeLabelWidth / 2).toBeLessThanOrEqual(width);
      expect(Number.parseFloat(label.style.top) - 12).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(label.style.top) + 12).toBeLessThanOrEqual(height);
    } finally { dispose(); }
  });

  it("syncs selected styling when the system layout falls back without a placement", async () => {
    const created: Array<{ className?: string; style: Record<string, string>; attributes: Map<string, string>; classes: Set<string> }> = [];
    const node = () => {
      const classes = new Set<string>();
      const element = {
        style: { cssText: "" } as Record<string, string>, attributes: new Map<string, string>(), classes, dataset: {},
        appendChild() {}, append() {}, remove() {}, setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        addEventListener() {}, classList: {
          toggle(name: string, force?: boolean) { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); },
          add(name: string) { classes.add(name); }, remove(name: string) { classes.delete(name); },
        },
      };
      created.push(element);
      return element;
    };
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const earth = { ...createSolarSystem().find((body) => body.id === "earth")!, positionM: [0, 0, 0] as const };
    const bodies = [earth];
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 400, clientHeight: 400, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 400 }) };
    vi.mocked(sceneLabels.layoutSceneLabels).mockReturnValueOnce([]);
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      const label = created.find((element) => element.className === "scene-body-label" && element.attributes.get("aria-label") === `Selecionar ${earth.name}`)!;
      expect(label.style.display).toBe("block");
      expect(label.classes.has("is-selected")).toBe(true);
    } finally { dispose(); }
  });
});

describe("trajectory preview rendering", () => {
  it("draws an approximate path and contact marker only while placement is active", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem();
    const placementBody = { ...bodies[0]!, id: "placement-preview", name: "Asteroide · prévia", parentId: undefined };
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", placementBody, gravity: NEWTONIAN_G, simulationTime: 0,
      showOrbits: false, viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0,
      collisionMode: "scientific", rotatingFrame: false, trajectoryPreviewStatus: "idle",
      trajectoryPreview: { points: [[0, 0, 0], [1e7, 0, 0], [2e7, 1e7, 0]], contact: { timeSeconds: 12, positionM: [2e7, 1e7, 0], bodyIds: ["earth", "trajectory-preview-1"] } },
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      frame(0);
      frame(16);
      const group = sceneCapture.scene!.getObjectByName("trajectory-preview-visual-only") as THREE.Group;
      expect(group.visible).toBe(true);
      expect(group.getObjectByName("approximate-trajectory-preview")).toBeInstanceOf(THREE.Line);
      expect(group.getObjectByName("trajectory-preview-contact-marker")?.visible).toBe(true);

      state = { ...state, placementBody: null, trajectoryPreview: null, trajectoryPreviewStatus: "idle" };
      frame(32);
      expect(group.visible).toBe(false);
      expect(group.getObjectByName("approximate-trajectory-preview")).toBeUndefined();
    } finally { dispose(); }
  });
});

describe("UV sphere geometry resilience", () => {
  it("creates a UV sphere when the loaded geometry is missing UV coordinates", async () => {
    const { selectUvSphereGeometry } = await import("./celestial-scene");
    const modelGeometry = new THREE.BufferGeometry();
    const geometry = selectUvSphereGeometry(modelGeometry);

    expect(geometry).not.toBe(modelGeometry);
    expect(geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(geometry.getAttribute("uv")).toBeDefined();
    geometry.dispose();
    modelGeometry.dispose();
  });

  it("reuses loaded geometry when it already has UV coordinates", async () => {
    const { selectUvSphereGeometry } = await import("./celestial-scene");
    const modelGeometry = new THREE.SphereGeometry(1, 8, 4);
    const createFallback = vi.fn(() => new THREE.SphereGeometry());

    expect(selectUvSphereGeometry(modelGeometry, createFallback)).toBe(modelGeometry);
    expect(createFallback).not.toHaveBeenCalled();
    modelGeometry.dispose();
  });

  it("surfaces an error only when the fallback geometry also has no UVs", async () => {
    const { selectUvSphereGeometry } = await import("./celestial-scene");
    const modelGeometry = new THREE.BufferGeometry();
    const fallback = new THREE.BufferGeometry();
    const disposeModel = vi.spyOn(modelGeometry, "dispose");
    const disposeFallback = vi.spyOn(fallback, "dispose");

    expect(() => selectUvSphereGeometry(modelGeometry, () => fallback)).toThrow("Fallback sphere has no UV coordinates.");
    expect(disposeModel).toHaveBeenCalledOnce();
    expect(disposeFallback).toHaveBeenCalledOnce();
  });

  it("uses one shared fallback for all bodies and disposes it once at scene teardown", async () => {
    sceneCapture.sphereLoadFails = true;
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem();
    const onLoaded = vi.fn(), onError = vi.fn();
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, {
      read: () => ({ bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1,
        historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false, simulationRunning: false }),
      onSelect() {}, onPlaceBody() {}, onLoaded, onError, onRotatingFrameChange() {},
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      frame(0);
      expect(onLoaded).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(sceneCapture.bodyGeometries).toHaveLength(bodies.length);
      const sharedGeometry = sceneCapture.bodyGeometries[0]!;
      expect(sharedGeometry).toBeInstanceOf(THREE.SphereGeometry);
      expect(sharedGeometry.getAttribute("uv")).toBeDefined();
      expect(sceneCapture.bodyGeometries.every((geometry) => geometry === sharedGeometry)).toBe(true);
      const disposeGeometry = vi.spyOn(sharedGeometry, "dispose");

      dispose();

      expect(disposeGeometry).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });
});

describe("scene resolution tier and late rock maps", () => {
  it("rebuilds the environment and body maps only when resize crosses the tier breakpoint", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { sceneCapture.resizeObserver = callback; }
      observe() {} disconnect() {}
    });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    sceneCapture.maxTextureSize = 8192;
    const bodies = createSolarSystem();
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, environmentSeed: 123, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 767, clientHeight: 600, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 600 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      frame(0);
      const initialVisualCount = sceneCapture.visualCreations.length;
      expect(sceneCapture.environmentResolutions).toEqual([false]);
      expect(sceneCapture.environmentSeeds).toEqual([123]);
      expect(sceneCapture.visualCreations.every((visual) => !visual.highResolution)).toBe(true);

      const resizeTo = (width: number) => {
        host.clientWidth = width;
        sceneCapture.resizeObserver?.([{ target: host as unknown as Element } as ResizeObserverEntry], {} as ResizeObserver);
      };
      resizeTo(768);
      expect(sceneCapture.environmentResolutions).toEqual([false, true]);
      expect(sceneCapture.environmentSeeds).toEqual([123, 123]);
      expect(sceneCapture.environmentDisposals).toBe(1);
      expect(sceneCapture.environmentGroups[0]?.parent).toBeNull();
      expect(sceneCapture.visualCreations).toHaveLength(initialVisualCount * 2);
      expect(sceneCapture.visualCreations.slice(initialVisualCount).every((visual) => visual.highResolution)).toBe(true);
      expect(sceneCapture.visualDisposals).toHaveLength(initialVisualCount);

      resizeTo(820);
      expect(sceneCapture.environmentResolutions).toEqual([false, true]);
      expect(sceneCapture.visualCreations).toHaveLength(initialVisualCount * 2);

      resizeTo(767);
      expect(sceneCapture.environmentResolutions).toEqual([false, true, false]);
      expect(sceneCapture.environmentSeeds).toEqual([123, 123, 123]);
      expect(sceneCapture.environmentDisposals).toBe(2);
      expect(sceneCapture.visualCreations).toHaveLength(initialVisualCount * 3);
      expect(sceneCapture.visualCreations.slice(initialVisualCount * 2).every((visual) => !visual.highResolution)).toBe(true);
      state.environmentSeed = 456;
      frame(100);
      expect(sceneCapture.environmentSeeds).toEqual([123, 123, 123, 456]);
    } finally { dispose(); }
  });

  it("applies late rock maps to generic rocky planets in place, preserving Earth and materialization", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let resolveAssets!: (assets: import("./rock-assets").RockSurfaceAssets) => void;
    sceneCapture.rockAssetsPromise = new Promise((resolve) => { resolveAssets = resolve; });
    const bodies = createSolarSystem();
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      frame(0);
      const earth = bodies.find((body) => body.id === "earth")!;
      const rockyPlanet: CelestialBody = { ...earth, id: "generic-rocky-1", name: "Planeta rochoso 1", bodyType: "rocky-planet", positionM: [earth.positionM[0] + 1e8, earth.positionM[1], earth.positionM[2]] };
      const nextBodies = [...bodies, rockyPlanet];
      state = { ...state, bodies: nextBodies, revision: 2, historySnapshot: { bodies: nextBodies, timeSeconds: 0, revision: 2, generation: 0 } };
      frame(16);
      const group = sceneCapture.bodyGroups.get(rockyPlanet.id)!;
      const surface = group.children[0]!;
      const position = group.position.clone(), scale = group.scale.clone();
      const materialization = group.getObjectByName("accepted-body-materialization");
      expect(materialization).toBeDefined();
      const visualCount = sceneCapture.visualCreations.length;
      const diffuse = new THREE.Texture(), roughness = new THREE.Texture();

      resolveAssets({ diffuse, roughness, dispose() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sceneCapture.rockSurfaceApplications).toContain(rockyPlanet.id);
      expect(sceneCapture.rockSurfaceApplications).not.toContain("earth");
      expect(sceneCapture.visualCreations).toHaveLength(visualCount);
      expect(sceneCapture.bodyGroups.get(rockyPlanet.id)).toBe(group);
      expect(group.children[0]).toBe(surface);
      expect(group.getObjectByName("accepted-body-materialization")).toBe(materialization);
      expect(materialization?.parent).toBe(group);
      expect(group.position.toArray()).toEqual(position.toArray());
      expect(group.scale.toArray()).toEqual(scale.toArray());
    } finally { dispose(); }
  });
});

describe("orbit visibility in the scene loop", () => {
  it("skips hidden orbit calculations and refreshes current state immediately when shown", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem();
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0,
      showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false, simulationRunning: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      frame(1);
      frame(100);
      expect(refreshOrbitPaths).not.toHaveBeenCalled();
      expect(createOrbitPaths).not.toHaveBeenCalled();
      state = { ...state, showOrbits: true };
      frame(101);
      expect(createOrbitPaths).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createOrbitPaths).mock.results[0]!.value.children.length).toBeGreaterThan(0);
      vi.mocked(refreshOrbitPaths).mockClear();
      state = { ...state, showOrbits: false };
      frame(102);
      state = { ...state, showOrbits: true };
      frame(103);
      expect(refreshOrbitPaths).toHaveBeenCalledTimes(1);
      vi.mocked(refreshOrbitPaths).mockClear();
      state = { ...state, showOrbits: false };
      frame(104);
      state = { ...state, gravity: 0, revision: 2, bodies: bodies.slice(0, 2) };
      frame(105);
      expect(refreshOrbitPaths).not.toHaveBeenCalled();
      state = { ...state, showOrbits: true };
      frame(106);
      expect(refreshOrbitPaths).toHaveBeenCalledTimes(1);
      expect(vi.mocked(refreshOrbitPaths).mock.calls[0]![1].map((body) => body.id)).toEqual(state.bodies.map((body) => body.id));
      expect(vi.mocked(refreshOrbitPaths).mock.calls[0]![2]).toBe(0);
      expect(vi.mocked(createOrbitPaths).mock.results.at(-1)!.value.children).toHaveLength(0);
    } finally { dispose(); }
  });

  it("skips periodic orbit recalculation while paused but resumes it with motion", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem();
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: true,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      vi.mocked(refreshOrbitPaths).mockClear();
      frame(60);
      expect(refreshOrbitPaths).not.toHaveBeenCalled();
      state = { ...state, revision: 2 };
      frame(61);
      expect(refreshOrbitPaths).toHaveBeenCalledOnce();
      vi.mocked(refreshOrbitPaths).mockClear();
      state = { ...state, simulationRunning: true };
      frame(122);
      expect(refreshOrbitPaths).toHaveBeenCalledOnce();
    } finally { dispose(); }
  });

  it("keeps historical trails hidden by default and skips geometry refresh until enabled", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem();
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0,
      showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false, simulationRunning: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      sceneCapture.scene = null;
      frame(0);
      const trail = sceneCapture.scene!.children.find((child) => child instanceof THREE.LineSegments) as THREE.LineSegments;
      expect(trail.visible).toBe(false);
      expect(trail.geometry.drawRange.count).toBe(Infinity);
      state = { ...state, showTrails: true };
      frame(1);
      expect(trail.visible).toBe(true);
      expect(trail.geometry.drawRange.count).toBeGreaterThan(0);
      const sun = bodies.find((body) => body.id === "sun")!;
      const earth = bodies.find((body) => body.id === "earth")!;
      const radius = Math.hypot(earth.positionM[0] - sun.positionM[0], earth.positionM[1] - sun.positionM[1]);
      const initialAngle = Math.atan2(earth.positionM[1] - sun.positionM[1], earth.positionM[0] - sun.positionM[0]);
      const samples = [10, 20].map((degrees, index) => {
        const angle = initialAngle + degrees * Math.PI / 180;
        const positionM = [sun.positionM[0] + radius * Math.cos(angle), sun.positionM[1] + radius * Math.sin(angle), earth.positionM[2]] as const;
        return { offsetSeconds: (index + 1) * 10_000, bodies: [{ id: "sun", positionM: sun.positionM }, { id: "earth", positionM }] };
      });
      const endpointBodies = bodies.map((body) => body.id === "earth" ? { ...body, positionM: samples[1]!.bodies[1]!.positionM } : body);
      state = { ...state, bodies: endpointBodies, simulationTime: 20_000, historySnapshot: { bodies: endpointBodies, timeSeconds: 20_000, revision: 1, generation: 0,
        integrationSamples: { version: 1, startTimeSeconds: 0, endTimeSeconds: 20_000, samples } } };
      frame(2);
      expect(trail.geometry.drawRange.count).toBeGreaterThanOrEqual(3);
      state = { ...state, showTrails: false };
      frame(2);
      expect(trail.visible).toBe(false);
      expect(trail.geometry.drawRange.count).toBeGreaterThan(0);
    } finally { dispose(); }
  });

  it("renders paused scenes at 15 fps and keeps full cadence while simulation runs", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node, visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = createSolarSystem();
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "sun", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false, rotatingFrame: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific",
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      frame(16);
      frame(32);
      frame(66);
      expect(sceneCapture.renders).toBe(1);
      frame(67);
      expect(sceneCapture.renders).toBe(2);
      frame(1000);
      expect(JSON.parse((host.dataset as Record<string, string>).renderMetrics!).drawCalls).toBe(1);
      expect(JSON.parse((host.dataset as Record<string, string>).renderMetrics!).triangles).toBe(0);
      state = { ...state, simulationRunning: true };
      frame(1016);
      frame(1032);
      expect(sceneCapture.renders).toBe(5);
    } finally { dispose(); }
  });

  it("stops scheduling hidden-tab frames and resumes without a stale pause", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    const listeners = new Map<string, () => void>();
    const documentStub = { createElement: node, createElementNS: node, visibilityState: "visible", addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) };
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {}, scheduledFrames = 0, cancelledFrames = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; scheduledFrames += 1; return scheduledFrames; });
    vi.stubGlobal("cancelAnimationFrame", () => { cancelledFrames += 1; });
    const bodies = createSolarSystem();
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "sun", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false, rotatingFrame: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific",
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      expect(sceneCapture.renders).toBe(1);
      const scheduledBeforeHide = scheduledFrames;
      documentStub.visibilityState = "hidden";
      listeners.get("visibilitychange")?.();
      expect(sceneCapture.renders).toBe(1);
      expect(cancelledFrames).toBe(1);
      expect(scheduledFrames).toBe(scheduledBeforeHide);
      documentStub.visibilityState = "visible";
      listeners.get("visibilitychange")?.();
      expect(scheduledFrames).toBe(scheduledBeforeHide + 1);
      frame(5000);
      expect(sceneCapture.renders).toBe(2);
      expect(scheduledFrames).toBe(scheduledBeforeHide + 2);
    } finally { dispose(); }
  });
});

describe("solar light evolution", () => {
  it("updates the dominant light in place across solar, giant, and white-dwarf states", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    sceneCapture.scene = null;
    const solar = createSolarSystem();
    let state: CelestialSceneState = {
      bodies: solar, selectedBodyId: "sun", gravity: NEWTONIAN_G, simulationTime: 0,
      showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1,
      historySnapshot: { bodies: solar, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false, simulationRunning: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(1);
      const light = sceneCapture.scene!.children.find((child) => child instanceof THREE.PointLight) as THREE.PointLight;
      expect(light.intensity).toBeCloseTo(1.6);
      const solarColor = light.color.clone();
      const giantBodies = solar.map((body) => body.id === "sun" ? { ...body, radiusM: 7e9, surfaceTemperatureK: 3500 } : body);
      state = { ...state, bodies: giantBodies, revision: 2, historySnapshot: { ...state.historySnapshot, bodies: giantBodies, revision: 2 } };
      frame(51);
      expect(sceneCapture.scene!.children.find((child) => child instanceof THREE.PointLight)).toBe(light);
      expect(light.intensity).toBeGreaterThan(1.6);
      expect(light.intensity).toBeLessThan(6.4);
      expect(light.color.equals(solarColor)).toBe(false);
      for (let now = 1000; now <= 2000; now += 100) frame(now);
      expect(light.intensity).toBeCloseTo(6.4, 0);
      const dwarfBodies = giantBodies.map((body) => body.id === "sun" ? { ...body, radiusM: 7e6, surfaceTemperatureK: 10000 } : body);
      state = { ...state, bodies: dwarfBodies, revision: 3, historySnapshot: { ...state.historySnapshot, bodies: dwarfBodies, revision: 3 } };
      frame(2050);
      expect(light.intensity).toBeCloseTo(6.4, 0);
      for (let now = 2150; now <= 3150; now += 100) frame(now);
      expect(light.intensity).toBeGreaterThan(0);
      expect(light.intensity).toBeLessThan(1.6);
    } finally { dispose(); }
  });

  it("lights a binary system from both accepted stars within the shared budget", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const solar = createSolarSystem(), primary = solar.find((body) => body.id === "sun")!;
    const secondary = { ...primary, id: "secondary", name: "Estrela B", positionM: [2e11, 0, 0] as const };
    const bodies = [...solar, secondary];
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "sun", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(0);
      const lights = sceneCapture.scene!.children.filter((child): child is THREE.PointLight => child instanceof THREE.PointLight);
      const activeLights = lights.filter((light) => light.visible);
      expect(lights).toHaveLength(4);
      expect(activeLights).toHaveLength(2);
      expect(activeLights.every((light) => light.intensity > 0)).toBe(true);
      expect(activeLights[0]!.position.distanceTo(activeLights[1]!.position)).toBeGreaterThan(0);
      expect(activeLights.reduce((total, light) => total + light.intensity, 0)).toBeLessThanOrEqual(6.4);
    } finally { dispose(); }
  });

  it("updates each body's distance factor and rendered eclipse blocker from accepted poses", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const au = 149_597_870_700;
    const solar = createSolarSystem();
    const source = { ...solar.find((body) => body.id === "sun")!, positionM: [0, 0, au] as const, radiusM: 1e9 };
    const target = { ...solar.find((body) => body.id === "earth")!, positionM: [0, 0, 0] as const };
    const occulter = { ...solar.find((body) => body.id === "moon")!, positionM: [0, 0, au / 2] as const, radiusM: 1e9 };
    let bodies: CelestialBody[] = [source, target, occulter];
    let state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "focus", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(1);
      const initial = sceneCapture.eclipseLighting.get("earth")?.[0];
      expect(initial?.distanceFactor).toBeCloseTo(1, 8);
      expect(initial?.blockerId).toBe("moon");

      bodies = [
        { ...source, positionM: [0, 0, 2 * au] as const },
        target,
        { ...occulter, positionM: [0.2 * au, 0, au / 2] as const },
      ];
      state = { ...state, bodies, revision: 2, historySnapshot: { ...state.historySnapshot, bodies, revision: 2 } };
      frame(17);
      const updated = sceneCapture.eclipseLighting.get("earth")?.[0];
      expect(updated?.distanceFactor).toBeLessThan(initial!.distanceFactor);
      expect(updated?.blockerId).toBeUndefined();
    } finally { dispose(); }
  });
});

describe("system framing with the inspector", () => {
  it.each([
    { name: "hidden desktop inspector", width: 1440, railWidth: 0, railHeight: 0, offsetX: 0, offsetY: 16.5 },
    { name: "zero-width inspector", width: 1440, railWidth: 0, railHeight: 600, offsetX: 0, offsetY: 16.5 },
    { name: "zero-height inspector", width: 1440, railWidth: 300, railHeight: 0, offsetX: 0, offsetY: 16.5 },
    { name: "visible desktop inspector", width: 1440, railWidth: 300, railHeight: 600, offsetX: 170, offsetY: 16.5 },
    { name: "hidden mobile inspector", width: 480, railWidth: 0, railHeight: 0, offsetX: 0, offsetY: 16.5 },
    { name: "visible mobile inspector", width: 480, railWidth: 300, railHeight: 600, offsetX: 0, offsetY: 229 },
  ])("reserves only visible area for a $name", async ({ width, railWidth, railHeight, offsetX, offsetY }) => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const setViewOffset = vi.spyOn(THREE.PerspectiveCamera.prototype, "setViewOffset");
    const bodies = createSolarSystem();
    const state: CelestialSceneState = {
      bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0,
      showOrbits: true, viewMode: "system", viewRequest: 0, revision: 1,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false, simulationRunning: false,
    };
    const root = { querySelector: (selector: string) => selector === ".object-rail"
      ? { getBoundingClientRect: () => ({ width: railWidth, height: railHeight, left: railWidth ? 1100 : 0, top: railHeight ? 300 : 0 }) }
      : { getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, bottom: 0 }) } };
    const host = { ...node(), clientWidth: width, clientHeight: 900, closest: () => root, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 900 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      frame(0);
      expect(setViewOffset).toHaveBeenLastCalledWith(width, 900, offsetX, offsetY, width, 900);
    } finally { dispose(); }
  });
});

describe("spontaneous collision camera stability", () => {
  it("preserves the spontaneous fusion pose, then refits a later accepted body expansion", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const sun = createSolarSystem().find((body) => body.id === "sun")!;
    const rockyBase = createSolarSystem().find((body) => body.id === "earth")!;
    const rockyA = { ...rockyBase, id: "qa-rocky-a", name: "QA rochoso A", bodyType: "rocky-planet" as const, radiusM: 70e6, positionM: [1e9, 0, 0] as const };
    const rockyB = { ...rockyBase, id: "qa-rocky-b", name: "QA rochoso B", bodyType: "rocky-planet" as const, radiusM: 70e6, positionM: [1.47e9, 0, 0] as const };
    const initialBodies = [sun, rockyA, rockyB];
    let state: CelestialSceneState = {
      bodies: initialBodies, selectedBodyId: "sun", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false,
      viewMode: "system", viewRequest: 7, revision: 1, simulationRunning: false,
      historySnapshot: { bodies: initialBodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false,
    };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      frame(0);
      const camera = sceneCapture.camera!, target = sceneCapture.target!, cursor = sceneCapture.cursor!;
      const before = { position: camera.position.toArray(), target: target.toArray(), cursor: cursor.toArray(), distance: camera.position.distanceTo(target) };
      const remnant = {
        ...rockyA, id: "qa-remnant", name: "QA remanescente", massKg: rockyA.massKg + rockyB.massKg,
        radiusM: 70e6 * 2 ** (1 / 3), positionM: [1.27e9, 0, 0] as const,
      };
      const fusion: SimulationEvent = {
        id: 1, type: "collision", timeSeconds: 200, positionM: [1.235e9, 0, 0], radiusM: 70e6, energyJ: 1e20,
        bodyIds: [rockyA.id, rockyB.id], outcome: { kind: "perfectly-inelastic-merge", modelId: "perfectly-inelastic-merge-v1", survivorBodyId: remnant.id },
      };
      const acceptedBodies = [sun, remnant];
      state = {
        ...state, bodies: acceptedBodies, simulationTime: 200, revision: 2,
        historySnapshot: { bodies: acceptedBodies, timeSeconds: 200, revision: 2, generation: 0 }, events: [fusion],
      };
      frame(16);
      const afterFusion = { position: camera.position.toArray(), target: target.toArray(), cursor: cursor.toArray(), distance: camera.position.distanceTo(target) };
      const fusionObserved = `before=${JSON.stringify(before)} afterFusion=${JSON.stringify(afterFusion)}`;
      expect(afterFusion.position, fusionObserved).toEqual(before.position);
      expect(afterFusion.target, fusionObserved).toEqual(before.target);
      expect(afterFusion.cursor, fusionObserved).toEqual(before.cursor);
      expect(afterFusion.distance, fusionObserved).toBeCloseTo(before.distance, 12);

      const distantRock = { ...rockyA, id: "qa-rocky-distant", name: "QA rochoso distante", positionM: [3e9, 0, 0] as const };
      const expandedBodies = [sun, remnant, distantRock];
      state = {
        ...state, bodies: expandedBodies, simulationTime: 201, revision: 3,
        historySnapshot: { bodies: expandedBodies, timeSeconds: 201, revision: 3, generation: 0 }, events: [],
      };
      frame(32);
      const afterExpansion = { position: camera.position.toArray(), target: target.toArray(), cursor: cursor.toArray(), distance: camera.position.distanceTo(target) };
      const refitObserved = `afterFusion=${JSON.stringify(afterFusion)} afterExpansion=${JSON.stringify(afterExpansion)}`;
      expect(afterExpansion.distance, refitObserved).toBeGreaterThan(afterFusion.distance);
    } finally { dispose(); }
  });
});

describe("rendered historical trail", () => {
  it("does not create a segment across an explicit collision gap", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24), 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial());
    const samples = [
      { timeSeconds: 0, positionM: [0, 0, 0] as const },
      { timeSeconds: 10, positionM: [1e9, 0, 0] as const },
      { timeSeconds: 20, positionM: [1e12, 0, 0] as const },
    ];
    refreshOrbitTrailLine(line, samples, undefined, [0, 0, 0], [], [10]);
    const positions = geometry.getAttribute("position");

    expect(geometry.drawRange.count).toBe(2);
    expect(positions.getX(0)).toBe(0);
    expect(positions.getX(1)).toBeCloseTo(1, 6);
    geometry.dispose();
    (line.material as THREE.Material).dispose();
  });

  it("keeps snapshot history and moves only the live tip with the current frame", () => {
    const scene = new THREE.Scene();
    const line = addOrbitTrailToScene(scene);
    const samples = [{ timeSeconds: 0, positionM: [0, 0, 0] as const }, { timeSeconds: 86_400, positionM: [10, 0, 0] as const }];
    refreshOrbitTrailLine(line, samples, [12, 2, 0], [0, 0, 0]);
    expect(scene.children).toContain(line);
    const positions = line.geometry.getAttribute("position");
    expect(line.geometry.drawRange.count).toBeGreaterThanOrEqual(2);
    expect(line.geometry.drawRange.count).toBe(4);
    expect(positions.getX(0)).toBe(0);
    expect(positions.getX(1)).toBeCloseTo(1e-8, 14);
    expect(positions.getX(2)).toBeCloseTo(1e-8, 14);
    expect(positions.getX(3)).toBe(12);
    expect(positions.getY(3)).toBe(2);
    refreshOrbitTrailLine(line, samples, [13, 4, 0], [0, 0, 0]);
    expect(positions.getX(1)).toBeCloseTo(1e-8, 14);
    expect(positions.getY(1)).toBe(0);
    expect(positions.getX(3)).toBe(13);
    expect(positions.getY(3)).toBe(4);
    line.geometry.dispose();
    line.removeFromParent();
    const materials = Array.isArray(line.material) ? line.material : [line.material];
    materials.forEach((material) => material.dispose());
  });
});

describe("explosion camera handoff", () => {
  it("keeps explicit event framing until a view request changes and does not chase the remnant", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const source = { ...createSolarSystem().find((body) => body.id === "earth")!, id: "source", positionM: [0, 0, 0] as const };
    const fragment = { ...source, id: "fragment", bodyType: "asteroid" as const, radiusM: 1e6, positionM: [1e7, 0, 0] as const };
    let state: CelestialSceneState = { bodies: [source], selectedBodyId: "source", gravity: 0, simulationTime: 0, showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1,
      historySnapshot: { bodies: [source], timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "creative", rotatingFrame: false, simulationRunning: false };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await Promise.resolve();
    try {
      frame(0);
      const camera = sceneCapture.camera!;
      const explosion: SimulationEvent = { id: 41, type: "explosion", timeSeconds: 0, positionM: [0, 0, 0], radiusM: source.radiusM, energyJ: 1e20, bodyIds: ["source", "fragment"] };
      state = { ...state, bodies: [fragment], selectedBodyId: "fragment", simulationTime: 1, revision: 2,
        historySnapshot: { bodies: [fragment], timeSeconds: 1, revision: 2, generation: 0 }, events: [explosion], eventFocusRequest: { eventId: 41, requestId: 1 } };
      frame(100);
      expect(sceneCapture.target!.x).toBeCloseTo(0.0065);
      const eventZoom = camera.position.distanceTo(sceneCapture.target!);
      frame(3100);
      const eventTarget = sceneCapture.target!.clone();
      expect(eventTarget.x).toBeCloseTo(0.0065);
      expect(camera.position.distanceTo(eventTarget)).toBeCloseTo(eventZoom);
      state = { ...state, bodies: [{ ...fragment, positionM: [3e7, 0, 0] }], simulationTime: 2,
        historySnapshot: { bodies: [{ ...fragment, positionM: [3e7, 0, 0] }], timeSeconds: 2, revision: 2, generation: 0 } };
      frame(3201);
      expect(sceneCapture.target!.distanceTo(eventTarget)).toBe(0);
    } finally { dispose(); }
  });
});

describe("accepted atmosphere forwarding", () => {
  it("derives renderer metrics from the accepted body snapshot and accepted gravity", async () => {
    const node = () => ({ style: { cssText: "" }, dataset: {}, appendChild() {}, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } });
    vi.stubGlobal("document", { createElement: node, createElementNS: node });
    vi.stubGlobal("window", { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const earth = { ...createSolarSystem().find((body) => body.id === "earth")!, materials: { modelId: "material-composition-v1" as const, rockKg: 5e24, ironKg: 1e24, gasKg: 0 }, atmosphere: { modelId: "isothermal-atmosphere-v1" as const, profileId: "nitrogen-oxygen-v1" as const, dryGasMassKg: 5e18, isothermalTemperatureK: 288 } };
    let accepted = earth;
    const bodies = [earth];
    let state: CelestialSceneState = { bodies, selectedBodyId: "earth", gravity: NEWTONIAN_G, simulationTime: 0, showOrbits: false, viewMode: "focus", viewRequest: 0, revision: 1, simulationRunning: false,
      historySnapshot: { bodies, timeSeconds: 0, revision: 1, generation: 0 }, events: [], eventGeneration: 0, collisionMode: "scientific", rotatingFrame: false };
    const host = { ...node(), clientWidth: 1024, clientHeight: 768, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 768 }) };
    const dispose = createCelestialScene(host as unknown as HTMLDivElement, { read: () => state, onSelect() {}, onPlaceBody() {}, onLoaded() {}, onError() {}, onRotatingFrameChange() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      frame(16);
      expect(sceneCapture.atmosphereMetrics.get("earth")).toMatchObject({ surfaceGravityMs2: expect.closeTo(NEWTONIAN_G * earth.massKg / earth.radiusM ** 2) });
      accepted = { ...earth, atmosphere: { ...earth.atmosphere, dryGasMassKg: 8e18 } };
      const nextBodies = [accepted];
      state = { ...state, bodies: nextBodies, revision: 2, historySnapshot: { ...state.historySnapshot, bodies: nextBodies, revision: 2 } };
      frame(32);
      expect(sceneCapture.atmosphereMetrics.get("earth")).toMatchObject({ columnMassKg: accepted.atmosphere.dryGasMassKg });
    } finally { dispose(); }
  });
});

