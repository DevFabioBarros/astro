import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getSolarEvolutionProperties,
  getSolarTrackAgeAtEep,
  getSolarEvolutionTrackSample,
  SOLAR_EVOLUTION_START_AGE_YEARS,
} from "../src/simulation/stellar-evolution";

const evidenceDirectory = join(
  process.cwd(),
  "artifacts",
  `solar-track-visual-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
);
mkdirSync(evidenceDirectory, { recursive: true });

const checkpoints = [
  { name: "anchor", eep: null, ageYears: SOLAR_EVOLUTION_START_AGE_YEARS, displayedAge: "4,58 Gyr", type: "Estrela" },
  { name: "eep-605", eep: 605, ageYears: getSolarTrackAgeAtEep(605), displayedAge: "11,336 Gyr", type: "Estrela" },
  { name: "eep-1000", eep: 1000, ageYears: getSolarTrackAgeAtEep(1000), displayedAge: "11,462 Gyr", type: "Estrela" },
  { name: "eep-1338-max-radius", eep: 1338, ageYears: getSolarTrackAgeAtEep(1338), displayedAge: "11,463 Gyr", type: "Estrela" },
  { name: "eep-1710-white-dwarf", eep: 1710, ageYears: getSolarTrackAgeAtEep(1710), displayedAge: "11,465 Gyr", type: "Anã branca" },
] as const;

async function selectSunAndOpenInspector(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retomar", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Escolha um astro" })
    .getByRole("button", { name: "Sol", exact: true }).click();
  const edit = page.getByRole("button", { name: "Editar Sol", exact: true });
  if (await edit.count() && await edit.getAttribute("aria-expanded") !== "true") await edit.click();
  await expect(page.locator("#object-inspector")).toBeVisible();
  const sceneHelp = page.locator(".scene-help");
  const sceneHelpSummary = sceneHelp.getByText("Ajuda da cena", { exact: true });
  await expect(sceneHelp).not.toHaveAttribute("open", "");
  await sceneHelpSummary.focus();
  await page.keyboard.press("Enter");
  await expect(sceneHelp).toHaveAttribute("open", "");
  await expect(sceneHelp.getByText("Arraste para explorar", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(sceneHelp).not.toHaveAttribute("open", "");
  const sunLabel = page.getByRole("button", { name: "Selecionar Sol", exact: true });
  await expect(sunLabel).toBeVisible();
  await sunLabel.focus();
  await expect(sunLabel).toBeFocused();
}

function displayedMeasure(page: Page, label: string) {
  return page.locator(".inspector .object-facts dt")
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::dd[1]");
}

async function readDownload(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Exportar", exact: true }).click(),
  ]);
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright did not provide the in-memory export stream.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as {
    bodies: Array<{
      id: string;
      radiusM: number;
      surfaceTemperatureK: number;
      bodyType?: string;
      stellarEvolution?: { ageYears: number; trackEep?: number };
    }>;
  };
}

async function setAgeThroughSlider(page: Page, ageYears: number) {
  const slider = page.getByRole("slider", { name: "Idade da evolução solar" });
  await slider.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, ageYears);
  await slider.dispatchEvent("pointerup");
}

function parsePtNumber(text: string) {
  const value = text.replace(/\s/g, "").replace(/\./g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!value) throw new Error(`Could not parse displayed number: ${text}`);
  return Number(value[0]);
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("real Chrome shows accepted MIST checkpoints and keeps the red giant framed", async ({ page }) => {
  test.setTimeout(180_000);
  const appConsole: Array<{ type: string; text: string }> = [];
  page.on("console", (message) => appConsole.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => appConsole.push({ type: "pageerror", text: error.message }));
  try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectSunAndOpenInspector(page);

  const solar = page.locator("details.advanced-controls")
    .filter({ has: page.getByText("Evolução do Sol", { exact: true }) });
  const status = solar.locator('p[role="status"]');
  await solar.getByRole("button", { name: "Iniciar modelo solar", exact: true }).click();
  await expect(status).toHaveText("Evolução pausada.");
  await expect(solar.getByText("Idade evolutiva: 4,58 Gyr", { exact: true })).toBeVisible();

  for (const [index, checkpoint] of checkpoints.entries()) {
    if (index === 1) await solar.getByText("Marcos fornecidos pelo modelo", { exact: true }).click();
    if (index === 1 || checkpoint.eep === 1710) {
      if (checkpoint.eep === 1710) {
        await solar.getByRole("button", { name: /Avançar até Início da formação da anã branca, 11,465 Gyr/ }).click();
      } else {
        await solar.getByRole("button", { name: /Avançar até Ramo das gigantes vermelhas, 11,336 Gyr/ }).click();
      }
    } else if (index > 1) {
      await setAgeThroughSlider(page, checkpoint.ageYears);
    }

    await expect(status).toHaveText("Evolução pausada.");
    await expect(solar.getByText(`Idade evolutiva: ${checkpoint.displayedAge}`, { exact: true })).toBeVisible();
    await expect(solar.locator(".object-facts").locator("dt", { hasText: /^Raio \(R☉\)$/ })).toBeVisible();
    await expect(solar.locator(".object-facts").locator("dt", { hasText: /^Teff$/ })).toBeVisible();

    const screenshot = join(evidenceDirectory, `${checkpoint.name}-1440x900.png`);
    await page.screenshot({ path: screenshot });

    const exported = await readDownload(page);
    const sun = exported.bodies.find(({ id }) => id === "sun");
    expect(sun?.stellarEvolution?.ageYears).toBeCloseTo(checkpoint.ageYears, -3);
    expect(sun?.bodyType ?? "star").toBe(checkpoint.eep === 1710 ? "white-dwarf" : "star");
    expect(getSolarEvolutionTrackSample(sun!.stellarEvolution!.ageYears).trackEep)
      .toBeCloseTo(checkpoint.eep ?? getSolarEvolutionTrackSample(SOLAR_EVOLUTION_START_AGE_YEARS).trackEep, 2);

    const expected = getSolarEvolutionProperties(checkpoint.ageYears);
    const displayedRadiusText = await displayedMeasure(page, "Raio (R☉)").textContent();
    const displayedTemperatureText = await displayedMeasure(page, "Teff").textContent();
    const displayedRadius = parsePtNumber(displayedRadiusText ?? "");
    const displayedTemperature = parsePtNumber(displayedTemperatureText ?? "");
    expect(displayedRadius).toBeCloseTo(expected.radiusM / 695_700_000, 2);
    expect(displayedTemperature).toBeCloseTo(expected.effectiveTemperatureK, 0);
    expect(displayedRadius).toBeCloseTo(sun!.radiusM / 695_700_000, 2);
    expect(displayedTemperature).toBeCloseTo(sun!.surfaceTemperatureK, 0);
    await expect(page.locator("#object-inspector .object-kind")).toHaveText(checkpoint.type);

    console.log(`MIST ${checkpoint.name}: accepted=${sun!.stellarEvolution!.ageYears} yr, EEP=${getSolarEvolutionTrackSample(sun!.stellarEvolution!.ageYears).trackEep}, radius=${displayedRadius} R☉, Teff=${displayedTemperature} K, type=${sun!.bodyType ?? "star"}, screenshot=${screenshot}`);
  }

  expect(appConsole.filter(({ type }) => type === "error" || type === "pageerror")).toEqual([]);
  console.log(`App console: ${appConsole.length} messages; 0 errors/pageerrors; evidence=${evidenceDirectory}`);
  } finally {
    writeFileSync(join(evidenceDirectory, "app-console.json"), JSON.stringify(appConsole, null, 2));
  }
});

test("scene help and body selection stay keyboard-accessible on narrow mobile viewports", async ({ page }) => {
  const appConsole: Array<{ type: string; text: string }> = [];
  const layoutMetrics: Array<Record<string, unknown>> = [];
  page.on("console", (message) => appConsole.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => appConsole.push({ type: "pageerror", text: error.message }));
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const sceneHelp = page.locator(".scene-help");
      const summary = sceneHelp.getByText("Ajuda da cena", { exact: true });
      const canvasBox = await page.locator(".scene-panel").boundingBox();
      const transportBox = await page.locator(".transport").boundingBox();
      const navigationBox = await page.getByRole("navigation", { name: "Escolha um astro" }).boundingBox();
      expect(canvasBox).not.toBeNull();
      expect(transportBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      const jupiter = page.getByRole("navigation", { name: "Escolha um astro" })
        .getByRole("button", { name: "Júpiter", exact: true });
      await jupiter.focus();
      await page.keyboard.press("Enter");
      await expect(jupiter).toHaveAttribute("aria-pressed", "true");
      await jupiter.focus();
      await expect(jupiter).toBeFocused();
      const labelBox = await jupiter.boundingBox();
      expect(labelBox).not.toBeNull();

      await expect(sceneHelp).not.toHaveAttribute("open", "");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(sceneHelp).toHaveAttribute("open", "");
      await expect(page.getByRole("button", { name: "Editar Júpiter", exact: true })).toBeVisible();
      const helpContent = sceneHelp.locator(".scene-help-content");
      await expect(helpContent).toBeVisible();
      const contentBox = await helpContent.boundingBox();
      expect(contentBox).not.toBeNull();
      expect(contentBox!.height).toBeLessThanOrEqual(56);
      expect(await helpContent.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
      const bodyRadius = Math.min(canvasBox!.width, canvasBox!.height) * 0.3;
      const centralBodyBox = {
        x: canvasBox!.x + canvasBox!.width / 2 - bodyRadius,
        y: canvasBox!.y + canvasBox!.height * 0.39 - bodyRadius,
        width: bodyRadius * 2,
        height: bodyRadius * 2,
      };
      expect(overlaps(contentBox!, navigationBox!)).toBe(false);
      expect(overlaps(contentBox!, transportBox!)).toBe(false);
      expect(overlaps(contentBox!, centralBodyBox)).toBe(false);
      expect(overlaps(contentBox!, labelBox!)).toBe(false);
      layoutMetrics.push({ viewport, disclosure: contentBox, navigation: navigationBox, transport: transportBox, centralBody: centralBodyBox, focusedSelection: labelBox });
      console.log(`Mobile help ${viewport.width}x${viewport.height}: ${JSON.stringify(layoutMetrics.at(-1))}`);
      await page.screenshot({ path: join(evidenceDirectory, `mobile-help-${viewport.width}x${viewport.height}.png`) });
      await expect(helpContent.getByRole("link", { name: "Créditos das imagens" })).toBeVisible();
      await helpContent.getByRole("link", { name: "Créditos das imagens" }).focus();
      await expect(helpContent.getByRole("link", { name: "Créditos das imagens" })).toBeFocused();
      await expect.poll(() => helpContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(sceneHelp).not.toHaveAttribute("open", "");
    }
    expect(appConsole.filter(({ type }) => type === "error" || type === "pageerror")).toEqual([]);
  } finally {
    writeFileSync(join(evidenceDirectory, "mobile-app-console.json"), JSON.stringify(appConsole, null, 2));
    writeFileSync(join(evidenceDirectory, "mobile-layout.json"), JSON.stringify(layoutMetrics, null, 2));
  }
});
