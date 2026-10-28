import type { CelestialBody, SimulationEvent } from "./types";

// shortcut: one active world per browser bundle; use scene-scoped state if concurrent worlds are added.
let activeDebrisBodyIds: ReadonlySet<string> = new Set();

export function debrisBodyIdsFromEvents(events: readonly SimulationEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "collision" && event.outcome?.kind === "creative-fragmentation") {
      for (const id of event.outcome.fragmentBodyIds) if (id.trim()) ids.add(id);
    } else if (event.type === "explosion" && event.visualEffect !== "stellar-gas-expansion") {
      for (const id of event.bodyIds.slice(1)) if (id.trim()) ids.add(id);
    }
  }
  return ids;
}

export function setActiveDebrisBodyIds(ids: ReadonlySet<string>): void {
  activeDebrisBodyIds = ids;
}

export function isDebrisBody(body: CelestialBody, acceptedIds: ReadonlySet<string> = activeDebrisBodyIds): boolean {
  return acceptedIds.has(body.id);
}
