import { expect, test } from "@playwright/test";
import type { Download, Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { BodyType, StellarEvolutionMetadata } from "../src/simulation/types";

type ExportedBody = {
  id: string;
  name: string;
  bodyType?: BodyType;
  massKg: number;
  radiusM: number;
  positionM: number[];
  velocityMs: number[];
  stellarEvolution?: StellarEvolutionMetadata;
};

type ExportedWorld = {
  version: number;
  settings: { gravitationalConstant: number };
  bodies: ExportedBody[];
};

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright did not provide the in-memory download stream.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportWorld(page: Page): Promise<ExportedWorld> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Exportar", exact: true }).click(),
  ]);
  return JSON.parse((await readDownload(download)).toString()) as ExportedWorld;
}

async function importWorld(page: Page, name: string, world: unknown): Promise<void> {
  await page.getByLabel("Arquivo de simulação").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(world)),
  });
  await expect(page.getByRole("status").filter({ hasText: "Simulação importada com sucesso." }))
    .toHaveText("Simulação importada com sucesso.");
}

async function pause(page: Page): Promise<void> {
  const transport = page.locator(".transport");
  const pauseButton = page.getByRole("button", { name: "Pausar", exact: true });
  await expect(transport).toHaveAttribute("data-simulation-status", "running");
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect(transport).toHaveAttribute("data-simulation-status", "paused");
}

async function ensureInspectorOpen(page: Page, bodyName: string): Promise<void> {
  const edit = page.getByRole("button", { name: `Editar ${bodyName}`, exact: true });
  if (await edit.count() && await edit.getAttribute("aria-expanded") !== "true") await edit.click();
  await expect(page.locator("#object-inspector")).toBeVisible();
}

function captureRenderErrors(page: Page) {
  const pageErrors: string[] = [];
  const shaderErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /shader|WebGLProgram|GLSL/i.test(message.text())) shaderErrors.push(message.text());
  });
  return () => {
    expect(pageErrors).toEqual([]);
    expect(shaderErrors).toEqual([]);
  };
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const image = await page.screenshot({ path: `.playwright-cli/${name}.png` });
  await testInfo.attach(name, { body: image, contentType: "image/png" });
}

test("starts with osculating guides on and history off; orbit toggles stay independent", async ({ page }, testInfo) => {
  await page.goto("/");
  const orbits = page.getByRole("button", { name: "Órbitas estimadas", exact: true });
  const trails = page.getByRole("button", { name: "Rastros percorridos", exact: true });
  await expect(orbits).toHaveAttribute("aria-pressed", "true");
  await expect(trails).toHaveAttribute("aria-pressed", "false");
  await capture(page, testInfo, "qa-after-orbit-default");

  await trails.click();
  await expect(trails).toHaveAttribute("aria-pressed", "true");
  await expect(orbits).toHaveAttribute("aria-pressed", "true");
  await capture(page, testInfo, "qa-after-orbit-guides-and-trails");
  await orbits.click();
  await expect(orbits).toHaveAttribute("aria-pressed", "false");
  await expect(trails).toHaveAttribute("aria-pressed", "true");
  await capture(page, testInfo, "qa-after-orbit-trails-only");

  await trails.click();
  await expect(trails).toHaveAttribute("aria-pressed", "false");
  await expect(orbits).toHaveAttribute("aria-pressed", "false");
  await orbits.click();
  await expect(orbits).toHaveAttribute("aria-pressed", "true");
  await expect(trails).toHaveAttribute("aria-pressed", "false");
  await capture(page, testInfo, "qa-after-orbit-guides-only");
});

