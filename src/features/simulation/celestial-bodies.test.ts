import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { applyRockSurfaceAssetsToVisual, createBodyVisual, createSurfaceReliefGeometry, rotateBody, surfaceReliefCellIndex, type BodyVisual } from "./celestial-bodies";
import { createSolarSystem } from "@/simulation/solar-system";
import { getSolarEvolutionProperties, getSolarTrackAgeAtEep, SOLAR_EVOLUTION_START_AGE_YEARS } from "@/simulation/stellar-evolution";
import { stellarColorTemperature } from "./body-appearance";
import type { SceneEclipseLight } from "./scene-lighting";
import { configureEarthSurfaceShader, installEarthSurfaceResponse, surfaceWaterMaskAtElevation } from "./surface-material";
import { deriveAtmosphereMetrics } from "@/simulation/atmosphere-model";
import type { SpinState } from "@/simulation/spin-model";
import { adoptWaterInventory, getWaterInventoryCapacityKg, setWaterInventory, updateWaterInventoryTemperature } from "@/simulation/water-model";

const textureLoads = vi.hoisted(() => ({ callbacks: [] as Array<(texture: import("three").Texture) => void> }));
vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return { ...actual, TextureLoader: class { load(_url: string, onLoad: (texture: import("three").Texture) => void) { textureLoads.callbacks.push(onLoad); return new actual.Texture(); } } };
});

