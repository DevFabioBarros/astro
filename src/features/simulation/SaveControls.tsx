import type { CelestialBody, CollisionMode, PhysicsSettings, SurfaceData, SwarmLedger } from "@/simulation/types";
import { useEffect, useRef, useState } from "react";
import { decodeSimulation, encodeSimulation, MAX_SIMULATION_SAVE_BYTES, type SimulationSaveData } from "@/simulation/save-file";
import { createAutosaveThumbnail, loadLocalAutosave, LocalAutosaveDisabledError, setLocalAutosaveEnabled, writeLocalAutosave, type AcceptedAutosaveSnapshot, type LocalAutosaveRecordV1 } from "./local-autosave";

type SaveControlsProps = {
  bodies: readonly CelestialBody[];
  settings: PhysicsSettings;
  environmentSeed: number;
  simulationTimeSeconds: number;
  collisionMode: CollisionMode;
  acceptedSnapshot: (AcceptedAutosaveSnapshot & { surfaceData?: SurfaceData }) | null;
  displayedSurfaceData?: SurfaceData;
  displayedSwarmLedger?: SwarmLedger;
  replacementPending?: boolean;
  onAutosaveAnnouncement: (message: string) => void;
  onImport: (data: SimulationSaveData) => void;
};

type ExportSnapshot = Pick<AcceptedAutosaveSnapshot, "bodies" | "settings" | "simulationTimeSeconds" | "collisionMode" | "environmentSeed"> & { surfaceData?: SurfaceData; swarmLedger?: SwarmLedger };

export function encodeSimulationForExport(acceptedSnapshot: ExportSnapshot | null, displayedWorld: ExportSnapshot): string {
  const snapshot = acceptedSnapshot ?? displayedWorld;
  return encodeSimulation(snapshot.bodies, snapshot.settings, {
    simulationTimeSeconds: snapshot.simulationTimeSeconds,
    collisionMode: snapshot.collisionMode,
  }, snapshot.environmentSeed, snapshot.surfaceData, snapshot.swarmLedger);
}

