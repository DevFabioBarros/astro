# Astro Web Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, with one writer per file and a reviewer after each task.

**Goal:** Prepare Astro as an agent-ready web project and deliver a first usable slice: open the Solar System, edit or add a planet, simulate gravity and temperature effects, and export/import the simulation.

**Architecture:** Next.js hosts the application and accessible controls. A pure TypeScript simulation core owns celestial state and N-body gravity; a Web Worker advances it, and Three.js renders a scaled view. Files are validated at import and downloaded by the browser; no server or database is needed.

**Tech Stack:** Node.js 24.21.0; pnpm 12.11.2; Next.js 16.4.1; React 19.3.1; TypeScript; Three.js 0.186.1; Zod 4.6.7; Vitest 5.0.5; Playwright 1.64.1; Tailwind CSS 4.3.3; ESLint 10.12.0. At plan time these were latest stable tags returned by npm and compatible peer ranges were checked for Next.js and Vitest. Recheck registry and exact resolutions before installation.

**Spec:** `docs/superpowers/specs/2026-10-15-astro-design.md`

## Global Constraints

- First platform is a browser application; validate on Windows with Chrome first.
- Use Next.js App Router, TypeScript strict, Tailwind, ESLint, `src/`, and alias `@/*`.
- Preserve the existing approved design and plan under `docs/superpowers/`.
- Use SI units and JavaScript `number` for the initial simulation model; keep rendering scale separate from physics scale.
- User can change gravity settings and object properties; unsupported or invalid states must fail visibly and safely.
- Temperature changes must affect simulated surface material phases in the first slice.
- Save/export/import uses local files; do not add accounts, cloud sync, paid services, or a database.
- Do not copy Universe Sandbox code, brand, UI, text, datasets, or assets.
- Keep the rest of the reference feature set as a roadmap; this plan does not claim full parity.
- Do not install global tools or alter global Codex/Claude configuration. Reuse available integrations and record missing ones.

## Review Focus

- Non-finite editable values, or non-positive mass/radius/timestep: reject them and preserve the prior state. Allow gravitational constant `G = 0` as the no-gravity experiment. Add boundary tests in Task 2 and Task 5.
- Coincident bodies and invalid time steps: return a controlled simulation error before producing `NaN` or `Infinity`. Add tests in Task 2.
- Extreme masses, distances, and elapsed times: keep values finite or stop the step with an actionable error. Add tests in Task 2.
- Malformed, unsupported-version, or oversized import files: reject before changing the current simulation. Add tests in Task 6.
- WebGL unavailable or context lost: show a usable accessible explanation and keep controls/error recovery available. Add a browser check in Task 7.

---

### Task 1: Bootstrap the web project and agent harness

