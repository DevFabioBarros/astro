import { expect, test } from "@playwright/test";
import type { Download } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright did not provide the in-memory download stream.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportWorld(page: import("@playwright/test").Page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar", exact: true }).click()]);
  return JSON.parse((await readDownload(download)).toString());
}

type SavedBodySummary = { id: string; radiusM: number };
type EncodedWorld = { bodies?: SavedBodySummary[]; world?: { bodies: SavedBodySummary[] } };

async function exportEncodedWorld(page: import("@playwright/test").Page): Promise<EncodedWorld> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar", exact: true }).click()]);
  return JSON.parse((await readDownload(download)).toString()) as EncodedWorld;
}

function savedBodies(save: EncodedWorld): SavedBodySummary[] {
  return save.world?.bodies ?? save.bodies ?? [];
}

async function importWorld(page: import("@playwright/test").Page, name: string, world: unknown) {
  await page.getByLabel("Arquivo de simulação").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(world)) });
  await expect(page.getByRole("status").filter({ hasText: "Simulação importada com sucesso." })).toHaveText("Simulação importada com sucesso.");
}

async function ensureInspectorOpen(page: import("@playwright/test").Page, bodyName: string) {
  const edit = page.getByRole("button", { name: `Editar ${bodyName}`, exact: true });
  if (await edit.count()) {
    if (await edit.getAttribute("aria-expanded") !== "true") await edit.click();
  } else {
    await expect(page.locator(".mobile-inspector-toggle")).toHaveAttribute("aria-expanded", "true");
  }
  await expect(page.locator("#object-inspector")).toBeVisible();
}

async function ensureHistoryControlsOpen(page: import("@playwright/test").Page) {
  const panel = page.locator(".transport-more");
  if (!await panel.evaluate((element) => (element as HTMLDetailsElement).open)) await panel.locator(":scope > summary").click();
}

test("changes solar mass with a keyboard slider and resets the complete system", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.getByRole("list").getByRole("button", { name: "Sol", exact: true }).click();
  await ensureInspectorOpen(page, "Sol");
  const initial = await exportWorld(page);
  const initialSolarMass = initial.bodies.find((body: { id: string }) => body.id === "sun").massKg;
  const slider = page.getByRole("slider", { name: "Massa", exact: true });
  await slider.focus();
  await slider.press("ArrowRight");
  await expect.poll(async () => (await exportWorld(page)).bodies.find((body: { id: string }) => body.id === "sun").massKg).toBeGreaterThan(initialSolarMass);
  await page.getByRole("button", { name: "2 vezes a massa inicial", exact: true }).click();
  const doubled = await exportWorld(page);
  expect(doubled.bodies.find((body: { id: string }) => body.id === "sun").massKg).toBe(initial.bodies[0].massKg * 2);
  expect(doubled.bodies.find((body: { id: string }) => body.id === "earth").positionM).toEqual(initial.bodies.find((body: { id: string }) => body.id === "earth").positionM);
  await page.getByLabel("Passagem do tempo").selectOption("604800");
  await page.getByText("Gravidade", { exact: true }).click();
  const gravity = page.getByLabel("Intensidade da gravidade (× natural)");
  await gravity.fill("0"); await gravity.press("Tab");
  await page.getByRole("button", { name: "Reiniciar sistema", exact: true }).click();
  await ensureInspectorOpen(page, "Terra");
  await expect(page.getByRole("heading", { name: "Terra", exact: true })).toBeVisible();
  await expect(page.getByLabel("Passagem do tempo")).toHaveValue("86400");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const reset = await exportWorld(page);
  expect(reset.bodies).toHaveLength(10);
  expect(reset.bodies.find((body: { id: string }) => body.id === "sun").massKg).toBe(initial.bodies[0].massKg);
  expect(reset.settings.gravitationalConstant).toBe(initial.settings.gravitationalConstant);
});

test("removes Earth without deleting or teleporting the Moon and then advances its solar trajectory", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const before = await exportWorld(page);
  const moon = before.bodies.find((body: { id: string }) => body.id === "moon");
  await ensureInspectorOpen(page, "Terra");
  await page.getByRole("button", { name: "Remover Terra", exact: true }).click();
  expect((await exportWorld(page)).bodies).toHaveLength(9);
  const removed = await exportWorld(page);
  const orphan = removed.bodies.find((body: { id: string }) => body.id === "moon");
  expect(orphan.positionM).toEqual(moon.positionM);
  expect(orphan.velocityMs).toEqual(moon.velocityMs);
  expect(removed.bodies.some((body: { id: string }) => body.id === "earth")).toBe(false);
  await page.getByRole("button", { name: "Fechar editor", exact: true }).click();
  await page.getByRole("list").getByRole("button", { name: "Lua", exact: true }).click();
  await ensureInspectorOpen(page, "Lua");
  await expect(page.getByText(/Em órbita de Sol/)).toBeVisible();
  await page.getByRole("button", { name: "Retomar", exact: true }).click();
  await expect.poll(async () => {
    const current = (await exportWorld(page)).bodies.find((body: { id: string }) => body.id === "moon");
    return Math.hypot(...current.positionM.map((value: number, axis: number) => value - moon.positionM[axis]));
  }).toBeGreaterThan(1e8);
});

