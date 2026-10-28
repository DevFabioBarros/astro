# Simulation and Visual Quality Plan

> **For agentic workers:** Maestri workers execute their assigned slices. Use TDD and focused review. No commits.

**Goal:** Make simulation limits recoverable, show clear visual impact for every collision, remove misleading body controls, and improve desktop scene readability.

**Architecture:** Keep Newtonian collision resolution and its event protocol unchanged. Improve bounded Worker behavior and render existing collision events as transient effects; keep appearance code separate from physics. Filter inspector fields by body semantics and budget speed options by body count.

**Tech Stack:** Next.js, TypeScript, React, Three.js, Vitest, ESLint, Playwright CLI.

**Spec:** `docs/superpowers/specs/2026-10-17-realistic-astronomy-design.md` plus user-approved audit findings in this conversation.

## Global Constraints

- Node `>=24.21.0 <25`; pnpm `12.11.2`.
- Physics remains independent of rendering.
- Existing save format and Worker event protocol remain unchanged.
- All effects are bounded, disposable, and respect reduced motion.
- No invented collision fragmentation, GR, lensing, photometry, or white-dwarf surface texture.
- No Python, global configuration, commit, deploy, or `pnpm check`.

## Review Focus

- Many simultaneous initial contacts must not fail after 16 valid merges; test 17 disjoint overlapping pairs at `G=0`.
- Fractional slow-speed ticks must advance positions and simulated time without waiting for a whole second.
- A 64-body month-per-second request must fail or adapt with a clear recoverable state; never leave a misleading selected speed.
- Collision effects must appear for merge events, expire, stay bounded, and respect reduced motion.
- Scene labels and orbit paths must not obscure visible body discs.
- Star-only and black-hole-only controls must not expose no-op water or temperature edits; field errors must be associated with inputs.

---

### Task 1: Worker Simulation Limits

**Files:** `src/simulation/simulation-time.ts`, `src/simulation/simulation-time.test.ts`, `src/simulation/simulation.worker.ts`, `src/simulation/simulation.worker.test.ts`.

- [x] Add regression tests for 17 independent initial overlaps and fractional slow-rate integration; run them red.
- [x] Implement bounded collision resolution and preserve subsecond accumulation with atomic rollback.
- [x] Add a clear limit/recovery path for 64-body, month-per-second load; keep UI speed state consistent through existing protocol.
- [x] Run focused Vitest, ESLint, and typecheck.

### Task 2: Collision Effects and Scene Readability

**Files:** `src/features/simulation/scene-events.ts`, `scene-events.test.ts`, `scene-labels.ts`, `scene-labels.test.ts`, `orbit-paths.ts`, `orbit-paths.test.ts`, `celestial-bodies.ts`, `celestial-bodies.test.ts`, and scene tests only where required.

- [x] Add red tests for collision effects, bounded expiry, label placement, and orbit occlusion.
- [x] Improve effects using existing collision events; keep them visual, finite, bounded, and reduced-motion aware.
- [x] Place labels outside body discs and hide/fade orbit lines behind opaque body surfaces.
- [x] Improve ordinary stellar surface animation deterministically; keep white dwarfs smooth and preserve attribution for existing maps.
- [x] Run focused Vitest, ESLint, and typecheck.

### Task 3: Body Inspector Semantics

**Files:** `src/features/simulation/ObjectInspector.tsx`, `ObjectInspector.test.ts`, `src/features/simulation/SimulationToolbar.tsx`, `SimulationToolbar.test.ts`, `src/app/globals.css` only if desktop layout needs a local style adjustment.

- [x] Add red tests for hidden no-op fields on stars and black holes, plus input-to-error associations.
- [x] Render only meaningful fields and expose each field error through `aria-describedby`.
- [x] Make the desktop inspector easier to scan without changing simulation semantics.
- [x] Disable speed presets over the nominal per-tick budget and expose the reason.
- [x] Run focused Vitest, ESLint, and typecheck.

### Task 4: Integrated Browser Validation

- [ ] Run the full Playwright CLI workflow in desktop Chrome: edit star/planet, collision/merge effect, labels/orbits, reduced motion, and recover from a load limit. The manual smoke covered collision/fusion, labels/orbits, and clean-console reload only.
- [x] Record screenshots and console errors for the exercised flows: `astro-event-final.png` and `astro-clean-final.png`; clean-session console reported 0 errors and 0 warnings. Static event capture does not establish transient-effect quality or timing.
- [x] Run `git diff --check`; do not claim a full suite, benchmark, or GPU performance result unless executed.

## Integrated verification — 17/10/2026

Node `v24.21.0`, Vitest `5.0.5`, ESLint `10.12.0`: 146/146 focused tests passed in 11 files; ESLint on 19 changed TS/TSX files exited 0; `tsc --noEmit` exited 0. Focused Playwright smoke was manual and delegated; no automated E2E, reduced-motion flow, 64-body browser recovery, benchmark, GPU profiling, `pnpm check`, or commit.
