# Orbit Trail Substep Samples Implementation Plan

> **Estado Wave A:** concluído. P3 de cópia antes da decimação e boundary de revisão estão cobertos. Worker Vitest 48/48, ESLint focado, typecheck e `git diff --check` passaram; review read-only final de Prumo sem P1/P2/P3 acionáveis. O recorte final não alterou arquivos de produção.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Improve historical orbit trail resolution by transporting bounded batches of real, accepted integrator substep positions.

**Architecture:** Collect candidate states locally inside `advanceSimulationInterval` and return them only when the full interval succeeds. The Worker batches these transient samples into optional versioned snapshot data; the client validates it, and the visual trail consumes accepted samples under existing revision/generation and 256-point rules. No interpolated path points are invented.

**Tech Stack:** TypeScript, Vitest, Web Worker structured clone, existing Three.js trail renderer.

**Spec:** Read-only investigation and approval recorded in the current Wave A task; current contracts are in `src/simulation/simulation-time.ts`, `simulation.worker.ts`, `simulation-client.ts`, and `src/features/simulation/orbit-trails.ts`.

## Global Constraints

- Preserve atomic Worker rollback: publish samples only when the full integration interval commits.
- Keep existing `advanceSimulationTime()` return contract and accept snapshots without the optional batch.
- Keep batch/history memory bounded; batch overflow may reduce trail detail but must not fail a physically valid tick.
- Samples are accepted solver states or accepted swept-contact states; never fabricate positions or a curve between them.
- Do not persist trail data in `astro-simulation` files.

## Review Focus

- Late integration failure: no partial samples or physical state commit.
- Swept collision: retain accepted contact and committed post-merge boundaries; draw a gap across incompatible topology.
- Any mutation or rejection that advances `worldRevision`: discard pending buffered samples before applying the mutation or publishing its result. Never flush a batch under the old revision: `SimulationClient.latestRevision` already advanced and rejects it, and local generation resets. `SET_WORLD` already clears the buffer.
- `SET_TRAIL_SAMPLING false` does not advance revision; preserve its valid pending-sample flush.
- World revision or solar-age generation change: no mixed-generation trail.
- Malformed, oversized, or stale batch: reject or discard atomically within existing snapshot validation.
- Dense world or suspended tab: preserve current step/work budgets; sample caps must not create unbounded allocation or new simulation failures.

---

## Current quantitative basis

At 30 simulated days/s and nominal 20 Hz Worker publication, snapshots are 50 ms apart: 1.5 simulated days. With the approved lunar period of 27.1208 days, this yields `27.1208 / 1.5 = 18.0805` samples per orbit. The existing 5° trail target requires `360 / 5 = 72` samples per orbit, about 3.98 times the current resolution.

These are endpoint-only publication-rate calculations, not runtime measurements of the implemented batch path. Accepted real substep states can improve resolution, but batch decimation, explicit gaps, truncation, the 128-sample batch cap, and the 256-point retained-history cap mean 5° angular spacing is not guaranteed. No browser performance measurement was run.

## Files and callers

- `src/simulation/simulation-time.ts`: adaptive interval loop and result; preserve `advanceSimulationTime()` compatibility.
- `src/simulation/world.ts`: one velocity-Verlet step; expected unchanged.
- `src/simulation/integration-sample-buffer.ts`: bounded cross-tick sample buffer and estimated-byte cap.
- `src/simulation/integration-sample-buffer.ts`: bounded cross-tick sample buffer and estimated-byte cap.
- `src/simulation/simulation.worker.ts`: capture toggle, snapshot flush, revision-boundary discard/reset and rollback behavior.
- `src/simulation/types.ts`: optional batch contract on `SimulationSnapshot`.
- `src/simulation/simulation-client.ts`: batch validation, freezing, legacy absence compatibility.
- `src/features/simulation/SimulationCanvas.tsx`: consume only accepted snapshots and bind samples to current revision/generation.
- `src/features/simulation/orbit-trails.ts`: ingest real positions, apply sampling/cap policy.
- `src/features/simulation/celestial-scene.ts`: pass accepted batch history to trail updater.
- No save codec change: trails remain transient.

## Batch contract

Add optional `integrationSamples` to `SimulationSnapshot`; absence means legacy endpoint-only snapshot.