test("renders catalog and terminal white dwarfs without shader errors and remains readable on mobile", async ({ page }, testInfo) => {
  const assertNoRenderErrors = captureRenderErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await pause(page);
  await page.getByRole("button", { name: "Criar astro", exact: true }).click();
  const catalog = page.getByRole("dialog", { name: "Crie seu universo" });
  await catalog.locator(".catalog-option").filter({ has: page.locator("strong", { hasText: /^Anã branca$/ }) }).click();
  await catalog.getByRole("button", { name: "Criar anã branca", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Anã branca 1", exact: true })).toBeVisible();
  await ensureInspectorOpen(page, "Anã branca 1");
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "white-dwarf-1")?.bodyType).toBe("white-dwarf");
  await capture(page, testInfo, "qa-after-white-dwarf-template-focus");
  await page.getByRole("button", { name: "Ver sistema", exact: true }).click();
  await capture(page, testInfo, "qa-after-white-dwarf-template-context");

  await page.setViewportSize({ width: 390, height: 844 });
  const edit = page.getByRole("button", { name: "Editar Anã branca 1", exact: true });
  if (await edit.count() && await edit.getAttribute("aria-expanded") !== "true") await edit.click();
  await expect(page.getByRole("heading", { name: "Anã branca 1", exact: true })).toBeVisible();
  const derivedMeasurements = page.locator("details.derived-measurements");
  await derivedMeasurements.locator("summary").click();
  await expect(derivedMeasurements.locator(".object-facts").getByText("Diâmetro", { exact: true })).toBeVisible();
  await expect(derivedMeasurements.locator(".object-facts dd").first()).toContainText("km");
  expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, testInfo, "qa-after-white-dwarf-mobile-390x844");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Reiniciar sistema", exact: true }).click();
  await pause(page);
  await page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { name: "Sol", exact: true }).click();
  await ensureInspectorOpen(page, "Sol");
  const solar = page.locator("details.advanced-controls").filter({ has: page.getByText("Evolução do Sol", { exact: true }) });
  await solar.getByRole("button", { name: "Iniciar modelo solar", exact: true }).click();
  await expect(solar.locator('p[role="status"]')).toHaveText("Evolução pausada.");
  await solar.getByText("Marcos fornecidos pelo modelo", { exact: true }).click();
  await solar.getByRole("button", { name: /Avançar até Início da formação da anã branca/ }).click();
  await expect(solar.locator(".object-facts").getByText("Início da formação da anã branca", { exact: true })).toBeVisible();
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.bodyType).toBe("white-dwarf");
  await capture(page, testInfo, "qa-after-white-dwarf-terminal-focus");
  await page.getByRole("button", { name: "Ver sistema", exact: true }).click();
  await capture(page, testInfo, "qa-after-white-dwarf-terminal-context");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("body").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, testInfo, "qa-after-white-dwarf-terminal-mobile-390x844");
  assertNoRenderErrors();
});

const explosionWorld = {
  format: "astro-simulation",
  version: 2,
  settings: { gravitationalConstant: 0 },
  bodies: [{
    id: "impact-source",
    name: "Fonte de impacto",
    kind: "planet",
    bodyType: "rocky-planet",
    massKg: 1e20,
    radiusM: 1e5,
    positionM: [2e6, -3e6, 5e6],
    velocityMs: [1200, -500, 70],
    surfaceTemperatureK: 200,
    waterFraction: 0,
  }],
} as const;

async function explodeAtEnergy(page: Page, testInfo: TestInfo, energy: number, filename: string): Promise<{ initial: ExportedWorld; result: ExportedWorld }> {
  await importWorld(page, filename, explosionWorld);
  await expect(page.getByRole("button", { name: "Retomar", exact: true })).toBeVisible();
  await ensureInspectorOpen(page, "Fonte de impacto");
  const initial = await exportWorld(page);
  await page.getByLabel("Energia específica da fragmentação (J/kg)").fill(String(energy));
  await page.getByRole("button", { name: "Explodir astro", exact: true }).click();
  await expect(page.getByRole("status", { name: "Evento astronômico" }))
    .toContainText("Explosão experimental: seis fragmentos. Não é uma supernova.");
  await capture(page, testInfo, `qa-after-explosion-q${energy}`);
  return { initial, result: await exportWorld(page) };
}

function momentum(bodies: ExportedBody[]): number[] {
  return [0, 1, 2].map((axis) => bodies.reduce((sum, body) => sum + body.massKg * body.velocityMs[axis]!, 0));
}

function kineticEnergyAbove(bodies: ExportedBody[], velocity: readonly number[]): number {
  return bodies.reduce((sum, body) => sum + 0.5 * body.massKg * body.velocityMs.reduce(
    (squared, component, axis) => squared + (component - velocity[axis]!) ** 2,
    0,
  ), 0);
}

