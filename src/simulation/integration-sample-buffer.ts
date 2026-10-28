import { estimateIntegrationSampleBatchBytes, estimateIntegrationSampleBytes, MAX_INTEGRATION_SAMPLE_BATCH_BYTES, MAX_INTEGRATION_SAMPLES_PER_BATCH, type IntegrationSampleBatchV1 } from "./types";
import type { IntegrationSubstepSample } from "./simulation-time";

type PendingIntegrationSample = IntegrationSampleBatchV1["samples"][number] & { timeSeconds: number };

export class IntegrationSampleBuffer {
  private samples: PendingIntegrationSample[] = [];
  private startTimeSeconds = 0;
  private truncated = false;
  private estimatedBytes = 32;

  get hasSamples(): boolean {
    return this.samples.length > 0;
  }

  clear(startTimeSeconds = 0): void {
    this.samples = [];
    this.startTimeSeconds = startTimeSeconds;
    this.truncated = false;
    this.estimatedBytes = 32;
  }

  append(samples: readonly IntegrationSubstepSample[], startTimeSeconds: number, sourceTruncated = false): void {
    this.truncated ||= sourceTruncated;
    if (!samples.length) return;
    if (!this.samples.length) this.startTimeSeconds = startTimeSeconds;
    for (const sample of samples) {
      const entry = { ...sample, timeSeconds: startTimeSeconds + sample.offsetSeconds };
      const previous = this.samples.at(-1);
      if (previous && entry.timeSeconds < previous.timeSeconds) continue;
      if (previous && entry.timeSeconds === previous.timeSeconds) {
        this.estimatedBytes -= estimateIntegrationSampleBytes(previous);
        this.samples[this.samples.length - 1] = entry;
      } else this.samples.push(entry);
      this.estimatedBytes += estimateIntegrationSampleBytes(entry);
      while (this.samples.length > MAX_INTEGRATION_SAMPLES_PER_BATCH || this.estimatedBytes > MAX_INTEGRATION_SAMPLE_BATCH_BYTES) {
        if (this.samples.length <= 2) {
          const last = this.samples.at(-1);
          this.samples.splice(0, this.samples.length, ...(last && estimateIntegrationSampleBatchBytes([last]) <= MAX_INTEGRATION_SAMPLE_BATCH_BYTES ? [last] : []));
        } else {
          const count = this.samples.length;
          this.samples = this.samples.filter((_, index) => index === 0 || index === count - 1 || index % 2 === 0);
        }
        this.estimatedBytes = estimateIntegrationSampleBatchBytes(this.samples);
        this.truncated = true;
      }
    }
  }

  toBatch(endTimeSeconds: number): IntegrationSampleBatchV1 | undefined {
    if (!this.samples.length) return undefined;
    return {
      version: 1,
      startTimeSeconds: this.startTimeSeconds,
      endTimeSeconds,
      samples: this.samples.map(({ timeSeconds, ...sample }) => ({ ...sample, offsetSeconds: timeSeconds - this.startTimeSeconds })),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }
}
