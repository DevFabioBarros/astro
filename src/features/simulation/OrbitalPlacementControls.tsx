"use client";

import { useState } from "react";
import type { CelestialBody, MaterialProfileId, OrbitalMutationPreviewResponse, OrbitalPlacementMutation, Vector3 } from "@/simulation/types";

const MATERIAL_CHOICES: readonly { id: MaterialProfileId; label: string }[] = [
  { id: "rock-v1", label: "Rocha" }, { id: "iron-v1", label: "Ferro" },
  { id: "water-ice-v1", label: "Gelo de água (densidade efetiva T12)" }, { id: "gas-v1", label: "Gás" },
];
const PLANES = {
  xy: { label: "XY", normal: [0, 0, 1], radial: [1, 0, 0] },
  xz: { label: "XZ", normal: [0, 1, 0], radial: [1, 0, 0] },
  yz: { label: "YZ", normal: [1, 0, 0], radial: [0, 1, 0] },
} as const satisfies Record<string, { label: string; normal: Vector3; radial: Vector3 }>;
type PlaneId = keyof typeof PLANES;
type BuildKind = "moon" | "binary" | "ring";
export type OrbitalPlacementIntent = { mutation: OrbitalPlacementMutation; worldRevision: number; baseTimeSeconds: number };
export type BoundOrbitalPreview = { response: OrbitalMutationPreviewResponse; mutation: OrbitalPlacementMutation };
type Props = {
  bodies: readonly CelestialBody[];
  selectedBodyIds: readonly string[];
  gravitationalConstant: number;
  disabled?: boolean;
  orbitalPlacement?: OrbitalPlacementIntent | null;
  orbitalPreview?: BoundOrbitalPreview | null;
  orbitalPreviewState?: "idle" | "scheduled" | "calculating" | "unavailable";
  onStartPlacement?: (mutation: OrbitalPlacementMutation) => void;
  onDraftMutation?: (mutation: OrbitalPlacementMutation | null) => void;
  onCancelPlacement?: () => void;
  onConfirmPlacement?: (mutation: OrbitalPlacementMutation, requestId: number) => void;
  onMutate?: (mutation: OrbitalPlacementMutation) => void;
};

function planeFor(normal?: Vector3, radial?: Vector3): PlaneId | "" {
  if (!normal || !radial) return "";
  return (Object.entries(PLANES).find(([, plane]) => plane.normal.every((value, axis) => value === normal[axis])
    && plane.radial.every((value, axis) => value === radial[axis]))?.[0] ?? "") as PlaneId | "";
}
function sameMutation(left: OrbitalPlacementMutation, right: OrbitalPlacementMutation): boolean {
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftFields);
  return keys.length === Object.keys(rightFields).length && keys.every((key) => {
    const leftValue = leftFields[key];
    const rightValue = rightFields[key];
    return Array.isArray(leftValue) && Array.isArray(rightValue)
      ? leftValue.length === rightValue.length && leftValue.every((value, index) => value === rightValue[index])
      : leftValue === rightValue;
  });
}
function candidateVelocity(candidate: { velocityMs: Vector3 }): string {
  const speed = Math.hypot(...candidate.velocityMs);
  return Number.isFinite(speed) ? `${speed.toExponential(3)} m/s` : "indisponível";
}

