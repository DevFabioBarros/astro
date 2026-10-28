import { describe, expect, it } from "vitest";
import { RenderQualityController, type RenderQualityConfig } from "./render-quality";

const config = (overrides: Partial<RenderQualityConfig> = {}): RenderQualityConfig => ({
  width: 1000,
  height: 1000,
  devicePixelRatio: 2,
  maxTextureSize: 8192,
  ...overrides,
});

const sampleFrames = (controller: RenderQualityController, intervalMs: number, count: number): boolean => {
  let changed = false;
  for (let frame = 0; frame < count; frame += 1) changed = controller.sampleFrame(intervalMs) || changed;
  return changed;
};

describe("RenderQualityController", () => {
  it("caps DPR by the pixel budget and GPU texture capability", () => {
    expect(new RenderQualityController(config({ devicePixelRatio: 3 })).pixelRatio).toBeCloseTo(Math.sqrt(3));
    expect(new RenderQualityController(config({ maxTextureSize: 1024 })).pixelRatio).toBe(1);
    expect(new RenderQualityController(config({ maxTextureSize: 2048 })).pixelRatio).toBe(1.25);
    expect(new RenderQualityController(config({ width: 3000, height: 1000 })).pixelRatio).toBe(1);
  });

  it("reports nearest-rank percentiles over the latest 60 valid frame intervals", () => {
    const controller = new RenderQualityController(config());
    for (let interval = 1; interval <= 60; interval += 1) controller.sampleFrame(interval);

    expect(controller.metrics).toEqual({ p50FrameIntervalMs: 30, p95FrameIntervalMs: 57, sampleCount: 60 });

    controller.sampleFrame(61);
    expect(controller.metrics).toEqual({ p50FrameIntervalMs: 31, p95FrameIntervalMs: 58, sampleCount: 60 });
  });

  it("lowers pixel ratio by 15% after two consecutive slow windows", () => {
    const controller = new RenderQualityController(config());

    expect(sampleFrames(controller, 29, 60)).toBe(false);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3));
    expect(sampleFrames(controller, 29, 59)).toBe(false);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3));
    expect(controller.sampleFrame(29)).toBe(true);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3) * 0.85);
  });

  it("resets consecutive slow windows when frame cadence enters the middle band", () => {
    const controller = new RenderQualityController(config());
    sampleFrames(controller, 30, 60);
    sampleFrames(controller, 24, 60);
    sampleFrames(controller, 30, 60);

    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3));
    expect(sampleFrames(controller, 30, 60)).toBe(true);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3) * 0.85);
  });

  it("recovers by the inverse factor after four consecutive fast windows, capped at base", () => {
    const controller = new RenderQualityController(config());
    sampleFrames(controller, 30, 120);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3) * 0.85);

    expect(sampleFrames(controller, 19, 180)).toBe(false);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3) * 0.85);
    expect(sampleFrames(controller, 19, 60)).toBe(true);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3));
  });

  it("never degrades below the minimum pixel ratio", () => {
    const controller = new RenderQualityController(config({ devicePixelRatio: 1, maxTextureSize: 1024 }));

    expect(sampleFrames(controller, 30, 600)).toBe(true);
    expect(controller.pixelRatio).toBe(0.65);
    expect(sampleFrames(controller, 30, 120)).toBe(false);
    expect(controller.pixelRatio).toBe(0.65);
  });

  it("ignores non-positive and non-finite frame intervals", () => {
    const controller = new RenderQualityController(config());

    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(controller.sampleFrame(interval)).toBe(false);
    }
    expect(controller.metrics).toEqual({ p50FrameIntervalMs: 0, p95FrameIntervalMs: 0, sampleCount: 0 });
  });

  it("restores the new pixel budget after resizing back to a larger viewport", () => {
    const controller = new RenderQualityController(config());

    expect(controller.resize(config({ width: 2000, height: 1000 }))).toBe(true);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(1.5));
    expect(controller.metrics.sampleCount).toBe(0);
    expect(controller.resize(config({ width: 2000, height: 1000 }))).toBe(false);

    expect(controller.resize(config())).toBe(true);
    expect(controller.pixelRatio).toBeCloseTo(Math.sqrt(3));
    expect(controller.metrics.sampleCount).toBe(0);
  });
});
