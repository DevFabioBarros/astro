import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import type { SolarEvolutionStage } from "@/simulation/stellar-evolution";
import {
  getSolarEvolutionProperties,
  SOLAR_EVOLUTION_END_AGE_YEARS,
  SOLAR_EVOLUTION_MODEL,
  SOLAR_EVOLUTION_START_AGE_YEARS,
} from "@/simulation/stellar-evolution";
import { SolarEvolutionControls } from "./SolarEvolutionControls";

vi.mock("@/simulation/stellar-evolution", () => {
  const startAge = 4.58e9;
  const endAge = 11_465_471_475.297027;
  const model = { id: "mist-v1.2-solar-1msun-nonrotating", version: "1.2", sourceUrl: "https://example.test/mist" };
  return {
    SOLAR_EVOLUTION_START_AGE_YEARS: startAge,
    SOLAR_EVOLUTION_END_AGE_YEARS: endAge,
    SOLAR_EVOLUTION_MODEL: model,
    stellarLuminosityW: (body: { radiusM: number; surfaceTemperatureK: number }) => 4 * Math.PI * body.radiusM ** 2 * 5.670374419e-8 * body.surfaceTemperatureK ** 4,
    getSolarEvolutionProperties: (ageYears: number) => ({
      ageYears,
      stage: (ageYears >= endAge ? "white-dwarf-formation" : "main-sequence") as SolarEvolutionStage,
      massKg: 1.9884e30,
      radiusM: 695_700_000,
      effectiveTemperatureK: 5772,
      luminosityW: 3.828e26,
    }),
    getSolarTrackKnotsBetween: () => [{ ageYears: 6e9, primaryEep: 100, stage: "main-sequence" }],
  };
});

const bodies = createSolarSystem();
const noop = () => {};

it("shows terminal track state, accessible age controls, and the explicit full-system reset", () => {
  const sun = bodies.find(({ id }) => id === "sun")!;
  const properties = getSolarEvolutionProperties(SOLAR_EVOLUTION_END_AGE_YEARS);
  const body = {
    ...sun,
    massKg: properties.massKg,
    radiusM: properties.radiusM,
    surfaceTemperatureK: properties.effectiveTemperatureK,
    stellarEvolution: {
      modelId: SOLAR_EVOLUTION_MODEL.id,
      modelVersion: SOLAR_EVOLUTION_MODEL.version,
      ageYears: SOLAR_EVOLUTION_END_AGE_YEARS,
      accretedMassKg: 0,
      absorbedBodyIds: [],
      mode: "secular" as const,
    },
  };
  const markup = renderToStaticMarkup(createElement(SolarEvolutionControls, {
    body, bodies, evolutionRunning: false, evolutionPending: false,
    onInitialize: noop, onAdvanceAge: noop, onStart: noop, onPause: noop,
    onReset: noop, onExitManual: noop, mutationError: "",
  }));

  expect(markup).toContain("11,465 Gyr");
  expect(markup).toContain("Início da formação da anã branca");
  expect(markup).toContain("não modela seu resfriamento");
  expect(markup).not.toContain("aria-label=\"Idade da evolução solar\"");
  expect(markup).toContain("Reset Solar");
  expect(markup).toContain("substitui todo o sistema");
  expect(markup).toContain("W/m²");
});

it("provides an accessible paused age range and model milestone for the Solar preset", () => {
  const sun = bodies.find(({ id }) => id === "sun")!;
  const body = {
    ...sun,
    stellarEvolution: {
      modelId: SOLAR_EVOLUTION_MODEL.id,
      modelVersion: SOLAR_EVOLUTION_MODEL.version,
      ageYears: SOLAR_EVOLUTION_START_AGE_YEARS,
      accretedMassKg: 0,
      absorbedBodyIds: [],
      mode: "secular" as const,
    },
  };
  const markup = renderToStaticMarkup(createElement(SolarEvolutionControls, {
    body, bodies, evolutionRunning: false, evolutionPending: false,
    onInitialize: noop, onAdvanceAge: noop, onStart: noop, onPause: noop,
    onReset: noop, onExitManual: noop, mutationError: "",
  }));

  expect(markup).toContain("aria-label=\"Idade da evolução solar\"");
  expect(markup).toContain("Evolução pausada.");
  expect(markup).toContain("Avançar até Sequência principal");
  expect(markup).toContain("trilha MIST 1 M☉");
  expect(markup).toContain("fora da faixa não há extrapolação");
});

it("does not render a generic evolution panel for another star", () => {
  const otherStar = { ...bodies[0]!, id: "other-star", name: "Outra estrela" };
  const markup = renderToStaticMarkup(createElement(SolarEvolutionControls, {
    body: otherStar, bodies, evolutionRunning: false, evolutionPending: false,
    onInitialize: noop, onAdvanceAge: noop, onStart: noop, onPause: noop,
    onReset: noop, onExitManual: noop, mutationError: "",
  }));

  expect(markup).toBe("");
});
