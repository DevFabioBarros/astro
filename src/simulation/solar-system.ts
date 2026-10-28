import type { CelestialBody } from "./types";

export const SOLAR_SYSTEM_PRESET_VERSION = 1;

export const SOLAR_SYSTEM_PRESET_SOURCE = {
  epochTdb: "2026-10-15T00:00:00",
  center: "solar system barycenter (0)",
  referencePlane: "J2000 ecliptic",
  ephemeris: "DE441",
  horizonsApiVersion: "1.2",
  vectors: "https://ssd-api.jpl.nasa.gov/doc/horizons.html",
  physicalParameters: "https://ssd.jpl.nasa.gov/planets/phys_par.html",
  sunAndMoonParameters: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/",
} as const;

const preset: readonly CelestialBody[] = [
  { id: "sun", name: "Sol", kind: "star", massKg: 1.9884e30, radiusM: 695700000, positionM: [-173666337.1821573, -763625246.9921756, 13890456.26260113], velocityMs: [10.410926575784881, 4.529576996764837, -0.2239375832334637], surfaceTemperatureK: 5772, waterFraction: 0 },
  { id: "mercury", name: "Mercúrio", kind: "planet", massKg: 3.30103e23, radiusM: 2439400, positionM: [39716666498.443375, -49628264556.893196, -7638125231.176157], velocityMs: [28054.12849955117, 33155.18336532328, 136.91756741103057], surfaceTemperatureK: 440, waterFraction: 0 },
  { id: "venus", name: "Vênus", kind: "planet", massKg: 4.86731e24, radiusM: 6051800, positionM: [104128008154.7987, 28685495278.81765, -5599496949.052795], velocityMs: [-9628.325767631848, 33551.38204988134, 1016.8839805057031], surfaceTemperatureK: 737, waterFraction: 0 },
  { id: "earth", name: "Terra", kind: "planet", massKg: 5.97217e24, radiusM: 6371008.4, positionM: [138851660566.26608, 53399249991.14612, 10169615.34363404], velocityMs: [-11297.14168918346, 27653.561138548797, -2.073437625616847], surfaceTemperatureK: 288, waterFraction: 0.71 },
  { id: "moon", name: "Lua", kind: "moon", massKg: 7.346e22, radiusM: 1737400, positionM: [138722724570.5974, 53019650982.595894, -24602676.41890794], velocityMs: [-10382.6579912416, 27314.520003627193, 15.718401666577009], surfaceTemperatureK: 253, waterFraction: 0 },
  { id: "mars", name: "Marte", kind: "planet", massKg: 6.41691e23, radiusM: 3389500, positionM: [-9309000381.452412, 234641212876.83652, 5171112243.74263], velocityMs: [-23282.95937708893, 1122.4313639480729, 594.3570473005368], surfaceTemperatureK: 208, waterFraction: 0 },
  { id: "jupiter", name: "Júpiter", kind: "planet", massKg: 1.898125e27, radiusM: 69911000, positionM: [-534332993517.43225, 587410959801.0592, 9521706717.691303], velocityMs: [-9821.120151551148, -8177.664183689094, 253.7434920376453], surfaceTemperatureK: 163, waterFraction: 0 },
  { id: "saturn", name: "Saturno", kind: "planet", massKg: 5.68317e26, radiusM: 58232000, positionM: [1382090239943.0361, 274969652202.62494, -59810755388.60087], velocityMs: [-2415.240342602472, 9451.735212815984, -67.64023227026695], surfaceTemperatureK: 133, waterFraction: 0 },
  { id: "uranus", name: "Urano", kind: "planet", massKg: 8.68099e25, radiusM: 25362000, positionM: [1328449737065.5142, 2585957780458.604, -7606336768.221617], velocityMs: [-6107.592792687526, 2794.428344353467, 89.79800431018737], surfaceTemperatureK: 78, waterFraction: 0 },
  { id: "neptune", name: "Netuno", kind: "planet", massKg: 1.024092e26, radiusM: 24622000, positionM: [4463099908259.122, 212305262792.5554, -107228747904.0645], velocityMs: [-293.4900684464931, 5461.047470506374, -106.3965160044795], surfaceTemperatureK: 73, waterFraction: 0 },
];

export function createSolarSystem(): CelestialBody[] {
  return preset.map((body) => ({
    ...body,
    positionM: [...body.positionM],
    velocityMs: [...body.velocityMs],
  }));
}
