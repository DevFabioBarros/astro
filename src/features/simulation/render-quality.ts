export type RenderQualityConfig = {
  width: number;
  height: number;
  devicePixelRatio: number;
  maxTextureSize: number;
};

export type RenderQualityMetrics = {
  p50FrameIntervalMs: number;
  p95FrameIntervalMs: number;
  sampleCount: number;
};

const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_RENDERED_PIXELS = 3_000_000;
const MIN_PIXEL_RATIO = 0.65;
const FRAME_WINDOW_SIZE = 60;
const SLOW_FRAME_P95_MS = 28;
const FAST_FRAME_P95_MS = 20;
const QUALITY_STEP = 0.85;

type NormalizedConfig = RenderQualityConfig;

const positiveFinite = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

const normalizeConfig = (config: RenderQualityConfig): NormalizedConfig => ({
  width: positiveFinite(config.width, 1),
  height: positiveFinite(config.height, 1),
  devicePixelRatio: positiveFinite(config.devicePixelRatio, 1),
  maxTextureSize: Number.isFinite(config.maxTextureSize) && config.maxTextureSize >= 0
    ? config.maxTextureSize
    : 0,
});

const basePixelRatio = ({ width, height, devicePixelRatio, maxTextureSize }: NormalizedConfig): number => {
  const textureLimit = maxTextureSize < 2048 ? 1 : maxTextureSize < 4096 ? 1.25 : Infinity;
  const pixelLimit = Math.sqrt(MAX_RENDERED_PIXELS / (width * height));

  // shortcut: the 0.65 floor exceeds the pixel budget above ~7.1M CSS pixels; revisit if larger canvases need a strict cap.
  return Math.max(MIN_PIXEL_RATIO, Math.min(MAX_DEVICE_PIXEL_RATIO, devicePixelRatio, textureLimit, pixelLimit));
};

const percentile = (sortedSamples: readonly number[], fraction: number): number =>
  sortedSamples[Math.ceil(sortedSamples.length * fraction) - 1] ?? 0;

const sameConfig = (left: NormalizedConfig, right: NormalizedConfig): boolean =>
  left.width === right.width &&
  left.height === right.height &&
  left.devicePixelRatio === right.devicePixelRatio &&
  left.maxTextureSize === right.maxTextureSize;

export class RenderQualityController {
  #config: NormalizedConfig;
  #basePixelRatio: number;
  #pixelRatio: number;
  #samples: number[] = [];
  #framesInWindow = 0;
  #slowWindows = 0;
  #fastWindows = 0;
  #metrics: RenderQualityMetrics = { p50FrameIntervalMs: 0, p95FrameIntervalMs: 0, sampleCount: 0 };

  constructor(config: RenderQualityConfig) {
    this.#config = normalizeConfig(config);
    this.#basePixelRatio = basePixelRatio(this.#config);
    this.#pixelRatio = this.#basePixelRatio;
  }

  get pixelRatio(): number {
    return this.#pixelRatio;
  }

  get metrics(): RenderQualityMetrics {
    return { ...this.#metrics };
  }

  resize(config: RenderQualityConfig): boolean {
    const nextConfig = normalizeConfig(config);
    if (sameConfig(this.#config, nextConfig)) return false;

    const previousRatio = this.#pixelRatio;
    const previousBasePixelRatio = this.#basePixelRatio;
    this.#config = nextConfig;
    this.#basePixelRatio = basePixelRatio(nextConfig);
    this.#pixelRatio = this.#basePixelRatio > previousBasePixelRatio
      ? this.#basePixelRatio
      : Math.min(this.#pixelRatio, this.#basePixelRatio);
    this.#samples = [];
    this.#framesInWindow = 0;
    this.#slowWindows = 0;
    this.#fastWindows = 0;
    this.#metrics = { p50FrameIntervalMs: 0, p95FrameIntervalMs: 0, sampleCount: 0 };

    return this.#pixelRatio !== previousRatio;
  }

  sampleFrame(intervalMs: number): boolean {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;

    const previousRatio = this.#pixelRatio;
    this.#samples.push(intervalMs);
    if (this.#samples.length > FRAME_WINDOW_SIZE) this.#samples.shift();

    const sortedSamples = [...this.#samples].sort((left, right) => left - right);
    this.#metrics = {
      p50FrameIntervalMs: percentile(sortedSamples, 0.5),
      p95FrameIntervalMs: percentile(sortedSamples, 0.95),
      sampleCount: sortedSamples.length,
    };

    this.#framesInWindow += 1;
    if (this.#framesInWindow === FRAME_WINDOW_SIZE) {
      this.#framesInWindow = 0;
      this.#applyWindowQuality(this.#metrics.p95FrameIntervalMs);
    }

    return this.#pixelRatio !== previousRatio;
  }

  #applyWindowQuality(p95FrameIntervalMs: number): void {
    if (p95FrameIntervalMs > SLOW_FRAME_P95_MS) {
      this.#slowWindows += 1;
      this.#fastWindows = 0;
      if (this.#slowWindows === 2) {
        this.#pixelRatio = Math.max(MIN_PIXEL_RATIO, this.#pixelRatio * QUALITY_STEP);
        this.#slowWindows = 0;
      }
      return;
    }

    if (p95FrameIntervalMs < FAST_FRAME_P95_MS) {
      this.#fastWindows += 1;
      this.#slowWindows = 0;
      if (this.#fastWindows === 4) {
        this.#pixelRatio = Math.min(this.#basePixelRatio, this.#pixelRatio / QUALITY_STEP);
        this.#fastWindows = 0;
      }
      return;
    }

    this.#slowWindows = 0;
    this.#fastWindows = 0;
  }
}
