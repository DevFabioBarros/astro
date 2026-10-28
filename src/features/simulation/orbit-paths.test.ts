import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { calculateOrbit, createOrbitPaths, interpolateOrbitBodies, refreshOrbitPaths, setOrbitPathOccluders, updateOrbitPathOcclusion } from "./orbit-paths";
import { createSolarSystem } from "@/simulation/solar-system";
import { setActiveDebrisBodyIds } from "@/simulation/body-identity";
import { toOverviewScenePosition } from "./scene-scale";

afterEach(() => setActiveDebrisBodyIds(new Set()));

describe("osculating physical orbits", () => {
  it("moves the orphaned Moon guide to the Sun after Earth disappears", () => {
    const bodies = createSolarSystem();
    const initial = createOrbitPaths(bodies, 6.6743e-11, [0, 0, 0]);
    expect(initial.getObjectByName("moon")?.userData.primaryId).toBe("earth");
    const orphaned = createOrbitPaths(bodies.filter((body) => body.id !== "earth"), 6.6743e-11, [0, 0, 0]);
    expect(orphaned.getObjectByName("moon")?.userData.primaryId).toBe("sun");
  });
  it("draws moon orbits without a luminous star and handles an empty world", () => {
    const bodies = createSolarSystem().filter((body) => body.id === "earth" || body.id === "moon");
    expect(createOrbitPaths(bodies, 6.6743e-11, [0, 0, 0]).getObjectByName("moon")?.userData.primaryId).toBe("earth");
    expect(createOrbitPaths([], 6.6743e-11, [0, 0, 0]).children).toHaveLength(0);
  });
  it("derives a circular orbit in the actual velocity plane", () => {
    const bodies = createSolarSystem();
    const sun = bodies.find((body) => body.id === "sun")!;
    const earth = bodies.find((body) => body.id === "earth")!;
    const primary = { ...sun!, massKg: 1e30, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const };
    const body = { ...earth!, massKg: 1, positionM: [1e10, 0, 0] as const, velocityMs: [0, 0, Math.sqrt(6.6743e-11 * primary.massKg / 1e10)] as const };
    const points = calculateOrbit(body, primary, 6.6743e-11);
    expect(points).toHaveLength(257);
    for (const point of points) {
      expect(Math.hypot(...point)).toBeCloseTo(1e10, 3);
      expect(point[1]).toBe(0);
    }
  });
  it("draws complete bound guides as continuous lines and leaves unbound guides open", () => {
    const bodies = createSolarSystem();
    const sun = bodies.find((body) => body.id === "sun")!;
    const earth = bodies.find((body) => body.id === "earth")!;
    const primary = { ...sun!, massKg: 1e30, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const };
    const circular = { ...earth!, massKg: 1, positionM: [1e10, 0, 0] as const, velocityMs: [0, Math.sqrt(6.6743e-11 * primary.massKg / 1e10), 0] as const };
    const ellipse = createOrbitPaths([primary, circular], 6.6743e-11, [0, 0, 0]).getObjectByName("earth") as THREE.Line;
    expect(ellipse.material).toBeInstanceOf(THREE.LineBasicMaterial);
    const ellipseVertices = ellipse.geometry.getAttribute("position");
    expect(new THREE.Vector3().fromBufferAttribute(ellipseVertices, 0).distanceTo(new THREE.Vector3().fromBufferAttribute(ellipseVertices, ellipseVertices.count - 1))).toBeLessThan(1e-5);
    const escapeSpeed = Math.sqrt(2 * 6.6743e-11 * primary.massKg / 1e10);
    const hyperbolic = { ...circular, velocityMs: [0, escapeSpeed * 1.5, 0] as const };
    const openPath = calculateOrbit(hyperbolic, primary, 6.6743e-11);
    expect(openPath.length).toBeGreaterThan(2);
    expect(openPath[0]).not.toEqual(openPath.at(-1));
  });
  it("produces bounded solar and lunar paths from reference velocities", () => {
    const bodies = createSolarSystem(), sun = bodies.find((body) => body.id === "sun")!, earth = bodies.find((body) => body.id === "earth")!, moon = bodies.find((body) => body.id === "moon")!;
    const earthPath = calculateOrbit(earth, sun, 6.6743e-11);
    expect(earthPath.length).toBeGreaterThan(200);
    const moonPath = calculateOrbit(moon, earth, 6.6743e-11);
    expect(moonPath.every((point) => Math.hypot(point[0] - earth.positionM[0], point[1] - earth.positionM[1], point[2] - earth.positionM[2]) < 5e8)).toBe(true);
    expect(calculateOrbit(earth, sun, 0)).toEqual([]);
  });
  it("updates a snapshot in place without replacing orbit geometry or material", () => {
    const bodies = createSolarSystem();
    const group = createOrbitPaths(bodies, 6.6743e-11, [0, 0, 0]);
    const earthPath = group.getObjectByName("earth") as THREE.Line;
    const geometry = earthPath.geometry;
    const position = geometry.getAttribute("position");
    const firstX = position.getX(0);
    const material = earthPath.material;
    expect(material).toBeInstanceOf(THREE.LineBasicMaterial);
    expect((material as THREE.LineBasicMaterial).opacity).toBeCloseTo(0.26);
    const boundingRadius = geometry.boundingSphere!.radius;
    const updated = bodies.map((body) => body.id === "earth" ? {
      ...body,
      positionM: [body.positionM[0] * 0.98, body.positionM[1] * 0.98, body.positionM[2]] as const,
    } : body);

    expect(refreshOrbitPaths(group, updated, 6.6743e-11, [0, 0, 0])).toBe(true);
    expect(group.getObjectByName("earth")).toBe(earthPath);
    expect(earthPath.geometry).toBe(geometry);
    expect(geometry.getAttribute("position")).toBe(position);
    expect(earthPath.material).toBe(material);
    expect(position.getX(0)).not.toBe(firstX);
    expect(geometry.boundingSphere!.radius).not.toBe(boundingRadius);
  });
  it("maps orbit vertices with the same radial projection as overview bodies", () => {
    const bodies = createSolarSystem(), origin = bodies.find((body) => body.id === "sun")!.positionM;
    const mapper = (position: readonly number[]) => new THREE.Vector3(...toOverviewScenePosition(position as [number, number, number], origin, origin, 1));
    const group = createOrbitPaths(bodies, 6.6743e-11, origin, undefined, mapper);
    const earth = bodies.find((body) => body.id === "earth")!, primary = bodies.find((body) => body.id === "sun")!;
    const path = calculateOrbit(earth, primary, 6.6743e-11);
    const line = group.getObjectByName("earth") as THREE.Line;
    const first = new THREE.Vector3().fromBufferAttribute(line.geometry.getAttribute("position"), 0).add(line.position);
    expect(first.distanceTo(mapper(path[0]!))).toBeLessThan(1e-8);

    const physicalMapper = (position: readonly number[]) => new THREE.Vector3().fromArray(position.map((value, axis) => (value - origin[axis]!) * 1e-9));
    expect(refreshOrbitPaths(group, bodies, 6.6743e-11, origin, undefined, physicalMapper)).toBe(true);
    const restored = new THREE.Vector3().fromBufferAttribute(line.geometry.getAttribute("position"), 0).add(line.position);
    expect(restored.distanceTo(physicalMapper(path[0]!))).toBeLessThan(1e-8);
    group.traverse((object) => { if (object instanceof THREE.Line) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
  });

  it("fades projected path fragments across body disks and keeps depth occlusion enabled", () => {
    const bodies = createSolarSystem();
    const group = createOrbitPaths(bodies, 6.6743e-11, [0, 0, 0]);
    const line = group.getObjectByName("earth") as THREE.Line;
    const material = line.material as THREE.LineBasicMaterial;
    expect(material.depthTest).toBe(true);
    expect(material.onBeforeCompile).toBeTypeOf("function");
    setOrbitPathOccluders(group, [{ x: 300, y: 200, radius: 40 }]);
    expect(line.userData.occlusionUniforms.uOccluderCount.value).toBe(1);
    expect(line.userData.occlusionUniforms.uOccluders.value[0].toArray()).toEqual([300, 200, 40, 0]);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 1.5); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const body = new THREE.Group(); body.scale.setScalar(1); body.updateMatrixWorld();
    updateOrbitPathOcclusion(group, camera, new Map([["body", { group: body }]]), 100, 100, 2);
    expect(line.userData.occlusionUniforms.uOccluders.value[0]!.x).toBe(50);
    expect(line.userData.occlusionUniforms.uOccluders.value[0]!.y).toBe(50);
    const expectedRadius = 1 / Math.sqrt(1.5 ** 2 - 1) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 50 + 2;
    expect(line.userData.occlusionUniforms.uOccluders.value[0]!.z).toBeCloseTo(expectedRadius);
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    material.onBeforeCompile!(shader as never, {} as never);
    expect(shader.fragmentShader).toContain("uOccluderCount");
    expect(shader.fragmentShader).toContain("gl_FragCoord.xy");
    expect(shader.fragmentShader).toContain("discard;");
    expect(shader.fragmentShader.indexOf("discard;")).toBeLessThan(shader.fragmentShader.indexOf("#include <opaque_fragment>"));
    group.traverse((object) => { if (object instanceof THREE.Line) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
  });
  it("interpolates position and velocity from the same snapshots used by scene bodies", () => {
    const bodies = createSolarSystem();
    const previous = bodies.map((body) => ({ ...body, positionM: [0, 0, 0] as const, velocityMs: [0, 0, 0] as const }));
    const current = bodies.map((body) => ({ ...body, positionM: [10, 20, 30] as const, velocityMs: [40, 50, 60] as const }));
    const midway = interpolateOrbitBodies(previous, current, 0.5);
    expect(midway[0]!.positionM).toEqual([5, 10, 15]);
    expect(midway[0]!.velocityMs).toEqual([20, 25, 30]);
  });

  it("omits accepted debris orbit by stable ID after its name changes", () => {
    const bodies = createSolarSystem();
    const earth = bodies.find((body) => body.id === "earth")!;
    const debris = { ...earth, id: "accepted-fragment-id", name: "Renamed asteroid", parentId: "sun" };
    setActiveDebrisBodyIds(new Set([debris.id]));

    const paths = createOrbitPaths([...bodies, debris], 6.6743e-11, [0, 0, 0]);

    expect(paths.getObjectByName(debris.id)).toBeUndefined();
    expect(paths.getObjectByName("earth")).toBeDefined();
    setActiveDebrisBodyIds(new Set());
  });
});
