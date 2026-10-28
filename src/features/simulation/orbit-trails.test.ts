import { describe, expect, it } from "vitest";
import { acceptOrbitSnapshot, createOrbitTrailState, refreshOrbitTrailLine, updateOrbitTrails } from "./orbit-trails";
import * as THREE from "three";
import { toScenePosition } from "./scene-scale";
import { createSolarSystem } from "@/simulation/solar-system";

const bodies = createSolarSystem().filter((body) => ["sun", "earth", "moon"].includes(body.id));
const move = (id: string, x: number) => bodies.map((body) => body.id === id ? { ...body, positionM: [x, 0, 0] as const } : body);

describe("historical orbit trails", () => {
  it("stores only real snapshots spaced by simulated time and caps each body", () => {
    let state = updateOrbitTrails(createOrbitTrailState(), bodies, 0, 1, 0);
    state = updateOrbitTrails(state, bodies, 86_399, 1, 0);
    expect(state.trails.earth).toHaveLength(1);
    state = updateOrbitTrails(state, move("earth", 20), 86_400, 1, 0);
    expect(state.trails.earth?.map(({ timeSeconds, positionM }) => [timeSeconds, positionM[0]])).toEqual([[0, bodies[1]!.positionM[0]], [86_400, 20]]);
    for (let index = 2; index < 260; index += 1) state = updateOrbitTrails(state, move("earth", index), index * 86_400, 1, 0);
    expect(state.trails.earth).toHaveLength(256);
    expect(state.trails.earth?.at(-1)?.positionM[0]).toBe(259);
  });

  it("uses accepted lunar substeps to retain the 5-degree target without inventing positions", () => {
    const periodSeconds = 27.1208 * 86_400;
    const earth = bodies.find((body) => body.id === "earth")!;
    const actual = Array.from({ length: 720 }, (_, index) => {
      const angle = (index + 1) * Math.PI / 360;
      const offsetSeconds = periodSeconds * (index + 1) / 720;
      const positionM = [earth.positionM[0] + 3.84e8 * Math.cos(angle), earth.positionM[1] + 3.84e8 * Math.sin(angle), earth.positionM[2]] as const;
      return { offsetSeconds, bodies: [{ id: "earth", positionM: earth.positionM }, { id: "moon", positionM }] };
    });
    const batch = { version: 1 as const, startTimeSeconds: 0, endTimeSeconds: periodSeconds, samples: actual };
    const startBodies = bodies.map((body) => body.id === "moon" ? {
      ...body, positionM: [earth.positionM[0] + 3.84e8, earth.positionM[1], earth.positionM[2]] as const,
    } : body);
    const initial = updateOrbitTrails(createOrbitTrailState(), startBodies, 0, 1, 0);
    const finalMoonPosition = actual.at(-1)!.bodies[1]!.positionM;
    const result = updateOrbitTrails(initial, bodies.map((body) => body.id === "moon" ? {
      ...body, positionM: finalMoonPosition,
    } : body), periodSeconds, 1, 0, 6.6743e-11, batch);
    const retained = result.trails.moon!;
    const candidatePositions = new Set(actual.map(({ bodies: sampled }) => sampled[1]!.positionM.join(",")));

    expect(retained.length).toBeGreaterThanOrEqual(73);
    expect(retained.length).toBeLessThanOrEqual(74);
    expect(retained.slice(1).every(({ positionM }) => candidatePositions.has(positionM.join(",")))).toBe(true);
    expect(retained.at(-1)?.timeSeconds).toBe(periodSeconds);
  });

  it("keeps real contact and merged survivor positions across a mid-batch topology change", () => {
    const world = bodies.filter((body) => body.id === "sun" || body.id === "earth");
    const initial = updateOrbitTrails(createOrbitTrailState(), world, 0, 1, 0);
    const earth = world.find((body) => body.id === "earth")!;
    const sun = world.find((body) => body.id === "sun")!;
    const contactPosition = [sun.positionM[0] + 100, sun.positionM[1] + 50, sun.positionM[2]] as const;
    const mergedPosition = [sun.positionM[0] + 500, sun.positionM[1] + 250, sun.positionM[2]] as const;
    const updated = updateOrbitTrails(initial, [{ ...sun, positionM: mergedPosition }], 172_800, 1, 0, 6.6743e-11, {
      version: 1, startTimeSeconds: 0, endTimeSeconds: 172_800, samples: [
        { offsetSeconds: 86_400, bodies: [
          { id: "sun", positionM: contactPosition }, { id: "earth", positionM: earth.positionM },
        ] },
        { offsetSeconds: 129_600, bodies: [
          { id: "sun", positionM: mergedPosition },
        ] },
      ],
    });

    expect(updated.trails.sun?.map(({ timeSeconds, positionM }) => [timeSeconds, positionM])).toEqual([
      [0, sun.positionM], [86_400, contactPosition], [129_600, mergedPosition], [172_800, mergedPosition],
    ]);
    expect(updated.gaps.sun).toContain(86_400);
    expect(updated.trails).not.toHaveProperty("earth");
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial());
    refreshOrbitTrailLine(line, updated.trails.sun!, undefined, sun.positionM, updated.truncated.sun, updated.gaps.sun);
    expect(geometry.drawRange.count).toBe(4);
    const positions = geometry.getAttribute("position");
    expect(Math.abs(positions.getX(0) - positions.getX(1))).toBeGreaterThan(5e-8);
    const mergedSceneX = toScenePosition(mergedPosition, sun.positionM)[0];
    expect(positions.getX(2)).toBeCloseTo(mergedSceneX, 5);
    expect(positions.getX(3)).toBeCloseTo(mergedSceneX, 5);
    geometry.dispose();
    (line.material as THREE.Material).dispose();
  });

  it("breaks history when a batch begins after a topology change", () => {
    const world = bodies.filter((body) => body.id === "sun" || body.id === "earth");
    const initial = updateOrbitTrails(createOrbitTrailState(), world, 0, 1, 0);
    const sun = world.find((body) => body.id === "sun")!;
    const postMerge = [sun.positionM[0] + 900, sun.positionM[1], sun.positionM[2]] as const;
    const updated = updateOrbitTrails(initial, [{ ...sun, positionM: postMerge }], 2_000, 1, 0, 6.6743e-11, {
      version: 1, startTimeSeconds: 1_000, endTimeSeconds: 2_000, samples: [
        { offsetSeconds: 500, bodies: [{ id: "sun", positionM: postMerge }] },
      ],
    });

    expect(updated.trails.sun?.some(({ timeSeconds, positionM }) => timeSeconds === 1_500 && positionM.every((value, axis) => value === postMerge[axis]))).toBe(true);
    expect(updated.gaps.sun).toContain(0);
  });

  it("exposes truncation and gaps instead of connecting across omitted history", () => {
    const world = bodies.filter((body) => body.id === "sun" || body.id === "earth");
    const samples = Array.from({ length: 6 }, (_, index) => ({ offsetSeconds: (index + 1) * 1_000, bodies: [
      { id: "sun", positionM: world[0]!.positionM },
      { id: "earth", positionM: [world[1]!.positionM[0] + index * 1_000, world[1]!.positionM[1], world[1]!.positionM[2]] as const },
    ] }));
    const history = updateOrbitTrails(createOrbitTrailState(), world, 6_000, 1, 0, 6.6743e-11, {
      version: 1, startTimeSeconds: 0, endTimeSeconds: 6_000, truncated: true, samples,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial());
    refreshOrbitTrailLine(line, history.trails.earth!, undefined, [0, 0, 0], history.truncated.earth, history.gaps.earth);

    expect(history.truncated.earth).toContain(1_000);
    expect(history.gaps.earth).toContain(1_000);
    expect(line.geometry.drawRange.count).toBe(0);
    expect(line.geometry.getAttribute("position").count).toBeGreaterThanOrEqual(line.geometry.drawRange.count);
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  });

  it("expires gap and truncation markers with the 256-point history window", () => {
    const initialWorld = bodies.filter((body) => body.id === "sun" || body.id === "earth");
    let state = createOrbitTrailState();
    let endpoint = initialWorld;
    for (let index = 1; index <= 300; index += 1) {
      const timeSeconds = index * 1_000;
      state = updateOrbitTrails(state, endpoint, timeSeconds, 1, 0, 6.6743e-11, {
        version: 1, startTimeSeconds: timeSeconds - 1, endTimeSeconds: timeSeconds, truncated: true,
        samples: [{ offsetSeconds: 1, bodies: [...endpoint.map(({ id, positionM }) => ({ id, positionM })), { id: "removed", positionM: [0, 0, 0] }] }],
      });
      endpoint = endpoint.map((body) => body.id === "sun" ? { ...body, positionM: [body.positionM[0] + 1, body.positionM[1], body.positionM[2]] as const } : body);
    }

    for (const id of ["sun", "earth"]) {
      const oldest = state.trails[id]![0]!.timeSeconds;
      expect(state.trails[id]).toHaveLength(256);
      expect(state.gaps[id]!.length).toBeLessThanOrEqual(256);
      expect(state.truncated[id]!.length).toBeLessThanOrEqual(256);
      expect(state.gaps[id]!.every((time) => time >= oldest)).toBe(true);
      expect(state.truncated[id]!.every((time) => time >= oldest)).toBe(true);
    }
  });

  it("samples the real Moon preset more often than daily, invariant under system translation and boost", () => {
    const moon = bodies.find((body) => body.id === "moon")!;
    const translated = bodies.map((body) => ({
      ...body,
      positionM: body.positionM.map((value, axis) => value + [8e10, -3e10, 2e10][axis]!) as unknown as typeof body.positionM,
      velocityMs: body.velocityMs.map((value, axis) => value + [30000, -12000, 8000][axis]!) as unknown as typeof body.velocityMs,
    }));
    let actualState = updateOrbitTrails(createOrbitTrailState(), bodies, 0, 1, 0);
    let transformedState = updateOrbitTrails(createOrbitTrailState(), translated, 0, 1, 0);
    for (let hour = 1; hour <= 24; hour += 1) {
      const time = hour * 3600;
      const angle = time * 2 * Math.PI / (27.3 * 86_400);
      const snapshot = bodies.map((body) => body.id === "moon" ? {
        ...body, positionM: [moon.positionM[0] + 3.84e8 * (Math.cos(angle) - 1), moon.positionM[1] + 3.84e8 * Math.sin(angle), moon.positionM[2]] as const,
        velocityMs: [moon.velocityMs[0] - 1022 * Math.sin(angle), moon.velocityMs[1] + 1022 * (Math.cos(angle) - 1), moon.velocityMs[2]] as const,
      } : body);
      const shifted = snapshot.map((body) => ({ ...body,
        positionM: body.positionM.map((value, axis) => value + [8e10, -3e10, 2e10][axis]!) as unknown as typeof body.positionM,
        velocityMs: body.velocityMs.map((value, axis) => value + [30000, -12000, 8000][axis]!) as unknown as typeof body.velocityMs,
      }));
      actualState = updateOrbitTrails(actualState, snapshot, time, 1, 0);
      transformedState = updateOrbitTrails(transformedState, shifted, time, 1, 0);
    }
    expect(actualState.trails.moon!.length).toBeGreaterThan(1);
    expect(actualState.trails.moon![1]!.timeSeconds).toBeLessThan(86_400);
    expect(actualState.trails.moon!.map(({ timeSeconds }) => timeSeconds)).toEqual(transformedState.trails.moon!.map(({ timeSeconds }) => timeSeconds));
    actualState.trails.moon!.forEach(({ positionM }, index) => positionM.forEach((value, axis) => {
      expect(value).toBeCloseTo(transformedState.trails.moon![index]!.positionM[axis]! - [8e10, -3e10, 2e10][axis]!, 3);
    }));
  });

  it("reseeds a new world revision at the same time without joining old positions", () => {
    const old = updateOrbitTrails(createOrbitTrailState(), bodies, 10, 1, 0);
    const next = updateOrbitTrails(old, move("earth", 99), 10, 1, 1);
    expect(next.trails.earth).toHaveLength(1);
    expect(next.trails.earth?.[0]?.positionM).toEqual([99, 0, 0]);
  });

  it("drops removed bodies and rejects non-finite positions and times", () => {
    const initial = updateOrbitTrails(createOrbitTrailState(), bodies, 0, 1, 0);
    const invalid = bodies.map((body) => body.id === "earth" ? { ...body, positionM: [Infinity, 0, 0] as const } : body);
    const updated = updateOrbitTrails(initial, invalid, 86_400, 1, 0);
    expect(updated.trails.earth).toHaveLength(1);
    expect(updated.trails.moon).toHaveLength(2);
    const removed = updateOrbitTrails(initial, bodies.filter((body) => body.id !== "moon"), 86_400, 1, 0);
    expect(removed.trails).not.toHaveProperty("moon");
  });

  it("seeds a newly added body without adding samples for existing bodies", () => {
    const initial = updateOrbitTrails(createOrbitTrailState(), bodies, 0, 1, 0);
    const added = { ...bodies[1]!, id: "comet", positionM: [42, 0, 0] as const };
    const updated = updateOrbitTrails(initial, [...bodies, added], 1, 1, 0);
    expect(updated.trails.comet?.map(({ timeSeconds, positionM }) => [timeSeconds, positionM[0]])).toEqual([[1, 42]]);
    expect(updated.trails.earth).toHaveLength(1);
  });

  it("ignores rejected snapshots and advances generation only for accepted world revisions", () => {
    const accepted = { bodies, timeSeconds: 7, revision: 4, generation: 0 };
    expect(acceptOrbitSnapshot(accepted, { bodies: move("earth", 99), timeSeconds: 7, revision: 5 }, false)).toBe(accepted);
    expect(acceptOrbitSnapshot(accepted, { bodies: move("earth", 99), timeSeconds: 7, revision: 5 }, true)).toMatchObject({ timeSeconds: 7, revision: 5, generation: 1 });
    expect(acceptOrbitSnapshot(accepted, { bodies: move("earth", 99), timeSeconds: 8, revision: 4 }, true).generation).toBe(0);
  });

  it("accumulates accepted batches within one generation and drops them at revision boundaries", () => {
    const first = { version: 1 as const, startTimeSeconds: 0, endTimeSeconds: 2, samples: [
      { offsetSeconds: 1, bodies: [{ id: "moon", positionM: [1, 0, 0] as const }] },
      { offsetSeconds: 2, bodies: [{ id: "moon", positionM: [2, 0, 0] as const }] },
    ] };
    const second = { version: 1 as const, startTimeSeconds: 2, endTimeSeconds: 4, samples: [
      { offsetSeconds: 1, bodies: [{ id: "moon", positionM: [3, 0, 0] as const }] },
      { offsetSeconds: 2, bodies: [{ id: "moon", positionM: [4, 0, 0] as const }] },
    ] };
    const initial = { bodies, timeSeconds: 2, revision: 4, generation: 0 };
    const one = acceptOrbitSnapshot(initial, { ...initial, integrationSamples: first }, true);
    const two = acceptOrbitSnapshot(one, { ...initial, timeSeconds: 4, integrationSamples: second }, true);

    expect(two.integrationSamples?.samples.map(({ offsetSeconds }) => offsetSeconds)).toEqual([1, 2, 3, 4]);
    expect(acceptOrbitSnapshot(two, { ...initial, timeSeconds: 4, revision: 5, integrationSamples: second }, true)).not.toHaveProperty("integrationSamples");
  });

  it("clears history when an accepted solar age changes without a world revision", () => {
    const initial = bodies.map((body) => body.id === "sun"
      ? { ...body, stellarEvolution: { modelId: "mist-v1.2-solar-1msun-nonrotating" as const, modelVersion: "1.2" as const, ageYears: 4.58e9, accretedMassKg: 0, absorbedBodyIds: [], mode: "secular" as const } }
      : body);
    const snapshot = { bodies: initial, timeSeconds: 42, revision: 1, generation: 0 };
    const advanced = initial.map((body) => body.id === "sun" ? { ...body, stellarEvolution: { ...body.stellarEvolution!, ageYears: 6e9 } } : body);
    expect(acceptOrbitSnapshot(snapshot, { bodies: advanced, timeSeconds: 42, revision: 1 }, true).generation).toBe(1);
    expect(acceptOrbitSnapshot(snapshot, { bodies: initial, timeSeconds: 43, revision: 1 }, true).generation).toBe(0);
    expect(acceptOrbitSnapshot(snapshot, { bodies: advanced, timeSeconds: 42, revision: 1 }, false)).toBe(snapshot);
  });
});
