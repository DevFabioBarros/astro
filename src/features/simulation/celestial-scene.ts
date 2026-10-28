import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CelestialBody, CollisionMode, LaserAimConfiguration, OrbitalMutationPreviewResponse, OrbitalPlacementMutation, SimulationEvent, SurfaceData, SurfaceHeatData, TrajectoryPreviewResult, Vector3 } from "@/simulation/types";
import { deriveAtmosphereMetrics } from "@/simulation/atmosphere-model";
import { isDebrisBody } from "@/simulation/body-identity";
import { CAMERA_FAR, MAX_CAMERA_DISTANCE, MAX_SCENE_EXTENT_UNITS, OVERVIEW_POSITION_TRANSITION_MS, SCENE_UNITS_PER_METER, assistedOverviewRadius, cachedBodyExtent, fromOverviewScenePosition, interpolateOverviewCompression, measureBodyExtent, measureOrbitExtent, minimumCameraDistance, toOverviewScenePosition, toSceneRadius } from "./scene-scale";
import { applySafeCameraViewport, focusCameraFitDistance, focusCameraOnBody, getSafeCameraViewport, shouldFollowFocusedBody, systemCameraDistance, updateSystemCamera, type CameraFocusState } from "./camera-focus";
import { applyRockSurfaceAssetsToVisual, createBodyVisual, rotateBody, type BodyVisual } from "./celestial-bodies";
import { loadRockSurfaceAssets, type RockSurfaceAssets } from "./rock-assets";
import { createCelestialEnvironment } from "./celestial-environment";
import { createCircularOrbitPreviewPath, createOrbitPaths, createOrbitalRingPreviewGuide, interpolateOrbitBodies, orbitPathColor, orbitPathColorForBodyType, refreshOrbitPaths, updateOrbitPathHighlights, updateOrbitPathOcclusion, type OrbitPositionMapper } from "./orbit-paths";
import { addOrbitTrailToScene, createOrbitTrailState, refreshOrbitTrailLine, updateOrbitTrails, type AuthoritativeOrbitSnapshot } from "./orbit-trails";
import { SceneEventEffects } from "./scene-events";
import { compactSceneLabel, layoutFocusLabel, layoutSceneLabels, projectSceneOccluder, type SceneLabelAnchor, type SceneLabelOccluder, type SceneViewport } from "./scene-labels";
import { blackHoleVisualExtent, blackHoleVisualRadius, bodyAppearanceKey, dominantLightSource, renderedBodyRadius } from "./body-appearance";
import { findStrongestEclipseBlocker, isSceneSourceOccluded, sceneExposureTarget, sceneLightSourceLimit, sceneStellarDistanceFactor, selectSceneLightSources, type SceneEclipseLight } from "./scene-lighting";
import { getBodyType, isLuminousBody } from "@/simulation/body-catalog";
import { findOrbitalPrimary } from "@/simulation/orbital-analysis";
import { intersectPlacementPlane, orbitalPlacementDraftFromDrag, placementLaunchVelocity, placementPointOnDepth, placementSafetyEnvelopeRadiusM } from "./scene-placement";
import { calculateApproximateLagrangePoints, type LagrangePoint } from "./lagrange-points";
import { createLagrangePointMarkers } from "./scene-lagrange-points";
import { RenderQualityController } from "./render-quality";
import { cometFocusMetrics } from "./comet-tail";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "@/simulation/world-seed";
import { captureScenePng, type SceneCapture } from "./scene-capture";
import { bodyLocalDirectionFromWorldHit, LaserPointerCapture } from "./laser-aim";

const ACTIVE_SCENE_DISPOSER = Symbol.for("astro.celestial-scene.active-disposer");

export type CelestialSceneState = {
  bodies: readonly CelestialBody[]; selectedBodyId: string; gravity: number; simulationTime: number;
  environmentSeed?: number; surfaceData?: SurfaceData; surfaceHeatData?: SurfaceHeatData;
  showOrbits: boolean; showTrails?: boolean; viewMode: "focus" | "system"; viewRequest: number; revision: number;
  eventFocusRequest?: { eventId: number; requestId: number } | null;
  rotatingFrame: boolean; simulationRunning: boolean;
  historySnapshot: AuthoritativeOrbitSnapshot;
  events: readonly SimulationEvent[]; eventGeneration: number;
  collisionMode: CollisionMode;
  placementBody?: CelestialBody | null;
  laserAim?: LaserAimConfiguration | null;
  trajectoryPreview?: TrajectoryPreviewResult | null;
  trajectoryPreviewStatus?: "idle" | "pending" | "unavailable";
  orbitalPlacement?: { mutation: OrbitalPlacementMutation; worldRevision: number; baseTimeSeconds: number } | null;
  orbitalPreview?: OrbitalMutationPreviewResponse | null;
};

type Options = {
  read: () => CelestialSceneState; onSelect: (id: string, additive?: boolean) => void;
  onRotatingFrameChange: (active: boolean) => void;
  onCreateLagrangeComet?: (point: LagrangePoint) => void;
  onPlaceBody: (positionM: Vector3, velocityMs: Vector3) => void;
  onFocusNavigationFallback?: (bodyId: string) => boolean;
  onCancelPlacement?(): void;
  onLaserShot?: (aim: LaserAimConfiguration, bodyLocalDirection: Vector3, acceptedRevision: number) => string | null;
  onCancelLaserAim?(): void;
  onTrajectoryPreviewRequest?: (candidate: CelestialBody) => void;
  onTrajectoryPreviewInvalidate?(): void;
  onTrajectoryPreviewCancel?(): void;
  onDraftMutation?: (mutation: OrbitalPlacementMutation | null) => void;
  consumeIntegrationSamples?: (snapshot: AuthoritativeOrbitSnapshot) => void;
  onLoaded: () => void; onError: (message: string | null) => void;
  onCaptureReady?: (capture: SceneCapture | null) => void;
};

type CameraFlight = { bodyId: string; startedAt: number; fromTarget: THREE.Vector3; fromOffset: THREE.Vector3; toOffset: THREE.Vector3; toTargetOffset: THREE.Vector3 };
type RotatingFrameTransition = { startedAt: number; fromDirection: THREE.Vector3; fromUp: THREE.Vector3 };
type BodyMaterialization = { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; startedAt: number };
const BODY_MATERIALIZATION_MS = 600;
const MAX_BODY_MATERIALIZATIONS = 8;
const MOVING_ORBIT_REFRESH_INTERVAL_MS = 250;
const NO_NEW_BODY_IDS: ReadonlySet<string> = new Set();

function reliefPayloadFingerprint(patches: unknown): string {
  if (!Array.isArray(patches)) return "invalid";
  let hash = 2166136261;
  let encoded: string | undefined;
  try { encoded = JSON.stringify(patches); } catch { return "invalid"; }
  if (encoded === undefined) return "invalid";
  for (let index = 0; index < encoded.length; index += 1) hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619);
  return `${patches.length}:${hash >>> 0}`;
}

export function selectUvSphereGeometry(
  modelGeometry?: THREE.BufferGeometry,
  createFallback: () => THREE.BufferGeometry = () => new THREE.SphereGeometry(1, 64, 32),
): THREE.BufferGeometry {
  if (modelGeometry?.getAttribute("uv")) return modelGeometry;
  modelGeometry?.dispose();
  const fallback = createFallback();
  if (!fallback.getAttribute("uv")) {
    fallback.dispose();
    throw new Error("Fallback sphere has no UV coordinates.");
  }
  return fallback;
}

function disposeSphereAsset(root: THREE.Object3D, keepGeometry?: THREE.BufferGeometry): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.geometry !== keepGeometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach((entry) => entry.dispose());
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  textures.forEach((texture) => texture.dispose());
}

function disposeOrbits(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Line) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
  group.removeFromParent();
}

function eventFragmentIds(event: SimulationEvent): string[] {
  if (event.outcome?.kind === "creative-fragmentation") return event.outcome.fragmentBodyIds;
  return event.type === "explosion" ? event.bodyIds.slice(1) : [];
}

function eventResultBodyIds(event: SimulationEvent): string[] {
  if (event.type === "collision" && event.outcome?.kind === "perfectly-inelastic-merge") return [event.outcome.survivorBodyId];
  if (event.type === "black-hole-capture" && event.outcome?.kind === "creative-accretion") return [event.outcome.captorBodyId];
  const fragments = eventFragmentIds(event);
  return fragments.length ? fragments : [...event.bodyIds];
}

function isStellarGasVisual(event: SimulationEvent): boolean {
  return event.type === "explosion" && (event as SimulationEvent & { visualEffect?: unknown }).visualEffect === "stellar-gas-expansion";
}

function measureFragmentCluster(ids: readonly string[], bodies: readonly CelestialBody[], mapPosition: OrbitPositionMapper): { center: THREE.Vector3; extent: number; count: number } {
  const fragments = ids.map((id) => bodies.find((body) => body.id === id)).filter((body): body is CelestialBody => !!body);
  const center = new THREE.Vector3();
  let totalMass = 0;
  for (const body of fragments) {
    const weight = Math.max(body.massKg, 1);
    center.addScaledVector(mapPosition(body.positionM), weight);
    totalMass += weight;
  }
  if (totalMass > 0) center.multiplyScalar(1 / totalMass);
  let extent = 0;
  for (const body of fragments) {
    const position = mapPosition(body.positionM);
    extent = Math.max(extent, center.distanceTo(position) + toSceneRadius(renderedBodyRadius(body)));
  }
  return { center, extent, count: fragments.length };
}

function createSolarLensFlare(): { group: THREE.Group; dispose: () => void } {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const radius = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5);
    const alpha = Math.round(Math.max(0, 1 - radius) ** 2.4 * 210);
    pixels.set([255, 255, 255, alpha], (y * size + x) * 4);
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const group = new THREE.Group();
  group.name = "solar-lens-flare-artifact";
  group.renderOrder = 30;
  group.visible = false;
  const add = (name: string, color: number, opacity: number, stretch: number) => {
    const material = new THREE.SpriteMaterial({ map: texture, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false });
    const sprite = new THREE.Sprite(material);
    sprite.name = name;
    sprite.userData.baseOpacity = opacity;
    sprite.userData.stretch = stretch;
    group.add(sprite);
  };
  add("solar-lens-bloom", 0xffe2b1, 0.18, 0.16);
  add("solar-lens-streak", 0xffbd78, 0.1, 0.32);
  add("solar-lens-ghost", 0xc68a64, 0.08, 0.065);
  return { group, dispose: () => { texture.dispose(); group.children.forEach((child) => { if (child instanceof THREE.Sprite) child.material.dispose(); }); } };
}

