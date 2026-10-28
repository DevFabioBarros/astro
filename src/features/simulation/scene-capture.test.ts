import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScenePng, createScenePhotoModeController, downloadSceneBlob, downloadScenePng, MAX_CAPTURE_PIXELS, MAX_SCENE_CLIP_BYTES, MAX_SCENE_CLIP_DURATION_MS, startSceneClipRecording } from "./scene-capture";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded scene PNG capture", () => {
  it("renders the current frame and downsamples oversized canvases", async () => {
    const source = { width: 2400, height: 1600 } as HTMLCanvasElement;
    const drawImage = vi.fn();
    const output = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })), toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" }))) } as unknown as HTMLCanvasElement;
    vi.stubGlobal("document", { createElement: vi.fn(() => output) });
    const render = vi.fn();

    const blob = await captureScenePng(source, render);

    expect(render).toHaveBeenCalledOnce();
    expect(output.width * output.height).toBeLessThanOrEqual(MAX_CAPTURE_PIXELS);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, output.width, output.height);
    expect(blob.type).toBe("image/png");
  });

  it("rejects when WebGL cannot provide a PNG blob", async () => {
    const source = { width: 800, height: 600, toBlob: (callback: BlobCallback) => callback(null) } as HTMLCanvasElement;

    await expect(captureScenePng(source, vi.fn())).rejects.toThrow(/PNG/);
  });

  it("downloads a successful capture and revokes its object URL later", async () => {
    const click = vi.fn();
    const setTimeout = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => ({ click, href: "", download: "" })) });
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:scene"), revokeObjectURL: vi.fn() });

    await expect(downloadScenePng(async () => new Blob())).resolves.toBe("PNG da cena salvo.");
    expect(click).toHaveBeenCalledOnce();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it("announces capture failures without attempting a download", async () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });

    await expect(downloadScenePng(async () => { throw new Error("tainted canvas"); }))
      .resolves.toMatch(/possível capturar/);
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe("photo mode lifecycle", () => {
  it("enters, exits, and restores UI on disposal", () => {
    const changes: boolean[] = [];
    const mode = createScenePhotoModeController((active) => changes.push(active));

    mode.enter();
    mode.exit();
    mode.enter();
    mode.dispose();

    expect(changes).toEqual([true, false, true]);
    expect(mode.isActive).toBe(false);
  });

  it("keeps exit and disposal idempotent", () => {
    const changes: boolean[] = [];
    const mode = createScenePhotoModeController((active) => changes.push(active));

    mode.enter();
    mode.dispose();
    mode.exit();

    expect(changes).toEqual([true]);
    expect(mode.isActive).toBe(false);
  });

  it("restores UI after an image capture error", () => {
    const changes: boolean[] = [];
    const mode = createScenePhotoModeController((active) => changes.push(active));

    mode.enter();
    mode.captureFailed();

    expect(changes).toEqual([true, false]);
  });
});

describe("bounded scene clip capture", () => {
  class FakeRecorder {
    static isTypeSupported = vi.fn((type: string) => type === "video/webm;codecs=vp8");
    static latest: FakeRecorder;
    static failStart = false;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: (() => void) | null = null;
    onstop: (() => void) | null = null;
    state = "inactive";
    start = vi.fn((_timeslice: number) => { if (FakeRecorder.failStart) throw new Error("unsupported"); this.state = "recording"; });
    stop = vi.fn(() => {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["clip"], { type: "video/webm" }) });
      this.onstop?.();
    });
    constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions) { FakeRecorder.latest = this; }
  }

  function stubRecorder(supported = true) {
    FakeRecorder.isTypeSupported = vi.fn((type: string) => supported && type === "video/webm;codecs=vp8");
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const createStream = vi.fn(() => stream);
    return { track, stream, createStream };
  }

  afterEach(() => { FakeRecorder.failStart = false; });

  it("records a supported WebM clip for at most five seconds and stops its tracks", async () => {
    vi.useFakeTimers();
    const { track, stream, createStream } = stubRecorder();

    const session = startSceneClipRecording(createStream);
    expect(session).not.toBeNull();
    expect(FakeRecorder.latest.stream).toBe(stream);
    expect(FakeRecorder.latest.options).toMatchObject({ mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: expect.any(Number) });
    expect(FakeRecorder.latest.start).toHaveBeenCalledWith(250);

    await vi.advanceTimersByTimeAsync(MAX_SCENE_CLIP_DURATION_MS);

    const blob = await session!.result;
    expect(blob.type).toBe("video/webm;codecs=vp8");
    expect(blob.size).toBeLessThanOrEqual(MAX_SCENE_CLIP_BYTES);
    expect(FakeRecorder.latest.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("reports unsupported recording so the caller can use the PNG fallback", () => {
    const { createStream } = stubRecorder(false);

    expect(startSceneClipRecording(createStream)).toBeNull();
    expect(startSceneClipRecording()).toBeNull();
    expect(createStream).not.toHaveBeenCalled();
  });

  it("stops the stream when MediaRecorder cannot start", () => {
    const { track, createStream } = stubRecorder();
    FakeRecorder.failStart = true;

    expect(startSceneClipRecording(createStream)).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("discards a partial clip and stops the recorder and tracks on cancel", async () => {
    const { track, createStream } = stubRecorder();
    const session = startSceneClipRecording(createStream)!;

    session.cancel();

    await expect(session.result).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeRecorder.latest.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("discards an oversized recording and stops the recorder and tracks", async () => {
    const { track, createStream } = stubRecorder();
    const session = startSceneClipRecording(createStream)!;
    FakeRecorder.latest.ondataavailable?.({ data: new Blob([new Uint8Array(MAX_SCENE_CLIP_BYTES + 1)]) });

    await expect(session.result).rejects.toThrow(/limite/);
    expect(FakeRecorder.latest.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("discards recorder errors, stops tracks, and clears its duration timer", async () => {
    vi.useFakeTimers();
    const { track, createStream } = stubRecorder();
    const session = startSceneClipRecording(createStream)!;
    FakeRecorder.latest.onerror?.();

    await expect(session.result).rejects.toThrow(/interrompeu/);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("downloads and later revokes a locally recorded blob", async () => {
    const click = vi.fn();
    const setTimeout = vi.fn();
    const link = { click, href: "", download: "" };
    vi.stubGlobal("document", { createElement: vi.fn(() => link) });
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:clip"), revokeObjectURL: vi.fn() });

    expect(downloadSceneBlob(new Blob(["clip"]), "astro-scene.webm", "Clipe da cena salvo.")).toBe("Clipe da cena salvo.");
    expect(click).toHaveBeenCalledOnce();
    expect(link.download).toBe("astro-scene.webm");
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });
});
