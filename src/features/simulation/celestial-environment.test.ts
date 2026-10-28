import { describe, expect, it } from "vitest";
import { createStarfieldData, STARFIELD_ALGORITHM_ID } from "./celestial-environment";

describe("seeded starfield v1", () => {
  it("names the versioned generator", () => expect(STARFIELD_ALGORITHM_ID).toBe("seeded-starfield-v1"));
  it("reproduces the same position and color arrays for a seed", () => {
    expect(createStarfieldData(1234)).toEqual(createStarfieldData(1234));
  });

  it("changes the star arrays for another seed", () => {
    expect(createStarfieldData(1234).positions).not.toEqual(createStarfieldData(5678).positions);
    expect(createStarfieldData(1234).colors).not.toEqual(createStarfieldData(5678).colors);
  });

  it("rejects seeds outside uint32", () => {
    expect(() => createStarfieldData(-1)).toThrow();
    expect(() => createStarfieldData(0x1_0000_0000)).toThrow();
  });
});
