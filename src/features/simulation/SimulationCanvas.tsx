"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createCelestialScene, type CelestialSceneState } from "./celestial-scene";
import { resolvePendingWorldMutations, resolveSimulationWorldUpdate } from "./simulation-world-sync";
import { createSimulationClient, type SimulationClient, type SimulationRevisionOutcome } from "@/simulation/simulation-client";
import type { CelestialBody, CollisionMode, LaserAimConfiguration, OrbitalMutationPreviewRequest, OrbitalMutationPreviewResponse, OrbitalPlacementMutation, PendingWorldMutation, PhysicsSettings, SimulationEvent, SimulationSessionState, SimulationSnapshot, SurfaceData, SurfaceHeatData, SurfaceStateMessage, SwarmLedger, TrajectoryPreviewRequest, TrajectoryPreviewResult, TrajectoryPreviewResponse, Vector3, WorldRestoreDirection, WorldSetOrigin } from "@/simulation/types";
import { acceptOrbitSnapshot, type AuthoritativeOrbitSnapshot } from "./orbit-trails";
import { shortBodyName } from "./BodyCatalog";
import type { LagrangePoint } from "./lagrange-points";
import { isTrajectoryPreviewCurrent } from "./trajectory-preview-state";
import { DEFAULT_ENVIRONMENT_SEED_V1 } from "@/simulation/world-seed";
import { focusPlanetNavigationButton } from "./planet-navigation-focus";
import { getSimulationErrorNotice, SimulationErrorNotice, translateSimulationError } from "./simulation-error-notice";
import { SceneCaptureControl, useSceneCapture, useScenePhotoMode, withPhotoModeSceneVisibility } from "./scene-capture";
export { translateSimulationError };

