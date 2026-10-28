import type { CelestialBody, Vector3 } from "@/simulation/types";

export type LagrangePointId = "L1" | "L2" | "L3" | "L4" | "L5";
export type LagrangePoint = { id: LagrangePointId; positionM: Vector3; velocityMs: Vector3 };

const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vector3, b: Vector3): Vector3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (vector: Vector3, amount: number): Vector3 => [vector[0] * amount, vector[1] * amount, vector[2] * amount];
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const magnitude = (vector: Vector3): number => Math.hypot(...vector);
const normalized = (vector: Vector3): Vector3 | null => {
  const length = magnitude(vector);
  return length > 0 && Number.isFinite(length) ? scale(vector, 1 / length) : null;
};

function bisectRoot(fn: (value: number) => number, lower: number, upper: number): number | null {
  let lowerValue = fn(lower), upperValue = fn(upper);
  if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue) || Math.sign(lowerValue) === Math.sign(upperValue)) return null;
  for (let index = 0; index < 80; index += 1) {
    const middle = (lower + upper) / 2;
    const middleValue = fn(middle);
    if (!Number.isFinite(middleValue)) return null;
    if (middleValue === 0) return middle;
    if (Math.sign(middleValue) === Math.sign(lowerValue)) {
      lower = middle;
      lowerValue = middleValue;
    } else {
      upper = middle;
      upperValue = middleValue;
    }
  }
  return (lower + upper) / 2;
}

/** Instantaneous circular restricted two-body guide; it never changes simulation forces. */
export function calculateApproximateLagrangePoints(primary: CelestialBody, secondary: CelestialBody, gravitationalConstant: number): LagrangePoint[] | null {
  const totalMass = primary.massKg + secondary.massKg;
  const separationVector = subtract(secondary.positionM, primary.positionM);
  const separation = magnitude(separationVector);
  const relativeVelocity = subtract(secondary.velocityMs, primary.velocityMs);
  const angularMomentum = cross(separationVector, relativeVelocity);
  const normal = normalized(angularMomentum);
  const axis = normalized(separationVector);
  const speedSquared = relativeVelocity.reduce((sum, value) => sum + value * value, 0);
  const specificEnergy = speedSquared / 2 - gravitationalConstant * totalMass / separation;
  if (!(primary.massKg > secondary.massKg && gravitationalConstant > 0 && separation > 0 && totalMass > 0)
    || !normal || !axis || !Number.isFinite(specificEnergy) || specificEnergy >= 0) return null;
  const tangent = normalized(cross(normal, axis));
  if (!tangent) return null;

  const massRatio = secondary.massKg / totalMass;
  const primaryX = -massRatio, secondaryX = 1 - massRatio;
  const equation = (x: number) => x
    - (1 - massRatio) * (x + massRatio) / Math.abs(x + massRatio) ** 3
    - massRatio * (x - (1 - massRatio)) / Math.abs(x - (1 - massRatio)) ** 3;
  const epsilon = 1e-12;
  const roots = [
    bisectRoot(equation, primaryX + epsilon, secondaryX - epsilon),
    bisectRoot(equation, secondaryX + epsilon, secondaryX + 2),
    bisectRoot(equation, -2, primaryX - epsilon),
  ];
  if (roots.some((root) => root === null)) return null;

  const centerPosition = scale(add(scale(primary.positionM, primary.massKg), scale(secondary.positionM, secondary.massKg)), 1 / totalMass);
  const centerVelocity = scale(add(scale(primary.velocityMs, primary.massKg), scale(secondary.velocityMs, secondary.massKg)), 1 / totalMass);
  const angularVelocity = scale(angularMomentum, 1 / separation ** 2);
  const coordinates: readonly [LagrangePointId, number, number][] = [
    ["L1", roots[0]!, 0], ["L2", roots[1]!, 0], ["L3", roots[2]!, 0],
    ["L4", 0.5 - massRatio, Math.sqrt(3) / 2], ["L5", 0.5 - massRatio, -Math.sqrt(3) / 2],
  ];
  return coordinates.map(([id, x, y]) => {
    const offset = scale(add(scale(axis, x), scale(tangent, y)), separation);
    return { id, positionM: add(centerPosition, offset), velocityMs: add(centerVelocity, cross(angularVelocity, offset)) };
  });
}
