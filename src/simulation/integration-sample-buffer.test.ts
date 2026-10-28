import { describe, expect, it } from "vitest";
import { IntegrationSampleBuffer } from "./integration-sample-buffer";

describe("IntegrationSampleBuffer", () => {
  it("preserves source truncation in the versioned batch", () => {
    const buffer = new IntegrationSampleBuffer();
    buffer.append([{ offsetSeconds: 1, bodies: [{ id: "earth", positionM: [1, 0, 0] }] }], 0, true);

    expect(buffer.toBatch(1)?.truncated).toBe(true);
  });
});
