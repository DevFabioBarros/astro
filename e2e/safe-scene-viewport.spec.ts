import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const screenshotDirectory = join(process.cwd(), "artifacts", `safe-scene-viewport-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
mkdirSync(screenshotDirectory, { recursive: true });

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow-mobile", width: 320, height: 740 },
] as const;

const bodies = [
  { name: "Terra", file: "Earth" },
  { name: "Júpiter", file: "Jupiter" },
  { name: "Saturno", file: "Saturn" },
] as const;

type Bounds = { left: number; top: number; right: number; bottom: number; width: number; height: number };

async function sceneMetrics(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector(".scene-view")!;
    const hostRect = host.getBoundingClientRect();
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || element.getBoundingClientRect().width === 0 || element.getBoundingClientRect().height === 0) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left - hostRect.left, top: value.top - hostRect.top, right: value.right - hostRect.left, bottom: value.bottom - hostRect.top, width: value.width, height: value.height };
    };
    const tools = rect(".scene-tools");
    const rail = rect(".object-rail");
    const navigation = rect(".planet-navigation");
    const transport = rect(".transport");
    const top = Math.max(120, (tools?.bottom ?? 120) + 22);
    const dockBottom = (navigation?.top ?? hostRect.height - 150) - 25;
    const bottom = Math.max(top + 100, rail && hostRect.width <= 600 ? Math.min(dockBottom, rail.top) : dockBottom);
    const right = rail && hostRect.width > 600 ? Math.max(220, rail.left - 30) : hostRect.width - 30;
    return {
      host: { width: hostRect.width, height: hostRect.height },
      safe: { left: 30, top, right, bottom },
      rail,
      navigation,
      transport,
      tools,
    };
  });
}

function overlaps(a: Bounds, b: Bounds) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function verifyTransportEndReachableByTouch(page: Page) {
  const transport = page.locator(".transport");
  const details = transport.locator(".gravity-settings");
  const summary = details.locator(":scope > summary");
  const before = await transport.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

  const box = await transport.boundingBox();
  expect(box).not.toBeNull();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    const x = box!.x + box!.width / 2;
    const startY = box!.y + box!.height - 28;
    const endY = box!.y + 24;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY, id: 1 }] });
    for (let step = 1; step <= 5; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY + (endY - startY) * step / 5, id: 1 }] });
      await page.waitForTimeout(20);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }

  await expect.poll(() => transport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const visible = await page.evaluate(() => {
    const parent = document.querySelector(".transport")!.getBoundingClientRect();
    const control = document.querySelector(".gravity-settings > summary")!.getBoundingClientRect();
    return control.top >= parent.top && control.bottom <= parent.bottom && control.left >= parent.left && control.right <= parent.right;
  });
  expect(visible, "last transport action must scroll fully into view").toBe(true);

  await transport.getByRole("button", { name: "Retomar", exact: true }).focus();
  for (let tab = 0; tab < 20 && !(await summary.evaluate((element) => document.activeElement === element)); tab++) {
    await page.keyboard.press("Tab");
  }
  await expect(summary).toBeFocused();
  await expect.poll(() => transport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const keyboardVisible = await page.evaluate(() => {
    const parent = document.querySelector(".transport")!.getBoundingClientRect();
    const control = document.querySelector(".gravity-settings > summary")!.getBoundingClientRect();
    return control.top >= parent.top && control.bottom <= parent.bottom && control.left >= parent.left && control.right <= parent.right;
  });
  expect(keyboardVisible, "keyboard focus must scroll the last transport action fully into view").toBe(true);
  await summary.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await summary.press("Enter");
  await transport.evaluate((element) => { element.scrollTop = 0; });
}

async function closeInspector(page: Page, isMobile: boolean) {
  const rail = page.locator(".object-rail");
  if (await rail.evaluate((element) => element.classList.contains("is-open"))) {
    await (isMobile
      ? rail.getByRole("button", { name: /Fechar editor/ })
      : page.locator(".desktop-inspector-toggle")).click();
  }
}

for (const viewport of viewports) {
  test(`safe focus and usable inspector at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const consoleEntries: { type: string; text: string }[] = [];
    page.on("console", (message) => consoleEntries.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", (error) => consoleEntries.push({ type: "pageerror", text: error.message }));

    await page.goto("/");
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Escolha um astro" });
    const isMobile = viewport.width <= 760;

    for (const body of bodies) {
      await closeInspector(page, isMobile);
      await expect(navigation).toBeVisible();
      const bodyButton = navigation.getByRole("button", { name: body.name, exact: true });
      await bodyButton.click();
      await expect(bodyButton).toHaveAttribute("aria-pressed", "true");
      const metricsBeforeFocus = await sceneMetrics(page);
      expect(metricsBeforeFocus.safe.right).toBeGreaterThan(metricsBeforeFocus.safe.left);
      expect(metricsBeforeFocus.safe.bottom).toBeGreaterThan(metricsBeforeFocus.safe.top);
      expect(metricsBeforeFocus.safe.top).toBeGreaterThanOrEqual(metricsBeforeFocus.tools!.bottom + 22);
      expect(metricsBeforeFocus.navigation).not.toBeNull();
      expect(metricsBeforeFocus.transport).not.toBeNull();
      expect(overlaps(metricsBeforeFocus.navigation!, metricsBeforeFocus.transport!)).toBe(false);
      expect(metricsBeforeFocus.navigation!.bottom).toBeLessThanOrEqual(metricsBeforeFocus.transport!.top);

      const focusButton = page.locator(".scene-tools").getByRole("button", { name: /Focar astro/ });
      await focusButton.click();
      await expect(focusButton).toHaveAttribute("aria-pressed", "true");

      if (isMobile) await page.locator(".mobile-inspector-toggle").click();
      else await page.locator(".desktop-inspector-toggle").click();

      const rail = page.locator(".object-rail");
      await expect(rail).toBeVisible();
      await expect(rail).toHaveClass(/is-open/);
      await expect(navigation).toBeHidden();
      const metrics = await sceneMetrics(page);
      expect(metrics.rail).not.toBeNull();
      expect(metrics.tools).not.toBeNull();
      expect(metrics.transport).not.toBeNull();
      expect(metrics.safe.right).toBeGreaterThan(metrics.safe.left);
      expect(metrics.safe.bottom).toBeGreaterThan(metrics.safe.top);
      expect(metrics.safe.top).toBeGreaterThanOrEqual(metrics.tools!.bottom + 22);
      expect(overlaps(metrics.rail!, metrics.tools!)).toBe(false);
      expect(overlaps(metrics.rail!, metrics.transport!)).toBe(false);
      expect(metrics.rail!.bottom).toBeLessThanOrEqual(metrics.transport!.top);
      if (isMobile) {
        expect(metrics.safe.bottom).toBeLessThanOrEqual(metrics.rail!.top);
        const availableGap = metrics.transport!.top - (metrics.tools!.bottom + 22);
        expect(metrics.rail!.top).toBeGreaterThanOrEqual(metrics.tools!.bottom + 22);
        expect(metrics.transport!.top - metrics.rail!.bottom).toBeLessThanOrEqual(4);
        expect(metrics.rail!.height / availableGap).toBeGreaterThanOrEqual(0.42);
        expect(metrics.rail!.height / availableGap).toBeLessThanOrEqual(0.58);
        expect(await rail.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
        expect(await rail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        const slider = rail.locator('input[type="range"]').first();
        await slider.scrollIntoViewIfNeeded();
        await expect(slider).toBeVisible();
        await slider.focus();
        await expect(slider).toBeFocused();
        await rail.evaluate((element) => { element.scrollTop = 0; });
        await verifyTransportEndReachableByTouch(page);
      } else {
        expect(metrics.safe.right).toBeLessThanOrEqual(metrics.rail!.left - 30);
        await expect(rail.locator("input[type=range]").first()).toBeVisible();
        await rail.locator("input[type=range]").first().focus();
        await expect(rail.locator("input[type=range]").first()).toBeFocused();
      }

      const screenshotName = `${viewport.name}-${body.file.toLowerCase()}.png`;
      await page.screenshot({ path: join(screenshotDirectory, screenshotName), fullPage: true });
      console.log(`${viewport.width}x${viewport.height} ${body.name} scene=${metrics.host.width}x${metrics.host.height} safe=${JSON.stringify(metrics.safe)} panel=${JSON.stringify(metrics.rail)} nav=${JSON.stringify(metrics.navigation)} transport=${JSON.stringify(metrics.transport)} screenshot=${screenshotName}`);
    }

    const consolePath = join(screenshotDirectory, `${viewport.name}-app-console.json`);
    writeFileSync(consolePath, JSON.stringify(consoleEntries, null, 2));
    await testInfo.attach(`${viewport.name}-app-console`, { path: consolePath, contentType: "application/json" });
    expect(consoleEntries.filter(({ type }) => type === "error" || type === "pageerror")).toEqual([]);
  });
}
