import { describe, expect, it } from "vitest";
import { calculateAccelerations, SimulationError, validateBodies, validateSimulationState } from "./physics";
import { SOLAR_EVOLUTION_END_AGE_YEARS, SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG, SOLAR_EVOLUTION_START_AGE_YEARS } from "./stellar-evolution-limits";
import { createSolarSystem } from "./solar-system";
import type { CelestialBody, PhysicsSettings } from "./types";
import { calculateDryMaterialVolumeM3 } from "./material-profiles";
import { deriveAtmosphereMetrics } from "./atmosphere-model";
import type { SpinState } from "./spin-model";

const settings = (gravitationalConstant = 1): PhysicsSettings => ({ gravitationalConstant });
const testSpin: SpinState = { modelId: "rigid-body-spin-v1", axisUnitWorld: [0, 0, 1], phaseAtEpochRad: 0, angularVelocityRadPerS: 1 };

const body = (
  id: string,
  massKg: number,
  positionM: CelestialBody["positionM"],
  overrides: Partial<CelestialBody> = {},
): CelestialBody => ({
  id,
  name: id,
  kind: "planet",
  massKg,
  radiusM: 1,
  positionM,
  velocityMs: [0, 0, 0],
  surfaceTemperatureK: 288,
  waterFraction: 0,
  ...overrides,
});