export function SaveControls({ bodies, settings, environmentSeed, simulationTimeSeconds, collisionMode, acceptedSnapshot, displayedSurfaceData, displayedSwarmLedger, replacementPending = false, onAutosaveAnnouncement, onImport }: SaveControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acceptedSnapshotRef = useRef(acceptedSnapshot);
  const lastEvaluatedSequence = useRef(-1);
  const lastSavedJson = useRef<string | null>(null);
  const lastAttemptedJson = useRef<string | null>(null);
  const lastAttemptAt = useRef(0);
  const writePending = useRef(false);
  const pendingRestoreJson = useRef<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [autosaveEnabled, setAutosaveEnabled] = useState(false);
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [autosaveRecord, setAutosaveRecord] = useState<LocalAutosaveRecordV1 | null>(null);
  const [invalidAutosaveRecord, setInvalidAutosaveRecord] = useState(false);
  const [autosaveLoadFailed, setAutosaveLoadFailed] = useState(false);
  const [protectLoadedRecord, setProtectLoadedRecord] = useState(false);
  const [autosaveFeedback, setAutosaveFeedback] = useState("");
  const announcedFirstSave = useRef(false);

  useEffect(() => { acceptedSnapshotRef.current = acceptedSnapshot; }, [acceptedSnapshot]);

  useEffect(() => {
    let active = true;
    void loadLocalAutosave().then(({ enabled, record, invalidRecord }) => {
      if (!active) return;
      setAutosaveEnabled(enabled);
      setAutosaveRecord(record);
      setInvalidAutosaveRecord(invalidRecord);
      lastSavedJson.current = record?.simulationJson ?? null;
      lastAttemptedJson.current = record?.simulationJson ?? null;
      setProtectLoadedRecord(enabled && (record !== null || invalidRecord));
      const message = invalidRecord ? "O último autosave está inválido e não foi restaurado." : "";
      setAutosaveFeedback(message);
      if (message) onAutosaveAnnouncement(message);
      setAutosaveReady(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setAutosaveLoadFailed(true);
      const message = error instanceof Error ? error.message : "Autosave local indisponível neste navegador.";
      setAutosaveFeedback(message);
      onAutosaveAnnouncement(message);
      setAutosaveReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!autosaveEnabled || !autosaveReady || protectLoadedRecord) return;
    const timer = window.setInterval(() => {
      const snapshot = acceptedSnapshotRef.current;
      if (!snapshot || writePending.current || snapshot.sequence === lastEvaluatedSequence.current) return;
      lastEvaluatedSequence.current = snapshot.sequence;
      const now = Date.now();
      const cadenceMs = snapshot.status === "running" ? 10_000 : 800;
      if (now - lastAttemptAt.current < cadenceMs) return;
      try {
        const simulationJson = encodeSimulation(snapshot.bodies, snapshot.settings, {
          simulationTimeSeconds: snapshot.simulationTimeSeconds,
          collisionMode: snapshot.collisionMode,
        }, snapshot.environmentSeed, snapshot.surfaceData, snapshot.swarmLedger);
        if (simulationJson === lastSavedJson.current) return;
        if (simulationJson === lastAttemptedJson.current && now - lastAttemptAt.current < 10_000) return;
        lastAttemptAt.current = now;
        lastAttemptedJson.current = simulationJson;
        writePending.current = true;
        const record: LocalAutosaveRecordV1 = {
          recordVersion: 1,
          savedAtMs: now,
          simulationJson,
          thumbnailSvg: createAutosaveThumbnail(snapshot.bodies),
        };
        void writeLocalAutosave(record).then(() => {
          lastSavedJson.current = simulationJson;
          setAutosaveRecord(record);
          setInvalidAutosaveRecord(false);
          setAutosaveFeedback(`Autosave salvo às ${new Date(record.savedAtMs).toLocaleTimeString("pt-BR")}.`);
          if (!announcedFirstSave.current) {
            announcedFirstSave.current = true;
            onAutosaveAnnouncement("Autosave local salvo.");
          }
        }).catch((error: unknown) => {
          const disabledElsewhere = !autosaveEnabled || error instanceof LocalAutosaveDisabledError;
          const message = disabledElsewhere
            ? "Autosave desativado em outra aba; o último registro foi mantido."
            : `Falha no autosave; o último salvo${autosaveRecord ? ` de ${new Date(autosaveRecord.savedAtMs).toLocaleTimeString("pt-BR")}` : ""} foi mantido.`;
          if (disabledElsewhere) setAutosaveEnabled(false);
          setAutosaveFeedback(message);
          onAutosaveAnnouncement(message);
        }).finally(() => { writePending.current = false; });
      } catch (error) {
        writePending.current = false;
        lastAttemptAt.current = now;
        const message = error instanceof Error
          ? `Autosave não atualizado; ${autosaveRecord ? "o último registro foi mantido." : error.message}`
          : "Autosave não atualizado; o último registro foi mantido.";
        setAutosaveFeedback(message);
        onAutosaveAnnouncement(message);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [autosaveEnabled, autosaveReady, protectLoadedRecord, autosaveRecord, onAutosaveAnnouncement]);

  useEffect(() => {
    if (!protectLoadedRecord || !pendingRestoreJson.current || !acceptedSnapshot) return;
    try {
      const acceptedJson = encodeSimulation(acceptedSnapshot.bodies, acceptedSnapshot.settings, {
        simulationTimeSeconds: acceptedSnapshot.simulationTimeSeconds,
        collisionMode: acceptedSnapshot.collisionMode,
      }, acceptedSnapshot.environmentSeed, acceptedSnapshot.surfaceData, acceptedSnapshot.swarmLedger);
      if (acceptedJson === pendingRestoreJson.current) {
        pendingRestoreJson.current = null;
        setProtectLoadedRecord(false);
        setInvalidAutosaveRecord(false);
        setAutosaveFeedback("Último autosave restaurado do estado aceito pelo motor.");
        onAutosaveAnnouncement("Último autosave restaurado do estado aceito pelo motor.");
      }
    } catch { /* Keep the previous record protected until an accepted snapshot matches it. */ }
  }, [acceptedSnapshot, protectLoadedRecord, onAutosaveAnnouncement]);

  const download = () => {
    try {
      const snapshot = acceptedSnapshotRef.current;
      const text = encodeSimulationForExport(replacementPending ? null : snapshot, {
        bodies, settings, environmentSeed, simulationTimeSeconds, collisionMode, surfaceData: displayedSurfaceData, swarmLedger: displayedSwarmLedger,
      });
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "astro-simulation.astro";
      link.click();
      URL.revokeObjectURL(url);
      setFeedback("Arquivo da simulação baixado.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Não foi possível exportar a simulação.");
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_SIMULATION_SAVE_BYTES) {
      setFeedback("O arquivo excede o limite de 10 MiB.");
      return;
    }
    try {
      const data = decodeSimulation(await file.text());
      onImport(data);
      setFeedback("Arquivo válido; importação enviada ao motor.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Não foi possível importar o arquivo.");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const toggleAutosave = async (enabled: boolean) => {
    try {
      await setLocalAutosaveEnabled(enabled);
      setAutosaveEnabled(enabled);
      const hasProtectedRecord = autosaveRecord !== null || invalidAutosaveRecord;
      setProtectLoadedRecord(enabled && hasProtectedRecord);
      const message = enabled
        ? invalidAutosaveRecord ? "Autosave anterior inválido; escolha continuar para permitir nova gravação." : autosaveRecord ? "Restaure o último autosave ou escolha continuar neste universo." : "Autosave ativado neste dispositivo."
        : "Autosave desativado; o último registro foi mantido.";
      setAutosaveFeedback(message);
      onAutosaveAnnouncement(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível salvar a preferência de autosave.";
      setAutosaveFeedback(message);
      onAutosaveAnnouncement(message);
    }
  };

  const restoreAutosave = () => {
    if (!autosaveRecord) return;
    try {
      const data = decodeSimulation(autosaveRecord.simulationJson);
      pendingRestoreJson.current = encodeSimulation(data.bodies, data.settings, data.session, data.environmentSeed, data.surfaceData, data.swarmLedger);
      onImport(data);
      setAutosaveFeedback("Restauração enviada; o registro anterior fica protegido até o Worker aceitar o mundo.");
      onAutosaveAnnouncement("Restauração enviada; aguardando aceite do Worker.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível validar o autosave local.";
      setAutosaveFeedback(message);
      onAutosaveAnnouncement(message);
    }
  };

  return (
    <div className="save-controls" aria-label="Importar e exportar simulação">
      <button type="button" onClick={download}>Exportar</button>
      <button type="button" onClick={() => inputRef.current?.click()}>Importar</button>
      <input ref={inputRef} aria-label="Arquivo de simulação" accept=".astro,application/json" className="visually-hidden" onChange={(event) => void importFile(event.currentTarget.files?.[0])} type="file" />
      <span className="save-feedback" role="status" aria-live="polite">{feedback}</span>
      <details className="local-autosave">
        <summary>Autosave local</summary>
        <label><input type="checkbox" checked={autosaveEnabled} disabled={!autosaveReady || autosaveLoadFailed} onChange={(event) => void toggleAutosave(event.currentTarget.checked)} /> Salvar neste dispositivo</label>
        {invalidAutosaveRecord && protectLoadedRecord ? <p>Registro anterior inválido; continuar permite substituí-lo após uma gravação aceita.</p> : null}
        {autosaveRecord ? <div className="local-autosave-record">
          <img src={`data:image/svg+xml,${encodeURIComponent(autosaveRecord.thumbnailSvg)}`} width="128" height="72" alt="Prévia esquemática do último autosave" />
          <span>Último salvo {new Date(autosaveRecord.savedAtMs).toLocaleString("pt-BR")}.</span>
          <button type="button" onClick={restoreAutosave}>Restaurar último autosave</button>
        </div> : null}
        {protectLoadedRecord ? <button type="button" onClick={() => { pendingRestoreJson.current = null; setProtectLoadedRecord(false); setInvalidAutosaveRecord(false); setAutosaveFeedback("Continuando neste universo; autosave antigo fica até a próxima gravação aceita."); onAutosaveAnnouncement("Continuando neste universo."); }}>Continuar neste universo</button> : null}
        <span className="local-autosave-feedback">{autosaveFeedback}</span>
      </details>
    </div>
  );
}
