import { expect, test } from "@playwright/test";
import type { Download, Page } from "@playwright/test";
import { getSolarEvolutionProperties, getSolarWindMassLostKg, SOLAR_EVOLUTION_END_AGE_YEARS } from "../src/simulation/stellar-evolution";
import { createSolarSystem } from "../src/simulation/solar-system";
import type { BodyType, StellarEvolutionMetadata } from "../src/simulation/types";

type SavedBody = {
  id: string;
  massKg: number;
  radiusM: number;
  velocityMs: number[];
  stellarEvolution?: StellarEvolutionMetadata;
  bodyType?: BodyType;
  parentId?: string;
  [key: string]: unknown;
};

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright did not provide the in-memory download stream.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportWorld(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Exportar", exact: true }).click(),
  ]);
  return JSON.parse((await readDownload(download)).toString()) as {
    version: number;
    settings: { gravitationalConstant: number };
    bodies: SavedBody[];
  };
}

async function importWorld(page: Page, name: string, world: unknown) {
  await page.getByLabel("Arquivo de simulação").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(world)),
  });
  await expect(page.getByRole("status").filter({ hasText: "Simulação importada com sucesso." }))
    .toHaveText("Simulação importada com sucesso.");
}

async function selectSun(page: Page) {
  await page.goto("/");
  const pause = page.getByRole("button", { name: "Pausar", exact: true });
  await pause.waitFor({ state: "visible" });
  await pause.click();
  await expect(page.getByRole("button", { name: "Retomar", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Escolha um astro" })
    .getByRole("button", { name: "Sol", exact: true }).click();
  const edit = page.getByRole("button", { name: "Editar Sol", exact: true });
  if (await edit.count()) {
    if (await edit.getAttribute("aria-expanded") !== "true") await edit.click();
  }
  await expect(page.locator("#object-inspector")).toBeVisible();
}

function displayedMeasure(page: Page, label: string) {
  return page.locator(".inspector .object-facts")
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

async function measure(page: Page, label: string): Promise<number> {
  const text = (await displayedMeasure(page, label).textContent()) ?? "";
  const normalized = text.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const match = normalized.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) throw new Error(`Could not parse ${label} measurement: ${text}`);
  return Number(match[0]);
}

async function changeTypedValue(page: Page, label: string, value: string) {
  const fields = page.locator("details.advanced-controls")
    .filter({ has: page.getByText("Digitar valores", { exact: true }) });
  if (!await fields.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await page.getByText("Digitar valores", { exact: true }).click();
  }
  const input = page.getByRole("textbox", { name: new RegExp(`^${label} \\(`) });
  await input.fill(value);
  await input.press("Tab");
}

test("solar evolution accepts age, updates properties, and keeps clocks exclusive", async ({ page }, testInfo) => {
  await selectSun(page);
  const solar = page.locator("details.advanced-controls").filter({ has: page.getByText("Evolução do Sol", { exact: true }) });
  const solarStatus = solar.locator('p[role="status"]');
  await solar.getByRole("button", { name: "Iniciar modelo solar", exact: true }).click();
  await expect(solarStatus).toHaveText("Evolução pausada.");

  const initialDiameter = await measure(page, "Diâmetro");
  const orbitalTime = await page.locator(".transport-time strong").textContent();
  await solar.getByText("Marcos fornecidos pelo modelo", { exact: true }).click();
  await solar.getByRole("button", { name: /Avançar até Ramo das gigantes vermelhas/ }).first().click();
  await expect(solarStatus).toHaveText("Evolução pausada.");
  await expect(solar.getByText(/Idade evolutiva:/)).toBeVisible();
  await expect(solar.locator(".object-facts").getByText("Ramo das gigantes vermelhas", { exact: true })).toBeVisible();
  expect(await measure(page, "Diâmetro")).toBeGreaterThan(initialDiameter);
  expect(await page.locator(".transport-time strong").textContent()).toBe(orbitalTime);

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktop = await page.screenshot({ path: testInfo.outputPath("solar-evolution-desktop.png") });
  await testInfo.attach("solar-evolution-desktop-1440x900", { body: desktop, contentType: "image/png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.screenshot({ path: testInfo.outputPath("solar-evolution-mobile-390x844.png") });
  await testInfo.attach("solar-evolution-mobile-390x844", { body: mobile, contentType: "image/png" });
  await page.setViewportSize({ width: 1440, height: 900 });

  const evolved = await exportWorld(page);
  expect(evolved.version).toBe(3);
  expect(evolved.bodies.find(({ id }) => id === "sun")?.stellarEvolution?.ageYears).toBeGreaterThan(4.58e9);
  await importWorld(page, "solar-v3.astro", evolved);
  expect((await exportWorld(page)).version).toBe(3);
  const importedOrbitalTime = await page.locator(".transport-time strong").textContent();

  await solar.getByRole("button", { name: "Iniciar evolução", exact: true }).click();
  await expect(solarStatus).toHaveText("Evolução ativa. O movimento orbital está pausado.");
  await expect(page.getByRole("button", { name: "Retomar", exact: true })).toBeDisabled();
  await solar.getByRole("button", { name: "Pausar evolução", exact: true }).click();
  await expect(solarStatus).toHaveText("Evolução pausada.");
  await expect(page.getByRole("button", { name: "Retomar", exact: true })).toBeEnabled();
  expect(await page.locator(".transport-time strong").textContent()).toBe(importedOrbitalTime);
});

test("solar mass and radius edits match physical scaling with configured G", async ({ page }) => {
  await selectSun(page);
  const initial = await exportWorld(page);
  expect(initial.settings.gravitationalConstant).toBe(6.6743e-11);
  const initialSun = initial.bodies.find(({ id }) => id === "sun")!;
  const initialDensity = await measure(page, "Densidade média");
  const initialGravity = await measure(page, "Gravidade superficial");
  const initialEscape = await measure(page, "Velocidade de escape");
  const initialDiameter = await measure(page, "Diâmetro");

  await page.getByRole("button", { name: "2 vezes a massa inicial", exact: true }).click();
  await expect.poll(async () => (await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg)
    .toBe(initialSun.massKg * 2);
  expect(await measure(page, "Densidade média") / initialDensity).toBeCloseTo(2, 2);
  expect(await measure(page, "Gravidade superficial") / initialGravity).toBeCloseTo(2, 2);
  expect(await measure(page, "Velocidade de escape") / initialEscape).toBeCloseTo(Math.sqrt(2), 2);
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.velocityMs).toEqual(initialSun.velocityMs);

  await page.getByRole("button", { name: "1 vezes a massa inicial", exact: true }).click();
  await changeTypedValue(page, "Raio", String(initialSun.radiusM * 2 / 1000));
  await expect.poll(async () => (await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.radiusM)
    .toBe(initialSun.radiusM * 2);
  expect(await measure(page, "Diâmetro") / initialDiameter).toBeCloseTo(2, 2);
  expect(await measure(page, "Densidade média") / initialDensity).toBeCloseTo(1 / 8, 2);
  expect(await measure(page, "Gravidade superficial") / initialGravity).toBeCloseTo(1 / 4, 2);
  expect(await measure(page, "Velocidade de escape") / initialEscape).toBeCloseTo(1 / Math.sqrt(2), 2);

  await page.getByText("Gravidade", { exact: true }).click();
  const gravityInput = page.getByLabel("Intensidade da gravidade (× natural)");
  await gravityInput.fill("0");
  await gravityInput.press("Tab");
  await expect.poll(async () => (await exportWorld(page)).settings.gravitationalConstant).toBe(0);
  expect(await measure(page, "Gravidade superficial")).toBe(0);
  expect(await measure(page, "Velocidade de escape")).toBe(0);
  await gravityInput.fill("1");
  await gravityInput.press("Tab");
  await expect.poll(async () => (await exportWorld(page)).settings.gravitationalConstant).toBeCloseTo(6.6743e-11, 20);

  await importWorld(page, "black-hole-v2.astro", {
    format: "astro-simulation",
    version: 2,
    settings: { gravitationalConstant: 6.6743e-11 },
    bodies: [{
      id: "black-hole",
      name: "Buraco negro de teste",
      kind: "star",
      bodyType: "black-hole",
      massKg: 2e30,
      radiusM: 2 * 6.6743e-11 * 2e30 / 299_792_458 ** 2,
      positionM: [0, 0, 0],
      velocityMs: [0, 0, 0],
      surfaceTemperatureK: 0,
      waterFraction: 0,
    }],
  });
  await page.getByText("Medidas derivadas", { exact: true }).click();
  await expect(displayedMeasure(page, "Diâmetro")).toBeVisible();
  await expect(page.locator(".inspector .object-facts").getByText("Gravidade superficial", { exact: true })).toHaveCount(0);
  await expect(page.locator(".inspector .object-facts").getByText("Velocidade de escape", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/não há relatividade geral/)).toBeVisible();
});

test("harness: keeps a manual solar edit pending until synthetic Worker rejection", async ({ page }) => {
  await page.addInitScript(`(() => {
    const NativeWorker = window.Worker;
    window.__rejectNextBodyEdit = false;
    window.__pendingRejectedRevision = null;
    window.__lastAcceptedWorkerSnapshot = null;
    window.__releaseRejectedEdit = () => {};
    window.Worker = class extends EventTarget {
      constructor(...args) {
        super();
        this.worker = new NativeWorker(...args);
        this.worker.addEventListener("message", (event) => {
          window.__lastAcceptedWorkerSnapshot = event.data.snapshot;
          this.dispatchEvent(new MessageEvent("message", { data: event.data }));
        });
        this.worker.addEventListener("error", (event) => this.dispatchEvent(new ErrorEvent("error", { message: event.message })));
        this.worker.addEventListener("messageerror", () => this.dispatchEvent(new MessageEvent("messageerror")));
      }
      postMessage(message, options) {
        if (window.__rejectNextBodyEdit && message.type === "MUTATE_WORLD" && message.mutation?.type === "EDIT_BODY") {
          window.__rejectNextBodyEdit = false;
          window.__pendingRejectedRevision = message.revision;
          window.__releaseRejectedEdit = () => this.dispatchEvent(new MessageEvent("message", { data: {
            type: "ERROR", message: "Worker rejeitou edição de teste.", worldRevision: message.revision,
            rejectedRevision: message.revision,
            snapshot: { ...window.__lastAcceptedWorkerSnapshot, worldRevision: message.revision },
          } }));
          return;
        }
        this.worker.postMessage(message, options);
      }
      terminate() { this.worker.terminate(); }
    };
  })()`);
  await selectSun(page);
  const before = await exportWorld(page);
  const initialMass = before.bodies.find(({ id }) => id === "sun")!.massKg;
  await page.evaluate(() => { Reflect.set(window, "__rejectNextBodyEdit", true); });

  await page.getByRole("button", { name: "2 vezes a massa inicial", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__pendingRejectedRevision"))).not.toBeNull();
  await expect(page.getByRole("alert").filter({ hasText: "Worker rejeitou edição de teste." })).toHaveCount(0);
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg).toBe(initialMass);

  await page.evaluate(() => Reflect.apply(Reflect.get(window, "__releaseRejectedEdit") as (...args: never[]) => void, window, []));
  await expect(page.getByRole("alert").filter({ hasText: "Worker rejeitou edição de teste." })).toBeVisible();
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg).toBe(initialMass);
});

test("real Worker edit keeps accepted revision and body visible until its snapshot arrives", async ({ page }) => {
  await page.addInitScript(`(() => {
    const NativeWorker = window.Worker;
    window.__holdNextEditSnapshot = false;
    window.__targetEditRevision = null;
    window.__heldWorkerSnapshotRevision = null;
    window.__staleWorkerSnapshot = null;
    window.__releaseWorkerSnapshot = () => {};
    window.__replayStaleWorkerSnapshot = () => {};
    window.Worker = class extends EventTarget {
      constructor(...args) {
        super();
        this.worker = new NativeWorker(...args);
        this.worker.addEventListener("message", (event) => {
          if (event.data.type === "SNAPSHOT" && window.__staleWorkerSnapshot === null) {
            window.__staleWorkerSnapshot = event.data;
          }
          if (event.data.type === "SNAPSHOT" && event.data.worldRevision === window.__targetEditRevision) {
            this.heldSnapshot = event.data;
            window.__heldWorkerSnapshotRevision = event.data.worldRevision;
            window.__releaseWorkerSnapshot = () => {
              if (!this.heldSnapshot) return;
              this.dispatchEvent(new MessageEvent("message", { data: this.heldSnapshot }));
              this.heldSnapshot = null;
            };
            window.__replayStaleWorkerSnapshot = () => this.dispatchEvent(new MessageEvent("message", { data: window.__staleWorkerSnapshot }));
            return;
          }
          this.dispatchEvent(new MessageEvent("message", { data: event.data }));
        });
        this.worker.addEventListener("error", (event) => this.dispatchEvent(new ErrorEvent("error", { message: event.message })));
        this.worker.addEventListener("messageerror", () => this.dispatchEvent(new MessageEvent("messageerror")));
      }
      postMessage(message, options) {
        if (window.__holdNextEditSnapshot && message.type === "MUTATE_WORLD" && message.mutation?.type === "EDIT_BODY") {
          window.__holdNextEditSnapshot = false;
          window.__targetEditRevision = message.revision;
        }
        this.worker.postMessage(message, options);
      }
      terminate() { this.worker.terminate(); }
    };
  })()`);
  await selectSun(page);
  const before = await exportWorld(page);
  const initialMass = before.bodies.find(({ id }) => id === "sun")!.massKg;
  const acceptedRevision = await page.locator("main").getAttribute("data-accepted-world-revision");
  await page.evaluate(() => { Reflect.set(window, "__holdNextEditSnapshot", true); });

  await page.getByRole("button", { name: "2 vezes a massa inicial", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__targetEditRevision"))).not.toBeNull();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__heldWorkerSnapshotRevision"))).toBeGreaterThan(Number(acceptedRevision));
  await expect(page.locator("main")).toHaveAttribute("data-accepted-world-revision", acceptedRevision!);
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg).toBe(initialMass);

  const workerRevision = await page.evaluate(() => Reflect.get(window, "__heldWorkerSnapshotRevision"));
  await page.evaluate(() => Reflect.apply(Reflect.get(window, "__releaseWorkerSnapshot") as (...args: never[]) => void, window, []));
  await expect(page.locator("main")).toHaveAttribute("data-accepted-world-revision", String(workerRevision));
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg).toBe(initialMass * 2);

  await page.evaluate(() => Reflect.apply(Reflect.get(window, "__replayStaleWorkerSnapshot") as (...args: never[]) => void, window, []));
  await expect(page.locator("main")).toHaveAttribute("data-accepted-world-revision", String(workerRevision));
  expect((await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg).toBe(initialMass * 2);
});

test("manual solar edits preserve velocity; v1/v2 imports and Reset Solar restore the preset", async ({ page }) => {
  await selectSun(page);
  const solar = page.locator("details.advanced-controls").filter({ has: page.getByText("Evolução do Sol", { exact: true }) });
  const solarStatus = solar.locator('p[role="status"]');
  await solar.getByRole("button", { name: "Iniciar modelo solar", exact: true }).click();
  await solar.getByRole("button", { name: "Sair da evolução para editar", exact: true }).click();
  await expect(solarStatus).toHaveText("Modo manual. A trilha evolutiva está interrompida.");
  const before = (await exportWorld(page)).bodies.find(({ id }) => id === "sun")!;
  await changeTypedValue(page, "Massa", "2");
  await changeTypedValue(page, "Raio", "800000");
  await expect.poll(async () => (await exportWorld(page)).bodies.find(({ id }) => id === "sun")?.massKg)
    .toBe(2e30);
  const manual = (await exportWorld(page)).bodies.find(({ id }) => id === "sun")!;
  expect(manual.radiusM).toBe(800_000_000);
  expect(manual.velocityMs).toEqual(before.velocityMs);
  expect(manual.stellarEvolution?.mode).toBe("manual");

  const savedManual = await exportWorld(page);
  const v2 = { ...savedManual, version: 2, bodies: manualWorldBodies(savedManual) };
  await importWorld(page, "solar-legacy-v2.astro", v2);
  const v1 = {
    ...v2,
    version: 1,
    bodies: v2.bodies.map((body: Record<string, unknown>) => {
      const legacy = { ...body };
      delete legacy.bodyType;
      delete legacy.parentId;
      return legacy;
    }),
  };
  await importWorld(page, "solar-legacy-v1.astro", v1);
  expect((await exportWorld(page)).version).toBe(2);

  await page.getByRole("button", { name: /^Reset Solar/ }).click();
  await page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { name: "Sol", exact: true }).click();
  const reset = await exportWorld(page);
  const resetSun = reset.bodies.find(({ id }) => id === "sun")!;
  expect(reset.version).toBe(2);
  expect(reset.bodies).toHaveLength(10);
  expect(reset.settings.gravitationalConstant).toBe(6.6743e-11);
  expect(resetSun.massKg).toBe(1.9884e30);
  expect(resetSun.radiusM).toBe(695_700_000);
  expect(resetSun.stellarEvolution).toBeUndefined();
});

test("terminal solar milestone reaches white dwarf and rejects out-of-domain v3 atomically", async ({ page }) => {
  test.setTimeout(120_000);
  await selectSun(page);
  const solar = page.locator("details.advanced-controls").filter({ has: page.getByText("Evolução do Sol", { exact: true }) });
  const solarStatus = solar.locator('p[role="status"]');
  await solar.getByRole("button", { name: "Iniciar modelo solar", exact: true }).click();
  await expect(solarStatus).toHaveText("Evolução pausada.");
  await solar.getByText("Marcos fornecidos pelo modelo", { exact: true }).click();
  await solar.getByRole("button", { name: /Avançar até Início da formação da anã branca/ }).click();
  await expect(solarStatus).toHaveText("Evolução pausada.");
  await expect(solar.locator(".object-facts").getByText("Início da formação da anã branca", { exact: true })).toBeVisible();

  const terminal = await exportWorld(page);
  expect(terminal.version).toBe(3);
  const sun = terminal.bodies.find(({ id }) => id === "sun")!;
  const metadata = sun.stellarEvolution!;
  expect(metadata.ageYears).toBe(SOLAR_EVOLUTION_END_AGE_YEARS);
  expect(sun.bodyType).toBe("white-dwarf");
  expect(Number.isFinite(sun.massKg) && sun.massKg > 0).toBe(true);
  expect(Number.isFinite(sun.radiusM) && sun.radiusM > 0).toBe(true);
  const track = getSolarEvolutionProperties(SOLAR_EVOLUTION_END_AGE_YEARS, metadata.accretedMassKg);
  expect(Math.abs(sun.massKg / track.massKg - 1)).toBeLessThan(1e-12);
  expect(Math.abs(sun.radiusM / track.radiusM - 1)).toBeLessThan(1e-12);

  const presetMassById = new Map(createSolarSystem().map(({ id, massKg }) => [id, massKg]));
  const absorbedMass = metadata.absorbedBodyIds.reduce((sum, id) => sum + (presetMassById.get(id) ?? NaN), 0);
  expect(metadata.absorbedBodyIds.length).toBeGreaterThan(0);
  expect(Math.abs(metadata.accretedMassKg - absorbedMass)).toBeLessThan(Math.max(1, absorbedMass) * 1e-12);
  for (const id of metadata.absorbedBodyIds) expect(presetMassById.has(id)).toBe(true);
  const activeMass = terminal.bodies.reduce((sum, body) => sum + body.massKg, 0);
  const initialMass = createSolarSystem().reduce((sum, body) => sum + body.massKg, 0);
  const windMass = getSolarWindMassLostKg(SOLAR_EVOLUTION_END_AGE_YEARS);
  expect(Math.abs((activeMass + windMass) / initialMass - 1)).toBeLessThan(1e-12);

  const invalid = structuredClone(terminal);
  invalid.bodies.find(({ id }) => id === "sun")!.stellarEvolution!.ageYears = SOLAR_EVOLUTION_END_AGE_YEARS + 1;
  await page.getByLabel("Arquivo de simulação").setInputFiles({
    name: "solar-v3-age-out-of-domain.astro",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.locator(".save-controls [role=status]"))
    .toHaveText("O arquivo de simulação contém dados inválidos ou incompletos.");
  expect(await exportWorld(page)).toEqual(terminal);
});

function manualWorldBodies(world: { bodies: SavedBody[] }) {
  return world.bodies.map((body) => {
    const legacy = { ...body };
    delete legacy.stellarEvolution;
    return legacy;
  });
}