describe("planet rotation", () => {
  it("uses explicit world-axis spin and accepted simulation time without changing legacy rotation", () => {
    const body = createSolarSystem().find(({ id }) => id === "earth")!;
    const spin: SpinState = { modelId: "rigid-body-spin-v1", axisUnitWorld: [1, 0, 0], phaseAtEpochRad: 0,
      angularVelocityRadPerS: Math.PI / 2 };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const spinningBody = { ...body, spin };
    const physicalVisual = createBodyVisual(spinningBody, geometry, 1);
    const legacyVisual = createBodyVisual(body, geometry, 1);
    const expectedAxis = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));

    rotateBody(physicalVisual, spinningBody, 0);
    expect(physicalVisual.surface.quaternion.angleTo(expectedAxis)).toBeCloseTo(0);
    rotateBody(physicalVisual, spinningBody, 1);
    const expectedPhase = expectedAxis.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
    expect(physicalVisual.surface.quaternion.angleTo(expectedPhase)).toBeCloseTo(0);
    rotateBody(legacyVisual, body, 0);
    expect(legacyVisual.surface.rotation.x).toBeCloseTo(Math.PI / 2 + THREE.MathUtils.degToRad(23.44));
    physicalVisual.dispose(); legacyVisual.dispose(); geometry.dispose();
  });

  it("renders heat on a body-local clone and clears it without touching shared geometry", () => {
    const base = createSolarSystem()[3]!;
    const body = { ...base, id: "heated-surface", surface: { modelId: "sparse-relief-v1" as const, seed: 1, revision: 1, resolution: 64 as const, dataId: "heated" } };
    const geometry = new THREE.SphereGeometry(1, 64, 32);
    const sourcePositions = Array.from(geometry.getAttribute("position").array);
    const visual = createBodyVisual(body, geometry, 1);
    const otherBody = { ...body, id: "heated-surface-other", surface: { ...body.surface!, dataId: "heated-other" } };
    const otherVisual = createBodyVisual(otherBody, geometry, 1);
    const overlay = visual.group.children.find((child) => child.name === "collision-visual-heat") as THREE.Mesh;
    const otherOverlay = otherVisual.group.children.find((child) => child.name === "collision-visual-heat") as THREE.Mesh;

    visual.setSurfaceHeat!([{ cellIndex: 16 * 64 + 32, energyJ: 1e24 }]);
    const colors = overlay.geometry.getAttribute("heatColor");
    expect(overlay.visible).toBe(true);
    expect(otherOverlay.visible).toBe(false);
    expect(Array.from({ length: colors.count }, (_, index) => colors.getW(index)).some((alpha) => alpha > 0)).toBe(true);
    expect(overlay.geometry).not.toBe(geometry);
    expect(overlay.material).not.toBe(visual.surface.material);
    expect(overlay.material).not.toBe(otherOverlay.material);
    expect(overlay.geometry).not.toBe(otherOverlay.geometry);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(sourcePositions);
    visual.setSurfaceHeat!([]);
    expect(overlay.visible).toBe(false);
    expect(Array.from({ length: colors.count }, (_, index) => colors.getW(index)).every((alpha) => alpha === 0)).toBe(true);
    visual.dispose();
    otherVisual.dispose();
    geometry.dispose();
  });

  it("ponds accepted liquid in crater lows before highlands using a body-local overlay", () => {
    const base = createSolarSystem()[3]!;
    const metadata = { modelId: "sparse-relief-v1" as const, seed: 1, revision: 1, resolution: 64 as const, dataId: "ponding" };
    const wetBody = setWaterInventory(adoptWaterInventory({ ...base, surface: metadata }), getWaterInventoryCapacityKg(base) * 0.02);
    const patches = [
      ...Array.from({ length: 80 }, (_, cellIndex) => ({ cellIndex, elevationM: -100 })),
      ...Array.from({ length: 10 }, (_, index) => ({ cellIndex: 100 + index, elevationM: 100 })),
    ];
    const shared = new THREE.SphereGeometry(1, 64, 32);
    const visual = createBodyVisual(wetBody, shared, 1, true, "scientific", undefined, false, patches);
    rotateBody(visual, wetBody, 0);
    const overlay = visual.surfaceWaterOverlay!;
    const waterMaterial = overlay.material as THREE.MeshStandardMaterial;
    const response = waterMaterial.userData.surfaceWaterState.response;
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>" } as Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0];
    waterMaterial.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    expect(overlay.visible).toBe(true);
    expect(response.levelM).toBeLessThan(0);
    expect(surfaceWaterMaskAtElevation(-100, response)).toBeGreaterThan(0);
    expect(surfaceWaterMaskAtElevation(0, response)).toBe(0);
    expect(overlay.geometry).not.toBe(visual.surface.geometry);
    expect(overlay.material).not.toBe(visual.surface.material);
    expect(overlay.geometry.getAttribute("surfaceElevation")).toBeDefined();
    expect(shader.vertexShader).toContain("attribute float surfaceElevation");
    expect(shader.fragmentShader).toContain("surfaceWaterMask");
    expect(shader.uniforms.surfaceWaterIceFraction?.value).toBe(0);
    visual.dispose();
    shared.dispose();
  });

  it("does not infer depression water from a legacy waterFraction", () => {
    const base = createSolarSystem()[3]!;
    const body = { ...base, waterFraction: 1, surface: { modelId: "sparse-relief-v1" as const, seed: 1, revision: 1, resolution: 64 as const, dataId: "legacy-ponding" } };
    const patches = Array.from({ length: 80 }, (_, cellIndex) => ({ cellIndex, elevationM: -100 }));
    const shared = new THREE.SphereGeometry(1, 64, 32);
    const visual = createBodyVisual(body, shared, 1, true, "scientific", undefined, false, patches);

    rotateBody(visual, body, 0);

    expect(visual.surfaceWaterOverlay!.visible).toBe(false);
    expect((visual.surfaceWaterOverlay!.material as THREE.MeshStandardMaterial).userData.surfaceWaterState.response).toBeUndefined();
    visual.dispose();
    shared.dispose();
  });

  it("freezes and restores accepted surface water from the accepted temperature phase", () => {
    const base = createSolarSystem()[3]!;
    const metadata = { modelId: "sparse-relief-v1" as const, seed: 1, revision: 1, resolution: 64 as const, dataId: "freeze-ponding" };
    const initial = setWaterInventory(adoptWaterInventory({ ...base, surface: metadata }), getWaterInventoryCapacityKg(base) * 0.02);
    const frozen = updateWaterInventoryTemperature(initial, 250);
    const thawed = updateWaterInventoryTemperature(frozen, 288);
    const patches = Array.from({ length: 80 }, (_, cellIndex) => ({ cellIndex, elevationM: -100 }));
    const shared = new THREE.SphereGeometry(1, 64, 32);
    const visual = createBodyVisual(initial, shared, 1, true, "scientific", undefined, false, patches);

    rotateBody(visual, frozen, 0);
    const waterMaterial = visual.surfaceWaterOverlay!.material as THREE.MeshStandardMaterial;
    const frozenResponse = waterMaterial.userData.surfaceWaterState.response;
    expect(frozenResponse.iceFraction).toBe(1);
    expect(frozenResponse.coverage).toBeGreaterThan(0);
    rotateBody(visual, thawed, 0);
    const thawedResponse = waterMaterial.userData.surfaceWaterState.response;
    expect(thawedResponse.iceFraction).toBe(0);
    expect(thawedResponse.coverage).toBeGreaterThan(0);
    visual.dispose();
    shared.dispose();
  });

  it("maps Y-north relief cells over the seam and canonical poles without mutating shared geometry", () => {
    const body = { ...createSolarSystem()[3]!, id: "surface-grid-test", radiusM: 1_000_000,
      surface: { modelId: "sparse-relief-v1" as const, seed: 1, revision: 1, resolution: 64 as const, dataId: "grid" } };
    const shared = new THREE.SphereGeometry(1, 64, 32);
    const sharedPositions = Array.from(shared.getAttribute("position").array);
    const geometry = createSurfaceReliefGeometry(body, shared, [
      { cellIndex: 16 * 64 + 32, elevationM: 100 },
      { cellIndex: 31 * 64 + 32, elevationM: 200 },
      { cellIndex: 0 * 64 + 32, elevationM: 300 },
      { cellIndex: 16 * 64, elevationM: 400 },
      { cellIndex: 16 * 64 + 63, elevationM: 500 },
    ]);
    const positions = geometry.getAttribute("position");
    const elevations = geometry.getAttribute("surfaceElevation");
    expect(elevations).toBeDefined();
    const equatorPositiveX = (16 * 65 + 32) * 3;
    const northPole = 1;
    const southPole = 32 * 65 + 1;
    const seamPositive = new THREE.Vector3(Math.cos(Math.PI - 0.05), 0, Math.sin(Math.PI - 0.05));
    const seamNegative = new THREE.Vector3(Math.cos(-Math.PI + 0.05), 0, Math.sin(-Math.PI + 0.05));
    const seamSource = new THREE.BufferGeometry();
    seamSource.setAttribute("position", new THREE.Float32BufferAttribute([
      seamPositive.x, 0, seamPositive.z, seamPositive.x, 0.01, seamPositive.z, seamPositive.x, -0.01, seamPositive.z,
      seamNegative.x, 0, seamNegative.z, seamNegative.x, 0.01, seamNegative.z, seamNegative.x, -0.01, seamNegative.z,
    ], 3));
    const seamGeometry = createSurfaceReliefGeometry(body, seamSource, [
      { cellIndex: 16 * 64, elevationM: 400 }, { cellIndex: 16 * 64 + 63, elevationM: 400 },
    ]);
    const radiusAt = (vertex: number) => Math.hypot(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex));
    const seamRadiusAt = (geometry: THREE.BufferGeometry, vertex: number) => {
      const attribute = geometry.getAttribute("position");
      return Math.hypot(attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex));
    };

    expect(geometry).not.toBe(shared);
    expect(positions.getX(equatorPositiveX / 3)).toBeCloseTo(1.0001, 5);
    expect(radiusAt(northPole)).toBeCloseTo(1.0002, 5);
    expect(radiusAt(southPole)).toBeCloseTo(1.0003, 5);
    expect(surfaceReliefCellIndex(seamPositive.x, 0, seamPositive.z)).toBe(16 * 64 + 63);
    expect(surfaceReliefCellIndex(seamNegative.x, 0, seamNegative.z)).toBe(16 * 64);
    expect(seamRadiusAt(seamGeometry, 0)).toBeCloseTo(1.0004, 5);
    expect(seamRadiusAt(seamGeometry, 3)).toBeCloseTo(1.0004, 5);
    expect(Array.from(shared.getAttribute("position").array)).toEqual(sharedPositions);
    geometry.dispose();
    seamGeometry.dispose();
    seamSource.dispose();
    shared.dispose();
  });

  it("preserves the original geometry for invalid or removed relief and disposes only a cloned visual geometry", () => {
    const body = { ...createSolarSystem()[3]!, id: "surface-disposal-test", radiusM: 1_000_000,
      surface: { modelId: "sparse-relief-v1" as const, seed: 1, revision: 1, resolution: 64 as const, dataId: "grid" } };
    const shared = new THREE.SphereGeometry(1, 64, 32);
    const disposeShared = vi.spyOn(shared, "dispose");
    const invalid = createSurfaceReliefGeometry(body, shared, [{ cellIndex: 2048, elevationM: 10 }]);
    const removed = createSurfaceReliefGeometry(body, shared, []);
    const { surface: _surface, ...legacyBody } = body;
    const missingMetadata = createSurfaceReliefGeometry(legacyBody, shared, [{ cellIndex: 16 * 64 + 32, elevationM: 10 }]);
    const visual = createBodyVisual(body, shared, 1, true, "scientific", undefined, false, [{ cellIndex: 16 * 64 + 32, elevationM: -100 }]);

    expect(invalid).toBe(shared);
    expect(removed).toBe(shared);
    expect(missingMetadata).toBe(shared);
    expect(visual.surface.geometry).not.toBe(shared);
    visual.dispose();
    expect(disposeShared).not.toHaveBeenCalled();
    expect(shared.getAttribute("position").count).toBeGreaterThan(0);
    shared.dispose();
  });
  it("maps Core atmosphere metrics to isolated bounded shell materials and preserves legacy Earth shell", () => {
    const earth = { ...createSolarSystem().find((body) => body.id === "earth")!, materials: { modelId: "material-composition-v1" as const, rockKg: 5e24, ironKg: 1e24, gasKg: 0 }, atmosphere: { modelId: "isothermal-atmosphere-v1" as const, profileId: "nitrogen-oxygen-v1" as const, dryGasMassKg: 5e18, isothermalTemperatureK: 288 } };
    const other = { ...earth, id: "earth-copy", atmosphere: { ...earth.atmosphere, profileId: "carbon-dioxide-v1" as const, dryGasMassKg: 1e19 } };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const first = createBodyVisual(earth, geometry, 1), second = createBodyVisual(other, geometry, 1);
    const legacy = createBodyVisual(createSolarSystem().find((body) => body.id === "earth")!, geometry, 1);
    const metrics = deriveAtmosphereMetrics(earth, 6.6743e-11);
    second.setAtmosphereMetrics!(deriveAtmosphereMetrics(other, 6.6743e-11));
    first.setAtmosphereMetrics!(metrics);
    const explicitShell = first.group.children.find((child) => child.name === "body-atmosphere") as THREE.Mesh;
    const fallbackShell = first.group.children.find((child) => child.name === "earth-decorative-atmosphere") as THREE.Mesh;
    expect(explicitShell).toBeDefined();
    expect(fallbackShell.visible).toBe(false);
    expect(first.group.children.filter((child) => child.visible && child.name.includes("atmosphere"))).toHaveLength(1);
    const material = explicitShell.material as THREE.ShaderMaterial;
    expect(material.uniforms.opacity.value).toBeCloseTo(metrics.visualOpacityFraction);
    const renderedShellRatio = Math.min(metrics.scaleHeightToRadiusRatio * 4, 0.05);
    expect(material.uniforms.shellRatio.value).toBeCloseTo(renderedShellRatio);
    expect(material.uniforms).not.toHaveProperty("opticalDepth");
    expect(material.uniforms).not.toHaveProperty("limbStrength");
    expect(material.fragmentShader).toContain("float alpha = opacity * mix(0.2, 1.0, rim);");
    expect(explicitShell.scale.x).toBeCloseTo(1 + renderedShellRatio);
    first.setAtmosphereMetrics!({ ...metrics, scaleHeightToRadiusRatio: 0.02 });
    expect(material.uniforms.shellRatio.value).toBeCloseTo(0.05);
    expect(explicitShell.scale.x).toBeCloseTo(1.05);
    expect(material.uniforms.opacity.value).toBeCloseTo(metrics.visualOpacityFraction);
    first.setAtmosphereMetrics!(undefined);

    expect(first.group.children.some((child) => child.name === "body-atmosphere")).toBe(false);
    expect(fallbackShell.visible).toBe(true);
    expect(legacy.group.children.filter((child) => child.name === "body-atmosphere")).toHaveLength(0);
    expect(legacy.group.children.filter((child) => child.name === "earth-decorative-atmosphere")).toHaveLength(1);
    const legacyShell = legacy.group.children.find((child) => child.name === "earth-decorative-atmosphere") as THREE.Mesh;
    expect((legacyShell.material as THREE.ShaderMaterial).uniforms.opacity.value).toBeCloseTo(0.62);
    first.setAtmosphereMetrics!(metrics);
    const currentShell = first.group.children.find((child) => child.name === "body-atmosphere") as THREE.Mesh;
    expect(currentShell.visible).toBe(true);
    expect(legacyShell.visible).toBe(true);
    const secondMaterial = (second.group.children.find((child) => child.name === "body-atmosphere") as THREE.Mesh).material;
    expect(currentShell.material).not.toBe(secondMaterial);
    expect((secondMaterial as THREE.ShaderMaterial).uniforms.opacity.value).not.toBe(material.uniforms.opacity.value);
    const currentMaterial = Array.isArray(currentShell.material) ? currentShell.material[0]! : currentShell.material;
    const currentShader = currentMaterial as THREE.ShaderMaterial;
    const initialOpacity = currentShader.uniforms.opacity.value;
    const updatedMetrics = deriveAtmosphereMetrics({ ...earth, atmosphere: { ...earth.atmosphere, dryGasMassKg: 8e18 } }, 6.6743e-11);
    first.setAtmosphereMetrics!(updatedMetrics);
    expect(first.group.children.find((child) => child.name === "body-atmosphere")).toBe(currentShell);
    expect(currentShader.uniforms.opacity.value).not.toBe(initialOpacity);
    let materialDisposed = false;
    currentMaterial.addEventListener("dispose", () => { materialDisposed = true; });
    first.dispose();
    expect(materialDisposed).toBe(true);
    first.setAtmosphereMetrics!(metrics);
    expect(first.group.children.filter((child) => child.name === "body-atmosphere")).toEqual([currentShell]);
    second.dispose();
    legacy.dispose();
    geometry.dispose();
  });
  it("keeps scientific black holes physical and adds a bounded procedural creative disk", () => {
    const blackHole = { ...createSolarSystem()[0]!, id: "new-black-hole", bodyType: "black-hole" as const };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(blackHole, geometry, 1, true, "scientific");
    expect(visual.surface.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((visual.surface.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0);
    expect((visual.surface.material as THREE.MeshBasicMaterial).map).toBeNull();
    expect(visual.group.children.some((object) => object instanceof THREE.Sprite)).toBe(false);
    expect(visual.group.children.filter((object) => object instanceof THREE.Mesh)).toEqual([visual.surface]);
    visual.dispose();
    const creative = createBodyVisual(blackHole, geometry, 1, true, "creative");
    const disk = creative.group.children.find((object) => object.name === "black-hole-accretion-disk") as THREE.Mesh;
    const photonRing = creative.group.children.find((object) => object.name === "black-hole-photon-ring") as THREE.Mesh;
    const arcs = creative.group.children.filter((object) => object.name.startsWith("black-hole-lensing-arc-")) as THREE.Mesh[];
    expect(disk).toBeDefined();
    expect((disk.geometry as THREE.RingGeometry).parameters.outerRadius).toBe(32);
    expect(disk.userData.bodyId).toBe(blackHole.id);
    expect(disk.userData.bodyPickExtentMultiplier).toBe(4);
    expect((disk.geometry as THREE.RingGeometry).parameters.outerRadius).toBeLessThanOrEqual(creative.surface.scale.x * disk.userData.bodyPickExtentMultiplier);
    expect(disk.material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(photonRing.geometry).toBeInstanceOf(THREE.TorusGeometry);
    expect((photonRing.geometry as THREE.TorusGeometry).parameters.radius + (photonRing.geometry as THREE.TorusGeometry).parameters.tube).toBeCloseTo(9.43);
    expect(photonRing.userData.bodyId).toBe(blackHole.id);
    expect(photonRing.userData.bodyPickExtentMultiplier).toBe(1.18);
    expect((photonRing.geometry as THREE.TorusGeometry).parameters.radius + (photonRing.geometry as THREE.TorusGeometry).parameters.tube).toBeLessThanOrEqual(creative.surface.scale.x * photonRing.userData.bodyPickExtentMultiplier);
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) {
      expect(arc.geometry).toBeInstanceOf(THREE.TorusGeometry);
      expect(arc.userData.bodyId).toBe(blackHole.id);
      expect(arc.userData.bodyPickExtentMultiplier).toBe(1.5);
      const torus = arc.geometry as THREE.TorusGeometry;
      expect(torus.parameters.radius + torus.parameters.tube).toBeLessThanOrEqual(creative.surface.scale.x * arc.userData.bodyPickExtentMultiplier);
    }
    expect(creative.surface.userData.bodyId).toBe(blackHole.id);
    expect(creative.surface.scale.x).toBe(8);
    expect(creative.surface.userData.visualScaleNote).toBe("escala visual ampliada");
    creative.dispose();
    expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
    geometry.dispose();
  });
  it("exposes Saturn's visible ring as a body-owned picking extent", () => {
    const saturn = createSolarSystem().find((body) => body.id === "saturn")!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(saturn, geometry, 1);
    const ring = visual.group.children.find((object) => object instanceof THREE.Mesh && object.geometry instanceof THREE.RingGeometry) as THREE.Mesh;

    expect(ring).toBeDefined();
    expect(ring.userData.bodyId).toBe(saturn.id);
    expect(ring.userData.bodyPickExtentMultiplier).toBe(2.32);
    expect((ring.geometry as THREE.RingGeometry).parameters.innerRadius).toBe(1.24);
    expect((ring.geometry as THREE.RingGeometry).parameters.outerRadius).toBe(2.32);
    expect((ring.geometry as THREE.RingGeometry).parameters.outerRadius).toBeLessThanOrEqual(visual.surface.scale.x * ring.userData.bodyPickExtentMultiplier);
    expect(visual.surface.userData.bodyId).toBe(saturn.id);
    visual.dispose();
    geometry.dispose();
  });

  it("shades Saturn's rings inside the planet's projected shadow without shadow maps", () => {
    const saturn = createSolarSystem().find((body) => body.id === "saturn")!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(saturn, geometry, 1);
    const ring = visual.group.children.find((object) => object instanceof THREE.Mesh && object.geometry instanceof THREE.RingGeometry) as THREE.Mesh;
    const material = ring.material as THREE.MeshStandardMaterial;
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <lights_fragment_begin>\n#include <color_fragment>",
    };

    const lights: SceneEclipseLight[] = [0.25, 0.5, 0.75, 1].map((distanceFactor, index) => ({
      sourcePosition: [0, 0, 10 + index] as const,
      sourceRadius: 1,
      distanceFactor,
      blockerPosition: [0, 0, 5] as const,
      blockerRadius: 0.5,
    }));
    visual.setEclipseLighting?.(lights);
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("vRingPlanetRadius");
    expect(shader.vertexShader).toContain("vAstroWorldPosition");
    expect(shader.fragmentShader).toContain("ringShadowDistance");
    expect(shader.fragmentShader).toContain("directLight.color *= planetShadow;");
    expect(shader.fragmentShader).toMatch(/if \( UNROLLED_LOOP_INDEX < astroEclipseLightCount \) \{[\s\S]*?directLight\.color \*= planetShadow;\s*\}/);
    expect(shader.fragmentShader).toContain("astroEclipseShadowMask");
    expect(shader.fragmentShader).toContain("sourceAngularRadius");
    expect(shader.fragmentShader).toContain("smoothstep(abs(blockerAngularRadius - sourceAngularRadius)");
    expect(shader.fragmentShader).toMatch(/if \( UNROLLED_LOOP_INDEX < astroEclipseLightCount \) \{\s*directLight\.color \*= astroEclipseDistanceFactor\[ UNROLLED_LOOP_INDEX \] \* astroEclipseShadowMask\( UNROLLED_LOOP_INDEX, vAstroWorldPosition \);/);
    expect(shader.fragmentShader).toContain("smoothstep(0.92, 1.12");
    expect(shader.uniforms.astroEclipseLightCount.value).toBe(4);
    expect(shader.uniforms.astroEclipseDistanceFactor.value).toEqual(new Float32Array([0.25, 0.5, 0.75, 1]));
    expect(shader.uniforms.astroEclipseBlockerRadius.value).toEqual(new Float32Array([0.5, 0.5, 0.5, 0.5]));
    visual.dispose();
    geometry.dispose();
  });

  it("keeps a fifth event point light outside the four eclipse slots", () => {
    const mars = createSolarSystem().find((body) => body.id === "mars")!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(mars, geometry, 1);
    const material = visual.surface.material as THREE.MeshStandardMaterial;
    const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: "#include <common>\n#include <lights_fragment_begin>\n#include <lights_fragment_maps>\n#include <lights_fragment_end>", vertexShader: "" };

    expect(visual.setEclipseLighting).toBeTypeOf("function");
    visual.setEclipseLighting?.([0.25, 0.5, 0.75, 1, 0].map((distanceFactor, index) => ({
      sourcePosition: [0, 0, 10 + index] as const,
      sourceRadius: 1,
      distanceFactor,
      blockerPosition: [0, 0, 5] as const,
      blockerRadius: 0.25,
    })));
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.astroEclipseLightCount.value).toBe(4);
    expect(shader.uniforms.astroEclipseDistanceFactor.value).toEqual(new Float32Array([0.25, 0.5, 0.75, 1]));
    expect(shader.fragmentShader).toMatch(/if \( UNROLLED_LOOP_INDEX < astroEclipseLightCount \) \{[\s\S]*?astroEclipseDistanceFactor\[ UNROLLED_LOOP_INDEX \][\s\S]*?astroEclipseShadowMask\( UNROLLED_LOOP_INDEX, vAstroWorldPosition \);\s*\}/);
    visual.dispose();
    geometry.dispose();
  });
  it("updates eclipse light counts across cached shader variants", () => {
    const mars = createSolarSystem().find((body) => body.id === "mars")!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(mars, geometry, 1);
    const material = visual.surface.material as THREE.MeshStandardMaterial;
    const createShader = () => ({ uniforms: {} as Record<string, { value: unknown }>, fragmentShader: "", vertexShader: "" });
    const firstShader = createShader(), secondShader = createShader();
    const makeLights = (count: number): SceneEclipseLight[] => Array.from({ length: count }, (_, index) => ({
      sourcePosition: [0, 0, 10 + index] as const, sourceRadius: 1, distanceFactor: 1,
      blockerPosition: [0, 0, 5] as const, blockerRadius: 0.5,
    }));

    visual.setEclipseLighting?.(makeLights(1));
    material.onBeforeCompile(firstShader as never, {} as THREE.WebGLRenderer);
    material.onBeforeCompile(secondShader as never, {} as THREE.WebGLRenderer);
    visual.setEclipseLighting?.(makeLights(3));

    expect(firstShader.uniforms.astroEclipseLightCount.value).toBe(3);
    expect(secondShader.uniforms.astroEclipseLightCount.value).toBe(3);
    visual.dispose();
    geometry.dispose();
  });
  it("builds repeatable irregular rock geometry from stable body identity", () => {
    const asteroid = { ...createSolarSystem()[0]!, id: "rock-seed", bodyType: "asteroid" as const, kind: "planet" as const };
    const shared = new THREE.SphereGeometry(1, 8, 4);
    const first = createBodyVisual(asteroid, shared, 1);
    const second = createBodyVisual(asteroid, shared, 1);
    const firstPositions = first.surface.geometry.getAttribute("position");
    const secondPositions = second.surface.geometry.getAttribute("position");
    expect(first.surface.geometry).not.toBe(shared);
    expect(firstPositions.count).toBeGreaterThan(12);
    expect(Array.from(firstPositions.array)).toEqual(Array.from(secondPositions.array));
    expect(new Set(Array.from(firstPositions.array)).size).toBeGreaterThan(10);
    first.dispose(); second.dispose(); shared.dispose();
  });
  it("keeps deterministic per-ID rocky tint with shared assets through rotation", () => {
    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    const makeRock = (id: string) => ({ ...earth, id, bodyType: "rocky-planet" as const, surfaceTemperatureK: 250, waterFraction: 0 });
    const sharedGeometry = new THREE.SphereGeometry(1, 8, 4);
    const sharedDiffuse = new THREE.Texture();
    const sharedRoughness = new THREE.Texture();
    const assets = { diffuse: sharedDiffuse, roughness: sharedRoughness, dispose: () => {} };
    const bodies = [makeRock("qa-rock-a"), makeRock("qa-rock-a"), makeRock("qa-rock-b")];
    const visuals = bodies.map((body) => createBodyVisual(body, sharedGeometry, 1, true, "scientific", assets));
    const materials = visuals.map((visual) => visual.surface.material as THREE.MeshStandardMaterial);
    const tintAfterAssets = materials.map((material) => material.color.getHex());

    expect(materials.map((material) => material.map)).toEqual([sharedDiffuse, sharedDiffuse, sharedDiffuse]);
    expect(tintAfterAssets[0]).toBe(tintAfterAssets[1]);
    expect(tintAfterAssets[0]).not.toBe(tintAfterAssets[2]);

    visuals.forEach((visual, index) => rotateBody(visual, bodies[index]!, 0));
    visuals.forEach((visual, index) => rotateBody(visual, bodies[index]!, 43200));
    const tintAfterRotation = materials.map((material) => material.color.getHex());

    expect(tintAfterRotation).toEqual(tintAfterAssets);
    expect(tintAfterRotation[0]).toBe(tintAfterRotation[1]);
    expect(tintAfterRotation[0]).not.toBe(tintAfterRotation[2]);
    expect(materials.map((material) => material.map)).toEqual([sharedDiffuse, sharedDiffuse, sharedDiffuse]);

    visuals.forEach((visual) => visual.dispose());
    sharedGeometry.dispose();
    sharedDiffuse.dispose();
    sharedRoughness.dispose();
  });
  it("keeps per-ID tint and shared textures when rock assets attach after creation", () => {
    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    const makeRock = (id: string) => ({ ...earth, id, bodyType: "rocky-planet" as const, surfaceTemperatureK: 250, waterFraction: 0 });
    const sharedGeometry = new THREE.SphereGeometry(1, 8, 4);
    const sharedDiffuse = new THREE.Texture();
    const sharedRoughness = new THREE.Texture();
    sharedDiffuse.anisotropy = 2;
    sharedRoughness.anisotropy = 2;
    const assets = { diffuse: sharedDiffuse, roughness: sharedRoughness, dispose: () => {} };
    const bodies = [makeRock("qa-async-rock-a"), makeRock("qa-async-rock-a"), makeRock("qa-async-rock-b")];
    const visuals = bodies.map((body) => createBodyVisual(body, sharedGeometry, 1));

    visuals.forEach((visual, index) => expect(applyRockSurfaceAssetsToVisual(bodies[index]!, visual, assets)).toBe(true));
    const materials = visuals.map((visual) => visual.surface.material as THREE.MeshStandardMaterial);
    const tintAfterAssets = materials.map((material) => material.color.getHex());
    expect(tintAfterAssets[0]).toBe(tintAfterAssets[1]);
    expect(tintAfterAssets[0]).not.toBe(tintAfterAssets[2]);
    expect(materials.map((material) => material.map)).toEqual([sharedDiffuse, sharedDiffuse, sharedDiffuse]);
    expect(sharedDiffuse.anisotropy).toBe(2);
    expect(sharedRoughness.anisotropy).toBe(2);

    visuals.forEach((visual, index) => rotateBody(visual, bodies[index]!, 0));
    visuals.forEach((visual, index) => rotateBody(visual, bodies[index]!, 43200));
    const tintAfterRotation = materials.map((material) => material.color.getHex());
    expect(tintAfterRotation).toEqual(tintAfterAssets);
    expect(tintAfterRotation[0]).toBe(tintAfterRotation[1]);
    expect(tintAfterRotation[0]).not.toBe(tintAfterRotation[2]);
    expect(materials.map((material) => material.map)).toEqual([sharedDiffuse, sharedDiffuse, sharedDiffuse]);
    expect(sharedDiffuse.anisotropy).toBe(2);
    expect(sharedRoughness.anisotropy).toBe(2);

    visuals.forEach((visual) => visual.dispose());
    sharedGeometry.dispose();
    sharedDiffuse.dispose();
    sharedRoughness.dispose();
  });
  it("keeps canonical Mars clone texture and color when shared rock assets attach", () => {
    const mars = createSolarSystem().find((body) => body.id === "mars")!;
    const clone = { ...mars, id: "mars-copy-1" };
    const sharedGeometry = new THREE.SphereGeometry(1, 8, 4);
    const sharedDiffuse = new THREE.Texture();
    const sharedRoughness = new THREE.Texture();
    const assets = { diffuse: sharedDiffuse, roughness: sharedRoughness, dispose: () => {} };
    const visual = createBodyVisual(clone, sharedGeometry, 1, true, "scientific", assets);
    const material = visual.surface.material as THREE.MeshStandardMaterial;
    const canonicalMap = material.map;
    const canonicalColor = material.color.getHex();

    expect(canonicalMap).not.toBe(sharedDiffuse);
    expect(applyRockSurfaceAssetsToVisual(clone, visual, assets)).toBe(false);
    expect(material.map).toBe(canonicalMap);
    rotateBody(visual, clone, 0);
    const initialOrientation = visual.surface.quaternion.clone();
    rotateBody(visual, clone, 43200);

    expect(visual.surface.quaternion.angleTo(initialOrientation)).toBeGreaterThan(0);
    expect(material.map).toBe(canonicalMap);
    expect(material.color.getHex()).toBe(canonicalColor);

    visual.dispose();
    sharedGeometry.dispose();
    sharedDiffuse.dispose();
    sharedRoughness.dispose();
  });
  it("keeps the tilted Earth spin axis fixed as simulated time advances", () => {
    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const material = new THREE.MeshStandardMaterial();
    const surface = new THREE.Mesh(geometry, material), clouds = new THREE.Mesh(geometry, material);
    const visual: BodyVisual = { group: new THREE.Group(), surface, clouds, dispose: () => {} };
    rotateBody(visual, earth, 0);
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(surface.quaternion);
    const surfacePoint = new THREE.Vector3(1, 0, 0).applyQuaternion(surface.quaternion);
    expect(axis.angleTo(new THREE.Vector3(0, 0, 1))).toBeCloseTo(THREE.MathUtils.degToRad(23.44), 10);
    for (const time of [21541, 43082, 86164, 172328]) {
      rotateBody(visual, earth, time);
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(surface.quaternion).distanceTo(axis)).toBeLessThan(1e-12);
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(clouds.quaternion).distanceTo(axis)).toBeLessThan(1e-12);
      if (time === 21541) expect(new THREE.Vector3(1, 0, 0).applyQuaternion(surface.quaternion).distanceTo(surfacePoint)).toBeGreaterThan(1);
    }
    geometry.dispose(); material.dispose();
  });
  it("shows model vapor as clouds while keeping Earth's surface coverage dry", () => {
    const earth = {
      ...createSolarSystem().find((body) => body.id === "earth")!,
      surfaceTemperatureK: 400,
      waterFraction: 0,
      waterInventory: {
        modelId: "water-inventory-v1" as const,
        escapeModelId: "water-escape-retention-500-1000k-v1" as const,
        dryMassKg: 1e24,
        dryVolumeM3: 1e21,
        liquidKg: 0,
        iceKg: 0,
        vaporKg: 6e20,
        escapedKg: 0,
      },
    };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const surfaceMaterial = new THREE.MeshStandardMaterial();
    installEarthSurfaceResponse(surfaceMaterial);
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: "", fragmentShader: "" } as Parameters<typeof configureEarthSurfaceShader>[1];
    configureEarthSurfaceShader(surfaceMaterial, shader);
    const surface = new THREE.Mesh(geometry, surfaceMaterial);
    const clouds = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0 }));
    const visual: BodyVisual = { group: new THREE.Group(), surface, clouds, dispose: () => {} };

    rotateBody(visual, earth, 0);

    expect(shader.uniforms.astroWaterFraction.value).toBe(0);
    expect((clouds.material as THREE.MeshStandardMaterial).opacity).toBeGreaterThan(0);
    expect((surface.material as THREE.MeshStandardMaterial).opacity).toBe(1);
    expect((surface.material as THREE.MeshStandardMaterial).transparent).toBe(false);
    geometry.dispose(); surfaceMaterial.dispose(); clouds.material.dispose();
  });
  it("preserves legacy vapor opacity from the water metrics fallback", () => {
    const legacyBody = { ...createSolarSystem()[0]!, id: "legacy-rock", bodyType: "asteroid" as const, kind: "planet" as const, surfaceTemperatureK: 400, waterFraction: 0.5 };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
    const visual: BodyVisual = { group: new THREE.Group(), surface: new THREE.Mesh(geometry, material), dispose: () => {} };

    rotateBody(visual, legacyBody, 0);

    expect(material.opacity).toBe(0.675);
    expect(material.transparent).toBe(true);
    geometry.dispose(); material.dispose();
  });
  it("softens Earth highlight without changing its map or adding a fake surface layer", () => {
    const earth = createSolarSystem().find((body) => body.id === "earth")!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(earth, geometry, 1);
    expect((visual.surface.material as THREE.MeshStandardMaterial).roughness).toBeGreaterThanOrEqual(0.9);
    expect((visual.surface.material as THREE.MeshStandardMaterial).bumpMap).toBeNull();
    visual.dispose(); geometry.dispose();
  });
  it("updates stellar mesh and glow colors in place as effective temperature changes", () => {
    const sun = { ...createSolarSystem()[0]!, id: "generic-star", surfaceTemperatureK: 5772 };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(sun, geometry, 1);
    const material = visual.surface.material;
    const sprite = visual.group.children.find((child) => child instanceof THREE.Sprite) as THREE.Sprite;
    const spriteMaterial = sprite.material as THREE.SpriteMaterial;
    const solarColor = stellarColorTemperature(5772);
    const expectedInitialColor = new THREE.Color().setRGB(solarColor.r, solarColor.g, solarColor.b, THREE.SRGBColorSpace);
    expect(spriteMaterial.color.getHex()).toBe(expectedInitialColor.getHex());

    rotateBody(visual, { ...sun, surfaceTemperatureK: 3500 }, 0);
    const warm = visual.surface.material as THREE.ShaderMaterial;
    expect(warm).toBe(material);
    expect(sprite.material).toBe(spriteMaterial);
    expect(warm.uniforms.baseColor.value.r).toBeGreaterThan(warm.uniforms.baseColor.value.b);
    expect(spriteMaterial.color.r).toBeGreaterThan(spriteMaterial.color.b);
    const coolOpacity = spriteMaterial.opacity;

    rotateBody(visual, { ...sun, radiusM: 2.45e11, surfaceTemperatureK: 3500 }, 0);
    expect(visual.surface.material).toBe(material);
    expect(sprite.material).toBe(spriteMaterial);
    expect(spriteMaterial.opacity).toBeGreaterThan(coolOpacity);

    visual.dispose();
    geometry.dispose();
  });
  it("updates photosphere brightness in place from accepted radius and temperature", () => {
    const sun = createSolarSystem()[0]!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(sun, geometry, 1);
    const material = visual.surface.material as THREE.ShaderMaterial;
    rotateBody(visual, sun, 0);
    const solarBrightness = material.uniforms.surfaceBrightness?.value;
    expect(solarBrightness).toBe(1);

    rotateBody(visual, sun, 0, { ...sun, radiusM: sun.radiusM * 1.52, surfaceTemperatureK: 5610 });

    expect(material.uniforms.surfaceBrightness.value).toBeGreaterThan(1.1);
    expect(material.uniforms.surfaceBrightness.value).toBeLessThan(1.2);
    visual.dispose();
    geometry.dispose();
  });
  it("changes photosphere and corona response across accepted MIST anchor and TP-AGB state", () => {
    const sun = createSolarSystem()[0]!, geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(sun, geometry, 1);
    const photosphere = visual.surface.material as THREE.ShaderMaterial;
    const corona = visual.corona!.material as THREE.ShaderMaterial;
    const accepted = (ageYears: number) => {
      const state = getSolarEvolutionProperties(ageYears);
      return { radiusM: state.radiusM, surfaceTemperatureK: state.effectiveTemperatureK };
    };
    const anchor = accepted(SOLAR_EVOLUTION_START_AGE_YEARS), agb = accepted(getSolarTrackAgeAtEep(1000));

    rotateBody(visual, sun, 0, anchor, false);
    const anchorActivity = photosphere.uniforms.surfaceActivity.value;
    const anchorCorona = corona.uniforms.coronaIntensity.value;
    rotateBody(visual, sun, 0, agb, false);
    const agbActivity = photosphere.uniforms.surfaceActivity.value;
    const agbCorona = corona.uniforms.coronaIntensity.value;
    rotateBody(visual, sun, 0, agb, false);

    expect(agbActivity).not.toBe(anchorActivity);
    expect(agbCorona).not.toBe(anchorCorona);
    expect(photosphere.uniforms.surfaceActivity.value).toBe(agbActivity);
    expect(corona.uniforms.coronaIntensity.value).toBe(agbCorona);
    expect(photosphere.uniforms.surfaceTime.value).toBe(0);
    expect(corona.uniforms.surfaceTime.value).toBe(0);
    const photosphereDisposed = vi.fn(), coronaDisposed = vi.fn();
    photosphere.addEventListener("dispose", photosphereDisposed); corona.addEventListener("dispose", coronaDisposed);
    visual.dispose(); geometry.dispose();
    expect(photosphereDisposed).toHaveBeenCalledOnce(); expect(coronaDisposed).toHaveBeenCalledOnce();
  });
  it("does not load the Sun map for its white-dwarf phase and disposes stale map callbacks", () => {
    textureLoads.callbacks.length = 0;
    const sun = createSolarSystem()[0]!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const oldSun = createBodyVisual(sun, geometry, 1);
    const staleLoad = textureLoads.callbacks.pop()!;
    oldSun.dispose();

    const whiteDwarf = createBodyVisual({ ...sun, bodyType: "white-dwarf", radiusM: 7e6, surfaceTemperatureK: 10000 }, geometry, 1);
    expect(textureLoads.callbacks).toHaveLength(0);
    expect(whiteDwarf.surface.material).toBeInstanceOf(THREE.ShaderMaterial);
    const lateTexture = new THREE.Texture();
    const disposeTexture = vi.spyOn(lateTexture, "dispose");
    staleLoad(lateTexture);
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(whiteDwarf.surface.material).toBeInstanceOf(THREE.ShaderMaterial);
    whiteDwarf.dispose();
    geometry.dispose();
  });
  it("renders a white dwarf with smooth temperature-colored procedural limb shading and no surface activity", () => {
    const whiteDwarf = { ...createSolarSystem()[0]!, bodyType: "white-dwarf" as const, radiusM: 7e6, surfaceTemperatureK: 10000 };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(whiteDwarf, geometry, 1);
    const material = visual.surface.material as THREE.ShaderMaterial;
    const onDispose = vi.fn();
    material.addEventListener("dispose", onDispose);
    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    const hotColor = stellarColorTemperature(10000);
    expect(material.uniforms.baseColor.value.getHex()).toBe(new THREE.Color().setRGB(hotColor.r, hotColor.g, hotColor.b, THREE.SRGBColorSpace).getHex());
    expect(material.fragmentShader).toContain("limbDarkening");
    expect(material.uniforms.surfaceActivity.value).toBe(0);
    expect(material.fragmentShader).toContain("photosphereVariation");
    expect(material.vertexShader).toContain("#include <logdepthbuf_vertex>");
    expect(material.fragmentShader).toContain("#include <logdepthbuf_fragment>");
    expect(material.uniforms.surfaceTime.value).toBe(0);
    const glow = visual.group.children.find((object) => object instanceof THREE.Sprite) as THREE.Sprite;
    const before = material.uniforms.baseColor.value.getHex();
    rotateBody(visual, whiteDwarf, 0, { radiusM: 7e6, surfaceTemperatureK: 4000 });
    expect(material.uniforms.baseColor.value.getHex()).not.toBe(before);
    expect((visual.group.children.find((object) => object instanceof THREE.Sprite) as THREE.Sprite).material).toBe(glow.material);
    visual.dispose();
    expect(onDispose).toHaveBeenCalledOnce();
    geometry.dispose();
  });
  it("gives ordinary catalog stars deterministic animated photosphere detail", () => {
    const star = { ...createSolarSystem()[0]!, id: "catalog-star", bodyType: "star" as const, surfaceTemperatureK: 3500 };
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(star, geometry, 1);
    expect(visual.surface.material).toBeInstanceOf(THREE.ShaderMaterial);
    expect((visual.surface.material as THREE.ShaderMaterial).fragmentShader).toContain("limbDarkening");
    expect((visual.surface.material as THREE.ShaderMaterial).uniforms.surfaceActivity.value).toBeGreaterThan(0);
    rotateBody(visual, star, 200000, { radiusM: star.radiusM, surfaceTemperatureK: 3500 });
    const material = visual.surface.material as THREE.ShaderMaterial;
    expect(material.uniforms.baseColor.value.r).toBeGreaterThan(material.uniforms.baseColor.value.b);
    expect(material.uniforms.surfaceTime.value).toBeGreaterThanOrEqual(0);
    expect(material.uniforms.surfaceTime.value).toBeLessThan(Math.PI * 2);
    visual.dispose();
    geometry.dispose();
  });
  it("animates the Sun's photosphere and includes a luminous corona layer", () => {
    const sun = createSolarSystem()[0]!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(sun, geometry, 1);
    const corona = visual.group.children.find((child) => child instanceof THREE.Mesh && child !== visual.surface) as THREE.Mesh | undefined;

    expect(visual.surface.material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(corona).toBeDefined();
    expect(corona!.scale.x).toBeGreaterThan(visual.surface.scale.x);
    expect(corona!.scale.x).toBeCloseTo(1.04);
    const photosphere = visual.surface.material as THREE.ShaderMaterial;
    const coronaMaterial = corona!.material as THREE.ShaderMaterial;
    expect(coronaMaterial.fragmentShader).toMatch(/uniform\s+float\s+coronaIntensity\s*;/);
    const initialTime = photosphere.uniforms.surfaceTime.value;
    const initialCoronaTime = coronaMaterial.uniforms.surfaceTime.value;
    rotateBody(visual, sun, 100_000);

    expect(photosphere.uniforms.surfaceTime.value).not.toBe(initialTime);
    expect(coronaMaterial.uniforms.surfaceTime.value).not.toBe(initialCoronaTime);
    visual.dispose();
    geometry.dispose();
  });
  it("removes stellar surface and glow emission at zero effective temperature", () => {
    const star = createSolarSystem()[0]!;
    const geometry = new THREE.SphereGeometry(1, 8, 4);
    const visual = createBodyVisual(star, geometry, 1);
    const sprite = visual.group.children.find((child) => child instanceof THREE.Sprite)!;
    const corona = visual.corona!;

    rotateBody(visual, { ...star, surfaceTemperatureK: 0 }, 0);

    expect(visual.surface.visible).toBe(false);
    expect(sprite.visible).toBe(false);
    expect((sprite as THREE.Sprite).material.opacity).toBe(0);
    expect(corona.visible).toBe(false);
    expect((visual.surface.material as THREE.ShaderMaterial).uniforms.surfaceActivity.value).toBe(0);
    expect((corona.material as THREE.ShaderMaterial).uniforms.coronaIntensity.value).toBe(0);
    visual.dispose();
    geometry.dispose();
  });
});
