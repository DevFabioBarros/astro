import { describe, expect, it } from "vitest";
import { decodeSimulation, encodeSimulation } from "./save-file";
import { createSolarSystem } from "./solar-system";
import { MAX_SIMULATION_BODIES, validateBodies } from "./physics";
import type { CelestialBody } from "./types";
import { advanceSolarEvolutionAge, createSolarEvolutionCandidate, SOLAR_EVOLUTION_END_AGE_YEARS, SOLAR_EVOLUTION_MODEL } from "./stellar-evolution";
import { adoptWaterInventory } from "./water-model";
import { createMaterialCompositionCandidate } from "./body-edits";
import { DEFAULT_ENVIRONMENT_SEED_V1, LEGACY_ENVIRONMENT_SEED_V1 } from "./world-seed";
import type { SpinState } from "./spin-model";

const bodies = createSolarSystem();
const settings = { gravitationalConstant: 6.6743e-11 };
const file = () => ({ format: "astro-simulation", version: 1, bodies: structuredClone(bodies), settings: { ...settings } });
const limit = 10 * 1024 * 1024;

describe("simulation save files", () => {
  it("writes strict v10 for explicit spin and round-trips the accepted state", () => {
    const spin: SpinState = { modelId: "rigid-body-spin-v1", axisUnitWorld: [1, 0, 0], phaseAtEpochRad: 1.2, angularVelocityRadPerS: 0.001 };
    const spinBodies = bodies.map((body) => body.id === "earth" ? { ...body, spin } as unknown as CelestialBody : body);
    const encoded = encodeSimulation(spinBodies, settings);

    expect(JSON.parse(encoded).version).toBe(10);
    expect(decodeSimulation(encoded).bodies).toEqual(spinBodies);
    const malformed = JSON.parse(encoded);
    malformed.world.bodies.find((body: CelestialBody) => body.id === "earth").spin.extra = true;
    expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
  });

  it("writes strict v9 with compact surface payload and round-trips surface metadata", () => {
    const earth = bodies.find(({ id }) => id === "earth")!;
    const surface = { modelId: "sparse-relief-v1" as const, seed: 0xffff_ffff, revision: 3, resolution: 64 as const, dataId: "earth-relief" };
    const surfaceBodies = bodies.map((body) => body.id === earth.id ? { ...body, surface } : body);
    const surfaceData = { "earth-relief": [{ cellIndex: 0, elevationM: -1200 }, { cellIndex: 2047, elevationM: 2500 }] };
    const encoded = encodeSimulation(surfaceBodies, settings, undefined, DEFAULT_ENVIRONMENT_SEED_V1, surfaceData);
    const parsed = JSON.parse(encoded);

    expect(parsed.version).toBe(9);
    expect(parsed.world.surfaceData).toEqual(surfaceData);
    expect(decodeSimulation(encoded)).toEqual({ bodies: surfaceBodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1, surfaceData });
  });

  it("rejects malformed, duplicate, out-of-grid, or unreferenced surface payloads", () => {
    const earth = bodies.find(({ id }) => id === "earth")!;
    const surfaceBodies = bodies.map((body) => body.id === earth.id ? { ...body, surface: {
      modelId: "sparse-relief-v1" as const, seed: 1, revision: 0, resolution: 64 as const, dataId: "earth-relief",
    } } : body);
    const surfaceData = { "earth-relief": [{ cellIndex: 5, elevationM: 1 }] };
    const encoded = encodeSimulation(surfaceBodies, settings, undefined, DEFAULT_ENVIRONMENT_SEED_V1, surfaceData);
    const malformed = JSON.parse(encoded);

    malformed.world.surfaceData["earth-relief"][0].cellIndex = 2048;
    expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
    malformed.world.surfaceData["earth-relief"] = [{ cellIndex: 5, elevationM: 1 }, { cellIndex: 5, elevationM: 2 }];
    expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
    malformed.world.surfaceData = { orphan: [] };
    expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
    malformed.world.surfaceData = { "earth-relief": [{ cellIndex: 5, elevationM: 1e20 }] };
    expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
  });

  it("enforces the aggregate 4 MiB surface payload budget on import and export", () => {
    const earth = bodies.find(({ id }) => id === "earth")!;
    const surfaceBodies = Array.from({ length: MAX_SIMULATION_BODIES }, (_, index) => ({
      ...earth, id: `surface-${index}`, parentId: undefined, positionM: [index * 1e9, 0, 0] as const,
      surface: { modelId: "sparse-relief-v1" as const, seed: index, revision: 0, resolution: 64 as const, dataId: `surface-${index}` },
    }));
    const patches = Array.from({ length: 2048 }, (_, cellIndex) => ({ cellIndex, elevationM: cellIndex }));
    const surfaceData = Object.fromEntries(surfaceBodies.map((body) => [body.surface.dataId, patches]));
    expect(() => encodeSimulation(surfaceBodies, settings, undefined, DEFAULT_ENVIRONMENT_SEED_V1, surfaceData)).toThrow(/superfície/);
    const invalidImport = JSON.stringify({ format: "astro-simulation", version: 9,
      world: { bodies: surfaceBodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1, surfaceData } });
    expect(() => decodeSimulation(invalidImport)).toThrow();
  });

  it("requires exactly one payload for every surface and keeps legacy v8 bodies surface-free", () => {
    const earth = bodies.find(({ id }) => id === "earth")!;
    const surfaceBodies = bodies.map((body) => body.id === earth.id ? { ...body, surface: {
      modelId: "sparse-relief-v1" as const, seed: 1, revision: 0, resolution: 64 as const, dataId: "earth-relief",
    } } : body);
    expect(() => encodeSimulation(surfaceBodies, settings)).toThrow();
    const v8 = JSON.parse(encodeSimulation(bodies, settings));
    expect(v8.version).toBe(8);
    expect(decodeSimulation(JSON.stringify(v8))).not.toHaveProperty("surfaceData");
    const missingPayload = JSON.parse(encodeSimulation(surfaceBodies, settings, undefined, DEFAULT_ENVIRONMENT_SEED_V1,
      { "earth-relief": [] }));
    delete missingPayload.world.surfaceData["earth-relief"];
    expect(() => decodeSimulation(JSON.stringify(missingPayload))).toThrow();
  });
  it("rejects more than 64 bodies at validation and import boundaries", () => {
    const manyBodies = Array.from({ length: MAX_SIMULATION_BODIES + 1 }, (_, index) => ({
      ...bodies[0]!, id: `body-${index}`, massKg: 1, positionM: [index * 1e9, 0, 0] as const,
    }));
    expect(() => validateBodies(manyBodies)).toThrow("64 astros");
    expect(() => encodeSimulation(manyBodies, settings)).toThrow("64 astros");
    expect(() => decodeSimulation(JSON.stringify({ ...file(), bodies: manyBodies }))).toThrow();
    const allowed = manyBodies.slice(0, MAX_SIMULATION_BODIES);
    expect(decodeSimulation(encodeSimulation(allowed, settings)).bodies).toHaveLength(MAX_SIMULATION_BODIES);
  });

  it("rejects an excessive body array before reading individual body values", () => {
    const manyBodies = new Array(MAX_SIMULATION_BODIES + 1) as CelestialBody[];
    Object.defineProperty(manyBodies, "0", { get: () => { throw new Error("Body data was accessed"); } });
    expect(() => validateBodies(manyBodies)).toThrow("64 astros");
  });
  it("round-trips every body field and settings in the versioned format", () => {
    const text = encodeSimulation(bodies, settings);
    expect(JSON.parse(text)).toEqual({ format: "astro-simulation", version: 8, world: { bodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1 } });
    expect(decodeSimulation(text)).toEqual({ bodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1 });
    expect(decodeSimulation(encodeSimulation(bodies, { gravitationalConstant: 0 })).settings.gravitationalConstant).toBe(0);
  });

  it("writes and strictly validates a persisted uint32 world seed in v8", () => {
    const text = encodeSimulation(bodies, settings, undefined, 0xffff_ffff);
    expect(JSON.parse(text)).toMatchObject({ version: 8, world: { environmentSeed: 0xffff_ffff } });
    expect(decodeSimulation(text).environmentSeed).toBe(0xffff_ffff);
    for (const environmentSeed of [-1, 0x1_0000_0000, 1.5, null]) {
      const malformed = JSON.parse(text);
      malformed.world.environmentSeed = environmentSeed;
      expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
    }
    const extra = JSON.parse(text);
    extra.world.extra = true;
    expect(() => decodeSimulation(JSON.stringify(extra))).toThrow();
    expect(() => encodeSimulation(bodies, settings, undefined, -1)).toThrow();
  });

  it("persists only explicitly opted-in thermal profiles in version 5", () => {
    const thermalBodies = bodies.map((body) => body.id === "earth" ? { ...body, thermalProfileId: "earthlike-global-mean-v1" as const } : body);
    const session = { simulationTimeSeconds: 3600, collisionMode: "creative" as const };
    const text = encodeSimulation(thermalBodies, settings, session);
    const legacyV4 = { format: "astro-simulation", version: 4, world: { bodies, settings }, session };

    expect(JSON.parse(text).version).toBe(8);
    expect(decodeSimulation(text)).toEqual({ bodies: thermalBodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1, session });
    expect(decodeSimulation(JSON.stringify(legacyV4))).toEqual({ bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1, session });
    expect(decodeSimulation(JSON.stringify(legacyV4)).bodies.every((body) => body.thermalProfileId === undefined)).toBe(true);
  });

  it("writes version 6 for water inventory and keeps version 5 water coverage legacy", () => {
    const waterBodies = bodies.map((body) => body.id === "earth" ? adoptWaterInventory(body) : body);
    const session = { simulationTimeSeconds: 3600, collisionMode: "creative" as const };
    const waterSave = encodeSimulation(waterBodies, settings, session);
    const legacyV5 = { format: "astro-simulation", version: 5, world: { bodies, settings }, session };
    const legacyV6 = { format: "astro-simulation", version: 6, world: { bodies: waterBodies, settings }, session };

    expect(JSON.parse(waterSave).version).toBe(8);
    expect(decodeSimulation(waterSave)).toEqual({ bodies: waterBodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1, session });
    expect(decodeSimulation(JSON.stringify(legacyV5)).environmentSeed).toBe(LEGACY_ENVIRONMENT_SEED_V1);
    expect(decodeSimulation(JSON.stringify(legacyV6)).environmentSeed).toBe(LEGACY_ENVIRONMENT_SEED_V1);
    expect(() => decodeSimulation(JSON.stringify({ ...legacyV6, world: { ...legacyV6.world, environmentSeed: 1 } }))).toThrow();
    expect(decodeSimulation(JSON.stringify(legacyV5)).bodies.find(({ id }) => id === "earth")?.waterInventory).toBeUndefined();
  });

  it("writes v8 for explicit material state and derives water from T11 phases", () => {
    const earth = adoptWaterInventory(bodies.find(({ id }) => id === "earth")!);
    const materialEarth = createMaterialCompositionCandidate([earth], settings, earth.id,
      "mass-authoritative", { rock: 0.7, iron: 0.2, gas: 0.1 })[0]!;
    const payload = JSON.parse(encodeSimulation(bodies.map((body) => body.id === earth.id ? materialEarth : body), settings));

    expect(payload.version).toBe(8);
    expect(payload.world.bodies.find((body: CelestialBody) => body.id === earth.id).materials).not.toHaveProperty("waterKg");
    expect(decodeSimulation(JSON.stringify(payload)).bodies.find(({ id }) => id === earth.id)).toEqual(materialEarth);
    const duplicatedWater = structuredClone(payload);
    duplicatedWater.world.bodies.find((body: CelestialBody) => body.id === earth.id).materials.waterKg = 1;
    expect(() => decodeSimulation(JSON.stringify(duplicatedWater))).toThrow();
    expect(decodeSimulation(encodeSimulation(bodies.map((body) => body.id === earth.id ? earth : body), settings)).bodies.find(({ id }) => id === earth.id)?.materials).toBeUndefined();
  });

  it("writes v8 for atmosphere and strictly round-trips optional atmosphere state", () => {
    const earth = bodies.find(({ id }) => id === "earth")!;
    const materialEarth = createMaterialCompositionCandidate([earth], settings, earth.id,
      "mass-authoritative", { rock: 0.7, iron: 0.2, gas: 0.1 })[0]!;
    const atmosphere = { modelId: "isothermal-atmosphere-v1" as const, profileId: "nitrogen-oxygen-v1" as const,
      dryGasMassKg: 1e17, isothermalTemperatureK: 288 };
    const world = bodies.map((body) => body.id === earth.id
      ? { ...materialEarth, atmosphere, massKg: materialEarth.massKg + atmosphere.dryGasMassKg } : body);
    const encoded = encodeSimulation(world, settings);
    const legacyV7 = { format: "astro-simulation", version: 7, world: { bodies: [materialEarth], settings } };
    const malformed = JSON.parse(encoded);
    malformed.world.bodies.find((body: CelestialBody) => body.id === earth.id).atmosphere.extra = true;

    expect(JSON.parse(encoded).version).toBe(8);
    expect(decodeSimulation(encoded).bodies).toEqual(world);
    expect(() => encodeSimulation(world, { gravitationalConstant: 0 })).toThrow();
    const zeroGravity = JSON.parse(encoded);
    zeroGravity.world.settings.gravitationalConstant = 0;
    expect(() => decodeSimulation(JSON.stringify(zeroGravity))).toThrow();
    expect(decodeSimulation(JSON.stringify(legacyV7)).bodies).toEqual([materialEarth]);
    expect(() => decodeSimulation(JSON.stringify(malformed))).toThrow();
  });

  it("rejects water ledger that does not match accepted mass and volume", () => {
    const waterBodies = bodies.map((body) => body.id === "earth" ? adoptWaterInventory(body) : body);
    const payload = JSON.parse(encodeSimulation(waterBodies, settings));
    payload.world.bodies.find((body: CelestialBody) => body.id === "earth").waterInventory.escapedKg = -1;

    expect(() => decodeSimulation(JSON.stringify(payload))).toThrow();
  });

  it("does not serialize transient simulation events in version 2 saves", () => {
    const text = encodeSimulation(bodies, settings);
    expect(JSON.parse(text)).not.toHaveProperty("events");
    expect(decodeSimulation(text)).not.toHaveProperty("events");
  });

  it.each([
    ["red giant", 11.4e9, "star"],
    ["white dwarf", SOLAR_EVOLUTION_END_AGE_YEARS, "white-dwarf"],
  ] as const)("round-trips secular solar metadata for %s in version 3", (_label, ageYears, bodyType) => {
    const world = advanceSolarEvolutionAge(createSolarEvolutionCandidate(bodies), ageYears, settings).bodies;
    const legacyV3 = { format: "astro-simulation", version: 3, bodies: world, settings };
    expect(world.find((body) => body.id === "sun")?.bodyType).toBe(bodyType);
    const restored = decodeSimulation(encodeSimulation(world, settings));
    expect(JSON.parse(encodeSimulation(world, settings)).version).toBe(8);
    expect(restored.bodies).toEqual(world);
    expect(decodeSimulation(JSON.stringify(legacyV3)).environmentSeed).toBe(LEGACY_ENVIRONMENT_SEED_V1);
  });

  it("round-trips edited manual solar profile and preserves its ledger", () => {
    const world = createSolarEvolutionCandidate(bodies).map((body) => body.id === "sun"
      ? { ...body, massKg: body.massKg * 1.01, radiusM: 2.5e11, surfaceTemperatureK: 3500, stellarEvolution: { ...body.stellarEvolution!, mode: "manual" as const } }
      : body);
    expect(decodeSimulation(encodeSimulation(world, settings)).bodies).toEqual(world);
  });

  it("rejects invalid secular physics and malformed evolution metadata atomically", () => {
    const world = createSolarEvolutionCandidate(bodies);
    const sun = world.find((body) => body.id === "sun")!;
    const malformed = [
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, modelId: "other-model" } },
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, modelVersion: "other-version" } },
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, ageYears: SOLAR_EVOLUTION_END_AGE_YEARS + 1 } },
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, accretedMassKg: SOLAR_EVOLUTION_MODEL.initialMassSolar * 1e30 } },
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, absorbedBodyIds: ["earth", "earth"] } },
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, absorbedBodyIds: ["unknown"] } },
      { ...sun, stellarEvolution: { ...sun.stellarEvolution!, absorbedBodyIds: ["earth"], accretedMassKg: 0 } },
      { ...sun, radiusM: sun.radiusM * 1.1 },
      { ...sun, bodyType: "white-dwarf" as const },
    ];
    for (const badSun of malformed) {
      const payload = JSON.stringify({ format: "astro-simulation", version: 3, bodies: world.map((body) => body.id === "sun" ? badSun : body), settings });
      const currentWorld = structuredClone(bodies);
      expect(() => {
        decodeSimulation(payload);
        currentWorld.splice(0, currentWorld.length, ...world);
      }).toThrow();
      expect(currentWorld).toEqual(bodies);
    }
  });

  it("continues decoding legacy version 1 and version 2 files", () => {
    const v1 = file();
    const v2 = { ...v1, version: 2, bodies: bodies.map((body) => ({ ...body, ...(body.id === "sun" ? { bodyType: "star" as const } : { parentId: "sun" }) })) };
    expect(decodeSimulation(JSON.stringify(v1))).toMatchObject({ bodies, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1 });
    expect(decodeSimulation(JSON.stringify(v2))).toMatchObject({ bodies: v2.bodies, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1 });
    expect(() => decodeSimulation(JSON.stringify({ ...file(), environmentSeed: 123 }))).toThrow();
  });

  it("preserves non-empty IDs and names exactly, including surrounding spaces", () => {
    const spacedBodies = [{ ...bodies[0]!, id: " corpo ", name: " Estrela " }];
    expect(decodeSimulation(encodeSimulation(spacedBodies, settings)).bodies).toEqual(spacedBodies);
  });

  it.each([
    { massKg: Number.MAX_VALUE },
    { radiusM: Number.MAX_VALUE },
    { positionM: [Number.MAX_VALUE, 0, 0] },
    { velocityMs: [Number.MAX_VALUE, 0, 0] },
  ])("rejects finite body magnitudes outside the supported physical/rendering envelope: %j", (override) => {
    const data = file();
    Object.assign(data.bodies[0]!, override);
    expect(() => decodeSimulation(JSON.stringify(data))).toThrow();
    expect(() => encodeSimulation(data.bodies, data.settings)).toThrow();
  });

  it("rejects finite gravitational constants outside the supported envelope", () => {
    expect(() => decodeSimulation(JSON.stringify({ ...file(), settings: { gravitationalConstant: Number.MAX_VALUE } }))).toThrow();
    expect(() => encodeSimulation(bodies, { gravitationalConstant: Number.MAX_VALUE })).toThrow();
  });

  it("rejects a finite world whose acceleration exceeds the fixed-step safety envelope", () => {
    const unsafeBodies = [
      { ...bodies[0]!, id: "a", massKg: 1e32, positionM: [0, 0, 0] as const },
      { ...bodies[0]!, id: "b", massKg: 1e32, positionM: [1e9, 0, 0] as const },
    ];
    expect(() => decodeSimulation(JSON.stringify({ format: "astro-simulation", version: 1, bodies: unsafeBodies, settings: { gravitationalConstant: 1 } }))).toThrow();
    expect(() => encodeSimulation(unsafeBodies, { gravitationalConstant: 1 })).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => decodeSimulation("{" )).toThrow();
  });

  it.each([{ version: 3 }, { version: "1" }, { format: "another-simulation" }])("rejects unsupported envelopes: %j", (override) => {
    expect(() => decodeSimulation(JSON.stringify({ ...file(), ...override }))).toThrow();
  });

  it("rejects over 10 MiB before parsing and accepts the exact limit", () => {
    const text = JSON.stringify(file());
    expect(() => decodeSimulation(text + " ".repeat(limit + 1 - new TextEncoder().encode(text).length))).toThrow(/10 MiB/);
    expect(decodeSimulation(text + " ".repeat(limit - new TextEncoder().encode(text).length))).toEqual({ bodies, settings, environmentSeed: LEGACY_ENVIRONMENT_SEED_V1 });
  });

  it("measures UTF-8 bytes instead of string length", () => {
    expect(() => decodeSimulation(`"${"é".repeat(limit / 2)}"`)).toThrow(/10 MiB/);
  });

  it.each(["bodies", "settings", "version", "format"])("rejects missing %s", (key) => {
    const data: Record<string, unknown> = file();
    delete data[key];
    expect(() => decodeSimulation(JSON.stringify(data))).toThrow();
  });

  it("rejects missing body fields, duplicate IDs, empty systems, and wrong vector lengths", () => {
    const data = file();
    expect(() => decodeSimulation(JSON.stringify({ ...data, bodies: [{ id: "only" }] }))).toThrow();
    expect(() => decodeSimulation(JSON.stringify({ ...data, bodies: [bodies[0], bodies[0]] }))).toThrow();
    expect(decodeSimulation(JSON.stringify({ ...data, bodies: [] })).bodies).toEqual([]);
    data.bodies[0]!.positionM = [1, 2] as unknown as [number, number, number];
    expect(() => decodeSimulation(JSON.stringify(data))).toThrow();
  });

  it.each([
    { massKg: 0 }, { radiusM: -1 }, { surfaceTemperatureK: -1 },
    { waterFraction: 1.1 }, { positionM: [null, 0, 0] }, { velocityMs: ["1", 0, 0] },
    { name: " " }, { kind: "comet" },
  ])("rejects unsafe body values: %j", (override) => {
    const data = file();
    Object.assign(data.bodies[0]!, override);
    expect(() => decodeSimulation(JSON.stringify(data))).toThrow();
  });

  it("rejects numeric overflow and negative gravity", () => {
    expect(() => decodeSimulation(JSON.stringify(file()).replace(String(settings.gravitationalConstant), "1e999"))).toThrow();
    expect(() => decodeSimulation(JSON.stringify({ ...file(), settings: { gravitationalConstant: -1 } }))).toThrow();
  });

  it("rejects invalid values during export instead of converting infinity to null", () => {
    expect(() => encodeSimulation(bodies, { gravitationalConstant: Infinity })).toThrow();
  });
});