```ts
type IntegrationSampleBatchV1 = {
  version: 1;
  startTimeSeconds: number;
  endTimeSeconds: number;
  samples: readonly {
    offsetSeconds: number;
    bodies: readonly { id: string; positionM: Vector3 }[];
  }[];
  truncated?: boolean;
};
```

Offsets are finite, strictly increasing, and within the batch interval. `endTimeSeconds` equals the enclosing snapshot simulation time. Each sparse body list has unique IDs and finite positions; sparse membership allows merge/removal without implying stale bodies. The snapshot envelope's `worldRevision` applies to the whole batch. `generation` remains local to the accepted Canvas history and changes on accepted revision/solar-age transitions. Any mutation or rejection that advances `worldRevision` discards pending samples before applying the mutation or publishing the result. Never flush a batch under the old revision: the client advances `latestRevision` when it sends the mutation and rejects that snapshot, while local generation reset clears the trail. `SET_WORLD` already clears the buffer. `SET_TRAIL_SAMPLING false` preserves its flush because it does not change revision. This creates an explicit history gap at revision boundaries. A future asynchronous or transferable queue must add an explicit monotonic sequence if ordering can no longer rely on Worker message order.

Use a hard cap of 128 samples per published batch and a 512 KiB estimated-byte cap before structured cloning. On overflow, decimate retained real candidates while preserving required endpoints/contact states and mark `truncated`; do not fail a valid integration tick. Trail ingestion then applies the angular filter to available real candidates and preserves explicit gaps. Keep the 256 samples per body history cap. The implementation uses plain objects; packed `Float64Array` plus transfer remains deferred pending profiling.

Raw numeric payload estimate: ten bodies × three Float64 coordinates plus one Float64 time is 248 bytes/sample. The prior unmeasured 880–1280 samples/s estimate implies about 0.22–0.32 MB/s raw for all ten bodies, excluding object and structured-clone overhead. Actual serialized object cost and browser throughput require measurement.

## TDD implementation tasks

### Task 1: Collect accepted interval samples atomically

**Files:** Modify `src/simulation/simulation-time.ts`; test `src/simulation/simulation-time.test.ts`. Preserve callers in `src/simulation/simulation.worker.ts` and `advanceSimulationTime()`.

- [x] Write a failing test for opt-in collection: timestamps increase, each position matches a real completed substep, final sample matches interval endpoint, and default callers receive no sample payload.
- [x] Add optional collection to `advanceSimulationInterval`; keep candidates local until successful return. Keep `advanceSimulationTime()` returning only bodies.
- [x] Add a failure-after-earlier-substeps test proving no partial result escapes. Swept-contact tests retain the accepted contact and committed topology boundaries.
- [x] Verify the focused simulation-time coverage in the combined final run recorded below.

### Task 2: Publish bounded batches from Worker

**Files:** Modify `src/simulation/types.ts`, `src/simulation/simulation.worker.ts`; test `src/simulation/simulation.worker.test.ts`.

- [x] Add tests for successful periodic batch publication, batch cap/truncation, rollback with no batch, and clearing on `SET_WORLD`.
- [x] Add optional versioned batch to snapshot. Buffer successful tick samples with absolute simulation timestamps, bounded by sample and byte caps; flush only with the matching endpoint snapshot.
- [x] Preserve tick-before-mutation physics semantics while respecting client revision filtering: do not publish an old-revision pre-mutation snapshot after the client advances `latestRevision`.
- [x] Any mutation or rejection that advances `worldRevision` discards pending samples before applying or publishing; never flush under the old revision. `SET_WORLD` already clears the buffer. Keep the `SET_TRAIL_SAMPLING false` flush because it does not advance revision.
- [x] Add Worker regressions for revision-changing `MUTATE_WORLD`, `SET_SETTINGS`, and `SET_BODIES`, rejected mutation, and Worker/Client bridge rejection of old-revision samples (`discards pending samples before %s changes revision`, `discards pending samples when a revision-changing mutation is rejected`, `does not deliver old-revision samples through the client bridge`). Existing disable coverage verifies its flush remains.
- [x] Make disabling trail capture after a failed tick clear the pending buffer and return without publishing; reviewer P2 regression is covered by a test.
- [x] Decimate before copying candidate arrays into retained storage; reviewer P3 allocation regression is covered by a test.
- [x] Re-run affected Worker coverage after the revision-boundary discard correction: Vitest 48/48; ESLint focado nos dois arquivos Worker; typecheck e `git diff --check` passaram.
- [x] Complete explicit read-only Prumo review after the Helion Worker correction: no actionable P1/P2/P3. The earlier trail/topology review did not cover this recut.

