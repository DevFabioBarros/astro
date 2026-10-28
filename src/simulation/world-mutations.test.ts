import { describe, expect, it } from "vitest";
import {
  createExplosionCandidate,
  DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG,
  getExplosionEnergyPreview,
  MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG,
  applyWorldMutation,
  validateWorldMutation,
} from "./world-mutations";
import { MAX_MASS_KG, MAX_POSITION_COMPONENT_M, MAX_VELOCITY_MS } from "./physics";
import { advanceSimulationInterval } from "./simulation-time";
import { NEWTONIAN_G } from "./physical-constants";
import { mergeCollision } from "./collisions";
import { createSolarSystem } from "./solar-system";
import { supportsThermalProfile } from "./thermal-model";
import { adoptWaterInventory, getWaterInventoryCapacityKg } from "./water-model";
import type { CelestialBody } from "./types";
import type { SpinState } from "./spin-model";
import { spinPhaseAtAcceptedTimeRad } from "./spin-model";
import { createSwarmLedger, validateSwarmLedger } from "./swarm-model";

const settings = { gravitationalConstant: 0 };
const atmosphereSettings = { gravitationalConstant: 6.6743e-11 };
const spinState: SpinState = { modelId: "rigid-body-spin-v1", axisUnitWorld: [0, 0, 1], phaseAtEpochRad: 0, angularVelocityRadPerS: 0.001 };
const body: CelestialBody = {
  id: "planet", name: "Planet", kind: "planet", bodyType: "rocky-planet",
  massKg: 6e24, radiusM: 6e6, positionM: [1e9, -2e9, 3e9], velocityMs: [120, -30, 4],
  surfaceTemperatureK: 288, waterFraction: 0.2,
};

function momentum(bodies: readonly CelestialBody[]) {
  return bodies.reduce((sum, body) => sum.map((value, axis) => value + body.massKg * body.velocityMs[axis]!), [0, 0, 0]);
}

function centerVelocity(bodies: readonly CelestialBody[]) {
  const totalMass = bodies.reduce((sum, candidate) => sum + candidate.massKg, 0);
  return [0, 1, 2].map((axis) => momentum(bodies)[axis]! / totalMass);
}

function relativeKineticEnergy(bodies: readonly CelestialBody[]) {
  const velocity = centerVelocity(bodies);
  return bodies.reduce((sum, candidate) => sum + 0.5 * candidate.massKg
    * candidate.velocityMs.reduce((speedSquared, component, axis) => speedSquared + (component - velocity[axis]!) ** 2, 0), 0);
}

function expectRelativeClose(actual: number, expected: number, tolerance = 1e-12) {
  expect(Math.abs(actual / expected - 1)).toBeLessThan(tolerance);
}

