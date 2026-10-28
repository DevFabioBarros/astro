import { MAX_ACCELERATION_MS2, MAX_MASS_KG, MAX_RADIUS_M, MAX_SIMULATION_BODIES, validateSimulationState } from "./physics";
import { SimulationError } from "./types";
import type { CelestialBody, CollisionEnergyLedger, PhysicsSettings, SimulationEvent, Vector3 } from "./types";
import { createExplosionCandidate, getExplosionEnergyPreview } from "./world-mutations";
import { schwarzschildRadius } from "./physical-constants";
import { combineWaterInventories } from "./water-model";
import { mergeSwarmShares, createEmptySwarmLedger, distributeSwarmShares, validateSwarmLedger } from "./swarm-model";
import { materialCompositionVolumeM3 } from "./material-profiles";
import type { SwarmLedger } from "./types";

export type CollisionResult = {
  bodies: CelestialBody[];
  event: Omit<SimulationEvent, "id" | "timeSeconds">;
  swarmLedger?: SwarmLedger;
};

function collisionEnergyLedger(relativeKineticJ: number, fragmentKineticJ = 0): CollisionEnergyLedger {
  return {
    modelId: "collision-energy-ledger-v1",
    sources: { externalJ: 0, relativeKineticJ },
    allocations: { fragmentKineticJ, thermalJ: 0, unresolvedJ: relativeKineticJ - fragmentKineticJ },
  };
}

export function findOverlappingPair(bodies: readonly CelestialBody[]): readonly [number, number] | undefined {
  for (let first = 0; first < bodies.length; first += 1) {
    for (let second = first + 1; second < bodies.length; second += 1) {
      const a = bodies[first]!;
      const b = bodies[second]!;
      if (Math.hypot(...a.positionM.map((value, axis) => value - b.positionM[axis]!)) <= a.radiusM + b.radiusM) return [first, second];
    }
  }
  return undefined;
}

/** Returns earliest contact fraction along straight segments joining both substep endpoints. */
export function findSweptCollision(start: readonly CelestialBody[], end: readonly CelestialBody[]): { first: number; second: number; fraction: number } | undefined {
  let earliest: { first: number; second: number; fraction: number } | undefined;
  for (let first = 0; first < start.length; first += 1) {
    for (let second = first + 1; second < start.length; second += 1) {
      const a0 = start[first]!;
      const b0 = start[second]!;
      const a1 = end[first]!;
      const b1 = end[second]!;
      const relativeStart = a0.positionM.map((value, axis) => value - b0.positionM[axis]!);
      const relativeDelta = a1.positionM.map((value, axis) => value - b1.positionM[axis]! - relativeStart[axis]!);
      const radius = a0.radiusM + b0.radiusM;
      const quadratic = relativeDelta.reduce((sum, value) => sum + value * value, 0);
      const linear = 2 * relativeStart.reduce((sum, value, axis) => sum + value * relativeDelta[axis]!, 0);
      const constant = relativeStart.reduce((sum, value) => sum + value * value, 0) - radius * radius;
      if (constant <= 0 || quadratic === 0) continue;
      const discriminant = linear * linear - 4 * quadratic * constant;
      if (discriminant < 0) continue;
      const fraction = (-linear - Math.sqrt(discriminant)) / (2 * quadratic);
      if (fraction < 0 || fraction > 1 || (earliest && fraction >= earliest.fraction)) continue;
      earliest = { first, second, fraction };
    }
  }
  return earliest;
}

