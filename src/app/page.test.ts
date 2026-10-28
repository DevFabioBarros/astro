import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import Home from "./page";
import { SimulationCanvas } from "@/features/simulation/SimulationCanvas";
import { SimulationExperimentsDock } from "@/features/simulation/SimulationExperimentsDock";
import { SimulationToolbar } from "@/features/simulation/SimulationToolbar";
import type { OrbitalMutationPreviewResponse, OrbitalPlacementMutation, SimulationSnapshot } from "@/simulation/types";
import { shouldResumeFromSnapshot, snapshotStopsRunning } from "./snapshot-running";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], initialized: [] as boolean[] }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.initialized[index]) { hooks.slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial; hooks.initialized[index] = true; }
    return index;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(initial);
      return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(hooks.slots[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = slot({ current: initial });
      return hooks.slots[index];
    },
    useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown) => {
      const index = slot(initial);
      return [hooks.slots[index], (action: unknown) => { hooks.slots[index] = reducer(hooks.slots[index], action); }];
    },
    useEffect: () => {},
  };
});
vi.mock("@/features/simulation/scene-audio", () => ({ useSceneAudio: () => ({
  enabled: false, muted: false, volume: 0.5, reducedMotion: false, failed: false,
  acceptSnapshot: () => [], reset() {}, stopVoices() {}, enableFromGesture: async () => {}, disable() {}, setMuted() {}, setVolume() {},
}) }));

type UiNode = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): UiNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as UiNode;
  return [node, ...nodes(node.props.children)];
}
function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join("");
  return isValidElement(value) ? textOf((value as UiNode).props.children) : typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function renderPage(): UiNode[] { hooks.cursor = 0; return nodes(Home()); }
function nodeOf(tree: UiNode[], component: unknown): UiNode {
  const node = tree.find(({ type }) => type === component);
  if (!node) throw new Error("Elemento da página não encontrado");
  return node;
}
function callback<T extends (...args: never[]) => unknown>(node: UiNode, key: string): T {
  const value = node.props[key];
  if (typeof value !== "function") throw new Error(`Callback ausente: ${key}`);
  return value as T;
}

beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.initialized = []; });

it("keeps orbital numeric controls available and hides confirmation before accepted preview", () => {
  const tree = renderPage();
  const dock = nodeOf(tree, SimulationExperimentsDock);
  const toolbar = nodeOf(tree, SimulationToolbar);
  expect(dock.props.orbitalPlacement).toBeNull();
  expect(dock.props.orbitalPreview).toBeNull();
  expect(textOf(tree)).toContain("Shift+clique ou Ctrl+Espaço");
  expect(textOf(tree)).not.toContain("Laboratório de impactos");
  expect(tree.some((node) => node.props["aria-modal"] === true)).toBe(false);
  expect(toolbar.props.status).toBe("paused");
});

it("commits the exact accepted draft once and leaves accepted bodies unchanged", () => {
  let tree = renderPage();
  let canvas = nodeOf(tree, SimulationCanvas);
  const initialBodies = canvas.props.bodies;
  const snapshot = { bodies: initialBodies, settings: { gravitationalConstant: 6.6743e-11 }, environmentSeed: 0,
    worldRevision: 1, simulationTimeSeconds: 0, status: "paused", collisionMode: "creative" } as SimulationSnapshot;
  callback<(value: SimulationSnapshot) => void>(canvas, "onSnapshot")(snapshot);
  callback<() => void>(nodeOf(tree, SimulationToolbar), "onToggle")();
  tree = renderPage();
  canvas = nodeOf(tree, SimulationCanvas);
  let dock = nodeOf(tree, SimulationExperimentsDock);
  const start = callback<(mutation: OrbitalPlacementMutation) => void>(dock, "onStartOrbitalPlacement");
  const mutation: OrbitalPlacementMutation = { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: "earth", semiMajorAxisM: 4e8,
    planeNormal: [0, 0, 1], radialDirection: [1, 0, 0] };
  start(mutation);
  const drafted = { ...mutation, semiMajorAxisM: 5e8 };
  tree = renderPage();
  canvas = nodeOf(tree, SimulationCanvas);
  callback<(value: OrbitalPlacementMutation | null) => void>(canvas, "onDraftMutation")(drafted);
  const response: OrbitalMutationPreviewResponse = { type: "ORBITAL_MUTATION_PREVIEW", version: 1, requestId: 71,
    worldRevision: 1, baseTimeSeconds: 0, result: { status: "ready", candidates: [{ bodyId: "moon-preview", positionM: [5e8, 0, 0], velocityMs: [0, 1000, 0] }] } };
  tree = renderPage();
  canvas = nodeOf(tree, SimulationCanvas);
  callback<(value: OrbitalMutationPreviewResponse | null) => void>(canvas, "onOrbitalMutationPreview")(response);
  tree = renderPage();
  dock = nodeOf(tree, SimulationExperimentsDock);
  const confirm = callback<(candidate: OrbitalPlacementMutation, requestId: number) => void>(dock, "onConfirmOrbitalPlacement");
  confirm(drafted, 71);
  confirm(drafted, 71);

  tree = renderPage();
  canvas = nodeOf(tree, SimulationCanvas);
  expect(canvas.props.mutations).toHaveLength(1);
  expect((canvas.props.mutations as { mutation: OrbitalPlacementMutation }[])[0]?.mutation).toBe(drafted);
  expect(canvas.props.bodies).toBe(initialBodies);
});

