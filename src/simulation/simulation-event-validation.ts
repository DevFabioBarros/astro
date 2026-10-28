import { GREY_ALBEDO_LASER_PROFILE_ID, isNormalizedLaserDirection, MAX_LASER_DURATION_SECONDS, MAX_LASER_ENERGY_J, MAX_LASER_POWER_W } from "./laser-model";

const MAX_SWARM_TRANSFERS = 4096;
const MAX_SWARM_TRANSFER_SOURCES = 64;
const MAX_TRANSFER_ID_LENGTH = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function isEventVisualEffect(event: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(event, "visualEffect")) return true;
  const bodyIds = event.bodyIds;
  return event.type === "explosion" && event.visualEffect === "stellar-gas-expansion" && event.energyJ === 0
    && Array.isArray(bodyIds) && bodyIds.length === 1
    && typeof bodyIds[0] === "string" && !!bodyIds[0].trim();
}

function isCollisionDiagnostics(value: unknown): boolean {
  return isRecord(value) && value.modelId === "perfectly-inelastic-merge-v1"
    && typeof value.relativeSpeedMps === "number" && Number.isFinite(value.relativeSpeedMps) && value.relativeSpeedMps >= 0
    && typeof value.specificImpactEnergyJkg === "number" && Number.isFinite(value.specificImpactEnergyJkg) && value.specificImpactEnergyJkg >= 0
    && (value.impactAngleRad === null
      || typeof value.impactAngleRad === "number" && Number.isFinite(value.impactAngleRad)
        && value.impactAngleRad >= 0 && value.impactAngleRad <= Math.PI / 2);
}

function isCollisionEnergyLedger(value: unknown, event: Record<string, unknown>): boolean {
  if (!isRecord(value) || Array.isArray(value) || Reflect.ownKeys(value).length !== 3 || value.modelId !== "collision-energy-ledger-v1"
    || !isRecord(value.sources) || Array.isArray(value.sources) || Reflect.ownKeys(value.sources).length !== 2
    || !Object.hasOwn(value.sources, "externalJ") || !Object.hasOwn(value.sources, "relativeKineticJ")
    || !isRecord(value.allocations) || Array.isArray(value.allocations) || Reflect.ownKeys(value.allocations).length !== 3
    || !["fragmentKineticJ", "thermalJ", "unresolvedJ"].every((key) => Object.hasOwn(value.allocations, key))) return false;
  const { externalJ, relativeKineticJ } = value.sources;
  const { fragmentKineticJ, thermalJ, unresolvedJ } = value.allocations;
  const values = [externalJ, relativeKineticJ, fragmentKineticJ, thermalJ, unresolvedJ];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    || event.type !== "collision" || externalJ !== 0 || relativeKineticJ !== event.energyJ || thermalJ !== 0) return false;
  const expectedFragmentKinetic = isRecord(event.outcome) && event.outcome.kind === "creative-fragmentation"
    ? event.outcome.fragmentKineticEnergyJ : 0;
  if (fragmentKineticJ !== expectedFragmentKinetic || (fragmentKineticJ as number) > (relativeKineticJ as number)) return false;
  const sourceTotal = (externalJ as number) + (relativeKineticJ as number);
  const allocationTotal = (fragmentKineticJ as number) + (thermalJ as number) + (unresolvedJ as number);
  return Math.abs(sourceTotal - allocationTotal) <= Math.max(1, sourceTotal) * 1e-12
    && Math.abs((unresolvedJ as number) - ((relativeKineticJ as number) - (fragmentKineticJ as number))) <= Math.max(1, sourceTotal) * 1e-12;
}

function isCollisionContact(value: unknown): boolean {
  return isRecord(value) && isVector3(value.pointM)
    && (value.normalM === null || isVector3(value.normalM) && Math.abs(Math.hypot(...value.normalM) - 1) <= 1e-6)
    && isVector3(value.relativeVelocityMs);
}

function isCenterOfMassImpulse(value: unknown, event: Record<string, unknown>): boolean {
  if (!isRecord(value) || value.modelId !== "center-of-mass-impulse-v1"
    || !isVector3(value.deltaVelocityMs) || !isVector3(value.impulseNs)
    || !Number.isFinite(value.externalWorkJ)
    || event.energyJ !== Math.abs(value.externalWorkJ as number)
    || !Array.isArray(event.bodyIds) || event.bodyIds.length !== 1
    || event.outcome !== undefined || event.visualEffect !== undefined
    || event.contact !== undefined || event.collisionDiagnostics !== undefined) return false;
  return value.deltaVelocityMs.some((component) => component !== 0);
}