export function mergeCollision(bodies: readonly CelestialBody[], firstIndex: number, secondIndex: number, settings: PhysicsSettings, swarmLedger = createEmptySwarmLedger()): CollisionResult {
  const first = bodies[firstIndex];
  const second = bodies[secondIndex];
  if (!first || !second || firstIndex === secondIndex) throw new SimulationError("INVALID_BODY", "Colisão inválida.");
  rejectExplicitSpin(first, second);
  rejectMaterialCollision(first, second);
  if (first.bodyType === "black-hole" || second.bodyType === "black-hole") {
    throw new SimulationError("UNSUPPORTED_COLLISION", "Colisão entre buracos negros não é suportada. A execução foi pausada no último estado aceito; edite posição/velocidade ou troque o cenário antes de retomar.");
  }

  const massKg = first.massKg + second.massKg;
  if (!Number.isFinite(massKg) || massKg > MAX_MASS_KG) throw new SimulationError("INVALID_BODY", "A fusão excederia o limite de massa da simulação.");
  const positionM = first.positionM.map((value, axis) => (first.massKg * value + second.massKg * second.positionM[axis]!) / massKg) as unknown as Vector3;
  const velocityMs = first.velocityMs.map((value, axis) => (first.massKg * value + second.massKg * second.velocityMs[axis]!) / massKg) as unknown as Vector3;
  let radiusM = Math.cbrt(first.radiusM ** 3 + second.radiusM ** 3);
  if (!Number.isFinite(radiusM) || radiusM > MAX_RADIUS_M) throw new SimulationError("INVALID_BODY", "A fusão excederia o limite de raio da simulação.");

  const relativeSpeedSquared = first.velocityMs.reduce((sum, value, axis) => sum + (value - second.velocityMs[axis]!) ** 2, 0);
  const energyJ = 0.5 * (first.massKg * second.massKg / massKg) * relativeSpeedSquared;
  if (!Number.isFinite(energyJ)) throw new SimulationError("NUMERIC_OVERFLOW", "A energia dissipada na colisão não é representável.");
  const relativeVelocity = first.velocityMs.map((value, axis) => value - second.velocityMs[axis]!) as unknown as Vector3;
  const relativePosition = first.positionM.map((value, axis) => value - second.positionM[axis]!) as unknown as Vector3;
  const distanceM = Math.hypot(...relativePosition);
  const normalM = distanceM > 0
    ? second.positionM.map((value, axis) => (value - first.positionM[axis]!) / distanceM) as unknown as Vector3
    : null;
  const pointM = normalM
    ? first.positionM.map((value, axis) => ((value + first.radiusM * normalM[axis]!)
      + (second.positionM[axis]! - second.radiusM * normalM[axis]!)) / 2) as unknown as Vector3
    : positionM;
  const radialDot = relativePosition.reduce((sum, value, axis) => sum + value * relativeVelocity[axis]!, 0);
  const cross = [
    relativePosition[1] * relativeVelocity[2] - relativePosition[2] * relativeVelocity[1],
    relativePosition[2] * relativeVelocity[0] - relativePosition[0] * relativeVelocity[2],
    relativePosition[0] * relativeVelocity[1] - relativePosition[1] * relativeVelocity[0],
  ];
  const relativeSpeedMps = Math.sqrt(relativeSpeedSquared);
  const impactAngleRad = Math.hypot(...relativePosition) > 0 && relativeSpeedMps > 0 && radialDot < 0
    ? Math.atan2(Math.hypot(...cross), -radialDot)
    : null;

  const survivor = first.massKg > second.massKg || first.massKg === second.massKg && first.id <= second.id ? first : second;
  const absorbed = survivor === first ? second : first;
  const inherited = { ...survivor };
  if (inherited.parentId === absorbed.id || inherited.parentId === survivor.id) delete inherited.parentId;
  const merged: CelestialBody = {
    ...inherited,
    name: `${survivor.name} + ${absorbed.name}`,
    massKg,
    radiusM,
    positionM,
    velocityMs,
    surfaceTemperatureK: first.thermalProfileId !== undefined && first.thermalProfileId === second.thermalProfileId
      ? (first.radiusM ** 2 * first.surfaceTemperatureK + second.radiusM ** 2 * second.surfaceTemperatureK) / radiusM ** 2
      : (first.massKg * first.surfaceTemperatureK + second.massKg * second.surfaceTemperatureK) / massKg,
    waterFraction: (first.massKg * first.waterFraction + second.massKg * second.waterFraction) / massKg,
  };
  delete merged.stellarEvolution;
  if (first.thermalProfileId !== second.thermalProfileId) delete merged.thermalProfileId;
  const mergedBody = combineWaterInventories(first, second, merged);
  if (first.materials && second.materials) {
    mergedBody.materials = {
      modelId: first.materials.modelId,
      rockKg: first.materials.rockKg + second.materials.rockKg,
      ironKg: first.materials.ironKg + second.materials.ironKg,
      gasKg: first.materials.gasKg + second.materials.gasKg,
    };
    if (first.atmosphere && second.atmosphere) {
      mergedBody.atmosphere = { ...first.atmosphere,
        dryGasMassKg: first.atmosphere.dryGasMassKg + second.atmosphere.dryGasMassKg,
        isothermalTemperatureK: (first.atmosphere.dryGasMassKg * first.atmosphere.isothermalTemperatureK
          + second.atmosphere.dryGasMassKg * second.atmosphere.isothermalTemperatureK)
          / (first.atmosphere.dryGasMassKg + second.atmosphere.dryGasMassKg) };
    }
    const retainedWaterKg = mergedBody.waterInventory
      ? mergedBody.waterInventory.liquidKg + mergedBody.waterInventory.iceKg + mergedBody.waterInventory.vaporKg : 0;
    const volumeM3 = materialCompositionVolumeM3(mergedBody.materials) + retainedWaterKg / 1_000;
    radiusM = Math.cbrt(3 * volumeM3 / (4 * Math.PI));
    mergedBody.radiusM = radiusM;
    mergedBody.massKg = mergedBody.materials.rockKg + mergedBody.materials.ironKg + mergedBody.materials.gasKg
      + (mergedBody.atmosphere?.dryGasMassKg ?? 0) + retainedWaterKg;
    if (mergedBody.waterInventory) {
      const dryMassKg = mergedBody.materials.rockKg + mergedBody.materials.ironKg + mergedBody.materials.gasKg
        + (mergedBody.atmosphere?.dryGasMassKg ?? 0);
      mergedBody.waterInventory = { ...mergedBody.waterInventory, dryMassKg,
        dryVolumeM3: materialCompositionVolumeM3(mergedBody.materials) };
    }
  }
  const candidate = bodies.filter((_, index) => index !== firstIndex && index !== secondIndex).map((body) =>
    body.parentId === absorbed.id ? { ...body, parentId: survivor.id } : body);
  candidate.splice(Math.min(firstIndex, secondIndex), 0, mergedBody);
  const swarmMerge = mergeSwarmShares(swarmLedger, [first.id, second.id], mergedBody, bodies);
  validateSwarmLedger(swarmMerge.ledger, candidate);
  validateSimulationState(candidate, settings);
  return {
    bodies: candidate,
    swarmLedger: swarmMerge.ledger,
    event: {
      type: "collision", positionM, radiusM: mergedBody.radiusM, energyJ, bodyIds: [first.id, second.id],
      energyLedger: collisionEnergyLedger(energyJ),
      contact: {
        pointM, normalM,
        relativeVelocityMs: second.velocityMs.map((value, axis) => value - first.velocityMs[axis]!) as unknown as Vector3,
      },
      collisionDiagnostics: {
        modelId: "perfectly-inelastic-merge-v1", relativeSpeedMps,
        specificImpactEnergyJkg: energyJ / massKg, impactAngleRad,
      },
      outcome: { kind: "perfectly-inelastic-merge", modelId: "perfectly-inelastic-merge-v1", survivorBodyId: survivor.id },
      ...(swarmMerge.transfers.length ? { swarmTransfers: swarmMerge.transfers } : {}),
    },
  };
}

