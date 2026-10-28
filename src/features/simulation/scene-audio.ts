import { createElement, useCallback, useEffect, useState } from "react";
import type { SimulationEvent, SimulationSnapshot, Vector3 } from "@/simulation/types";
import { findNewAuthoritativeEvents } from "./simulation-events";

export const MAX_SCENE_AUDIO_VOICES = 4;
export const MAX_SCENE_AUDIO_DISTANCE_M = 5e12;
export const DEFAULT_SCENE_AUDIO_VOLUME = 0.35;

export type SceneAudioState = { enabled: boolean; muted: boolean; volume: number; reducedMotion: boolean; failed: boolean };
export type SceneAudioControlProps = SceneAudioState & {
  onEnable: () => void;
  onDisable: () => void;
  onMute: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
};

type SceneAudioVoice = { oscillator: OscillatorNode; envelope: GainNode };
type AudioContextFactory = () => AudioContext;

function createBrowserAudioContext(): AudioContext {
  if (typeof AudioContext === "undefined") throw new Error("Web Audio indisponível.");
  return new AudioContext();
}

function cueFor(event: SimulationEvent): { frequency: number; waveform: OscillatorType; durationSeconds: number } {
  if (event.type === "black-hole-capture") return { frequency: 72, waveform: "triangle", durationSeconds: 0.32 };
  if (event.type === "explosion") return { frequency: 196, waveform: "sawtooth", durationSeconds: 0.24 };
  return { frequency: event.outcome?.kind === "creative-fragmentation" ? 164 : 110, waveform: "sine", durationSeconds: 0.2 };
}