**Files:**
- Preserve: `docs/superpowers/specs/2026-10-15-astro-design.md`
- Create: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.mts`, `.gitignore`, `.graphifyignore`
- Create: `src/app/`, `src/lib/`, `scripts/verify-quality-rules.mjs`, `eslint-rules/`
- Create: `PRODUCT.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`
- Create: `docs/architecture.md`, `docs/design.md`, `docs/onboarding.md`, `docs/quality.md`, `docs/setup.md`
- Create when compatible: `.agents/skills/` and `skills-lock.json`

**Interfaces:**
- Consumes: approved product design and toolkit revision at `C:\Users\fabio\Desktop\toolkits\vibe-coding-toolkit`.
- Produces: a runnable Next.js skeleton, canonical product docs, exact commands, and an applicability matrix covering every toolkit tool/template.

- [ ] Inventory local Git state, files, tool versions, agent integrations, Context7, RTK, Graphify, and browser automation. Record `environment-manifest.json` as unavailable if still missing; do not infer installed versions from its dated example.
- [ ] Read the toolkit's full prompt-12 scope, defaults, tool catalog, and applicable templates at one local revision. Record each component as reused, configured, inapplicable with reason, or pending with a retry condition.
- [ ] Confirm current stable package tags, Node engine requirements, peers, and `create-next-app` flags from official docs and npm registry. Use `pnpm 12.11.2` if still installed and compatible.
- [ ] Run `pnpm dlx create-next-app@16.4.1 --help`; scaffold with App Router, TypeScript, Tailwind, ESLint, `src/`, and `@/*` in a unique temporary directory outside the project. Merge without replacing the approved design or plan.
- [ ] Initialize Git in the project if absent; do not add a remote. Preserve all existing files and review `git status` before and after integration.
- [ ] Copy/adapt the toolkit's project-doc manifest, AGENTS/CLAUDE, lightweight Next ESLint rules, verify script, Vitest config, and Graphify exclusions. Do not copy database templates or add secrets because this product starts without server persistence.
- [ ] Set `packageManager` to `pnpm@12.11.2` and the Node engine to `>=24.21.0 <25`. Add real scripts: `dev: next dev`, `build: next build`, `start: next start`, `lint: eslint .`, `typecheck: tsc --noEmit`, `lint:rules: node scripts/verify-quality-rules.mjs`, `test: vitest run`, and `check: pnpm lint && pnpm typecheck && pnpm lint:rules && pnpm test && pnpm build`.
- [ ] Add `three@0.186.1` and `zod@4.6.7` as dependencies; add `vitest@5.0.5`, `eslint@10.12.0`, `@types/node@24.19.2`, and `@playwright/test@1.64.1` as dev dependencies. Run `pnpm install` and record resolved versions and lockfile.
- [ ] Create `PRODUCT.md` and the eight remaining manifest documents from observed facts and this spec; replace placeholders, mark future features as planned, and record exact package/source results in `docs/setup.md`.
- [ ] Decide which current Vercel skills apply, install only those project-locally with their real frontmatter names and lock revisions, or record why project-local installation is unsupported. Do not install all tools globally.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm lint:rules`, `pnpm test`, and `pnpm build`; fix configuration errors before handing off.

**Acceptance:** fresh install succeeds, the blank app builds, all nine manifest docs contain project facts, toolkit applicability is explicit, and the project has no DB dependency or credentials.

### Task 2: Build the deterministic simulation core

**Files:**
- Create: `src/simulation/types.ts`, `src/simulation/physics.ts`, `src/simulation/integrator.ts`, `src/simulation/world.ts`
- Test: `src/simulation/physics.test.ts`, `src/simulation/integrator.test.ts`, `src/simulation/world.test.ts`
- Modify: `package.json` only if a test or quality command needs adjustment.

**Interfaces:**
- `Vector3 = readonly [x: number, y: number, z: number]`
- `CelestialBody = { id: string; name: string; kind: 'star' | 'planet' | 'moon'; massKg: number; radiusM: number; positionM: Vector3; velocityMs: Vector3; surfaceTemperatureK: number; waterFraction: number }`
- `PhysicsSettings = { gravitationalConstant: number }`, initially `6.67430e-11` SI.
- `advanceWorld(bodies: readonly CelestialBody[], settings: PhysicsSettings, dtSeconds: number): CelestialBody[]` returns a new validated state or throws a typed simulation error.

- [ ] Add failing tests for Newtonian pair acceleration, momentum symmetry, `G = 0`, negative/non-finite `G`, invalid kind, non-positive/non-finite mass or radius, water fraction outside `0..1`, coincident positions, `Number.MAX_VALUE` mass/distance/timestep, and invalid timestep.
- [ ] Run `pnpm test -- src/simulation/physics.test.ts`; confirm new tests fail for the missing implementation.
- [ ] Implement `Vector3`, input validation, and pairwise Newtonian acceleration in SI units in `src/simulation/physics.ts`.
- [ ] Add failing integration tests for deterministic velocity-Verlet stepping and one two-body orbital period with a bounded energy drift.
- [ ] Run the focused integration tests and confirm they fail before implementation.
- [ ] Implement velocity-Verlet integration in `src/simulation/integrator.ts`; keep physics state independent of React and Three.js.
- [ ] Implement `advanceWorld` in `src/simulation/world.ts`; never mutate caller arrays or return non-finite state.
- [ ] Run `pnpm test -- src/simulation`; require all focused tests to pass.

### Task 3: Load a Solar System and render it in Three.js

**Files:**
- Create: `src/simulation/solar-system.ts`, `src/simulation/solar-system.test.ts`
- Create: `src/features/simulation/SimulationCanvas.tsx`, `src/features/simulation/scene-scale.ts`, `src/features/simulation/scene-scale.test.ts`
- Modify: `src/app/page.tsx`, `src/app/globals.css`

**Interfaces:**
- `createSolarSystem(): CelestialBody[]` returns the versioned initial preset in SI units.
- `toScenePosition(positionM: Vector3, originM: Vector3): [number, number, number]` maps coordinates relative to the camera origin without modifying physics values.

- [ ] Add a failing preset test for the Sun, eight planets, Earth-Moon system, positive masses/radii, and finite positions/velocities.
- [ ] Verify the provenance and license for the initial astronomical values against NASA/JPL primary data; store only the selected values and source metadata in the project.
- [ ] Implement the static initial preset in `src/simulation/solar-system.ts`; do not call a remote service at runtime.
- [ ] Add a failing scene-scale test showing body offsets relative to the camera origin map into finite render coordinates while simulation coordinates remain unchanged.
- [ ] Implement a client-only Three.js scene with WebGL 2, generated placeholder materials, visible bodies, orbit paths, selection, and camera navigation. Keep simulation values out of render-space calculations.
- [ ] Show an accessible fallback if WebGL cannot initialize; support cleanup on unmount and context loss.
- [ ] Run `pnpm test -- src/simulation/solar-system.test.ts src/features/simulation/scene-scale.test.ts` and `pnpm typecheck`.

### Task 4: Advance physics without blocking the interface

**Files:**
- Create: `src/simulation/simulation.worker.ts`, `src/simulation/simulation-client.ts`, `src/simulation/simulation-client.test.ts`
- Modify: `src/features/simulation/SimulationCanvas.tsx`

**Interfaces:**
- `SimulationSnapshot = { bodies: CelestialBody[]; simulationTimeSeconds: number; status: 'running' | 'paused' | 'error'; error?: string }`.
- `SimulationClient` exposes `start(): void`, `pause(): void`, `setSpeed(multiplier: number): void`, `setBodies(bodies: CelestialBody[]): void`, `subscribe(listener: (snapshot: SimulationSnapshot) => void): () => void`, and `dispose(): void`.
- Worker messages use a discriminated TypeScript union; invalid messages return a typed error and do not alter world state.

- [ ] Add failing tests for start/pause, time scaling, message validation, disposal, and error propagation.
- [ ] Run focused tests and confirm they fail before implementation.
- [ ] Move `advanceWorld` calls into a Web Worker; send immutable serializable snapshots to the UI at a bounded display rate.
- [ ] Keep pause and simulation speed separate from the numerical integration timestep.
- [ ] Run focused tests and `pnpm typecheck`; profile a documented local scenario and record body count, frame rate, and hardware without setting an unsupported universal threshold.

### Task 5: Add free object editing and temperature effects

**Files:**
- Create: `src/simulation/surface-phase.ts`, `src/simulation/surface-phase.test.ts`
- Create: `src/features/simulation/SimulationToolbar.tsx`, `src/features/simulation/ObjectInspector.tsx`
- Modify: `src/app/page.tsx`, `src/app/globals.css`, `src/simulation/types.ts`

**Interfaces:**
- `classifyWaterPhase(temperatureK: number): 'ice' | 'liquid' | 'vapor' | 'unsupported'` defines the first simplified surface-material model at standard atmospheric pressure.
- UI state contains selected body ID, editable global gravitational constant, time controls, and validation/error messages.

- [ ] Add failing tests for `273.15 K` and `373.15 K` water-phase boundaries and non-finite/negative temperature; document the standard-pressure approximation in test names and product docs.
- [ ] Run focused tests and confirm they fail before implementation.
- [ ] Implement the first visible surface effect: a body's water material changes between ice, liquid, and vapor as temperature crosses `273.15 K` and `373.15 K`, assuming standard atmospheric pressure; bodies with `waterFraction = 0` have no water phase.
- [ ] Add accessible controls to select a body, add a planet from a preset, edit mass/radius/position/velocity/temperature/water fraction, change gravitational constant, and pause/resume/change simulation speed.
- [ ] Reject invalid form values and keep the last valid world state. Add tests for `NaN`, infinity, zero/negative mass and radius, and out-of-range temperature.
- [ ] Run focused tests, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.

### Task 6: Export and import simulation files

**Files:**
- Create: `src/simulation/save-file.ts`, `src/simulation/save-file.test.ts`
- Create: `src/features/simulation/SaveControls.tsx`
- Modify: `src/features/simulation/SimulationToolbar.tsx`, `src/simulation/types.ts`

**Interfaces:**
- `encodeSimulation(bodies: readonly CelestialBody[], settings: PhysicsSettings): string` emits JSON `{ format: 'astro-simulation', version: 1, bodies, settings }`.
- `decodeSimulation(text: string): { bodies: CelestialBody[]; settings: PhysicsSettings }` validates fully before returning.

- [ ] Add failing tests for round-trip preservation, malformed JSON, unknown file version, oversized input, missing fields, and unsafe numeric values.
- [ ] Run focused tests and confirm they fail before implementation.
- [ ] Implement a versioned JSON format and runtime validation; reject unknown versions before changing live simulation state.
- [ ] Limit imports to 10 MiB, add browser download and file-picker controls, show success/error feedback, and do not transmit file content.
- [ ] Run focused tests and `pnpm test`.

### Task 7: Integrated browser validation and handoff

**Files:**
- Modify: `README.md`, `PRODUCT.md`, `AGENTS.md`, `docs/architecture.md`, `docs/design.md`, `docs/onboarding.md`, `docs/quality.md`, `docs/setup.md`
- Create: `playwright.config.ts`, `e2e/simulation.spec.ts`

- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm lint:rules`, `pnpm test`, and `pnpm build` from a clean dependency install.
- [ ] Configure Playwright to use installed Chrome, without downloading a second browser. Add an end-to-end test for startup, body editing, temperature phase changes, and file round-trip.
- [ ] Run `pnpm exec playwright test` against the app on a free port and record the browser version.
- [ ] Exercise the WebGL-unavailable path and confirm the page explains the issue without a blank interactive area.
- [ ] Run Graphify code-only extraction with auto-refresh disabled if the installed CLI accepts the documented mode; record configured/not run if unsupported.
- [ ] Update `docs/setup.md` with exact versions, source URLs, commands, and validated/configured/pending statuses; update other docs to reflect implemented features only.
- [ ] Review `git diff --check`, `git status`, and all generated files; preserve the approved design and this plan.

## Future plans after this slice

Write separate designs and plans for collisions/fragmentation, full climate and material grids, stellar evolution and black-hole effects, procedural systems/galaxies, historical scenarios and tools, and optional VR/localization. Each plan must produce a working, testable slice and report measured performance and model limits.
