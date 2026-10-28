import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrbitalPlacementControls } from "./OrbitalPlacementControls";

const hookState = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const slot = hookState.cursor++;
    if (hookState.slots[slot] === undefined) hookState.slots[slot] = initial;
    return [hookState.slots[slot], (value: unknown) => { hookState.slots[slot] = typeof value === "function" ? (value as (current: unknown) => unknown)(hookState.slots[slot]) : value; }];
  } };
});

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

function makeHarness(props: React.ComponentProps<typeof OrbitalPlacementControls>) {
  let currentProps = props;
  const render = () => {
    hookState.cursor = 0;
    return nodes(OrbitalPlacementControls(currentProps));
  };
  const findLabel = (text: string) => render().find((node) => node.type === "label" && String(node.props.children).includes(text));
  const control = (label: string, tag: "select" | "input") => {
    const labelNode = findLabel(label);
    const found = labelNode && nodes(labelNode.props.children).find((node) => node.type === tag);
    if (!found) throw new Error(`Controle ausente: ${label}`);
    return found;
  };
  const change = (node: UiNode, value: string, checked?: boolean) => {
    (node.props.onChange as (event: unknown) => void)({ currentTarget: { value, checked } });
    return render();
  };
  return { render, control, change, update: (nextProps: typeof props) => { currentProps = nextProps; } };
}

beforeEach(() => { hookState.slots = []; hookState.cursor = 0; });