export function resolveCreativeCollision(bodies: readonly CelestialBody[], firstIndex: number, secondIndex: number, settings: PhysicsSettings, swarmLedger = createEmptySwarmLedger()): CollisionResult {
  const merged = mergeCollision(bodies, firstIndex, secondIndex, settings, swarmLedger);
  const survivorId = merged.event.outcome?.kind === "perfectly-inelastic-merge" ? merged.event.outcome.survivorBodyId : undefined;
  const remnant = merged.bodies.find(({ id }) => id === survivorId);
  if (!survivorId || !remnant || merged.bodies.length + 5 > MAX_SIMULATION_BODIES) return merged;
  try {
    const source = { ...remnant, kind: "planet" as const, bodyType: "asteroid" as const };
    delete source.stellarEvolution;
    const availableEnergyJ = merged.event.energyJ;
    if (availableEnergyJ <= 0) return merged;
    const bindingEnergyJ = getExplosionEnergyPreview(source, settings).gravitationalBindingEnergyJ;
    if (availableEnergyJ <= bindingEnergyJ) return merged;
    const fragmentEnergyJ = availableEnergyJ - bindingEnergyJ;
    const candidate = createExplosionCandidate(merged.bodies.map((body) => body.id === survivorId ? source : body), settings,
      survivorId, (fragmentEnergyJ / source.massKg) * (1 - 1e-12));
    if (candidate.event?.type !== "explosion") return merged;
    const fragmentBodyIds = candidate.event.bodyIds.filter((id) => id !== survivorId);
    const fragments = candidate.bodies.filter(({ id }) => fragmentBodyIds.includes(id));
    const fragmentKineticEnergyJ = fragments.reduce((sum, fragment) => sum + 0.5 * fragment.massKg
      * fragment.velocityMs.reduce((speed, value, axis) => speed + (value - source.velocityMs[axis]!) ** 2, 0), 0);
    if (fragmentBodyIds.length !== 6 || !Number.isFinite(fragmentKineticEnergyJ) || fragmentKineticEnergyJ > fragmentEnergyJ) return merged;
    const event = { ...merged.event };
    delete event.collisionDiagnostics;
    const nextLedger = distributeSwarmShares(merged.swarmLedger ?? swarmLedger, survivorId, fragments, candidate.bodies);
    validateSwarmLedger(nextLedger, candidate.bodies);
    const fragmentTransfers = (merged.swarmLedger?.bodyMassShares[survivorId] ?? []).flatMap((share) => {
      let allocated = 0;
      return fragments.map((fragment, index) => {
        const massKg = index === fragments.length - 1
          ? share.massKg - allocated : share.massKg * fragment.massKg / source.massKg;
        allocated += massKg;
        return { swarmId: share.swarmId, fromBodyIds: [survivorId], toBodyId: fragment.id, massKg, availableMassKg: share.massKg };
      }).filter(({ massKg }) => massKg > 0);
    });
    return {
      bodies: candidate.bodies,
      swarmLedger: nextLedger,
      event: {
        ...event,
        energyJ: availableEnergyJ,
        energyLedger: collisionEnergyLedger(availableEnergyJ, fragmentKineticEnergyJ),
        ...(fragmentTransfers.length ? { swarmTransfers: [...(event.swarmTransfers ?? []), ...fragmentTransfers] } : {}),
        outcome: { kind: "creative-fragmentation", modelId: "creative-fragmentation-v1", fragmentBodyIds,
          availableEnergyJ, fragmentKineticEnergyJ, dissipatedEnergyJ: availableEnergyJ - fragmentKineticEnergyJ },
      },
    };
  } catch {
    return merged;
  }
}