for (const [name, bodyType] of [["Estrela", "star"], ["Anã branca", "white-dwarf"], ["Estrela de nêutrons", "neutron-star"], ["Buraco negro", "black-hole"], ["Planeta rochoso", "rocky-planet"], ["Gigante gasoso", "gas-giant"], ["Lua", "moon"], ["Asteroide", "asteroid"], ["Cometa", "comet"]]) {
  test(`creates ${name} while paused and exports its physical type`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.getByRole("button", { name: "Criar astro", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Crie seu universo" });
    await dialog.locator(".catalog-option").filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) }).click();
    if (bodyType === "moon") await page.getByLabel("Orbitar ao redor de").selectOption("earth");
    await dialog.getByRole("button", { name: `Criar ${name.toLocaleLowerCase("pt-BR")}`, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: `${name} 1`, exact: true })).toBeVisible();
    await ensureInspectorOpen(page, `${name} 1`);
    const created = (await exportWorld(page)).bodies.find((body: { id: string }) => body.id === `${bodyType}-1`);
    expect(created.bodyType).toBe(bodyType);
    if (bodyType === "black-hole") await expect(page.getByRole("slider", { name: "Horizonte de eventos", exact: true })).toBeDisabled();
  });
}

test("imports legacy v1 and an empty v2 world before creating a fresh star", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const world = await exportWorld(page);
  expect(world.version).toBe(2);
  const legacy = { ...world, version: 1, bodies: world.bodies.map((body: Record<string, unknown>) => {
    const copy = { ...body }; delete copy.bodyType; delete copy.parentId; return copy;
  }) };
  await page.getByLabel("Arquivo de simulação").setInputFiles({ name: "legacy.astro", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
  await expect(page.getByRole("status").filter({ hasText: "Simulação importada com sucesso." })).toHaveText("Simulação importada com sucesso.");
  expect((await exportWorld(page)).version).toBe(2);
  await page.getByLabel("Arquivo de simulação").setInputFiles({ name: "empty.astro", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...world, bodies: [] })) });
  await expect(page.getByRole("list").getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Criar astro", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Crie seu universo" });
  await expect(dialog.locator(".catalog-option").filter({ has: page.locator("strong", { hasText: /^Lua$/ }) })).toBeDisabled();
  await dialog.locator(".catalog-option").filter({ has: page.locator("strong", { hasText: /^Estrela$/ }) }).click();
  await dialog.getByRole("button", { name: "Criar estrela", exact: true }).click();
  await ensureInspectorOpen(page, "Estrela 1");
  const created = await exportWorld(page);
  expect(created.bodies).toHaveLength(1);
  expect(created.bodies[0].bodyType).toBe("star");
});

test("selects 1x and 60x simulation speeds", async ({ page }) => {
  await page.goto("/");
  const speed = page.getByRole("combobox", { name: "Passagem do tempo" });
  await speed.selectOption("1");
  await expect(speed).toHaveValue("1");
  await speed.selectOption("60");
  await expect(speed).toHaveValue("60");
});

test("imports a local v2 world, resets it, and still accepts a legacy v1 world", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const original = await exportWorld(page);
  const compactV2 = { ...original, bodies: original.bodies.slice(0, 1) };

  await importWorld(page, "local-v2.astro", compactV2);
  expect((await exportWorld(page)).bodies).toHaveLength(1);
  expect((await exportWorld(page)).version).toBe(2);

  await page.getByRole("button", { name: "Reiniciar sistema", exact: true }).click();
  expect((await exportWorld(page)).bodies).toHaveLength(10);
  await expect(page.getByLabel("Passagem do tempo")).toHaveValue("86400");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();

  const legacy = { ...original, version: 1, bodies: original.bodies.map((body: Record<string, unknown>) => {
    const copy = { ...body }; delete copy.bodyType; delete copy.parentId; return copy;
  }) };
  await importWorld(page, "local-legacy-v1.astro", legacy);
  const normalized = await exportWorld(page);
  expect(normalized.version).toBe(2);
  expect(normalized.bodies).toHaveLength(10);
});

