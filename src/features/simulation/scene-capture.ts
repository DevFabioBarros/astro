import { createElement, useCallback, useEffect, useRef, useState } from "react";

export const MAX_CAPTURE_PIXELS = 3_000_000;
export const MAX_SCENE_CLIP_DURATION_MS = 5_000;
export const MAX_SCENE_CLIP_BYTES = 16 * 1024 * 1024;

const SCENE_CLIP_TIMESLICE_MS = 250;
const SCENE_CLIP_VIDEO_BITS_PER_SECOND = 4_000_000;
const SCENE_CLIP_MIME_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export type SceneCapture = {
  png: () => Promise<Blob>;
  createStream?: () => MediaStream;
};

export type SceneClipSession = { result: Promise<Blob>; cancel: () => void };

export function createScenePhotoModeController(onChange: (active: boolean) => void) {
  let active = false;
  const exit = () => {
    if (!active) return;
    active = false;
    onChange(false);
  };
  const enter = () => {
    if (active) return;
    active = true;
    onChange(true);
  };
  return { enter, exit, toggle: () => active ? exit() : enter(), captureFailed: exit, dispose: () => { active = false; }, get isActive() { return active; } };
}

export function withPhotoModeSceneVisibility<T extends { showOrbits: boolean; showTrails?: boolean }>(state: T, photoMode: boolean): T {
  return photoMode ? { ...state, showOrbits: false, showTrails: false } : state;
}

export function useScenePhotoMode(shouldExit = false) {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const [controller] = useState(() => createScenePhotoModeController(setActive));
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => () => { activeRef.current = false; controller.dispose(); }, [controller]);
  useEffect(() => { if (shouldExit) controller.exit(); }, [controller, shouldExit]);
  return { active, activeRef, toggle: controller.toggle, exit: controller.captureFailed };
}

export function useSceneCapture() {
  const [capture, setCapture] = useState<SceneCapture | null>(null);
  const setCaptureValue = useCallback((next: SceneCapture | null) => setCapture(() => next), []);
  return [capture, setCaptureValue] as const;
}

export function captureScenePng(canvas: HTMLCanvasElement, render: () => void): Promise<Blob> {
  if (!canvas.width || !canvas.height) return Promise.reject(new Error("A cena ainda não possui resolução capturável."));
  render();
  const scale = Math.min(1, Math.sqrt(MAX_CAPTURE_PIXELS / (canvas.width * canvas.height)));
  const width = Math.max(1, Math.floor(canvas.width * scale));
  const height = Math.max(1, Math.floor(canvas.height * scale));
  const target = scale < 1 ? document.createElement("canvas") : canvas;
  if (target !== canvas) {
    target.width = width;
    target.height = height;
    const context = target.getContext("2d");
    if (!context) return Promise.reject(new Error("Não foi possível preparar o PNG."));
    context.drawImage(canvas, 0, 0, width, height);
  }
  return new Promise((resolve, reject) => target.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("O navegador não conseguiu gerar o PNG. Verifique se a cena contém textura de origem externa."));
  }, "image/png"));
}

export function startSceneClipRecording(createStream?: () => MediaStream): SceneClipSession | null {
  if (!createStream || typeof MediaRecorder === "undefined") return null;
  let mimeType: string | undefined;
  try { mimeType = SCENE_CLIP_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)); } catch { return null; }
  if (!mimeType) return null;

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder;
  try {
    stream = createStream();
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: SCENE_CLIP_VIDEO_BITS_PER_SECOND });
  } catch {
    stream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* track already stopped */ } });
    return null;
  }

  let settled = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let size = 0;
  const chunks: Blob[] = [];
  let resolveResult!: (blob: Blob) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<Blob>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const stopTracks = () => stream!.getTracks().forEach((track) => { try { track.stop(); } catch { /* track already stopped */ } });
  const cleanup = () => {
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    stopTimer = undefined;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    stopTracks();
    chunks.length = 0;
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* recorder is already stopping */ } }
    cleanup();
    rejectResult(error);
  };

  recorder.ondataavailable = (event) => {
    if (settled || !event.data.size) return;
    size += event.data.size;
    if (size > MAX_SCENE_CLIP_BYTES) {
      fail(new Error("O clipe excedeu o limite de tamanho."));
      return;
    }
    chunks.push(event.data);
  };
  recorder.onerror = () => fail(new Error("O navegador interrompeu a gravação do clipe."));
  recorder.onstop = () => {
    if (settled) return;
    let blob: Blob | null;
    try { blob = chunks.length ? new Blob(chunks, { type: recorder.mimeType || mimeType }) : null; }
    catch { fail(new Error("O navegador não conseguiu montar o clipe.")); return; }
    settled = true;
    cleanup();
    if (blob) resolveResult(blob);
    else rejectResult(new Error("A gravação não gerou dados."));
  };
  try {
    recorder.start(SCENE_CLIP_TIMESLICE_MS);
    stopTimer = setTimeout(() => {
      if (settled) return;
      try { recorder.stop(); } catch { fail(new Error("O navegador não conseguiu encerrar a gravação.")); }
    }, MAX_SCENE_CLIP_DURATION_MS);
  } catch {
    settled = true;
    if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* recorder did not start */ } }
    cleanup();
    return null;
  }

  return {
    result,
    cancel: () => {
      if (settled) return;
      settled = true;
      if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* recorder is already stopping */ } }
      cleanup();
      rejectResult(Object.assign(new Error("Gravação cancelada."), { name: "AbortError" }));
    },
  };
}