export const CREATIVE_BH_SCALE_DESCRIPTION = "Horizonte visual 8×Rs; disco ilustrativo até 32×Rs.";
export const OVERVIEW_SCALE_DESCRIPTION = "posições, órbitas e colisões usam medidas físicas";
export function acceptSnapshotGravity(acceptedGravityRef: { current: number }, snapshot: Pick<SimulationSnapshot, "settings">): void {
  if (snapshot.settings) acceptedGravityRef.current = snapshot.settings.gravitationalConstant;
}
export function isOrbitalMutationPreviewCurrent(
  response: OrbitalMutationPreviewResponse,
  request: Pick<OrbitalMutationPreviewRequest, "requestId" | "worldRevision" | "baseTimeSeconds">,
  worldRevision: number,
  baseTimeSeconds: number,
): boolean {
  return response.requestId === request.requestId && response.worldRevision === request.worldRevision
    && response.baseTimeSeconds === request.baseTimeSeconds && response.worldRevision === worldRevision
    && response.baseTimeSeconds === baseTimeSeconds;
}
export function forwardSurfaceStateForScene(
  state: SurfaceStateMessage,
  _acceptedSurfaceDataRef: { current: SurfaceData | undefined },
  onSurfaceState: (state: SurfaceStateMessage) => void,
): void {
  // SURFACE_STATE is only a notification; props change the scene's accepted sidecar.
  onSurfaceState(state);
}
type SimulationCanvasProps = {
  bodies: readonly CelestialBody[]; selectedBodyId: string; onSelectBody: (bodyId: string, additive?: boolean) => void;
  surfaceData?: SurfaceData; surfaceHeatData?: SurfaceHeatData; worldReplacementSurfaceData?: SurfaceData; worldReplacementSwarmLedger?: SwarmLedger; onSurfaceState: (state: SurfaceStateMessage) => void;
  settings: PhysicsSettings; speedMultiplier: number; worldRevision: number; worldReplacementRevision?: number | null; worldReplacementOrigin?: WorldSetOrigin; worldReplacementCollisionMode?: CollisionMode; worldReplacementSession?: SimulationSessionState; worldReplacementEnvironmentSeed?: number; environmentSeed?: number; running: boolean;
  onSnapshot: (snapshot: SimulationSnapshot) => void;
  onRevisionOutcome?: (outcome: SimulationRevisionOutcome) => void;
  collisionModeCommand?: { id: number; mode: CollisionMode; revision: number; origin?: "bootstrap" } | null;
  historyRestoreCommand?: { id: number; checkpointId: string; direction: WorldRestoreDirection; revision: number; generation: number } | null;
  onHistoryRestoreError?: (message: string) => void;
  onCreateLagrangeComet?: (point: LagrangePoint) => void;
  placementBody?: CelestialBody | null;
  orbitalPlacement?: { mutation: OrbitalPlacementMutation; worldRevision: number; baseTimeSeconds: number } | null;
  onDraftMutation?: (mutation: OrbitalPlacementMutation | null) => void;
  onOrbitalMutationPreview?: (response: OrbitalMutationPreviewResponse | null) => void;
  onOrbitalPreviewStateChange?: (state: "idle" | "scheduled" | "calculating" | "unavailable") => void;
  onPlaceBody?: (positionM: CelestialBody["positionM"], velocityMs: CelestialBody["velocityMs"]) => void;
  onCancelPlacement?: () => void;
  laserAim?: LaserAimConfiguration | null;
  onLaserShot?: (aim: LaserAimConfiguration, bodyLocalDirection: Vector3, acceptedRevision: number) => string | null;
  onCancelLaserAim?: () => void;
  solarEvolutionCommand?: { id: number; running: boolean } | null;
  mutations?: readonly PendingWorldMutation[];
  showOrbits?: boolean; showTrails?: boolean; viewMode?: "focus" | "system"; viewRequest?: number; eventFocusRequest?: { eventId: number; requestId: number } | null; rotatingFrame: boolean; onRotatingFrameChange: (active: boolean) => void; creativeBlackHoleVisual: boolean;
};
export function SimulationCanvas({ bodies, selectedBodyId, onSelectBody, surfaceData, surfaceHeatData, worldReplacementSurfaceData, worldReplacementSwarmLedger, onSurfaceState, settings, speedMultiplier, worldRevision, worldReplacementRevision = null, worldReplacementOrigin = "reset", worldReplacementCollisionMode, worldReplacementSession, worldReplacementEnvironmentSeed = DEFAULT_ENVIRONMENT_SEED_V1, environmentSeed = DEFAULT_ENVIRONMENT_SEED_V1, running, onSnapshot, onRevisionOutcome, collisionModeCommand, historyRestoreCommand, onHistoryRestoreError, onCreateLagrangeComet, placementBody = null, orbitalPlacement = null, onDraftMutation, onOrbitalMutationPreview, onOrbitalPreviewStateChange, onPlaceBody, onCancelPlacement, laserAim = null, onLaserShot, onCancelLaserAim, solarEvolutionCommand, mutations, showOrbits = true, showTrails = false, viewMode = "focus", viewRequest = 0, eventFocusRequest = null, rotatingFrame, onRotatingFrameChange, creativeBlackHoleVisual }: SimulationCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bodiesRef = useRef(bodies), selectedRef = useRef(selectedBodyId);
  const onSelectRef = useRef(onSelectBody), onSnapshotRef = useRef(onSnapshot);
  const onRevisionOutcomeRef = useRef(onRevisionOutcome);
  const onSurfaceStateRef = useRef(onSurfaceState);
  const surfaceDataRef = useRef(surfaceData);
  surfaceDataRef.current = surfaceData;
  const surfaceHeatDataRef = useRef(surfaceHeatData);
  useEffect(() => { surfaceHeatDataRef.current = surfaceHeatData; }, [surfaceHeatData]);
  const onPlaceBodyRef = useRef(onPlaceBody), onCancelPlacementRef = useRef(onCancelPlacement);
  const onCreateLagrangeCometRef = useRef(onCreateLagrangeComet);
  const placementBodyRef = useRef(placementBody);
  const orbitalPlacementRef = useRef(orbitalPlacement);
  const previousOrbitalPlacementKeyRef = useRef("");
  const onDraftMutationRef = useRef(onDraftMutation), onOrbitalMutationPreviewRef = useRef(onOrbitalMutationPreview);
  const orbitalDraftMutationRef = useRef<OrbitalPlacementMutation | null>(null);
  const orbitalPreviewRef = useRef<OrbitalMutationPreviewResponse | null>(null);
  const orbitalPreviewRequestRef = useRef<Omit<OrbitalMutationPreviewRequest, "type" | "version" | "mutation"> | null>(null);
  const orbitalPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const orbitalPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const orbitalPreviewRequestIdRef = useRef(0);
  const laserAimRef = useRef(laserAim);
  const onLaserShotRef = useRef(onLaserShot), onCancelLaserAimRef = useRef(onCancelLaserAim);
  const settingsRef = useRef(settings), previousSettingsRef = useRef(settings);
  const acceptedGravityRef = useRef(settings.gravitationalConstant);
  const acceptedEnvironmentSeedRef = useRef(DEFAULT_ENVIRONMENT_SEED_V1);
  const collisionModeRef = useRef<CollisionMode>("scientific");
  const previousBodiesRef = useRef(bodies);
  const lastWorkerSnapshotBodiesRef = useRef<readonly CelestialBody[] | null>(null);
  const speedRef = useRef(speedMultiplier), runningRef = useRef(running);
  const clientRef = useRef<SimulationClient | null>(null);
  const solarEvolutionCommandRef = useRef(solarEvolutionCommand);
  const worldRevisionRef = useRef(worldRevision), simulationTimeRef = useRef(0);
  const worldReplacementRevisionRef = useRef(worldReplacementRevision);
  const worldReplacementOriginRef = useRef(worldReplacementOrigin);
  const worldReplacementCollisionModeRef = useRef(worldReplacementCollisionMode);
  const worldReplacementSessionRef = useRef(worldReplacementSession);
  const worldReplacementEnvironmentSeedRef = useRef(worldReplacementEnvironmentSeed);
  const worldReplacementSurfaceDataRef = useRef(worldReplacementSurfaceData);
  const worldReplacementSwarmLedgerRef = useRef(worldReplacementSwarmLedger);
  const acceptedSwarmLedgerRef = useRef<SwarmLedger | undefined>(undefined);
  const collisionModeCommandRef = useRef(collisionModeCommand);
  const historySnapshotRef = useRef<AuthoritativeOrbitSnapshot>({ bodies: [], timeSeconds: 0, revision: worldRevision, generation: 0 });
  const eventsRef = useRef<readonly SimulationEvent[]>([]), eventGenerationRef = useRef(0);
  const presentationEpochRef = useRef<number | null>(null);
  const historyRestoreSentIdRef = useRef(0);
  const trajectoryPreviewRef = useRef<TrajectoryPreviewResult | null>(null);
  const displayedTrajectoryPreviewRef = useRef<Omit<TrajectoryPreviewRequest, "candidate"> | null>(null);
  const trajectoryPreviewStatusRef = useRef<"idle" | "pending" | "unavailable">("idle");
  const trajectoryPreviewRequestIdRef = useRef(0);
  const trajectoryPreviewRequestCallbackRef = useRef<(candidate: CelestialBody) => void>(() => {}); const trajectoryPreviewResponseCallbackRef = useRef<(response: TrajectoryPreviewResponse) => void>(() => {});
  const activeTrajectoryPreviewRef = useRef<{ request: Omit<TrajectoryPreviewRequest, "candidate">; candidate: CelestialBody; stale: boolean } | null>(null);
  const queuedTrajectoryPreviewRef = useRef<CelestialBody | null>(null);
  const lastSentRevisionRef = useRef(0);
  const viewRef = useRef({ showOrbits, showTrails, viewMode, viewRequest, eventFocusRequest, rotatingFrame, simulationRunning: running });
  const onRotatingFrameChangeRef = useRef(onRotatingFrameChange);
  const [error, setError] = useState<string | null>(null); const [simulationError, setSimulationError] = useState<ReturnType<typeof getSimulationErrorNotice>>(null);
  const [modelLoaded, setModelLoaded] = useState(false); const [workerReady, setWorkerReady] = useState(false);
  const [captureFrame, setCaptureFrame] = useSceneCapture();
  const { active: photoMode, activeRef: photoModeRef, toggle: togglePhotoMode, exit: exitPhotoMode } = useScenePhotoMode(Boolean(error || simulationError));
  const cancelTrajectoryPreview = useCallback(() => {
    const active = activeTrajectoryPreviewRef.current;
    if (active) clientRef.current?.cancelTrajectoryPreview(active.request.requestId);
    activeTrajectoryPreviewRef.current = null;
    queuedTrajectoryPreviewRef.current = null;
    trajectoryPreviewRef.current = null;
    displayedTrajectoryPreviewRef.current = null;
    trajectoryPreviewStatusRef.current = "idle";
  }, []);
  const sendTrajectoryPreview = useCallback((candidate: CelestialBody) => {
    const client = clientRef.current;
    if (!client || !placementBodyRef.current) { trajectoryPreviewStatusRef.current = "unavailable"; return; }
    const request = {
      requestId: ++trajectoryPreviewRequestIdRef.current,
      worldRevision: worldRevisionRef.current,
      baseTimeSeconds: simulationTimeRef.current,
      collisionMode: collisionModeRef.current,
    };
    activeTrajectoryPreviewRef.current = { request, candidate, stale: false };
    const sent = client.requestTrajectoryPreview({ ...request, candidate });
    if (!sent) {
      activeTrajectoryPreviewRef.current = null;
      trajectoryPreviewStatusRef.current = "unavailable";
    }
  }, []);
  const requestTrajectoryPreview = useCallback((candidate: CelestialBody) => {
    trajectoryPreviewRef.current = null;
    displayedTrajectoryPreviewRef.current = null;
    trajectoryPreviewStatusRef.current = "pending";
    const active = activeTrajectoryPreviewRef.current;
    if (active) {
      active.stale = true;
      queuedTrajectoryPreviewRef.current = candidate;
    } else sendTrajectoryPreview(candidate);
  }, [sendTrajectoryPreview]);
  const invalidateTrajectoryPreview = useCallback(() => {
    trajectoryPreviewRef.current = null;
    displayedTrajectoryPreviewRef.current = null;
    trajectoryPreviewStatusRef.current = placementBodyRef.current ? "pending" : "idle";
    queuedTrajectoryPreviewRef.current = null;
    if (activeTrajectoryPreviewRef.current) activeTrajectoryPreviewRef.current.stale = true;
  }, []);
  const receiveTrajectoryPreview = useCallback((response: TrajectoryPreviewResponse) => {
    const active = activeTrajectoryPreviewRef.current;
    if (!active || active.request.requestId !== response.requestId) return;
    activeTrajectoryPreviewRef.current = null;
    const queued = queuedTrajectoryPreviewRef.current;
    queuedTrajectoryPreviewRef.current = null;
    if (queued && placementBodyRef.current) {
      sendTrajectoryPreview(queued);
      return;
    }
    if (!placementBodyRef.current || active.stale) {
      trajectoryPreviewRef.current = null;
      trajectoryPreviewStatusRef.current = placementBodyRef.current ? "pending" : "idle";
      return;
    }
    trajectoryPreviewRef.current = response.preview;
    displayedTrajectoryPreviewRef.current = response.preview ? active.request : null;
    trajectoryPreviewStatusRef.current = response.preview ? "idle" : "unavailable";
  }, [sendTrajectoryPreview]);
  const cancelOrbitalMutationPreview = useCallback((notify = true) => {
    if (orbitalPreviewTimerRef.current !== undefined) clearTimeout(orbitalPreviewTimerRef.current);
    if (orbitalPreviewTimeoutRef.current !== undefined) clearTimeout(orbitalPreviewTimeoutRef.current);
    orbitalPreviewTimerRef.current = undefined;
    orbitalPreviewTimeoutRef.current = undefined;
    const active = orbitalPreviewRequestRef.current;
    if (active) clientRef.current?.cancelOrbitalMutationPreview(active.requestId);
    orbitalPreviewRequestRef.current = null;
    orbitalPreviewRef.current = null;
    if (notify) {
      onOrbitalMutationPreviewRef.current?.(null);
      onOrbitalPreviewStateChange?.("idle");
    }
  }, [onOrbitalPreviewStateChange]);
  const handleSceneOrbitalDraft = useCallback((mutation: OrbitalPlacementMutation | null) => {
    orbitalDraftMutationRef.current = mutation;
    onDraftMutationRef.current?.(mutation);
    cancelOrbitalMutationPreview();
    if (!mutation) return;
    onOrbitalPreviewStateChange?.("scheduled");
    const placement = orbitalPlacementRef.current;
    if (!placement || placement.worldRevision !== worldRevisionRef.current || placement.baseTimeSeconds !== simulationTimeRef.current) {
      onOrbitalPreviewStateChange?.("unavailable");
      return;
    }
    const mutationKey = JSON.stringify(mutation);
    orbitalPreviewTimerRef.current = setTimeout(() => {
      orbitalPreviewTimerRef.current = undefined;
      const currentPlacement = orbitalPlacementRef.current;
      if (!clientRef.current || !currentPlacement || currentPlacement.worldRevision !== worldRevisionRef.current
        || currentPlacement.baseTimeSeconds !== simulationTimeRef.current || JSON.stringify(orbitalDraftMutationRef.current) !== mutationKey) {
        onOrbitalPreviewStateChange?.("unavailable");
        return;
      }
      const request = {
        requestId: ++orbitalPreviewRequestIdRef.current,
        worldRevision: currentPlacement.worldRevision,
        baseTimeSeconds: currentPlacement.baseTimeSeconds,
      };
      orbitalPreviewRequestRef.current = request;
      if (!clientRef.current.requestOrbitalMutationPreview({ type: "PREVIEW_ORBITAL_MUTATION", version: 1, ...request, mutation })) {
        orbitalPreviewRequestRef.current = null;
        onOrbitalMutationPreviewRef.current?.(null);
        onOrbitalPreviewStateChange?.("unavailable");
        return;
      }
      onOrbitalPreviewStateChange?.("calculating");
      orbitalPreviewTimeoutRef.current = setTimeout(() => {
        if (orbitalPreviewRequestRef.current?.requestId !== request.requestId) return;
        clientRef.current?.cancelOrbitalMutationPreview(request.requestId);
        orbitalPreviewRequestRef.current = null;
        orbitalPreviewTimeoutRef.current = undefined;
        onOrbitalMutationPreviewRef.current?.(null);
        onOrbitalPreviewStateChange?.("unavailable");
      }, 8000);
    }, 180);
  }, [cancelOrbitalMutationPreview, onOrbitalPreviewStateChange]);
  const receiveOrbitalMutationPreview = useCallback((response: OrbitalMutationPreviewResponse) => {
    const active = orbitalPreviewRequestRef.current, placement = orbitalPlacementRef.current;
    if (!active || active.requestId !== response.requestId) return;
    if (orbitalPreviewTimeoutRef.current !== undefined) clearTimeout(orbitalPreviewTimeoutRef.current);
    orbitalPreviewTimeoutRef.current = undefined;
    orbitalPreviewRequestRef.current = null;
    if (!placement || !isOrbitalMutationPreviewCurrent(response, active, worldRevisionRef.current, simulationTimeRef.current)
      || placement.worldRevision !== response.worldRevision || placement.baseTimeSeconds !== response.baseTimeSeconds) {
      orbitalPreviewRef.current = null;
      onOrbitalMutationPreviewRef.current?.(null);
      onOrbitalPreviewStateChange?.("unavailable");
      return;
    }
    orbitalPreviewRef.current = response;
    onOrbitalMutationPreviewRef.current?.(response);
    onOrbitalPreviewStateChange?.(response.result ? "idle" : "unavailable");
  }, [onOrbitalPreviewStateChange]);
  useEffect(() => {
    worldRevisionRef.current = worldRevision;
    laserAimRef.current = laserAim;
    worldReplacementRevisionRef.current = worldReplacementRevision;
    worldReplacementOriginRef.current = worldReplacementOrigin;
    worldReplacementCollisionModeRef.current = worldReplacementCollisionMode;
    worldReplacementSessionRef.current = worldReplacementSession;
    worldReplacementEnvironmentSeedRef.current = worldReplacementEnvironmentSeed;
    worldReplacementSurfaceDataRef.current = worldReplacementSurfaceData;
    worldReplacementSwarmLedgerRef.current = worldReplacementSwarmLedger;
    const update = resolveSimulationWorldUpdate(bodies, settings, {
      worldRevision, lastSentRevision: lastSentRevisionRef.current,
      previousBodies: previousBodiesRef.current, previousSettings: previousSettingsRef.current,
      workerSnapshotBodies: lastWorkerSnapshotBodiesRef.current,
      mutations, worldReplacementRevision, worldReplacementOrigin, worldReplacementCollisionMode, worldReplacementSession,
      environmentSeed, surfaceData,
      worldReplacementEnvironmentSeed,
      worldReplacementSurfaceData,
      worldReplacementSwarmLedger,
      acceptedSwarmLedger: acceptedSwarmLedgerRef.current,
    });
    const replacementUpdate = update?.type === "SET_WORLD" && worldReplacementRevision === worldRevision ? update : null;
    if (replacementUpdate && clientRef.current) {
      lastSentRevisionRef.current = worldRevision;
      clientRef.current.setWorld(replacementUpdate.bodies, replacementUpdate.settings, worldRevision, replacementUpdate.origin, replacementUpdate.collisionMode, replacementUpdate.session, replacementUpdate.environmentSeed, replacementUpdate.surfaceData, replacementUpdate.swarmLedger);
    }
    if (mutations && clientRef.current) {
      const pending = resolvePendingWorldMutations(mutations, lastSentRevisionRef.current);
      if (pending.some(({ mutation }) => mutation.type === "CREATE_BODY" || mutation.type === "REMOVE_BODY" || mutation.type === "EXPLODE_BODY")) {
        clientRef.current.pause();
        if (pending.some(({ mutation }) => mutation.type === "EXPLODE_BODY")) clientRef.current.setSpeed(speedMultiplier);
      }
      for (const entry of pending) {
        lastSentRevisionRef.current = entry.revision;
        if (entry.mutation.type === "SET_SETTINGS") clientRef.current.setSettings(entry.mutation.settings, entry.revision, entry.coalesceId);
        else clientRef.current.mutateWorld(entry.mutation, entry.revision, entry.coalesceId);
      }
    }
    if (update && !replacementUpdate && clientRef.current) {
      lastSentRevisionRef.current = worldRevision;
      if (update.type === "SET_WORLD") clientRef.current.setWorld(update.bodies, update.settings, worldRevision, update.origin, update.collisionMode, update.session, update.environmentSeed, update.surfaceData, update.swarmLedger);
      else if (update.type === "SET_BODIES") clientRef.current?.setBodies(update.bodies, worldRevision);
      else clientRef.current?.setSettings(update.settings, worldRevision);
    }
    previousBodiesRef.current = bodies;
    previousSettingsRef.current = settings;
  }, [bodies, settings, environmentSeed, surfaceData, worldRevision, worldReplacementRevision, worldReplacementOrigin, worldReplacementCollisionMode, worldReplacementSession, worldReplacementEnvironmentSeed, worldReplacementSurfaceData, worldReplacementSwarmLedger, mutations, speedMultiplier, laserAim]);
  useEffect(() => { collisionModeCommandRef.current = collisionModeCommand; }, [collisionModeCommand]);
  useEffect(() => {
    const orbitalPlacementKey = orbitalPlacement ? `${orbitalPlacement.worldRevision}:${orbitalPlacement.baseTimeSeconds}:${orbitalPlacement.mutation.type}:${orbitalPlacement.mutation.type === "SET_ORBITAL_PAIR" ? orbitalPlacement.mutation.firstBodyId : orbitalPlacement.mutation.primaryId}` : "";
    if (previousOrbitalPlacementKeyRef.current !== orbitalPlacementKey) {
      previousOrbitalPlacementKeyRef.current = orbitalPlacementKey;
      if (orbitalDraftMutationRef.current) handleSceneOrbitalDraft(null);
    }
    orbitalPlacementRef.current = orbitalPlacement;
    onDraftMutationRef.current = onDraftMutation; onOrbitalMutationPreviewRef.current = onOrbitalMutationPreview;
    onSnapshotRef.current = onSnapshot; onRevisionOutcomeRef.current = onRevisionOutcome; onSurfaceStateRef.current = onSurfaceState; settingsRef.current = settings;
    selectedRef.current = selectedBodyId;
    onRotatingFrameChangeRef.current = onRotatingFrameChange;
    onCreateLagrangeCometRef.current = onCreateLagrangeComet;
    onPlaceBodyRef.current = onPlaceBody; onCancelPlacementRef.current = onCancelPlacement; placementBodyRef.current = placementBody;
    laserAimRef.current = laserAim; onLaserShotRef.current = onLaserShot; onCancelLaserAimRef.current = onCancelLaserAim;
    trajectoryPreviewRequestCallbackRef.current = requestTrajectoryPreview;
    trajectoryPreviewResponseCallbackRef.current = receiveTrajectoryPreview;
    speedRef.current = speedMultiplier; runningRef.current = running;
    viewRef.current = { showOrbits, showTrails, viewMode, viewRequest, eventFocusRequest, rotatingFrame, simulationRunning: running };
  }, [onSelectBody, onSnapshot, onRevisionOutcome, onSurfaceState, onRotatingFrameChange, onCreateLagrangeComet, onPlaceBody, onCancelPlacement, placementBody, orbitalPlacement, onDraftMutation, onOrbitalMutationPreview, handleSceneOrbitalDraft, laserAim, onLaserShot, onCancelLaserAim, requestTrajectoryPreview, receiveTrajectoryPreview, running, selectedBodyId, settings, speedMultiplier, showOrbits, showTrails, viewMode, viewRequest, eventFocusRequest, rotatingFrame]);
  useEffect(() => { clientRef.current?.setSpeed(speedMultiplier); }, [speedMultiplier]);
  useEffect(() => { clientRef.current?.setTrailSampling(showTrails); }, [showTrails]);
  useEffect(() => { solarEvolutionCommandRef.current = solarEvolutionCommand; }, [solarEvolutionCommand]);
  useEffect(() => {
    if (solarEvolutionCommandRef.current?.running) return;
    if (running) clientRef.current?.start();
    else clientRef.current?.pause();
  }, [running]);
  useEffect(() => {
    if (solarEvolutionCommand) clientRef.current?.setStellarEvolutionRunning(solarEvolutionCommand.running);
  }, [solarEvolutionCommand]);
  useEffect(() => {
    const client = clientRef.current;
    if (collisionModeCommand && client && collisionModeCommand.revision > lastSentRevisionRef.current) {
      lastSentRevisionRef.current = collisionModeCommand.revision;
      client.setCollisionMode(collisionModeCommand.mode, collisionModeCommand.revision, collisionModeCommand.origin);
    }
  }, [collisionModeCommand]);
  useEffect(() => {
    if (!historyRestoreCommand || historyRestoreCommand.id <= historyRestoreSentIdRef.current || !clientRef.current) return;
    historyRestoreSentIdRef.current = historyRestoreCommand.id;
    lastSentRevisionRef.current = historyRestoreCommand.revision;
    try {
      clientRef.current.restoreCheckpoint(historyRestoreCommand.checkpointId, historyRestoreCommand.direction, historyRestoreCommand.revision, historyRestoreCommand.generation);
    } catch (error) {
      onHistoryRestoreError?.(error instanceof Error ? error.message : "Não foi possível restaurar o histórico.");
    }
  }, [historyRestoreCommand, onHistoryRestoreError]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      return createCelestialScene(host, {
        read: (): CelestialSceneState => withPhotoModeSceneVisibility({
          bodies: bodiesRef.current, selectedBodyId: selectedRef.current,
          placementBody: placementBodyRef.current,
          orbitalPlacement: orbitalPlacementRef.current,
          orbitalPreview: orbitalPreviewRef.current,
          laserAim: laserAimRef.current,
          trajectoryPreview: trajectoryPreviewRef.current,
          trajectoryPreviewStatus: trajectoryPreviewStatusRef.current,
          gravity: acceptedGravityRef.current, simulationTime: simulationTimeRef.current,
          environmentSeed: acceptedEnvironmentSeedRef.current,
          surfaceData: surfaceDataRef.current,
          surfaceHeatData: surfaceHeatDataRef.current,
          revision: worldRevisionRef.current, historySnapshot: historySnapshotRef.current, events: eventsRef.current, eventGeneration: eventGenerationRef.current, collisionMode: collisionModeRef.current, ...viewRef.current,
        }, photoModeRef.current),
        consumeIntegrationSamples: (snapshot) => {
          if (historySnapshotRef.current !== snapshot) return;
          const history = { ...snapshot };
          delete history.integrationSamples;
          historySnapshotRef.current = history;
        },
        onSelect: (id, additive) => onSelectRef.current(id, additive), onRotatingFrameChange: (active) => onRotatingFrameChangeRef.current(active),
        onFocusNavigationFallback: (bodyId) => focusPlanetNavigationButton(host, bodyId),
        onCreateLagrangeComet: (point) => onCreateLagrangeCometRef.current?.(point),
        onPlaceBody: (positionM, velocityMs) => onPlaceBodyRef.current?.(positionM, velocityMs),
        onDraftMutation: handleSceneOrbitalDraft,
        onCancelPlacement: () => onCancelPlacementRef.current?.(),
        onLaserShot: (aim, direction, revision) => onLaserShotRef.current?.(aim, direction, revision) ?? "O disparo do laser não está disponível.",
        onCancelLaserAim: () => onCancelLaserAimRef.current?.(),
        onTrajectoryPreviewRequest: (candidate) => trajectoryPreviewRequestCallbackRef.current(candidate),
        onTrajectoryPreviewInvalidate: invalidateTrajectoryPreview,
        onTrajectoryPreviewCancel: cancelTrajectoryPreview,
        onCaptureReady: setCaptureFrame, onLoaded: () => { setModelLoaded(true); setError(null); },
        onError: setError,
      });
    } catch {
      queueMicrotask(() => setError("WebGL 2 não está disponível neste navegador ou dispositivo."));
    }
  }, [cancelTrajectoryPreview, handleSceneOrbitalDraft, invalidateTrajectoryPreview, photoModeRef, setCaptureFrame]);
  useEffect(() => {
    let client: SimulationClient;
    try {
      client = createSimulationClient(new Worker(new URL("../../simulation/simulation.worker.ts", import.meta.url), { type: "module" }));
    } catch {
      queueMicrotask(() => setSimulationError({ heading: "Simulação interrompida", message: "O navegador não conseguiu iniciar o motor de simulação." }));
      return;
    }
    clientRef.current = client;
    const unsubscribeRevisionOutcome = client.subscribeRevisionOutcome((outcome) => onRevisionOutcomeRef.current?.(outcome));
    const unsubscribeTrajectoryPreview = client.subscribeTrajectoryPreview((response) => trajectoryPreviewResponseCallbackRef.current(response));
    const unsubscribeOrbitalPreview = client.subscribeOrbitalMutationPreview(receiveOrbitalMutationPreview);
    const unsubscribeSurfaceState = client.subscribeSurfaceState((state) => {
      forwardSurfaceStateForScene(state, surfaceDataRef, onSurfaceStateRef.current);
    });
    const unsubscribe = client.subscribe((snapshot) => {
      if (snapshot.worldRevision !== undefined && snapshot.worldRevision < worldRevisionRef.current) return;
      const placement = orbitalPlacementRef.current;
      if (orbitalDraftMutationRef.current && (!placement || placement.worldRevision !== snapshot.worldRevision || placement.baseTimeSeconds !== snapshot.simulationTimeSeconds)) handleSceneOrbitalDraft(null);
      acceptSnapshotGravity(acceptedGravityRef, snapshot);
      acceptedEnvironmentSeedRef.current = snapshot.environmentSeed;
      const presentationEpoch = snapshot.presentationEpoch ?? 0;
      const presentationChanged = presentationEpochRef.current !== null && presentationEpoch !== presentationEpochRef.current;
      presentationEpochRef.current = presentationEpoch;
      if (presentationChanged) {
        eventGenerationRef.current += 1;
        eventsRef.current = [];
        historySnapshotRef.current = {
          bodies: [], timeSeconds: 0, revision: snapshot.worldRevision ?? worldRevisionRef.current,
          generation: historySnapshotRef.current.generation + 1,
        };
      }
      const activePreview = activeTrajectoryPreviewRef.current;
      const displayedPreview = displayedTrajectoryPreviewRef.current;
      const invalidPreview = activePreview && !isTrajectoryPreviewCurrent(activePreview.request, snapshot)
        || displayedPreview && !isTrajectoryPreviewCurrent(displayedPreview, snapshot);
      if (invalidPreview) cancelTrajectoryPreview();
      if (snapshot.worldRevision !== undefined) {
        historySnapshotRef.current = acceptOrbitSnapshot(historySnapshotRef.current, {
          bodies: snapshot.bodies, timeSeconds: snapshot.simulationTimeSeconds, revision: snapshot.worldRevision,
          integrationSamples: snapshot.integrationSamples,
        }, true);
      }
      bodiesRef.current = snapshot.bodies;
      simulationTimeRef.current = snapshot.simulationTimeSeconds;
      if (snapshot.swarmLedger) acceptedSwarmLedgerRef.current = snapshot.swarmLedger;
      if (!presentationChanged) eventsRef.current = snapshot.events ?? [];
      collisionModeRef.current = snapshot.collisionMode;
      lastWorkerSnapshotBodiesRef.current = snapshot.bodies;
      if (snapshot.worldRevision !== undefined) {
        previousBodiesRef.current = snapshot.bodies;
        worldRevisionRef.current = snapshot.worldRevision;
        if (snapshot.settings && snapshot.settings.gravitationalConstant !== settingsRef.current.gravitationalConstant) {
          settingsRef.current = snapshot.settings;
          previousSettingsRef.current = snapshot.settings;
        }
      }
      setSimulationError(getSimulationErrorNotice(snapshot));
      setWorkerReady(true);
      onSnapshotRef.current(snapshot);
    });
    const initialRevision = worldRevisionRef.current;
    const replacingWorld = worldReplacementRevisionRef.current === initialRevision;
    client.setWorld(
      [...bodiesRef.current], settingsRef.current, initialRevision,
      replacingWorld ? worldReplacementOriginRef.current : "initial",
      replacingWorld ? worldReplacementCollisionModeRef.current : undefined,
      replacingWorld ? worldReplacementSessionRef.current : undefined,
      replacingWorld ? worldReplacementEnvironmentSeedRef.current : DEFAULT_ENVIRONMENT_SEED_V1,
      replacingWorld ? worldReplacementSurfaceDataRef.current : surfaceData,
      replacingWorld ? worldReplacementSwarmLedgerRef.current : acceptedSwarmLedgerRef.current,
    );
    lastSentRevisionRef.current = worldRevisionRef.current;
    const pendingMode = collisionModeCommandRef.current;
    if (pendingMode && pendingMode.revision > lastSentRevisionRef.current) {
      lastSentRevisionRef.current = pendingMode.revision;
      client.setCollisionMode(pendingMode.mode, pendingMode.revision, pendingMode.origin);
    }
    client.setSpeed(speedRef.current);
    client.setTrailSampling(viewRef.current.showTrails);
    if (runningRef.current) client.start();
    return () => { cancelTrajectoryPreview(); cancelOrbitalMutationPreview(); clientRef.current = null; unsubscribe(); unsubscribeRevisionOutcome(); unsubscribeTrajectoryPreview(); unsubscribeOrbitalPreview(); unsubscribeSurfaceState(); client.dispose(); };
  }, [cancelOrbitalMutationPreview, cancelTrajectoryPreview, handleSceneOrbitalDraft, receiveOrbitalMutationPreview]);

  return (
    <div className="scene-frame" data-glb-loaded={modelLoaded} data-scale="real" data-photo-mode={photoMode ? "true" : undefined}>
      <div className="scene-view" ref={hostRef} />
      {!error && !simulationError && (!modelLoaded || !workerReady) ? <div className="scene-loading" role="status" aria-atomic="true">Preparando o universo…</div> : null}
      {error ? <div className="scene-error" role="alert"><strong>Visualização indisponível</strong><span>{error}</span></div> : null}
      <SimulationErrorNotice notice={simulationError} />
      {captureFrame ? <details className="scene-capture-menu">
        <summary>{photoMode ? "Modo foto" : "Captura"}</summary>
        <SceneCaptureControl capture={captureFrame} photoMode={photoMode} onPhotoModeToggle={togglePhotoMode} onPhotoModeExit={exitPhotoMode} />
      </details> : null}
      <div className="scene-caption">
        <span title={bodies.find((body) => body.id === selectedBodyId)?.name}><i className="status-dot" /> {bodies.find((body) => body.id === selectedBodyId) ? shortBodyName(bodies.find((body) => body.id === selectedBodyId)!) : "Explore o universo"}</span>
        <span title={viewMode === "system" ? OVERVIEW_SCALE_DESCRIPTION : creativeBlackHoleVisual ? CREATIVE_BH_SCALE_DESCRIPTION : "Corpos e distâncias em escala física."} aria-label={`${viewMode === "system" ? "Visibilidade ampliada" : creativeBlackHoleVisual ? "Escala visual criativa" : "Escala física"}. ${viewMode === "system" ? OVERVIEW_SCALE_DESCRIPTION : creativeBlackHoleVisual ? CREATIVE_BH_SCALE_DESCRIPTION : "Corpos e distâncias em escala física."}`}>
          {viewMode === "system" ? "Visibilidade ampliada" : creativeBlackHoleVisual ? "Escala visual criativa" : "Escala física"}{showTrails ? " · Trajeto percorrido" : ""}{showOrbits ? " · Órbita estimada" : ""}
          <span className="visually-hidden"> {viewMode === "system" ? OVERVIEW_SCALE_DESCRIPTION : creativeBlackHoleVisual ? CREATIVE_BH_SCALE_DESCRIPTION : "Corpos e distâncias em escala física."}</span>
        </span>
      </div>
    </div>
  );
}