test("explodes an imported rocky planet into six fragments with conserved mass and momentum", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const world = {
    format: "astro-simulation",
    version: 2,
    settings: { gravitationalConstant: 6.6743e-11 },
    bodies: [{
      id: "explosion-source",
      name: "Planeta de teste",
      kind: "planet",
      bodyType: "rocky-planet",
      massKg: 1e20,
      radiusM: 1e5,
      positionM: [0, 0, 0],
      velocityMs: [0, 0, 0],
      surfaceTemperatureK: 200,
      waterFraction: 0,
    }],
  };
  await importWorld(page, "explosion-v2.astro", world);

  await ensureInspectorOpen(page, "Planeta de teste");
  const explode = page.getByRole("button", { name: "Explodir astro", exact: true });
  await explode.click();
  const eventStatus = page.getByRole("status", { name: "Evento astronômico" });
  await expect(eventStatus).toContainText("Explosão experimental: seis fragmentos. Não é uma supernova.");
  await testInfo.attach("explosion-render-desktop-1440x900", { body: await page.screenshot(), contentType: "image/png" });
  await expect(explode).toBeFocused();
  await page.getByRole("button", { name: "Fechar editor", exact: true }).click();
  const selectedBodies = page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { pressed: true });
  await expect(selectedBodies).toHaveCount(1);
  const exported = await exportWorld(page);
  expect(exported.version).toBe(2);
  const fragments = exported.bodies;
  expect(fragments).toHaveLength(6);
  const totalMass = fragments.reduce((sum: number, body: { massKg: number }) => sum + body.massKg, 0);
  expect(Math.abs(totalMass - 1e20) / 1e20).toBeLessThan(1e-12);
  const centerOfMassVelocity = [0, 1, 2].map((axis) => fragments.reduce(
    (sum: number, body: { massKg: number; velocityMs: number[] }) => sum + body.massKg * body.velocityMs[axis]!,
    0,
  ) / totalMass);
  centerOfMassVelocity.forEach((component) => expect(component).toBeCloseTo(0, 6));

  await page.getByRole("button", { name: "Reiniciar sistema", exact: true }).click();
  expect((await exportWorld(page)).bodies).toHaveLength(10);
  await expect(eventStatus).toBeHidden();

  await importWorld(page, "explosion-reimport-v2.astro", world);
  await expect(eventStatus).toBeHidden();
  await ensureInspectorOpen(page, "Planeta de teste");
  const reexplode = page.getByRole("button", { name: "Explodir astro", exact: true });
  await reexplode.click();
  await expect(eventStatus).toContainText("Explosão experimental: seis fragmentos. Não é uma supernova.");
  await expect(reexplode).toBeFocused();
});

test("keeps compact objects from exploding and exposes their accessible explanation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await importWorld(page, "compact-object-v2.astro", {
    format: "astro-simulation",
    version: 2,
    settings: { gravitationalConstant: 6.6743e-11 },
    bodies: [{ id: "neutron-star-test", name: "Estrela de nêutrons", kind: "star", bodyType: "neutron-star", massKg: 2e30, radiusM: 12000, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 1e6, waterFraction: 0 }],
  });

  await ensureInspectorOpen(page, "Estrela de nêutrons");
  const explode = page.getByRole("button", { name: "Explodir astro", exact: true });
  await expect(explode).toBeDisabled();
  const descriptionId = await explode.getAttribute("aria-describedby");
  expect(descriptionId).toBeTruthy();
  await expect(page.locator(`#${descriptionId}`)).toContainText("Astros compactos continuam indisponíveis para fragmentação neste experimento.");
});

test("imports a deterministic collision and captures the rendered merger event", async ({ page }, testInfo) => {
  const appErrors: string[] = [];
  page.on("pageerror", (error) => appErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") appErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await importWorld(page, "collision-v2.astro", {
    format: "astro-simulation",
    version: 2,
    settings: { gravitationalConstant: 0 },
    bodies: [
      { id: "impact-a", name: "A", kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1000, positionM: [-10000, 0, 0], velocityMs: [100, 0, 0], surfaceTemperatureK: 200, waterFraction: 0 },
      { id: "impact-b", name: "B", kind: "planet", bodyType: "asteroid", massKg: 1e15, radiusM: 1000, positionM: [10000, 0, 0], velocityMs: [-100, 0, 0], surfaceTemperatureK: 200, waterFraction: 0 },
    ],
  });
  await page.getByLabel("Passagem do tempo").selectOption("60");
  await page.getByRole("button", { name: "Retomar", exact: true }).click();
  await expect.poll(async () => (await exportWorld(page)).bodies.length).toBe(1);
  const eventNotice = page.locator(".event-notice");
  await expect(eventNotice.getByRole("status")).toHaveText("Impacto: astros se fundiram.");
  const impactDetails = eventNotice.locator(".collision-details");
  const detailsSummary = impactDetails.locator("summary");
  await expect(impactDetails).not.toHaveAttribute("open", "");
  await expect(impactDetails.getByText("Fusão perfeitamente inelástica (v1)")).toBeHidden();
  await detailsSummary.focus();
  await detailsSummary.press("Enter");
  await expect(impactDetails).toHaveAttribute("open", "");
  await expect(impactDetails).toContainText("Fusão perfeitamente inelástica (v1)");
  await expect(impactDetails).toContainText("200 m/s");
  await expect(impactDetails).toContainText("5.000 J/kg");
  await expect(impactDetails).toContainText("0°");
  await expect(impactDetails).toContainText("Energia cinética relativa removida (não calor)");
  await expect(impactDetails).toContainText("10.000.000.000.000.000.000 J");
  await expect(impactDetails).toContainText("O efeito visual é ilustrativo e não representa ejeção física.");
  await detailsSummary.press("Enter");
  await expect(impactDetails).not.toHaveAttribute("open", "");
  await expect(impactDetails.getByText("Fusão perfeitamente inelástica (v1)")).toBeHidden();
  await expect(page.locator(".scene-frame")).toHaveAttribute("data-glb-loaded", "true");
  await testInfo.attach("collision-flash-desktop-1440x900", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 320, height: 740 });
  await testInfo.attach("collision-render-mobile-320", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 480, height: 844 });
  await testInfo.attach("collision-render-mobile-480", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Pausar", exact: true }).click();

  const exported = await exportWorld(page);
  expect(exported.version).toBe(2);
  await expect(page.getByRole("list").getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("list").getByRole("button")).toHaveAttribute("aria-pressed", "true");
  const merged = exported.bodies[0];
  expect(merged.id).toBe("impact-a");
  expect(merged.kind).toBe("planet");
  expect(merged.bodyType).toBe("asteroid");
  expect(merged.massKg).toBe(2e15);
  merged.velocityMs.forEach((component: number) => expect(component).toBeCloseTo(0, 8));
  expect(merged.radiusM).toBeCloseTo(1000 * 2 ** (1 / 3), 6);
  await testInfo.attach("collision-render-and-inspector", { body: await page.screenshot(), contentType: "image/png" });
  await importWorld(page, "collision-merged-v2.astro", exported);
  await expect(eventNotice).toBeHidden();
  const restored = await exportWorld(page);
  expect(restored.bodies).toHaveLength(1);
  expect(restored.bodies[0].id).toBe("impact-a");
  await expect(eventNotice).toBeHidden();
  expect(appErrors).toEqual([]);
});

