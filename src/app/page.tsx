"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { ObjectInspector } from "@/features/simulation/ObjectInspector";
import type { SpinMutationOutcome } from "@/features/simulation/SpinControl";
import { BatchScaleControls } from "@/features/simulation/BatchScaleControls";
import { VisualBodySeriesPanel } from "@/features/simulation/VisualBodySeriesPanel";
import { visualBodySeriesReducer } from "@/features/simulation/visual-body-series";
import { isBodySelectionKeyboardShortcut, updateBodySelection } from "@/features/simulation/body-selection";
import { CREATIVE_BH_SCALE_DESCRIPTION, OVERVIEW_SCALE_DESCRIPTION, SimulationCanvas, translateSimulationError } from "@/features/simulation/SimulationCanvas";
import { SimulationToolbar } from "@/features/simulation/SimulationToolbar";
import { SimulationExperimentsDock } from "@/features/simulation/SimulationExperimentsDock";
import { BodyCatalog, shortBodyName } from "@/features/simulation/BodyCatalog";
import { chooseSurvivingBodyId, describeCollisionDetails, describeSimulationEvent, shouldRestoreAcknowledgedControlFocus } from "@/features/simulation/simulation-events";
import { useSceneAudio } from "@/features/simulation/scene-audio";
import { createCatalogBody, getBodyType } from "@/simulation/body-catalog";
import { findOrbitalPrimary, removeBodyFromWorld } from "@/simulation/orbital-analysis";
import { debrisBodyIdsFromEvents, isDebrisBody, setActiveDebrisBodyIds } from "@/simulation/body-identity";
import { createBodyEditCandidate } from "@/simulation/body-edits";
import { MAX_SIMULATION_BODIES, validateSimulationState } from "@/simulation/physics";
import { applyWorldMutation, MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG } from "@/simulation/world-mutations";
import { isLaserShotAllowedForRevision } from "@/simulation/laser-model";
import { createSolarSystem } from "@/simulation/solar-system";
import { createExperimentPreset, type ExperimentId } from "@/simulation/experiment-presets";
import { DEFAULT_SIMULATION_SPEED } from "@/simulation/simulation-time";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "@/simulation/world-seed";
import { createEmptySwarmLedger } from "@/simulation/swarm-model";
import type { BodyType, CelestialBody, CollisionMode, EditableBodyField, LaserAimConfiguration, OrbitalMutationPreviewResponse, OrbitalPlacementMutation, PendingWorldMutation, PhysicsSettings, SimulationEvent, SimulationSessionState, SimulationSnapshot, SurfaceData, SurfaceHeatData, SurfaceStateMessage, SwarmLedger, ThermalProfileId, Vector3, WorldHistorySummary, WorldMutation, WorldRestoreDirection, WorldSetOrigin } from "@/simulation/types";
import { isSurfaceStateAcceptedAtSnapshot } from "@/simulation/surface-state";
import { shouldResumeFromSnapshot, snapshotStopsRunning } from "./snapshot-running";
import type { SimulationSaveData } from "@/simulation/save-file";
import type { LagrangePoint } from "@/features/simulation/lagrange-points";
import type { AcceptedAutosaveSnapshot } from "@/features/simulation/local-autosave";
import type { BoundOrbitalPreview, OrbitalPlacementIntent } from "@/features/simulation/OrbitalPlacementControls";
import type { SimulationRevisionOutcome } from "@/simulation/simulation-client";

const initialBodies = createSolarSystem();
const initialSettings = { gravitationalConstant: 6.6743e-11 };
const compactRemnantTypes = new Set<BodyType>(["white-dwarf", "neutron-star", "black-hole"]);
const emptyWorldHistory: WorldHistorySummary = { generation: 0, undoCheckpointId: null, redoCheckpointId: null, actionCount: 0, bytes: 0 };
const LIVE_SNAPSHOT_UI_INTERVAL_MS = 100;
const VISUAL_SERIES_SAMPLE_INTERVAL_MS = 200;
type ExperimentPresentation = { experimentId: ExperimentId | null; selectedBodyId: string; speed: number; viewMode: "focus" | "system"; showOrbits: boolean; showTrails: boolean; inspectorOpen: boolean; rotatingFrame: boolean };
type ExperimentHistoryTransition = { previous: ExperimentPresentation; next: ExperimentPresentation; previousCheckpointId: string | null };
type AcceptedSurfaceSnapshot = AcceptedAutosaveSnapshot & { surfaceData: SurfaceData; swarmLedger?: SwarmLedger };

function isOrbitalPreviewCurrent(intent: OrbitalPlacementIntent | null, preview: BoundOrbitalPreview | null, snapshot: Pick<SimulationSnapshot, "worldRevision" | "simulationTimeSeconds" | "status" | "stellarEvolutionRunning">): boolean {
  if (!intent || !preview || !preview.response || preview.response.result?.status !== "ready") return false;
  const response = preview.response;
  return response.version === 1 && Number.isSafeInteger(response.requestId) && response.requestId > 0
    && response.worldRevision === intent.worldRevision && response.baseTimeSeconds === intent.baseTimeSeconds
    && response.worldRevision === (snapshot.worldRevision ?? 0) && response.baseTimeSeconds === snapshot.simulationTimeSeconds
    && snapshot.status === "paused" && !snapshot.stellarEvolutionRunning
    && JSON.stringify(intent.mutation) === JSON.stringify(preview.mutation);
}

function getOrbitalPlacementCommit(intent: OrbitalPlacementIntent | null, preview: BoundOrbitalPreview | null,
  snapshot: Pick<SimulationSnapshot, "worldRevision" | "simulationTimeSeconds" | "status" | "stellarEvolutionRunning">,
  requestId: number, lastCommittedRequestId: number): OrbitalPlacementMutation | null {
  if (!intent || !preview || !isOrbitalPreviewCurrent(intent, preview, snapshot)
    || preview.response.requestId !== requestId || requestId <= lastCommittedRequestId) return null;
  return intent.mutation;
}

