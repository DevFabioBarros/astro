import type { CelestialBody, SimulationEvent, SimulationSnapshot } from "@/simulation/types";

function isSimulationEvent(value: unknown): value is SimulationEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<SimulationEvent>;
  return Number.isSafeInteger(event.id) && event.id! >= 0
    && (event.type === "collision" || event.type === "explosion" || event.type === "black-hole-capture" || event.type === "impulse" || event.type === "laser")
    && Number.isFinite(event.timeSeconds) && event.timeSeconds! >= 0
    && Array.isArray(event.positionM) && event.positionM.length === 3 && event.positionM.every(Number.isFinite)
    && Number.isFinite(event.radiusM) && event.radiusM! > 0
    && Number.isFinite(event.energyJ) && event.energyJ! >= 0
    && Array.isArray(event.bodyIds) && event.bodyIds.length > 0 && event.bodyIds.every((id) => typeof id === "string")
    && (event.type !== "impulse" || event.impulse?.modelId === "center-of-mass-impulse-v1"
      && event.impulse.deltaVelocityMs.length === 3 && event.impulse.deltaVelocityMs.every(Number.isFinite)
      && event.impulse.impulseNs.length === 3 && event.impulse.impulseNs.every(Number.isFinite)
      && event.impulse.deltaVelocityMs.some((component) => component !== 0)
      && Number.isFinite(event.impulse.externalWorkJ) && event.energyJ === Math.abs(event.impulse.externalWorkJ)
      && event.bodyIds.length === 1)
    && (event.type !== "laser" || event.laser?.modelId === "laser-energy-ledger-v1"
      && event.laser.profileId === "grey-albedo-laser-absorption-v1"
      && event.laser.bodyLocalDirection.length === 3 && event.laser.bodyLocalDirection.every(Number.isFinite)
      && event.energyJ === event.laser.inputJ && event.bodyIds.length === 1)
    && (event.collisionDiagnostics === undefined || (event.type === "collision" && typeof event.collisionDiagnostics === "object" && event.collisionDiagnostics !== null && event.collisionDiagnostics.modelId === "perfectly-inelastic-merge-v1" && Number.isFinite(event.collisionDiagnostics.relativeSpeedMps) && event.collisionDiagnostics.relativeSpeedMps >= 0 && Number.isFinite(event.collisionDiagnostics.specificImpactEnergyJkg) && event.collisionDiagnostics.specificImpactEnergyJkg >= 0 && (event.collisionDiagnostics.impactAngleRad === null || Number.isFinite(event.collisionDiagnostics.impactAngleRad) && event.collisionDiagnostics.impactAngleRad >= 0 && event.collisionDiagnostics.impactAngleRad <= Math.PI / 2)))
    && (event.outcome === undefined || isValidOutcome(event.type, event.outcome));
}

function isValidOutcome(type: SimulationEvent["type"], value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value as Record<string, unknown>;
  if (type === "collision" && outcome.kind === "creative-fragmentation") return outcome.modelId === "creative-fragmentation-v1"
    && Array.isArray(outcome.fragmentBodyIds) && outcome.fragmentBodyIds.every((id) => typeof id === "string" && id.length > 0)
    && [outcome.availableEnergyJ, outcome.fragmentKineticEnergyJ, outcome.dissipatedEnergyJ].every((energy) => typeof energy === "number" && Number.isFinite(energy) && energy >= 0);
  if (type === "collision" && outcome.kind === "perfectly-inelastic-merge") return outcome.modelId === "perfectly-inelastic-merge-v1" && typeof outcome.survivorBodyId === "string" && outcome.survivorBodyId.length > 0;
  if (type === "black-hole-capture" && outcome.kind === "creative-accretion") return outcome.modelId === "creative-accretion-v1"
    && typeof outcome.captorBodyId === "string" && outcome.captorBodyId.length > 0
    && typeof outcome.absorbedBodyId === "string" && outcome.absorbedBodyId.length > 0
    && typeof outcome.captureRadiusM === "number" && Number.isFinite(outcome.captureRadiusM) && outcome.captureRadiusM > 0;
  return false;
}

export function findNewAuthoritativeEvents(snapshot: SimulationSnapshot, currentRevision: number, lastSeenId: number): SimulationEvent[] {
  if (!Number.isSafeInteger(snapshot.worldRevision) || snapshot.worldRevision! < currentRevision || !Array.isArray(snapshot.events)) return [];
  return snapshot.events.filter((event): event is SimulationEvent => isSimulationEvent(event) && event.id > lastSeenId).sort((a, b) => a.id - b.id);
}

export function chooseSurvivingBodyId(bodies: readonly CelestialBody[], selectedId: string, events: readonly SimulationEvent[] = []): string {
  if (bodies.some((body) => body.id === selectedId)) return selectedId;
  const lineage = new Set([selectedId]);
  for (const event of events) {
    const linkedIds = [...event.bodyIds, ...(event.outcome?.kind === "creative-fragmentation" ? event.outcome.fragmentBodyIds : [])];
    if (linkedIds.some((id) => lineage.has(id))) linkedIds.forEach((id) => lineage.add(id));
  }
  return bodies.find((body) => lineage.has(body.id))?.id ?? bodies[0]?.id ?? "";
}