describe("calculateAccelerations", () => {
  it("validates spin against accepted body mass, radius, and G", () => {
    const base = body("spinning", 1e24, [0, 0, 0], { radiusM: 6e6 });
    const stable = { ...base, spin: testSpin } as unknown as CelestialBody;
    const unstable = { ...base, spin: { ...testSpin, angularVelocityRadPerS: 100 } } as unknown as CelestialBody;

    expect(() => validateSimulationState([stable], settings())).not.toThrow();
    expect(() => validateSimulationState([unstable], settings())).toThrow(/limite de estabilidade/);
    expect(() => validateSimulationState([stable], settings(0))).toThrow(/limite de estabilidade/);
  });

  it("validates atmosphere as explicit dry mass within material and water mass balances", () => {
    const materialMassKg = 6e24 - 5e18;
    const atmospheric: CelestialBody = {
      ...body("world", 6e24, [0, 0, 0]),
      radiusM: Math.cbrt(3 * (materialMassKg / 3_000) / (4 * Math.PI)),
      materials: { modelId: "material-composition-v1", rockKg: materialMassKg, ironKg: 0, gasKg: 0 },
      atmosphere: { modelId: "isothermal-atmosphere-v1", profileId: "nitrogen-oxygen-v1", dryGasMassKg: 5e18, isothermalTemperatureK: 288 },
    };
    expect(() => validateBodies([atmospheric])).not.toThrow();
    expect(() => validateBodies([{ ...atmospheric, materials: undefined }])).toThrow();
    expect(() => validateBodies([{ ...atmospheric, massKg: atmospheric.massKg - 1e18 }])).toThrow();
    expect(() => deriveAtmosphereMetrics(atmospheric, 0)).toThrow();
    expect(() => validateSimulationState([atmospheric], settings(0))).toThrow();
  });

  it("rejects the Solar System candidate with G=1 before settings can be applied", () => {
    expect(() => calculateAccelerations(createSolarSystem(), { gravitationalConstant: 1 })).toThrow(SimulationError);
  });

  it("calculates Newtonian pair acceleration in SI units", () => {
    expect(calculateAccelerations([
      body("a", 2, [0, 0, 0]),
      body("b", 3, [10, 0, 0]),
    ], settings())).toEqual([[0.03, 0, 0], [-0.02, 0, 0]]);
  });

  it("preserves pair momentum symmetry", () => {
    const accelerations = calculateAccelerations([
      body("a", 2, [0, 0, 0]),
      body("b", 3, [10, 0, 0]),
    ], settings());

    expect(accelerations[0]![0] * 2 + accelerations[1]![0] * 3).toBeCloseTo(0);
  });

  it("returns zero acceleration when gravity is disabled", () => {
    expect(calculateAccelerations([
      body("a", 2, [0, 0, 0]),
      body("b", 3, [10, 0, 0]),
    ], settings(0))).toEqual([[0, 0, 0], [0, 0, 0]]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid G: %s", (g) => {
    expect(() => calculateAccelerations([body("a", 1, [0, 0, 0])], settings(g)))
      .toThrow(SimulationError);
  });

  it.each([
    ["kind", { kind: "comet" }],
    ["zero mass", { massKg: 0 }],
    ["non-finite mass", { massKg: Number.NaN }],
    ["zero radius", { radiusM: 0 }],
    ["non-finite radius", { radiusM: Number.POSITIVE_INFINITY }],
    ["negative water fraction", { waterFraction: -0.1 }],
    ["water fraction above one", { waterFraction: 1.1 }],
    ["non-finite temperature", { surfaceTemperatureK: Number.NaN }],
  ])("rejects invalid body data: %s", (_label, overrides) => {
    expect(() => calculateAccelerations([
      body("a", 1, [0, 0, 0], overrides as Partial<CelestialBody>),
    ], settings())).toThrow(SimulationError);
  });

  it("rejects coincident bodies", () => {
    expect(() => calculateAccelerations([
      body("a", 1, [0, 0, 0]),
      body("b", 1, [0, 0, 0]),
    ], settings())).toThrow(SimulationError);
  });

  it("rejects coincident bodies even when gravity is disabled", () => {
    expect(() => calculateAccelerations([
      body("a", 1, [0, 0, 0]),
      body("b", 1, [0, 0, 0]),
    ], settings(0))).toThrow(SimulationError);
  });

  it("rejects finite accelerations outside the one-second timestep envelope", () => {
    expect(() => calculateAccelerations([
      body("a", 1e32, [0, 0, 0]),
      body("b", 1e32, [1e9, 0, 0]),
    ], settings(1))).toThrow(SimulationError);
  });

  it("rejects acceleration overflow from extreme masses", () => {
    expect(() => calculateAccelerations([
      body("a", Number.MAX_VALUE, [0, 0, 0]),
      body("b", Number.MAX_VALUE, [1e-6, 0, 0]),
    ], settings())).toThrow(SimulationError);
  });

  it("rejects unrepresentable separation from extreme coordinates", () => {
    expect(() => calculateAccelerations([
      body("a", 1, [Number.MAX_VALUE, 0, 0]),
      body("b", 1, [-Number.MAX_VALUE, 0, 0]),
    ], settings())).toThrow(SimulationError);
  });

  it("applies expanded radius and position envelopes only to a recognized solar profile", () => {
    const solar = createSolarSystem()[0]!;
    const evolvedSun: CelestialBody = {
      ...solar,
      radiusM: 2.5e11,
      positionM: [8e12, 0, 0],
      stellarEvolution: {
        modelId: "mist-v1.2-solar-1msun-nonrotating", modelVersion: "1.2", ageYears: 1e10,
        accretedMassKg: 0, absorbedBodyIds: [], mode: "manual",
      },
    };
    const outerBody = body("outer", 1, [9e12, 0, 0]);

    expect(() => calculateAccelerations([evolvedSun, outerBody], settings(0))).not.toThrow();
    expect(() => calculateAccelerations([body("ordinary", 1, [0, 0, 0], { radiusM: 2.5e11 })], settings(0))).toThrow(SimulationError);
    expect(() => calculateAccelerations([body("ordinary", 1, [9e12, 0, 0])], settings(0))).toThrow(SimulationError);
  });
});

describe("material composition invariants", () => {
  it("requires component mass and additive volume to match accepted body state", () => {
    const massKg = 1e6;
    const fractions = { rock: 0.5, iron: 0.25, gas: 0.25 };
    const materialBody = body("material", massKg, [0, 0, 0], {
      radiusM: Math.cbrt(3 * calculateDryMaterialVolumeM3(massKg, fractions) / (4 * Math.PI)),
      materials: { modelId: "material-composition-v1", rockKg: massKg * 0.5, ironKg: massKg * 0.25, gasKg: massKg * 0.25 },
    });
    expect(() => validateBodies([materialBody])).not.toThrow();
    expect(() => validateBodies([{ ...materialBody, materials: { ...materialBody.materials!, modelId: "unknown-v2" } as never }])).toThrow();
    expect(() => validateBodies([{ ...materialBody, materials: { ...materialBody.materials!, rockKg: massKg } }])).toThrow(/composição/);
  });
});



describe("solar evolution metadata bounds", () => {
  const solar = createSolarSystem()[0]!;
  const metadata = { modelId: "mist-v1.2-solar-1msun-nonrotating" as const, modelVersion: "1.2" as const,
    ageYears: SOLAR_EVOLUTION_START_AGE_YEARS, accretedMassKg: 0, absorbedBodyIds: [], mode: "manual" as const };
  const withMetadata = (overrides: Partial<typeof metadata> = {}): CelestialBody => ({
    ...solar, stellarEvolution: { ...metadata, ...overrides },
  });

  it.each([0, SOLAR_EVOLUTION_START_AGE_YEARS - 1, SOLAR_EVOLUTION_END_AGE_YEARS + 1, Number.NaN])(
    "rejects persisted solar age outside model domain: %s", (ageYears) => {
      expect(() => validateBodies([withMetadata({ ageYears })])).toThrow(SimulationError);
    },
  );

  it.each([-1, SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG * (1 + 1e-12), Number.NaN])(
    "rejects persisted accretion outside model limit: %s", (accretedMassKg) => {
      expect(() => validateBodies([withMetadata({ accretedMassKg })])).toThrow(SimulationError);
    },
  );

  it("accepts inclusive age and accretion boundaries", () => {
    expect(() => validateBodies([withMetadata({ ageYears: SOLAR_EVOLUTION_START_AGE_YEARS, accretedMassKg: 0 })])).not.toThrow();
    expect(() => validateBodies([withMetadata({ ageYears: SOLAR_EVOLUTION_END_AGE_YEARS, accretedMassKg: SOLAR_EVOLUTION_MAX_ACCRETED_MASS_KG })])).not.toThrow();
  });
});