test("captures the textured Earth–Mars Worker merge before contact, during its pulse, and after VFX expiry", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  const appErrors: string[] = [];
  const appConsole: { type: string; text: string }[] = [];
  const textureResponses: { url: string; status: number }[] = [];
  page.on("pageerror", (error) => appErrors.push(error.message));
  page.on("console", (message) => {
    appConsole.push({ type: message.type(), text: message.text() });
    if (message.type() === "error") appErrors.push(message.text());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (/\/textures\/(?:earth-day(?:-2k)?|earth-night|mars)\.jpg$/.test(url.pathname)) textureResponses.push({ url: url.pathname, status: response.status() });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const screenshotSession = await page.context().newCDPSession(page);
  await screenshotSession.send("Page.enable");
  const captureFrame = async (path: string) => {
    const { data } = await screenshotSession.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await writeFile(path, Buffer.from(data, "base64"));
  };
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await expect(page.locator(".scene-frame")).toHaveAttribute("data-glb-loaded", "true");
  await expect.poll(() => textureResponses.some(({ url, status }) => /earth-day(?:-2k)?\.jpg$/.test(url) && status === 200)).toBe(true);
  await expect.poll(() => textureResponses.some(({ url, status }) => url === "/textures/mars.jpg" && status === 200)).toBe(true);

  const sun = { id: "sun", name: "Sol", kind: "star", bodyType: "star", massKg: 1.9884e30, radiusM: 695700000, positionM: [0, -2e9, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 5772, waterFraction: 0 };
  const earth = { id: "earth", name: "Terra", kind: "planet", bodyType: "rocky-planet", massKg: 5.97217e24, radiusM: 6371008.4, positionM: [-5380254.2, 0, 0], velocityMs: [5000, 0, 0], surfaceTemperatureK: 288, waterFraction: 0.71 };
  const mars = { id: "mars", name: "Marte", kind: "planet", bodyType: "rocky-planet", massKg: 6.41691e23, radiusM: 3389500, positionM: [5380254.2, 0, 0], velocityMs: [-earth.massKg / 6.41691e23 * 5000, 0, 0], surfaceTemperatureK: 208, waterFraction: 0 };
  await importWorld(page, "textured-earth-mars-collision-v2.astro", {
    format: "astro-simulation", version: 2, settings: { gravitationalConstant: 0 }, bodies: [sun, earth, mars],
  });
  const initial = await exportWorld(page);
  expect(initial.bodies.filter((body: { id: string }) => body.id !== "sun").map((body: { id: string; name: string; bodyType: string }) => [body.id, body.name, body.bodyType])).toEqual([
    ["earth", "Terra", "rocky-planet"], ["mars", "Marte", "rocky-planet"],
  ]);
  await page.getByRole("button", { name: "Focar astro", exact: true }).click();
  await expect(page.getByRole("button", { name: "Focar astro", exact: true })).toHaveAttribute("aria-pressed", "true");
  const closeInspector = page.getByRole("button", { name: "Fechar editor", exact: true });
  if (await closeInspector.count()) await closeInspector.click();
  const sceneCanvas = page.locator("canvas.simulation-webgl");
  const sceneBounds = await sceneCanvas.boundingBox();
  expect(sceneBounds?.width).toBeGreaterThan(600);
  expect(sceneBounds?.height).toBeGreaterThan(400);
  const preContactPath = testInfo.outputPath("earth-mars-pre-contact.png");
  await captureFrame(preContactPath);

  await page.getByLabel("Passagem do tempo").selectOption("60");
  await page.getByRole("button", { name: "Retomar", exact: true }).click();
  const eventNotice = page.locator(".event-notice");
  await expect(eventNotice.getByRole("status")).toHaveText("Impacto: astros se fundiram.");
  const acceptedAt = Date.now();
  const contactPath = testInfo.outputPath("earth-mars-contact-pulse.png");
  await captureFrame(contactPath);
  const contactCaptureDelayMs = Date.now() - acceptedAt;
  await expect.poll(async () => (await exportWorld(page)).bodies.filter((body: { kind: string }) => body.kind === "planet").length).toBe(1);
  const merged = await exportWorld(page);
  const remnant = merged.bodies.find((body: { id: string }) => body.id === "earth");
  expect(remnant).toMatchObject({ id: "earth", name: "Terra + Marte", kind: "planet", bodyType: "rocky-planet", massKg: earth.massKg + mars.massKg });
  expect(remnant.radiusM).toBeCloseTo((earth.radiusM ** 3 + mars.radiusM ** 3) ** (1 / 3), 5);
  remnant.velocityMs.forEach((component: number) => expect(component).toBeCloseTo(0, 8));
  const collisionDetails = eventNotice.locator(".collision-details");
  await expect(collisionDetails).toBeVisible();
  await collisionDetails.locator("summary").click();
  await expect(collisionDetails).toContainText("Fusão perfeitamente inelástica (v1)");
  await expect(collisionDetails).toContainText("Velocidade relativa");
  await expect(collisionDetails).toContainText("Energia específica do impacto (Q_R)");
  await expect(collisionDetails).toContainText("Energia cinética relativa removida (não calor)");
  await expect(collisionDetails).toContainText("O efeito visual é ilustrativo e não representa ejeção física.");
  const relativeSpeedMps = Math.hypot(earth.velocityMs[0] - mars.velocityMs[0], 0, 0);
  const reducedMassKg = earth.massKg * mars.massKg / (earth.massKg + mars.massKg);
  const relativeEnergyJ = 0.5 * reducedMassKg * relativeSpeedMps ** 2;
  const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  await expect(collisionDetails).toContainText(`${number.format(relativeSpeedMps)} m/s`);
  await expect(collisionDetails).toContainText(`${number.format(relativeEnergyJ / (earth.massKg + mars.massKg))} J/kg`);
  await expect(collisionDetails).toContainText("0°");
  await collisionDetails.locator("summary").click();

  await page.waitForTimeout(3400);
  const postExpiryPath = testInfo.outputPath("earth-mars-persistent-remnant-after-vfx.png");
  await captureFrame(postExpiryPath);
  const afterExpiry = await exportWorld(page);
  expect(afterExpiry.bodies).toHaveLength(2);
  const persistentRemnant = afterExpiry.bodies.find((body: { id: string }) => body.id === "earth");
  expect(persistentRemnant).toMatchObject({ id: "earth", name: "Terra + Marte", massKg: earth.massKg + mars.massKg });
  expect(persistentRemnant.radiusM).toBeCloseTo(remnant.radiusM, 8);
  expect(persistentRemnant.positionM).toEqual(remnant.positionM);
  expect(persistentRemnant.velocityMs).toEqual(remnant.velocityMs);
  expect(await sceneCanvas.boundingBox()).toEqual(sceneBounds);
  expect(textureResponses.filter(({ status }) => status >= 400)).toEqual([]);
  expect(appErrors).toEqual([]);
  const screenshots = await Promise.all([preContactPath, contactPath, postExpiryPath].map(async (path) => {
    const image = await readFile(path);
    return { path, width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }));
  const metrics = {
    browserVersion: page.context().browser()?.version(), viewport: { width: 1440, height: 900 }, sceneBounds,
    bodies: [{ id: earth.id, name: earth.name, bodyType: earth.bodyType, materialMap: "/textures/earth-day*.jpg" }, { id: mars.id, name: mars.name, bodyType: mars.bodyType, materialMap: "/textures/mars.jpg" }],
    textureResponses, contactCaptureDelayMs, vfxExpiryWaitMs: 3400, relativeSpeedMps, relativeEnergyJ,
    remnant: { id: remnant.id, name: remnant.name, massKg: remnant.massKg, radiusM: remnant.radiusM, bodyType: remnant.bodyType }, appErrors, screenshots,
  };
  await writeFile(testInfo.outputPath("collision-run-metrics.json"), JSON.stringify(metrics, null, 2));
  await writeFile(testInfo.outputPath("browser-console.json"), JSON.stringify(appConsole, null, 2));
  await screenshotSession.detach();
});

test("shows the updated Earth orbit context after doubling the Sun's mass", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const moonTexture = page.waitForResponse((response) => /\/textures\/moon-lroc-color-(?:2k|4k)\.jpg$/.test(new URL(response.url()).pathname));
  await page.goto("/");
  expect((await moonTexture).ok()).toBe(true);
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await expect(page.locator(".scene-frame")).toHaveAttribute("data-glb-loaded", "true");
  await page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { name: "Selecionar Terra", exact: true }).click();
  await ensureInspectorOpen(page, "Terra");
  await testInfo.attach("sun-mass-1x-earth-orbit-and-inspector", { body: await page.screenshot(), contentType: "image/png" });
  const initial = await exportWorld(page);
  const initialSunMass = initial.bodies.find((body: { id: string }) => body.id === "sun").massKg;
  await page.getByRole("button", { name: "Fechar editor", exact: true }).click();
  await page.getByRole("list").getByRole("button", { name: "Sol", exact: true }).click();
  await ensureInspectorOpen(page, "Sol");
  await page.getByRole("button", { name: "2 vezes a massa inicial", exact: true }).click();
  const updated = await exportWorld(page);
  expect(updated.bodies.find((body: { id: string }) => body.id === "sun").massKg).toBe(initialSunMass * 2);
  await page.getByRole("button", { name: "Fechar editor", exact: true }).click();
  await page.getByRole("list").getByRole("button", { name: "Terra", exact: true }).click();
  await ensureInspectorOpen(page, "Terra");
  await expect(page.getByRole("heading", { name: "Terra", exact: true })).toBeVisible();
  await expect(page.locator(".scene-frame")).toHaveAttribute("data-glb-loaded", "true");
  await testInfo.attach("sun-mass-doubled-earth-orbit-and-inspector", { body: await page.screenshot(), contentType: "image/png" });
});

test("starts the solar system with an accessible canvas", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const sphereModel = page.waitForResponse((response) => response.url().endsWith("/models/astro-sphere.glb"));
  await page.goto("/");

  await expect(page).toHaveTitle("Astro");
  await expect(page.getByRole("heading", { name: "Seu universo" })).toBeVisible();
  await expect(page.getByRole("list").getByRole("button")).toHaveCount(10);
  await expect(page.locator("canvas.simulation-webgl")).toHaveCount(1);
  await expect(page.getByLabel(/^Universo em 3D\./)).toBeVisible();
  expect((await sphereModel).ok()).toBe(true);
  await expect(page.locator(".scene-frame")).toHaveAttribute("data-glb-loaded", "true");
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible();
  await expect(page.getByLabel("Passagem do tempo")).toHaveValue("86400");
  await expect(page.getByText("Escala real", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ver sistema", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ver sistema", exact: true })).toHaveAttribute("aria-pressed", "true");
  const viewportWidth = page.viewportSize()!.width;
  const solarAnchorX = async () => Number(await page.locator(".scene-markers svg circle").first().getAttribute("cx"));
  await expect.poll(solarAnchorX).toBeGreaterThan(viewportWidth * 0.4);
  await expect.poll(solarAnchorX).toBeLessThan(viewportWidth * 0.6);
  await page.getByRole("list").getByRole("button", { name: "Marte", exact: true }).click();
  await ensureInspectorOpen(page, "Marte");
  await expect(page.getByRole("heading", { name: "Marte", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("edits a body, changes water phase, and round-trips an in-memory file", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await expect(page.locator(".phase")).toHaveText("Água líquida");

  await ensureInspectorOpen(page, "Terra");
  await page.getByText("Digitar valores", { exact: true }).click();
  const mass = page.getByRole("textbox", { name: "Massa (×10²⁴ kg)" });
  await mass.fill("6");
  await mass.press("Tab");
  await expect(mass).toHaveValue("6");
  await page.waitForTimeout(150);
  await expect(mass).toHaveValue("6");

  const temperature = page.getByRole("textbox", { name: "Temperatura (°C)" });
  await temperature.fill("126.85");
  await temperature.press("Tab");
  await expect(page.locator(".phase")).toHaveText("Vapor de água");
  await page.waitForTimeout(150);
  await expect(temperature).toHaveValue("126.85");
  await expect(page.locator(".phase")).toHaveText("Vapor de água");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Exportar" }).click(),
  ]);
  const fileBuffer = await readDownload(download);
  const savedEarth = JSON.parse(fileBuffer.toString()).bodies.find((body: { id: string }) => body.id === "earth");
  expect(savedEarth.massKg).toBe(6e24);
  expect(savedEarth.surfaceTemperatureK).toBe(400);

  await temperature.fill("-23.15");
  await temperature.press("Tab");
  await expect(page.locator(".phase")).toHaveText("Gelo");
  await page.getByLabel("Arquivo de simulação").setInputFiles({
    name: "round-trip.astro",
    mimeType: "application/json",
    buffer: fileBuffer,
  });

  await expect(page.getByRole("status").filter({ hasText: "Simulação importada com sucesso." })).toHaveText("Simulação importada com sucesso.");
  await page.waitForTimeout(150);
  await expect(page.locator(".phase")).toHaveText("Vapor de água");
  await page.getByText("Digitar valores", { exact: true }).click();
  await expect(mass).toHaveValue("6");
});

test("advances real orbital state by default and stops when paused", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible();
  const exportWorld = async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Exportar", exact: true }).click(),
    ]);
    return JSON.parse((await readDownload(download)).toString());
  };
  const before = (await exportWorld()).bodies.find((body: { id: string }) => body.id === "earth");
  await page.waitForTimeout(1000);
  const after = (await exportWorld()).bodies.find((body: { id: string }) => body.id === "earth");
  expect(Math.hypot(...after.positionM.map((value: number, axis: number) => value - before.positionM[axis]))).toBeGreaterThan(1e8);
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retomar", exact: true })).toBeVisible();
  const paused = await exportWorld();
  await page.waitForTimeout(300);
  expect(await exportWorld()).toEqual(paused);
});