export function downloadSceneBlob(blob: Blob, filename: string, successMessage: string): string {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return successMessage;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function downloadScenePng(capture: () => Promise<Blob>): Promise<string> {
  try {
    return downloadSceneBlob(await capture(), "astro-scene.png", "PNG da cena salvo.");
  } catch {
    return "Não foi possível capturar a cena. Uma textura externa pode bloquear a exportação.";
  }
}

export function SceneCaptureControl({ capture, photoMode = false, onPhotoModeToggle, onPhotoModeExit }: { capture: SceneCapture; photoMode?: boolean; onPhotoModeToggle?: () => void; onPhotoModeExit?: () => void }) {
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [cancelClip, setCancelClip] = useState<() => void>(() => () => {});
  const [activeClip, setActiveClip] = useState<SceneClipSession | null>(null);
  useEffect(() => () => activeClip?.cancel(), [activeClip]);
  const download = useCallback(async () => {
    const message = await downloadScenePng(capture.png);
    setStatus(message);
    if (photoMode && message !== "PNG da cena salvo.") onPhotoModeExit?.();
  }, [capture, onPhotoModeExit, photoMode]);
  const recordClip = useCallback(async () => {
    if (activeClip) return;
    const session = startSceneClipRecording(capture.createStream);
    if (!session) {
      const pngStatus = await downloadScenePng(capture.png);
      setStatus(pngStatus === "PNG da cena salvo." ? "Clipe indisponível; PNG da cena salvo." : pngStatus);
      if (photoMode && pngStatus !== "PNG da cena salvo.") onPhotoModeExit?.();
      return;
    }
    setActiveClip(session);
    setCancelClip(() => session.cancel);
    setRecording(true);
    setStatus("Gravando clipe por até 5 s.");
    try {
      const blob = await session.result;
      setStatus(downloadSceneBlob(blob, "astro-scene.webm", "Clipe da cena salvo."));
    } catch (error) {
      setStatus(error instanceof Error && error.name === "AbortError" ? "Gravação cancelada." : "Não foi possível gravar o clipe. Tente salvar PNG.");
      if (photoMode && !(error instanceof Error && error.name === "AbortError")) onPhotoModeExit?.();
    } finally {
      setActiveClip((current) => current === session ? null : current);
      setRecording(false);
      setCancelClip(() => () => {});
    }
  }, [activeClip, capture, onPhotoModeExit, photoMode]);
  const handleClipButton = useCallback(() => {
    if (recording) cancelClip();
    else void recordClip();
  }, [cancelClip, recordClip, recording]);
  return createElement("div", { className: "scene-capture-control" },
    createElement("div", { className: "scene-capture-actions" },
      createElement("button", { type: "button", onClick: download, disabled: recording }, "Salvar PNG da cena"),
      createElement("button", { type: "button", onClick: handleClipButton }, recording ? "Cancelar clipe" : "Salvar clipe de 5 s"),
      createElement("button", { type: "button", className: "scene-photo-mode-toggle", onClick: onPhotoModeToggle, "aria-pressed": photoMode }, photoMode ? "Sair do modo foto" : "Ativar modo foto")),
    createElement("span", { className: "scene-capture-note" }, "A imagem e o clipe incluem apenas a cena 3D."),
    createElement("span", { className: "scene-capture-status", role: "status", "aria-live": "polite", "aria-atomic": "true" }, status || (photoMode ? "Modo foto ativo. Saia do modo para restaurar os controles da interface." : "")));
}
