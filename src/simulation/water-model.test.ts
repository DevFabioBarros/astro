import { describe, expect, it } from "vitest";
import { createSolarSystem } from "./solar-system";
import { adoptWaterInventory, getWaterInventoryMetrics, setWaterInventory, updateWaterInventoryTemperature, validateWaterInventory } from "./water-model";

const earth = createSolarSystem().find(({ id }) => id === "earth")!;
const referenceCapacityKg = 4 * Math.PI * earth.radiusM ** 2 * 2_700 * 1_000;

describe("versioned water inventory", () => {
  it("turns legacy coverage into an explicit added water layer without guessing bulk composition", () => {
    const adopted = adoptWaterInventory(earth);
    const metrics = getWaterInventoryMetrics(adopted);

    expect(adopted.massKg).toBeCloseTo(earth.massKg + referenceCapacityKg * earth.waterFraction, -8);
    expect(adopted.radiusM).toBeGreaterThan(earth.radiusM);
    expect(metrics.retainedWaterKg).toBeCloseTo(referenceCapacityKg * earth.waterFraction, -8);
    expect(metrics.surfaceCoverageFraction).toBeCloseTo(earth.waterFraction, 12);
    expect(adopted.waterInventory?.dryMassKg).toBe(earth.massKg);
  });

  it("moves water between phases without changing retained mass, and cooling never restores escaped water", () => {
    const adopted = adoptWaterInventory(earth);
    const heated = updateWaterInventoryTemperature(adopted, 700);
    const metricsAtHeat = getWaterInventoryMetrics(heated);
    const repeated = updateWaterInventoryTemperature(heated, 700);
    const cooled = updateWaterInventoryTemperature(heated, 260);
    const metricsAfterCooling = getWaterInventoryMetrics(cooled);

    expect(heated.waterInventory!.vaporKg).toBeGreaterThan(0);
    expect(metricsAtHeat.phase).toBe("vapor");
    expect(metricsAtHeat.surfaceCoverageFraction).toBe(0);
    expect(heated.waterInventory!.liquidKg + heated.waterInventory!.iceKg + heated.waterInventory!.vaporKg)
      .toBeCloseTo(metricsAtHeat.retainedWaterKg!, 6);
    expect(repeated.waterInventory).toEqual(heated.waterInventory);
    expect(cooled.waterInventory!.iceKg).toBeCloseTo(metricsAtHeat.retainedWaterKg!, 6);
    expect(metricsAfterCooling.retainedWaterKg).toBe(metricsAtHeat.retainedWaterKg);
    expect(metricsAfterCooling.escapedWaterKg).toBe(metricsAtHeat.escapedWaterKg);
  });

  it("records manual removal as escaped mass and allows explicit later addition", () => {
    const adopted = adoptWaterInventory(earth);
    const removed = setWaterInventory(adopted, referenceCapacityKg * 0.1);
    const added = setWaterInventory(removed, referenceCapacityKg * 0.3);

    expect(removed.waterInventory!.escapedKg).toBeCloseTo(referenceCapacityKg * (earth.waterFraction - 0.1), -8);
    expect(removed.massKg).toBeCloseTo(earth.massKg + referenceCapacityKg * 0.1, -8);
    expect(added.waterInventory!.escapedKg).toBe(removed.waterInventory!.escapedKg);
    expect(added.massKg).toBeCloseTo(earth.massKg + referenceCapacityKg * 0.3, -8);
    expect(getWaterInventoryMetrics(added).availableFraction).toBeCloseTo(0.3, 12);
  });

  it("rejects a persisted ledger above its temperature-dependent retention ceiling", () => {
    const adopted = adoptWaterInventory(earth);
    const retainedWaterKg = getWaterInventoryMetrics(adopted).retainedWaterKg!;
    const impossible = {
      ...adopted,
      surfaceTemperatureK: 1_000,
      waterFraction: 0,
      waterInventory: { ...adopted.waterInventory!, liquidKg: 0, iceKg: 0, vaporKg: retainedWaterKg },
    };

    expect(() => validateWaterInventory(impossible)).toThrow(/retenção térmica/);
  });
});
