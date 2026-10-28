# SHARD Impact Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use Maestri roles for implementation and read-only review. One writer per file. Do not edit Python, global config, commit, or deploy.

**Goal:** Provide a bounded impact lab backed by SHARD's per-impact SPH outcomes. Live collision use stays disabled until the 10-hour snapshot timing is reconciled.

**Status:** Data catalog, loader, and lab-only query are implemented. Live collision integration and SHARD-driven VFX remain deferred.

**Architecture:** Parse SHARD's local table and interpolate remnant states. Exact grid nodes may expose original debris samples; interpolated queries do not invent matching debris. Keep N-body integration, rollback, save validation, and rendering in their existing layers. Store CC0 outcomes compressed and lazy-load a selected debris file; no third-party runtime requests.

**Tech Stack:** TypeScript, existing Web Worker, Vitest, existing Playwright CLI/Chrome, Node built-in tooling for data preparation.

**Spec:** `docs/superpowers/specs/2026-10-17-impact-simulator-design.md`

## Global Constraints

- No Python edits, dependency installs, global settings, commits, or deploys.
- Preserve Newtonian integration and atomic rollback.
- Do not persist composition in this slice; query declares fixed 10% bulk water on both bodies, independent of visual `waterFraction`.
- Keep save v1–v3 untouched.
- Model only within SHARD's joint data grid; no extrapolation.
- No third-party runtime data requests.
- Keep the 64-body limit and report any aggregation/truncation.
- Keep fallback collisions explicit and scientifically labeled.

## Review Focus

- Swapping input body order must not change `γ`, target/projectile composition, or outcome.
- Missing/crashed SPH corners and values outside the joint grid must fall back without partial state.
- Source frame and units must be converted exactly; do not label the ~10-hour SHARD snapshot as contact state.
- Validate mass/water totals. Measure momentum/energy differences; never claim conservation without source evidence.
- Reaching the 64-body cap must not truncate mass; do not cluster physical states in this slice.
- Existing snapshots, saves, manual explosion, trail gaps, and visual effects must remain compatible.

---

### Task 1: Lock the SHARD contract and source provenance

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-impact-simulator-design.md`
- Modify: `public/textures/ATTRIBUTION.md` or create `public/impact-data/ATTRIBUTION.md`
- Modify: `docs/physics.md`

**Interfaces:** Adopt `gamma = min(m1/m2, m2/m1)` with `0 < gamma <= 1`; SHARD's actual `SPH.table` has `gamma=0.1, 0.5, 1`, despite a paper table typo. Use one declared internal bulk-water profile per body, separate from surface `waterFraction`. Restrict inputs to the 6D SPH convex hull and reject interpolation cells with missing/unusable corners.

- [x] Use SHARD-880-grid for lab outcomes; live collision ejecta stays off.
- [x] Record nonrotating bodies, SPH snapshots at roughly 10 hours, fixed 10%/10% water, grid limits, CC0 provenance, invalid nodes, and fallback.
- [x] Bundle selected 10%/10% data as per-outcome gzip after size measurement; load locally, without remote requests.

### Task 2: Build the local SPH outcome loader and impact model

**Files:**
- Create: `src/simulation/impact-outcomes.ts`
- Create: `src/simulation/impact-outcomes.test.ts`
- Create: `public/impact-data/*` (generated, selected supported domain only)
- Create: `scripts/prepare-impact-data.mjs`

**Interfaces:** `resolveImpactOutcome(dataset, query): ImpactOutcome | undefined` returns `undefined` outside the supported grid or with unusable corners. Query uses the fixed 10%/10% bulk-water profile. Output preserves source-frame metadata, identifies the ~10-hour post-impact snapshot, and reports masses/water plus remnant/debris states after unit conversion. It is not a contact-state resolver.

- [x] Add reference tests for canonical gamma, mass/speed/angle interpolation, exact nodes, missing corners, and order invariance.
- [x] Implement no-extrapolation multilinear interpolation for remnant payloads; debris is available only at exact nodes.
- [x] Bundle fixed 10%/10% data as individual gzip outcomes and lazy-load the selected file.
- [x] Keep debris as snapshot samples; do not convert them to physical bodies or invented clusters.
- [x] Validate finite values, water/mass capacity, units, and deterministic outcomes. Do not claim momentum/energy conservation.

### Task 3: Live collision integration (deferred)

**Files:**
- Modify: `src/simulation/collisions.ts` and `collisions.test.ts`
- Modify: `src/simulation/simulation-time.ts` and `simulation-time.test.ts`
- Modify: Worker/client types and tests only as required for validated impact event metadata.

**Interfaces:** Live collision resolution must not consume the SHARD ~10-hour snapshot as if it were a contact state. Keep idealized merge until a lab-only timing contract or a validated time/frame mapping exists.

- [x] Keep SHARD outcomes out of live collision handling; no event claims contact-state debris.
- [ ] Reconcile the ~10-hour source snapshot with contact-time dynamics and validate frame rotation before applying outcomes to the Worker.
- [ ] Only then design atomic fragment insertion, body caps, rollback, and collision-chain tests.

### Task 4: Add the impact lab flow (implemented)

**Files:**
- Create: `src/features/impact/ImpactLab.tsx` and test
- Modify: `src/app/page.tsx` and `src/app/globals.css` to open the modal laboratory
- Modify: `src/features/simulation/SimulationToolbar.tsx` and test for pre-existing cardinality limits

- [x] Add a lab query within supported grid choices and display fixed composition, source time, and frame.
- [x] Show remnant outcomes and label exact-node debris as a 2D sample; do not imply it is an evolved two-body scenario.
- [x] Explain that live collisions remain idealized; unsupported queries have a labeled fallback.

### Task 5: SHARD-driven collision visuals (deferred)

**Files:**
- No live scene or event files are changed in this slice.
- Modify: `docs/architecture.md`, `docs/quality.md`, `docs/physics.md`, `PRODUCT.md`

- [ ] Bind SHARD outcomes to live collision effects only after the deferred timing/frame contract is validated.
- [ ] Add automated Playwright coverage for in-domain and fallback queries; current validation is a manual CLI smoke.
- [x] Run integrated focused Vitest, ESLint, typecheck, and Playwright CLI with existing Chrome configuration.
- [x] Record actual browser console results; no GPU benchmark is claimed.
