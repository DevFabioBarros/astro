import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutosaveThumbnail, isLocalAutosaveRecord, loadLocalAutosave, MAX_LOCAL_AUTOSAVE_THUMBNAIL_BYTES, writeLocalAutosave } from "./local-autosave";
import type { CelestialBody } from "@/simulation/types";

const body: CelestialBody = { id: "earth", name: "Terra", kind: "planet", bodyType: "rocky-planet", massKg: 1e20,
  radiusM: 1e6, positionM: [0, 0, 0], velocityMs: [0, 0, 0], surfaceTemperatureK: 288, waterFraction: 0.7 };

afterEach(() => vi.unstubAllGlobals());

describe("local autosave envelope", () => {
  it("builds a small schematic thumbnail for the bounded world", () => {
    const bodies = Array.from({ length: 64 }, (_, index) => ({ ...body, id: `body-${index}`, name: `<script>${index}</script>`, positionM: [index * 1e9, index % 3 * 1e8, 0] as const }));
    const thumbnail = createAutosaveThumbnail(bodies);

    expect(thumbnail.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144"')).toBe(true);
    expect((thumbnail.match(/<circle /g) ?? [])).toHaveLength(64);
    expect(thumbnail).not.toContain("script");
    expect(new TextEncoder().encode(thumbnail).byteLength).toBeLessThanOrEqual(MAX_LOCAL_AUTOSAVE_THUMBNAIL_BYTES);
  });

  it("accepts bounded saves and rejects malformed or oversized records", () => {
    const valid = { recordVersion: 1 as const, savedAtMs: 1, simulationJson: "{}", thumbnailSvg: createAutosaveThumbnail([body]) };

    expect(isLocalAutosaveRecord(valid)).toBe(true);
    expect(isLocalAutosaveRecord({ ...valid, savedAtMs: Number.NaN })).toBe(false);
    expect(isLocalAutosaveRecord({ ...valid, thumbnailSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' })).toBe(false);
    expect(isLocalAutosaveRecord({ ...valid, thumbnailSvg: `<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(MAX_LOCAL_AUTOSAVE_THUMBNAIL_BYTES)}</svg>` })).toBe(false);
  });

  it("preserves the last good record when a write fails with quota exceeded", async () => {
    const records = new Map<string, { key: string; recordVersion?: number; savedAtMs?: number; simulationJson?: string; thumbnailSvg?: string }>();
    let failNextWrite = false;
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        let pendingRequests = 0;
        let completeQueued = false;
        let aborted = false;
        const transactionRecords = new Map(records);
        const transaction = {
          error: null as DOMException | null,
          oncomplete: null as (() => void) | null,
          onabort: null as (() => void) | null,
          onerror: null as (() => void) | null,
          objectStore: () => store,
          abort: () => {
            aborted = true;
            transaction.onabort?.();
          },
        };
        const completeWhenReady = () => {
          if (pendingRequests === 0 && !completeQueued) {
            completeQueued = true;
            queueMicrotask(() => {
              if (aborted) return;
              records.clear();
              for (const [key, value] of transactionRecords) records.set(key, value);
              transaction.oncomplete?.();
            });
          }
        };
        const store = {
          get: (key: string) => {
            const request = { result: undefined as (typeof records extends Map<string, infer V> ? V : never) | undefined,
              onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
            pendingRequests += 1;
            queueMicrotask(() => {
              request.result = transactionRecords.get(key);
              request.onsuccess?.();
              pendingRequests -= 1;
              completeWhenReady();
            });
            return request;
          },
          put: (value: { key: string; recordVersion?: number; savedAtMs?: number; simulationJson?: string; thumbnailSvg?: string }) => {
            const request = { error: null as DOMException | null, onsuccess: null as (() => void) | null,
              onerror: null as (() => void) | null };
            pendingRequests += 1;
            queueMicrotask(() => {
              if (failNextWrite) {
                failNextWrite = false;
                const error = new DOMException("Storage quota exceeded", "QuotaExceededError");
                request.error = error;
                request.onerror?.();
                transaction.error = error;
                transaction.onerror?.();
                aborted = true;
                transaction.onabort?.();
                return;
              }
              transactionRecords.set(value.key, value);
              request.onsuccess?.();
              pendingRequests -= 1;
              completeWhenReady();
            });
            return request;
          },
        };
        return transaction;
      },
      close: vi.fn(),
    };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: database, onsuccess: null as (() => void) | null, onupgradeneeded: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });

    const good = { recordVersion: 1 as const, savedAtMs: 1, simulationJson: "{\"good\":true}", thumbnailSvg: createAutosaveThumbnail([body]) };
    const replacement = { ...good, savedAtMs: 2, simulationJson: "{\"good\":false}" };
    await writeLocalAutosave(good);
    failNextWrite = true;

    await expect(writeLocalAutosave(replacement)).rejects.toMatchObject({ name: "QuotaExceededError" });
    await expect(loadLocalAutosave()).resolves.toMatchObject({ record: good, invalidRecord: false });
  });
});
