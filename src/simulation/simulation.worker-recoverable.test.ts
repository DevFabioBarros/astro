import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSimulationErrorNotice, SimulationErrorNotice } from "@/features/simulation/simulation-error-notice";
import { createSimulationClient } from "./simulation-client";
import { schwarzschildRadius } from "./physical-constants";
import { installSimulationWorker } from "./simulation.worker";
import type { CelestialBody, SimulationSnapshot, SimulationWorkerMessage, Vector3 } from "./types";

class RecoverableWorkerScope extends EventTarget {
  outbound = new EventTarget();
  messages: SimulationWorkerMessage[] = [];
  revision = 0;
  postMessage = (message: SimulationWorkerMessage) => {
    const cloned = structuredClone(message);
    this.messages.push(cloned);
    this.outbound.dispatchEvent(new MessageEvent("message", { data: cloned }));
  };

  send(data: unknown) {
    const command = data as Record<string, unknown> | null;
    if (command && ["SET_WORLD", "MUTATE_WORLD"].includes(String(command.type))) {
      const revision = typeof command.revision === "number" ? command.revision : this.revision + 1;
      this.revision = Math.max(this.revision, revision);
      data = { ...command, ...(command.type === "SET_WORLD" && command.origin === undefined ? { origin: "initial" } : {}), revision };
    }
    this.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
  }

  latest(): SimulationSnapshot {
    const message = this.messages.filter((item) => item.type === "SNAPSHOT").at(-1);
    if (!message) throw new Error("Expected a snapshot");
    return message.snapshot;
  }
}

class RecoverableWorkerAdapter extends EventTarget {
  constructor(private readonly scope: RecoverableWorkerScope) {
    super();
    scope.outbound.addEventListener("message", (event) => {
      this.dispatchEvent(new MessageEvent("message", { data: (event as MessageEvent).data }));
    });
  }

  postMessage(data: unknown) { this.scope.send(data); }
  terminate() {}
}

const makeBlackHole = (id: string, positionM: Vector3): CelestialBody => ({
  id, name: id, kind: "star", bodyType: "black-hole", massKg: 1e12,
  radiusM: schwarzschildRadius(1e12), positionM, velocityMs: [0, 0, 0],
  surfaceTemperatureK: 0, waterFraction: 0,
});
const cleanups: (() => void)[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

describe("recoverable scientific black hole collision refusal", () => {
  it("preserves the accepted world, pauses, accepts repositioning, and resumes", () => {
    const scope = new RecoverableWorkerScope();
    cleanups.push(installSimulationWorker(scope as unknown as Parameters<typeof installSimulationWorker>[0]));
    const client = createSimulationClient(new RecoverableWorkerAdapter(scope) as unknown as Worker);
    cleanups.push(() => client.dispose());
    const snapshots: SimulationSnapshot[] = [];
    client.subscribe((snapshot) => snapshots.push(snapshot));
    const first = makeBlackHole("bh-a", [0, 0, 0]);
    const second = makeBlackHole("bh-b", [1e-16, 0, 0]);
    const acceptedTimeSeconds = 1234;

    client.setWorld([first, second], { gravitationalConstant: 0 }, 1, "import", undefined,
      { simulationTimeSeconds: acceptedTimeSeconds, collisionMode: "scientific" });
    const acceptedBodies = snapshots.at(-1)!.bodies;
    client.start();
    vi.advanceTimersByTime(50);

    const refusal = scope.messages.findLast((message) => message.type === "ERROR");
    expect(refusal).toMatchObject({
      type: "ERROR",
      message: "Colisão entre buracos negros não é suportada. A execução foi pausada no último estado aceito; edite posição/velocidade ou troque o cenário antes de retomar.",
      snapshot: { status: "paused", simulationTimeSeconds: acceptedTimeSeconds, collisionMode: "scientific", bodies: acceptedBodies },
    });
    const refusedSnapshot = snapshots.at(-1)!;
    expect(refusedSnapshot).toMatchObject({ status: "paused", simulationTimeSeconds: acceptedTimeSeconds, bodies: acceptedBodies,
      error: "Colisão entre buracos negros não é suportada. A execução foi pausada no último estado aceito; edite posição/velocidade ou troque o cenário antes de retomar." });
    const notice = getSimulationErrorNotice(refusedSnapshot);
    const markup = renderToStaticMarkup(createElement(SimulationErrorNotice, { notice }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("<strong>Simulação pausada</strong>");
    expect(markup).toContain(`<span>${refusedSnapshot.error}</span>`);

    client.mutateWorld({ type: "EDIT_BODY", bodyId: "bh-b", field: "positionM.0", value: 1_000 }, 2);
    expect(snapshots.at(-1)).toMatchObject({
      status: "paused", simulationTimeSeconds: acceptedTimeSeconds, collisionMode: "scientific",
      bodies: [{ id: "bh-a", positionM: [0, 0, 0] }, { id: "bh-b", positionM: [1_000, 0, 0] }],
    });

    client.start();
    vi.advanceTimersByTime(50);
    expect(snapshots.at(-1)).toMatchObject({ status: "running", collisionMode: "scientific", bodies: [{ id: "bh-a" }, { id: "bh-b" }] });
    expect(snapshots.at(-1)!.simulationTimeSeconds).toBeGreaterThan(acceptedTimeSeconds);
  });
});