export function creativeCaptureRadiusM(captor: CelestialBody, absorbed: CelestialBody, gravitationalConstant: number): number {
  const maxMassKg = Math.max(captor.massKg, absorbed.massKg);
  return Math.max(50 * schwarzschildRadius(captor.massKg), Math.sqrt(gravitationalConstant * maxMassKg / MAX_ACCELERATION_MS2));
}

export function findSweptBlackHoleCapture(start: readonly CelestialBody[], end: readonly CelestialBody[], gravitationalConstant: number): { captor: number; absorbed: number; fraction: number; captureRadiusM: number } | undefined {
  let earliest: { captor: number; absorbed: number; fraction: number; captureRadiusM: number } | undefined;
  for (let captor = 0; captor < start.length; captor += 1) {
    if (start[captor]!.bodyType !== "black-hole") continue;
    for (let absorbed = 0; absorbed < start.length; absorbed += 1) {
      if (absorbed === captor || start[absorbed]!.bodyType === "black-hole") continue;
      const radius = creativeCaptureRadiusM(start[captor]!, start[absorbed]!, gravitationalConstant);
      const a0 = start[captor]!, b0 = start[absorbed]!, a1 = end[captor]!, b1 = end[absorbed]!;
      const relativeStart = a0.positionM.map((value, axis) => value - b0.positionM[axis]!);
      const relativeDelta = a1.positionM.map((value, axis) => value - b1.positionM[axis]! - relativeStart[axis]!);
      const quadratic = relativeDelta.reduce((sum, value) => sum + value * value, 0);
      const linear = 2 * relativeStart.reduce((sum, value, axis) => sum + value * relativeDelta[axis]!, 0);
      const constant = relativeStart.reduce((sum, value) => sum + value * value, 0) - radius * radius;
      if (constant <= 0 || quadratic === 0) continue;
      const discriminant = linear * linear - 4 * quadratic * constant;
      if (discriminant < 0) continue;
      const fraction = (-linear - Math.sqrt(discriminant)) / (2 * quadratic);
      if (fraction >= 0 && fraction <= 1 && (!earliest || fraction < earliest.fraction)) earliest = { captor, absorbed, fraction, captureRadiusM: radius };
    }
  }
  return earliest;
}