function isLaserEvent(value: unknown, event: Record<string, unknown>): boolean {
  if (!isRecord(value) || value.modelId !== "laser-energy-ledger-v1"
    || value.profileId !== GREY_ALBEDO_LASER_PROFILE_ID || !isNormalizedLaserDirection(value.bodyLocalDirection)
    || ![value.powerW, value.durationAcceptedSeconds, value.albedo, value.inputJ, value.absorbedJ, value.reflectedJ].every((item) => typeof item === "number" && Number.isFinite(item))
    || (value.powerW as number) <= 0 || (value.powerW as number) > MAX_LASER_POWER_W
    || (value.durationAcceptedSeconds as number) <= 0 || (value.durationAcceptedSeconds as number) > MAX_LASER_DURATION_SECONDS
    || (value.inputJ as number) <= 0 || (value.inputJ as number) > MAX_LASER_ENERGY_J
    || value.albedo !== 0.3 || value.inputJ !== (value.powerW as number) * (value.durationAcceptedSeconds as number)
    || value.inputJ !== (value.absorbedJ as number) + (value.reflectedJ as number)
    || value.absorbedJ !== (value.inputJ as number) * (1 - (value.albedo as number))
    || event.energyJ !== value.inputJ || !Array.isArray(event.bodyIds) || event.bodyIds.length !== 1
    || event.outcome !== undefined || event.visualEffect !== undefined || event.impulse !== undefined
    || event.contact !== undefined || event.collisionDiagnostics !== undefined) return false;
  return true;
}

function isSwarmTransfers(value: unknown, event: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(event, "swarmTransfers")) return true;
  if ((event.type !== "collision" && event.type !== "black-hole-capture") || !Array.isArray(value) || value.length > MAX_SWARM_TRANSFERS) return false;
  const participants = new Set(Array.isArray(event.bodyIds) ? event.bodyIds.filter((id): id is string => typeof id === "string") : []);
  const outcome = event.outcome;
  const fragments = isRecord(outcome) && outcome.kind === "creative-fragmentation" && Array.isArray(outcome.fragmentBodyIds)
    && outcome.fragmentBodyIds.length === 6
    && outcome.fragmentBodyIds.every((id) => typeof id === "string" && !!id.trim() && id.length <= MAX_TRANSFER_ID_LENGTH)
    && new Set(outcome.fragmentBodyIds).size === outcome.fragmentBodyIds.length ? outcome.fragmentBodyIds as string[] : [];
  const recipients = new Set([...participants, ...fragments]);
  const seenTransfers = new Set<string>();
  const transferredBySource = new Map<string, { availableMassKg: number; transferredMassKg: number }>();
  for (const transfer of value) {
    if (!isRecord(transfer) || Reflect.ownKeys(transfer).length !== 5
      || !["swarmId", "fromBodyIds", "toBodyId", "massKg", "availableMassKg"].every((key) => Reflect.ownKeys(transfer).includes(key))
      || typeof transfer.swarmId !== "string" || !transfer.swarmId.trim() || transfer.swarmId.length > MAX_TRANSFER_ID_LENGTH
      || typeof transfer.toBodyId !== "string" || !transfer.toBodyId.trim() || transfer.toBodyId.length > MAX_TRANSFER_ID_LENGTH
      || !recipients.has(transfer.toBodyId) || typeof transfer.massKg !== "number" || !Number.isFinite(transfer.massKg) || transfer.massKg <= 0
      || typeof transfer.availableMassKg !== "number" || !Number.isFinite(transfer.availableMassKg) || transfer.availableMassKg <= 0
      || transfer.massKg > transfer.availableMassKg + Math.max(1, transfer.availableMassKg) * 1e-10
      || !Array.isArray(transfer.fromBodyIds) || transfer.fromBodyIds.length !== 1 || transfer.fromBodyIds.length > MAX_SWARM_TRANSFER_SOURCES
      || transfer.fromBodyIds.some((id) => typeof id !== "string" || !id.trim() || id.length > MAX_TRANSFER_ID_LENGTH
        || id === transfer.toBodyId || !participants.has(id)) || new Set(transfer.fromBodyIds).size !== transfer.fromBodyIds.length) return false;
    const source = transfer.fromBodyIds[0] as string;
    const transferKey = `${transfer.swarmId}\u0000${source}\u0000${transfer.toBodyId}`;
    if (seenTransfers.has(transferKey)) return false;
    seenTransfers.add(transferKey);
    const sourceKey = `${transfer.swarmId}\u0000${source}`;
    const current = transferredBySource.get(sourceKey);
    if (current && current.availableMassKg !== transfer.availableMassKg) return false;
    const transferredMassKg = (current?.transferredMassKg ?? 0) + transfer.massKg;
    if (transferredMassKg > transfer.availableMassKg + Math.max(1, transfer.availableMassKg) * 1e-10) return false;
    transferredBySource.set(sourceKey, { availableMassKg: transfer.availableMassKg, transferredMassKg });
  }
  return true;
}

