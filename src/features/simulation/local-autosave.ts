import { MAX_SIMULATION_SAVE_BYTES } from "@/simulation/save-file";
import type { CelestialBody, CollisionMode, PhysicsSettings, SimulationSnapshot, SwarmLedger } from "@/simulation/types";

export const MAX_LOCAL_AUTOSAVE_THUMBNAIL_BYTES = 32 * 1024;
const DATABASE_NAME = "astro-local";
const DATABASE_VERSION = 1;
const STORE_NAME = "state";
const PREFERENCE_KEY = "autosave-enabled";
const LAST_GOOD_KEY = "last-good";

export type AcceptedAutosaveSnapshot = {
  bodies: readonly CelestialBody[];
  settings: PhysicsSettings;
  environmentSeed: number;
  simulationTimeSeconds: number;
  collisionMode: CollisionMode;
  status: SimulationSnapshot["status"];
  worldRevision: number;
  sequence: number;
  swarmLedger?: SwarmLedger;
};

export type LocalAutosaveRecordV1 = {
  recordVersion: 1;
  savedAtMs: number;
  simulationJson: string;
  thumbnailSvg: string;
};

export class LocalAutosaveDisabledError extends Error {
  constructor() {
    super("Autosave desativado em outra aba.");
    this.name = "LocalAutosaveDisabledError";
  }
}

type StoredValue = { key: string; enabled?: boolean } & Partial<LocalAutosaveRecordV1>;

export function createAutosaveThumbnail(bodies: readonly CelestialBody[]): string {
  const visibleBodies = bodies.slice(0, 64);
  if (visibleBodies.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144" viewBox="0 0 256 144"><rect width="256" height="144" fill="#050914"/></svg>';
  const xs = visibleBodies.map(({ positionM }) => positionM[0]);
  const ys = visibleBodies.map(({ positionM }) => positionM[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const circles = visibleBodies.map((body) => {
    const x = 14 + (body.positionM[0] - minX) / span * 228;
    const y = 14 + (maxY - body.positionM[1]) / span * 116;
    const radius = body.kind === "star" ? 4 : body.bodyType === "gas-giant" ? 3 : 2;
    const color = body.bodyType === "black-hole" ? "#101624" : body.kind === "star" ? "#ffe1a0" : body.bodyType === "gas-giant" ? "#d69a67" : "#9bbde4";
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${color}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144" viewBox="0 0 256 144"><rect width="256" height="144" fill="#050914"/><g>${circles}</g></svg>`;
}

export function isLocalAutosaveRecord(value: unknown): value is LocalAutosaveRecordV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<LocalAutosaveRecordV1>;
  if (record.recordVersion !== 1 || !Number.isFinite(record.savedAtMs) || (record.savedAtMs as number) < 0
    || typeof record.simulationJson !== "string" || typeof record.thumbnailSvg !== "string") return false;
  if (new TextEncoder().encode(record.simulationJson).byteLength > MAX_SIMULATION_SAVE_BYTES
    || new TextEncoder().encode(record.thumbnailSvg).byteLength > MAX_LOCAL_AUTOSAVE_THUMBNAIL_BYTES) return false;
  return record.thumbnailSvg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')
    && record.thumbnailSvg.endsWith("</svg>")
    && !/<script|<foreignObject|\b(?:href|xlink:href)=|url\(/i.test(record.thumbnailSvg);
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB não está disponível neste navegador."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Não foi possível abrir o autosave local."));
    request.onblocked = () => reject(new Error("O autosave local está ocupado em outra aba."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("A transação do autosave foi cancelada."));
    transaction.onerror = () => reject(transaction.error ?? new Error("A transação do autosave falhou."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Não foi possível ler o autosave local."));
  });
}

export async function loadLocalAutosave(): Promise<{ enabled: boolean; record: LocalAutosaveRecordV1 | null; invalidRecord: boolean }> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const preferencePromise = requestResult<StoredValue | undefined>(store.get(PREFERENCE_KEY));
    const recordPromise = requestResult<StoredValue | undefined>(store.get(LAST_GOOD_KEY));
    let preference: StoredValue | undefined;
    let stored: StoredValue | undefined;
    try {
      [preference, stored] = await Promise.all([preferencePromise, recordPromise]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
    const recordCandidate = stored ? { recordVersion: stored.recordVersion, savedAtMs: stored.savedAtMs,
      simulationJson: stored.simulationJson, thumbnailSvg: stored.thumbnailSvg } : null;
    return { enabled: preference?.enabled === true,
      record: isLocalAutosaveRecord(recordCandidate) ? recordCandidate : null,
      invalidRecord: stored !== undefined && !isLocalAutosaveRecord(recordCandidate) };
  } finally {
    database.close();
  }
}

async function writeStoredValue(value: StoredValue): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionCompletion(transaction);
    try {
      transaction.objectStore(STORE_NAME).put(value);
    } catch (error) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw error;
    }
    await completed;
  } finally {
    database.close();
  }
}

export function setLocalAutosaveEnabled(enabled: boolean): Promise<void> {
  return writeStoredValue({ key: PREFERENCE_KEY, enabled });
}

export async function writeLocalAutosave(record: LocalAutosaveRecordV1): Promise<void> {
  if (!isLocalAutosaveRecord(record)) throw new Error("O autosave excede os limites ou contém uma miniatura inválida.");
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const preference = store.get(PREFERENCE_KEY);
    let failure: Error | null = null;
    preference.onsuccess = () => {
      if (preference.result?.enabled !== true) {
        failure = new LocalAutosaveDisabledError();
        transaction.abort();
        return;
      }
      try {
        store.put({ key: LAST_GOOD_KEY, ...record });
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Não foi possível gravar o autosave local.");
        transaction.abort();
      }
    };
    await completed.catch((error: unknown) => { throw failure ?? error; });
  } finally {
    database.close();
  }
}