### Task 3: Validate and route accepted batches

**Files:** Modify `src/simulation/simulation-client.ts`, `src/features/simulation/SimulationCanvas.tsx`, `src/features/simulation/celestial-scene.ts`; test `src/simulation/simulation-client.test.ts` and relevant scene integration test.

- [x] Add tests for legacy snapshots without batches, valid batch freezing, malformed/oversized batch rejection, and stale revision rejection.
- [x] Validate version, count/byte limits, interval bounds/order, unique IDs and finite vectors before publishing; freeze nested batch data. A malformed batch invalidates the enclosing snapshot rather than partially accepting it.
- [x] Route batches only after the existing accepted-snapshot/revision check. Associate with current local generation; discard on revision or solar-age generation change. Never use optimistic React props as sample source.
- [x] Verify client and scene integration coverage in the combined final run.

### Task 4: Consume real candidates with existing trail limits

**Files:** Modify `src/features/simulation/orbit-trails.ts`; test `src/features/simulation/orbit-trails.test.ts`.

- [x] Add tests that feed real lunar-like candidate states and assert angular filtering where candidate spacing supports the target; endpoint-only input remains lower resolution.
- [x] Apply the existing 5°/one-day interval policy to candidate points, retain only actual states, keep the 256/body cap, and signal gaps/truncation. Do not synthesize positions.
- [x] Test nonuniform candidate spacing, 256 cap, contact/merge topology boundaries, gaps, truncation, revision/generation reset, and no fabricated points.
- [x] Render the history with `LineSegments` so explicit gaps and truncation do not become false connecting chords.
- [x] Verify trail and scene coverage in the combined final run. Prumo's read-only review of the corrected trail/topology recut found no P1/P2/P3.

## Focused verification commands

Focused validation executed by Codex before discovery of the revision-boundary P2; global `pnpm check` was not run. Final Worker recut validation and review are recorded below:

```powershell
node node_modules/vitest/vitest.mjs run src/simulation/simulation-time.test.ts src/simulation/simulation.worker.test.ts src/simulation/simulation-client.test.ts src/simulation/integration-sample-buffer.test.ts src/features/simulation/orbit-trails.test.ts src/features/simulation/celestial-scene.test.ts
node node_modules/eslint/bin/eslint.js src/simulation/simulation-time.ts src/simulation/simulation-time.test.ts src/simulation/simulation.worker.ts src/simulation/simulation.worker.test.ts src/simulation/types.ts src/simulation/simulation-client.ts src/simulation/simulation-client.test.ts src/simulation/integration-sample-buffer.ts src/simulation/integration-sample-buffer.test.ts src/features/simulation/SimulationCanvas.tsx src/features/simulation/orbit-trails.ts src/features/simulation/orbit-trails.test.ts src/features/simulation/celestial-scene.ts src/features/simulation/celestial-scene.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Vitest: 101/101 tests across six files in the earlier focused run. Final Worker recut: Vitest `5.0.5`, 48/48; ESLint on the two Worker files, typecheck, and `git diff --check` passed. Runtime was Node `v24.21.0`; pnpm CLI `12.11.2`. RTK/fnm wrapper still emitted a Node-version warning in the earlier direct-command run, while direct Node binary invocations succeeded. Worker tests cover pending-batch discard for rejected `SET_SETTINGS` and `SET_BODIES`, and `SET_WORLD`/reset followed by a snapshot without the old batch. `SET_TRAIL_SAMPLING false` still flushes because it does not advance revision. Final read-only Prumo review found no actionable P1/P2/P3. No production file changed in this final recut.

Codex manual Playwright CLI smoke: Astro loaded in local Chrome; canvas backing size `1295×878`, CSS size `1036×703`, and 10 bodies. At `1 мес/s`, enabling `Rastros` showed the `Trajeto percorrido` label; console had zero errors and warnings. This was manual smoke only: no automated E2E, browser benchmark/performance measurement, or visual quality review. `pnpm check` was not run. No 5° guarantee is claimed. The independent review of the corrected trail/topology recut found no P1/P2/P3; it was separate from the final Worker review.
