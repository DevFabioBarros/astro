import type { CelestialBody, PhysicsSettings } from "./types";

/** Primary used only for an osculating two-body guide; N-body forces use every body. */
export function findOrbitalPrimary(body: CelestialBody, bodies: readonly CelestialBody[], settings: PhysicsSettings): CelestialBody | undefined {
  const others = bodies.filter((candidate) => candidate.id !== body.id);
  const parent = others.find((candidate) => candidate.id === body.parentId)
    ?? (body.id === "moon" ? others.find((candidate) => candidate.id === "earth") : undefined);
  if (parent) return parent;
  const equalMassCompanion = others.find((candidate) => candidate.parentId === body.id && candidate.massKg === body.massKg);
  if (equalMassCompanion) return equalMassCompanion;
  return others.filter((candidate) => candidate.massKg > body.massKg).sort((a, b) => {
    const influence = (candidate: CelestialBody) => {
      const distance = Math.hypot(...candidate.positionM.map((value, axis) => value - body.positionM[axis]!));
      return settings.gravitationalConstant * candidate.massKg / distance ** 2;
    };
    return influence(b) - influence(a);
  })[0];
}

export function removeBodyFromWorld(bodies: readonly CelestialBody[], id: string): CelestialBody[] {
  return bodies.filter((body) => body.id !== id).map((body) => {
    if (body.parentId !== id) return body;
    const { parentId: removedParent, ...orphan } = body;
    void removedParent;
    return orphan;
  });
}

/** Instantaneous Kepler elements; valid for bound and unbound relative trajectories. */
export function getOrbitalElements(body: CelestialBody, primary: CelestialBody, settings: PhysicsSettings) {
  const r = body.positionM.map((value, axis) => value - primary.positionM[axis]!);
  const v = body.velocityMs.map((value, axis) => value - primary.velocityMs[axis]!);
  const radius = Math.hypot(...r);
  const mu = settings.gravitationalConstant * (body.massKg + primary.massKg);
  if (radius === 0 || mu <= 0) return undefined;
  const speedSquared = v.reduce((sum, value) => sum + value * value, 0);
  const dot = r.reduce((sum, value, axis) => sum + value * v[axis]!, 0);
  const eccentricity = Math.hypot(...r.map((value, axis) => ((speedSquared - mu / radius) * value - dot * v[axis]!) / mu));
  const specificEnergy = speedSquared / 2 - mu / radius;
  const semiMajorAxisM = specificEnergy === 0 ? Infinity : -mu / (2 * specificEnergy);
  const angularMomentum = [r[1]! * v[2]! - r[2]! * v[1]!, r[2]! * v[0]! - r[0]! * v[2]!, r[0]! * v[1]! - r[1]! * v[0]!];
  const semiLatusRectumM = angularMomentum.reduce((sum, value) => sum + value * value, 0) / mu;
  return { eccentricity, semiMajorAxisM, periapsisM: semiLatusRectumM / (1 + eccentricity), apoapsisM: specificEnergy < 0 ? semiMajorAxisM * (1 + eccentricity) : Infinity, specificEnergy, bound: specificEnergy < 0 };
}
