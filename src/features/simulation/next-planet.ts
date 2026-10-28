/** Keeps imported IDs distinct from planets created during this session. */
export function nextAvailablePlanetNumber(bodies: readonly { id: string }[], start: number): number {
  const ids = new Set(bodies.map((body) => body.id));
  let count = start;
  while (ids.has(`planet-${count}`)) count += 1;
  return count;
}