export function createCelestialScene(host: HTMLDivElement, options: Options): () => void {
  const sceneHost = host as HTMLDivElement & Record<symbol, unknown>;
  const previousDisposer = sceneHost[ACTIVE_SCENE_DISPOSER];
  if (typeof previousDisposer === "function") previousDisposer();
  for (const child of Array.from(host.children)) {
    if (child instanceof HTMLCanvasElement && child.classList.contains("simulation-webgl")) child.remove();
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  const renderQuality = new RenderQualityController({ width: host.clientWidth, height: host.clientHeight, devicePixelRatio: window.devicePixelRatio, maxTextureSize: renderer.capabilities.maxTextureSize });
  renderer.setPixelRatio(renderQuality.pixelRatio);
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.className = "simulation-webgl";
  renderer.domElement.setAttribute("aria-label", "Universo em 3D. Arraste para girar e use a roda para aproximar. Selecione um astro pelo nome.");
  host.appendChild(renderer.domElement);
  const markers = document.createElement("div");
  markers.className = "scene-markers";
  markers.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
  host.appendChild(markers);
  const overviewScaleNote = document.createElement("div");
  overviewScaleNote.className = "scene-scale-note";
  overviewScaleNote.setAttribute("role", "note");
  overviewScaleNote.setAttribute("aria-label", "Vista geral com distâncias comprimidas apenas na imagem; valores, órbitas simuladas e colisões continuam usando medidas físicas.");
  overviewScaleNote.title = "A compressão é apenas visual; valores, órbitas simuladas e colisões continuam usando medidas físicas.";
  overviewScaleNote.textContent = "Distâncias orbitais comprimidas";
  overviewScaleNote.style.cssText = "position:absolute;z-index:2;padding:4px 8px;border:1px solid #8ab7d233;border-radius:999px;background:#07101bb8;color:#bdd4e7;font:11px/1.2 system-ui,sans-serif;letter-spacing:.01em;pointer-events:none;display:none";
  markers.appendChild(overviewScaleNote);
  const placementHint = document.createElement("div");
  placementHint.className = "scene-placement-hint";
  placementHint.setAttribute("role", "group");
  placementHint.setAttribute("aria-label", "Controles para posicionar astro");
  const placementInstructions = document.createElement("span");
  placementInstructions.className = "scene-placement-instructions";
  placementInstructions.textContent = "Clique ou toque coloca parado; arraste lança. A linha é uma previsão aproximada. Page Up/Down muda o plano; Enter confirma; Esc cancela.";
  const placementPrediction = document.createElement("output");
  placementPrediction.className = "scene-placement-prediction";
  const placementSpeedLabel = document.createElement("label");
  placementSpeedLabel.className = "scene-placement-speed-label";
  placementSpeedLabel.append("Velocidade do arrasto (km/s) ");
  const placementSpeedInput = document.createElement("input");
  placementSpeedInput.className = "scene-placement-speed-input";
  placementSpeedInput.type = "number";
  placementSpeedInput.min = "0";
  placementSpeedInput.max = "1000";
  placementSpeedInput.step = "0.1";
  placementSpeedInput.placeholder = "Auto";
  placementSpeedInput.setAttribute("aria-label", "Velocidade inicial do arrasto em quilômetros por segundo; vazio usa velocidade automática");
  placementSpeedLabel.appendChild(placementSpeedInput);
  const placementSpeedReadout = document.createElement("output");
  placementSpeedReadout.className = "scene-placement-speed-readout";
  placementSpeedReadout.textContent = "Arrasto: automático";
  const placementDepthReadout = document.createElement("output");
  placementDepthReadout.className = "scene-placement-depth-readout";
  placementDepthReadout.textContent = "Plano: 0 km";
  placementHint.append(placementInstructions, placementPrediction, placementSpeedLabel, placementSpeedReadout, placementDepthReadout);
  placementHint.style.cssText = "position:absolute;z-index:101;left:50%;top:112px;transform:translateX(-50%);max-width:min(520px,calc(100% - 24px));padding:8px 12px;border:1px solid #8db4de66;border-radius:8px;background:#0a1323e8;color:#e8f2ff;font:13px/1.35 system-ui,sans-serif;text-align:center;pointer-events:auto;display:none";
  markers.appendChild(placementHint);
  const orbitalPreviewLabel = document.createElement("div");
  orbitalPreviewLabel.textContent = "Prévia orbital · não confirmada";
  orbitalPreviewLabel.setAttribute("aria-live", "polite");
  orbitalPreviewLabel.style.cssText = "position:absolute;z-index:100;left:50%;top:76px;transform:translateX(-50%);padding:6px 10px;border:1px solid #9bc9dc66;border-radius:999px;background:#091321dc;color:#d7f0ff;font:12px/1.2 system-ui,sans-serif;pointer-events:none;display:none";
  markers.appendChild(orbitalPreviewLabel);
  const leaderLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  leaderLayer.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible";
  markers.appendChild(leaderLayer);
  const scene = new THREE.Scene();
  let highResolution = host.clientWidth >= 768 && renderer.capabilities.maxTextureSize >= 8192;
  const initialState = options.read();
  let observedSurfaceData = initialState.surfaceData;
  let surfacePayloadFingerprints = new Map(Object.entries(observedSurfaceData ?? {}).map(([dataId, patches]) => [dataId, reliefPayloadFingerprint(patches)]));
  const refreshSurfacePayloadFingerprints = (data: SurfaceData | undefined) => {
    if (data === observedSurfaceData) return;
    observedSurfaceData = data;
    surfacePayloadFingerprints = new Map(Object.entries(data ?? {}).map(([dataId, patches]) => [dataId, reliefPayloadFingerprint(patches)]));
  };
  let observedSurfaceHeatData = initialState.surfaceHeatData;
  let surfaceHeatPayloadFingerprints = new Map(Object.entries(observedSurfaceHeatData ?? {}).map(([dataId, patches]) => [dataId, reliefPayloadFingerprint(patches)]));
  const appliedSurfaceHeat = new Map<string, string>();
  const refreshSurfaceHeatFingerprints = (data: SurfaceHeatData | undefined) => {
    if (data === observedSurfaceHeatData) return;
    observedSurfaceHeatData = data;
    surfaceHeatPayloadFingerprints = new Map(Object.entries(data ?? {}).map(([dataId, patches]) => [dataId, reliefPayloadFingerprint(patches)]));
  };
  let environmentSeed = initialState.environmentSeed ?? DEFAULT_ENVIRONMENT_SEED_V1;
  const origin = dominantLightSource(initialState.bodies)?.positionM ?? [0, 0, 0];
  let overviewCenterPositionM: Vector3 = [...origin] as Vector3;
  let overviewCompressionBlend = initialState.viewMode === "system" && !initialState.rotatingFrame ? 1 : 0;
  let overviewCompressionFrom = overviewCompressionBlend, overviewCompressionTo = overviewCompressionBlend, overviewCompressionStartedAt = 0;
  const mapScenePosition: OrbitPositionMapper = (positionM) => new THREE.Vector3(...toOverviewScenePosition(positionM, origin, overviewCenterPositionM, overviewCompressionBlend));
  const scenePointToAcceptedPosition = (point: THREE.Vector3): Vector3 => fromOverviewScenePosition(point, origin, overviewCenterPositionM, overviewCompressionBlend);
  const rendererSpacePositionM = (positionM: Vector3): Vector3 => {
    const rendered = mapScenePosition(positionM);
    return [
      origin[0] + rendered.x / SCENE_UNITS_PER_METER,
      origin[1] + rendered.y / SCENE_UNITS_PER_METER,
      origin[2] + rendered.z / SCENE_UNITS_PER_METER,
    ];
  };
  let environment = createCelestialEnvironment(scene, highResolution, environmentSeed);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const eventEffects = new SceneEventEffects(scene, origin, () => reducedMotion.matches, mapScenePosition);
  const materializationGeometry = new THREE.SphereGeometry(1, 12, 8);
  const camera = new THREE.PerspectiveCamera(42, 1, 1e-7, CAMERA_FAR);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomSpeed = 0.8;
  controls.maxDistance = MAX_CAMERA_DISTANCE;
  controls.maxTargetRadius = MAX_SCENE_EXTENT_UNITS;
  // Illustrative light; intensity is not photometric calibration.
  const stellarLights = Array.from({ length: 4 }, (_, index) => {
    const light = new THREE.PointLight(0xfff3df, 0, 0, 0);
    light.name = `stellar-light-${index + 1}`;
    return light;
  });
  // Inspection fill keeps non-emissive surfaces readable; it is not a physical light source.
  const inspectionFill = new THREE.AmbientLight(0x8dabe0, 0.08);
  scene.add(...stellarLights, inspectionFill);
  const lensFlare = createSolarLensFlare();
  scene.add(lensFlare.group);
  const placementPreview = new THREE.Group();
  placementPreview.name = "placement-preview";
  placementPreview.renderOrder = 100;
  placementPreview.visible = false;
  const placementGhost = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0x78c6ff, wireframe: true, transparent: true, opacity: 0.82, depthWrite: false }));
  placementGhost.userData.visualOnly = true;
  placementPreview.add(placementGhost);
  const placementArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffc36e, 0.22, 0.12);
  placementArrow.visible = false;
  placementArrow.traverse((object) => {
    object.renderOrder = 100;
    const materials = object instanceof THREE.Mesh || object instanceof THREE.Line ? Array.isArray(object.material) ? object.material : [object.material] : [];
    materials.forEach((material) => { material.depthTest = false; material.depthWrite = false; });
  });
  (placementGhost.material as THREE.MeshBasicMaterial).depthTest = false;
  placementPreview.add(placementArrow);
  scene.add(placementPreview);
  const trajectoryPreviewGroup = new THREE.Group();
  trajectoryPreviewGroup.name = "trajectory-preview-visual-only";
  trajectoryPreviewGroup.visible = false;
  const trajectoryLineMaterial = new THREE.LineDashedMaterial({ color: 0x71d9ff, dashSize: 0.11, gapSize: 0.075, transparent: true, opacity: 0.88, depthWrite: false });
  const trajectoryContactGeometry = new THREE.SphereGeometry(1, 16, 10);
  const trajectoryContactMaterial = new THREE.MeshBasicMaterial({ color: 0xffc36e, wireframe: true, transparent: true, opacity: 0.9, depthWrite: false });
  let trajectoryLine: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial> | undefined;
  const trajectoryContactMarker = new THREE.Mesh(trajectoryContactGeometry, trajectoryContactMaterial);
  trajectoryContactMarker.name = "trajectory-preview-contact-marker";
  trajectoryContactMarker.visible = false;
  trajectoryPreviewGroup.add(trajectoryContactMarker);
  scene.add(trajectoryPreviewGroup);
  const visuals = new Map<string, BodyVisual>();
  const cometAwayFromStar = new THREE.Vector3(), cometRelativeVelocity = new THREE.Vector3();
  const bodyPickTargets = new Map<string, THREE.Object3D[]>();
  const pickTargets: THREE.Object3D[] = [];
  const labels = new Map<string, HTMLButtonElement>();
  const leaders = new Map<string, { line: SVGLineElement; dot: SVGCircleElement }>();
  const lagrangeMarkers = createLagrangePointMarkers(markers, (point) => options.onCreateLagrangeComet?.(point));
  const initialFocusBody = initialState.bodies.find((body) => body.id === initialState.selectedBodyId) ?? initialState.bodies[0];
  const initialMode = initialState.collisionMode ?? "scientific";
  const initialFocusRadius = initialFocusBody ? blackHoleVisualRadius(initialFocusBody, initialMode) : 1;
  const focus: CameraFocusState = {
    bodyId: null, position: new THREE.Vector3(), aspect: camera.aspect,
    fitDistance: focusCameraFitDistance(toSceneRadius(initialFocusRadius), camera.aspect, camera.fov),
  };
  let cameraFlight: CameraFlight | undefined, initializedFocus = false, currentFrameAt = 0, lastControlChangeAt = -Infinity;
  let rotatingFrameRequested = initialState.rotatingFrame;
  let rotatingFrameSuppressed = false, rotatingFrameActive = false, rotatingFrameManualHold = false;
  let rotatingFrameTransition: RotatingFrameTransition | undefined, rotatingFramePairKey: string | undefined;
  const cancelCameraFlight = () => { cameraFlight = undefined; };
  const leaveRotatingFrame = () => {
    if (!rotatingFrameActive) return;
    rotatingFrameSuppressed = true;
    rotatingFrameActive = false;
    rotatingFrameTransition = undefined;
    rotatingFramePairKey = undefined;
    rotatingFrameManualHold = true;
    options.onRotatingFrameChange(false);
  };
  controls.addEventListener("start", cancelCameraFlight);
  const onControlsChange = () => { lastControlChangeAt = currentFrameAt; };
  controls.addEventListener("change", onControlsChange);
  const beginFocusFlight = (body: CelestialBody, position: THREE.Vector3, radius: number, extent: number, minimumDistance: number | undefined, collisionMode: CollisionMode, viewport: SceneViewport, now: number, preserveZoom: boolean) => {
    const destinationCamera = camera.clone();
    const destinationControls = { target: controls.target.clone(), cursor: controls.cursor.clone(), minDistance: controls.minDistance, maxDistance: controls.maxDistance, maxTargetRadius: controls.maxTargetRadius };
    const destinationFocus: CameraFocusState = { ...focus, position: focus.position.clone() };
    const zoomRatio = preserveZoom && focus.fitDistance > 0 ? camera.position.distanceTo(controls.target) / focus.fitDistance : 1;
    const viewDirection = camera.position.clone().sub(controls.target).normalize();
    focusCameraOnBody(destinationCamera, destinationControls, body.id, position, radius, destinationFocus, viewport, host.clientWidth, host.clientHeight, extent, minimumDistance, bodyAppearanceKey(body, collisionMode));
    const destinationDistance = Math.max(destinationControls.minDistance, destinationFocus.fitDistance * zoomRatio);
    const destinationOffset = destinationCamera.position.clone().sub(destinationControls.target);
    if (destinationOffset.lengthSq() > 0) destinationCamera.position.copy(destinationControls.target).addScaledVector(viewDirection.lengthSq() > 0 ? viewDirection : destinationOffset.normalize(), destinationDistance);
    cameraFlight = {
      bodyId: body.id, startedAt: now, fromTarget: controls.target.clone(), fromOffset: camera.position.clone().sub(controls.target),
      toOffset: destinationCamera.position.clone().sub(destinationControls.target), toTargetOffset: destinationControls.target.clone().sub(position),
    };
    Object.assign(focus, destinationFocus);
  };
  const appearanceKeys = new Map<string, string>();
  const rockyFragmentIds = new Set<string>();
  const fragmentHeatStartedAt = new Map<string, number>();
  const orbitTrailLine = addOrbitTrailToScene(scene);
  const orbitTrailState = createOrbitTrailState();
  let geometry: THREE.BufferGeometry | undefined, active = true, frame = 0;
  let rockAssets: RockSurfaceAssets | undefined;
  let orbitGroup = new THREE.Group(), orbitAt = -Infinity, orbitRevision = -1, orbitBodyCount = -1;
  let orbitDetailedBodyId: string | undefined;
  let lastBodies: readonly CelestialBody[] = [], previousSnapshotBodies: readonly CelestialBody[] = [], snapshotAt = 0;
  let lastHistorySnapshot: CelestialSceneState["historySnapshot"] | undefined;
  let previousTime = 0, displayedTime = 0;
  let previousFrameAt = 0, lastRenderAt = -Infinity, lastMetricsAt = -Infinity, systemFitExtent = 0, systemFitDistance = 0, safeViewportDirty = true, preserveSystemFit = false;
  let eclipseInputs: { state: CelestialSceneState; bodies: CelestialBody[]; lightSources: ReturnType<typeof selectSceneLightSources>; renderedRadiusM: (body: CelestialBody) => number; collisionMode: CollisionMode } | undefined;
  let lastEclipseGeometryKey: string | undefined;
  let collisionSystemFitHold: { revision: number; eventGeneration: number } | undefined;
  let sceneExposure = 1;
  let cachedOrbitExtent = 0;
  const bodyExtentCache: { bodies?: readonly CelestialBody[]; extent: number; renderedEnvelope?: boolean } = { extent: 0 };
  let lastCollisionMode = initialMode;
  let fragmentGeneration = initialState.eventGeneration;
  const seenCameraEvents = new Set<number>();
  let lastEventFocusRequestId = initialState.eventFocusRequest?.requestId ?? 0;
  let eventCameraHold: { viewMode: CelestialSceneState["viewMode"]; viewRequest: number; generation: number } | undefined;
  let impactImpulse: { startedAt: number; amplitude: number; phase: number } | undefined;
  let consumedPlacement: CelestialBody | null = null, placementDrag: { pointerId: number; x: number; y: number; currentX: number; currentY: number; start: THREE.Vector3; current: THREE.Vector3 } | null = null;
  let orbitalGesture: { pointerId: number; anchorId: string; worldRevision: number; baseTimeSeconds: number; viewMode: CelestialSceneState["viewMode"]; viewRequest: number; planeNormal: THREE.Vector3 } | null = null;
  let orbitalDraft: OrbitalPlacementMutation | null = null;
  let orbitalBasis = "";
  let renderedOrbitalPreview: OrbitalMutationPreviewResponse | null | undefined;
  let renderedOrbitalPreviewBasis = "";
  let acceptedOrbitalPreview: { revision: number; eventGeneration: number; expiresAt: number; poses: Map<string, { positionM: Vector3; velocityMs: Vector3 }> } | undefined;
  let orbitalPathHighlight: { ids: Set<string>; startedAt: number } | undefined;
  let laserAimPointer: { pointerId: number; bodyId: string; acceptedRevision: number } | null = null;
  const laserPointerCapture = new LaserPointerCapture(renderer.domElement);
  let trajectoryPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let trajectoryPreviewSequence = 0;
  let renderedTrajectoryPreview: TrajectoryPreviewResult | null | undefined;
  let renderedTrajectoryPreviewStatus: CelestialSceneState["trajectoryPreviewStatus"];
  const placementPoint = new THREE.Vector3();
  const placementViewDirection = new THREE.Vector3();
  let placementDepthOffset = 0;
  let hasPlacementPoint = false, wasPlacementActive = false;
  const displayedAppearance = new Map<string, { radiusM: number; surfaceTemperatureK: number }>();
  const setRenderedOverviewScale = (body: CelestialBody, visual: BodyVisual, depth: number, blend: number, collisionMode: CollisionMode) => {
    const bodyType = getBodyType(body), physicalRadius = bodyType === "black-hole" ? renderedBodyRadius(body) : displayedAppearance.get(body.id)?.radiusM ?? body.radiusM;
    const creativeHole = bodyType === "black-hole" && collisionMode === "creative";
    const extentFactor = creativeHole ? blackHoleVisualExtent(body, collisionMode) / Math.max(physicalRadius, 1) : 1;
    const assistRadius = toSceneRadius(creativeHole ? blackHoleVisualExtent(body, collisionMode) : physicalRadius);
    const assisted = assistedOverviewRadius(assistRadius, body.kind, bodyType, Math.max(depth, 1e-9), camera.fov, host.clientHeight, creativeHole ? 12 : undefined) / extentFactor;
    visual.group.scale.setScalar(THREE.MathUtils.lerp(toSceneRadius(physicalRadius), assisted, THREE.MathUtils.clamp(blend, 0, 1)));
  };
  const materializations = new Map<string, BodyMaterialization>();
  let materializationGeneration = initialState.eventGeneration;
  let observedBodySnapshot = initialState.bodies;
  let knownBodyIds = new Set(initialState.bodies.map((body) => body.id));
  const appliedAtmosphereBodies = new Map<string, CelestialBody>();
  let appliedAtmosphereGravity = Number.NaN;
  let lastView = "", lastRequest = -1, lastSelectedBodyId = initialState.selectedBodyId;
  const projected = new THREE.Vector3(), cameraSpace = new THREE.Vector3();
  let hoveredBodyId: string | null = null;
  const appearanceKeyFor = (body: CelestialBody, mode: CollisionMode) => `${bodyAppearanceKey(body, mode)}${isDebrisBody(body, rockyFragmentIds) ? ":rocky-fragment" : ""}`
    + (body.surface ? `:surface:${body.surface.dataId}:${body.surface.revision}:${surfacePayloadFingerprints.get(body.surface.dataId) ?? "missing"}` : ":surface:none");
  let safeViewport: SceneViewport = { left: 25, top: 145, right: host.clientWidth - 25, bottom: host.clientHeight - 200 };
  const effectViewport = { ...safeViewport, width: host.clientWidth, height: host.clientHeight };
  const orbitalGhostGroup = new THREE.Group();
  orbitalGhostGroup.name = "orbital-mutation-preview-ghosts";
  scene.add(orbitGroup, orbitalGhostGroup);

  const clearOrbitalGhosts = () => {
    for (const ghost of [...orbitalGhostGroup.children]) {
      orbitalGhostGroup.remove(ghost);
      if (ghost instanceof THREE.Mesh || ghost instanceof THREE.Line) {
        ghost.geometry.dispose();
        const materials = Array.isArray(ghost.material) ? ghost.material : [ghost.material];
        materials.forEach((material) => material.dispose());
      }
    }
  };
  const restoreOrbitalControls = () => { controls.enabled = !options.read().placementBody && !laserAimPointer; };
  const clearOrbitalDraft = (notify = true) => {
    const pointerId = orbitalGesture?.pointerId;
    const hadDraft = orbitalDraft !== null || orbitalGesture !== null;
    orbitalGesture = null;
    orbitalDraft = null;
    restoreOrbitalControls();
    if (pointerId !== undefined) {
      try { renderer.domElement.releasePointerCapture(pointerId); } catch { /* Capture can end before cancellation runs. */ }
    }
    if (notify && hadDraft) options.onDraftMutation?.(null);
  };
  const anchorIdForMutation = (mutation: OrbitalPlacementMutation) => mutation.type === "SET_ORBITAL_PAIR" ? mutation.firstBodyId : mutation.primaryId;
  const orbitalPlacementIsCurrent = (state: CelestialSceneState) => {
    const placement = state.orbitalPlacement;
    return placement && placement.worldRevision === state.revision && placement.baseTimeSeconds === state.simulationTime
      && state.bodies.some((body) => body.id === anchorIdForMutation(placement.mutation)) ? placement : null;
  };
  const updateOrbitalDraft = (gesture: NonNullable<typeof orbitalGesture>, point: THREE.Vector3) => {
    const state = options.read(), placement = orbitalPlacementIsCurrent(state);
    if (!placement || anchorIdForMutation(placement.mutation) !== gesture.anchorId) { clearOrbitalDraft(); return; }
    const anchor = visuals.get(gesture.anchorId)?.group.position;
    if (!anchor) { clearOrbitalDraft(); return; }
    const draft = orbitalPlacementDraftFromDrag(placement.mutation, anchor, point, gesture.planeNormal);
    orbitalDraft = draft;
    options.onDraftMutation?.(draft);
  };
  const refreshOrbitalGhosts = (state: CelestialSceneState) => {
    const preview = state.orbitalPreview ?? null;
    const placement = orbitalPlacementIsCurrent(state);
    const basis = `${state.revision}:${state.simulationTime}:${placement?.mutation.type ?? ""}:${preview?.requestId ?? ""}`;
    if (preview === renderedOrbitalPreview && basis === renderedOrbitalPreviewBasis) return;
    clearOrbitalGhosts();
    orbitalPreviewLabel.style.display = "none";
    renderedOrbitalPreview = preview;
    renderedOrbitalPreviewBasis = basis;
    if (!placement || !preview || preview.worldRevision !== state.revision || preview.baseTimeSeconds !== state.simulationTime || preview.result?.status !== "ready") return;
    const candidates = preview.result.candidates.slice(0, 64);
    if (!candidates.length) return;
    acceptedOrbitalPreview = {
      revision: state.revision, eventGeneration: state.eventGeneration, expiresAt: performance.now() + 5000,
      poses: new Map(candidates.map(({ bodyId, positionM, velocityMs }) => [bodyId, { positionM, velocityMs }])),
    };
    for (const candidate of preview.result.candidates) {
      if (orbitalGhostGroup.children.length >= 64) break;
      const position = mapScenePosition(candidate.positionM);
      const radius = Math.max(camera.position.distanceTo(position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, host.clientHeight) * 6, 1e-8);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color: 0x8bd5ff, transparent: true, opacity: 0.38, depthWrite: false }));
      mesh.name = `orbital-preview:${candidate.bodyId}`;
      mesh.userData.nonPickable = true;
      mesh.userData.visualOnly = true;
      mesh.position.copy(position);
      orbitalGhostGroup.add(mesh);
    }
    const candidateById = new Map(candidates.map((candidate) => [candidate.bodyId, candidate]));
    const addPath = (positionM: Vector3, velocityMs: Vector3, centerM: Vector3, centerVelocity: Vector3, color: number) => {
      const relativePosition = new THREE.Vector3(...positionM).sub(new THREE.Vector3(...centerM));
      const relativeVelocity = new THREE.Vector3(...velocityMs).sub(new THREE.Vector3(...centerVelocity));
      const normal = new THREE.Vector3().crossVectors(relativePosition, relativeVelocity);
      const line = createCircularOrbitPreviewPath(centerM, relativePosition.length(), normal.toArray() as Vector3, origin, color, mapScenePosition);
      if (line) orbitalGhostGroup.add(line);
    };
    const mutation = placement.mutation;
    if (mutation.type === "CREATE_ORBITAL_RING") {
      const primary = state.bodies.find(({ id }) => id === mutation.primaryId);
      const primaryCandidate = candidateById.get(mutation.primaryId);
      const center = primaryCandidate?.positionM ?? primary?.positionM;
      const velocity = primaryCandidate?.velocityMs ?? primary?.velocityMs;
      if (center && velocity) {
        const normal = new THREE.Vector3();
        for (const candidate of candidates) {
          const r = new THREE.Vector3(...candidate.positionM).sub(new THREE.Vector3(...center));
          const v = new THREE.Vector3(...candidate.velocityMs).sub(new THREE.Vector3(...velocity));
          normal.add(new THREE.Vector3().crossVectors(r, v));
        }
        const guide = createOrbitalRingPreviewGuide(center, mutation.innerRadiusM, mutation.outerRadiusM, normal.toArray() as Vector3, origin, mapScenePosition);
        if (guide) orbitalGhostGroup.add(guide);
      }
    } else if (mutation.type === "SET_ORBITAL_PAIR") {
      const first = state.bodies.find(({ id }) => id === mutation.firstBodyId);
      const second = state.bodies.find(({ id }) => id === mutation.secondBodyId);
      const firstPose = candidateById.get(mutation.firstBodyId), secondPose = candidateById.get(mutation.secondBodyId);
      if (first && second && firstPose && secondPose) {
        const totalMass = first.massKg + second.massKg;
        if (Number.isFinite(totalMass) && totalMass > 0) {
          const center: Vector3 = [
            (firstPose.positionM[0] * first.massKg + secondPose.positionM[0] * second.massKg) / totalMass,
            (firstPose.positionM[1] * first.massKg + secondPose.positionM[1] * second.massKg) / totalMass,
            (firstPose.positionM[2] * first.massKg + secondPose.positionM[2] * second.massKg) / totalMass,
          ];
          const centerVelocity: Vector3 = [
            (firstPose.velocityMs[0] * first.massKg + secondPose.velocityMs[0] * second.massKg) / totalMass,
            (firstPose.velocityMs[1] * first.massKg + secondPose.velocityMs[1] * second.massKg) / totalMass,
            (firstPose.velocityMs[2] * first.massKg + secondPose.velocityMs[2] * second.massKg) / totalMass,
          ];
          const normal = new THREE.Vector3().crossVectors(new THREE.Vector3(...firstPose.positionM).sub(new THREE.Vector3(...secondPose.positionM)), new THREE.Vector3(...firstPose.velocityMs).sub(new THREE.Vector3(...secondPose.velocityMs)));
          for (const [body, pose] of [[first, firstPose], [second, secondPose]] as const) {
            const line = createCircularOrbitPreviewPath(center, new THREE.Vector3(...pose.positionM).distanceTo(new THREE.Vector3(...center)), normal.toArray() as Vector3, origin, orbitPathColor(body), mapScenePosition);
            if (line) orbitalGhostGroup.add(line);
          }
        }
      }
    } else {
      const primary = state.bodies.find(({ id }) => id === mutation.primaryId);
      const candidate = candidates.find(({ bodyId }) => !state.bodies.some(({ id }) => id === bodyId));
      if (primary && candidate) {
        const pose = candidateById.get(primary.id);
        addPath(candidate.positionM, candidate.velocityMs, pose?.positionM ?? primary.positionM, pose?.velocityMs ?? primary.velocityMs, orbitPathColorForBodyType(mutation.bodyType));
      }
    }
    orbitalPreviewLabel.style.display = "block";
  };

  const readPlacementBody = () => {
    const body = options.read().placementBody ?? null;
    if (!body) consumedPlacement = null;
    return body === consumedPlacement ? null : body;
  };
  const cancelLaserAimPointer = (notify = true) => {
    const pointerId = laserAimPointer?.pointerId;
    laserAimPointer = null;
    controls.enabled = true;
    if (pointerId !== undefined) laserPointerCapture.cancel();
    if (notify && options.read().laserAim) options.onCancelLaserAim?.();
  };

  const unregisterBodyPickTargets = (id: string) => {
    const removed = new Set(bodyPickTargets.get(id) ?? []);
    if (!removed.size) return;
    for (let index = pickTargets.length - 1; index >= 0; index -= 1) if (removed.has(pickTargets[index]!)) pickTargets.splice(index, 1);
    bodyPickTargets.delete(id);
  };

  const registerBodyPickTargets = (id: string, group: THREE.Group) => {
    const targets: THREE.Object3D[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh && typeof object.userData.bodyId === "string") targets.push(object);
    });
    bodyPickTargets.set(id, targets);
    pickTargets.push(...targets);
  };

  const applyAcceptedAtmosphere = (body: CelestialBody, gravity: number) => {
    const visual = visuals.get(body.id);
    visual?.setAtmosphereMetrics?.(body.atmosphere ? deriveAtmosphereMetrics(body, gravity) : undefined);
  };

  const addBody = (body: CelestialBody, collisionMode: CollisionMode) => {
    const state = options.read();
    refreshSurfacePayloadFingerprints(state.surfaceData);
    refreshSurfaceHeatFingerprints(state.surfaceHeatData);
    const visual = createBodyVisual(body, geometry!, Math.min(renderer.capabilities.getMaxAnisotropy(), 8), highResolution, collisionMode, rockAssets,
      isDebrisBody(body, rockyFragmentIds), body.surface ? state.surfaceData?.[body.surface.dataId] : undefined);
    visuals.set(body.id, visual);
    applyAcceptedAtmosphere(body, options.read().gravity);
    registerBodyPickTargets(body.id, visual.group);
    appearanceKeys.set(body.id, appearanceKeyFor(body, collisionMode));
    scene.add(visual.group);
    const label = document.createElement("button");
    label.type = "button";
    label.className = "scene-body-label";
    label.style.cssText = "position:absolute;pointer-events:auto;display:none";
    label.textContent = body.name;
    label.setAttribute("aria-label", `Selecionar ${body.name}`);
    label.addEventListener("click", (event) => options.onSelect(body.id, event.shiftKey));
    label.addEventListener("pointerenter", () => { hoveredBodyId = body.id; });
    label.addEventListener("pointerleave", () => { if (hoveredBodyId === body.id) hoveredBodyId = null; });
    markers.appendChild(label);
    labels.set(body.id, label);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", "#8db4de55"); line.setAttribute("stroke-width", "1");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", "2"); dot.setAttribute("fill", "#b7d4f5");
    leaderLayer.append(line, dot); leaders.set(body.id, { line, dot });
    return visual;
  };
  const replaceBodyVisual = (body: CelestialBody, collisionMode: CollisionMode) => {
    const previous = visuals.get(body.id);
    if (!previous || !geometry) return;
    const state = options.read();
    refreshSurfacePayloadFingerprints(state.surfaceData);
    refreshSurfaceHeatFingerprints(state.surfaceHeatData);
    const visual = createBodyVisual(body, geometry, Math.min(renderer.capabilities.getMaxAnisotropy(), 8), highResolution, collisionMode, rockAssets,
      isDebrisBody(body, rockyFragmentIds), body.surface ? state.surfaceData?.[body.surface.dataId] : undefined);
    visual.setAtmosphereMetrics?.(body.atmosphere ? deriveAtmosphereMetrics(body, options.read().gravity) : undefined);
    visual.group.position.copy(previous.group.position);
    visual.group.quaternion.copy(previous.group.quaternion);
    visual.group.scale.copy(previous.group.scale);
    visual.group.visible = previous.group.visible;
    const materialization = materializations.get(body.id);
    materialization?.mesh.removeFromParent();
    unregisterBodyPickTargets(body.id);
    previous.group.removeFromParent();
    previous.dispose();
    appliedSurfaceHeat.delete(body.id);
    visuals.set(body.id, visual);
    lastEclipseGeometryKey = undefined;
    appearanceKeys.set(body.id, appearanceKeyFor(body, collisionMode));
    scene.add(visual.group);
    registerBodyPickTargets(body.id, visual.group);
    if (materialization) visual.group.add(materialization.mesh);
  };
  const clearMaterialization = (id: string) => {
    const effect = materializations.get(id);
    if (!effect) return;
    effect.mesh.removeFromParent();
    effect.material.dispose();
    materializations.delete(id);
  };
  const addMaterialization = (id: string, visual: BodyVisual, now: number) => {
    while (materializations.size >= MAX_BODY_MATERIALIZATIONS) clearMaterialization(materializations.keys().next().value!);
    const material = new THREE.MeshBasicMaterial({ color: 0x9acbff, transparent: true, opacity: 0, wireframe: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(materializationGeometry, material);
    mesh.name = "accepted-body-materialization";
    mesh.renderOrder = 8;
    visual.group.add(mesh);
    materializations.set(id, { mesh, material, startedAt: now });
  };

  void loadRockSurfaceAssets(Math.min(renderer.capabilities.getMaxAnisotropy(), 8)).then((assets) => {
    if (!assets) return;
    if (!active) { assets.dispose(); return; }
    rockAssets = assets;
    for (const body of lastBodies) {
      const previous = visuals.get(body.id);
      if (!previous) continue;
      const debris = isDebrisBody(body, rockyFragmentIds);
      if (getBodyType(body) === "rocky-planet" && !debris) {
        applyRockSurfaceAssetsToVisual(body, previous, rockAssets);
        continue;
      }
      if (getBodyType(body) !== "asteroid" && !debris) continue;
      replaceBodyVisual(body, lastCollisionMode);
    }
  }).catch(() => undefined);

  const animate = (now: number) => {
    if (!active) return;
    frame = 0;
    if (document.visibilityState === "hidden") { previousFrameAt = 0; return; }
    frame = requestAnimationFrame(animate);
    currentFrameAt = now;
    const frameIntervalMs = previousFrameAt > 0 ? now - previousFrameAt : 0;
    const state = options.read();
    const previousOverviewBlend = overviewCompressionBlend;
    const nextOverviewTarget = state.viewMode === "system" && !state.rotatingFrame ? 1 : 0;
    if (nextOverviewTarget !== overviewCompressionTo) {
      overviewCompressionFrom = overviewCompressionBlend;
      overviewCompressionTo = nextOverviewTarget;
      overviewCompressionStartedAt = now;
      if (reducedMotion.matches) overviewCompressionBlend = nextOverviewTarget;
    }
    if (overviewCompressionBlend !== overviewCompressionTo) {
      const progress = THREE.MathUtils.clamp((now - overviewCompressionStartedAt) / OVERVIEW_POSITION_TRANSITION_MS, 0, 1);
      overviewCompressionBlend = interpolateOverviewCompression(overviewCompressionFrom, overviewCompressionTo, progress);
      if (progress >= 1) overviewCompressionFrom = overviewCompressionTo;
    }
    const overviewBlendChanged = Math.abs(overviewCompressionBlend - previousOverviewBlend) > 1e-5;
    const activeOrbitalPlacement = orbitalPlacementIsCurrent(state);
    const nextOrbitalBasis = activeOrbitalPlacement
      ? `${anchorIdForMutation(activeOrbitalPlacement.mutation)}:${state.revision}:${state.simulationTime}:${state.viewMode}:${state.viewRequest}` : "";
    if (nextOrbitalBasis !== orbitalBasis) {
      clearOrbitalDraft();
      orbitalBasis = nextOrbitalBasis;
    }
    refreshOrbitalGhosts(state);
    if (laserAimPointer && (!state.laserAim || state.laserAim.bodyId !== laserAimPointer.bodyId
      || state.revision !== laserAimPointer.acceptedRevision)) cancelLaserAimPointer(false);
    refreshSurfacePayloadFingerprints(state.surfaceData);
    refreshSurfaceHeatFingerprints(state.surfaceHeatData);
    const nextEnvironmentSeed = state.environmentSeed ?? DEFAULT_ENVIRONMENT_SEED_V1;
    if (nextEnvironmentSeed !== environmentSeed) {
      environmentSeed = nextEnvironmentSeed;
      scene.remove(environment.group);
      environment.dispose();
      environment = createCelestialEnvironment(scene, highResolution, environmentSeed);
    }
    if (state.gravity !== appliedAtmosphereGravity) {
      appliedAtmosphereBodies.clear();
      appliedAtmosphereGravity = state.gravity;
    }
    const activeAtmosphereIds = new Set(state.bodies.map((body) => body.id));
    for (const body of state.bodies) {
      if (appliedAtmosphereBodies.get(body.id) === body) continue;
      applyAcceptedAtmosphere(body, state.gravity);
      appliedAtmosphereBodies.set(body.id, body);
    }
    for (const id of appliedAtmosphereBodies.keys()) if (!activeAtmosphereIds.has(id)) appliedAtmosphereBodies.delete(id);
    if (collisionSystemFitHold && (collisionSystemFitHold.revision !== state.revision || collisionSystemFitHold.eventGeneration !== state.eventGeneration)) collisionSystemFitHold = undefined;
    if (state.rotatingFrame !== rotatingFrameRequested) {
      rotatingFrameRequested = state.rotatingFrame;
      rotatingFrameSuppressed = false;
    }
    if (materializationGeneration !== state.eventGeneration) {
      for (const id of [...materializations.keys()]) clearMaterialization(id);
      materializationGeneration = state.eventGeneration;
      observedBodySnapshot = state.bodies;
      knownBodyIds = new Set(state.bodies.map((body) => body.id));
    }
    const bodiesChanged = state.bodies !== observedBodySnapshot;
    const newBodyIds = bodiesChanged ? new Set(state.bodies.filter((body) => !knownBodyIds.has(body.id)).map((body) => body.id)) : NO_NEW_BODY_IDS;
    if (acceptedOrbitalPreview) {
      if (state.eventGeneration !== acceptedOrbitalPreview.eventGeneration || now > acceptedOrbitalPreview.expiresAt) {
        acceptedOrbitalPreview = undefined;
      } else if (state.revision !== acceptedOrbitalPreview.revision) {
        const accepted = [...acceptedOrbitalPreview.poses].every(([id, pose]) => {
          const body = state.bodies.find((candidate) => candidate.id === id);
          if (!body) return false;
          const positionTolerance = Math.max(1, Math.hypot(...pose.positionM)) * 1e-10;
          const velocityTolerance = Math.max(1, Math.hypot(...pose.velocityMs)) * 1e-10;
          return Math.hypot(...body.positionM.map((value, axis) => value - pose.positionM[axis]!)) <= positionTolerance
            && Math.hypot(...body.velocityMs.map((value, axis) => value - pose.velocityMs[axis]!)) <= velocityTolerance;
        });
        if (accepted && acceptedOrbitalPreview.poses.size > 0) {
          if (!reducedMotion.matches) orbitalPathHighlight = { ids: new Set(acceptedOrbitalPreview.poses.keys()), startedAt: now };
          acceptedOrbitalPreview = undefined;
        } else if (state.revision > acceptedOrbitalPreview.revision) acceptedOrbitalPreview = undefined;
      }
    }
    const eventCoveredIds = newBodyIds.size ? new Set(state.events.flatMap((event) => event.type === "explosion" || event.outcome?.kind === "creative-fragmentation" ? eventFragmentIds(event) : [])) : undefined;
    if (reducedMotion.matches) for (const id of [...materializations.keys()]) clearMaterialization(id);
    const collisionMode = state.collisionMode ?? "scientific";
    if (fragmentGeneration !== state.eventGeneration) {
      fragmentGeneration = state.eventGeneration;
      rockyFragmentIds.clear(); fragmentHeatStartedAt.clear(); seenCameraEvents.clear(); eventCameraHold = undefined; impactImpulse = undefined;
    }
    if (!state.placementBody) consumedPlacement = null;
    const placementBody = state.placementBody && state.placementBody !== consumedPlacement ? state.placementBody : null;
    if (!placementBody && wasPlacementActive) cancelTrajectoryPreview();
    controls.enabled = !state.placementBody && !laserAimPointer && !orbitalGesture;
    renderer.domElement.style.touchAction = state.placementBody || state.laserAim ? "none" : touchAction;
    const placementInstruction = placementBody?.parentId
      ? "Clique ou toque mantém velocidade da origem; arraste define lançamento. A linha é uma previsão aproximada. Page Up/Down muda o plano; Enter confirma; Esc cancela."
      : "Clique ou toque coloca parado; arraste lança. A linha é uma previsão aproximada. Page Up/Down muda o plano; Enter confirma; Esc cancela.";
    if (placementInstructions.textContent !== placementInstruction) placementInstructions.textContent = placementInstruction;
    placementHint.style.display = placementBody ? "grid" : "none";
    placementPreview.visible = !!placementBody;
    if (placementBody) {
      if (!wasPlacementActive) {
        placementDepthOffset = 0;
        placementSpeedInput.value = "";
        placementSpeedReadout.textContent = "Arrasto: automático";
        placementDepthReadout.textContent = "Plano: 0 km";
        renderer.domElement.focus({ preventScroll: true });
        placementPoint.copy(controls.target); hasPlacementPoint = true;
        const viewport = getSafeCameraViewport(host);
        safeViewport = viewport;
        safeViewportDirty = false;
        applySafeCameraViewport(camera, viewport, host.clientWidth, host.clientHeight);
        const reference = state.bodies.reduce<CelestialBody | undefined>((closest, body) => {
          const distance = mapScenePosition(body.positionM).distanceToSquared(controls.target);
          return !closest || distance < mapScenePosition(closest.positionM).distanceToSquared(controls.target) ? body : closest;
        }, undefined);
        if (reference) {
          const safeWidth = (viewport.right - viewport.left) / Math.max(1, host.clientWidth);
          const safeHeight = (viewport.bottom - viewport.top) / Math.max(1, host.clientHeight);
          const radius = toSceneRadius(placementSafetyEnvelopeRadiusM(placementBody, reference, state.gravity));
          const neededDistance = focusCameraFitDistance(radius, camera.aspect, camera.fov, safeWidth, safeHeight);
          const offset = camera.position.clone().sub(controls.target);
          if (offset.length() < neededDistance) camera.position.copy(controls.target).add(offset.lengthSq() > 0 ? offset.setLength(Math.min(neededDistance, MAX_CAMERA_DISTANCE)) : offset.set(0, -1, 0).setLength(Math.min(neededDistance, MAX_CAMERA_DISTANCE)));
          camera.lookAt(controls.target);
        }
        requestPlacementPreview(placementBody);
      }
      if (!hasPlacementPoint) { placementPoint.copy(controls.target); hasPlacementPoint = true; }
      placementPreview.position.copy(placementPoint);
      const type = getBodyType(placementBody);
      const previewRadius = type === "black-hole" ? blackHoleVisualRadius(placementBody, collisionMode) : renderedBodyRadius(placementBody);
      const distance = Math.max(camera.position.distanceTo(placementPoint), 1e-9);
      const visibleRadius = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, host.clientHeight) * 11;
      placementGhost.scale.setScalar(Math.max(toSceneRadius(previewRadius), visibleRadius));
      const previewMaterial = placementGhost.material as THREE.MeshBasicMaterial;
      previewMaterial.color.setHex(type === "black-hole" ? 0xb88aff : type === "asteroid" || type === "comet" ? 0xc5b8a2 : type === "star" ? 0xffb56d : 0x78c6ff);
    } else {
      placementArrow.visible = false;
      if (!state.placementBody) { placementDrag = null; hasPlacementPoint = false; }
    }
    const trajectoryPreview = state.trajectoryPreview ?? null;
    const trajectoryPreviewStatus = state.trajectoryPreviewStatus ?? "idle";
    if (trajectoryPreview !== renderedTrajectoryPreview || trajectoryPreviewStatus !== renderedTrajectoryPreviewStatus || overviewBlendChanged) {
      if (trajectoryLine) {
        trajectoryPreviewGroup.remove(trajectoryLine);
        trajectoryLine.geometry.dispose();
        trajectoryLine = undefined;
      }
      trajectoryContactMarker.visible = false;
      renderedTrajectoryPreview = trajectoryPreview;
      if (trajectoryPreview && trajectoryPreview.points.length > 1) {
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(trajectoryPreview.points.map(mapScenePosition));
        trajectoryLine = new THREE.Line(lineGeometry, trajectoryLineMaterial);
        trajectoryLine.name = "approximate-trajectory-preview";
        trajectoryLine.renderOrder = 7;
        trajectoryLine.computeLineDistances();
        trajectoryPreviewGroup.add(trajectoryLine);
      }
      if (trajectoryPreview?.contact) {
        trajectoryContactMarker.position.copy(mapScenePosition(trajectoryPreview.contact.positionM));
        trajectoryContactMarker.visible = true;
      }
      const status = state.trajectoryPreviewStatus ?? "idle";
      renderedTrajectoryPreviewStatus = status;
      const contactNames = trajectoryPreview?.contact?.bodyIds.map((id) => state.bodies.find((body) => body.id === id)?.name ?? (id.startsWith("trajectory-preview-") ? placementBody?.name ?? "astro" : "astro"));
      placementPrediction.textContent = trajectoryPreview?.contact
        ? `Contato provável em ${trajectoryPreview.contact.timeSeconds.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s${contactNames?.length ? ` · ${contactNames.join(" + ")}` : ""}. Não confirmado.`
        : trajectoryPreview ? "Trajetória aproximada; sem contato previsto em até 1 h."
          : status === "pending" ? "Calculando trajetória aproximada…"
            : status === "unavailable" ? "Prévia indisponível; ainda é possível posicionar."
              : "";
    }
    trajectoryPreviewGroup.visible = !!placementBody && !!trajectoryPreview;
    wasPlacementActive = !!placementBody;
    if (eventCameraHold && (eventCameraHold.viewMode !== state.viewMode || eventCameraHold.viewRequest !== state.viewRequest || eventCameraHold.generation !== state.eventGeneration)) eventCameraHold = undefined;
    for (const event of state.events) if (!seenCameraEvents.has(event.id)) {
      seenCameraEvents.add(event.id);
      if (seenCameraEvents.size > 64) seenCameraEvents.delete(seenCameraEvents.values().next().value!);
      if (event.type === "collision") collisionSystemFitHold = { revision: state.revision, eventGeneration: state.eventGeneration };
      const impulseAmplitude = event.type === "collision" ? 0.018 : event.type === "black-hole-capture" ? 0.014 : isStellarGasVisual(event) ? 0.012 : 0.024;
      if (!reducedMotion.matches && impulseAmplitude >= (impactImpulse?.amplitude ?? 0) * Math.max(0, 1 - (now - (impactImpulse?.startedAt ?? now)) / 420)) {
        impactImpulse = { startedAt: now, amplitude: impulseAmplitude, phase: event.id * 2.399963229728653 };
      }
      if (isStellarGasVisual(event)) continue;
      if (event.type !== "explosion" && event.outcome?.kind !== "creative-fragmentation") continue;
      const fragmentIds = eventFragmentIds(event);
      for (const id of fragmentIds) if (state.bodies.some((body) => body.id === id)) {
        rockyFragmentIds.add(id);
        fragmentHeatStartedAt.set(id, now);
      }
    }
    const eventFocusRequest = state.eventFocusRequest;
    if (eventFocusRequest && eventFocusRequest.requestId !== lastEventFocusRequestId) {
      lastEventFocusRequestId = eventFocusRequest.requestId;
      const event = state.events.find(({ id }) => id === eventFocusRequest.eventId);
      if (event) {
        const resultIds = eventResultBodyIds(event);
        const cluster = measureFragmentCluster(resultIds, state.bodies, mapScenePosition);
        const eventPosition = mapScenePosition(event.positionM);
        const center = cluster.count ? cluster.center.clone().lerp(eventPosition, 0.35) : eventPosition;
        const sourceRadius = toSceneRadius(event.radiusM);
        const eventExtent = Math.max(cluster.count ? cluster.extent + cluster.center.distanceTo(center) : sourceRadius * 1.6, 1e-8);
        const offset = camera.position.clone().sub(controls.target);
        if (offset.lengthSq() < 1e-20) offset.set(0.45, -3.8, 1.45).normalize().multiplyScalar(Math.max(focus.fitDistance * 1.12, 1e-8));
        const viewport = getSafeCameraViewport(host);
        const usableWidth = (viewport.right - viewport.left) / Math.max(1, host.clientWidth);
        const usableHeight = (viewport.bottom - viewport.top) / Math.max(1, host.clientHeight);
        const safeProjection = Math.max(0.01, Math.min(usableHeight, camera.aspect * usableWidth));
        const eventDistance = eventExtent / (0.42 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * safeProjection) * 1.04;
        offset.setLength(eventDistance);
        cameraFlight = undefined;
        controls.target.copy(center); controls.cursor.copy(center); camera.position.copy(center).add(offset); camera.lookAt(center);
        eventCameraHold = { viewMode: state.viewMode, viewRequest: state.viewRequest, generation: state.eventGeneration };
      }
    }
    const trailRevisionChanged = state.historySnapshot.generation !== orbitTrailState.generation || state.historySnapshot.revision !== orbitTrailState.revision;
    if (state.historySnapshot !== lastHistorySnapshot || trailRevisionChanged) {
      const nextTrails = updateOrbitTrails(orbitTrailState, state.historySnapshot.bodies, state.historySnapshot.timeSeconds, state.historySnapshot.revision, state.historySnapshot.generation, state.gravity, state.historySnapshot.integrationSamples);
      Object.assign(orbitTrailState, nextTrails);
      lastHistorySnapshot = state.historySnapshot; if (state.historySnapshot.integrationSamples) options.consumeIntegrationSamples?.(state.historySnapshot);
    }
    if (geometry) {
    let bodyBoundsDirty = state.bodies !== bodyExtentCache.bodies || collisionMode !== lastCollisionMode || overviewBlendChanged;
    if (trailRevisionChanged) {
      previousSnapshotBodies = [];
      previousTime = state.simulationTime;
      snapshotAt = now;
    }
      if (state.bodies !== lastBodies) {
        bodyBoundsDirty = true;
        if (!trailRevisionChanged) {
          previousSnapshotBodies = lastBodies;
          previousTime = displayedTime;
        }
        snapshotAt = now;
        lastBodies = state.bodies;
      }
      const alpha = Math.min(1, (now - snapshotAt) / 50);
      const appearanceAlpha = reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(100, Math.max(0, frameIntervalMs)) / 260);
      previousFrameAt = now;
      displayedTime = THREE.MathUtils.lerp(previousTime, state.simulationTime, alpha);
      const interpolatedBodies = interpolateOrbitBodies(previousSnapshotBodies, state.bodies, alpha);
      const overviewCenter = dominantLightSource(interpolatedBodies) ?? [...interpolatedBodies].sort((a, b) => b.massKg - a.massKg)[0];
      overviewCenterPositionM = overviewCenter?.positionM ?? origin as Vector3;
      const interpolatedById = new Map(interpolatedBodies.map((body) => [body.id, body]));
      const luminousBodies = interpolatedBodies.filter(isLuminousBody);
      const ids = new Set(state.bodies.map((body) => body.id));
      for (const [id, visual] of visuals) if (!ids.has(id)) {
        clearMaterialization(id);
        rockyFragmentIds.delete(id); fragmentHeatStartedAt.delete(id);
        appliedSurfaceHeat.delete(id);
        visual.dispose(); visual.group.removeFromParent(); visuals.delete(id); unregisterBodyPickTargets(id);
        appearanceKeys.delete(id);
        displayedAppearance.delete(id);
        labels.get(id)?.remove(); labels.delete(id);
        leaders.get(id)?.line.remove(); leaders.get(id)?.dot.remove(); leaders.delete(id);
      }
      for (const body of state.bodies) {
        if (appearanceKeys.has(body.id) && appearanceKeys.get(body.id) !== appearanceKeyFor(body, collisionMode)) {
          clearMaterialization(body.id);
          displayedAppearance.delete(body.id);
          replaceBodyVisual(body, collisionMode);
        }
        const existingVisual = visuals.get(body.id);
        const visual = existingVisual ?? addBody(body, collisionMode);
        const heatDataId = body.surface?.dataId;
        const heatKey = heatDataId ? `${heatDataId}:${surfaceHeatPayloadFingerprints.get(heatDataId) ?? "missing"}` : "none";
        if (appliedSurfaceHeat.get(body.id) !== heatKey) {
          visual.setSurfaceHeat?.(heatDataId ? state.surfaceHeatData?.[heatDataId] ?? [] : [], state.simulationTime);
          appliedSurfaceHeat.set(body.id, heatKey);
        }
        visual.setSurfaceHeatTime?.(state.simulationTime);
        if (!existingVisual && newBodyIds.has(body.id) && !eventCoveredIds?.has(body.id) && !reducedMotion.matches) addMaterialization(body.id, visual, now);
        appearanceKeys.set(body.id, appearanceKeyFor(body, collisionMode));
        const appearance = displayedAppearance.get(body.id) ?? { radiusM: body.radiusM, surfaceTemperatureK: body.surfaceTemperatureK };
        appearance.radiusM = THREE.MathUtils.lerp(appearance.radiusM, body.radiusM, appearanceAlpha);
        appearance.surfaceTemperatureK = THREE.MathUtils.lerp(appearance.surfaceTemperatureK, body.surfaceTemperatureK, appearanceAlpha);
        if (Math.abs(appearance.radiusM - body.radiusM) > Math.max(1e-6, body.radiusM * 1e-6)
          || Math.abs(appearance.surfaceTemperatureK - body.surfaceTemperatureK) > Math.max(1e-6, body.surfaceTemperatureK * 1e-6)) bodyBoundsDirty = true;
        displayedAppearance.set(body.id, appearance);
        const interpolatedBody = interpolatedById.get(body.id) ?? body;
        visual.group.position.copy(mapScenePosition(interpolatedBody.positionM));
        if (visual.cometTail) {
          let nearestStar: CelestialBody | undefined, nearestDistanceSquared = Infinity;
          for (const star of luminousBodies) {
            const dx = star.positionM[0] - interpolatedBody.positionM[0];
            const dy = star.positionM[1] - interpolatedBody.positionM[1];
            const dz = star.positionM[2] - interpolatedBody.positionM[2];
            const distanceSquared = dx * dx + dy * dy + dz * dz;
            if (distanceSquared < nearestDistanceSquared) { nearestStar = star; nearestDistanceSquared = distanceSquared; }
          }
          if (nearestStar) {
            cometAwayFromStar.set(
              interpolatedBody.positionM[0] - nearestStar.positionM[0],
              interpolatedBody.positionM[1] - nearestStar.positionM[1],
              interpolatedBody.positionM[2] - nearestStar.positionM[2],
            );
            cometRelativeVelocity.set(
              interpolatedBody.velocityMs[0] - nearestStar.velocityMs[0],
              interpolatedBody.velocityMs[1] - nearestStar.velocityMs[1],
              interpolatedBody.velocityMs[2] - nearestStar.velocityMs[2],
            );
            visual.cometTail.update(cometAwayFromStar, cometRelativeVelocity, reducedMotion.matches ? 0 : now / 1000, state.viewMode === "focus" ? cometFocusMetrics(camera.aspect).tailScale : 1, !reducedMotion.matches);
          } else visual.cometTail.update(null, cometRelativeVelocity, 0, state.viewMode === "focus" ? cometFocusMetrics(camera.aspect).tailScale : 1, !reducedMotion.matches);
        }
        const visualRadius = getBodyType(body) === "black-hole" ? renderedBodyRadius(body) : appearance.radiusM;
        setRenderedOverviewScale(body, visual, camera.position.distanceTo(visual.group.position), overviewCompressionBlend, collisionMode);
        labels.get(body.id)!.textContent = compactSceneLabel(body.name);
        labels.get(body.id)!.setAttribute("aria-label", `Selecionar ${body.name}`);
        rotateBody(visual, body, body.spin ? state.simulationTime : displayedTime, appearance, !reducedMotion.matches);
        if (visual.setFragmentHeat) visual.setFragmentHeat(0.18 * Math.exp(-Math.max(0, now - (fragmentHeatStartedAt.get(body.id) ?? now)) / 550));
        const materialization = materializations.get(body.id);
        if (materialization) {
          const progress = THREE.MathUtils.clamp((now - materialization.startedAt) / BODY_MATERIALIZATION_MS, 0, 1);
          materialization.mesh.scale.setScalar(1.28 - progress * 0.28);
          materialization.material.opacity = Math.sin(progress * Math.PI) * 0.52;
          if (progress >= 1) clearMaterialization(body.id);
        }
      }
      if (bodiesChanged) {
        knownBodyIds = new Set(state.bodies.map((body) => body.id));
        observedBodySnapshot = state.bodies;
      }
      const detailedOrbitBodyId = state.viewMode === "focus" ? state.selectedBodyId : undefined;
      if (state.showOrbits && (!orbitGroup.visible || state.revision !== orbitRevision || state.bodies.length !== orbitBodyCount || overviewBlendChanged
        || detailedOrbitBodyId !== orbitDetailedBodyId || state.simulationRunning && now - orbitAt >= MOVING_ORBIT_REFRESH_INTERVAL_MS)) {
        if (!refreshOrbitPaths(orbitGroup, interpolatedBodies, state.gravity, origin, detailedOrbitBodyId, mapScenePosition)) {
          disposeOrbits(orbitGroup);
          orbitGroup = createOrbitPaths(interpolatedBodies, state.gravity, origin, detailedOrbitBodyId, mapScenePosition);
          scene.add(orbitGroup);
        }
        orbitAt = now; orbitRevision = state.revision; orbitBodyCount = state.bodies.length; orbitDetailedBodyId = detailedOrbitBodyId;
        const primary = dominantLightSource(state.bodies) ?? [...state.bodies].sort((a, b) => b.massKg - a.massKg)[0];
        cachedOrbitExtent = measureOrbitExtent(orbitGroup, primary ? mapScenePosition(primary.positionM) : new THREE.Vector3());
      }
      orbitGroup.visible = state.showOrbits;
      for (const line of orbitGroup.children) {
        const primaryVisual = visuals.get(line.userData.primaryId as string);
        if (primaryVisual) line.position.copy(primaryVisual.group.position);
        line.visible = state.showOrbits;
      }
      if (orbitalPathHighlight) {
        const progress = (now - orbitalPathHighlight.startedAt) / 1400;
        if (progress >= 1) orbitalPathHighlight = undefined;
        updateOrbitPathHighlights(orbitGroup, orbitalPathHighlight?.ids ?? NO_NEW_BODY_IDS, orbitalPathHighlight ? (1 - Math.max(0, progress)) ** 2 : 0);
      }
      const selectedBody = state.bodies.find((body) => body.id === state.selectedBodyId);
      const historyBody = state.historySnapshot.bodies.find((body) => body.id === state.selectedBodyId);
      const authoritativePose = selectedBody && historyBody && selectedBody.positionM.every((value, axis) => value === historyBody.positionM[axis]);
      const selectedTrailTip = authoritativePose ? visuals.get(state.selectedBodyId)?.group.position.toArray() as Vector3 | undefined : undefined;
      orbitTrailLine.visible = state.showTrails ?? false;
      if (orbitTrailLine.visible) {
        const trail = orbitTrailState.trails[state.selectedBodyId] ?? [];
        const visualTrail = overviewCompressionBlend > 0 ? trail.map((sample) => ({ ...sample, positionM: rendererSpacePositionM(sample.positionM) })) : trail;
        refreshOrbitTrailLine(orbitTrailLine, visualTrail, selectedTrailTip, origin, orbitTrailState.truncated[state.selectedBodyId], orbitTrailState.gaps[state.selectedBodyId]);
      }
      const selected = state.bodies.find((body) => body.id === state.selectedBodyId) ?? state.bodies[0];
      const selectedVisual = selected ? visuals.get(selected.id) : undefined;
      const viewChanged = lastView !== state.viewMode || lastRequest !== state.viewRequest;
      const canFollowFocusedBody = selected ? shouldFollowFocusedBody(focus.bodyId, selected.id, viewChanged) : false;
      if (viewChanged) { preserveSystemFit = false; collisionSystemFitHold = undefined; }
      const selectedChanged = selected?.id !== lastSelectedBodyId;
      if (state.viewMode === "focus" && !canFollowFocusedBody) cameraFlight = undefined;
      if (viewChanged || selectedChanged) rotatingFrameManualHold = false;
      const geometryChanged = safeViewportDirty;
      if (safeViewportDirty || viewChanged) {
        safeViewport = getSafeCameraViewport(host);
        Object.assign(effectViewport, safeViewport, { width: host.clientWidth, height: host.clientHeight });
        placementHint.style.left = `${(safeViewport.left + safeViewport.right) / 2}px`;
        placementHint.style.top = `${Math.max(72, safeViewport.top + 10)}px`;
        overviewScaleNote.style.left = `${safeViewport.left + 8}px`;
        overviewScaleNote.style.top = `${safeViewport.top + 8}px`;
        safeViewportDirty = false;
      }
      overviewScaleNote.style.display = state.viewMode === "system" && overviewCompressionBlend > 0.01 ? "block" : "none";
      let rotatingPose: { pairKey: string; primaryId: string; center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3; primary: CelestialBody; secondary: CelestialBody } | undefined;
      if (state.rotatingFrame && !rotatingFrameSuppressed && selected) {
        const selectedPose = interpolatedById.get(selected.id) ?? selected;
        const primary = findOrbitalPrimary(selectedPose, interpolatedBodies, { gravitationalConstant: state.gravity });
        const primaryPose = primary && (interpolatedById.get(primary.id) ?? primary);
        const primaryVisual = primary && visuals.get(primary.id);
        if (primary && primaryPose && primaryVisual && selectedVisual && selected.massKg > 0 && primary.massKg > 0) {
          const separation = selectedVisual.group.position.clone().sub(primaryVisual.group.position);
          const relativeVelocity = new THREE.Vector3().fromArray(selectedPose.velocityMs).sub(new THREE.Vector3().fromArray(primaryPose.velocityMs));
          const separationLength = separation.length(), velocityLength = relativeVelocity.length();
          const normal = separation.clone().cross(relativeVelocity);
          if (Number.isFinite(separationLength) && separationLength > 1e-12 && Number.isFinite(velocityLength) && velocityLength > 1e-12
            && normal.length() > separationLength * velocityLength * 1e-8) {
            normal.normalize();
            const up = normal.clone().cross(separation).normalize();
            if (up.dot(camera.up) < 0) { normal.negate(); up.negate(); }
            const totalMass = selected.massKg + primary.massKg;
            const center = selectedVisual.group.position.clone().multiplyScalar(selected.massKg / totalMass)
              .addScaledVector(primaryVisual.group.position, primary.massKg / totalMass);
            if (up.lengthSq() > 0 && center.toArray().every(Number.isFinite)) rotatingPose = { pairKey: `${selected.id}:${primary.id}`, primaryId: primary.id, center, normal, up, primary: primaryPose, secondary: selectedPose };
          }
        }
        if (!rotatingPose) {
          rotatingFrameSuppressed = true;
          rotatingFrameActive = false;
          rotatingFrameManualHold = false;
          rotatingFrameTransition = undefined;
          rotatingFramePairKey = undefined;
          options.onRotatingFrameChange(false);
        }
      } else if (!state.rotatingFrame && rotatingFrameActive) {
        rotatingFrameActive = false;
        rotatingFrameManualHold = true;
        rotatingFrameTransition = undefined;
        rotatingFramePairKey = undefined;
      }
      if (rotatingPose) {
        if (!rotatingFrameActive || rotatingFramePairKey !== rotatingPose.pairKey) {
          const fromOffset = camera.position.clone().sub(controls.target);
          const fromDirection = fromOffset.lengthSq() > 1e-20 ? fromOffset.normalize() : new THREE.Vector3(0.45, -3.8, 1.45).normalize();
          const selectedBounds = new THREE.Box3().setFromObject(selectedVisual!.group).getBoundingSphere(new THREE.Sphere());
          const primaryVisual = visuals.get(rotatingPose.primaryId)!;
          const primaryBounds = new THREE.Box3().setFromObject(primaryVisual.group).getBoundingSphere(new THREE.Sphere());
          const pairExtent = Math.max(
            rotatingPose.center.distanceTo(selectedBounds.center) + selectedBounds.radius,
            rotatingPose.center.distanceTo(primaryBounds.center) + primaryBounds.radius,
          );
          const usableWidth = (safeViewport.right - safeViewport.left) / Math.max(1, host.clientWidth);
          const usableHeight = (safeViewport.bottom - safeViewport.top) / Math.max(1, host.clientHeight);
          const fitDistance = focusCameraFitDistance(pairExtent, camera.aspect, camera.fov, usableWidth, usableHeight);
          const fittedDistance = THREE.MathUtils.clamp(Math.max(camera.position.distanceTo(controls.target), fitDistance, controls.minDistance), controls.minDistance, controls.maxDistance);
          controls.target.copy(rotatingPose.center);
          controls.cursor.copy(rotatingPose.center);
          camera.position.copy(rotatingPose.center).addScaledVector(fromDirection, fittedDistance);
          camera.lookAt(rotatingPose.center);
          rotatingFrameActive = true;
          rotatingFrameManualHold = false;
          rotatingFramePairKey = rotatingPose.pairKey;
          rotatingFrameTransition = { startedAt: now, fromDirection, fromUp: camera.up.clone() };
          cameraFlight = undefined;
          applySafeCameraViewport(camera, safeViewport, host.clientWidth, host.clientHeight);
        }
        const transition = rotatingFrameTransition;
        const progress = transition ? THREE.MathUtils.clamp((now - transition.startedAt) / 850, 0, 1) : 1;
        const eased = progress * progress * (3 - 2 * progress);
        const offset = camera.position.clone().sub(controls.target);
        const distance = Math.max(offset.length(), controls.minDistance, 1e-8);
        const fromDirection = transition?.fromDirection ?? offset.clone().normalize();
        const normal = rotatingPose.normal.clone();
        if (normal.dot(fromDirection) < 0) normal.negate();
        const up = rotatingPose.up.clone();
        if (normal.dot(rotatingPose.normal) < 0) up.negate();
        const fromUp = transition?.fromUp ?? camera.up;
        if (up.dot(fromUp) < 0) up.negate();
        if (transition) {
          const direction = fromDirection.clone().lerp(normal, eased).normalize();
          controls.target.copy(rotatingPose.center);
          camera.position.copy(rotatingPose.center).addScaledVector(direction, distance);
          camera.up.copy(fromUp).lerp(up, eased).normalize();
          if (progress >= 1) rotatingFrameTransition = undefined;
        } else {
          controls.target.copy(rotatingPose.center);
          camera.position.copy(rotatingPose.center).addScaledVector(normal, distance);
          camera.up.copy(up);
        }
        controls.cursor.copy(controls.target);
        camera.lookAt(controls.target);
        if (geometryChanged || viewChanged) applySafeCameraViewport(camera, safeViewport, host.clientWidth, host.clientHeight);
      } else if (!rotatingFrameManualHold && !eventCameraHold && state.viewMode === "focus" && selected && selectedVisual && canFollowFocusedBody) {
        const blackHole = getBodyType(selected) === "black-hole";
        const focusRadius = blackHole ? blackHoleVisualRadius(selected, collisionMode) : displayedAppearance.get(selected.id)?.radiusM ?? renderedBodyRadius(selected);
        const visualExtent = blackHole ? blackHoleVisualExtent(selected, collisionMode) : getBodyType(selected) === "comet" ? focusRadius * cometFocusMetrics(camera.aspect).envelopeRadii : focusRadius;
        const minVisualHorizonDistance = blackHole && collisionMode === "creative"
          ? focusCameraFitDistance(toSceneRadius(focusRadius), camera.aspect, camera.fov, (safeViewport.right - safeViewport.left) / Math.max(1, host.clientWidth), (safeViewport.bottom - safeViewport.top) / Math.max(1, host.clientHeight))
          : undefined;
        const nextAppearanceKey = bodyAppearanceKey(selected, collisionMode);
        const appearanceChanged = focus.appearanceKey !== undefined && focus.appearanceKey !== nextAppearanceKey;
        const targetTolerance = Math.max(toSceneRadius(focusRadius) * 0.05, 1e-8);
        const alreadyCenteredOnBody = focus.bodyId === selected.id && controls.target.distanceTo(selectedVisual.group.position) <= targetTolerance;
        const expectedDistance = focus.fitDistance * (selected.id === "sun" && focus.bodyId === selected.id ? 1.12 : 1);
        const alreadyFramed = alreadyCenteredOnBody && Math.abs(camera.position.distanceTo(controls.target) - expectedDistance) <= Math.max(focus.fitDistance * 0.15, targetTolerance);
        if (viewChanged && !alreadyFramed) { focus.bodyId = null; camera.clearViewOffset(); }
        const needsFlight = initializedFocus && (viewChanged && !alreadyFramed || focus.bodyId !== selected.id || appearanceChanged);
        if (needsFlight && (!cameraFlight || cameraFlight.bodyId !== selected.id)) {
          beginFocusFlight(selected, selectedVisual.group.position, toSceneRadius(focusRadius), toSceneRadius(visualExtent), minVisualHorizonDistance, collisionMode, safeViewport, now, !viewChanged && focus.bodyId !== null);
        } else if (!cameraFlight) {
          focusCameraOnBody(camera, controls, selected.id, selectedVisual.group.position, toSceneRadius(focusRadius), focus, safeViewport, host.clientWidth, host.clientHeight, toSceneRadius(visualExtent), minVisualHorizonDistance, bodyAppearanceKey(selected, collisionMode));
        }
        initializedFocus = true;
        if (cameraFlight && cameraFlight.bodyId === selected.id) {
          const progress = THREE.MathUtils.clamp((now - cameraFlight.startedAt) / 850, 0, 1);
          const eased = progress * progress * (3 - 2 * progress);
          controls.target.copy(cameraFlight.fromTarget).lerp(selectedVisual.group.position, eased).addScaledVector(cameraFlight.toTargetOffset, eased);
          controls.cursor.copy(controls.target);
          camera.position.copy(cameraFlight.fromOffset).lerp(cameraFlight.toOffset, eased).add(controls.target);
          focus.position.copy(selectedVisual.group.position);
          camera.lookAt(controls.target);
          if (progress >= 1) cameraFlight = undefined;
        }
        if (viewChanged || geometryChanged) applySafeCameraViewport(camera, safeViewport, host.clientWidth, host.clientHeight);
      } else if (!rotatingFrameManualHold && !eventCameraHold && state.viewMode === "system") {
        if (viewChanged) camera.clearViewOffset();
        focus.bodyId = null;
        cameraFlight = undefined;
        const central = dominantLightSource(state.bodies) ?? [...state.bodies].sort((a, b) => b.massKg - a.massKg)[0];
        const center = central ? mapScenePosition(central.positionM) : new THREE.Vector3();
        if (now - snapshotAt < 50) bodyBoundsDirty = true;
        const bodyExtent = cachedBodyExtent(bodyExtentCache, state.bodies, visuals, displayedAppearance, center, bodyBoundsDirty, collisionMode);
        const physicalExtent = Math.max(0.00001, bodyExtent, state.showOrbits ? cachedOrbitExtent : 0);
        const physicalDistance = systemCameraDistance(physicalExtent, camera.aspect, camera.fov, (safeViewport.right - safeViewport.left) / Math.max(1, host.clientWidth), (safeViewport.bottom - safeViewport.top) / Math.max(1, host.clientHeight));
        const envelopeDistance = !viewChanged && systemFitDistance > 0 ? camera.position.distanceTo(controls.target) : physicalDistance;
        const applyOverviewEnvelope = (distance: number) => {
          for (const body of state.bodies) {
            const visual = visuals.get(body.id)!;
            const depth = !viewChanged && systemFitDistance > 0
              ? camera.position.distanceTo(visual.group.position)
              : distance + visual.group.position.distanceTo(center);
            setRenderedOverviewScale(body, visual, depth, overviewCompressionBlend, collisionMode);
          }
        };
        applyOverviewEnvelope(envelopeDistance);
        const extent = Math.max(0.00001, physicalExtent, state.showOrbits ? cachedOrbitExtent : 0);
        const priorDistance = systemFitDistance;
        const preserveCurrentSystemFit = preserveSystemFit || !!collisionSystemFitHold;
        let cameraExtent = preserveCurrentSystemFit && !viewChanged && systemFitExtent > 0 ? systemFitExtent : extent;
        if (collisionSystemFitHold && !viewChanged && systemFitExtent > 0) cameraExtent = Math.max(cameraExtent, extent);
        let nextDistance = systemCameraDistance(cameraExtent, camera.aspect, camera.fov, (safeViewport.right - safeViewport.left) / Math.max(1, host.clientWidth), (safeViewport.bottom - safeViewport.top) / Math.max(1, host.clientHeight));
        if (!preserveCurrentSystemFit) {
          applyOverviewEnvelope(nextDistance);
        }
        systemFitExtent = updateSystemCamera(camera, controls, center, cameraExtent, systemFitExtent, safeViewport, host.clientWidth, host.clientHeight, viewChanged);
        if (!viewChanged && geometryChanged && priorDistance > 0) {
          const ratio = nextDistance / priorDistance;
          camera.position.sub(center).multiplyScalar(ratio).add(center);
          controls.target.sub(center).multiplyScalar(ratio).add(center);
          controls.cursor.sub(center).multiplyScalar(ratio).add(center);
          applySafeCameraViewport(camera, safeViewport, host.clientWidth, host.clientHeight);
        }
        systemFitDistance = nextDistance;
      }
      if (state.viewMode === "focus" && !canFollowFocusedBody && geometryChanged) applySafeCameraViewport(camera, safeViewport, host.clientWidth, host.clientHeight);
      if (eventCameraHold && state.viewMode === "system") {
        for (const body of state.bodies) {
          const visual = visuals.get(body.id)!;
          setRenderedOverviewScale(body, visual, camera.position.distanceTo(visual.group.position), overviewCompressionBlend, collisionMode);
        }
      }
      lastView = state.viewMode; lastRequest = state.viewRequest; lastSelectedBodyId = selected?.id ?? "";
      lastCollisionMode = collisionMode;
      const renderBodies = state.bodies.map((body) => ({
        ...body,
        ...displayedAppearance.get(body.id),
        positionM: interpolatedById.get(body.id)?.positionM ?? body.positionM,
      }));
      const lightSources = selectSceneLightSources(renderBodies, sceneLightSourceLimit(renderQuality.pixelRatio, renderer.capabilities.maxTextureSize));
      const star = lightSources[0]?.body;
      const renderedRadiusM = (body: CelestialBody) => {
        const visual = visuals.get(body.id);
        const radius = visual ? visual.group.scale.x * visual.surface.scale.x / SCENE_UNITS_PER_METER : body.radiusM;
        return Number.isFinite(radius) && radius > 0 ? radius : body.radiusM;
      };
      eclipseInputs = { state, bodies: renderBodies, lightSources, renderedRadiusM, collisionMode };
      for (let index = 0; index < stellarLights.length; index += 1) {
        const light = stellarLights[index]!;
        const source = lightSources[index];
        light.visible = !!source;
        light.intensity = source?.intensity ?? 0;
        if (source) {
          light.color.setRGB(source.color.r, source.color.g, source.color.b, THREE.SRGBColorSpace);
          light.position.copy(mapScenePosition(interpolatedById.get(source.body.id)?.positionM ?? source.body.positionM));
        }
      }
      inspectionFill.intensity = lightSources.length ? 0.78 : 1.1;
      const targetExposure = sceneExposureTarget(lightSources.reduce((sum, source) => sum + source.intensity, 0));
      const exposureBlend = 1 - Math.exp(-Math.min(frameIntervalMs, 100) / 350);
      sceneExposure += (targetExposure - sceneExposure) * exposureBlend;
      renderer.toneMappingExposure = sceneExposure;
      const cameraDistance = camera.position.distanceTo(controls.target);
      camera.near = Math.max(1e-9, Math.min(0.1, cameraDistance / 10000));
      camera.far = Math.max(CAMERA_FAR, cameraDistance + 3 * MAX_SCENE_EXTENT_UNITS + 2500);
      camera.updateProjectionMatrix(); controls.update();
      if (reducedMotion.matches) impactImpulse = undefined;
      if (impactImpulse) {
        const progress = (now - impactImpulse.startedAt) / 420;
        if (progress >= 1) impactImpulse = undefined;
        else {
          const decay = (1 - progress) ** 2;
          const pulse = Math.sin(progress * Math.PI * 8) * decay * impactImpulse.amplitude;
          const projection = camera.projectionMatrix.elements;
          projection[8] += Math.cos(impactImpulse.phase) * pulse;
          projection[9] += Math.sin(impactImpulse.phase) * pulse * 0.7;
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        }
      }
      camera.updateMatrixWorld();
      if (trajectoryContactMarker.visible) {
        const markerDistance = camera.position.distanceTo(trajectoryContactMarker.position);
        trajectoryContactMarker.scale.setScalar(Math.max(1e-9, 2 * markerDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 8 / Math.max(1, host.clientHeight)));
      }
      if (state.rotatingFrame && rotatingFrameActive && rotatingPose) {
        const points = calculateApproximateLagrangePoints(rotatingPose.primary, rotatingPose.secondary, state.gravity);
        if (points) lagrangeMarkers.update(points, rotatingPose.primary, rotatingPose.secondary, origin, camera, host.clientWidth, host.clientHeight, safeViewport);
        else lagrangeMarkers.hide();
      } else lagrangeMarkers.hide();
      const sunVisual = visuals.get("sun");
      const sunProjected = sunVisual ? projected.copy(sunVisual.group.position).project(camera) : undefined;
      const safeCenterX = (safeViewport.left + safeViewport.right) / Math.max(1, host.clientWidth) - 1;
      const safeCenterY = 1 - (safeViewport.top + safeViewport.bottom) / Math.max(1, host.clientHeight);
      const flareOffsetX = sunProjected ? sunProjected.x - safeCenterX : Infinity;
      const flareOffsetY = sunProjected ? sunProjected.y - safeCenterY : Infinity;
      const flareOffset = Math.hypot(flareOffsetX, flareOffsetY);
      const flareEligible = state.viewMode === "focus" && state.selectedBodyId === "sun" && star?.id === "sun" && sunProjected && sunProjected.z > -1 && sunProjected.z < 1 && !reducedMotion.matches;
      const flareOccluded = flareEligible && isSceneSourceOccluded("sun", sunVisual!.group.position.toArray() as [number, number, number], camera.position.toArray() as [number, number, number], [...visuals].map(([id, visual]) => ({ id, position: visual.group.position.toArray() as [number, number, number], radius: visual.group.scale.x * visual.surface.scale.x })));
      const flareStrength = flareEligible && !flareOccluded
        ? 1 - THREE.MathUtils.smoothstep(flareOffset, 0.025, 0.48)
        : 0;
      lensFlare.group.visible = flareStrength > 0.001;
      if (lensFlare.group.visible && sunProjected) {
        const flareDistance = Math.max(camera.near * 2.5, cameraDistance * 0.01, 1e-8);
        const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const halfWidth = flareDistance * tangent * camera.aspect, halfHeight = flareDistance * tangent;
        lensFlare.group.position.copy(camera.position).addScaledVector(camera.getWorldDirection(cameraSpace), flareDistance);
        lensFlare.group.quaternion.copy(camera.quaternion);
        const screenAngle = Math.atan2(flareOffsetY * host.clientHeight, flareOffsetX * host.clientWidth);
        const placements = [
          [sunProjected.x, sunProjected.y, 1, 0.19, 0.19],
          [safeCenterX + flareOffsetX * 0.48, safeCenterY + flareOffsetY * 0.48, 0.7, 0.34, 0.014],
          [safeCenterX - flareOffsetX * 0.38, safeCenterY - flareOffsetY * 0.38, 0.45, 0.075, 0.075],
        ];
        lensFlare.group.children.forEach((child, index) => {
          if (!(child instanceof THREE.Sprite)) return;
          const [x, y, opacity, width, height] = placements[index]!;
          child.position.set(x! * halfWidth, y! * halfHeight, 0);
          child.scale.set(halfWidth * width!, halfHeight * height!, 1);
          child.rotation.z = index === 1 ? screenAngle : 0;
          child.material.opacity = Number(child.userData.baseOpacity) * flareStrength * opacity!;
        });
      }
      if (state.showOrbits) updateOrbitPathOcclusion(orbitGroup, camera, visuals, host.clientWidth, host.clientHeight, renderer.getPixelRatio());
      const photospheres: SceneLabelOccluder[] = state.bodies.flatMap((body) => { const visual = visuals.get(body.id); const isStellarSurface = body.kind === "star"; const visibleScale = visual ? Number(visual.group.userData.orbitOcclusionScale) || visual.surface.scale.x : 1; const occluder = isStellarSurface && visual && projectSceneOccluder(visual.group.position, visual.group.scale.x * visibleScale, camera, host.clientWidth, host.clientHeight); return occluder ? [occluder] : []; });
      const anchors: SceneLabelAnchor[] = [];
      for (const body of state.bodies) {
        const visual = visuals.get(body.id)!, labelElement = labels.get(body.id)!;
        const leader = leaders.get(body.id)!;
        labelElement.style.left = "";
        labelElement.style.top = "";
        leader.line.style.display = "none"; leader.dot.style.display = "none";
        projected.copy(visual.group.position).project(camera);
        const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 0.96 && Math.abs(projected.y) < 0.94;
        const fragment = isDebrisBody(body, rockyFragmentIds);
        const selectedLabel = body.id === state.selectedBodyId;
        const labelWidth = Math.min(Math.max(0, safeViewport.right - safeViewport.left), Math.max(40, labelElement.textContent!.length * 7 + 16));
        labelElement.style.maxWidth = `${Math.max(0, safeViewport.right - safeViewport.left)}px`;
        labelElement.style.overflow = "hidden";
        labelElement.style.textOverflow = "ellipsis";
        labelElement.style.whiteSpace = "nowrap";
        labelElement.classList.toggle("is-selected", selectedLabel);
        const focusedLabel = labelElement === document.activeElement;
        const activeLabel = selectedLabel || focusedLabel || body.id === hoveredBodyId;
        labelElement.tabIndex = fragment ? -1 : 0;
        labelElement.style.background = "transparent";
        labelElement.style.padding = "0";
        labelElement.style.display = visible && !fragment ? "block" : "none";
        labelElement.style.opacity = visible && !fragment && activeLabel ? "1" : "0";
        labelElement.style.pointerEvents = visible && !fragment && activeLabel ? "auto" : "none";
        if (!visible || fragment || !activeLabel) continue;
        const labelDepth = -cameraSpace.copy(visual.group.position).applyMatrix4(camera.matrixWorldInverse).z;
        const distance = camera.position.distanceTo(visual.group.position);
        const visibleRadius = visual.group.scale.x * (Number(visual.group.userData.orbitOcclusionScale) || visual.surface.scale.x);
        const pixelRadius = visibleRadius / Math.max(distance, 1e-12) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * host.clientHeight / 2;
        if (state.viewMode === "system") {
          anchors.push({ id: body.id, x: (projected.x + 1) * host.clientWidth / 2, y: (1 - projected.y) * host.clientHeight / 2, width: labelWidth, selected: selectedLabel, focused: focusedLabel, depth: labelDepth });
          continue;
        }
        const labelViewport = safeViewport;
        const x = (projected.x + 1) * host.clientWidth / 2, y = (1 - projected.y) * host.clientHeight / 2;
        const placement = layoutFocusLabel(x, y, pixelRadius, labelWidth, labelViewport, photospheres, labelDepth, selectedLabel, focusedLabel);
        const labelPosition = placement;
        if (!labelPosition) {
          if (labelElement === document.activeElement) {
            const restored = options.onFocusNavigationFallback?.(body.id) ?? false;
            if (!restored || document.activeElement === labelElement) renderer.domElement.focus({ preventScroll: true });
          }
          labelElement.style.display = "none";
          continue;
        }
        labelElement.style.left = `${labelPosition.x}px`;
        labelElement.style.top = `${labelPosition.y}px`;
      }
      for (const placement of layoutSceneLabels(anchors, safeViewport, photospheres)) {
        const label = labels.get(placement.id)!, leader = leaders.get(placement.id)!;
        label.style.display = "block"; label.style.opacity = "1"; label.style.left = `${placement.labelX}px`; label.style.top = `${placement.labelY}px`;
        leader.line.style.display = "block"; leader.dot.style.display = "block";
        leader.line.setAttribute("x1", `${placement.x}`); leader.line.setAttribute("y1", `${placement.y}`);
        leader.line.setAttribute("x2", `${placement.labelX}`); leader.line.setAttribute("y2", `${placement.labelY}`);
        leader.dot.setAttribute("cx", `${placement.x}`); leader.dot.setAttribute("cy", `${placement.y}`);
      }
      for (const anchor of anchors) {
        const label = labels.get(anchor.id)!;
        if (label.style.left) continue;
        if (anchor.selected || anchor.focused) {
          label.style.display = "block"; label.style.opacity = "1";
          label.style.left = `${THREE.MathUtils.clamp(anchor.x, safeViewport.left + anchor.width / 2, safeViewport.right - anchor.width / 2)}px`;
          label.style.top = `${THREE.MathUtils.clamp(anchor.y, safeViewport.top + 12, safeViewport.bottom - 12)}px`;
        } else {
          label.style.display = "none"; label.style.opacity = "0"; label.style.pointerEvents = "none";
        }
      }
    }
    eventEffects.consume(state.events, now, state.eventGeneration, state.bodies, collisionMode, (bodyId) => {
      const visual = visuals.get(bodyId);
      return visual ? { group: visual.group, surfaceRadius: visual.surface.scale.x } : undefined;
    });
    eventEffects.update(now, camera, state.bodies, effectViewport, state.simulationTime);
    const continuouslyAnimating = state.simulationRunning || !!cameraFlight || !!rotatingFrameTransition || !!impactImpulse
      || !!placementBody || materializations.size > 0 || eventEffects.hasActiveEffects || now - lastControlChangeAt < 250;
    if (continuouslyAnimating || now - lastRenderAt >= 1000 / 15) {
      const eclipse = eclipseInputs;
      if (eclipse) {
        const geometryKey = JSON.stringify([
          eclipse.state.revision, eclipse.state.eventGeneration, eclipse.state.historySnapshot.generation, eclipse.collisionMode,
          eclipse.lightSources.map(({ body }) => body.id),
          eclipse.bodies.map((body) => [body.id, bodyAppearanceKey(body, eclipse.collisionMode), body.positionM, eclipse.renderedRadiusM(body)]),
        ]);
        if (eclipse.state.simulationRunning || geometryKey !== lastEclipseGeometryKey) {
          for (const body of eclipse.bodies) {
            const eclipseLights: SceneEclipseLight[] = eclipse.lightSources.map(({ body: source }) => {
              const distanceM = Math.hypot(...source.positionM.map((value, axis) => value - body.positionM[axis]!));
              const blocker = findStrongestEclipseBlocker(source, body, eclipse.bodies, eclipse.renderedRadiusM);
              return {
                sourcePosition: mapScenePosition(source.positionM).toArray() as Vector3,
                sourceRadius: toSceneRadius(eclipse.renderedRadiusM(source)),
                distanceFactor: source.id === body.id ? 1 : sceneStellarDistanceFactor(distanceM),
                blockerPosition: blocker ? mapScenePosition(blocker.positionM).toArray() as Vector3 : [0, 0, 0] as Vector3,
                blockerRadius: blocker ? toSceneRadius(blocker.radiusM) : 0,
                ...(blocker ? { blockerId: blocker.bodyId } : {}),
              };
            });
            visuals.get(body.id)?.setEclipseLighting?.(eclipseLights);
          }
          lastEclipseGeometryKey = geometryKey;
        }
      }
      try {
        renderer.render(scene, camera);
      } catch {
        active = false;
        cancelAnimationFrame(frame);
        frame = 0;
        options.onError("Não foi possível renderizar a cena. Atualize a página para tentar novamente.");
        return;
      }
      lastRenderAt = now;
      if (continuouslyAnimating && frameIntervalMs > 0 && renderQuality.sampleFrame(frameIntervalMs)) {
        renderer.setPixelRatio(renderQuality.pixelRatio);
        renderer.setSize(host.clientWidth, host.clientHeight);
      }
      if (now - lastMetricsAt >= 1000) {
        const info = renderer.info;
        host.dataset.renderMetrics = JSON.stringify({
          rafP50Ms: renderQuality.metrics.p50FrameIntervalMs, rafP95Ms: renderQuality.metrics.p95FrameIntervalMs,
          sampleCount: renderQuality.metrics.sampleCount, drawCalls: info.render.calls, triangles: info.render.triangles,
          geometries: info.memory.geometries, textures: info.memory.textures, pixelRatio: renderer.getPixelRatio(),
        });
        lastMetricsAt = now;
      }
    }
  };

  const createCapture = (): SceneCapture => ({
    png: () => captureScenePng(renderer.domElement, () => renderer.render(scene, camera)),
    createStream: typeof renderer.domElement.captureStream === "function" ? () => renderer.domElement.captureStream(24) : undefined,
  });
  const useFallbackSphere = () => {
    if (!active) return;
    try {
      geometry = selectUvSphereGeometry();
    } catch {
      options.onError("Não foi possível criar a geometria dos astros. Atualize a página para tentar novamente.");
      return;
    }
    options.onCaptureReady?.(createCapture());
    options.onLoaded();
  };
  void new GLTFLoader().loadAsync("/models/astro-sphere.glb").then((gltf) => {
    if (!active) { disposeSphereAsset(gltf.scene); return; }
    let modelGeometry: THREE.BufferGeometry | undefined;
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh && !modelGeometry && object.geometry.getAttribute("uv")) modelGeometry = object.geometry;
    });
    disposeSphereAsset(gltf.scene, modelGeometry);
    if (!modelGeometry) { useFallbackSphere(); return; }
    geometry = selectUvSphereGeometry(modelGeometry);
    options.onCaptureReady?.(createCapture());
    options.onLoaded();
  }, useFallbackSphere);
  const syncRendererSize = () => {
    if (!host.clientWidth || !host.clientHeight) return;
    const nextHighResolution = host.clientWidth >= 768 && renderer.capabilities.maxTextureSize >= 8192;
    if (nextHighResolution !== highResolution) {
      highResolution = nextHighResolution;
      scene.remove(environment.group);
      environment.dispose();
      environment = createCelestialEnvironment(scene, highResolution, environmentSeed);
      const collisionMode = options.read().collisionMode ?? "scientific";
      for (const body of lastBodies) replaceBodyVisual(body, collisionMode);
    }
    if (renderQuality.resize({ width: host.clientWidth, height: host.clientHeight, devicePixelRatio: window.devicePixelRatio, maxTextureSize: renderer.capabilities.maxTextureSize })) renderer.setPixelRatio(renderQuality.pixelRatio);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  };
  const resize = new ResizeObserver((entries) => { safeViewportDirty = true; if (entries.some((entry) => entry.target === host)) syncRendererSize(); });
  resize.observe(host);
  const shell = host.closest(".astro-shell"), overlays = shell?.querySelectorAll?.(".object-rail, .planet-navigation, .scene-tools, .experiment-dock");
  overlays?.forEach((element) => resize.observe(element)); const invalidateSafeViewport = () => { safeViewportDirty = true; };
  const handleResize = () => { invalidateSafeViewport(); syncRendererSize(); };
  window.addEventListener?.("resize", handleResize);
  const handleVisibilityChange = () => {
    previousFrameAt = 0;
    lastRenderAt = -Infinity;
    if (document.visibilityState === "hidden") {
      cancelLaserAimPointer();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    } else if (active && !frame) frame = requestAnimationFrame(animate);
  };
  document.addEventListener?.("visibilitychange", handleVisibilityChange);
  const overlayMutation = shell && typeof MutationObserver !== "undefined" ? new MutationObserver(invalidateSafeViewport) : undefined;
  overlays?.forEach((element) => overlayMutation?.observe(element, { attributes: true, attributeFilter: ["class", "style", "hidden"] }));
  camera.aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
  camera.updateProjectionMatrix();
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const bodyHitAtPointer = () => {
    const state = options.read();
    return raycaster.intersectObjects(pickTargets, false).find((hit) => {
      if (state.viewMode !== "system") return true;
      const bodyId = hit.object.userData.bodyId as string | undefined;
      const body = state.bodies.find((candidate) => candidate.id === bodyId), visual = bodyId ? visuals.get(bodyId) : undefined;
      if (!body || !visual) return false;
      const type = getBodyType(body), creativeHole = type === "black-hole" && state.collisionMode === "creative";
      if (creativeHole) return hit.object.visible;
      const radius = displayedAppearance.get(body.id)?.radiusM ?? renderedBodyRadius(body);
      const previousEnvelope = assistedOverviewRadius(toSceneRadius(radius), body.kind, type, camera.position.distanceTo(visual.group.position), camera.fov, host.clientHeight);
      const targetExtent = hit.object.userData.bodyPickExtentMultiplier;
      const priorHitRadius = previousEnvelope * visual.surface.scale.x
        * (typeof targetExtent === "number" && Number.isFinite(targetExtent) && targetExtent > 0 ? targetExtent : 1);
      return hit.point.distanceTo(visual.group.position) <= priorHitRadius * 1.00001;
    });
  };
  const bodyHitForLaserPointer = (event: PointerEvent) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return undefined;
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -((event.clientY - bounds.top) / bounds.height * 2 - 1));
    raycaster.setFromCamera(pointer, camera);
    return bodyHitAtPointer();
  };
  const updateHoveredBody = (event: PointerEvent) => {
    if (readPlacementBody() || event.pointerType === "touch") return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1, -((event.clientY - bounds.top) / Math.max(1, bounds.height) * 2 - 1));
    raycaster.setFromCamera(pointer, camera);
    hoveredBodyId = (bodyHitAtPointer()?.object.userData.bodyId as string | undefined) ?? null;
  };
  const clearHoveredBody = () => { hoveredBodyId = null; };
  const placementPlane = new THREE.Plane(), placementHit = new THREE.Vector3();
  const touchAction = renderer.domElement.style.touchAction;
  const pointerScenePoint = (event: PointerEvent) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    return intersectPlacementPlane(event.clientX, event.clientY, bounds, camera, controls.target, raycaster, pointer, placementPlane, placementHit)?.clone() ?? null;
  };
  const orbitalPointerDown = (event: PointerEvent) => {
    const state = options.read(), placement = orbitalPlacementIsCurrent(state);
    if (!placement || event.target !== renderer.domElement || !event.isPrimary || state.placementBody || state.laserAim) return;
    const anchorId = anchorIdForMutation(placement.mutation), anchor = visuals.get(anchorId)?.group.position;
    if (!anchor) return;
    const point = orbitalPointerPoint(event, anchor);
    const hit = bodyHitAtPointer();
    if (!point || hit?.object.userData.bodyId !== anchorId) return;
    blockPlacementPointer(event);
    clearOrbitalDraft();
    orbitalGesture = {
      pointerId: event.pointerId, anchorId, worldRevision: state.revision, baseTimeSeconds: state.simulationTime,
      viewMode: state.viewMode, viewRequest: state.viewRequest, planeNormal: camera.getWorldDirection(new THREE.Vector3()).normalize(),
    };
    controls.enabled = false;
    try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* Some touch browsers omit pointer capture. */ }
  };
  const orbitalPointerMove = (event: PointerEvent) => {
    const gesture = orbitalGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    blockPlacementPointer(event);
    const state = options.read(), anchor = visuals.get(gesture.anchorId)?.group.position;
    if (!anchor || state.revision !== gesture.worldRevision || state.simulationTime !== gesture.baseTimeSeconds
      || state.viewMode !== gesture.viewMode || state.viewRequest !== gesture.viewRequest) { clearOrbitalDraft(); return; }
    const point = orbitalPointerPoint(event, anchor);
    if (point) updateOrbitalDraft(gesture, point);
  };
  const orbitalPointerUp = (event: PointerEvent) => {
    const gesture = orbitalGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    blockPlacementPointer(event);
    const state = options.read(), placement = orbitalPlacementIsCurrent(state);
    if (!placement || state.revision !== gesture.worldRevision || state.simulationTime !== gesture.baseTimeSeconds
      || state.viewMode !== gesture.viewMode || state.viewRequest !== gesture.viewRequest
      || anchorIdForMutation(placement.mutation) !== gesture.anchorId) { clearOrbitalDraft(); return; }
    const anchor = visuals.get(gesture.anchorId)?.group.position;
    const point = anchor && orbitalPointerPoint(event, anchor);
    if (point) updateOrbitalDraft(gesture, point);
    orbitalGesture = null;
    restoreOrbitalControls();
  };
  const orbitalPointerCancel = (event: PointerEvent) => {
    if (orbitalGesture?.pointerId !== event.pointerId) return;
    blockPlacementPointer(event);
    clearOrbitalDraft();
  };
  const orbitalLostPointerCapture = (event: Event) => {
    if (orbitalGesture?.pointerId === (event as PointerEvent).pointerId) clearOrbitalDraft();
  };
  const orbitalPointerPoint = (event: PointerEvent, anchor: THREE.Vector3) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    return intersectPlacementPlane(event.clientX, event.clientY, bounds, camera, anchor, raycaster, pointer, placementPlane, placementHit)?.clone() ?? null;
  };
  const placementPointerPoint = (event: PointerEvent) => {
    const point = pointerScenePoint(event);
    if (!point) return null;
    return placementPointOnDepth(point, camera.getWorldDirection(placementViewDirection), placementDepthOffset);
  };
  const selectedLaunchSpeedMs = () => {
    const value = placementSpeedInput.value.trim();
    if (!value) return undefined;
    const speedKmS = Number(value);
    return Number.isFinite(speedKmS) && speedKmS >= 0 ? speedKmS * 1_000 : 0;
  };
  const placementVelocity = (start: THREE.Vector3, end: THREE.Vector3, pixels: number) =>
    placementLaunchVelocity(start, end, pixels, selectedLaunchSpeedMs());
  const previewCandidate = (body: CelestialBody, point: THREE.Vector3, velocityMs: Vector3): CelestialBody => {
    const state = options.read();
    const sourceId = body.parentId ?? body.id;
    const source = state.bodies.find((candidate) => candidate.id === sourceId);
    let id = `trajectory-preview-${++trajectoryPreviewSequence}`;
    while (state.bodies.some((candidate) => candidate.id === id)) id = `trajectory-preview-${++trajectoryPreviewSequence}`;
    const candidate = {
      ...(source ?? body), id, name: body.name, parentId: undefined,
      positionM: scenePointToAcceptedPosition(point),
      velocityMs: velocityMs.some((value) => value !== 0) ? velocityMs : source?.velocityMs ?? velocityMs,
    };
    delete candidate.stellarEvolution;
    return candidate;
  };
  const cancelTrajectoryPreviewTimer = () => {
    if (trajectoryPreviewTimer !== undefined) clearTimeout(trajectoryPreviewTimer);
    trajectoryPreviewTimer = undefined;
  };
  const scheduleTrajectoryPreview = (body: CelestialBody, point: THREE.Vector3, velocityMs: Vector3) => {
    cancelTrajectoryPreviewTimer();
    options.onTrajectoryPreviewInvalidate?.();
    const previewPoint = point.clone();
    const previewVelocity = [...velocityMs] as unknown as Vector3;
    trajectoryPreviewTimer = setTimeout(() => {
      trajectoryPreviewTimer = undefined;
      options.onTrajectoryPreviewRequest?.(previewCandidate(body, previewPoint, previewVelocity));
    }, 260);
  };
  const cancelTrajectoryPreview = () => {
    cancelTrajectoryPreviewTimer();
    options.onTrajectoryPreviewCancel?.();
    placementPrediction.textContent = "";
  };
  const placementCandidatePose = () => {
    if (placementDrag) {
      const pixels = Math.hypot(placementDrag.currentX - placementDrag.x, placementDrag.currentY - placementDrag.y);
      return pixels > 5
        ? { point: placementDrag.start, velocity: placementVelocity(placementDrag.start, placementDrag.current, pixels) }
        : { point: placementDrag.current, velocity: [0, 0, 0] as Vector3 };
    }
    return { point: placementPoint, velocity: [0, 0, 0] as Vector3 };
  };
  const requestPlacementPreview = (body: CelestialBody) => {
    const pose = placementCandidatePose();
    scheduleTrajectoryPreview(body, pose.point, pose.velocity);
  };
  const showPlacementVelocity = (velocityMs: Vector3) => {
    placementSpeedReadout.textContent = `Arrasto: ${(Math.hypot(...velocityMs) / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km/s`;
  };
  const commitPlacement = (body: CelestialBody, point: THREE.Vector3, velocityMs: Vector3) => {
    cancelTrajectoryPreview();
    consumedPlacement = body;
    placementDrag = null; placementArrow.visible = false; placementPreview.visible = false; hasPlacementPoint = false;
    preserveSystemFit = true;
    options.onPlaceBody(scenePointToAcceptedPosition(point), velocityMs);
  };
  const blockPlacementPointer = (event: PointerEvent) => {
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
  };
  const laserPointerDown = (event: PointerEvent) => {
    const aim = options.read().laserAim;
    if (!aim || readPlacementBody() || event.target !== renderer.domElement || !event.isPrimary) return;
    const hit = bodyHitForLaserPointer(event);
    if (!hit || hit.object.userData.bodyId !== aim.bodyId) return;
    blockPlacementPointer(event);
    if (!laserPointerCapture.begin(event.pointerId)) { options.onCancelLaserAim?.(); return; }
    controls.enabled = false;
    laserAimPointer = { pointerId: event.pointerId, bodyId: aim.bodyId, acceptedRevision: options.read().revision };
  };
  const laserPointerMove = (event: PointerEvent) => {
    if (laserAimPointer?.pointerId === event.pointerId) blockPlacementPointer(event);
  };
  const laserPointerUp = (event: PointerEvent) => {
    const pointerState = laserAimPointer;
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;
    blockPlacementPointer(event);
    const state = options.read(), aim = state.laserAim;
    const hit = bodyHitForLaserPointer(event);
    const visual = visuals.get(pointerState.bodyId);
    if (aim && aim.bodyId === pointerState.bodyId && state.revision === pointerState.acceptedRevision
      && hit?.object.userData.bodyId === pointerState.bodyId && visual) {
      const direction = bodyLocalDirectionFromWorldHit(visual.group, hit.point);
      if (direction) options.onLaserShot?.(aim, direction, pointerState.acceptedRevision);
    }
    laserPointerCapture.finish(event.pointerId);
    cancelLaserAimPointer(false);
    options.onCancelLaserAim?.();
  };
  const laserPointerCancel = (event: PointerEvent) => {
    if (laserAimPointer?.pointerId !== event.pointerId) return;
    blockPlacementPointer(event);
    cancelLaserAimPointer();
  };
  const updatePlacementArrow = () => {
    if (!placementDrag) { placementArrow.visible = false; return; }
    const delta = placementDrag.current.clone().sub(placementDrag.start);
    const distance = delta.length();
    if (distance < 1e-9) { placementArrow.visible = false; return; }
    placementPreview.position.copy(placementDrag.start);
    placementArrow.position.set(0, 0, 0);
    placementArrow.setDirection(delta.normalize());
    const length = Math.min(distance, camera.position.distanceTo(placementDrag.start) * 0.32);
    placementArrow.setLength(Math.max(length, 1e-8), Math.max(length * 0.22, 1e-8), Math.max(length * 0.13, 1e-8));
    placementArrow.visible = true;
  };
  const placementDown = (event: PointerEvent) => {
    if (event.target !== renderer.domElement || !event.isPrimary) return;
    const body = readPlacementBody();
    if (!body) return;
    blockPlacementPointer(event);
    controls.enabled = false;
    const point = placementPointerPoint(event);
    if (!point) return;
    placementPoint.copy(point); placementPreview.position.copy(point);
    placementDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, currentX: event.clientX, currentY: event.clientY, start: point, current: point.clone() };
    requestPlacementPreview(body);
    try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* Some touch browsers omit pointer capture. */ }
  };
  const placementMove = (event: PointerEvent) => {
    const body = readPlacementBody();
    if (!body) return;
    if (event.target !== renderer.domElement && placementDrag?.pointerId !== event.pointerId) return;
    if (placementDrag?.pointerId === event.pointerId) blockPlacementPointer(event);
    const point = placementPointerPoint(event);
    if (!point) return;
    if (placementDrag?.pointerId === event.pointerId) {
      placementDrag.currentX = event.clientX; placementDrag.currentY = event.clientY;
      placementDrag.current.copy(point);
      updatePlacementArrow();
      showPlacementVelocity(placementVelocity(placementDrag.start, point, Math.hypot(event.clientX - placementDrag.x, event.clientY - placementDrag.y)));
    } else {
      placementPoint.copy(point); placementPreview.position.copy(point);
    }
    requestPlacementPreview(body);
  };
  const placementUp = (event: PointerEvent) => {
    if (!placementDrag || placementDrag.pointerId !== event.pointerId) return;
    blockPlacementPointer(event);
    const body = readPlacementBody();
    const drag = placementDrag;
    placementDrag = null;
    placementArrow.visible = false;
    if (!body) return;
    const point = placementPointerPoint(event) ?? drag.current;
    const pixels = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
    const position = pixels > 5 ? drag.start : point;
    const velocity = pixels > 5 ? placementVelocity(drag.start, point, pixels) : [0, 0, 0] as Vector3;
    commitPlacement(body, position, velocity);
  };
  const placementCancelPointer = (event: PointerEvent) => {
    if (placementDrag?.pointerId !== event.pointerId) return;
    placementDrag = null; placementArrow.visible = false;
    const body = readPlacementBody();
    if (body) requestPlacementPreview(body);
  };
  const placementWheel = (event: WheelEvent) => {
    if (!readPlacementBody()) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const body = readPlacementBody()!;
    const radius = getBodyType(body) === "black-hole" ? blackHoleVisualRadius(body, options.read().collisionMode) : body.radiusM;
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * Math.exp(event.deltaY * 0.001), minimumCameraDistance(toSceneRadius(radius)), MAX_CAMERA_DISTANCE);
    if (offset.lengthSq() === 0) offset.set(0, -1, 0);
    camera.position.copy(controls.target).add(offset.setLength(distance));
    camera.lookAt(controls.target);
  };
  const handlePlacementKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && (orbitalGesture || orbitalDraft)) {
      event.preventDefault(); event.stopPropagation();
      clearOrbitalDraft();
      return;
    }
    if (event.key === "Escape" && options.read().laserAim) {
      event.preventDefault(); event.stopPropagation();
      cancelLaserAimPointer();
      return;
    }
    const body = readPlacementBody();
    if (!body) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      consumedPlacement = body; placementDrag = null; placementArrow.visible = false;
      placementPreview.visible = false; hasPlacementPoint = false;
      cancelTrajectoryPreview();
      options.onCancelPlacement?.();
      return;
    }
    if (event.target === placementSpeedInput) return;
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault(); event.stopPropagation();
      const distance = Math.max(camera.position.distanceTo(controls.target), 1e-6);
      const step = Math.max(placementGhost.scale.x * 2, distance * 0.04);
      const maxOffset = distance * 0.75;
      const previous = placementDepthOffset;
      const next = THREE.MathUtils.clamp(previous + (event.key === "PageUp" ? step : -step), -maxOffset, maxOffset);
      placementDepthOffset = next;
      placementPoint.copy(placementPointOnDepth(placementPoint, camera.getWorldDirection(placementViewDirection), next - previous));
      placementPreview.position.copy(placementPoint); hasPlacementPoint = true;
      placementDepthReadout.textContent = `Plano: ${(next / SCENE_UNITS_PER_METER / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} km`;
      requestPlacementPreview(body);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !placementDrag && hasPlacementPoint) {
      event.preventDefault(); event.stopPropagation();
      commitPlacement(body, placementPoint.clone(), [0, 0, 0]);
    }
  };
  placementSpeedInput.addEventListener("input", () => {
    placementSpeedReadout.textContent = placementSpeedInput.value
      ? `Arrasto: ${Number(placementSpeedInput.value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km/s`
      : "Arrasto: automático";
    updatePlacementArrow();
    if (placementDrag) showPlacementVelocity(placementVelocity(placementDrag.start, placementDrag.current, Math.hypot(placementDrag.currentX - placementDrag.x, placementDrag.currentY - placementDrag.y)));
    const body = readPlacementBody();
    if (body) requestPlacementPreview(body);
  });
  let pointerStart = [0, 0];
  let rotatingPointer: { id: number; x: number; y: number } | undefined;
  const cancelFlightOnWheel = () => { cancelCameraFlight(); rotatingPointer = undefined; };
  const startRotatingPointer = (event: PointerEvent) => {
    rotatingPointer = rotatingFrameActive && !readPlacementBody() ? { id: event.pointerId, x: event.clientX, y: event.clientY } : undefined;
  };
  const moveRotatingPointer = (event: PointerEvent) => {
    if (rotatingPointer?.id !== event.pointerId) return;
    if (!event.buttons) { rotatingPointer = undefined; return; }
    if (Math.hypot(event.clientX - rotatingPointer.x, event.clientY - rotatingPointer.y) < 5) return;
    rotatingPointer = undefined;
    leaveRotatingFrame();
  };
  const endRotatingPointer = (event: PointerEvent) => { if (rotatingPointer?.id === event.pointerId) rotatingPointer = undefined; };
  const start = (event: PointerEvent) => { pointerStart = [event.clientX, event.clientY]; };
  const select = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - pointerStart[0]!, event.clientY - pointerStart[1]!) > 5) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = bodyHitAtPointer();
    if (hit) options.onSelect(hit.object.userData.bodyId as string, event.shiftKey);
  };
  const lost = (event: Event) => { event.preventDefault(); options.onError("A cena perdeu a conexão com a placa gráfica. Aguarde a recuperação ou atualize a página."); };
  const restored = () => options.onError(null);
  renderer.domElement.addEventListener("pointerdown", start);
  renderer.domElement.addEventListener("pointerdown", cancelCameraFlight, true);
  renderer.domElement.addEventListener("pointerdown", startRotatingPointer, true);
  renderer.domElement.addEventListener("pointermove", moveRotatingPointer, true);
  renderer.domElement.addEventListener("pointerup", endRotatingPointer, true);
  renderer.domElement.addEventListener("pointercancel", endRotatingPointer, true);
  renderer.domElement.addEventListener("wheel", cancelFlightOnWheel, true);
  renderer.domElement.addEventListener("pointerup", select);
  renderer.domElement.addEventListener("pointermove", updateHoveredBody);
  renderer.domElement.addEventListener("pointerleave", clearHoveredBody);
  renderer.domElement.addEventListener("pointerdown", laserPointerDown, true);
  renderer.domElement.addEventListener("pointermove", laserPointerMove, true);
  renderer.domElement.addEventListener("pointerup", laserPointerUp, true);
  renderer.domElement.addEventListener("pointercancel", laserPointerCancel, true);
  renderer.domElement.addEventListener("lostpointercapture", laserPointerCancel as EventListener, true);
  renderer.domElement.addEventListener("pointerdown", orbitalPointerDown, true);
  renderer.domElement.addEventListener("pointermove", orbitalPointerMove, true);
  renderer.domElement.addEventListener("pointerup", orbitalPointerUp, true);
  renderer.domElement.addEventListener("pointercancel", orbitalPointerCancel, true);
  renderer.domElement.addEventListener("lostpointercapture", orbitalLostPointerCapture, true);
  renderer.domElement.addEventListener("pointerdown", placementDown, true);
  renderer.domElement.addEventListener("pointermove", placementMove, true);
  renderer.domElement.addEventListener("pointerup", placementUp, true);
  renderer.domElement.addEventListener("pointercancel", placementCancelPointer, true);
  renderer.domElement.addEventListener("wheel", placementWheel, { capture: true, passive: false });
  window.addEventListener("keydown", handlePlacementKeydown, true);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  renderer.domElement.addEventListener("webglcontextrestored", restored);
  if (document.visibilityState !== "hidden") frame = requestAnimationFrame(animate);
  let disposed = false;
  const disposeScene = () => {
    if (disposed) return;
    disposed = true;
    if (sceneHost[ACTIVE_SCENE_DISPOSER] === disposeScene) Reflect.deleteProperty(sceneHost, ACTIVE_SCENE_DISPOSER);
    active = false; clearOrbitalDraft(); clearOrbitalGhosts(); cancelLaserAimPointer(false); options.onCancelLaserAim?.(); cancelAnimationFrame(frame); resize.disconnect(); overlayMutation?.disconnect(); window.removeEventListener?.("resize", handleResize); document.removeEventListener?.("visibilitychange", handleVisibilityChange); controls.removeEventListener("start", cancelCameraFlight); controls.removeEventListener("change", onControlsChange); controls.dispose();
    options.onCaptureReady?.(null);
    cancelTrajectoryPreviewTimer(); options.onTrajectoryPreviewCancel?.();
    window.removeEventListener("keydown", handlePlacementKeydown, true);
    renderer.domElement.removeEventListener("pointerdown", start);
    renderer.domElement.removeEventListener("pointerdown", cancelCameraFlight, true);
    renderer.domElement.removeEventListener("pointerdown", startRotatingPointer, true);
    renderer.domElement.removeEventListener("pointermove", moveRotatingPointer, true);
    renderer.domElement.removeEventListener("pointerup", endRotatingPointer, true);
    renderer.domElement.removeEventListener("pointercancel", endRotatingPointer, true);
    renderer.domElement.removeEventListener("wheel", cancelFlightOnWheel, true);
    renderer.domElement.removeEventListener("pointerup", select);
    renderer.domElement.removeEventListener("pointermove", updateHoveredBody);
    renderer.domElement.removeEventListener("pointerleave", clearHoveredBody);
    renderer.domElement.removeEventListener("pointerdown", laserPointerDown, true);
    renderer.domElement.removeEventListener("pointermove", laserPointerMove, true);
    renderer.domElement.removeEventListener("pointerup", laserPointerUp, true);
    renderer.domElement.removeEventListener("pointercancel", laserPointerCancel, true);
    renderer.domElement.removeEventListener("lostpointercapture", laserPointerCancel as EventListener, true);
    renderer.domElement.removeEventListener("pointerdown", orbitalPointerDown, true);
    renderer.domElement.removeEventListener("pointermove", orbitalPointerMove, true);
    renderer.domElement.removeEventListener("pointerup", orbitalPointerUp, true);
    renderer.domElement.removeEventListener("pointercancel", orbitalPointerCancel, true);
    renderer.domElement.removeEventListener("lostpointercapture", orbitalLostPointerCapture, true);
    renderer.domElement.removeEventListener("pointerdown", placementDown, true);
    renderer.domElement.removeEventListener("pointermove", placementMove, true);
    renderer.domElement.removeEventListener("pointerup", placementUp, true);
    renderer.domElement.removeEventListener("pointercancel", placementCancelPointer, true);
    renderer.domElement.removeEventListener("wheel", placementWheel, true);
    renderer.domElement.removeEventListener("webglcontextlost", lost);
    renderer.domElement.removeEventListener("webglcontextrestored", restored);
    for (const id of [...materializations.keys()]) clearMaterialization(id);
    materializationGeometry.dispose();
    visuals.forEach((visual) => visual.dispose());
    pickTargets.length = 0; bodyPickTargets.clear();
    disposeOrbits(orbitGroup);
    orbitTrailLine.geometry.dispose();
    const trailMaterials = Array.isArray(orbitTrailLine.material) ? orbitTrailLine.material : [orbitTrailLine.material];
    trailMaterials.forEach((material) => material.dispose());
    lagrangeMarkers.dispose(); eventEffects.dispose(); environment.dispose(); lensFlare.dispose(); geometry?.dispose(); renderer.dispose(); renderer.forceContextLoss();
    rockAssets?.dispose();
    placementPreview.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    if (trajectoryLine) trajectoryLine.geometry.dispose();
    trajectoryLineMaterial.dispose(); trajectoryContactGeometry.dispose(); trajectoryContactMaterial.dispose();
    renderer.domElement.remove(); markers.remove();
  };
  sceneHost[ACTIVE_SCENE_DISPOSER] = disposeScene;
  return disposeScene;
}