describe("orbital placement controls", () => {
  it("requires explicit primary/pair, plane, and confirmation of calculated orbital speeds", () => {
    const bodies = [
      { id: "earth", name: "Terra", kind: "planet" as const, massKg: 6e24, radiusM: 6e6, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 },
      { id: "moon", name: "Lua", kind: "moon" as const, massKg: 7e22, radiusM: 1.7e6, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 253, waterFraction: 0 },
    ];
    const html = renderToStaticMarkup(createElement(OrbitalPlacementControls, {
      bodies, selectedBodyIds: ["earth", "moon"], gravitationalConstant: 6.6743e-11, onMutate: vi.fn(),
    }));

    expect(html).toContain("Astro primário");
    expect(html).toContain("Segundo astro do par");
    expect(html).toContain("Plano orbital");
    expect(html).toContain("Velocidades e candidatos aparecem após o arraste");
    expect(html).not.toContain("Confirmar configuração");
    expect(html).toContain("Arrastar lua na cena");
    expect(html).toContain("Arrastar par binário na cena");
  });

  it("requires an explicit T12 material profile before offering a physical ring", () => {
    const html = renderToStaticMarkup(createElement(OrbitalPlacementControls, { bodies: [{ id: "p", name: "P", kind: "planet", massKg: 1e24,
      radiusM: 1e6, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 }], selectedBodyIds: ["p"], gravitationalConstant: 6.6743e-11, onMutate: vi.fn() }));

    expect(html).toContain("Escolha um perfil");
    expect(html).toContain("Material explícito do anel");
    expect(html).toContain('Arrastar anel físico na cena</button>');
    expect(html).toMatch(/<button type="button" disabled="">Arrastar anel físico na cena/);
    expect(html).toContain("Partículas físicas (4–32, par)");
  });

  it("does not offer a catalog moon around a star or black hole", () => {
    const html = renderToStaticMarkup(createElement(OrbitalPlacementControls, { bodies: [
      { id: "star", name: "Estrela", kind: "star" as const, massKg: 1e30, radiusM: 6e8, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 10_000, waterFraction: 0 },
      { id: "planet", name: "Planeta", kind: "planet" as const, massKg: 1e24, radiusM: 6e6, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 },
    ], selectedBodyIds: ["star", "planet"], gravitationalConstant: 6.6743e-11, onMutate: vi.fn() }));

    expect(html).toContain("Lua só pode orbitar um planeta");
    expect(html).toMatch(/<button type="button" disabled="">Arrastar lua na cena/);
  });

  it("builds a canonical moon placement intent from the selected primary, plane, and radius", () => {
    const onStartPlacement = vi.fn();
    const harness = makeHarness({ bodies: [
      { id: "bh", name: "BH", kind: "star", bodyType: "black-hole", massKg: 8e30, radiusM: 2.4e4, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 },
      { id: "earth", name: "Terra", kind: "planet", massKg: 6e24, radiusM: 6e6, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 },
    ], selectedBodyIds: ["bh"], gravitationalConstant: 6.6743e-11, onMutate: vi.fn(), onStartPlacement });

    harness.change(harness.control("Astro primário", "select"), "earth");
    harness.change(harness.control("Plano orbital", "select"), "xz");
    harness.change(harness.control("Raio orbital", "input"), "400000000");
    const moonButton = harness.render().find((node) => node.type === "button" && node.props.children === "Arrastar lua na cena");
    (moonButton?.props.onClick as () => void)();
    expect(onStartPlacement).toHaveBeenCalledExactlyOnceWith({ type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: "earth", semiMajorAxisM: 4e8,
      planeNormal: [0, 1, 0], radialDirection: [1, 0, 0] });
  });

  it("announces and rejects a moon orbit with a black-hole primary", () => {
    const onMutate = vi.fn();
    const harness = makeHarness({ bodies: [
      { id: "bh", name: "BH", kind: "star", bodyType: "black-hole", massKg: 8e30, radiusM: 2.4e4, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 0, waterFraction: 0 },
      { id: "earth", name: "Terra", kind: "planet", massKg: 6e24, radiusM: 6e6, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0 },
    ], selectedBodyIds: ["earth"], gravitationalConstant: 6.6743e-11, onMutate });
    const view = harness.change(harness.control("Astro primário", "select"), "bh");
    const message = view.find((node) => node.props.role === "status" && textOf(node.props.children).includes("Lua só pode orbitar"));
    const moonButton = view.find((node) => node.type === "button" && node.props.children === "Arrastar lua na cena");

    expect(textOf(message?.props.children)).toContain("Lua só pode orbitar um planeta");
    expect(moonButton?.props.disabled).toBe(true);
    (moonButton?.props.onClick as () => void)();
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("confirms only a ready preview bound to the current canonical draft and cancels without mutation", () => {
    const onStartPlacement = vi.fn();
    const onDraftMutation = vi.fn();
    const onCancelPlacement = vi.fn();
    const onConfirmPlacement = vi.fn();
    const bodies = [{ id: "earth", name: "Terra", kind: "planet" as const, massKg: 6e24, radiusM: 6e6,
      positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 }];
    const mutation = { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 4e8,
      planeNormal: [0, 0, 1] as const, radialDirection: [1, 0, 0] as const };
    const onMutate = vi.fn();
    const props = { bodies, selectedBodyIds: ["earth"], gravitationalConstant: 6.6743e-11, onMutate,
      onStartPlacement, onDraftMutation, onCancelPlacement, onConfirmPlacement, orbitalPlacement: null, orbitalPreview: null };
    const harness = makeHarness(props);
    const findButton = (label: string, view = harness.render()) => view.find((node) => node.type === "button" && textOf(node.props.children) === label);
    const click = (node: UiNode | undefined) => (node?.props.onClick as (() => void) | undefined)?.();

    click(findButton("Arrastar lua na cena"));
    expect(onStartPlacement).toHaveBeenCalledWith(mutation);
    expect(onMutate).not.toHaveBeenCalled();

    const acceptedPreview = { type: "ORBITAL_MUTATION_PREVIEW" as const, version: 1 as const, requestId: 41,
      worldRevision: 7, baseTimeSeconds: 120, result: { status: "ready" as const,
        candidates: [{ bodyId: "moon-candidate", positionM: [4e8, 0, 0] as const, velocityMs: [0, 1000, 0] as const }] } };
    harness.update({ ...props, orbitalPlacement: { mutation, worldRevision: 7, baseTimeSeconds: 120 },
      orbitalPreview: { response: acceptedPreview, mutation } });
    let view = harness.render();
    expect(view.some((node) => node.props.role === "status" && textOf(node.props.children).includes("1.000e+3 m/s"))).toBe(true);
    expect(findButton("Confirmar configuração", view)?.props.disabled).toBe(false);
    click(findButton("Confirmar configuração", view));
    expect(onConfirmPlacement).toHaveBeenCalledExactlyOnceWith(mutation, 41);

    const changedMutation = { ...mutation, semiMajorAxisM: 5e8 };
    harness.update({ ...props, orbitalPlacement: { mutation: changedMutation, worldRevision: 7, baseTimeSeconds: 120 },
      orbitalPreview: { response: acceptedPreview, mutation } });
    view = harness.render();
    expect(findButton("Confirmar configuração", view)?.props.disabled).toBe(true);
    harness.update({ ...props, orbitalPlacement: { mutation, worldRevision: 7, baseTimeSeconds: 120 },
      orbitalPreview: { response: { ...acceptedPreview, baseTimeSeconds: 121 }, mutation } });
    expect(findButton("Confirmar configuração")?.props.disabled).toBe(true);
    click(findButton("Cancelar posicionamento", view));
    expect(onCancelPlacement).toHaveBeenCalledOnce();
    expect(onDraftMutation).toHaveBeenLastCalledWith(null);
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("preserves a custom drag orientation through ready preview and confirmation", () => {
    const onConfirmPlacement = vi.fn();
    const bodies = [{ id: "earth", name: "Terra", kind: "planet" as const, massKg: 6e24, radiusM: 6e6,
      positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const, surfaceTemperatureK: 288, waterFraction: 0 }];
    const mutation = { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 4e8,
      planeNormal: [0.5773502691896258, 0.5773502691896258, 0.5773502691896258] as const,
      radialDirection: [Math.SQRT1_2, -Math.SQRT1_2, 0] as const };
    const response = { type: "ORBITAL_MUTATION_PREVIEW" as const, version: 1 as const, requestId: 42,
      worldRevision: 8, baseTimeSeconds: 240, result: { status: "ready" as const,
        candidates: [{ bodyId: "moon-candidate", positionM: [1, 2, 3] as const, velocityMs: [4, 5, 6] as const }] } };
    const harness = makeHarness({ bodies, selectedBodyIds: ["earth"], gravitationalConstant: 6.6743e-11,
      orbitalPlacement: { mutation, worldRevision: 8, baseTimeSeconds: 240 },
      orbitalPreview: { response, mutation }, onConfirmPlacement });
    const findButton = (label: string) => harness.render().find((node) => node.type === "button" && textOf(node.props.children) === label);
    const confirm = findButton("Confirmar configuração");

    expect(confirm?.props.disabled).toBe(false);
    (confirm?.props.onClick as (() => void) | undefined)?.();
    expect(onConfirmPlacement).toHaveBeenCalledExactlyOnceWith(mutation, 42);
  });
});