export function captureBlackHole(bodies: readonly CelestialBody[], captorIndex: number, absorbedIndex: number,
  captureRadiusM: number, settings: PhysicsSettings, swarmLedger = createEmptySwarmLedger()): { bodies: CelestialBody[]; swarmLedger: SwarmLedger; event: Omit<SimulationEvent, "id" | "timeSeconds"> } {
  const captor = bodies[captorIndex], absorbed = bodies[absorbedIndex];
  if (!captor || !absorbed || captor.bodyType !== "black-hole" || absorbed.bodyType === "black-hole") {
    throw new SimulationError("INVALID_BODY", "Captura criativa de buraco negro inválida.");
  }
  rejectExplicitSpin(captor, absorbed);
  if (!captor.materials && absorbed.materials) {
    // A black hole consumes explicit material and remains a black hole; its mass is not lost.
  } else rejectMaterialCollision(captor, absorbed);
  const massKg = captor.massKg + absorbed.massKg;
  if (!Number.isFinite(massKg) || massKg > MAX_MASS_KG) throw new SimulationError("INVALID_BODY", "A acreção excederia o limite de massa.");
  const positionM = captor.positionM.map((value, axis) => (captor.massKg * value + absorbed.massKg * absorbed.positionM[axis]!) / massKg) as unknown as Vector3;
  const velocityMs = captor.velocityMs.map((value, axis) => (captor.massKg * value + absorbed.massKg * absorbed.velocityMs[axis]!) / massKg) as unknown as Vector3;
  const nextCaptor: CelestialBody = { ...captor, massKg, radiusM: schwarzschildRadius(massKg), positionM, velocityMs };
  delete nextCaptor.materials;
  delete nextCaptor.waterInventory;
  delete nextCaptor.atmosphere;
  delete nextCaptor.thermalProfileId;
  delete nextCaptor.surface;
  delete nextCaptor.stellarEvolution;
  const next = bodies.map((body, index) => index === captorIndex ? nextCaptor
    : body.parentId === absorbed.id ? { ...body, parentId: captor.id } : body).filter((_, index) => index !== absorbedIndex);
  const transfer = mergeSwarmShares(swarmLedger, [captor.id, absorbed.id], nextCaptor, bodies);
  validateSwarmLedger(transfer.ledger, next);
  validateSimulationState(next, settings);
  const eventPosition = positionM;
  return { bodies: next, swarmLedger: transfer.ledger, event: { type: "black-hole-capture", positionM: eventPosition, radiusM: nextCaptor.radiusM, energyJ: 0,
    bodyIds: [captor.id, absorbed.id], outcome: { kind: "creative-accretion", modelId: "creative-accretion-v1",
      captorBodyId: captor.id, absorbedBodyId: absorbed.id, captureRadiusM },
    ...(transfer.transfers.length ? { swarmTransfers: transfer.transfers } : {}) } };
}

function rejectExplicitSpin(first: CelestialBody, second: CelestialBody): void {
  if (!first.spin && !second.spin) return;
  throw new SimulationError("UNSUPPORTED_COLLISION", "Colisões/capturas com rotação física explícita aguardam um ledger de momento angular. A execução foi pausada no último estado aceito; ajuste posição/velocidade antes de retomar.");
}

function rejectMaterialCollision(first: CelestialBody, second: CelestialBody): void {
  if (first.materials && second.materials) {
    if (Boolean(first.atmosphere) !== Boolean(second.atmosphere)
      || first.atmosphere && second.atmosphere && first.atmosphere.profileId !== second.atmosphere.profileId) {
      throw new SimulationError("UNSUPPORTED_COLLISION", "A colisão exige o mesmo perfil atmosférico nos dois corpos. O último estado aceito foi mantido.");
    }
    return;
  }
  if (!first.materials && !second.materials) return;
  const adoption = Boolean(first.materials) !== Boolean(second.materials)
    ? " Adote composição T12 no corpo legacy antes de colidir após T13."
    : "";
  throw new SimulationError("UNSUPPORTED_COLLISION", `Colisões com composição T12 aguardam colisões composicionais de T13. A execução foi pausada no último estado aceito; ajuste posição/velocidade antes de retomar.${adoption}`);
}