function isEventOutcome(type: unknown, value: unknown, energyJ: unknown, bodyIds: unknown): boolean {
  if (!isRecord(value)) return false;
  if (type === "collision" && value.kind === "creative-fragmentation") return value.modelId === "creative-fragmentation-v1"
    && Array.isArray(value.fragmentBodyIds) && value.fragmentBodyIds.length === 6
    && value.fragmentBodyIds.every((id) => typeof id === "string" && !!id.trim())
    && new Set(value.fragmentBodyIds).size === 6
    && [value.availableEnergyJ, value.fragmentKineticEnergyJ, value.dissipatedEnergyJ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    && value.availableEnergyJ === energyJ
    && (value.fragmentKineticEnergyJ as number) <= (value.availableEnergyJ as number)
    && Math.abs((value.availableEnergyJ as number) - (value.fragmentKineticEnergyJ as number) - (value.dissipatedEnergyJ as number))
      <= Math.max(1, value.availableEnergyJ as number) * 1e-12;
  if (type === "collision" && value.kind === "perfectly-inelastic-merge") return value.modelId === "perfectly-inelastic-merge-v1"
    && typeof value.survivorBodyId === "string" && !!value.survivorBodyId.trim()
    && Array.isArray(bodyIds) && bodyIds.includes(value.survivorBodyId);
  if (type === "black-hole-capture" && value.kind === "creative-accretion") return value.modelId === "creative-accretion-v1"
    && typeof value.captorBodyId === "string" && !!value.captorBodyId.trim()
    && typeof value.absorbedBodyId === "string" && !!value.absorbedBodyId.trim()
    && value.captorBodyId !== value.absorbedBodyId
    && Array.isArray(bodyIds) && bodyIds[0] === value.captorBodyId && bodyIds[1] === value.absorbedBodyId
    && typeof value.captureRadiusM === "number" && Number.isFinite(value.captureRadiusM) && value.captureRadiusM > 0;
  return false;
}

export function isValidSimulationEvent(value: unknown): boolean {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) < 1
    || !["collision", "explosion", "black-hole-capture", "impulse", "laser"].includes(value.type as string)
    || !Number.isFinite(value.timeSeconds) || (value.timeSeconds as number) < 0
    || !isVector3(value.positionM) || !Number.isFinite(value.radiusM) || (value.radiusM as number) <= 0
    || !Number.isFinite(value.energyJ) || (value.energyJ as number) < 0
    || value.type === "black-hole-capture" && (value.energyJ !== 0 || value.outcome === undefined)
    || value.type === "impulse" && !isCenterOfMassImpulse(value.impulse, value)
    || value.type !== "impulse" && value.impulse !== undefined
    || value.type === "laser" && !isLaserEvent(value.laser, value)
    || value.type !== "laser" && value.laser !== undefined
    || !isSwarmTransfers(value.swarmTransfers, value)
    || value.energyLedger !== undefined && !isCollisionEnergyLedger(value.energyLedger, value)
    || !isEventVisualEffect(value)
    || Object.prototype.hasOwnProperty.call(value, "contact") && (value.type !== "collision" || !isCollisionContact(value.contact))
    || value.collisionDiagnostics !== undefined && (value.type !== "collision" || !isCollisionDiagnostics(value.collisionDiagnostics))
    || value.outcome !== undefined && !isEventOutcome(value.type, value.outcome, value.energyJ, value.bodyIds)
    || !Array.isArray(value.bodyIds) || value.bodyIds.length < (value.visualEffect === "stellar-gas-expansion" || value.type === "impulse" || value.type === "laser" ? 1 : 2)
    || value.bodyIds.some((id) => typeof id !== "string" || !id.trim())) return false;
  return true;
}
