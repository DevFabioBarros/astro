import { expect, it } from "vitest";
import { nextAvailablePlanetNumber } from "./next-planet";

it("skips imported planet IDs and preserves the session sequence", () => {
  const imported = [{ id: "sun" }, { id: "planet-1" }, { id: "planet-2" }, { id: "planet-4" }];
  const first = nextAvailablePlanetNumber(imported, 1);
  expect(first).toBe(3);
  expect(nextAvailablePlanetNumber([...imported, { id: `planet-${first}` }], first + 1)).toBe(5);
  expect(nextAvailablePlanetNumber([{ id: "planet-1" }], 7)).toBe(7);
});