export default function Home() {
  const [bodies, setBodies] = useState(initialBodies);
  const [selectedBodyId, setSelectedBodyId] = useState("sun");
  const [selectedBodyIds, setSelectedBodyIds] = useState<string[]>(["sun"]);
  const [visualBodySeries, dispatchVisualBodySeries] = useReducer(visualBodySeriesReducer, []);
  const [settings, setSettings] = useState<PhysicsSettings>(initialSettings);
  const [environmentSeed, setEnvironmentSeed] = useState(DEFAULT_ENVIRONMENT_SEED_V1);
  const [acceptedGravitationalConstant, setAcceptedGravitationalConstant] = useState(initialSettings.gravitationalConstant);
  const [speed, setSpeed] = useState(DEFAULT_SIMULATION_SPEED);
  const [status, setStatus] = useState<SimulationSnapshot["status"]>("paused");
  const [speedLimited, setSpeedLimited] = useState(false);
  const [running, setRunning] = useState(false);
  const sceneAudio = useSceneAudio();
  const [stellarEvolutionRunning, setStellarEvolutionRunning] = useState(false);
  const [solarEvolutionCommand, setSolarEvolutionCommand] = useState<{ id: number; running: boolean } | null>(null);
  const [collisionMode, setCollisionMode] = useState<CollisionMode>("scientific");
  const [collisionModeCommand, setCollisionModeCommand] = useState<{ id: number; mode: CollisionMode; revision: number; origin?: "bootstrap" } | null>(null);
  const [history, setHistory] = useState<WorldHistorySummary>(emptyWorldHistory);
  const [historyRestorePending, setHistoryRestorePending] = useState(false);
  const [historyRestoreCommand, setHistoryRestoreCommand] = useState<{ id: number; checkpointId: string; direction: WorldRestoreDirection; revision: number; generation: number } | null>(null);
  const [experimentBusy, setExperimentBusy] = useState(false);
  const [activeExperiment, setActiveExperiment] = useState<ExperimentId | null>(null);
  const [placementBody, setPlacementBody] = useState<CelestialBody | null>(null);
  const [orbitalPlacement, setOrbitalPlacement] = useState<OrbitalPlacementIntent | null>(null);
  const [orbitalPreview, setOrbitalPreview] = useState<BoundOrbitalPreview | null>(null);
  const [orbitalPreviewState, setOrbitalPreviewState] = useState<"idle" | "scheduled" | "calculating" | "unavailable">("idle");
  const [laserAim, setLaserAim] = useState<LaserAimConfiguration | null>(null);
  const [creationPending, setCreationPending] = useState(false);
  const [showOrbits, setShowOrbits] = useState(true);
  const [showTrails, setShowTrails] = useState(false);
  const [viewMode, setViewMode] = useState<"focus" | "system">("system");
  const [viewRequest, setViewRequest] = useState(0);
  const [rotatingFrame, setRotatingFrame] = useState(false);
  const [rotatingFrameStatus, setRotatingFrameStatus] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [simulationTime, setSimulationTime] = useState(0);
  const [acceptedAutosaveSnapshot, setAcceptedAutosaveSnapshot] = useState<AcceptedSurfaceSnapshot | null>(null);
  const [acceptedSurfaceData, setAcceptedSurfaceData] = useState<SurfaceData>({});
  const [acceptedSurfaceHeatData, setAcceptedSurfaceHeatData] = useState<SurfaceHeatData>({});
  const acceptedSurfaceDataRef = useRef<SurfaceData>({});
  const acceptedSurfaceHeatDataRef = useRef<SurfaceHeatData>({});
  const acceptedSurfaceStateRevision = useRef(-1);
  const pendingSurfaceState = useRef<SurfaceStateMessage | null>(null);
  const acceptedAutosaveSequence = useRef(0);
  const lastLiveSnapshotUiUpdateAt = useRef(0);
  const lastVisualSeriesSampleAt = useRef(0);
  const [worldError, setWorldError] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [resetEpoch, setResetEpoch] = useState(0);
  const [toolbarEpoch, setToolbarEpoch] = useState(0);
  const [latestEvent, setLatestEvent] = useState<SimulationEvent | null>(null);
  const [eventFocusRequest, setEventFocusRequest] = useState<{ eventId: number; requestId: number } | null>(null);
  const eventFocusRequestId = useRef(0);
  const latestCollisionDetails = latestEvent ? describeCollisionDetails(latestEvent, bodies) : null;
  const seenEventId = useRef(-1);
  const acceptedDebrisBodyIds = useRef(new Set<string>());
  const explosionFocusPending = useRef(false);
  const restoreExplosionFocus = useRef(false);
  const requestEventFocus = (eventId: number) => setEventFocusRequest({ eventId, requestId: ++eventFocusRequestId.current });
  const current = useRef<SimulationSnapshot>({ bodies, settings, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1, swarmLedger: createEmptySwarmLedger(), simulationTimeSeconds: 0, status: "paused", collisionMode: "scientific" });
  const [worldRevision, setWorldRevision] = useState(1);
  const worldReplacementRevision = useRef<number | null>(null);
  const pendingResetReframeRevision = useRef<number | null>(null);
  const worldReplacementOrigin = useRef<WorldSetOrigin>("reset");
  const worldReplacementCollisionMode = useRef<CollisionMode | undefined>(undefined);
  const worldReplacementSession = useRef<SimulationSessionState | undefined>(undefined);
  const worldReplacementEnvironmentSeed = useRef(DEFAULT_ENVIRONMENT_SEED_V1);
  const worldReplacementSurfaceData = useRef<SurfaceData>({});
  const worldReplacementSwarmLedger = useRef<SwarmLedger>(createEmptySwarmLedger());
  const pendingImportPresentation = useRef<{ revision: number; presentation: ExperimentPresentation } | null>(null);
  const acceptedPresentationEpoch = useRef<number | null>(null);
  const pendingHistoryRestore = useRef<{ revision: number; checkpointId: string; direction: WorldRestoreDirection } | null>(null);
  const historyExperimentCheckpoints = useRef(new Map<string, ExperimentHistoryTransition>());
  const historyExperimentGeneration = useRef<number | null>(null);
  const historyRestoreCommandId = useRef(0);
  const [pendingWorldMutations, setPendingWorldMutations] = useState<readonly PendingWorldMutation[]>([]);
  const [spinMutationOutcomes, setSpinMutationOutcomes] = useState<Record<string, SpinMutationOutcome>>({});
  const spinMutationOutcomesRef = useRef<Record<string, SpinMutationOutcome>>({});
  const pendingSpinMutations = useRef(new Map<number, Extract<WorldMutation, { type: "SET_BODY_SPIN" }>>());
  const worldRevisionRef = useRef(1);
  const issuedWorldRevisionRef = useRef(1);
  const solarEvolutionCommandId = useRef(0);
  const collisionModeCommandId = useRef(0);
  const lastLaserShotRevision = useRef<number | null>(null);
  const creativeBootstrapped = useRef(false);
  const placementCommit = useRef<{ revision: number; resumeRunning: boolean } | null>(null);
  const orbitalPlacementRef = useRef<OrbitalPlacementIntent | null>(null);
  const orbitalPreviewRef = useRef<BoundOrbitalPreview | null>(null);
  const lastCommittedOrbitalPreviewId = useRef(0);
  const duplicatePlacementSourceId = useRef<string | null>(null);
  const createdBodyCommit = useRef<{ revision: number; acceptedBodyIds: ReadonlySet<string> } | null>(null);
  const focusMassAfterInspectorOpen = useRef(false);
  const creativeTransition = useRef<{ phase: "world" | "mode" | "explosion"; worldRevision: number; mode: CollisionMode; resumeRunning: boolean; experimentId?: ExperimentId; historyExperiment?: ExperimentHistoryTransition; explodeBodyId?: string; explodeSpecificEnergyJkg?: number } | null>(null);
  const mobileInspectorToggle = useRef<HTMLButtonElement>(null);
  const mobileInspectorClose = useRef<HTMLButtonElement>(null);
  const mobileInspectorFocus = useRef<"close" | "opener" | null>(null);
  const selectedBody = bodies.find((body) => body.id === selectedBodyId) ?? bodies[0];
  const selectedPrimary = selectedBody ? findOrbitalPrimary(selectedBody, bodies, settings) : undefined;
  const rotatingFrameActive = rotatingFrame && Boolean(selectedPrimary);
  const creativeBlackHoleVisual = Boolean(collisionMode === "creative" && selectedBody?.bodyType === "black-hole");
  const canDuplicate = Boolean(selectedBody && bodies.length < MAX_SIMULATION_BODIES && !stellarEvolutionRunning
    && !solarEvolutionCommand && !creationPending && !experimentBusy && !placementBody && pendingWorldMutations.length === 0);
  const clearAcceptedDebrisBodyIds = () => {
    acceptedDebrisBodyIds.current = new Set();
    setActiveDebrisBodyIds(acceptedDebrisBodyIds.current);
  };
  const clearOrbitalPlacement = () => {
    orbitalPlacementRef.current = null;
    orbitalPreviewRef.current = null;
    setOrbitalPlacement(null);
    setOrbitalPreview(null);
    setOrbitalPreviewState("idle");
  };
  const handleRotatingFrameChange = (active: boolean) => {
    const nextActive = active && Boolean(selectedBody && selectedPrimary);
    setRotatingFrame(nextActive);
    setRotatingFrameStatus(nextActive && selectedBody && selectedPrimary
      ? `Referencial orbital: ${selectedBody.name} e ${selectedPrimary.name}. L1–L5 são aproximações; clique num ponto para criar um cometa.`
      : "Referencial orbital desativado.");
  };
  useEffect(() => {
    if (!restoreExplosionFocus.current) return;
    restoreExplosionFocus.current = false;
    if (!document.hasFocus() || document.activeElement !== document.body) return;
    document.getElementById("explode-astro")?.focus();
  }, [latestEvent?.id, selectedBodyId]);
  useEffect(() => {
    setActiveDebrisBodyIds(acceptedDebrisBodyIds.current);
    return () => setActiveDebrisBodyIds(new Set());
  }, []);
  useEffect(() => {
    const destination = mobileInspectorFocus.current;
    if (!destination) return;
    mobileInspectorFocus.current = null;
    (destination === "close" ? mobileInspectorClose : mobileInspectorToggle).current?.focus();
  }, [inspectorOpen]);
  useEffect(() => {
    if (!inspectorOpen || !focusMassAfterInspectorOpen.current) return;
    focusMassAfterInspectorOpen.current = false;
    document.getElementById("slider-mass")?.focus();
  }, [inspectorOpen]);
  useEffect(() => {
    const scrollSelectedIntoView = () => {
      const navigation = document.querySelector<HTMLElement>(".planet-navigation");
      const item = [...(navigation?.querySelectorAll<HTMLButtonElement>("[data-body-id]") ?? [])].find((button) => button.dataset.bodyId === selectedBodyId);
      if (!navigation || !item) return;
      const navigationBounds = navigation.getBoundingClientRect();
      const itemBounds = item.getBoundingClientRect();
      if (itemBounds.left < navigationBounds.left || itemBounds.right > navigationBounds.right) {
        navigation.scrollTo({ left: navigation.scrollLeft + itemBounds.left - navigationBounds.left - (navigation.clientWidth - itemBounds.width) / 2, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    };
    scrollSelectedIntoView();
    window.addEventListener("resize", scrollSelectedIntoView);
    return () => window.removeEventListener("resize", scrollSelectedIntoView);
  }, [bodies.length, selectedBodyId]);
  const advanceWorldRevision = () => {
    const revision = issuedWorldRevisionRef.current + 1;
    issuedWorldRevisionRef.current = revision;
    return revision;
  };

  const markWorldReplacement = (revision: number, origin: WorldSetOrigin, mode?: CollisionMode, environmentSeed = current.current.environmentSeed, surfaceData: SurfaceData = {}, swarmLedger: SwarmLedger = createEmptySwarmLedger()) => {
    pendingResetReframeRevision.current = null;
    setLaserAim(null);
    sceneAudio.reset();
    pendingImportPresentation.current = null;
    worldReplacementRevision.current = revision;
    worldReplacementOrigin.current = origin;
    worldReplacementCollisionMode.current = mode;
    worldReplacementSession.current = undefined;
    worldReplacementEnvironmentSeed.current = environmentSeed;
    worldReplacementSurfaceData.current = surfaceData;
    worldReplacementSwarmLedger.current = swarmLedger;
    dispatchVisualBodySeries({ type: "world-replaced" });
  };
  const markImportedWorld = (revision: number, session: SimulationSessionState | undefined, environmentSeed: number, surfaceData: SurfaceData, swarmLedger: SwarmLedger = createEmptySwarmLedger()) => {
    pendingResetReframeRevision.current = null;
    setLaserAim(null);
    sceneAudio.reset();
    pendingImportPresentation.current = null;
    worldReplacementRevision.current = revision;
    worldReplacementOrigin.current = "import";
    worldReplacementCollisionMode.current = undefined;
    worldReplacementSession.current = session;
    worldReplacementEnvironmentSeed.current = environmentSeed;
    worldReplacementSurfaceData.current = surfaceData;
    worldReplacementSwarmLedger.current = swarmLedger;
    dispatchVisualBodySeries({ type: "world-replaced" });
  };

  const applyExperimentPresentation = (presentation: ExperimentPresentation, snapshot: SimulationSnapshot) => {
    const selectedId = snapshot.bodies.some((body) => body.id === presentation.selectedBodyId)
      ? presentation.selectedBodyId : snapshot.bodies[0]?.id ?? "";
    const selected = snapshot.bodies.find((body) => body.id === selectedId);
    const primary = selected ? findOrbitalPrimary(selected, snapshot.bodies, snapshot.settings ?? settings) : undefined;
    const restoreRotatingFrame = presentation.rotatingFrame && Boolean(primary);
    setActiveExperiment(presentation.experimentId);
    setSelectedBodyId(selectedId);
    setSelectedBodyIds([selectedId]);
      setSelectedBodyIds([selectedId]);
    setSpeed(presentation.speed);
    setViewMode(presentation.viewMode);
    setShowOrbits(presentation.showOrbits);
    setShowTrails(presentation.showTrails);
    setInspectorOpen(presentation.inspectorOpen);
    setRotatingFrame(restoreRotatingFrame);
    setRotatingFrameStatus(restoreRotatingFrame && selected && primary
      ? `Referencial orbital: ${selected.name} e ${primary.name}. L1–L5 são aproximações; clique num ponto para criar cometa.`
      : "Referencial orbital desativado.");
    setViewRequest((value) => value + 1);
  };

  const enqueueTypedMutation = (mutation: WorldMutation, coalesceId?: string) => {
    setLaserAim(null);
    if (orbitalPlacementRef.current) clearOrbitalPlacement();
    const revision = advanceWorldRevision();
    setPendingWorldMutations((pending) => [...pending, { revision, mutation, ...(coalesceId === undefined ? {} : { coalesceId }) }]);
    return revision;
  };

  const restoreHistoryCheckpoint = (direction: WorldRestoreDirection) => {
    if (pendingHistoryRestore.current || pendingWorldMutations.length || worldReplacementRevision.current !== null || experimentBusy || creationPending || stellarEvolutionRunning || solarEvolutionCommand || creativeTransition.current) return;
    const acceptedHistory = current.current.history ?? history;
    const checkpointId = direction === "undo" ? acceptedHistory.undoCheckpointId : acceptedHistory.redoCheckpointId;
    if (!checkpointId) return;
    setLaserAim(null);
    const revision = advanceWorldRevision();
    pendingHistoryRestore.current = { revision, checkpointId, direction };
    setHistoryRestorePending(true);
    setHistoryRestoreCommand({ id: ++historyRestoreCommandId.current, checkpointId, direction, revision, generation: acceptedHistory.generation });
  };

  const failHistoryRestore = (message: string) => {
    pendingHistoryRestore.current = null;
    setHistoryRestorePending(false);
    setHistoryRestoreCommand(null);
    setWorldError(message);
  };

  const requestCollisionMode = (mode: CollisionMode, resumeRunning: boolean, experimentId?: ExperimentId, explodeBodyId?: string, explodeSpecificEnergyJkg?: number, origin?: "bootstrap") => {
    setLaserAim(null);
    const worldRevision = advanceWorldRevision();
    creativeTransition.current = { phase: "mode", worldRevision, mode, resumeRunning, ...(experimentId ? { experimentId } : {}), ...(explodeBodyId ? { explodeBodyId, ...(explodeSpecificEnergyJkg === undefined ? {} : { explodeSpecificEnergyJkg }) } : {}) };
    setRunning(false);
    setCollisionModeCommand({ id: ++collisionModeCommandId.current, mode, revision: worldRevision, ...(origin === undefined ? {} : { origin }) });
  };
  const changeCollisionMode = (mode: CollisionMode) => {
    if (mode === collisionMode || creativeTransition.current || pendingWorldMutations.length || worldReplacementRevision.current !== null || historyRestorePending || experimentBusy) return;
    requestCollisionMode(mode, false);
  };

  const handleSurfaceState = (state: SurfaceStateMessage) => {
    const pending = pendingSurfaceState.current;
    if (state.worldRevision < acceptedSurfaceStateRevision.current || pending && state.worldRevision < pending.worldRevision) return;
    pendingSurfaceState.current = state;
  };

  const recordSpinOutcome = (mutationRevision: number, resolutionWorldRevision: number, bodyId: string, status: SpinMutationOutcome["status"], expectedSpin: SpinMutationOutcome["expectedSpin"], message?: string) => {
    const previous = spinMutationOutcomesRef.current[bodyId];
    if (previous && previous.mutationRevision > mutationRevision) return;
    const next = { ...spinMutationOutcomesRef.current, [bodyId]: { bodyId, mutationRevision, resolutionWorldRevision, status, expectedSpin, ...(message ? { message } : {}) } };
    spinMutationOutcomesRef.current = next;
    setSpinMutationOutcomes(next);
  };

  const handleRevisionOutcome = (outcome: SimulationRevisionOutcome) => {
    if (outcome.type === "snapshot") {
      if (collisionModeCommand && outcome.worldRevision >= collisionModeCommand.revision) setCollisionModeCommand(null);
      const mutation = pendingSpinMutations.current.get(outcome.worldRevision);
      if (!mutation) return;
      pendingSpinMutations.current.delete(outcome.worldRevision);
      recordSpinOutcome(outcome.worldRevision, outcome.worldRevision, mutation.bodyId, "accepted", mutation.spin);
      setPendingWorldMutations((pending) => pending.filter((entry) => entry.revision !== outcome.worldRevision));
      return;
    }

    if (outcome.rejectedRevision !== undefined && collisionModeCommand?.revision === outcome.rejectedRevision) setCollisionModeCommand(null);
    if (outcome.rejectedRevision === undefined) return;
    const revision = outcome.rejectedRevision;
    const pendingMutation = pendingSpinMutations.current.get(revision);
    const priorOutcome = Object.values(spinMutationOutcomesRef.current).find((item) => item.mutationRevision === revision);
    const bodyId = pendingMutation?.bodyId ?? priorOutcome?.bodyId;
    if (!bodyId) return;
    pendingSpinMutations.current.delete(revision);
    recordSpinOutcome(revision, revision, bodyId, "rejected",
      acceptedAutosaveSnapshot?.bodies.find((body) => body.id === bodyId)?.spin ?? null,
      translateSimulationError(outcome.message));
    setPendingWorldMutations((pending) => pending.filter((entry) => entry.revision !== revision));
  };

  const handleSnapshot = (snapshot: SimulationSnapshot) => {
    let presentationToRestore: ExperimentPresentation | null = null;
    if (snapshot.worldRevision !== undefined && snapshot.worldRevision < worldRevisionRef.current) return;
    const activeOrbitalPlacement = orbitalPlacementRef.current;
    if (activeOrbitalPlacement && (snapshot.worldRevision !== activeOrbitalPlacement.worldRevision
      || snapshot.simulationTimeSeconds !== activeOrbitalPlacement.baseTimeSeconds
      || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning)) clearOrbitalPlacement();
    const presentationEpoch = snapshot.presentationEpoch ?? 0;
    const presentationChanged = acceptedPresentationEpoch.current !== null && presentationEpoch !== acceptedPresentationEpoch.current;
    acceptedPresentationEpoch.current = presentationEpoch;
    if (presentationChanged) {
      clearAcceptedDebrisBodyIds();
      setLatestEvent(null);
      setEventFocusRequest(null);
    }
    const worldRevisionChanged = snapshot.worldRevision !== undefined && snapshot.worldRevision !== worldRevisionRef.current;
    const snapshotReceivedAt = performance.now();
    const listener = snapshot.bodies.find((body) => body.id === selectedBodyId) ?? snapshot.bodies[0];
    const newEvents = sceneAudio.acceptSnapshot(snapshot, worldRevisionRef.current, seenEventId.current, listener?.positionM, !presentationChanged);
    for (const id of debrisBodyIdsFromEvents(newEvents)) acceptedDebrisBodyIds.current.add(id);
    if (newEvents.length) setActiveDebrisBodyIds(acceptedDebrisBodyIds.current);
    const latestNewEvent = newEvents.at(-1);
    const snapshotNeedsImmediateUi = snapshot.status !== "running" || snapshot.status !== status || worldRevisionChanged
      || presentationChanged || newEvents.length > 0 || Boolean(snapshot.error);
    const publishLiveUi = snapshotNeedsImmediateUi || snapshotReceivedAt - lastLiveSnapshotUiUpdateAt.current >= LIVE_SNAPSHOT_UI_INTERVAL_MS;
    if (publishLiveUi) lastLiveSnapshotUiUpdateAt.current = snapshotReceivedAt;
    const acceptedSelectedBodyId = chooseSurvivingBodyId(snapshot.bodies, selectedBodyId, newEvents);
    setCollisionMode(snapshot.collisionMode);
    setSpeedLimited(snapshot.speedLimited === true);
    const acceptedHistory = snapshot.history ?? emptyWorldHistory;
    if (historyExperimentGeneration.current !== acceptedHistory.generation) {
      historyExperimentCheckpoints.current.clear();
      historyExperimentGeneration.current = acceptedHistory.generation;
    }
    setHistory((previous) => previous.generation === acceptedHistory.generation
      && previous.undoCheckpointId === acceptedHistory.undoCheckpointId
      && previous.redoCheckpointId === acceptedHistory.redoCheckpointId
      && previous.actionCount === acceptedHistory.actionCount
      && previous.bytes === acceptedHistory.bytes ? previous : acceptedHistory);
    if (snapshot.worldRevision !== undefined) {
      worldRevisionRef.current = snapshot.worldRevision;
      issuedWorldRevisionRef.current = Math.max(issuedWorldRevisionRef.current, snapshot.worldRevision);
      setWorldRevision(snapshot.worldRevision);
      for (const [revision, mutation] of pendingSpinMutations.current) {
        if (revision >= snapshot.worldRevision) continue;
        pendingSpinMutations.current.delete(revision);
        recordSpinOutcome(revision, snapshot.worldRevision, mutation.bodyId, "superseded", snapshot.bodies.find((body) => body.id === mutation.bodyId)?.spin ?? null,
          "O snapshot avançou sem confirmação desta alteração; valores aceitos restaurados.");
      }
      setPendingWorldMutations((pending) => {
        const remaining = pending.filter((entry) => entry.revision > snapshot.worldRevision!
          || entry.mutation.type === "SET_BODY_SPIN" && pendingSpinMutations.current.has(entry.revision));
        return remaining.length === pending.length ? pending : remaining;
      });
      if (worldReplacementRevision.current !== null && snapshot.worldRevision >= worldReplacementRevision.current) {
        worldReplacementRevision.current = null;
        worldReplacementSession.current = undefined;
      }
      const resetReframeRevision = pendingResetReframeRevision.current;
      if (resetReframeRevision !== null && snapshot.worldRevision >= resetReframeRevision) {
        pendingResetReframeRevision.current = null;
        if (!snapshot.error && snapshot.status !== "error") {
          setViewMode("system");
          setViewRequest((value) => value + 1);
        }
      }
      const pendingImport = pendingImportPresentation.current;
      if (pendingImport && snapshot.worldRevision >= pendingImport.revision) {
        if (snapshot.error || snapshot.status === "error") presentationToRestore = pendingImport.presentation;
        pendingImportPresentation.current = null;
      }
      if (pendingHistoryRestore.current && snapshot.worldRevision >= pendingHistoryRestore.current.revision) {
        const restore = pendingHistoryRestore.current;
        const experiment = historyExperimentCheckpoints.current.get(restore.checkpointId);
        if (experiment && !snapshot.error && snapshot.status !== "error") {
          presentationToRestore = restore.direction === "undo" ? experiment.previous : experiment.next;
          const nextCheckpointId = restore.direction === "undo" ? snapshot.history?.redoCheckpointId : snapshot.history?.undoCheckpointId;
          if (nextCheckpointId) {
            historyExperimentCheckpoints.current.set(nextCheckpointId, experiment);
            while (historyExperimentCheckpoints.current.size > 40) {
              const oldest = historyExperimentCheckpoints.current.keys().next().value;
              if (oldest === undefined) break;
              historyExperimentCheckpoints.current.delete(oldest);
            }
          }
        }
        pendingHistoryRestore.current = null;
        setHistoryRestorePending(false);
        setHistoryRestoreCommand(null);
        setRunning(snapshot.status === "running");
      }
    }
    if (latestNewEvent) {
      if (newEvents.some((event) => event.type === "explosion") && explosionFocusPending.current) {
        explosionFocusPending.current = false;
        restoreExplosionFocus.current = shouldRestoreAcknowledgedControlFocus(document.activeElement, document.getElementById("explode-astro"), document.hasFocus());
        const explicitExplosion = [...newEvents].reverse().find((event) => event.type === "explosion");
        if (explicitExplosion) requestEventFocus(explicitExplosion.id);
      }
      seenEventId.current = latestNewEvent.id;
      setLatestEvent(latestNewEvent);
    }
    current.current = snapshot;
    if (publishLiveUi && (snapshotNeedsImmediateUi || snapshotReceivedAt - lastVisualSeriesSampleAt.current >= VISUAL_SERIES_SAMPLE_INTERVAL_MS)) {
      dispatchVisualBodySeries({ type: "accepted-snapshot", trackedBodyIds: selectedBodyIds, snapshot });
      lastVisualSeriesSampleAt.current = snapshotReceivedAt;
    }
    const surfaceUpdate = pendingSurfaceState.current;
    if (surfaceUpdate && isSurfaceStateAcceptedAtSnapshot(surfaceUpdate, snapshot.worldRevision ?? worldRevisionRef.current, acceptedSurfaceStateRevision.current)) {
      acceptedSurfaceDataRef.current = surfaceUpdate.surfaceData;
      acceptedSurfaceHeatDataRef.current = surfaceUpdate.surfaceHeatData;
      acceptedSurfaceStateRevision.current = surfaceUpdate.worldRevision;
      pendingSurfaceState.current = null;
    } else if (surfaceUpdate && surfaceUpdate.worldRevision < (snapshot.worldRevision ?? worldRevisionRef.current)) pendingSurfaceState.current = null;
    if (publishLiveUi) {
      setAcceptedSurfaceData(acceptedSurfaceDataRef.current);
      setAcceptedSurfaceHeatData(acceptedSurfaceHeatDataRef.current);
      setBodies(snapshot.bodies);
      setSimulationTime(snapshot.simulationTimeSeconds);
      setAcceptedAutosaveSnapshot({
        bodies: snapshot.bodies,
        environmentSeed: snapshot.environmentSeed,
        settings: snapshot.settings ?? settings,
        simulationTimeSeconds: snapshot.simulationTimeSeconds,
        collisionMode: snapshot.collisionMode,
        status: snapshot.status,
        worldRevision: snapshot.worldRevision ?? worldRevisionRef.current,
        sequence: ++acceptedAutosaveSequence.current,
        surfaceData: acceptedSurfaceDataRef.current,
        ...(snapshot.swarmLedger ? { swarmLedger: snapshot.swarmLedger } : {}),
      });
    }
    setEnvironmentSeed(snapshot.environmentSeed);
    if (snapshot.settings) setAcceptedGravitationalConstant(snapshot.settings.gravitationalConstant);
    const evolutionActive = snapshot.stellarEvolutionRunning ?? false;
    setStellarEvolutionRunning(evolutionActive);
    if (snapshot.error) setSolarEvolutionCommand(null);
    else if (solarEvolutionCommand?.running === evolutionActive) setSolarEvolutionCommand(null);
    if (evolutionActive) setRunning(false);
    if (laserAim && (!snapshot.bodies.some((body) => body.id === laserAim.bodyId) || newEvents.some((event) => event.type === "laser"))) setLaserAim(null);
    if (snapshot.bodies.length) {
      setSelectedBodyId(acceptedSelectedBodyId);
      setSelectedBodyIds((previous) => {
        const surviving = previous.filter((id) => snapshot.bodies.some((body) => body.id === id));
        const next = surviving.length ? surviving : [acceptedSelectedBodyId];
        return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next;
      });
      if (worldRevisionChanged && rotatingFrame) {
        const acceptedSelectedBody = snapshot.bodies.find((body) => body.id === acceptedSelectedBodyId);
        if (!acceptedSelectedBody || !findOrbitalPrimary(acceptedSelectedBody, snapshot.bodies, snapshot.settings ?? settings)) {
          setRotatingFrame(false);
          setRotatingFrameStatus("Referencial orbital desativado porque não há primário inferido.");
        }
      }
    }
    if (snapshot.error) {
      setWorldError(translateSimulationError(snapshot.error));
      if (placementCommit.current) { placementCommit.current = null; setCreationPending(false); }
      createdBodyCommit.current = null;
      explosionFocusPending.current = false;
      restoreExplosionFocus.current = false;
    }
    else if (snapshot.status === "running") setWorldError("");
    if (snapshotStopsRunning(snapshot)) {
      createdBodyCommit.current = null;
      setRunning(false);
      explosionFocusPending.current = false;
      restoreExplosionFocus.current = false;
    }
    if (snapshot.settings && snapshot.settings.gravitationalConstant !== settings.gravitationalConstant) {
      setSettings(snapshot.settings);
    }
    setStatus(snapshot.status);
    if (snapshot.worldRevision !== undefined && placementCommit.current && snapshot.worldRevision >= placementCommit.current.revision) {
      const resumeRunning = placementCommit.current.resumeRunning;
      placementCommit.current = null;
      setCreationPending(false);
      if (shouldResumeFromSnapshot(snapshot, resumeRunning)) setRunning(true);
    }
    if (snapshot.worldRevision !== undefined && createdBodyCommit.current && snapshot.worldRevision >= createdBodyCommit.current.revision) {
      const createdBody = snapshot.bodies.find((body) => !createdBodyCommit.current!.acceptedBodyIds.has(body.id));
      createdBodyCommit.current = null;
      if (createdBody) {
        setSelectedBodyId(createdBody.id);
        setSelectedBodyIds([createdBody.id]);
        setInspectorOpen(true);
      }
    }
    const transition = creativeTransition.current;
    if (transition && (snapshot.error || snapshot.status === "error")) {
      if (transition.phase === "world" && transition.historyExperiment) {
        presentationToRestore = transition.historyExperiment.previous;
      }
      creativeTransition.current = null;
      setExperimentBusy(false);
      setRunning(false);
    } else if (transition && snapshot.worldRevision !== undefined && snapshot.worldRevision >= transition.worldRevision) {
      if (transition.phase === "world") {
        creativeTransition.current = null;
        setExperimentBusy(false);
        if (snapshot.collisionMode !== transition.mode) {
          setWorldError("O modo de colisão do cenário não foi confirmado pelo Worker.");
          setRunning(false);
        } else {
          if (transition.experimentId) {
            setActiveExperiment(transition.experimentId);
            const checkpointId = transition.historyExperiment && snapshot.history?.undoCheckpointId;
            if (checkpointId && checkpointId !== transition.historyExperiment?.previousCheckpointId) {
              historyExperimentCheckpoints.current.set(checkpointId, transition.historyExperiment!);
            }
          }
          if (transition.resumeRunning && !placementBody) setRunning(true);
        }
      } else if (transition.phase === "mode" && snapshot.collisionMode === transition.mode) {
        if (transition.explodeBodyId) {
          creativeTransition.current = { ...transition, phase: "explosion", worldRevision: issuedWorldRevisionRef.current + 1 };
          explosionFocusPending.current = true;
          const revision = enqueueTypedMutation(transition.explodeSpecificEnergyJkg === undefined
            ? { type: "EXPLODE_BODY", bodyId: transition.explodeBodyId }
            : { type: "EXPLODE_BODY", bodyId: transition.explodeBodyId, specificEnergyJkg: transition.explodeSpecificEnergyJkg });
          creativeTransition.current.worldRevision = revision;
          current.current = { ...current.current, worldRevision: revision };
          setWorldError("");
        } else {
          creativeTransition.current = null;
          if (transition.experimentId) setActiveExperiment(transition.experimentId);
          setExperimentBusy(false);
          if (transition.resumeRunning && !placementBody) setRunning(true);
        }
      } else if (transition.phase === "explosion" && newEvents.some((event) => event.type === "explosion" && event.bodyIds.includes(transition.explodeBodyId ?? ""))) {
        creativeTransition.current = null;
        setExperimentBusy(false);
        if (transition.resumeRunning && !placementBody) setRunning(true);
      }
    }
    if (snapshot.worldRevision !== undefined && !creativeBootstrapped.current && !creativeTransition.current && !snapshot.error && snapshot.status !== "error") {
      creativeBootstrapped.current = true;
      if (snapshot.collisionMode === "creative" && !placementBody) setRunning(true);
      else requestCollisionMode("creative", true, undefined, undefined, undefined, "bootstrap");
    }
    if (presentationToRestore) applyExperimentPresentation(presentationToRestore, snapshot);
  };
  const editBody = (field: EditableBodyField, value: number, coalesceId?: string): string | null => {
    try {
      createBodyEditCandidate(current.current.bodies, settings, selectedBodyId, field, value);
    } catch {
      return "Este valor não cabe na simulação atual. Tente uma mudança menor; o astro foi preservado.";
    }
    enqueueTypedMutation({ type: "EDIT_BODY", bodyId: selectedBodyId, field, value }, coalesceId);
    setWorldError("");
    return null;
  };
  const mutateSolar = (mutation: WorldMutation) => {
    if (current.current.stellarEvolutionRunning) {
      setWorldError("Pause a evolução solar antes de alterar a idade ou sair do modelo.");
      return;
    }
    setRunning(false);
    const revision = enqueueTypedMutation(mutation);
    current.current = { ...current.current, worldRevision: revision };
    setWorldError("");
  };
  const startOrbitalPlacement = (mutation: OrbitalPlacementMutation) => {
    const snapshot = current.current;
    const revision = snapshot.worldRevision;
    if (snapshot.status !== "paused" || running || revision === undefined || pendingWorldMutations.length > 0 || snapshot.stellarEvolutionRunning
      || worldReplacementRevision.current !== null || historyRestorePending || experimentBusy) return;
    const intent = { mutation, worldRevision: revision, baseTimeSeconds: snapshot.simulationTimeSeconds };
    orbitalPlacementRef.current = intent;
    orbitalPreviewRef.current = null;
    setOrbitalPlacement(intent);
    setOrbitalPreview(null);
    setOrbitalPreviewState("idle");
    setRunning(false);
  };
  const updateOrbitalDraft = (mutation: OrbitalPlacementMutation | null) => {
    if (!mutation) { clearOrbitalPlacement(); return; }
    const active = orbitalPlacementRef.current;
    const snapshot = current.current;
    if (!active || snapshot.status !== "paused" || snapshot.worldRevision !== active.worldRevision
      || snapshot.simulationTimeSeconds !== active.baseTimeSeconds || snapshot.stellarEvolutionRunning) {
      clearOrbitalPlacement();
      return;
    }
    const intent = { ...active, mutation };
    orbitalPlacementRef.current = intent;
    orbitalPreviewRef.current = null;
    setOrbitalPlacement(intent);
    setOrbitalPreview(null);
  };
  const acceptOrbitalPreview = (response: OrbitalMutationPreviewResponse | null) => {
    const intent = orbitalPlacementRef.current;
    const snapshot = current.current;
    if (!response || !intent || response.version !== 1 || response.requestId < 1
      || response.worldRevision !== intent.worldRevision || response.baseTimeSeconds !== intent.baseTimeSeconds
      || response.worldRevision !== snapshot.worldRevision || response.baseTimeSeconds !== snapshot.simulationTimeSeconds
      || snapshot.status !== "paused" || snapshot.stellarEvolutionRunning) {
      orbitalPreviewRef.current = null;
      setOrbitalPreview(null);
      setOrbitalPreviewState("unavailable");
      return;
    }
    if (!response.result) {
      orbitalPreviewRef.current = null;
      setOrbitalPreview(null);
      setOrbitalPreviewState("unavailable");
      return;
    }
    const bound = { response, mutation: intent.mutation };
    orbitalPreviewRef.current = bound;
    setOrbitalPreview(bound);
    setOrbitalPreviewState("idle");
  };
  const confirmOrbitalPlacement = (mutation: OrbitalPlacementMutation, requestId: number) => {
    const intent = orbitalPlacementRef.current;
    const preview = orbitalPreviewRef.current;
    const acceptedMutation = getOrbitalPlacementCommit(intent, preview, current.current, requestId, lastCommittedOrbitalPreviewId.current);
    const mismatch = !acceptedMutation ? "preview-or-request-validation" : JSON.stringify(acceptedMutation) !== JSON.stringify(mutation) ? "mutation-mismatch" : null;
    if (!acceptedMutation || mismatch || pendingWorldMutations.length > 0 || worldReplacementRevision.current !== null) return;
    lastCommittedOrbitalPreviewId.current = requestId;
    clearOrbitalPlacement();
    mutateSolar(acceptedMutation);
  };
  const mutationContext = () => ({ simulationTimeSeconds: current.current.simulationTimeSeconds,
    environmentSeed: current.current.environmentSeed, swarmLedger: current.current.swarmLedger ?? createEmptySwarmLedger() });
  const changeThermalProfile = (bodyId: string, profileId: ThermalProfileId | null) => {
    enqueueTypedMutation({ type: "SET_THERMAL_PROFILE", bodyId, profileId });
    setWorldError("");
  };
  const changeWaterInventory = (mutation: Extract<WorldMutation, { type: "ADOPT_WATER_INVENTORY" | "SET_WATER_INVENTORY" }>, coalesceId?: string) => {
    enqueueTypedMutation(mutation, coalesceId);
    setWorldError("");
  };
  const changeMaterialSize = (mutation: Extract<WorldMutation, { type: "SET_MATERIAL_SIZE" }>, coalesceId?: string): string | null => {
    try {
      applyWorldMutation(current.current.bodies, settings, mutation, mutationContext());
    } catch {
      return "Este tamanho não cabe na composição atual. O último estado aceito foi mantido.";
    }
    enqueueTypedMutation(mutation, coalesceId);
    setWorldError("");
    return null;
  };
  const changeAtmosphere = (mutation: Extract<WorldMutation, { type: "SET_ATMOSPHERE" }>): string | null => {
    try {
      applyWorldMutation(current.current.bodies, settings, mutation, mutationContext());
    } catch {
      return "Não foi possível aplicar esta atmosfera; o estado aceito foi mantido.";
    }
    enqueueTypedMutation(mutation);
    setWorldError("");
    return null;
  };
  const changeSpin = (mutation: Extract<WorldMutation, { type: "SET_BODY_SPIN" }>): string | null => {
    try {
      applyWorldMutation(current.current.bodies, { gravitationalConstant: acceptedGravitationalConstant }, mutation, mutationContext());
    } catch (error) {
      return translateSimulationError(error instanceof Error ? error.message : "Não foi possível alterar a rotação.");
    }
    const revision = enqueueTypedMutation(mutation);
    pendingSpinMutations.current.set(revision, mutation);
    setWorldError("");
    return null;
  };
  const applyImpulse = (bodyId: string, deltaVelocityMs: Vector3): string | null => {
    if (running || current.current.status !== "paused" || current.current.stellarEvolutionRunning === true
      || stellarEvolutionRunning || solarEvolutionCommand !== null) {
      return "Pause a simulação e aguarde a evolução solar ficar ociosa antes de aplicar o impulso.";
    }
    if (pendingWorldMutations.length > 0 || pendingHistoryRestore.current !== null || historyRestorePending
      || worldReplacementRevision.current !== null || creativeTransition.current !== null) {
      return "Aguarde a confirmação das alterações do sistema antes de aplicar o impulso.";
    }
    const acceptedBody = current.current.bodies.find((body) => body.id === bodyId);
    const errorMessage = "O impulso excede os limites de velocidade ou o astro não existe mais; o último estado aceito foi mantido.";
    if (!acceptedBody) return errorMessage;
    const impulseNs: Vector3 = [
      acceptedBody.massKg * deltaVelocityMs[0],
      acceptedBody.massKg * deltaVelocityMs[1],
      acceptedBody.massKg * deltaVelocityMs[2],
    ];
    if (!impulseNs.every(Number.isFinite)) return errorMessage;
    const mutation: WorldMutation = { type: "APPLY_IMPULSE", bodyId, impulseNs };
    try {
      applyWorldMutation(current.current.bodies, { gravitationalConstant: acceptedGravitationalConstant }, mutation, mutationContext());
    } catch {
      return errorMessage;
    }
    enqueueTypedMutation(mutation);
    setWorldError("");
    return null;
  };
  const startLaserAim = (aim: LaserAimConfiguration): string | null => {
    const acceptedBody = current.current.bodies.find((body) => body.id === aim.bodyId);
    if (!acceptedBody || !acceptedBody.materials) return "O laser exige um astro aceito com composição material explícita.";
    if (aim.bodyId !== selectedBodyId) return "Selecione o astro materializado antes de preparar o laser.";
    if (placementBody || pendingWorldMutations.length || issuedWorldRevisionRef.current !== worldRevisionRef.current
      || worldReplacementRevision.current !== null || pendingHistoryRestore.current || historyRestorePending || creativeTransition.current) {
      return "Aguarde a confirmação da alteração atual antes de preparar o laser.";
    }
    setLaserAim(aim);
    setWorldError("");
    return null;
  };
  const fireLaser = (aim: LaserAimConfiguration, bodyLocalDirection: Vector3, acceptedRevision: number): string | null => {
    const currentRevision = current.current.worldRevision ?? worldRevisionRef.current;
    const reject = (message: string) => { setWorldError(message); setLaserAim(null); return message; };
    const worldChangePending = pendingWorldMutations.length > 0 || issuedWorldRevisionRef.current !== worldRevisionRef.current
      || worldReplacementRevision.current !== null || pendingHistoryRestore.current !== null || historyRestorePending
      || experimentBusy || creationPending || Boolean(creativeTransition.current);
    if (!isLaserShotAllowedForRevision(lastLaserShotRevision.current, acceptedRevision, currentRevision, worldChangePending)) {
      if (worldChangePending) return reject("Aguarde a alteração de mundo atual ser aceita antes de disparar o laser.");
      return reject(acceptedRevision !== currentRevision ? "A cena mudou; prepare a mira novamente no estado aceito atual." : "Um disparo por revisão aceita; aguarde a próxima revisão do Worker.");
    }
    const mutation: WorldMutation = { type: "APPLY_LASER", bodyId: aim.bodyId, bodyLocalDirection,
      powerW: aim.powerW, durationAcceptedSeconds: aim.durationAcceptedSeconds, profileId: aim.profileId };
    try {
      applyWorldMutation(current.current.bodies, { gravitationalConstant: acceptedGravitationalConstant }, mutation, mutationContext());
    } catch {
      return reject("O disparo não passou pela validação do estado aceito; nenhum evento foi emitido.");
    }
    lastLaserShotRevision.current = acceptedRevision;
    enqueueTypedMutation(mutation);
    setLaserAim(null);
    setWorldError("");
    return null;
  };
  const setSolarEvolutionClock = (runningEvolution: boolean) => {
    if (runningEvolution) setRunning(false);
    setSolarEvolutionCommand({ id: ++solarEvolutionCommandId.current, running: runningEvolution });
  };
  const cancelBodyPlacement = () => {
    if (!placementBody || placementCommit.current) return;
    duplicatePlacementSourceId.current = null;
    setLaserAim(null);
    setPlacementBody(null);
    setWorldError("");
  };
  const startBodyPlacement = (type: BodyType): string | null => {
    if (current.current.stellarEvolutionRunning) return "Saia da evolução solar antes de criar astros.";
    if (creationPending || experimentBusy) return "Aguarde a ação atual do Worker.";
    if (current.current.bodies.length >= MAX_SIMULATION_BODIES) return `Este sistema já atingiu o limite de ${MAX_SIMULATION_BODIES} astros.`;
    try {
      setLaserAim(null);
      duplicatePlacementSourceId.current = null;
      setRunning(false);
      const preview = createCatalogBody(type, [], null, settings, { positionM: [0, 0, 0], velocityMs: [0, 0, 0] });
      setPlacementBody({ ...preview, id: "__placement-preview__", name: `${preview.name} · prévia`, parentId: undefined });
      setCatalogOpen(false);
      setInspectorOpen(false);
      setWorldError("");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Não foi possível criar este astro aqui. Escolha outra órbita.";
    }
  };
  const startBodyDuplication = () => {
    if (!selectedBody || current.current.stellarEvolutionRunning) return;
    if (creationPending || experimentBusy || placementBody || pendingWorldMutations.length || issuedWorldRevisionRef.current !== worldRevisionRef.current) {
      setWorldError("Aguarde a confirmação do Worker antes de duplicar.");
      return;
    }
    if (current.current.bodies.length >= MAX_SIMULATION_BODIES) {
      setWorldError(`Este sistema já atingiu o limite de ${MAX_SIMULATION_BODIES} astros.`);
      return;
    }
    const source = current.current.bodies.find((body) => body.id === selectedBody.id);
    if (!source) return;
    const preview = { ...source, id: "__duplicate-placement-preview__", name: `${source.name} · cópia`, parentId: source.id };
    delete preview.stellarEvolution;
    setLaserAim(null);
    duplicatePlacementSourceId.current = source.id;
    setRunning(false);
    setPlacementBody(preview);
    setCatalogOpen(false);
    setInspectorOpen(false);
    setWorldError("");
  };
  const createLagrangeComet = (point: LagrangePoint) => {
    if (!rotatingFrameActive || !selectedPrimary) return;
    if (current.current.stellarEvolutionRunning || creationPending || experimentBusy || placementCommit.current
      || pendingWorldMutations.length || issuedWorldRevisionRef.current !== worldRevisionRef.current) {
      setWorldError("Aguarde a confirmação do Worker antes de adicionar outro corpo.");
      return;
    }
    try {
      createCatalogBody("comet", current.current.bodies, null, current.current.settings ?? settings, { positionM: point.positionM, velocityMs: point.velocityMs });
    } catch (error) {
      setWorldError(translateSimulationError(error instanceof Error ? error.message : "Não foi possível criar um cometa nesse ponto."));
      return;
    }
    setRunning(false);
    setCreationPending(true);
    setWorldError("");
    const acceptedBodyIds = new Set(current.current.bodies.map((body) => body.id));
    const revision = enqueueTypedMutation({ type: "CREATE_BODY", bodyType: "comet", primaryId: null, positionM: point.positionM, velocityMs: point.velocityMs });
    placementCommit.current = { revision, resumeRunning: false };
    createdBodyCommit.current = { revision, acceptedBodyIds };
  };
  const placeBody = (positionM: CelestialBody["positionM"], velocityMs: CelestialBody["velocityMs"]) => {
    if (!placementBody || creationPending || placementCommit.current) return;
    const duplicateSourceId = duplicatePlacementSourceId.current;
    if (duplicateSourceId) {
      const source = current.current.bodies.find((body) => body.id === duplicateSourceId);
      if (!source) {
        duplicatePlacementSourceId.current = null;
        setPlacementBody(null);
        setWorldError("O astro de origem não está mais disponível. Nenhuma cópia foi criada.");
        return;
      }
      const launch = velocityMs.some((component) => component !== 0);
      const candidate = {
        ...source,
        id: "__duplicate-validation__",
        name: `${source.name} · cópia`,
        parentId: undefined,
        positionM,
        velocityMs: launch ? velocityMs : source.velocityMs,
      };
      delete candidate.stellarEvolution;
      try { validateSimulationState([...current.current.bodies, candidate], settings); }
      catch (error) { setWorldError(translateSimulationError(error instanceof Error ? error.message : "Não foi possível posicionar esta cópia.")); return; }
      const acceptedBodyIds = new Set(current.current.bodies.map((body) => body.id));
      placementCommit.current = { revision: issuedWorldRevisionRef.current + 1, resumeRunning: false };
      setCreationPending(true);
      setPlacementBody(null);
      setRunning(false);
      setWorldError("");
      const mutation: WorldMutation = launch
        ? { type: "DUPLICATE_BODY", bodyId: source.id, positionM, velocityMs }
        : { type: "DUPLICATE_BODY", bodyId: source.id, positionM };
      const revision = enqueueTypedMutation(mutation);
      placementCommit.current.revision = revision;
      createdBodyCommit.current = { revision, acceptedBodyIds };
      duplicatePlacementSourceId.current = null;
      return;
    }
    const candidate = { ...placementBody, parentId: undefined, positionM, velocityMs };
    try { validateSimulationState([...current.current.bodies, candidate], settings); }
    catch (error) { setWorldError(translateSimulationError(error instanceof Error ? error.message : "Não foi possível posicionar este astro aqui.")); return; }
    const acceptedBodyIds = new Set(current.current.bodies.map((body) => body.id));
    placementCommit.current = { revision: issuedWorldRevisionRef.current + 1, resumeRunning: false };
    setCreationPending(true);
    setPlacementBody(null);
    setRunning(false);
    setWorldError("");
    const revision = enqueueTypedMutation({ type: "CREATE_BODY", bodyType: getBodyType(placementBody), primaryId: null, positionM, velocityMs });
    placementCommit.current.revision = revision;
    createdBodyCommit.current = { revision, acceptedBodyIds };
  };
  const openBodyCatalog = () => { setRunning(false); setCatalogOpen(true); };
  const openSelectedProperties = () => {
    if (!selectedBody) return;
    if (inspectorOpen) {
      document.getElementById("slider-mass")?.focus();
      return;
    }
    focusMassAfterInspectorOpen.current = true;
    setInspectorOpen(true);
  };
  const removeSelectedBody = () => {
    const nextBodies = removeBodyFromWorld(current.current.bodies, selectedBodyId);
    const revision = enqueueTypedMutation({ type: "REMOVE_BODY", bodyId: selectedBodyId });
    current.current = { ...current.current, bodies: nextBodies, worldRevision: revision };
    setBodies(nextBodies);
    setSelectedBodyId(nextBodies.find((body) => body.id === "sun")?.id ?? nextBodies[0]?.id ?? "");
    setSelectedBodyIds([nextBodies.find((body) => body.id === "sun")?.id ?? nextBodies[0]?.id ?? ""]);
    setWorldError(""); setViewMode("system"); setViewRequest((value) => value + 1);
  };
  const resetSystem = () => {
    setLaserAim(null);
    if (rotatingFrame) handleRotatingFrameChange(false);
    const freshBodies = createSolarSystem();
    const revision = advanceWorldRevision();
    markWorldReplacement(revision, "reset", undefined, DEFAULT_ENVIRONMENT_SEED_V1, {});
    pendingResetReframeRevision.current = revision;
    setPendingWorldMutations([]);
    worldRevisionRef.current = issuedWorldRevisionRef.current = revision;
    setWorldRevision(revision);
    current.current = { bodies: freshBodies, settings: { ...initialSettings }, environmentSeed: DEFAULT_ENVIRONMENT_SEED_V1, simulationTimeSeconds: 0, status: "paused", collisionMode: "scientific", worldRevision: revision };
    setEnvironmentSeed(DEFAULT_ENVIRONMENT_SEED_V1);
    setStellarEvolutionRunning(false); setSolarEvolutionCommand(null); creativeBootstrapped.current = true;
    placementCommit.current = null; duplicatePlacementSourceId.current = null; createdBodyCommit.current = null; setPlacementBody(null); setCreationPending(false);
    creativeTransition.current = null; setExperimentBusy(false); setActiveExperiment(null);
    setBodies(freshBodies); setSettings({ ...initialSettings }); setSelectedBodyId("sun"); setSelectedBodyIds(["sun"]);
    setSpeed(DEFAULT_SIMULATION_SPEED); setSimulationTime(0); setRunning(false); setStatus("paused");
    setWorldError(""); setCatalogOpen(false); setInspectorOpen(false); setShowOrbits(true); setShowTrails(false); setToolbarEpoch((value) => value + 1);
    explosionFocusPending.current = false; restoreExplosionFocus.current = false;
    setViewMode("system"); setViewRequest((value) => value + 1); setResetEpoch((value) => value + 1);
  };
  const changeSettings = (next: PhysicsSettings, coalesceId?: string): string | null => {
    try {
      validateSimulationState(current.current.bodies, next);
    } catch {
      return "Este valor de G excede o limite de aceleração; o valor anterior foi mantido.";
    }
    current.current = { ...current.current, settings: next, worldRevision: enqueueTypedMutation({ type: "SET_SETTINGS", settings: next }, coalesceId) };
    setSettings(next);
    setWorldError("");
    return null;
  };
  const importSimulation = ({ bodies: nextBodies, settings: nextSettings, environmentSeed: nextEnvironmentSeed, session, surfaceData = {}, swarmLedger = createEmptySwarmLedger() }: SimulationSaveData) => {
    validateSimulationState(nextBodies, nextSettings);
    setLaserAim(null);
    const previousPresentation: ExperimentPresentation = { experimentId: activeExperiment, selectedBodyId, speed, viewMode,
      showOrbits, showTrails, inspectorOpen, rotatingFrame };
    if (rotatingFrame) handleRotatingFrameChange(false);
    const revision = advanceWorldRevision();
    markImportedWorld(revision, session, nextEnvironmentSeed, surfaceData, swarmLedger);
    pendingImportPresentation.current = { revision, presentation: previousPresentation };
    worldRevisionRef.current = issuedWorldRevisionRef.current = revision;
    setPendingWorldMutations([]);
    setWorldRevision(revision);
    const nextTime = session?.simulationTimeSeconds ?? 0;
    const nextMode = session?.collisionMode ?? "scientific";
    current.current = { bodies: nextBodies, settings: nextSettings, environmentSeed: nextEnvironmentSeed, swarmLedger, simulationTimeSeconds: nextTime, status: "paused", collisionMode: nextMode, worldRevision: revision };
    setEnvironmentSeed(nextEnvironmentSeed);
    setStellarEvolutionRunning(false); setSolarEvolutionCommand(null); creativeBootstrapped.current = true;
    placementCommit.current = null; duplicatePlacementSourceId.current = null; createdBodyCommit.current = null; setPlacementBody(null); setCreationPending(false); setRunning(false);
    creativeTransition.current = null; setExperimentBusy(false); setActiveExperiment(null);
    setBodies(nextBodies);
    setSettings(nextSettings);
    setCollisionMode(nextMode);
    const nextSelectedId = nextBodies.some((body) => body.id === selectedBodyId) ? selectedBodyId : nextBodies[0]?.id ?? "";
    setSelectedBodyId(nextSelectedId);
    setSelectedBodyIds([nextSelectedId]);
    setSimulationTime(nextTime);
    setWorldError("");
    explosionFocusPending.current = false; restoreExplosionFocus.current = false;
    setResetEpoch((value) => value + 1);
    setViewMode("system"); setViewRequest((value) => value + 1);
  };

  const reframe = (mode: "focus" | "system") => { pendingResetReframeRevision.current = null; setViewMode(mode); setViewRequest((value) => value + 1); };
  const selectBody = (id: string, additive = false) => {
    const next = updateBodySelection(selectedBodyIds, selectedBodyId, id, additive);
    setSelectedBodyIds(next.selectedIds);
    setSelectedBodyId(next.primaryId);
    setInspectorOpen(true);
    if (!next.shouldFocusCamera) return;
    if (laserAim && laserAim.bodyId !== id) setLaserAim(null);
    const alreadyFocused = id === selectedBodyId && viewMode === "focus";
    if (id !== selectedBodyId && rotatingFrame) handleRotatingFrameChange(false);
    if (!alreadyFocused) reframe("focus");
  };
  const runExplosionMutation = (bodyId: string, specificEnergyJkg: number | undefined, resumeRunning: boolean) => {
    setRunning(false);
    explosionFocusPending.current = true;
    const revision = enqueueTypedMutation(specificEnergyJkg === undefined
      ? { type: "EXPLODE_BODY", bodyId }
      : { type: "EXPLODE_BODY", bodyId, specificEnergyJkg });
    creativeTransition.current = { phase: "explosion", worldRevision: revision, mode: "creative", resumeRunning, explodeBodyId: bodyId, ...(specificEnergyJkg === undefined ? {} : { explodeSpecificEnergyJkg: specificEnergyJkg }) };
    current.current = { ...current.current, worldRevision: revision };
    setWorldError("");
  };
  const runExperiment = (id: ExperimentId, origin: WorldSetOrigin = "experiment") => {
    try {
      const preset = createExperimentPreset(id);
      validateSimulationState(preset.bodies, preset.settings);
      setLaserAim(null);
      if (rotatingFrame) handleRotatingFrameChange(false);
      const revision = advanceWorldRevision();
      const mode = origin === "experiment" ? preset.collisionMode : "scientific";
      markWorldReplacement(revision, origin, origin === "experiment" ? mode : undefined, preset.environmentSeed, {});
      worldRevisionRef.current = revision;
      creativeBootstrapped.current = true;
      creativeTransition.current = {
        phase: "world", worldRevision: revision, mode, resumeRunning: true, experimentId: id,
        ...(origin === "experiment" ? { historyExperiment: {
          previous: { experimentId: activeExperiment, selectedBodyId, speed, viewMode, showOrbits, showTrails, inspectorOpen, rotatingFrame },
          next: { experimentId: id, selectedBodyId: preset.selectedBodyId, speed: preset.speed, viewMode: preset.viewMode, showOrbits: preset.showOrbits ?? false, showTrails: preset.showTrails ?? false, inspectorOpen: preset.openInspector ?? false, rotatingFrame: false },
          previousCheckpointId: current.current.history?.undoCheckpointId ?? history.undoCheckpointId,
        } } : {}),
      };
      setExperimentBusy(true); setActiveExperiment(null); setRunning(false);
      setPendingWorldMutations([]); setBodies(preset.bodies); setSettings(preset.settings); setSelectedBodyId(preset.selectedBodyId); setSelectedBodyIds([preset.selectedBodyId]);
      setSpeed(preset.speed); setSimulationTime(0); setStatus("paused"); setWorldError("");
      explosionFocusPending.current = false; restoreExplosionFocus.current = false;
      current.current = { bodies: preset.bodies, settings: preset.settings, environmentSeed: preset.environmentSeed, simulationTimeSeconds: 0, status: "paused", collisionMode: "scientific", worldRevision: revision };
      setEnvironmentSeed(preset.environmentSeed);
      setWorldRevision(revision); setCatalogOpen(false); setInspectorOpen(preset.openInspector ?? false); setShowOrbits(preset.showOrbits ?? false); setShowTrails(preset.showTrails ?? false);
      setResetEpoch((value) => value + 1);
      setViewMode(preset.viewMode); setViewRequest((value) => value + 1);
    } catch (error) {
      setExperimentBusy(false); setWorldError(error instanceof Error ? error.message : "Não foi possível carregar este experimento.");
    }
  };
  const disintegrateSelected = () => {
    if (!selectedBody || compactRemnantTypes.has(getBodyType(selectedBody))) return;
    const specificEnergyJkg = getBodyType(selectedBody) === "star" ? undefined : Math.min(MAX_EXPLOSION_SPECIFIC_ENERGY_J_PER_KG, Math.max(2e8, 2 * settings.gravitationalConstant * selectedBody.massKg / selectedBody.radiusM));
    const resumeRunning = running;
    setExperimentBusy(true); setRunning(false);
    if (collisionMode !== "creative") requestCollisionMode("creative", resumeRunning, undefined, selectedBody.id, specificEnergyJkg);
    else runExplosionMutation(selectedBody.id, specificEnergyJkg, resumeRunning);
  };
  const resetExperiment = () => { if (activeExperiment) runExperiment(activeExperiment); };
  const explodeSelectedBody = (specificEnergyJkg?: number) => {
    if (!selectedBody) return;
    if (compactRemnantTypes.has(getBodyType(selectedBody))) return;
    if (getBodyType(selectedBody) === "star") specificEnergyJkg = undefined;
    const resumeRunning = running;
    setExperimentBusy(true); setRunning(false);
    if (collisionMode !== "creative") requestCollisionMode("creative", resumeRunning, undefined, selectedBody.id, specificEnergyJkg);
    else runExplosionMutation(selectedBody.id, specificEnergyJkg, resumeRunning);
  };
  const scaleLabel = viewMode === "system" ? "Visibilidade ampliada" : creativeBlackHoleVisual ? "Escala visual criativa" : "Escala física";
  const scaleDescription = viewMode === "system" ? OVERVIEW_SCALE_DESCRIPTION : creativeBlackHoleVisual ? CREATIVE_BH_SCALE_DESCRIPTION : "Corpos e distâncias em escala física.";
  const historyActionsPending = historyRestorePending || pendingWorldMutations.length > 0 || worldReplacementRevision.current !== null || experimentBusy || creationPending || stellarEvolutionRunning || Boolean(solarEvolutionCommand) || Boolean(creativeTransition.current);
  const sceneAudioControls = {
    enabled: sceneAudio.enabled, muted: sceneAudio.muted, volume: sceneAudio.volume, reducedMotion: sceneAudio.reducedMotion, failed: sceneAudio.failed,
    onEnable: () => { void sceneAudio.enableFromGesture(); }, onDisable: sceneAudio.disable,
    onMute: sceneAudio.setMuted, onVolumeChange: sceneAudio.setVolume,
  };

  return (
    <main className="astro-shell" id="inicio" data-accepted-world-revision={worldRevision} data-collision-mode={collisionMode} data-active-experiment={activeExperiment ?? undefined}>
      <section className="workspace" aria-label="Exploração do Sistema Solar">
        <section className="scene-panel" aria-label="Universo em três dimensões">
          <SimulationCanvas bodies={bodies} selectedBodyId={selectedBodyId} onSelectBody={selectBody} surfaceData={acceptedSurfaceData} surfaceHeatData={acceptedSurfaceHeatData} worldReplacementSurfaceData={worldReplacementSurfaceData.current} worldReplacementSwarmLedger={worldReplacementSwarmLedger.current} onSurfaceState={handleSurfaceState} settings={settings} speedMultiplier={speed} worldRevision={worldRevision} worldReplacementRevision={worldReplacementRevision.current} worldReplacementOrigin={worldReplacementOrigin.current} worldReplacementCollisionMode={worldReplacementCollisionMode.current} worldReplacementSession={worldReplacementSession.current} worldReplacementEnvironmentSeed={worldReplacementEnvironmentSeed.current} environmentSeed={environmentSeed} mutations={pendingWorldMutations} running={running} onSnapshot={handleSnapshot} onRevisionOutcome={handleRevisionOutcome} collisionModeCommand={collisionModeCommand} historyRestoreCommand={historyRestoreCommand} onHistoryRestoreError={failHistoryRestore} onCreateLagrangeComet={createLagrangeComet} placementBody={placementBody} onPlaceBody={placeBody} onCancelPlacement={cancelBodyPlacement} laserAim={laserAim} onLaserShot={fireLaser} onCancelLaserAim={() => setLaserAim(null)} solarEvolutionCommand={solarEvolutionCommand} showOrbits={showOrbits} showTrails={showTrails} viewMode={viewMode} viewRequest={viewRequest} eventFocusRequest={eventFocusRequest} rotatingFrame={rotatingFrameActive} onRotatingFrameChange={handleRotatingFrameChange} creativeBlackHoleVisual={creativeBlackHoleVisual} orbitalPlacement={orbitalPlacement} onDraftMutation={updateOrbitalDraft} onOrbitalMutationPreview={acceptOrbitalPreview} onOrbitalPreviewStateChange={setOrbitalPreviewState} />
        </section>
      </section>
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="Astro, início"><span className="brand-mark" aria-hidden="true">✦</span><span className="brand-name">Astro</span></a>
        <div className="system-switcher" aria-label="Sistema ativo"><span className="system-sun" aria-hidden="true" /><h1>Seu universo</h1><span className="system-count">{bodies.length} astros</span></div>
        <button type="button" className="rotating-frame-toggle" aria-label="Referencial da câmera, co-rotação e pontos L1–L5" aria-describedby="rotating-frame-status" aria-pressed={rotatingFrameActive} disabled={!selectedPrimary} title={selectedBody && selectedPrimary ? `Referencial da câmera: ${selectedBody.name} e ${selectedPrimary.name}. Co-rotação e pontos L1–L5 aproximados; não constrói uma órbita.` : "Selecione um astro com primário orbital inferido para co-rotacionar a câmera."} onClick={() => handleRotatingFrameChange(!rotatingFrameActive)}>
          <span className="rotating-frame-icon" aria-hidden="true">↻</span><span className="rotating-frame-label-desktop">Referencial orbital</span><span className="rotating-frame-label-mobile">Câmera L1–L5</span>
        </button>
        <span id="rotating-frame-status" className="visually-hidden" role="status" aria-live="polite">{rotatingFrameStatus}</span>
        <span className="live-state"><i className={running ? "status-dot" : "status-dot is-paused"} />{running ? "O universo está em movimento" : "O tempo está pausado"}</span>
      </header>
      <SimulationExperimentsDock selectedBody={selectedBody} bodies={bodies} selectedBodyIds={selectedBodyIds} gravitationalConstant={acceptedGravitationalConstant} collisionMode={collisionMode} busy={experimentBusy || creationPending || Boolean(placementBody) || !acceptedAutosaveSnapshot || running || status !== "paused" || pendingWorldMutations.length > 0 || stellarEvolutionRunning} scenarioBusy={historyActionsPending || Boolean(collisionModeCommand) || Boolean(placementBody) || !acceptedAutosaveSnapshot || status === "error"} canDuplicate={canDuplicate} canExplode={Boolean(selectedBody && !compactRemnantTypes.has(getBodyType(selectedBody)))} activeExperiment={activeExperiment} onCreate={openBodyCatalog} onDuplicate={startBodyDuplication} onDisintegrate={disintegrateSelected} onEditProperties={openSelectedProperties} onRunExperiment={runExperiment} onResetExperiment={resetExperiment} orbitalPlacement={orbitalPlacement} orbitalPreview={orbitalPreview} orbitalPreviewState={orbitalPreviewState} onStartOrbitalPlacement={startOrbitalPlacement} onDraftOrbitalMutation={updateOrbitalDraft} onCancelOrbitalPlacement={clearOrbitalPlacement} onConfirmOrbitalPlacement={confirmOrbitalPlacement} />
      <div className="scene-tools" aria-label="Visualização">
        <button type="button" aria-label="Ver sistema" title="Ver sistema" onClick={() => reframe("system")} aria-pressed={viewMode === "system"}><span className="scene-tool-icon" aria-hidden="true">◎</span><span className="scene-tool-label-desktop">Ver sistema</span><span className="scene-tool-label-mobile">Sistema</span></button>
        <button type="button" aria-label="Focar astro" title="Focar astro" onClick={() => reframe("focus")} aria-pressed={viewMode === "focus"}><span className="scene-tool-icon" aria-hidden="true">⊙</span><span className="scene-tool-label-desktop">Focar astro</span><span className="scene-tool-label-mobile">Foco</span></button>
        <span className="tool-divider" />
        <button type="button" aria-label="Órbitas estimadas" title="Guia osculante completa estimada; não é o trajeto N-body" onClick={() => setShowOrbits((value) => !value)} aria-pressed={showOrbits}><span className="scene-tool-icon" aria-hidden="true">◌</span><span className="scene-tool-label-desktop">Órbitas</span><span className="scene-tool-label-mobile">Órbitas</span></button>
        <button type="button" aria-label="Rastros percorridos" title="Histórico amostrado de snapshots aceitos" onClick={() => setShowTrails((value) => !value)} aria-pressed={showTrails}><span className="scene-tool-icon" aria-hidden="true">〰</span><span className="scene-tool-label-desktop">Rastros</span><span className="scene-tool-label-mobile">Rastros</span></button>
        <span className="scale-indicator" title={scaleDescription} aria-label={`${scaleLabel}. ${scaleDescription}`}>
          <span className="scale-label-visible"><span className="scale-label-desktop">{scaleLabel}</span><span className="scale-label-mobile">Escala</span></span><span className="visually-hidden"> {scaleDescription}</span>
        </span>
        <button type="button" className={`desktop-inspector-toggle${placementBody ? " is-placement-cancel" : ""}`} aria-label={placementBody ? "Cancelar posicionamento" : inspectorOpen ? "Fechar editor" : `Editar ${selectedBody?.name ?? "universo"}`} title={placementBody ? "Cancelar posicionamento" : inspectorOpen ? "Fechar editor" : `Editar ${selectedBody?.name ?? "universo"}`} aria-expanded={placementBody ? undefined : inspectorOpen} aria-controls={placementBody ? undefined : "object-inspector"} onClick={() => placementBody ? cancelBodyPlacement() : setInspectorOpen((open) => !open)}>{placementBody ? "Cancelar posicionamento" : inspectorOpen ? "Fechar editor" : selectedBody ? "Editar astro" : "Editar universo"}</button>
      </div>
      <button ref={mobileInspectorToggle} type="button" className={`mobile-inspector-toggle${placementBody ? " is-placement-cancel" : inspectorOpen || catalogOpen ? " is-obscured" : ""}`} aria-label={placementBody ? "Cancelar posicionamento" : inspectorOpen ? "Fechar editor" : `Editar ${selectedBody?.name ?? "universo"}`} title={placementBody ? "Cancelar posicionamento" : inspectorOpen ? "Fechar editor" : `Editar ${selectedBody?.name ?? "universo"}`} aria-expanded={placementBody ? undefined : inspectorOpen} aria-controls={placementBody ? undefined : "object-inspector"} onClick={() => { if (placementBody) { cancelBodyPlacement(); return; } mobileInspectorFocus.current = inspectorOpen ? "opener" : "close"; setInspectorOpen((open) => !open); }}>{placementBody ? "Cancelar" : inspectorOpen ? "Fechar editor" : selectedBody ? "Editar astro" : "Editar universo"}</button>
      <a className="mobile-credits" href="/textures/ATTRIBUTION.md" target="_blank" rel="noreferrer">Créditos</a>
      <aside id="object-inspector" className={`object-rail${inspectorOpen ? " is-open" : ""}`} aria-label="Inspeção do sistema">
        <button ref={mobileInspectorClose} type="button" className="mobile-inspector-close" onClick={() => { mobileInspectorFocus.current = "opener"; setInspectorOpen(false); }}>Fechar editor <span aria-hidden="true">×</span></button>
      <BatchScaleControls selectedBodyIds={selectedBodyIds} disabled={pendingWorldMutations.length > 0 || worldReplacementRevision.current !== null || historyRestorePending || selectedBodyIds.length > 16} onApply={(mutation) => { enqueueTypedMutation(mutation); setWorldError(""); return null; }} />
      <VisualBodySeriesPanel series={visualBodySeries} />
      {selectedBody ? <ObjectInspector body={selectedBody} bodies={bodies} pendingMutations={pendingWorldMutations} worldTransitionPending={pendingHistoryRestore.current !== null || historyRestorePending || worldReplacementRevision.current !== null || creativeTransition.current !== null} impulsePauseRequired={running || current.current.status !== "paused" || current.current.stellarEvolutionRunning === true || stellarEvolutionRunning || solarEvolutionCommand !== null} settings={settings} acceptedGravitationalConstant={acceptedGravitationalConstant} simulationTimeSeconds={simulationTime} onSpinChange={changeSpin} acceptedSpin={acceptedAutosaveSnapshot?.bodies.find((candidate) => candidate.id === selectedBody.id)?.spin ?? null} acceptedWorldRevision={acceptedAutosaveSnapshot?.worldRevision ?? null} spinMutationOutcome={spinMutationOutcomes[selectedBody.id] ?? null} spinSnapshotReady={Boolean(acceptedAutosaveSnapshot?.bodies.some((candidate) => candidate.id === selectedBody.id)) && worldReplacementRevision.current === null} spinEditable={!Boolean(acceptedAutosaveSnapshot?.swarmLedger?.bodyMassShares[selectedBody.id]?.length)} onApplyImpulse={applyImpulse} laserAim={laserAim} laserDisabled={pendingWorldMutations.length > 0 || worldReplacementRevision.current !== null || historyRestorePending} onStartLaserAim={startLaserAim} onCancelLaserAim={() => setLaserAim(null)} key={`${resetEpoch}-${selectedBody.id}`} onEdit={editBody} onMaterialSize={changeMaterialSize} onAtmosphereChange={changeAtmosphere} onRemove={removeSelectedBody} onExplode={explodeSelectedBody} canExplode={!compactRemnantTypes.has(getBodyType(selectedBody))} evolutionRunning={stellarEvolutionRunning} evolutionPending={solarEvolutionCommand !== null && solarEvolutionCommand.running !== stellarEvolutionRunning} mutationError={worldError} onSolarMutation={mutateSolar} onWaterMutation={changeWaterInventory} onThermalProfileChange={changeThermalProfile} onSolarRunningChange={setSolarEvolutionClock} onSolarReset={resetSystem} /> : <div className="empty-universe"><h2>Um universo em branco</h2><p>Comece com uma estrela ou invente seu próprio sistema.</p><button type="button" onClick={openBodyCatalog}>Criar primeiro astro</button></div>}
        <p className="scale-note">{scaleLabel}. {scaleDescription}</p>
      </aside>
      <nav className={`planet-navigation${inspectorOpen ? " is-inspector-open" : ""}`} aria-label="Escolha um astro"><p className="visually-hidden">Use Shift+clique ou Ctrl+Espaço para adicionar ou remover astros da seleção sem mudar o foco da câmera.</p><ul className="body-list">{bodies.filter((body) => !isDebrisBody(body)).map((body) => <li key={body.id}><button data-body-id={body.id} aria-label={`Selecionar ${body.name}`} title={body.name} aria-pressed={selectedBodyIds.includes(body.id)} className={`body-select${selectedBodyId === body.id ? " is-selected" : selectedBodyIds.includes(body.id) ? " is-multi-selected" : ""}`} onClick={(event) => selectBody(body.id, event.shiftKey)} onKeyDown={(event) => { if (isBodySelectionKeyboardShortcut(event.key, event.ctrlKey, event.metaKey)) { event.preventDefault(); selectBody(body.id, true); } }} type="button"><span className={`body-swatch swatch-${body.id} ${body.bodyType ? `swatch-type-${getBodyType(body)}` : ""}`} aria-hidden="true" /><span className="body-label"><strong>{shortBodyName(body)}</strong></span></button></li>)}</ul></nav>
      <details className={`scene-help${inspectorOpen ? " is-inspector-open" : ""}`}><summary>Ajuda da cena</summary><div className="scene-help-content"><span>Arraste para explorar</span><span>Role para aproximar</span><span>Clique em um astro para viajar</span><a href="/textures/ATTRIBUTION.md" target="_blank" rel="noreferrer">Créditos das imagens</a></div></details>
      {worldError ? <p className="world-error" role="alert">{worldError}</p> : null}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{latestEvent ? describeSimulationEvent(latestEvent, bodies) : ""}</p>
      {catalogOpen ? <BodyCatalog bodies={bodies} onStartPlacement={startBodyPlacement} onClose={() => setCatalogOpen(false)} /> : null}
      <SimulationToolbar key={toolbarEpoch} status={status} playDisabled={stellarEvolutionRunning || solarEvolutionCommand?.running === true || Boolean(placementBody) || creationPending || historyRestorePending || !creativeBootstrapped.current || Boolean(creativeTransition.current) || worldReplacementRevision.current !== null} simulationTimeSeconds={simulationTime} collisionMode={collisionMode} acceptedCollisionMode={acceptedAutosaveSnapshot?.collisionMode ?? "scientific"} collisionModePending={!acceptedAutosaveSnapshot || Boolean(creativeTransition.current) || worldReplacementRevision.current !== null} onCollisionModeChange={changeCollisionMode} speedMultiplier={speed} bodies={bodies} settings={settings} environmentSeed={environmentSeed} acceptedAutosaveSnapshot={acceptedAutosaveSnapshot} displayedSurfaceData={worldReplacementRevision.current !== null ? worldReplacementSurfaceData.current : acceptedSurfaceData} displayedSwarmLedger={worldReplacementRevision.current !== null ? worldReplacementSwarmLedger.current : current.current.swarmLedger} replacementPending={worldReplacementRevision.current !== null} speedLimited={speedLimited} history={history} historyPending={historyActionsPending} historyRestoring={historyRestorePending} onUndo={() => restoreHistoryCheckpoint("undo")} onRedo={() => restoreHistoryCheckpoint("redo")} latestEvent={latestEvent} latestEventDescription={latestEvent ? describeSimulationEvent(latestEvent, bodies) : ""} latestEventDetails={latestCollisionDetails} onViewEvent={() => { if (latestEvent) requestEventFocus(latestEvent.id); }} onToggle={() => { if (status === "running") sceneAudio.stopVoices(); if (!stellarEvolutionRunning) setRunning((value) => !value); }} onSpeedChange={(value) => setSpeed(Math.min(86_400, value))} onSettingsChange={changeSettings} onReset={resetSystem} onImport={importSimulation} sceneAudio={sceneAudioControls} />
    </main>
  );
}