export function OrbitalPlacementControls({ bodies, selectedBodyIds, disabled = false, orbitalPlacement = null, orbitalPreview = null, orbitalPreviewState = "idle", onStartPlacement, onDraftMutation, onCancelPlacement, onConfirmPlacement }: Props) {
  const [primaryChoice, setPrimaryChoice] = useState(selectedBodyIds[0] ?? "");
  const [secondaryChoice, setSecondaryChoice] = useState(selectedBodyIds.find((id) => id !== primaryChoice) ?? "");
  const [planeId, setPlaneId] = useState<PlaneId>("xy");
  const [profileId, setProfileId] = useState<MaterialProfileId | "">("");
  const [ringMassKg, setRingMassKg] = useState("1000000000000");
  const [innerRadiusM, setInnerRadiusM] = useState("10000000");
  const [outerRadiusM, setOuterRadiusM] = useState("12000000");
  const [count, setCount] = useState("8");
  const [separationM, setSeparationM] = useState("400000000");
  const [buildKind, setBuildKind] = useState<BuildKind>("moon");
  const primary = bodies.find((body) => body.id === primaryChoice);
  const secondary = bodies.find((body) => body.id === secondaryChoice && body.id !== primary?.id);
  const activeMutation = orbitalPlacement?.mutation;
  const activeKind: BuildKind = activeMutation?.type === "CREATE_ORBITAL_BODY" ? "moon"
    : activeMutation?.type === "SET_ORBITAL_PAIR" ? "binary"
      : activeMutation?.type === "CREATE_ORBITAL_RING" ? "ring" : buildKind;
  const activePlaneId = activeMutation ? planeFor(activeMutation.planeNormal, activeMutation.radialDirection) : planeId;
  const plane = PLANES[activePlaneId || planeId];
  const currentSeparation = activeMutation?.type === "CREATE_ORBITAL_BODY" ? activeMutation.semiMajorAxisM : activeMutation?.type === "SET_ORBITAL_PAIR" ? activeMutation.separationM : Number(separationM);
  const currentInnerRadius = activeMutation?.type === "CREATE_ORBITAL_RING" ? activeMutation.innerRadiusM : Number(innerRadiusM);
  const currentOuterRadius = activeMutation?.type === "CREATE_ORBITAL_RING" ? activeMutation.outerRadiusM : Number(outerRadiusM);
  const currentRingMass = activeMutation?.type === "CREATE_ORBITAL_RING" ? activeMutation.totalMassKg : Number(ringMassKg);
  const currentCount = activeMutation?.type === "CREATE_ORBITAL_RING" ? activeMutation.representativeCount : Number(count);
  const moonMutation: OrbitalPlacementMutation = { type: "CREATE_ORBITAL_BODY", bodyType: "moon", primaryId: primary?.id ?? "", semiMajorAxisM: currentSeparation, planeNormal: plane.normal, radialDirection: plane.radial };
  const pairMutation: OrbitalPlacementMutation = { type: "SET_ORBITAL_PAIR", firstBodyId: primary?.id ?? "", secondBodyId: secondary?.id ?? "", separationM: currentSeparation, planeNormal: plane.normal, radialDirection: plane.radial };
  const ringMutation: OrbitalPlacementMutation = { type: "CREATE_ORBITAL_RING", primaryId: primary?.id ?? "", innerRadiusM: currentInnerRadius, outerRadiusM: currentOuterRadius, representativeCount: currentCount, totalMassKg: currentRingMass, profileId: profileId || "rock-v1", planeNormal: plane.normal, radialDirection: plane.radial };
  const formMutation = activeMutation?.type === "CREATE_ORBITAL_BODY" ? { ...activeMutation, primaryId: primaryChoice, semiMajorAxisM: currentSeparation }
    : activeMutation?.type === "SET_ORBITAL_PAIR" ? { ...activeMutation, firstBodyId: primaryChoice, secondBodyId: secondaryChoice, separationM: currentSeparation }
      : activeMutation?.type === "CREATE_ORBITAL_RING" ? { ...activeMutation, primaryId: primaryChoice, innerRadiusM: currentInnerRadius, outerRadiusM: currentOuterRadius, representativeCount: currentCount, totalMassKg: currentRingMass, profileId: profileId || activeMutation.profileId } : null;
  const preview = orbitalPreview?.response;
  const previewMatchesIntent = Boolean(orbitalPlacement && formMutation && orbitalPreview && sameMutation(orbitalPreview.mutation, orbitalPlacement.mutation)
    && sameMutation(formMutation, orbitalPlacement.mutation) && preview?.version === 1 && preview.requestId > 0
    && preview.worldRevision === orbitalPlacement.worldRevision && preview.baseTimeSeconds === orbitalPlacement.baseTimeSeconds);
  const previewCurrent = previewMatchesIntent && preview?.result?.status === "ready";
  const emitDraft = (mutation: OrbitalPlacementMutation | null) => onDraftMutation?.(mutation);
  const updatePrimary = (id: string) => {
    setPrimaryChoice(id);
    if (activeMutation?.type === "CREATE_ORBITAL_BODY") emitDraft({ ...activeMutation, primaryId: id });
    if (activeMutation?.type === "SET_ORBITAL_PAIR") emitDraft({ ...activeMutation, firstBodyId: id });
    if (activeMutation?.type === "CREATE_ORBITAL_RING") emitDraft({ ...activeMutation, primaryId: id });
  };
  const updatePlane = (id: PlaneId) => {
    setPlaneId(id);
    const selectedPlane = PLANES[id];
    if (activeMutation?.type === "CREATE_ORBITAL_BODY" || activeMutation?.type === "SET_ORBITAL_PAIR") emitDraft({ ...activeMutation, planeNormal: selectedPlane.normal, radialDirection: selectedPlane.radial });
    if (activeMutation?.type === "CREATE_ORBITAL_RING") emitDraft({ ...activeMutation, planeNormal: selectedPlane.normal, radialDirection: selectedPlane.radial });
  };
  const updateSeparation = (value: string) => {
    setSeparationM(value);
    const radius = Number(value);
    if (activeMutation?.type === "CREATE_ORBITAL_BODY") emitDraft({ ...activeMutation, semiMajorAxisM: radius });
    if (activeMutation?.type === "SET_ORBITAL_PAIR") emitDraft({ ...activeMutation, separationM: radius });
  };
  const start = (mutation: OrbitalPlacementMutation) => onStartPlacement?.(mutation);
  const cancel = () => { emitDraft(null); onCancelPlacement?.(); };
  const confirm = () => {
    if (!previewCurrent || !orbitalPreview || !preview) return;
    onConfirmPlacement?.(orbitalPreview.mutation, preview.requestId);
  };
  const speedLines = previewCurrent && preview?.result?.status === "ready"
    ? preview.result.candidates.map((candidate) => `${candidate.bodyId}: ${candidateVelocity(candidate)}`).join("; ") : "";

  return <details className="orbital-placement-controls">
    <summary>Construir órbita</summary>
    <p>Modo Livre continua independente. Escolha uma construção e arraste na cena; o Referencial orbital controla a câmera e os pontos L1–L5.</p>
    <fieldset className="orbital-builder-types" disabled={disabled || Boolean(orbitalPlacement)}>
      <legend>O que construir?</legend>
      {([["moon", "Lua"], ["binary", "Par binário"], ["ring", "Anel físico"]] as const).map(([kind, label]) => <label key={kind}>
        <input type="radio" name="orbital-build-kind" value={kind} checked={activeKind === kind} onChange={() => setBuildKind(kind)} />{label}
      </label>)}
    </fieldset>
    <label>Astro primário<select value={primaryChoice} onChange={(event) => updatePrimary(event.currentTarget.value)}>
      <option value="">Escolha um astro</option>{bodies.map((body) => <option key={body.id} value={body.id}>{body.name}</option>)}
    </select></label>
    {activeKind === "binary" ? <label>Segundo astro<select value={secondaryChoice} onChange={(event) => { setSecondaryChoice(event.currentTarget.value); if (activeMutation?.type === "SET_ORBITAL_PAIR") emitDraft({ ...activeMutation, secondBodyId: event.currentTarget.value }); }}>
      <option value="">Escolha um astro</option>{bodies.filter((body) => body.id !== primary?.id).map((body) => <option key={body.id} value={body.id}>{body.name}</option>)}
    </select></label> : null}
    {activeKind !== "ring" ? <>
      {activeKind === "moon" && primary && primary.kind !== "planet" ? <p role="status">Lua precisa de um planeta como astro primário.</p> : null}
      <label>{activeKind === "moon" ? "Distância orbital (m)" : "Separação (m)"}<input type="number" min="1" value={activeMutation?.type === "CREATE_ORBITAL_BODY" || activeMutation?.type === "SET_ORBITAL_PAIR" ? currentSeparation : separationM} onChange={(event) => updateSeparation(event.currentTarget.value)} /></label>
      <label>Plano orbital<select value={activePlaneId} onChange={(event) => updatePlane(event.currentTarget.value as PlaneId)}>
        {activePlaneId === "" ? <option value="" disabled>Personalizado pelo arraste</option> : null}
        {Object.entries(PLANES).map(([id, choice]) => <option key={id} value={id}>{choice.label}</option>)}
      </select></label>
      <button type="button" disabled={disabled || (activeKind === "moon" ? primary?.kind !== "planet" : !primary || !secondary) || !Number.isFinite(activeKind === "moon" ? moonMutation.semiMajorAxisM : pairMutation.separationM)} onClick={() => start(activeKind === "moon" ? moonMutation : pairMutation)}>Arrastar {activeKind === "moon" ? "lua" : "par binário"} na cena</button>
    </> : <>
      <label>Material do anel<select value={profileId || (activeMutation?.type === "CREATE_ORBITAL_RING" ? activeMutation.profileId : "")} onChange={(event) => { const value = event.currentTarget.value as MaterialProfileId | ""; setProfileId(value); if (activeMutation?.type === "CREATE_ORBITAL_RING") { if (value) emitDraft({ ...activeMutation, profileId: value }); else emitDraft(null); } }}>
        <option value="">Escolha um perfil</option>{MATERIAL_CHOICES.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select></label>
      <label>Massa total (kg)<input type="number" min="1" value={activeMutation?.type === "CREATE_ORBITAL_RING" ? currentRingMass : ringMassKg} onChange={(event) => { setRingMassKg(event.currentTarget.value); if (activeMutation?.type === "CREATE_ORBITAL_RING") emitDraft({ ...activeMutation, totalMassKg: Number(event.currentTarget.value) }); }} /></label>
      <p id="ring-placement-hint">Arrasto define o plano e troca o raio externo inicial; o interno é o mínimo.</p>
      <div className="orbital-placement-range"><label>Raio interno mínimo (m)<input aria-describedby="ring-placement-hint" type="number" min="1" value={activeMutation?.type === "CREATE_ORBITAL_RING" ? currentInnerRadius : innerRadiusM} onChange={(event) => { setInnerRadiusM(event.currentTarget.value); if (activeMutation?.type === "CREATE_ORBITAL_RING") emitDraft({ ...activeMutation, innerRadiusM: Number(event.currentTarget.value) }); }} /></label>
        <label>Raio externo inicial (m)<input aria-describedby="ring-placement-hint" type="number" min="1" value={activeMutation?.type === "CREATE_ORBITAL_RING" ? currentOuterRadius : outerRadiusM} onChange={(event) => { setOuterRadiusM(event.currentTarget.value); if (activeMutation?.type === "CREATE_ORBITAL_RING") emitDraft({ ...activeMutation, outerRadiusM: Number(event.currentTarget.value) }); }} /></label></div>
      <label>Partículas físicas (4–32, par)<input type="number" min="4" max="32" step="2" value={activeMutation?.type === "CREATE_ORBITAL_RING" ? currentCount : count} onChange={(event) => { setCount(event.currentTarget.value); if (activeMutation?.type === "CREATE_ORBITAL_RING") emitDraft({ ...activeMutation, representativeCount: Number(event.currentTarget.value) }); }} /></label>
      <label>Plano orbital<select value={activePlaneId} onChange={(event) => updatePlane(event.currentTarget.value as PlaneId)}>{Object.entries(PLANES).map(([id, choice]) => <option key={id} value={id}>{choice.label}</option>)}</select></label>
      <button type="button" disabled={disabled || !primary || !profileId} onClick={() => start(ringMutation)}>Arrastar anel físico na cena</button>
    </>}
    {orbitalPlacement ? <>
      <p role="status" aria-live="polite">{previewCurrent ? `Prévia calculada — nada foi adicionado ainda. ${speedLines}`
        : previewMatchesIntent && preview?.result?.status === "refused" ? preview.result.message
          : orbitalPreviewState === "calculating" ? "Calculando prévia no Worker…"
            : orbitalPreviewState === "scheduled" ? "Posição definida; preparando o cálculo da prévia."
              : orbitalPreviewState === "unavailable" ? "Prévia indisponível. Arraste novamente na cena para tentar."
                : "Arraste na cena para posicionar e calcular a prévia."}</p>
      <p>{previewCurrent ? `Candidatos da prévia: ${preview?.result?.status === "ready" ? preview.result.candidates.map(({ bodyId }) => bodyId).join(", ") || "nenhum" : "nenhum"}.` : ""}</p>
      <button type="button" disabled={disabled || !previewCurrent} onClick={confirm}>Confirmar configuração</button>
      <button type="button" onClick={cancel}>Cancelar posicionamento</button>
    </> : <p role="status">Velocidades e candidatos aparecem após o arraste e o preview do Worker pausado.</p>}
  </details>;
}