test("explosion energy scales exported M, P, K and fragment velocity; invalid drafts preserve state", async ({ page }, testInfo) => {
  await page.goto("/");
  await pause(page);
  const lowCase = await explodeAtEnergy(page, testInfo, 10_000, "impact-low-energy-v2.astro");
  const highCase = await explodeAtEnergy(page, testInfo, 40_000, "impact-high-energy-v2.astro");
  expect(lowCase.initial).toEqual(highCase.initial);
  const low = lowCase.result;
  const high = highCase.result;
  const initial = explosionWorld.bodies[0];
  const initialMomentum = initial.velocityMs.map((velocity) => velocity * initial.massKg);
  expect(low.settings.gravitationalConstant).toBe(0);
  expect(high.settings.gravitationalConstant).toBe(0);

  for (const world of [low, high]) {
    expect(world.bodies).toHaveLength(6);
    const mass = world.bodies.reduce<number>((sum, body) => sum + body.massKg, 0);
    expect(Math.abs(mass / initial.massKg - 1)).toBeLessThan(1e-12);
    momentum(world.bodies).forEach((value, axis) => {
      expect(Math.abs(value / initialMomentum[axis]! - 1)).toBeLessThan(1e-12);
    });
  }

  const lowK = kineticEnergyAbove(low.bodies, initial.velocityMs);
  const highK = kineticEnergyAbove(high.bodies, initial.velocityMs);
  expect(Math.abs(highK / lowK - 4)).toBeLessThan(1e-10);
  const speed = (body: ExportedBody) => Math.hypot(...body.velocityMs.map((value, axis) => value - initial.velocityMs[axis]!));
  for (let index = 0; index < low.bodies.length; index += 1) {
    expect(Math.abs(speed(high.bodies[index]!) / speed(low.bodies[index]!) - 2)).toBeLessThan(1e-10);
  }
  await writeFile(".playwright-cli/qa-after-explosion-export-comparison.json", JSON.stringify({
    settings: { gravitationalConstant: 0 },
    initial: lowCase.initial,
    cases: [
      { specificEnergyJkg: 10_000, massKg: low.bodies.reduce((sum, body) => sum + body.massKg, 0), momentumKgMs: momentum(low.bodies), ejectaKineticEnergyJ: lowK, fragments: low.bodies },
      { specificEnergyJkg: 40_000, massKg: high.bodies.reduce((sum, body) => sum + body.massKg, 0), momentumKgMs: momentum(high.bodies), ejectaKineticEnergyJ: highK, fragments: high.bodies },
    ],
  }, null, 2));

  await importWorld(page, "impact-invalid-energy-v2.astro", explosionWorld);
  await ensureInspectorOpen(page, "Fonte de impacto");
  const beforeInvalidDrafts = await exportWorld(page);
  const energyInput = page.getByLabel("Energia específica da fragmentação (J/kg)");
  const explode = page.getByRole("button", { name: "Explodir astro", exact: true });
  for (const draft of ["", "0", "-1", "NaN", "Infinity", "1e100"]) {
    await energyInput.fill(draft);
    await expect(explode).toBeDisabled();
    await expect(page.locator("#explosion-energy-error")).toContainText("Não foi possível estimar a fragmentação:");
    expect(await exportWorld(page)).toEqual(beforeInvalidDrafts);
  }
});

test("white dwarfs, neutron stars and black holes keep fragmentation disabled", async ({ page }) => {
  await page.goto("/");
  await pause(page);
  const compactBodies = [
    { id: "compact-white-dwarf", bodyType: "white-dwarf", radiusM: 6_371_000 },
    { id: "compact-neutron-star", bodyType: "neutron-star", radiusM: 12_000 },
    { id: "compact-black-hole", bodyType: "black-hole", radiusM: 2 * 6.6743e-11 * 2e30 / 299_792_458 ** 2 },
  ] as const;

  for (const body of compactBodies) {
    await importWorld(page, `${body.id}.astro`, {
      format: "astro-simulation",
      version: 2,
      settings: { gravitationalConstant: 0 },
      bodies: [{
        ...body,
        name: body.id,
        kind: "star",
        massKg: 2e30,
        positionM: [0, 0, 0],
        velocityMs: [0, 0, 0],
        surfaceTemperatureK: 10_000,
        waterFraction: 0,
      }],
    });
    await ensureInspectorOpen(page, body.id);
    const explode = page.getByRole("button", { name: "Explodir astro", exact: true });
    await expect(explode).toBeDisabled();
    await expect(page.locator("#explode-description"))
      .toHaveText("Astros compactos continuam indisponíveis para fragmentação neste experimento.");
  }
});
