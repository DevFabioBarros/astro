import { MATERIAL_PROFILE_IDS } from "./material-profiles";
import type { CelestialBody, EnvironmentSeed, MaterialProfileId, SwarmGroup, SwarmLedger, SwarmMassShare, SwarmTransfer } from "./types";

export const PHYSICAL_SWARM_MODEL_ID = "physical-orbital-swarm-v1" as const;
export const SWARM_LEDGER_MODEL_ID = "physical-swarm-ledger-v1" as const;
export const MAX_SWARM_GROUPS = 64;
export const MAX_SWARM_LEDGER_BYTES = 256 * 1024;

export function createEmptySwarmLedger(): SwarmLedger {
  return { modelId: SWARM_LEDGER_MODEL_ID, nextSequence: 0, groups: [], bodyMassShares: {} };
}

export function deriveSwarmSeedV1(environmentSeed: EnvironmentSeed, sequence: number): number {
  let value = (environmentSeed ^ Math.imul(sequence + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

export function createSwarmLedger(
  bodies: readonly CelestialBody[],
  input: { environmentSeed: EnvironmentSeed; profileId: MaterialProfileId; nextSequence: number },
): SwarmLedger {
  if (!isSeed(input.environmentSeed) || !isProfile(input.profileId) || !Number.isSafeInteger(input.nextSequence)
    || input.nextSequence < 0 || input.nextSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("Parâmetros de enxame inválidos.");
  if (!bodies.length || bodies.length > 64 || bodies.some((body) => !body.id.trim() || !Number.isFinite(body.massKg) || body.massKg <= 0)
    || new Set(bodies.map(({ id }) => id)).size !== bodies.length) throw new RangeError("Representantes físicos inválidos.");
  if (input.nextSequence >= MAX_SWARM_GROUPS) throw new RangeError("O limite de 64 enxames foi atingido.");
  const initialMassKg = bodies.reduce((sum, body) => sum + body.massKg, 0);
  if (!Number.isFinite(initialMassKg) || initialMassKg <= 0) throw new RangeError("Massa total do enxame inválida.");
  return addSwarmGroup(createEmptySwarmLedger(), bodies, input);
}

export function addSwarmGroup(
  ledger: SwarmLedger, bodies: readonly CelestialBody[], input: { environmentSeed: EnvironmentSeed; profileId: MaterialProfileId },
): SwarmLedger {
  if (!isSeed(input.environmentSeed) || !isProfile(input.profileId) || ledger.nextSequence >= MAX_SWARM_GROUPS) {
    throw new RangeError("O limite ou perfil de enxame é inválido.");
  }
  const initialMassKg = bodies.reduce((sum, body) => sum + body.massKg, 0);
  if (!bodies.length || !Number.isFinite(initialMassKg) || initialMassKg <= 0) throw new RangeError("Massa total do enxame inválida.");
  const sequence = ledger.nextSequence;
  const id = `orbital-swarm-${sequence + 1}`;
  if (ledger.groups.some((group) => group.id === id) || bodies.some((body) => ledger.bodyMassShares[body.id])) {
    throw new RangeError("ID do grupo ou atribuição de massa duplicada.");
  }
  const group: SwarmGroup = {
    id, modelId: PHYSICAL_SWARM_MODEL_ID, seed: deriveSwarmSeedV1(input.environmentSeed, sequence),
    profileId: input.profileId, initialMassKg, externalMassInKg: 0, externalMassOutKg: 0, retiredMassKg: 0,
  };
  const bodyMassShares = { ...ledger.bodyMassShares,
    ...Object.fromEntries(bodies.map((body) => [body.id, [{ swarmId: id, massKg: body.massKg }]])) };
  const next = { ...ledger, nextSequence: sequence + 1, groups: [...ledger.groups, group], bodyMassShares };
  return next;
}

export function mergeSwarmShares(
  ledger: SwarmLedger,
  fromBodyIds: readonly string[],
  mergedBody: CelestialBody,
  inputBodies: readonly CelestialBody[],
): { ledger: SwarmLedger; transfers: SwarmTransfer[] } {
  const bodiesById = new Map(inputBodies.map((body) => [body.id, body]));
  const inputMassKg = fromBodyIds.reduce((sum, id) => {
    const body = bodiesById.get(id);
    if (!body) throw new RangeError("Corpo de origem do merge ausente.");
    return sum + body.massKg;
  }, 0);
  const massBySwarm = new Map<string, number>();
  const originalMassBySwarmAndBody = new Map<string, number>();
  for (const id of fromBodyIds) {
    for (const share of ledger.bodyMassShares[id] ?? []) {
      massBySwarm.set(share.swarmId, (massBySwarm.get(share.swarmId) ?? 0) + share.massKg);
      originalMassBySwarmAndBody.set(`${share.swarmId}\u0000${id}`, share.massKg);
    }
  }
  if (!massBySwarm.size) return { ledger, transfers: [] };
  const trackedMassKg = [...massBySwarm.values()].reduce((sum, mass) => sum + mass, 0);
  const missingMassKg = mergedBody.massKg - trackedMassKg;
  if (!Number.isFinite(missingMassKg) || Math.abs(mergedBody.massKg - inputMassKg) > massTolerance(inputMassKg)
    || missingMassKg < -massTolerance(mergedBody.massKg)) throw new RangeError("Ledger do enxame excede a massa do remanescente.");
  const groupIds = [...massBySwarm.keys()].sort();
  const totalWeight = trackedMassKg;
  const originalGroupMass = new Map(massBySwarm);
  const addedByGroup = new Map<string, number>();
  let remaining = Math.max(0, missingMassKg);
  for (let index = 0; index < groupIds.length; index += 1) {
    const swarmId = groupIds[index]!;
    const added = index === groupIds.length - 1 ? remaining : Math.max(0, missingMassKg) * massBySwarm.get(swarmId)! / totalWeight;
    addedByGroup.set(swarmId, added);
    massBySwarm.set(swarmId, massBySwarm.get(swarmId)! + added);
    remaining -= added;
  }
  const groupById = new Map(ledger.groups.map((group) => {
    const change = addedByGroup.get(group.id) ?? 0;
    return [group.id, { ...group, externalMassInKg: group.externalMassInKg + change }];
  }));
  const shares: SwarmMassShare[] = groupIds.map((swarmId) => ({ swarmId, massKg: massBySwarm.get(swarmId)! }));
  const bodyMassShares = { ...ledger.bodyMassShares };
  for (const id of fromBodyIds) delete bodyMassShares[id];
  bodyMassShares[mergedBody.id] = shares;
  const transfers: SwarmTransfer[] = [];
  for (const id of fromBodyIds) {
    if (id === mergedBody.id) continue;
    for (const swarmId of groupIds) {
      const massKg = originalMassBySwarmAndBody.get(`${swarmId}\u0000${id}`) ?? 0;
      if (massKg > 0) transfers.push({ swarmId, fromBodyIds: [id], toBodyId: mergedBody.id, massKg, availableMassKg: massKg });
    }
    if (!(ledger.bodyMassShares[id]?.length)) {
      const body = bodiesById.get(id)!;
      for (const swarmId of groupIds) {
        const massKg = body.massKg * originalGroupMass.get(swarmId)! / trackedMassKg;
        if (massKg > 0) transfers.push({ swarmId, fromBodyIds: [id], toBodyId: mergedBody.id, massKg, availableMassKg: massKg });
      }
    }
  }
  const next = { ...ledger, groups: [...groupById.values()], bodyMassShares };
  const resultingBodies = inputBodies.filter((body) => !fromBodyIds.includes(body.id)).concat(mergedBody);
  validateSwarmLedger(next, resultingBodies);
  return { ledger: next, transfers };
}

export function distributeSwarmShares(ledger: SwarmLedger, sourceBodyId: string, fragments: readonly CelestialBody[], resultingBodies: readonly CelestialBody[] = fragments): SwarmLedger {
  const sourceShares = ledger.bodyMassShares[sourceBodyId];
  if (!sourceShares?.length) return ledger;
  const totalMassKg = fragments.reduce((sum, body) => sum + body.massKg, 0);
  if (!fragments.length || !Number.isFinite(totalMassKg) || totalMassKg <= 0) throw new RangeError("Fragmentos do enxame inválidos.");
  const nextShares: Record<string, SwarmMassShare[]> = { ...ledger.bodyMassShares };
  delete nextShares[sourceBodyId];
  for (const share of sourceShares) {
    let allocated = 0;
    fragments.forEach((fragment, index) => {
      const massKg = index === fragments.length - 1 ? share.massKg - allocated : share.massKg * fragment.massKg / totalMassKg;
      allocated += massKg;
      nextShares[fragment.id] = [...(nextShares[fragment.id] ?? []), { swarmId: share.swarmId, massKg }];
    });
  }
  const next = { ...ledger, bodyMassShares: nextShares };
  validateSwarmLedger(next, resultingBodies);
  return next;
}

export function retireSwarmBodies(ledger: SwarmLedger, bodyIds: readonly string[]): SwarmLedger {
  const removed = new Map<string, number>();
  const bodyMassShares = { ...ledger.bodyMassShares };
  for (const id of bodyIds) {
    for (const share of bodyMassShares[id] ?? []) removed.set(share.swarmId, (removed.get(share.swarmId) ?? 0) + share.massKg);
    delete bodyMassShares[id];
  }
  const groups = ledger.groups.map((group) => ({ ...group, retiredMassKg: group.retiredMassKg + (removed.get(group.id) ?? 0) }));
  return { ...ledger, groups, bodyMassShares };
}

export function rescaleSwarmBody(ledger: SwarmLedger, bodyId: string, previousMassKg: number, nextMassKg: number): SwarmLedger {
  const shares = ledger.bodyMassShares[bodyId];
  if (!shares?.length || !Number.isFinite(previousMassKg) || previousMassKg <= 0 || !Number.isFinite(nextMassKg) || nextMassKg <= 0) return ledger;
  let allocated = 0;
  const nextShares = shares.map((share, index) => {
    const massKg = index === shares.length - 1 ? nextMassKg - allocated : nextMassKg * share.massKg / previousMassKg;
    allocated += massKg;
    return { ...share, massKg };
  });
  const delta = nextMassKg - previousMassKg;
  const groups = ledger.groups.map((group) => {
    const share = shares.find(({ swarmId }) => swarmId === group.id);
    if (!share) return group;
    const change = delta * share.massKg / previousMassKg;
    return change >= 0
      ? { ...group, externalMassInKg: group.externalMassInKg + change }
      : { ...group, externalMassOutKg: group.externalMassOutKg - change };
  });
  return { ...ledger, groups, bodyMassShares: { ...ledger.bodyMassShares, [bodyId]: nextShares } };
}

export function duplicateSwarmBody(ledger: SwarmLedger, sourceBodyId: string, duplicate: CelestialBody): SwarmLedger {
  const shares = ledger.bodyMassShares[sourceBodyId];
  if (!shares?.length) return ledger;
  const allocated = shares.map((share, index) => ({ ...share, massKg: index === shares.length - 1
    ? duplicate.massKg - shares.slice(0, -1).reduce((sum, item) => sum + duplicate.massKg * item.massKg / ledgerBodyShareMass(shares), 0)
    : duplicate.massKg * share.massKg / ledgerBodyShareMass(shares) }));
  const groups = ledger.groups.map((group) => {
    const added = allocated.find(({ swarmId }) => swarmId === group.id)?.massKg ?? 0;
    return { ...group, externalMassInKg: group.externalMassInKg + added };
  });
  return { ...ledger, groups, bodyMassShares: { ...ledger.bodyMassShares, [duplicate.id]: allocated } };
}

export function reconcileSwarmLedger(ledger: SwarmLedger, previousBodies: readonly CelestialBody[], nextBodies: readonly CelestialBody[]): SwarmLedger {
  const nextIds = new Set(nextBodies.map(({ id }) => id));
  let next = retireSwarmBodies(ledger, Object.keys(ledger.bodyMassShares).filter((id) => !nextIds.has(id)));
  const previousById = new Map(previousBodies.map((body) => [body.id, body]));
  for (const body of nextBodies) {
    const previous = previousById.get(body.id);
    if (previous && previous.massKg !== body.massKg) next = rescaleSwarmBody(next, body.id, previous.massKg, body.massKg);
  }
  validateSwarmLedger(next, nextBodies);
  return next;
}

export function validateSwarmLedger(value: unknown, bodies: readonly CelestialBody[]): asserts value is SwarmLedger {
  validateSwarmLedgerStructure(value);
  const bodyById = new Map(bodies.map((body) => [body.id, body]));
  const groupById = new Map<string, SwarmGroup>();
  for (const group of value.groups) {
    if (!isRecord(group) || !hasExactKeys(group, ["id", "modelId", "seed", "profileId", "initialMassKg", "externalMassInKg", "externalMassOutKg", "retiredMassKg"])
      || typeof group.id !== "string" || !group.id.trim() || group.id.length > 96 || groupById.has(group.id)
      || group.modelId !== PHYSICAL_SWARM_MODEL_ID || !isSeed(group.seed) || !isProfile(group.profileId)
      || !Number.isFinite(group.initialMassKg) || (group.initialMassKg as number) <= 0
      || ![group.externalMassInKg, group.externalMassOutKg, group.retiredMassKg].every((mass) => typeof mass === "number" && Number.isFinite(mass) && mass >= 0)) {
      throw new RangeError("Registro de enxame inválido.");
    }
    groupById.set(group.id, group as unknown as SwarmGroup);
  }
  const activeMass = new Map<string, number>();
  for (const [bodyId, rawShares] of Object.entries(value.bodyMassShares)) {
    const body = bodyById.get(bodyId);
    if (!body || !Array.isArray(rawShares) || rawShares.length === 0 || rawShares.length > MAX_SWARM_GROUPS) throw new RangeError("Atribuição de massa do enxame inválida.");
    const seenGroups = new Set<string>();
    let totalBodyShareKg = 0;
    for (const rawShare of rawShares) {
      if (!isRecord(rawShare) || !hasExactKeys(rawShare, ["swarmId", "massKg"]) || typeof rawShare.swarmId !== "string"
        || !groupById.has(rawShare.swarmId) || seenGroups.has(rawShare.swarmId) || !Number.isFinite(rawShare.massKg) || (rawShare.massKg as number) <= 0) {
        throw new RangeError("Atribuição de massa do enxame inválida.");
      }
      seenGroups.add(rawShare.swarmId);
      totalBodyShareKg += rawShare.massKg as number;
      activeMass.set(rawShare.swarmId, (activeMass.get(rawShare.swarmId) ?? 0) + (rawShare.massKg as number));
    }
    if (Math.abs(totalBodyShareKg - body.massKg) > massTolerance(body.massKg)) throw new RangeError("Atribuições do enxame devem somar a massa gravitante do corpo.");
  }
  for (const group of value.groups as SwarmGroup[]) {
    const active = activeMass.get(group.id) ?? 0;
    const source = group.initialMassKg + group.externalMassInKg;
    const accounted = active + group.externalMassOutKg + group.retiredMassKg;
    if (Math.abs(source - accounted) > massTolerance(source)) throw new RangeError("Ledger de massa do enxame não fecha.");
  }
  const text = new TextEncoder().encode(JSON.stringify(value));
  if (text.byteLength > MAX_SWARM_LEDGER_BYTES) throw new RangeError("Ledger do enxame excede 256 KiB.");
}

export function validateSwarmLedgerStructure(value: unknown): asserts value is SwarmLedger {
  if (!isRecord(value) || !hasExactKeys(value, ["modelId", "nextSequence", "groups", "bodyMassShares"])
    || value.modelId !== SWARM_LEDGER_MODEL_ID || !Number.isSafeInteger(value.nextSequence) || (value.nextSequence as number) < 0
    || (value.nextSequence as number) > MAX_SWARM_GROUPS || !Array.isArray(value.groups) || value.groups.length > MAX_SWARM_GROUPS
    || !isRecord(value.bodyMassShares) || Object.keys(value.bodyMassShares).length > 64) throw new RangeError("Ledger de enxame inválido.");
  const groupIds = new Set<string>();
  for (const group of value.groups) {
    if (!isRecord(group) || !hasExactKeys(group, ["id", "modelId", "seed", "profileId", "initialMassKg", "externalMassInKg", "externalMassOutKg", "retiredMassKg"])
      || typeof group.id !== "string" || !group.id.trim() || group.id.length > 96 || groupIds.has(group.id)
      || group.modelId !== PHYSICAL_SWARM_MODEL_ID || !isSeed(group.seed) || !isProfile(group.profileId)
      || !Number.isFinite(group.initialMassKg) || (group.initialMassKg as number) <= 0
      || ![group.externalMassInKg, group.externalMassOutKg, group.retiredMassKg].every((mass) => typeof mass === "number" && Number.isFinite(mass) && mass >= 0)) {
      throw new RangeError("Registro de enxame inválido.");
    }
    groupIds.add(group.id as string);
  }
  for (const [bodyId, rawShares] of Object.entries(value.bodyMassShares)) {
    if (!bodyId.trim() || bodyId.length > 128 || !Array.isArray(rawShares) || rawShares.length === 0 || rawShares.length > MAX_SWARM_GROUPS) throw new RangeError("Atribuição de massa do enxame inválida.");
    const seenGroups = new Set<string>();
    for (const rawShare of rawShares) {
      if (!isRecord(rawShare) || !hasExactKeys(rawShare, ["swarmId", "massKg"]) || typeof rawShare.swarmId !== "string"
        || !groupIds.has(rawShare.swarmId) || seenGroups.has(rawShare.swarmId) || !Number.isFinite(rawShare.massKg) || (rawShare.massKg as number) <= 0) throw new RangeError("Atribuição de massa do enxame inválida.");
      seenGroups.add(rawShare.swarmId);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SWARM_LEDGER_BYTES) throw new RangeError("Ledger do enxame excede 256 KiB.");
}

function isSeed(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff; }
function isProfile(value: unknown): value is MaterialProfileId { return typeof value === "string" && (MATERIAL_PROFILE_IDS as readonly string[]).includes(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function massTolerance(massKg: number): number { return Math.max(1, Math.abs(massKg)) * 1e-10; }
function ledgerBodyShareMass(shares: readonly SwarmMassShare[]): number { return shares.reduce((sum, share) => sum + share.massKg, 0); }