describe("experimental explosion candidate", () => {
  it("scales unique legacy and materialized bodies atomically", () => {
    const materialized = applyWorldMutation([body], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const legacy = { ...body, id: "legacy", massKg: 1e12, radiusM: 1e5, positionM: [0, 2e9, 0] as const };
    const result = applyWorldMutation([materialized, legacy], settings, {
      type: "BATCH_SCALE_BODIES", bodyIds: [body.id, legacy.id], field: "massKg", factor: 2,
    });

    expect(result.bodies[0]!.massKg).toBe(materialized.massKg * 2);
    expect(result.bodies[0]!.materials!.rockKg / result.bodies[0]!.massKg).toBeCloseTo(0.6, 12);
    expect(result.bodies[1]!.massKg).toBe(legacy.massKg * 2);
    expect(body.massKg).toBe(6e24);
  });

  it("rejects an invalid batch without changing any source body", () => {
    const first = { ...body, id: "first", massKg: 1e12, radiusM: 1e5 };
    const last = { ...body, id: "last", massKg: MAX_MASS_KG, radiusM: 1e5 };
    expect(() => applyWorldMutation([first, last], settings, {
      type: "BATCH_SCALE_BODIES", bodyIds: [first.id, last.id], field: "massKg", factor: 2,
    })).toThrow();
    expect([first.massKg, last.massKg]).toEqual([1e12, MAX_MASS_KG]);
  });

  it("strictly limits batch scale shape, fields, factors, and target count", () => {
    const mutation = { type: "BATCH_SCALE_BODIES", bodyIds: ["a", "b"], field: "radiusM", factor: 0.5 };
    expect(() => validateWorldMutation(mutation)).not.toThrow();
    expect(() => validateWorldMutation({ ...mutation, bodyIds: ["a", "a"] })).toThrow();
    expect(() => validateWorldMutation({ ...mutation, field: "velocityMs.0" })).toThrow();
    expect(() => validateWorldMutation({ ...mutation, factor: 3 })).toThrow();
    expect(() => validateWorldMutation({ ...mutation, nested: { type: "REMOVE_BODY", bodyId: "a" } })).toThrow();
    expect(() => validateWorldMutation({ ...mutation, bodyIds: Array.from({ length: 17 }, (_, index) => `body-${index}`) })).toThrow();
  });

  it("accepts a discrete laser action on an explicitly materialized body without changing its temperature", () => {
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const materialized = applyWorldMutation([earth], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: earth.id,
      editMode: "mass-authoritative", dryFractions: { rock: 1, iron: 0, gas: 0 } }).bodies[0]!;
    const result = applyWorldMutation([materialized], settings, { type: "APPLY_LASER", bodyId: earth.id,
      bodyLocalDirection: [0, 1, 0], powerW: 2e8, durationAcceptedSeconds: 10,
      profileId: "grey-albedo-laser-absorption-v1" }, 123);

    expect(result.bodies).toEqual([materialized]);
    expect(result.bodies[0]!.surfaceTemperatureK).toBe(materialized.surfaceTemperatureK);
    expect(result.event).toMatchObject({ type: "laser",
      bodyIds: [earth.id], energyJ: 2e9,
      laser: { modelId: "laser-energy-ledger-v1", profileId: "grey-albedo-laser-absorption-v1",
        bodyLocalDirection: [0, 1, 0], powerW: 2e8, durationAcceptedSeconds: 10,
        albedo: 0.3, inputJ: 2e9, absorbedJ: 1.4e9, reflectedJ: 0.6e9 },
    });
    expect(result.event!.energyJ).toBe(result.event!.laser!.absorbedJ + result.event!.laser!.reflectedJ);
  });

  it("rejects legacy laser targets and invalid local directions atomically", () => {
    const earth = createSolarSystem().find(({ id }) => id === "earth")!;
    const mutation = { type: "APPLY_LASER" as const, bodyId: earth.id, bodyLocalDirection: [0, 0, 1] as const,
      powerW: 100, durationAcceptedSeconds: 1, profileId: "grey-albedo-laser-absorption-v1" as const };
    expect(() => applyWorldMutation([earth], settings, mutation)).toThrow(/composição material explícita/);
    expect(() => validateWorldMutation({ ...mutation, bodyLocalDirection: [0, 0, 2] })).toThrow();
    expect(() => validateWorldMutation({ ...mutation, powerW: Infinity })).toThrow();
  });

  it("applies a center-of-mass delta-v atomically and reports signed external work", () => {
    const result = applyWorldMutation([body], settings, { type: "APPLY_IMPULSE", bodyId: body.id, impulseNs: [body.massKg, body.massKg * 2, 0] });

    expect(result.bodies[0]!.velocityMs).toEqual([121, -28, 4]);
    expect(result.event).toMatchObject({
      type: "impulse", positionM: body.positionM, radiusM: body.radiusM, bodyIds: [body.id],
      impulse: { modelId: "center-of-mass-impulse-v1", deltaVelocityMs: [1, 2, 0],
        impulseNs: [body.massKg, body.massKg * 2, 0], externalWorkJ: body.massKg * 62.5 },
    });
    expect(result.event!.energyJ).toBe(Math.abs(result.event!.impulse!.externalWorkJ));
    expect(body.velocityMs).toEqual([120, -30, 4]);
  });

  it("keeps braking work signed and rejects any candidate outside the velocity invariant", () => {
    const braking = applyWorldMutation([body], settings, { type: "APPLY_IMPULSE", bodyId: body.id, impulseNs: [-200 * body.massKg, 0, 0] });
    expect(braking.event!.impulse!.externalWorkJ).toBeLessThan(0);
    expect(() => applyWorldMutation([body], settings, { type: "APPLY_IMPULSE", bodyId: body.id, impulseNs: [MAX_VELOCITY_MS * body.massKg, 0, 0] })).toThrow();
    expect(() => applyWorldMutation([body], settings, { type: "APPLY_IMPULSE", bodyId: "missing", impulseNs: [1, 0, 0] })).toThrow();
  });

  it("strictly validates impulse mutation payloads", () => {
    expect(() => validateWorldMutation({ type: "APPLY_IMPULSE", bodyId: body.id, impulseNs: [0, 0, 0] })).toThrow();
    expect(() => validateWorldMutation({ type: "APPLY_IMPULSE", bodyId: body.id, impulseNs: [1, 0, 0], extra: true })).toThrow();
    expect(() => validateWorldMutation({ type: "APPLY_IMPULSE", bodyId: body.id, impulseNs: [Infinity, 0, 0] })).toThrow();
  });

  it("refuses manual fragmentation for explicit spin until angular momentum has a ledger", () => {
    const spinning = { ...body, spin: { modelId: "rigid-body-spin-v1" as const, axisUnitWorld: [0, 1, 0] as const,
      phaseAtEpochRad: 0, angularVelocityRadPerS: 0 } };
    expect(() => createExplosionCandidate([spinning], settings, body.id, 1e6))
      .toThrow(/rotação física explícita.*ledger de momento angular/);
  });

  it("accepts an explicit, strict physical spin mutation", () => {
    const stoppedSpin = { ...spinState, angularVelocityRadPerS: 0 };
    expect(() => validateWorldMutation({ type: "SET_BODY_SPIN", bodyId: body.id, spin: stoppedSpin })).not.toThrow();
    expect(() => validateWorldMutation({ type: "SET_BODY_SPIN", bodyId: body.id, spin: spinState, extra: true })).toThrow();
    const applied = applyWorldMutation([body], settings, { type: "SET_BODY_SPIN", bodyId: body.id, spin: stoppedSpin });
    expect(applied.bodies[0]?.spin).toEqual(stoppedSpin);
    const removed = applyWorldMutation(applied.bodies, settings, { type: "SET_BODY_SPIN", bodyId: body.id, spin: null });
    expect(removed.bodies[0]?.spin).toBeUndefined();
    expect(body.spin).toBeUndefined();
  });

  it("rebases a spin edit to the accepted commit time without an orientation jump", () => {
    const gravitational = { gravitationalConstant: NEWTONIAN_G };
    const currentSpin: SpinState = { ...spinState, phaseAtEpochRad: 0.4, angularVelocityRadPerS: 0.0002 };
    const atCommitSeconds = 1234;
    const replacement: SpinState = { ...currentSpin, phaseAtEpochRad: 0, angularVelocityRadPerS: 0.0001 };
    const spinning = { ...body, spin: currentSpin };
    const result = applyWorldMutation([spinning], gravitational, { type: "SET_BODY_SPIN", bodyId: body.id, spin: replacement }, atCommitSeconds);
    const acceptedSpin = result.bodies[0]!.spin!;
    expect(spinPhaseAtAcceptedTimeRad(acceptedSpin, atCommitSeconds)).toBeCloseTo(spinPhaseAtAcceptedTimeRad(currentSpin, atCommitSeconds));

    const adoption = applyWorldMutation([body], gravitational, { type: "SET_BODY_SPIN", bodyId: body.id, spin: replacement }, atCommitSeconds).bodies[0]!.spin!;
    expect(spinPhaseAtAcceptedTimeRad(adoption, atCommitSeconds)).toBeCloseTo(0);
  });

  it("scales every dry material component by each fragment mass fraction", () => {
    const materialBody = applyWorldMutation([body], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const materialComposition = materialBody.materials!;
    const fragments = createExplosionCandidate([materialBody], settings, body.id, 1e6).bodies;

    expect(fragments).toHaveLength(6);
    for (const fragment of fragments) {
      const fraction = fragment.massKg / materialBody.massKg;
      expect(fragment.materials!.rockKg).toBeCloseTo(materialComposition.rockKg * fraction, 8);
      expect(fragment.materials!.ironKg).toBeCloseTo(materialComposition.ironKg * fraction, 8);
      expect(fragment.materials!.gasKg).toBeCloseTo(materialComposition.gasKg * fraction, 8);
    }
  });

  it("validates and applies the atomic material composition mutation", () => {
    const result = applyWorldMutation([body], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } });

    expect(result.bodies[0]!.materials!.modelId).toBe("material-composition-v1");
    expect(Math.abs(result.bodies[0]!.materials!.rockKg / (body.massKg * 0.6) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.bodies[0]!.materials!.ironKg / (body.massKg * 0.3) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.bodies[0]!.materials!.gasKg / (body.massKg * 0.1) - 1)).toBeLessThan(1e-12);
  });

  it("scales atmosphere with materials across manual fragments", () => {
    const wet = applyWorldMutation([body], settings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id }).bodies[0]!;
    const materialized = applyWorldMutation([wet], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const atmosphere = { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1",
      dryGasMassKg: 1e16, isothermalTemperatureK: 288 } as const;
    const atmospheric = applyWorldMutation([materialized], atmosphereSettings, { type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere }).bodies[0]!;
    const fragments = createExplosionCandidate([atmospheric], atmosphereSettings, body.id, 1e6).bodies;

    expect(fragments).toHaveLength(6);
    const atmosphericMassAfterKg = fragments.reduce((sum, fragment) => sum + fragment.atmosphere!.dryGasMassKg, 0);
    expect(Math.abs(atmosphericMassAfterKg / atmosphere.dryGasMassKg - 1)).toBeLessThan(1e-14);
    for (const fragment of fragments) {
      const fraction = fragment.massKg / atmospheric.massKg;
      expect(Math.abs(fragment.atmosphere!.dryGasMassKg / (atmosphere.dryGasMassKg * fraction) - 1)).toBeLessThan(1e-12);
      const fragmentDryMassKg = fragment.materials!.rockKg + fragment.materials!.ironKg
        + fragment.materials!.gasKg + fragment.atmosphere!.dryGasMassKg;
      expect(Math.abs(fragment.waterInventory!.dryMassKg / fragmentDryMassKg - 1)).toBeLessThan(1e-12);
    }
  });

  it("edits materialized total mass while preserving dry fractions and T11 water phases", () => {
    const adopted = adoptWaterInventory(body);
    const materialized = applyWorldMutation([adopted], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const retainedBefore = [materialized.waterInventory!.liquidKg, materialized.waterInventory!.iceKg,
      materialized.waterInventory!.vaporKg, materialized.waterInventory!.escapedKg];
    const targetMassKg = materialized.massKg * 1.5;
    const edited = applyWorldMutation([materialized], settings, { type: "SET_MATERIAL_SIZE", bodyId: body.id,
      editMode: "mass-authoritative", massKg: targetMassKg }).bodies[0]!;

    expect(edited.massKg).toBe(targetMassKg);
    expect(edited.radiusM).not.toBe(materialized.radiusM);
    expect([edited.waterInventory!.liquidKg, edited.waterInventory!.iceKg,
      edited.waterInventory!.vaporKg, edited.waterInventory!.escapedKg]).toEqual(retainedBefore);
    expect(Math.abs(edited.waterInventory!.dryMassKg + retainedBefore[0]! + retainedBefore[1]! + retainedBefore[2]! - targetMassKg) / targetMassKg).toBeLessThan(1e-12);
    const dryMassScale = edited.waterInventory!.dryMassKg / materialized.waterInventory!.dryMassKg;
    for (const key of ["rockKg", "ironKg", "gasKg"] as const) {
      expect(Math.abs(edited.materials![key] / materialized.materials![key] - dryMassScale)).toBeLessThan(1e-12);
    }
  });

  it("edits materialized radius while preserving dry fractions and T11 water phases", () => {
    const adopted = adoptWaterInventory(body);
    const materialized = applyWorldMutation([adopted], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const retainedBefore = [materialized.waterInventory!.liquidKg, materialized.waterInventory!.iceKg,
      materialized.waterInventory!.vaporKg, materialized.waterInventory!.escapedKg];
    const targetRadiusM = materialized.radiusM * 1.1;
    const edited = applyWorldMutation([materialized], settings, { type: "SET_MATERIAL_SIZE", bodyId: body.id,
      editMode: "radius-authoritative", radiusM: targetRadiusM }).bodies[0]!;

    expect(edited.radiusM).toBe(targetRadiusM);
    expect(edited.massKg).not.toBe(materialized.massKg);
    expect([edited.waterInventory!.liquidKg, edited.waterInventory!.iceKg,
      edited.waterInventory!.vaporKg, edited.waterInventory!.escapedKg]).toEqual(retainedBefore);
    expect(edited.materials!.rockKg / (edited.materials!.rockKg + edited.materials!.ironKg + edited.materials!.gasKg))
      .toBeCloseTo(materialized.materials!.rockKg / (materialized.materials!.rockKg + materialized.materials!.ironKg + materialized.materials!.gasKg), 12);
  });

  it("rejects size edits on legacy bodies and generic mass/radius edits on materialized bodies", () => {
    const legacy = body;
    expect(() => applyWorldMutation([legacy], settings, { type: "SET_MATERIAL_SIZE", bodyId: body.id,
      editMode: "mass-authoritative", massKg: body.massKg * 2 })).toThrow(/composição explícita/);
    const materialized = applyWorldMutation([legacy], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    for (const field of ["massKg", "radiusM"] as const) {
      expect(() => applyWorldMutation([materialized], settings, { type: "EDIT_BODY", bodyId: body.id, field,
        value: materialized[field] * 2 })).toThrow(/SET_MATERIAL_SIZE/);
    }
    expect(materialized.massKg).toBe(body.massKg);
  });

  it("rejects material size targets outside existing SI bounds without clamping", () => {
    const materialized = applyWorldMutation([body], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;

    expect(() => applyWorldMutation([materialized], settings, { type: "SET_MATERIAL_SIZE", bodyId: body.id,
      editMode: "mass-authoritative", massKg: 1e33 })).toThrow();
    expect(() => applyWorldMutation([materialized], settings, { type: "SET_MATERIAL_SIZE", bodyId: body.id,
      editMode: "radius-authoritative", radiusM: 1e11 })).toThrow();
    expect(materialized.massKg).toBe(body.massKg);
  });

  it("rejects invalid material fractions at the Worker mutation boundary", () => {
    expect(() => validateWorldMutation({ type: "SET_MATERIAL_COMPOSITION", bodyId: body.id, editMode: "mass-authoritative",
      dryFractions: { rock: 0.7, iron: 0.2, gas: 0.2 } })).toThrow();
    expect(() => validateWorldMutation({ type: "SET_MATERIAL_COMPOSITION", bodyId: body.id, editMode: "mass-authoritative",
      dryFractions: { rock: 0.7, iron: 0.2, gas: 0.1, water: 0 } })).toThrow();
  });

  it.each([
    { type: "SET_MATERIAL_SIZE", bodyId: body.id, editMode: "mass-authoritative", massKg: body.massKg, radiusM: body.radiusM },
    { type: "SET_MATERIAL_SIZE", bodyId: body.id, editMode: "mass-authoritative", massKg: body.massKg, extra: true },
    { type: "SET_MATERIAL_SIZE", bodyId: body.id, editMode: "radius-authoritative", radiusM: body.radiusM, massKg: body.massKg },
    { type: "SET_MATERIAL_SIZE", bodyId: body.id, editMode: "radius-authoritative", radiusM: body.radiusM, extra: true },
  ])("rejects extra target or unknown keys in SET_MATERIAL_SIZE", (mutation) => {
    expect(() => validateWorldMutation(mutation)).toThrow();
  });

  it("uses the legacy default and realizes its requested ejecta kinetic energy", () => {
    const result = createExplosionCandidate([body], settings, body.id);
    const fragments = result.bodies;
    const expectedEnergy = body.massKg * DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG;

    expect(DEFAULT_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG).toBe(1e6);
    expect(MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG).toBe(0.5 * MAX_VELOCITY_MS ** 2);
    expect(fragments).toHaveLength(6);
    expectRelativeClose(relativeKineticEnergy(fragments), expectedEnergy);
    expectRelativeClose(result.event!.energyJ, expectedEnergy);
    expectRelativeClose(result.event!.energyJ, relativeKineticEnergy(fragments));
  });

  it("scales ejecta speed with sqrt(q) and kinetic energy linearly with q", () => {
    const lowQ = 2e5;
    const highQ = 8e5;
    const low = createExplosionCandidate([body], settings, body.id, lowQ);
    const high = createExplosionCandidate([body], settings, body.id, highQ);
    const lowKick = Math.hypot(...low.bodies[0]!.velocityMs.map((value, axis) => value - body.velocityMs[axis]!));
    const highKick = Math.hypot(...high.bodies[0]!.velocityMs.map((value, axis) => value - body.velocityMs[axis]!));

    expectRelativeClose(highKick / lowKick, 2);
    expectRelativeClose(relativeKineticEnergy(low.bodies), body.massKg * lowQ);
    expectRelativeClose(relativeKineticEnergy(high.bodies), body.massKg * highQ);
    expectRelativeClose(high.event!.energyJ, 4 * low.event!.energyJ);
  });

  it("is Galilean invariant and conserves center of mass and linear momentum", () => {
    const boost = [1e5, -2e5, 3e5] as const;
    const boostedBody = { ...body, velocityMs: body.velocityMs.map((value, axis) => value + boost[axis]!) as [number, number, number] };
    const plain = createExplosionCandidate([body], settings, body.id, 1e5);
    const boosted = createExplosionCandidate([boostedBody], settings, body.id, 1e5);
    const center = (bodies: readonly CelestialBody[]) => [0, 1, 2].map((axis) => bodies.reduce((sum, candidate) => sum + candidate.massKg * candidate.positionM[axis]!, 0) / body.massKg);

    center(boosted.bodies).forEach((value, axis) => expect(Math.abs(value - center([boostedBody])[axis]!)).toBeLessThan(1e-6));
    center(plain.bodies).forEach((value, axis) => expect(Math.abs(value - center([body])[axis]!)).toBeLessThan(1e-6));
    boosted.bodies.forEach((candidate, index) => candidate.velocityMs.forEach((value, axis) => {
      expect(value - plain.bodies[index]!.velocityMs[axis]!).toBeCloseTo(boost[axis]!, 8);
    }));
    expectRelativeClose(relativeKineticEnergy(boosted.bodies), relativeKineticEnergy(plain.bodies));
    expectRelativeClose(boosted.event!.energyJ, plain.event!.energyJ);
    momentum(plain.bodies).forEach((value, axis) => expectRelativeClose(value, momentum([body])[axis]!));
    momentum(boosted.bodies).forEach((value, axis) => expectRelativeClose(value - momentum(plain.bodies)[axis]!, boost[axis]! * body.massKg));
  });

  it("previews kinetic and uniform-sphere binding energy from q and configured G", () => {
    const preview = getExplosionEnergyPreview(body, { gravitationalConstant: 0.5 }, 2e4);

    expect(preview).toEqual({
      specificEnergyJkg: 2e4,
      kickSpeedMs: Math.sqrt(4e4),
      ejectaKineticEnergyJ: body.massKg * 2e4,
      gravitationalBindingEnergyJ: 3 * 0.5 * body.massKg ** 2 / (5 * body.radiusM),
    });
    expect(getExplosionEnergyPreview(body, { gravitationalConstant: 0 }, 2e4).gravitationalBindingEnergyJ).toBe(0);

    const escapeSpecificEnergy = NEWTONIAN_G * body.massKg / body.radiusM;
    const atEscape = getExplosionEnergyPreview(body, { gravitationalConstant: NEWTONIAN_G }, escapeSpecificEnergy);
    expect(atEscape.kickSpeedMs).toBeCloseTo(Math.sqrt(2 * NEWTONIAN_G * body.massKg / body.radiusM), 12);
    expectRelativeClose(atEscape.gravitationalBindingEnergyJ, 3 / 5 * body.massKg * escapeSpecificEnergy);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG * 2])(
    "rejects invalid ejecta specific energy %s", (specificEnergyJkg) => {
      expect(() => createExplosionCandidate([body], settings, body.id, specificEnergyJkg)).toThrow();
    },
  );

  it("rejects nonnumeric q at the runtime mutation boundary", () => {
    expect(() => validateWorldMutation({ type: "EXPLODE_BODY", bodyId: body.id, specificEnergyJkg: "1000000" }))
      .toThrow();
  });

  it("rejects energy that exceeds the velocity envelope or position boundary atomically", () => {
    const tooFast = { ...body, velocityMs: [MAX_VELOCITY_MS - 100, 0, 0] as const };
    const atBoundary = { ...body, positionM: [MAX_POSITION_COMPONENT_M, 0, 0] as const };
    const tooFastBefore = structuredClone(tooFast);
    const atBoundaryBefore = structuredClone(atBoundary);

    expect(() => createExplosionCandidate([tooFast], settings, body.id, 1e6)).toThrow();
    expect(() => createExplosionCandidate([atBoundary], settings, body.id, 1e6)).toThrow();
    expect(tooFast).toEqual(tooFastBefore);
    expect(atBoundary).toEqual(atBoundaryBefore);
  });

  it("distinguishes bound low-q return from high-q escape-speed ejecta under gravity", () => {
    const gravity = NEWTONIAN_G;
    const gravitationalSettings = { gravitationalConstant: gravity };
    const escapeSpecificEnergy = gravity * body.massKg / body.radiusM;
    const lowQ = createExplosionCandidate([{ ...body, velocityMs: [0, 0, 0] }], gravitationalSettings, body.id, 1e3);
    const highQ = createExplosionCandidate([{ ...body, velocityMs: [0, 0, 0] }], gravitationalSettings, body.id, 1e10);
    const returned = advanceSimulationInterval(lowQ.bodies, gravitationalSettings, 2_000, 10);
    const escaped = advanceSimulationInterval(highQ.bodies, gravitationalSettings, 100, 10);

    expect(1e3).toBeLessThan(escapeSpecificEnergy);
    expect(1e10).toBeGreaterThan(escapeSpecificEnergy);
    expect(returned.events.some(({ type }) => type === "collision")).toBe(true);
    expect(escaped.events).toEqual([]);
  });

  it("creates six symmetric fragments with conserved mass and linear momentum", () => {
    const child = { ...body, id: "moon", parentId: body.id, massKg: 1e22, positionM: [1.1e9, -2e9, 3e9] as const };
    const beforeMomentum = momentum([body, child]);
    const result = createExplosionCandidate([body, child], settings, body.id);
    const fragments = result.bodies.filter(({ id }) => id !== child.id);

    expect(fragments).toHaveLength(6);
    expect(fragments.reduce((sum, fragment) => sum + fragment.massKg, 0)).toBe(body.massKg);
    const afterMomentum = momentum(fragments).map((value, axis) => value + child.massKg * child.velocityMs[axis]!);
    afterMomentum.forEach((value, axis) => expect(Math.abs(value - beforeMomentum[axis]!) / Math.abs(beforeMomentum[axis]!)).toBeLessThan(1e-14));
    expect(new Set(result.bodies.map(({ id }) => id)).size).toBe(result.bodies.length);
    expect(result.bodies.find(({ id }) => id === child.id)?.parentId).toBeUndefined();
    expect(result.event).toMatchObject({ type: "explosion", bodyIds: expect.arrayContaining([body.id]), positionM: body.positionM });
    expect(result.event).toBeDefined();
    expect(Number.isFinite(result.event?.energyJ)).toBe(true);
  });

  it("partitions an adopted water inventory across accepted fragments", () => {
    const adopted = applyWorldMutation([body], settings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id }).bodies[0]!;
    const exploded = createExplosionCandidate([adopted], settings, body.id, 1e6).bodies;
    const fragments = exploded.filter(({ id }) => id !== body.id);
    const retainedBefore = adopted.waterInventory!.liquidKg + adopted.waterInventory!.iceKg + adopted.waterInventory!.vaporKg;
    const retainedAfter = fragments.reduce((sum, fragment) => sum + fragment.waterInventory!.liquidKg
      + fragment.waterInventory!.iceKg + fragment.waterInventory!.vaporKg, 0);

    expect(fragments).toHaveLength(6);
    expect(Math.abs(retainedAfter / retainedBefore - 1)).toBeLessThan(1e-12);
    fragments.forEach((fragment) => expect(Math.abs((fragment.waterInventory!.dryMassKg
      + fragment.waterInventory!.liquidKg + fragment.waterInventory!.iceKg + fragment.waterInventory!.vaporKg) / fragment.massKg - 1)).toBeLessThan(1e-12));
  });

  it("rejects compact bodies and worlds that would exceed the 64-body cap atomically", () => {
    const neutronStar: CelestialBody = {
      ...body, id: "neutron-star", name: "Neutron star", kind: "star", bodyType: "neutron-star",
      massKg: 2.78376e30, radiusM: 12_000,
    };
    expect(() => createExplosionCandidate([neutronStar], settings, neutronStar.id)).toThrow(/compact/i);

    const crowded = Array.from({ length: 60 }, (_, index) => ({
      ...body, id: `body-${index}`, positionM: [index * 1e9, 0, 0] as const,
    }));
    const before = structuredClone(crowded);
    expect(() => createExplosionCandidate(crowded, settings, "body-0")).toThrow(/64/);
    expect(crowded).toEqual(before);
  });
});

describe("orbital mutation orientation contract", () => {
  it("keeps legacy axis inputs optional and requires finite nonzero orthogonal axes when supplied", () => {
    const bodyMutation = { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: "planet", semiMajorAxisM: 4e8 };
    const pairMutation = { type: "SET_ORBITAL_PAIR", firstBodyId: "a", secondBodyId: "b", separationM: 1e8 };
    const ringMutation = { type: "CREATE_ORBITAL_RING", primaryId: "planet", innerRadiusM: 1e7, outerRadiusM: 2e7,
      representativeCount: 4, totalMassKg: 1e8, profileId: "rock-v1" };

    expect(() => validateWorldMutation(bodyMutation)).not.toThrow();
    expect(() => validateWorldMutation(pairMutation)).not.toThrow();
    expect(() => validateWorldMutation(ringMutation)).not.toThrow();
    expect(() => validateWorldMutation({ ...bodyMutation, planeNormal: [0, 0, 0], radialDirection: [1, 0, 0] })).toThrow();
    expect(() => validateWorldMutation({ ...pairMutation, planeNormal: [0, 0, 1], radialDirection: [0, 0, 2] })).toThrow();
    expect(() => validateWorldMutation({ ...ringMutation, planeNormal: [0, 0, 1], radialDirection: [1, 0, 1] })).toThrow();
    expect(() => validateWorldMutation({ ...ringMutation, planeNormal: [0, 0, 1], radialDirection: [1, 0, 0], extra: true })).toThrow();
    expect(() => validateWorldMutation({ ...bodyMutation, planeNormal: [0, 0, 1], radialDirection: [Infinity, 0, 0] })).toThrow();
  });

  it("uses the existing XY preset when orbital mutation axes are omitted", () => {
    const bodyMutation = { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: body.id, semiMajorAxisM: 1e8 };
    const withPreset = { ...bodyMutation, planeNormal: [0, 0, 1] as const, radialDirection: [1, 0, 0] as const };
    const implicitMoon = applyWorldMutation([body], atmosphereSettings, bodyMutation).bodies;
    const presetMoon = applyWorldMutation([body], atmosphereSettings, withPreset).bodies;

    expect(implicitMoon).toEqual(presetMoon);
  });
});

describe("world water inventory mutations", () => {
  it("reconciles swarm shares when water adoption and atmosphere change body mass", () => {
    const materialized = applyWorldMutation([body], atmosphereSettings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.7, iron: 0.3, gas: 0 } }).bodies[0]!;
    const ledger = createSwarmLedger([materialized], { environmentSeed: 41, profileId: "rock-v1", nextSequence: 0 });
    const adopted = applyWorldMutation([materialized], atmosphereSettings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id },
      { swarmLedger: ledger, environmentSeed: 41 });
    const atmosphere = { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 1e16, isothermalTemperatureK: 288 } as const;
    const atmospheric = applyWorldMutation(adopted.bodies, atmosphereSettings, { type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere },
      { swarmLedger: adopted.swarmLedger, environmentSeed: 41 });

    expect(adopted.swarmLedger.bodyMassShares[body.id]?.[0]?.massKg).toBe(adopted.bodies[0]!.massKg);
    expect(atmospheric.swarmLedger.bodyMassShares[body.id]?.[0]?.massKg).toBe(atmospheric.bodies[0]!.massKg);
    expect(atmospheric.swarmLedger.groups[0]?.externalMassInKg).toBeGreaterThan(adopted.swarmLedger.groups[0]!.externalMassInKg);
    expect(() => validateSwarmLedger(atmospheric.swarmLedger, atmospheric.bodies)).not.toThrow();
  });

  it("sets and removes atmosphere atomically without altering water phase or escape ledgers", () => {
    const wet = applyWorldMutation([body], atmosphereSettings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id }).bodies[0]!;
    const material = applyWorldMutation([wet], atmosphereSettings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const phases = [material.waterInventory!.liquidKg, material.waterInventory!.iceKg,
      material.waterInventory!.vaporKg, material.waterInventory!.escapedKg];
    const atmosphere = { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1",
      dryGasMassKg: 1e16, isothermalTemperatureK: 288 } as const;
    const added = applyWorldMutation([material], atmosphereSettings, { type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere }).bodies[0]!;
    const removed = applyWorldMutation([added], atmosphereSettings, { type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere: null }).bodies[0]!;

    expect(added.massKg).toBeCloseTo(material.massKg + atmosphere.dryGasMassKg, 5);
    expect(added.waterInventory!.dryMassKg).toBeCloseTo(material.waterInventory!.dryMassKg + atmosphere.dryGasMassKg, 5);
    expect([added.waterInventory!.liquidKg, added.waterInventory!.iceKg, added.waterInventory!.vaporKg,
      added.waterInventory!.escapedKg]).toEqual(phases);
    expect(removed.atmosphere).toBeUndefined();
    expect(removed.massKg).toBeCloseTo(material.massKg, 5);
    expect(removed.materials).toEqual(material.materials);
  });

  it("rejects SET_SETTINGS to G=0 atomically while atmosphere remains accepted", () => {
    const material = applyWorldMutation([body], atmosphereSettings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const accepted = applyWorldMutation([material], atmosphereSettings, { type: "SET_ATMOSPHERE", bodyId: body.id,
      atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 1e16, isothermalTemperatureK: 288 } }).bodies;
    const before = structuredClone(accepted);

    expect(() => applyWorldMutation(accepted, atmosphereSettings, { type: "SET_SETTINGS", settings })).toThrow();
    expect(accepted).toEqual(before);
  });

  it("keeps a material-plus-atmosphere collision on the existing recoverable refusal path", () => {
    const material = applyWorldMutation([body], settings, { type: "SET_MATERIAL_COMPOSITION", bodyId: body.id,
      editMode: "mass-authoritative", dryFractions: { rock: 0.6, iron: 0.3, gas: 0.1 } }).bodies[0]!;
    const atmosphere = { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1",
      dryGasMassKg: 1e16, isothermalTemperatureK: 288 } as const;
    const atmospheric = { ...material, atmosphere, massKg: material.massKg + atmosphere.dryGasMassKg };
    const legacy = { ...body, id: "legacy", positionM: [1e9, 0, 0] as const };

    expect(() => mergeCollision([atmospheric, legacy], 0, 1, settings)).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_COLLISION",
    }));
  });

  it("rejects malformed atmosphere mutation keys and legacy adoption", () => {
    expect(() => validateWorldMutation({ type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere: null, extra: true })).toThrow();
    expect(() => validateWorldMutation({ type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere: {
      modelId: "isothermal-atmosphere-v1", profileId: "unknown-v1", dryGasMassKg: 1, isothermalTemperatureK: 288,
    } })).toThrow();
    expect(() => applyWorldMutation([body], settings, { type: "SET_ATMOSPHERE", bodyId: body.id, atmosphere: null })).toThrow(/composição explícita/);
  });

  it("adopts legacy coverage explicitly, then adjusts available water and escaped mass atomically", () => {
    const original = structuredClone(body);
    const adopted = applyWorldMutation([body], settings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id }).bodies[0]!;
    const capacityKg = getWaterInventoryCapacityKg(adopted);
    const edited = applyWorldMutation([adopted], settings, {
      type: "SET_WATER_INVENTORY", bodyId: body.id, retainedWaterKg: capacityKg * 0.1,
    }).bodies[0]!;

    expect(body).toEqual(original);
    expect(adopted.massKg).toBeGreaterThan(body.massKg);
    expect(edited.waterInventory!.escapedKg).toBeGreaterThan(0);
    expect(edited.massKg).toBeCloseTo(edited.waterInventory!.dryMassKg + capacityKg * 0.1, 6);
    expect(edited.waterFraction).toBeCloseTo(0.1, 12);
  });

  it("rejects water inventory on unsupported bodies and malformed amounts", () => {
    const star = createSolarSystem()[0]!;

    expect(() => applyWorldMutation([star], settings, { type: "ADOPT_WATER_INVENTORY", bodyId: star.id })).toThrow();
    expect(() => validateWorldMutation({ type: "SET_WATER_INVENTORY", bodyId: body.id, retainedWaterKg: "1" })).toThrow();
    expect(() => validateWorldMutation({ type: "ADOPT_WATER_INVENTORY", bodyId: " " })).toThrow();
  });

  it("preserves explicit inventory when merging with a legacy body without inferring its coverage as composition", () => {
    const modeled = applyWorldMutation([body], settings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id }).bodies[0]!;
    const legacy = { ...body, id: "legacy", positionM: [1e9, 0, 0] as const, waterFraction: 0.8 };
    const merged = mergeCollision([modeled, legacy], 0, 1, settings).bodies[0]!;

    expect(merged.waterInventory).toBeDefined();
    expect(merged.waterInventory!.dryMassKg).toBeCloseTo(modeled.waterInventory!.dryMassKg + legacy.massKg, 6);
    expect(merged.waterInventory!.liquidKg).toBeCloseTo(modeled.waterInventory!.liquidKg, 6);
    expect(merged.massKg).toBeCloseTo(modeled.massKg + legacy.massKg, 6);
  });

  it("copies and fragments water state without sharing or dropping the inventory", () => {
    const adopted = applyWorldMutation([body], settings, { type: "ADOPT_WATER_INVENTORY", bodyId: body.id }).bodies[0]!;
    const duplicate = applyWorldMutation([adopted], settings, {
      type: "DUPLICATE_BODY", bodyId: body.id, positionM: [2e9, 0, 0],
    }).bodies[1]!;
    const exploded = createExplosionCandidate([adopted], settings, body.id, 1e6).bodies;

    expect(duplicate.waterInventory).toEqual(adopted.waterInventory);
    expect(duplicate.waterInventory).not.toBe(adopted.waterInventory);
    expect(exploded.slice(1).every((fragment) => fragment.waterInventory !== undefined)).toBe(true);
  });
});

describe("thermal-profile mutation compatibility", () => {
  it("keeps a duplicated legacy gas giant ineligible for the rocky profile", () => {
    const legacyJupiter = createSolarSystem().find(({ id }) => id === "jupiter")!;
    const result = applyWorldMutation([legacyJupiter], settings, {
      type: "DUPLICATE_BODY", bodyId: legacyJupiter.id, positionM: [5e12, 0, 0],
    });
    const duplicate = result.bodies.find(({ id }) => id !== legacyJupiter.id)!;

    expect(duplicate.bodyType).toBe("gas-giant");
    expect(supportsThermalProfile(duplicate)).toBe(false);
  });
});