export function describeSimulationEvent(event: SimulationEvent, bodies?: readonly CelestialBody[]): string {
  if (event.type === "laser") return "Feixe de laser aceito; ponto quente é visual e não altera a temperatura do astro.";
  if (event.type === "impulse") return "Impulso aplicado ao centro de massa.";
  if (event.type === "black-hole-capture") return "Captura criativa por buraco negro.";
  if (event.type === "explosion") return event.visualEffect === "stellar-gas-expansion" ? "Descarga criativa de gás; a estrela permanece intacta." : "Desintegração experimental.";
  if (event.outcome?.kind === "creative-fragmentation") return "Colisão criativa: fragmentação.";
  if (event.type === "collision") return "Colisão: fusão perfeitamente inelástica.";
  void bodies;
  return "Contato entre astros.";
}

export function describeCollisionDetails(event: SimulationEvent, bodies: readonly CelestialBody[] = []): [string, string][] | null {
  const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const scientific = new Intl.NumberFormat("pt-BR", { notation: "scientific", maximumSignificantDigits: 3 });
  const measure = (value: number) => Math.abs(value) >= 1_000_000 ? scientific.format(value) : number.format(value);
  if (event.type === "laser" && event.laser) return [
    ["Modelo", "Absorção por albedo cinzento (v1)"],
    ["Potência", `${measure(event.laser.powerW)} W`],
    ["Duração simulada", `${measure(event.laser.durationAcceptedSeconds)} s`],
    ["Energia de entrada", `${measure(event.laser.inputJ)} J`],
    ["Energia absorvida (sem T10)", `${measure(event.laser.absorbedJ)} J`],
    ["Energia refletida", `${measure(event.laser.reflectedJ)} J`],
  ];
  if (event.type === "impulse" && event.impulse) return [
    ["Modelo", "Impulso no centro de massa (v1)"],
    ["Variação de velocidade", `${event.impulse.deltaVelocityMs.map(measure).join(", ")} m/s`],
    ["Impulso", `${event.impulse.impulseNs.map(measure).join(", ")} N·s`],
    ["Trabalho externo assinado", `${measure(event.impulse.externalWorkJ)} J`],
  ];
  if (event.type === "black-hole-capture" && event.outcome?.kind === "creative-accretion") return [
    ["Modelo", "Acreção criativa (v1)"],
    ["Zona de captura criativa", `${measure(event.outcome.captureRadiusM)} m`],
    ["Horizonte do remanescente", `${measure(event.radiusM)} m`],
    ["Energia radiada", "0 J (não modelada)"],
  ];
  if (event.type === "collision" && event.outcome?.kind === "creative-fragmentation") {
    const extantIds = new Set(bodies.map(({ id }) => id));
    const extantCount = event.outcome.fragmentBodyIds.filter((id) => extantIds.has(id)).length;
    return [
      ["Modelo", "Fragmentação criativa (v1)"],
      ["Fragmentos presentes", `${extantCount} de ${event.outcome.fragmentBodyIds.length}`],
      ["Energia disponível", `${measure(event.outcome.availableEnergyJ)} J`],
      ["Energia cinética dos fragmentos", `${measure(event.outcome.fragmentKineticEnergyJ)} J`],
      ["Energia dissipada", `${measure(event.outcome.dissipatedEnergyJ)} J`],
    ];
  }
  const diagnostics = event.type === "collision" ? event.collisionDiagnostics : undefined;
  if (event.type === "collision" && event.outcome?.kind === "perfectly-inelastic-merge" && !diagnostics) return [
    ["Modelo", "Fusão perfeitamente inelástica (v1)"],
    ["Energia cinética relativa removida (não calor)", `${measure(event.energyJ)} J`],
  ];
  if (event.type !== "collision" || !diagnostics || typeof diagnostics !== "object" || diagnostics.modelId !== "perfectly-inelastic-merge-v1") return null;
  return [
    ["Modelo", "Fusão perfeitamente inelástica (v1)"],
    ["Velocidade relativa", `${measure(diagnostics.relativeSpeedMps)} m/s`],
    ["Energia específica do impacto (Q_R)", `${measure(diagnostics.specificImpactEnergyJkg)} J/kg`],
    ["Ângulo de impacto", diagnostics.impactAngleRad === null ? "Não informado" : `${number.format(diagnostics.impactAngleRad * 180 / Math.PI)}°`],
    ["Energia cinética relativa removida (não calor)", `${measure(event.energyJ)} J`],
  ];
}

export function shouldRestoreAcknowledgedControlFocus(activeElement: Element | null, actionElement: Element | null, documentFocused: boolean): boolean {
  return documentFocused && actionElement !== null && activeElement === actionElement;
}