function distanceBetween(a: Vector3, b: Vector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export class SceneAudioController {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private readonly voices = new Set<SceneAudioVoice>();
  private enabled = false;
  private muted = false;
  private volume = DEFAULT_SCENE_AUDIO_VOLUME;
  private reducedMotion = false;
  private failed = false;

  constructor(
    private readonly createContext: AudioContextFactory = createBrowserAudioContext,
    private readonly onStateChange: (state: SceneAudioState) => void = () => {},
  ) {}

  get state(): SceneAudioState {
    return { enabled: this.enabled, muted: this.muted, volume: this.volume, reducedMotion: this.reducedMotion, failed: this.failed };
  }

  get activeVoiceCount(): number { return this.voices.size; }

  async enableFromGesture(): Promise<boolean> {
    if (this.reducedMotion) return false;
    if (!this.context) {
      try {
        this.context = this.createContext();
        this.masterGain = this.context.createGain();
        this.masterGain.gain.setValueAtTime(this.muted ? 0 : this.volume, this.context.currentTime);
        this.masterGain.connect(this.context.destination);
      } catch {
        this.failActivation();
        return false;
      }
    }
    const context = this.context;
    if (!context) {
      this.failActivation();
      return false;
    }
    try {
      await context.resume();
      if (this.context !== context || context.state !== "running") {
        this.failActivation();
        return false;
      }
      this.enabled = true;
      this.failed = false;
      this.notify();
      return true;
    } catch {
      this.failActivation();
      return false;
    }
  }

  disable(): void {
    this.enabled = false;
    this.failed = false;
    this.closeContext();
    this.notify();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopVoices();
    this.applyMasterVolume();
    this.notify();
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyMasterVolume();
    this.notify();
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.reducedMotion === reducedMotion) return;
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.disable();
    else this.notify();
  }

  playAcceptedEvents(events: readonly SimulationEvent[], listenerPosition?: Vector3): void {
    const context = this.context;
    const masterGain = this.masterGain;
    if (!this.enabled || this.muted || this.reducedMotion || !context || !masterGain || context.state !== "running") return;
    for (const event of events) {
      const distance = listenerPosition ? distanceBetween(listenerPosition, event.positionM) : 0;
      if (!Number.isFinite(distance) || distance > MAX_SCENE_AUDIO_DISTANCE_M) continue;
      if (this.voices.size >= MAX_SCENE_AUDIO_VOICES) {
        const oldest = this.voices.values().next().value as SceneAudioVoice | undefined;
        if (oldest) this.stopVoice(oldest);
      }
      let voice: SceneAudioVoice | null = null;
      try {
        const cue = cueFor(event);
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        const now = context.currentTime;
        const attenuation = Math.max(0, 1 - distance / MAX_SCENE_AUDIO_DISTANCE_M);
        oscillator.type = cue.waveform;
        oscillator.frequency.setValueAtTime(cue.frequency, now);
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(0.14 * attenuation, now + 0.015);
        envelope.gain.exponentialRampToValueAtTime(0.001, now + cue.durationSeconds);
        oscillator.connect(envelope);
        envelope.connect(masterGain);
        const newVoice = { oscillator, envelope };
        voice = newVoice;
        this.voices.add(newVoice);
        oscillator.onended = () => this.releaseVoice(newVoice);
        oscillator.start(now);
        oscillator.stop(now + cue.durationSeconds);
      } catch {
        // An unavailable/closed device should not affect the simulation.
        if (voice) this.stopVoice(voice);
      }
    }
  }

  stopVoices(): void {
    for (const voice of [...this.voices]) this.stopVoice(voice);
  }

  reset(): void { this.disable(); }

  dispose(): void {
    this.enabled = false;
    this.closeContext();
  }

  private stopVoice(voice: SceneAudioVoice): void {
    if (!this.voices.delete(voice)) return;
    try { voice.oscillator.stop(); } catch { /* Voice may have ended already. */ }
    try { voice.oscillator.disconnect(); } catch { /* Node may already be disconnected. */ }
    try { voice.envelope.disconnect(); } catch { /* Node may already be disconnected. */ }
  }

  private releaseVoice(voice: SceneAudioVoice): void {
    if (!this.voices.delete(voice)) return;
    try { voice.oscillator.disconnect(); } catch { /* Node may already be disconnected. */ }
    try { voice.envelope.disconnect(); } catch { /* Node may already be disconnected. */ }
  }

  private applyMasterVolume(): void {
    const gain = this.masterGain?.gain;
    if (gain && this.context) gain.setValueAtTime(this.muted ? 0 : this.volume, this.context.currentTime);
  }

  private closeContext(): void {
    this.stopVoices();
    const context = this.context;
    this.context = null;
    this.masterGain = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  private failActivation(): void {
    this.enabled = false;
    this.failed = true;
    this.closeContext();
    this.notify();
  }

  private notify(): void { this.onStateChange(this.state); }
}

export function consumeAcceptedSceneAudioSnapshot(
  controller: SceneAudioController,
  snapshot: SimulationSnapshot,
  currentRevision: number,
  lastSeenId: number,
  listenerPosition?: Vector3,
  allowCues = true,
): SimulationEvent[] {
  const events = findNewAuthoritativeEvents(snapshot, currentRevision, lastSeenId);
  if (allowCues && snapshot.status === "running") controller.playAcceptedEvents(events, listenerPosition);
  else controller.stopVoices();
  return events;
}

export function useSceneAudio() {
  const [state, setState] = useState<SceneAudioState>({ enabled: false, muted: false, volume: DEFAULT_SCENE_AUDIO_VOLUME, reducedMotion: false, failed: false });
  const [controller] = useState(() => new SceneAudioController(undefined, setState));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (event: MediaQueryListEvent | MediaQueryList) => controller.setReducedMotion(event.matches);
    update(preference);
    if (preference.addEventListener) preference.addEventListener("change", update);
    else preference.addListener(update);
    return () => {
      if (preference.removeEventListener) preference.removeEventListener("change", update);
      else preference.removeListener(update);
    };
  }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);
  const enableFromGesture = useCallback(() => controller.enableFromGesture(), [controller]);
  const disable = useCallback(() => controller.disable(), [controller]);
  const setMuted = useCallback((muted: boolean) => controller.setMuted(muted), [controller]);
  const setVolume = useCallback((volume: number) => controller.setVolume(volume), [controller]);
  const stopVoices = useCallback(() => controller.stopVoices(), [controller]);
  const reset = useCallback(() => controller.reset(), [controller]);
  const acceptSnapshot = useCallback((snapshot: SimulationSnapshot, currentRevision: number, lastSeenId: number, listenerPosition?: Vector3, allowCues = true) =>
    consumeAcceptedSceneAudioSnapshot(controller, snapshot, currentRevision, lastSeenId, listenerPosition, allowCues), [controller]);
  return { ...state, enableFromGesture, disable, setMuted, setVolume, stopVoices, reset, acceptSnapshot };
}

export function SceneAudioControl({ enabled, muted, volume, reducedMotion, failed, onEnable, onDisable, onMute, onVolumeChange }: SceneAudioControlProps) {
  return createElement("section", { className: "scene-audio-controls", "aria-label": "Sons ilustrativos da simulação" },
    createElement("button", { type: "button", onClick: enabled ? onDisable : onEnable, disabled: reducedMotion, "aria-pressed": enabled }, enabled ? "Desativar sons" : "Ativar sons cinematográficos"),
    enabled ? createElement("button", { type: "button", onClick: () => onMute(!muted), "aria-pressed": muted }, muted ? "Ativar som" : "Silenciar") : null,
    enabled ? createElement("label", null, "Volume dos sons ilustrativos", createElement("input", { type: "range", min: 0, max: 1, step: 0.05, value: volume, onChange: (event) => onVolumeChange(Number(event.currentTarget.value)), "aria-label": "Volume dos sons ilustrativos" })) : null,
    createElement("p", null, "Pistas cinematográficas ilustrativas; não modelam propagação sonora no vácuo."),
    createElement("span", { role: "status", "aria-live": "polite", "aria-atomic": "true" }, reducedMotion ? "Sons desativados pela preferência de movimento reduzido." : failed ? "Não foi possível ativar o áudio neste navegador ou dispositivo." : enabled ? muted ? "Sons ilustrativos silenciados." : "Sons ilustrativos ativados para eventos aceitos." : "Som desativado. Ative por gesto para ouvir pistas."));
}