it("does not commit stale previews or cancelled placement drafts", () => {
  let tree = renderPage();
  const canvas = nodeOf(tree, SimulationCanvas);
  const snapshot = { bodies: canvas.props.bodies, settings: { gravitationalConstant: 6.6743e-11 }, environmentSeed: 0,
    worldRevision: 1, simulationTimeSeconds: 0, status: "paused", collisionMode: "creative" } as SimulationSnapshot;
  callback<(value: SimulationSnapshot) => void>(canvas, "onSnapshot")(snapshot);
  callback<() => void>(nodeOf(tree, SimulationToolbar), "onToggle")();
  tree = renderPage();
  const mutation: OrbitalPlacementMutation = { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: "earth", semiMajorAxisM: 4e8,
    planeNormal: [0, 0, 1], radialDirection: [1, 0, 0] };
  callback<(value: OrbitalPlacementMutation) => void>(nodeOf(tree, SimulationExperimentsDock), "onStartOrbitalPlacement")(mutation);
  callback<(value: SimulationSnapshot) => void>(canvas, "onSnapshot")({ ...snapshot, worldRevision: 2, simulationTimeSeconds: 1 });
  tree = renderPage();
  let canvasNow = nodeOf(tree, SimulationCanvas);
  callback<(value: OrbitalMutationPreviewResponse | null) => void>(canvasNow, "onOrbitalMutationPreview")({ type: "ORBITAL_MUTATION_PREVIEW", version: 1,
    requestId: 80, worldRevision: 1, baseTimeSeconds: 9, result: { status: "ready", candidates: [] } });
  tree = renderPage();
  let dock = nodeOf(tree, SimulationExperimentsDock);
  callback<(value: OrbitalPlacementMutation, requestId: number) => void>(dock, "onConfirmOrbitalPlacement")(mutation, 80);
  callback<() => void>(dock, "onCancelOrbitalPlacement")();
  tree = renderPage();
  canvasNow = nodeOf(tree, SimulationCanvas);
  callback<(value: OrbitalMutationPreviewResponse | null) => void>(canvasNow, "onOrbitalMutationPreview")({ type: "ORBITAL_MUTATION_PREVIEW", version: 1,
    requestId: 81, worldRevision: 1, baseTimeSeconds: 0, result: { status: "ready", candidates: [] } });
  tree = renderPage();
  dock = nodeOf(tree, SimulationExperimentsDock);
  callback<(value: OrbitalPlacementMutation, requestId: number) => void>(dock, "onConfirmOrbitalPlacement")(mutation, 81);
  expect(nodeOf(tree, SimulationCanvas).props.mutations).toEqual([]);
});

it("stops local running state for recoverable paused snapshots with an error", () => {
  expect(snapshotStopsRunning({ status: "paused", error: "Falha recuperável" })).toBe(true);
  expect(snapshotStopsRunning({ status: "running", error: "Falha recuperável" })).toBe(true);
  expect(snapshotStopsRunning({ status: "error" })).toBe(true);
  expect(snapshotStopsRunning({ status: "paused" })).toBe(false);
  expect(shouldResumeFromSnapshot({ status: "error" }, true)).toBe(false);
  expect(shouldResumeFromSnapshot({ status: "running" }, true)).toBe(true);
  expect(shouldResumeFromSnapshot({ status: "running" }, false)).toBe(false);
});
