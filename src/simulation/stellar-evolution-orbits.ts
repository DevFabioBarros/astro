import type { CelestialBody, Vector3 } from "./types";

export type OrbitalGroup = {
  bodyIds: string[];
  massKg: number;
  positionM: Vector3;
  velocityMs: Vector3;
  radiusExtentM: number;
};

export function orbitalGroups(bodies: readonly CelestialBody[]): OrbitalGroup[] {
  const earth = bodies.find((body) => body.id === "earth");
  const moon = bodies.find((body) => body.id === "moon");
  const groupedIds = new Set(["sun", "earth", "moon"]);
  const groups = bodies.filter((body) => !groupedIds.has(body.id)).map((body) => ({
    bodyIds: [body.id], massKg: body.massKg, positionM: body.positionM, velocityMs: body.velocityMs, radiusExtentM: body.radiusM,
  }));
  if (earth && moon) {
    const massKg = earth.massKg + moon.massKg;
    const positionM = weightedVector(earth.positionM, earth.massKg, moon.positionM, moon.massKg);
    const velocityMs = weightedVector(earth.velocityMs, earth.massKg, moon.velocityMs, moon.massKg);
    const radiusExtentM = Math.max(distance(earth.positionM, positionM) + earth.radiusM, distance(moon.positionM, positionM) + moon.radiusM);
    groups.push({ bodyIds: ["earth", "moon"], massKg, positionM, velocityMs, radiusExtentM });
  } else if (earth || moon) {
    const body = earth ?? moon!;
    groups.push({ bodyIds: [body.id], massKg: body.massKg, positionM: body.positionM, velocityMs: body.velocityMs, radiusExtentM: body.radiusM });
  }
  return groups.sort((a, b) => a.bodyIds[0]!.localeCompare(b.bodyIds[0]!));
}


export function weightedVector(a: Vector3, aMass: number, b: Vector3, bMass: number): Vector3 {
  return [0, 1, 2].map((axis) => (a[axis]! * aMass + b[axis]! * bMass) / (aMass + bMass)) as unknown as Vector3;
}


export function dot(a: Vector3, b: Vector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

export function cross(a: Vector3, b: Vector3): Vector3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

export function magnitude(a: Vector3): number { return Math.hypot(...a); }

export function distance(a: Vector3, b: Vector3): number { return magnitude(subtract(a, b)); }

export function add(a: Vector3, b: Vector3): Vector3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

export function subtract(a: Vector3, b: Vector3): Vector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

export function scaleVector(a: Vector3, scale: number): Vector3 { return [a[0] * scale, a[1] * scale, a[2] * scale]; }