test("adds a new planet after importing a system containing planet-1", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Exportar", exact: true }).click(),
  ]);
  const world = JSON.parse((await readDownload(download)).toString());
  const earth = world.bodies.find((body: { id: string }) => body.id === "earth");
  world.bodies.push({ ...earth, id: "planet-1", name: "Planeta importado", positionM: [earth.positionM[0] + 2e10, earth.positionM[1], earth.positionM[2]] });
  await page.getByLabel("Arquivo de simulação").setInputFiles({ name: "planet-1.astro", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(world)) });
  expect((await exportWorld(page)).bodies).toHaveLength(11);
  await page.getByRole("button", { name: "Criar astro", exact: true }).click();
  await page.getByRole("button", { name: "Criar planeta rochoso", exact: true }).click();
  await ensureInspectorOpen(page, "Planeta rochoso 1");
  expect((await exportWorld(page)).bodies).toHaveLength(12);
  await expect(page.getByRole("heading", { name: "Planeta rochoso 1", exact: true })).toBeVisible();
});

test("keeps mobile planet views clear at 320px and 480px, and opens editing on demand", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const moonTexture = page.waitForResponse((response) => /\/textures\/moon-lroc-color-(?:2k|4k)\.jpg$/.test(new URL(response.url()).pathname));
  await page.goto("/");
  expect((await moonTexture).ok()).toBe(true);
  await expect(page.locator(".scene-frame")).toHaveAttribute("data-glb-loaded", "true");
  await testInfo.attach("scene-mobile-320-textures-loaded", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 480, height: 844 });
  await testInfo.attach("scene-mobile-480-textures-loaded", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.locator("#object-inspector")).toBeHidden();
  await page.getByRole("button", { name: "Editar Terra", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Tamanho", exact: true })).toBeVisible();
  const inspectorBounds = await page.locator("#object-inspector").boundingBox();
  const bodyNavigation = page.getByRole("navigation", { name: "Escolha um astro" });
  if (await bodyNavigation.isVisible()) {
    const navigationBounds = await bodyNavigation.boundingBox();
    if (!inspectorBounds || !navigationBounds) throw new Error("Mobile panels have no layout bounds.");
    expect(inspectorBounds.y + inspectorBounds.height).toBeLessThanOrEqual(navigationBounds.y);
  }
  const mobileMass = page.getByRole("slider", { name: "Massa", exact: true });
  const initialEarthMass = (await exportWorld(page)).bodies.find((body: { id: string }) => body.id === "earth").massKg;
  await mobileMass.focus();
  await mobileMass.press("ArrowRight");
  await expect.poll(async () => (await exportWorld(page)).bodies.find((body: { id: string }) => body.id === "earth").massKg).toBeGreaterThan(initialEarthMass);
  const water = page.getByRole("slider", { name: "Água", exact: true });
  await water.scrollIntoViewIfNeeded();
  const bounds = await water.boundingBox();
  if (!bounds) throw new Error("Mobile water slider has no visible bounds.");
  await page.mouse.move(bounds.x + bounds.width * .71, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .4, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(Number(await water.inputValue())).toBeLessThan(.6);
  await page.getByRole("complementary", { name: "Inspeção do sistema" }).getByRole("button", { name: "Fechar editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Editar Terra", exact: true })).toBeFocused();
  await expect(page.locator("#object-inspector")).toBeHidden();
  await expect(page.getByRole("button", { name: "Exportar", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const create = page.getByRole("button", { name: "Criar astro", exact: true });
  await create.click();
  await page.getByRole("dialog", { name: "Crie seu universo" }).press("Escape");
  await expect(create).toBeFocused();
});

test("groups a radius drag into one undo step", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { name: "Selecionar Terra", exact: true }).click();
  await ensureInspectorOpen(page, "Terra");

  const slider = page.getByRole("slider", { name: "Tamanho", exact: true });
  await slider.scrollIntoViewIfNeeded();
  const before = await slider.inputValue();
  const bounds = await slider.boundingBox();
  if (!bounds) throw new Error("Earth radius slider has no visible bounds.");
  const min = Number(await slider.getAttribute("min"));
  const max = Number(await slider.getAttribute("max"));
  const startX = bounds.x + bounds.width * (Number(before) - min) / (max - min);
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.72, y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => slider.inputValue()).not.toBe(before);
  const after = await slider.inputValue();

  await page.getByText("Mais", { exact: true }).last().click();
  await page.getByRole("button", { name: "Desfazer ação", exact: true }).click();
  await expect(slider).toHaveValue(before);
  await page.getByRole("button", { name: "Refazer ação", exact: true }).click();
  await expect(slider).toHaveValue(after);

  await slider.scrollIntoViewIfNeeded();
  const nextBounds = await slider.boundingBox();
  if (!nextBounds) throw new Error("Earth radius slider has no visible bounds after redo.");
  const nextStartX = nextBounds.x + nextBounds.width * (Number(after) - min) / (max - min);
  const nextY = nextBounds.y + nextBounds.height / 2;
  await page.mouse.move(nextStartX, nextY);
  await page.mouse.down();
  await page.mouse.move(nextBounds.x + nextBounds.width * 0.6, nextY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => slider.inputValue()).not.toBe(after);
  const secondDrag = await slider.inputValue();

  await page.getByRole("button", { name: "Desfazer ação", exact: true }).click();
  await expect(slider).toHaveValue(after);
  await page.getByRole("button", { name: "Refazer ação", exact: true }).click();
  await expect(slider).toHaveValue(secondDrag);
});

