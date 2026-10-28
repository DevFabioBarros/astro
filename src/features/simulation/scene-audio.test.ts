import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolarSystem } from "@/simulation/solar-system";
import type { SimulationEvent, SimulationSnapshot, Vector3 } from "@/simulation/types";
import { consumeAcceptedSceneAudioSnapshot, MAX_SCENE_AUDIO_DISTANCE_M, MAX_SCENE_AUDIO_VOICES, SceneAudioController } from "./scene-audio";

class FakeAudioParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeGain {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeOscillator {
  type: OscillatorType = "sine";
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn((when?: number) => { if (when === undefined) this.onended?.(); });
}

class FakeAudioContext {
  currentTime = 1;
  state: AudioContextState = "running";
  destination = {} as AudioNode;
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createGain() { const gain = new FakeGain(); this.gains.push(gain); return gain as unknown as GainNode; }
  createOscillator() { const oscillator = new FakeOscillator(); this.oscillators.push(oscillator); return oscillator as unknown as OscillatorNode; }
}

const sampleEvent = (id: number, positionM: Vector3 = [0, 0, 0]): SimulationEvent => ({
  id, type: "collision", timeSeconds: id, positionM, radiusM: 2, energyJ: 10, bodyIds: ["earth", "mars"],
});
const sampleSnapshot = (worldRevision: number, events: readonly SimulationEvent[], status: SimulationSnapshot["status"] = "running"): SimulationSnapshot => ({
  bodies: createSolarSystem(), environmentSeed: 1, simulationTimeSeconds: 2, status, worldRevision, collisionMode: "scientific", events,
});

function makeAudio() {
  const context = new FakeAudioContext();
  const factory = vi.fn(() => context as unknown as AudioContext);
  const controller = new SceneAudioController(factory);
  return { context, factory, controller };
}

afterEach(() => vi.restoreAllMocks());

describe("cinematic scene audio", () => {
  it("creates audio only from an explicit gesture and plays only new accepted events", async () => {
    const { context, factory, controller } = makeAudio();
    const event = sampleEvent(7);

    expect(factory).not.toHaveBeenCalled();
    await controller.enableFromGesture();
    expect(factory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.oscillators).toHaveLength(0);

    const stale = consumeAcceptedSceneAudioSnapshot(controller, sampleSnapshot(3, [event]), 4, 6, [0, 0, 0]);
    expect(stale).toEqual([]);
    expect(context.oscillators).toHaveLength(0);
    expect(consumeAcceptedSceneAudioSnapshot(controller, sampleSnapshot(4, [event]), 4, 6, [0, 0, 0])).toEqual([event]);
    expect(context.oscillators).toHaveLength(1);
    expect(consumeAcceptedSceneAudioSnapshot(controller, sampleSnapshot(4, [event]), 4, 7, [0, 0, 0])).toEqual([]);
    expect(context.oscillators).toHaveLength(1);
  });

  it("respects mute, volume, and the selected-body distance cutoff", async () => {
    const { context, controller } = makeAudio();
    await controller.enableFromGesture();
    const listener = [0, 0, 0] as const;
    controller.setMuted(true);
    consumeAcceptedSceneAudioSnapshot(controller, sampleSnapshot(2, [sampleEvent(1)]), 2, -1, listener);
    expect(context.oscillators).toHaveLength(0);

    controller.setMuted(false);
    controller.setVolume(0.35);
    consumeAcceptedSceneAudioSnapshot(controller, sampleSnapshot(2, [sampleEvent(2, [MAX_SCENE_AUDIO_DISTANCE_M + 1, 0, 0])]), 2, 1, listener);
    expect(context.oscillators).toHaveLength(0);
    consumeAcceptedSceneAudioSnapshot(controller, sampleSnapshot(2, [sampleEvent(3, [MAX_SCENE_AUDIO_DISTANCE_M / 2, 0, 0])]), 2, 2, listener);
    expect(context.oscillators).toHaveLength(1);
    expect(context.gains[0]?.gain.value).toBeCloseTo(0.35);
    expect(context.gains[1]?.gain.value).toBeGreaterThan(0);
    expect(context.gains[1]?.gain.value).toBeLessThan(0.15);
  });

  it("caps simultaneous voices and stops the oldest before adding another", async () => {
    const { context, controller } = makeAudio();
    await controller.enableFromGesture();
    const events = Array.from({ length: MAX_SCENE_AUDIO_VOICES + 2 }, (_, index) => sampleEvent(index + 1));

    controller.playAcceptedEvents(events, [0, 0, 0]);

    expect(controller.activeVoiceCount).toBe(MAX_SCENE_AUDIO_VOICES);
    expect(context.oscillators).toHaveLength(MAX_SCENE_AUDIO_VOICES + 2);
    expect(context.oscillators.slice(0, 2).every(({ stop }) => stop.mock.calls.length === 2 && stop.mock.calls[1]?.length === 0)).toBe(true);
  });

  it("stops voices on pause and closes the context on reset and disposal", async () => {
    const { context, controller } = makeAudio();
    await controller.enableFromGesture();
    controller.playAcceptedEvents([sampleEvent(1)], [0, 0, 0]);
    controller.stopVoices();
    expect(controller.activeVoiceCount).toBe(0);
    expect(context.oscillators[0]?.stop).toHaveBeenLastCalledWith();

    await controller.enableFromGesture();
    controller.playAcceptedEvents([sampleEvent(2)], [0, 0, 0]);
    controller.reset();
    expect(controller.state.enabled).toBe(false);
    expect(controller.activeVoiceCount).toBe(0);
    expect(context.close).toHaveBeenCalledOnce();

    await controller.enableFromGesture();
    controller.playAcceptedEvents([sampleEvent(3)], [0, 0, 0]);
    controller.dispose();
    expect(controller.state.enabled).toBe(false);
    expect(controller.activeVoiceCount).toBe(0);
    expect(context.close).toHaveBeenCalledTimes(2);
  });

  it("disables cues for reduced motion without creating an audio context", async () => {
    const { factory, controller } = makeAudio();
    controller.setReducedMotion(true);

    await expect(controller.enableFromGesture()).resolves.toBe(false);
    controller.playAcceptedEvents([sampleEvent(1)], [0, 0, 0]);

    expect(controller.state.reducedMotion).toBe(true);
    expect(controller.activeVoiceCount).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    { description: "context creation throws", createContext: () => { throw new Error("unavailable"); } },
    { description: "resume rejects", createContext: () => {
      const context = new FakeAudioContext();
      context.resume = vi.fn(async () => { throw new Error("denied"); });
      return context as unknown as AudioContext;
    } },
    { description: "resume leaves context suspended", createContext: () => {
      const context = new FakeAudioContext();
      context.state = "suspended";
      context.resume = vi.fn(async () => {});
      return context as unknown as AudioContext;
    } },
  ])("reports failed activation when $description", async ({ createContext }) => {
    const onStateChange = vi.fn();
    const observingController = new SceneAudioController(createContext, onStateChange);

    await expect(observingController.enableFromGesture()).resolves.toBe(false);

    expect(observingController.state.enabled).toBe(false);
    expect(observingController.state.failed).toBe(true);
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, failed: true }));
  });
});