test("scopes history to experiment, import, and reset generations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { name: "Selecionar Terra", exact: true }).click();
  await ensureInspectorOpen(page, "Terra");
  await ensureHistoryControlsOpen(page);
  const initialCollisionMode = await page.locator(".sandbox-indicator").getAttribute("aria-label");
  const solarSave = await exportEncodedWorld(page);

  await page.locator(".experiment-scenario-panel > summary").click();
  await page.getByRole("button", { name: "Jogar Terra e Marte", exact: true }).click();
  await expect(page.locator(".system-count")).toHaveText("2 astros");
  await expect(page.locator(".sandbox-indicator")).toHaveAttribute("aria-label", "Sandbox criativa ativa");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();

  await ensureHistoryControlsOpen(page);
  const undo = page.getByRole("button", { name: "Desfazer ação", exact: true });
  const redo = page.getByRole("button", { name: "Refazer ação", exact: true });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator(".system-count")).toHaveText("10 astros");
  await expect(page.locator(".sandbox-indicator")).toHaveAttribute("aria-label", initialCollisionMode!);
  await expect(redo).toBeEnabled();

  await page.getByLabel("Arquivo de simulação").setInputFiles({ name: "solar-before-experiment.astro", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(solarSave)) });
  await expect(page.getByRole("status").filter({ hasText: "Arquivo válido; importação enviada ao motor." })).toHaveText("Arquivo válido; importação enviada ao motor.");
  await expect(page.locator(".system-count")).toHaveText("10 astros");
  await expect(page.locator(".sandbox-indicator")).toHaveAttribute("aria-label", initialCollisionMode!);
  await ensureHistoryControlsOpen(page);
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await ensureInspectorOpen(page, "Terra");
  await ensureHistoryControlsOpen(page);
  const slider = page.getByRole("slider", { name: "Tamanho", exact: true });
  const importedSliderValue = await slider.inputValue();
  const importedRadius = savedBodies(await exportEncodedWorld(page)).find((body) => body.id === "earth")!.radiusM;
  await slider.press("ArrowRight");
  await expect(slider).not.toHaveValue(importedSliderValue);
  await expect(undo).toBeEnabled();
  const editedRadius = savedBodies(await exportEncodedWorld(page)).find((body) => body.id === "earth")!.radiusM;
  expect(editedRadius).toBeGreaterThan(importedRadius);
  await undo.click();
  await expect(slider).toHaveValue(importedSliderValue);
  await expect(redo).toBeEnabled();

  await redo.click();
  await expect(slider).not.toHaveValue(importedSliderValue);
  await expect.poll(async () => savedBodies(await exportEncodedWorld(page)).find((body) => body.id === "earth")!.radiusM).toBe(editedRadius);
  await undo.click();
  await expect(slider).toHaveValue(importedSliderValue);
  await slider.press("ArrowRight");
  await expect(slider).not.toHaveValue(importedSliderValue);
  await expect(redo).toBeDisabled();
  await page.getByRole("button", { name: "Reiniciar simulação", exact: true }).click();
  await expect(page.locator(".system-count")).toHaveText("10 astros");
  await ensureHistoryControlsOpen(page);
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
});

test("groups a touch radius drag into one undo step", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3101", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.getByRole("navigation", { name: "Escolha um astro" }).getByRole("button", { name: "Selecionar Terra", exact: true }).click();
    await ensureInspectorOpen(page, "Terra");
    const slider = page.getByRole("slider", { name: "Tamanho", exact: true });
    await slider.scrollIntoViewIfNeeded();
    const before = await slider.inputValue();
    const bounds = await slider.boundingBox();
    if (!bounds) throw new Error("Earth radius slider has no visible bounds for touch input.");
    const min = Number(await slider.getAttribute("min"));
    const max = Number(await slider.getAttribute("max"));
    const startX = bounds.x + bounds.width * (Number(before) - min) / (max - min);
    const y = bounds.y + bounds.height / 2;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y }] });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX + bounds.width * 0.45 * step / 10, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => slider.inputValue()).not.toBe(before);
    const after = await slider.inputValue();

    await ensureHistoryControlsOpen(page);
    const undo = page.getByRole("button", { name: "Desfazer ação", exact: true });
    const redo = page.getByRole("button", { name: "Refazer ação", exact: true });
    await undo.click();
    await expect(slider).toHaveValue(before);
    await redo.click();
    await expect(slider).toHaveValue(after);
    await cdp.detach();
  } finally {
    await context.close();
  }
});

test("explains when WebGL 2 is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (type: string, ...args: unknown[]) {
        if (type === "webgl2") return null;
        return Reflect.apply(original, this, [type, ...args]);
      },
    });
  });
  await page.goto("/");

  await expect(page.getByRole("alert").filter({ hasText: "Visualização indisponível" })).toContainText(
    "WebGL 2 não está disponível neste navegador ou dispositivo.",
  );
  await expect(page.getByRole("heading", { name: "Seu universo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Exportar" })).toBeVisible();
});
