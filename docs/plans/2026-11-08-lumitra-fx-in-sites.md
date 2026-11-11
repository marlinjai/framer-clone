---
type: plan
status: in-progress
date: 2026-11-08
title: "Lumitra FX moves into Lumitra Sites: the WebGL effects engine becomes an FX scene block"
summary: "Marlin decided on 2026-11-08 that Lumitra FX, the owned WebGL effects engine (god rays, bloom, noise fields, gradients, grain; today the private package @lumitra-web/fx in the lumitra-web repo, whose only consumer is the lumitra.co hub hero), belongs in Lumitra Sites (framer-clone). This plan copies the engine into framer-clone as an internal module, adds an `FX scene` node (a marked div with the scene as data, rendered by a lazy client island only where one is on the page), generates its properties panel from the engine's own parameter schema in place of the leva tuning panel, teaches the AI generator and the agent plugin about it, and proves it pixel for pixel against lumitra.co before lumitra.co itself moves. lumitra-web keeps a frozen copy and lumitra.co and services.lumitra.co keep running untouched until Marlin approves the apex move. Supersedes the 2026-06-27 decision (D4) that FX would move into the lumitra-studio monorepo. Eight slices, about 17 to 24 agent days. Marlin also decided on 2026-11-08 (option B) that services.lumitra.co is rebuilt in Sites as well and lumitra-web is retired once both hosts run on Sites; the retirement sequence is part of this plan."
tags: [framer-clone, lumitra-sites, fx, webgl, three-js, react-three-fiber, primitives, migration, lumitra-web]
projects: [framer-clone, lumitra-web, knowledge-base]
---

# Lumitra FX moves into Lumitra Sites

## Decision already made (2026-11-08)

**Marlin decided that Lumitra FX belongs in Lumitra Sites.** Lumitra Sites is framer-clone, the hosted website builder
on app.lumitra.co whose sites publish to `<label>.sites.lumitra.co` and custom domains.

Why, from the evidence gathered for this plan:

1. **FX is a website effect and has one consumer, a website.** The engine's only consumer is lumitra-web, and inside it
   only the lumitra.co hub hero (`src/components/hub/HeroSceneInner.tsx`, scene `src/scenes/hubHero.ts`) and two noindexed
   demo routes (`/fx`, `/fx/gallery`). No other repo depends on it (checked every `package.json` under
   `~/software-dev` on 2026-11-08).
2. **The earlier plan to home it in Studio never executed and Studio has moved on.** The knowledge-base plans
   `research/2026-06-07-lumitra-studio-composition-and-embed-architecture.md` (decision 5: "fx migrates IN from
   lumitra-web" into the lumitra-studio engine monorepo) and
   `research/2026-06-27-lumitra-studio-surface-architecture-and-portfolio-video-plan.md` (D4: publish
   `@marlinjai/lumitra-fx` from the studio monorepo before building the director) were both decided and neither was built.
   Studio's own consolidation draft (`lumitra-studio/docs/plans/2026-08-15-studio-consolidation-and-redesign-sequencing.md`)
   says the FX track "never landed", that its value reached Studio through the react-three-fiber 3D adapter instead, and
   "do not resurrect the FX goal files". This decision supersedes D4 and decision 5 as far as FX's home is concerned;
   both documents carry an amendment note pointing here.
3. **Sites already has everything around it.** Published pages load client code only through lazy islands
   (`src/lib/renderer/server/BehaviourIsland.tsx`, `EffectsIsland.tsx`); the decided
   [3D scene primitive plan](2026-11-02-3d-scene-primitive.md) sets the pattern for a WebGL node (a marked `div`, scene as
   data, an island that creates the `canvas`); and the approved
   [agent plugin plan](2026-11-02-lumitra-sites-agent-plugin.md) names building the new lumitra.co in Sites as its
   dogfood. The lumitra.co hero is FX, so lumitra.co cannot move to Sites without FX in Sites.
4. **The engine was built to be data.** A scene is plain JSON: an ordered stack of layers, each with a typed parameter
   schema that already drives the editor, serialization and the runtime from one source
   (`packages/fx/src/types.ts`, `registry.ts`, `serialize.ts`). That is exactly the shape a Sites node stores.

**Decided later the same day (2026-11-08, option B of "For Marlin to decide"):** services.lumitra.co is rebuilt in Sites
too, and lumitra-web is retired once lumitra.co and services.lumitra.co both run on Sites. Why: it ends a second Next.js
app, container image and deploy pipeline that would otherwise exist for one German one-pager, and the services page (a
pitch plus an offer ladder) is what Sites builds. See "Retiring lumitra-web" below.

**Still not decided here:** when lumitra.co's domain points at Sites. The agent plugin plan holds that as Marlin's yes,
and the same applies to services.lumitra.co.

## Current state (verified 2026-11-08)

### The engine

- Source: `lumitra-web/packages/fx`, package `@lumitra-web/fx` 0.4.0, private, about 4,900 lines of TypeScript. Its build
  spec `lumitra-web/docs/plans/2026-05-31-lumitra-fx-engine.md` is completed (phases 0 to 4).
- Public surface: `<LumitraScene config />` (React), `createScene(config)` (vanilla mount), `registerNode` /
  `registerLayer` (the registry), `serializeScene` / `deserializeScene`, `sceneConfigFromUnified`, and a preset gallery
  (`godrays-hero`, `noise-gradient`, `bokeh-focuspull`).
- 15 layer types: content `text`, `noiseFill`, `image`, `shape`, `gradient`; post passes `godRays`, `bloom`, `bokeh`,
  `chromaticAberration`, `rgbShift`, `distortion`, `pixelate`, `halftone`, `vignette`, `grain`.
- Runtime dependencies (peers): react 19, three 0.184, @react-three/fiber 9, @react-three/postprocessing 3,
  postprocessing 6, @react-three/drei 10 (used for `PerformanceMonitor` only), leva 0.10 (the tuning panel, mounted
  inside `LumitraScene.tsx` itself behind `?tune=1`).
- One cross-repo dependency: `@marlinjai/studio-scene-core` ^0.1.0 (published on npm, 0.2.0 is current), the render-free
  unified scene schema homed in lumitra-studio. FX uses only its `runMigrations` inside `sceneConfigFromUnified`, the
  "U1 bridge" that reads a Studio-format scene. Two lumitra-web scenes load through it (`src/scenes/v7.ts`,
  `src/scenes/demoPhase2.ts`); the hub hero loads the plain format (`deserializeScene`).
- Tests: one, `src/__tests__/unified.equivalence.test.ts`, proving the bridge and the plain loader produce the same
  scene.
- Invariants the engine enforces: no server rendering, pixel ratio clamp `[1, 1.75]`, a one-way step down of pixel ratio
  and heavy passes on low frame rate, a static resolved frame under reduced motion, teardown on unmount (Safari allows
  8 live WebGL contexts).

### Production

- Coolify app `lumitra-web` serves `lumitra.co`, `www.lumitra.co` and `services.lumitra.co` (checked through the Coolify
  API on 2026-11-08). lumitra.co answers "Lumitra: focused tools for people who run their own business on the web",
  services.lumitra.co answers "Lumitra: KI-Automatisierung für den Mittelstand", `/api/health` answers `{"ok":true}`.
- The hub hero mounts FX 1.5 seconds after the window `load` event, skips it under reduced motion, and paints a static
  gold-on-black CSS gradient until then and wherever WebGL is missing (`src/components/hub/HeroScene.tsx`).
- The services tree (`src/app/(services)`) imports nothing from FX. **The services question therefore gates only the very
  last cleanup step of this plan.**
- Coolify app `framer-clone` serves `app.lumitra.co` and `demo.sites.lumitra.co`.

### Sites

- Next 15.5.28 and React 19.1.9 (lumitra-web runs Next 16.4.3 and React 19.2.4; FX's peers ask only for React 19).
- No three.js, react-three-fiber or postprocessing dependency yet. The 3D scene primitive is decided but unbuilt (no
  `data-scene` in `src/`).
- "Effects" is taken: the shipped [motion effects](2026-10-23-motion-effects.md) feature (appear on scroll, hover,
  parallax) is `props.effects`, the panel's Effects section and `EffectsIsland`. The FX node must not reuse the word.
- A stored page holds no `canvas`: it is not in the render vocabulary, and the 3D plan's rule is that an island creates
  it. FX follows the same rule.

## Target

A site author places an **FX scene** from the insert palette (starting from a preset such as "Gold noise gradient",
the lumitra.co hero), sizes it like any box, puts ordinary nodes inside it (headline, buttons), and tunes its layers in an
**FX** section of the properties panel. The published page renders the box, its own CSS background and its children on
the server; a client island draws the scene behind the children when WebGL works and the visitor has not asked for
reduced motion. A page without an FX scene loads no byte of the engine.

### The node

Following the map embed and the 3D primitive: an ordinary `div` with a marker attribute and the scene as a prop.

```json
{
  "type": "div",
  "props": {
    "data-fx": "scene",
    "fx": {
      "version": 1,
      "scene": { "...": "an FX SceneConfig, values only, exactly what serializeScene writes" },
      "start": "settled",
      "calm": "background"
    },
    "style": { "position": "relative", "minHeight": "100svh", "background": "linear-gradient(...)" }
  },
  "children": [ "the content shown over the scene, and alone whenever the scene is not drawn" ]
}
```

- `scene` is the engine's own format (`SCENE_SCHEMA_VERSION` 1), parsed through the engine's own `deserializeScene`,
  which already drops unknown layer types and coerces bad parameters to defaults. Sites adds clamps on top (layer count,
  text length, resolution of `image` layers) and refusals with messages, in `src/lib/fx/format.ts`.
- `start`: `settled` (the lumitra.co behaviour: after `load` plus 1.5 seconds), `visible` (when the box comes within one
  viewport height), or `immediate`.
- `calm`: what reduced motion shows: `background` (the box's CSS background, as lumitra.co does today) or `frame` (one
  static resolved frame, which the engine already renders).
- `fx` is denied as a Document Object Model (DOM) prop, as `effects` and `behaviour` are and `scene` will be.

### The runtime on a published page

- `applyFx(root)`, a pure pass in `renderPublishedPage` beside `applyEffects`, finds FX nodes and returns the box, its
  children and a program table. `FxIsland`, a client island like `BehaviourIsland`, imports the engine with a dynamic
  `import()` inside its effect, so the engine is its own chunk.
- WebGL probe first (a throwaway context, then lost), as the 3D plan does. No WebGL: nothing is fetched.
- The island creates the canvas as the box's first child, behind the children (`position: absolute; inset: 0;
  pointer-events: none; aria-hidden`), and crossfades it in over 300 milliseconds once the first frame is drawn.
- Fallback ladder: JavaScript off, no WebGL, a failed chunk, a context loss, or a start error all leave the box's CSS
  background and the children, which is what the server sent. A failure logs one console warning; the scene is
  decorative, so no visible error.
- Teardown on page leave; at most one live FX context per published page at version 1 (a second FX node renders its
  `calm` state). This keeps a page with an FX hero and a 3D scene within Safari's limit.

### Bundle

- One three.js for the whole app. When the 3D primitive's slices land first, FX uses its pinned version; when FX lands
  first, the 3D plan inherits FX's. One `package.json` entry either way.
- react-three-fiber, @react-three/postprocessing and postprocessing come with FX. Rewriting the engine onto plain three.js
  (as the 3D primitive's runtime is) is out of scope: it would rewrite 15 layers for no visitor-visible gain.
- drei is replaced by a 30-line local `PerformanceMonitor` equivalent, or imported by deep path, whichever the bundle test
  shows smaller. leva does not ship in Sites at all (see the editor).
- A bundle test measures the FX chunk on Next's real build, as the behaviour plan and the 3D plan do. The budget is
  set from the first measurement (expected around 230 KB gzipped including three.js, the same order as the 3D plan's
  210 KB) and then held: the test fails on growth above 5 percent.
- `fx-no-bytes-without-fx`: a page without an FX node fetches none of the engine's chunks, proven over the network.

### The editor

- **Insert palette:** an "FX scene" entry with the engine's presets as starting points, plus "Gold noise gradient" taken
  from `lumitra-web/src/scenes/hub-hero.json`.
- **Properties panel, FX section:** a layer list (add, remove, reorder, show or hide; reusing the engine's `layerOps.ts`)
  and, for the selected layer, controls generated from its `ParamSchema` (number with min, max and step; colour; select;
  boolean; two-number vector). These map onto the panel's existing control kinds. The section also holds `start`, `calm`,
  and "Import scene JSON" / "Copy scene JSON", the same blob the leva Export writes, so a scene tuned on lumitra.co with
  `?tune=1` can be pasted in during the transition.
- **Canvas:** the editor shows several breakpoints side by side, so live WebGL in each would exceed Safari's 8 contexts.
  The canvas draws the box's CSS background and the children by default; a "Live" toggle in the FX section draws the
  scene in one breakpoint at a time (the selected one). Parameter changes apply live to that one context.
- **Preview** (`/preview`) behaves as the published page.
- **leva:** split out of `LumitraScene.tsx` into an optional editor entry, so the engine module no longer imports it. Sites
  never imports that entry. lumitra-web's frozen copy keeps its leva panel unchanged.

### Safety

- The registry is not reachable from stored data. A stored scene can only name the 15 built-in layer types; unknown types
  are dropped by the engine's loader. No author-supplied shader code exists, so the render gate stays intact.
- `image` layers load only from the site image route (`/site-images/...`, the site's own uploads). Any other address is
  refused at parse time with a message, and again at render time.
- `text` layers draw into a `CanvasTexture`; their string is length-clamped and is not HTML.
- Flash safety: clamps on animated luminance parameters so no full-screen luminance change exceeds three per second, as
  the 3D plan requires for its light presets.

### AI generator and agent plugin

- The FX node and its layer parameter ranges go into the generator's schema documents and validator
  (`validateGeneration`), with presets as the only templates the generator may start from; it may recolour and retune
  within ranges, never invent layer types.
- The agent plugin's site operations accept the node through the same validator, so an agent building the new lumitra.co
  can place the hero.

### The Studio bridge

Kept. `sceneConfigFromUnified` and the published `@marlinjai/studio-scene-core` dependency come along with the engine
(two of lumitra-web's own scenes use the bridge, and it costs one small published dependency). The dependency is updated to
the current 0.2.x as part of the import, with the equivalence test as the proof. Sites stores the plain FX format; the
bridge is an import path ("Import scene JSON" accepts both). Studio's ownership of scene-core is unchanged.

## Where the code lives

**`src/lib/fx/` inside framer-clone, as an internal module behind an import boundary.** framer-clone is a single app with
no pnpm workspace and no `packages/` folder; adding a workspace for one internal consumer would change the Docker build
for nothing. A lint guard (`scripts/check-guards.mjs`) enforces that `src/lib/fx/**` imports nothing from the rest of
`src/`, so the engine stays extractable. The rest of the app reaches it only through `src/lib/fx/index.ts`.

- **Copied, not history-merged.** Every framer-clone pull request is squash-merged, which would collapse an imported
  history into one commit anyway. F1 is a plain copy whose commit message names the lumitra-web source commit; the
  frozen lumitra-web repo stays the record of the engine's history.
- The private name `@lumitra-web/fx` disappears from Sites; imports are `@/lib/fx`. Nothing is published. The
  knowledge-base package naming standard's row for the engine is amended accordingly. (The `@marlinjai/lumitra-fx` name
  the 2026-06-07 plan proposed would also have broken that standard's own rules 4 and 5, no `lumitra` slug and no `-fx`
  role word; vendoring removes the question.)
- **lumitra-web's copy is frozen, not removed.** A notice at the top of its README points here. It stays exactly as it is,
  serving the lumitra.co hero, until lumitra.co moves. Fixes that lumitra.co needs before then go into Sites first and are
  copied back by hand; development of new layers happens only in Sites.

The alternative, a publishable workspace package, is the right shape only once a second app outside Sites needs the
engine. Today none does, and the project rule that Sites edits only sites it hosts
(no external frontends, 2026-11-01) means other sites gain FX by moving into Sites, not by installing a package.

## Slices

Each slice is one pull request, green alone. Sizes are judgement in agent days.

| # | Slice | What it builds | Depends on | Acceptance | Size |
|---|---|---|---|---|---|
| F1 | `fx-import` | Copy into `src/lib/fx/` (commit names the lumitra-web source commit), three.js and the react-three-fiber family added, leva split out of `LumitraScene.tsx`, drei reduced to the monitor, scene-core moved to 0.2.x, the import-boundary guard, FX's test running in framer-clone's Vitest | none | `pnpm typecheck`, `pnpm test`, `pnpm lint:guards` green; equivalence test passes; nothing in the app imports the engine yet, so the production bundle is unchanged (asserted) | 2 to 3 |
| F2 | `fx-format` | `src/lib/fx/format.ts` (parse, clamps, refusals with messages, the image address rule), `fx` denied as a DOM prop, the marker in both renderers' dispatch | F1 | Unit tests per clamp and refusal: unknown layer type, foreign image address, oversized text, too many layers, bad version | 2 |
| F3 | `fx-published-island` | `applyFx` pass, `FxIsland` with probe, `start` modes, `calm`, crossfade, fallback ladder, one-context rule, teardown, bundle test | F2 | Published tests `fx-no-bytes-without-fx`, `fx-no-webgl`, `fx-reduced-motion`, `fx-chunk-fails`, `fx-context-lost`, `fx-bundle-budget`; the published HTML of an FX page equals the same page without the island, apart from the island's own script; the island reads the scene through `readFxScene` again before it draws (the image rule a second time); a browser check that the fastest full-screen layers at the top of their ranges stay under three luminance flashes per second (added 2026-11-11, see the F2 log) | 3 to 4 |
| F4 | `fx-visual-oracle` | A local headless Chromium harness (SwiftShader WebGL) rendering one scene config twice, through lumitra-web's frozen copy and through Sites' `FxIsland`, at the reduced-motion static frame, which is deterministic, and diffing the pixels; fixtures: the hub hero, `godrays-hero`, `noise-gradient` | F3 | All three fixtures within 0.5 percent of pixels differing, per channel tolerance 2; added to the score as an "FX promises" row | 2 to 3 |
| F5 | `fx-panel` | Palette entry with presets, FX section (layer list, generated controls, `start`, `calm`, import and copy JSON), canvas static by default with the one-breakpoint Live toggle | F3 | Panel tests for each control kind; the four stateful paths (forward; changing a layer type resets that layer's parameters and keeps the others; reload restores; undo after delete restores the layer); no more than one WebGL context on the canvas, asserted | 4 to 5 |
| F6 | `fx-ai-and-agent` | Schema documents, validator rules, preset templates for the generator; the same validator in the agent plugin's site operations | F2, agent plugin site operations | A generated FX node from a preset survives `validateGeneration`; an invented layer type is dropped with a review note; an agent `set_node` with a foreign image address is refused | 2 |
| F7 | `fx-deploy-proof` | Deploy to app.lumitra.co and the browser proof below on a sites.lumitra.co test page | F3 to F6 | Evidence recorded in this plan: page opened, WebGL context count, chunk list for a page with and without FX, reduced-motion rendering, screenshots compared with lumitra.co | 1 |
| F8 | `fx-hub-hero-in-sites` | The lumitra.co hub hero rebuilt as an FX scene in the new lumitra.co site that the agent plugin plan builds (its step 6), published to a sites.lumitra.co address, compared with the live lumitra.co hero | F7, agent plugin step 6 | The F4 harness run against the two live addresses at the static frame within tolerance; a side by side recording of the animated hero on both | 1 to 2 |

Total about 17 to 24 agent days. F1 to F4 can run as one worker in sequence; F5 and F6 can run in parallel after F3.

## Retiring lumitra-web (decided 2026-11-08, option B)

lumitra-web serves ten pages today (checked 2026-11-08): the English hub `/`, `/terms`; the German `/de`, `/impressum`,
`/datenschutz`; the noindexed demos `/fx` and `/fx/gallery`; and on services.lumitra.co the pitch `/`, the offer ladder
`/angebot` and the ArboSano offer `/angebot/arbosano` (offer content typed in `src/lib/offers.ts`, 369 lines), plus
`/api/health`. Each moves into Sites or is dropped, then the app is switched off.

| # | Step | What it does | Depends on | Acceptance | Gate |
|---|---|---|---|---|---|
| R1 | `hub-in-sites` | The new lumitra.co site in Sites (the agent plugin plan's step 6) carries every hub page: `/`, `/terms`, `/de`, `/impressum`, `/datenschutz`, with the FX hero from F8, the same titles, descriptions, `lang` per page and the same addresses. `/fx` and `/fx/gallery` are dropped: the presets live in the Sites palette now | F8 | A page-by-page check of title, description, canonical address and visible text against the live lumitra.co, recorded in the build log | none |
| R2 | `services-in-sites` | A second Sites site for services.lumitra.co with `/`, `/angebot`, `/angebot/arbosano`, rebuilt from the current pages and `src/lib/offers.ts`, German, indexed, on a sites.lumitra.co address first. The open copy and booking items carried over from lumitra-web's roadmap (below) are done here, not in lumitra-web | Sites custom domains (live) | Same page-by-page check against live services.lumitra.co | Marlin's plain-German copy decisions, already his on lumitra-web's roadmap |
| R3 | `apex-cutover` | lumitra.co and www.lumitra.co move from the Coolify app `lumitra-web` to `framer-clone` as custom domains; `www` keeps its 301 to the apex | R1 | Browser proof on both hosts; search console sees no new 404s for a week | Marlin's yes (agent plugin plan) |
| R4 | `services-cutover` | services.lumitra.co moves the same way | R2 | Browser proof; no new 404s for a week | Marlin's yes, one line with rollback |
| R5 | `lumitra-web-off` | Stop the Coolify app `lumitra-web` (kept, not deleted), remove the `lumitra-web` health monitor, and archive the GitHub repo (read-only, restorable) | R3 and R4 held for 14 days | Both hosts still answer from framer-clone; the stopped app can be started again | One line with rollback, as a production change |
| R6 | `lumitra-web-removed` | Delete the stopped Coolify app and its images, remove `infra/deployments/lumitra-web` from Terraform, update the knowledge-base package naming row and the agent fleet's project list | R5 held for 30 days | `terraform plan` shows only the removal; nothing references lumitra-web | One line with rollback (the archived repo rebuilds the image) |

Carried over from lumitra-web's `ROADMAP.md` into R2 on 2026-11-08 (their home is now this plan and its roadmap line):

- The German Mittelstand-KI copy pass for services.lumitra.co: the package content (scope, deliverables, Ablauf, FAQ)
  wired into the offer pages, buyer-facing copy de-jargonized (no "Souveränität" as a headline word, no RAG, LLM or
  backend jargon), and the user interface audit's high-impact fixes (real proof of the live product, a redesigned
  guarantee, contrast, a real booking link). The old branch `feat/mittelstand-ki-positioning` (`d0ad640`) is source
  material only. Needs Marlin's plain-German copy decisions.
- Two human-sourced values before the booking and payment path works: the booking address (Lumitra Booking at
  booking.lumitra.co is the natural choice now that it exists) and a Stripe payment link for the 50 percent deposit on the
  consolidated Lumitra Stripe account.

Also carried by R1, owned elsewhere: the knowledge-base roadmap line on the hub's "Built by" portrait and the privacy
page's log-retention number (decided 2026-11-08, being worked by another session); the rebuilt pages take those values.

## Rollback

| Stage | What can go wrong | Rollback |
|---|---|---|
| F1 to F6 | A slice breaks the build or a published page | Revert the pull request. Nothing outside Sites depends on these slices; lumitra.co is served by lumitra-web throughout |
| F3 onward on published sites | The island misbehaves on a customer page | The box's CSS background and children are what the server sends, so removing `FxIsland` from `renderPublishedPage` (one line, a revert) returns every FX page to its static state without touching stored data |
| F8 | The Sites hero does not match | Nothing to roll back: the comparison runs on a sites.lumitra.co address while lumitra.co stays on lumitra-web |
| Apex cutover | lumitra.co misbehaves on Sites | Put `https://lumitra.co,https://www.lumitra.co` back on the `lumitra-web` Coolify app's domain list; that app stays deployed and healthy, with its frozen FX, until the cleanup step. DNS needs no change when both apps run on the same server; if a record does change, the previous one is noted in the cutover step |
| R2 | The services rebuild does not match | Nothing to roll back: it runs on a sites.lumitra.co address while services.lumitra.co stays on lumitra-web |
| R4 services cutover | services.lumitra.co misbehaves on Sites | Put `https://services.lumitra.co` back on the `lumitra-web` app's domain list; the app is still running |
| R5 app stopped | Something still needed lumitra-web | Start the stopped Coolify app and move the domain back; unarchive the repo |
| R6 removed | Needed after removal | Unarchive the repo, re-apply its Terraform, redeploy the image from the repo's last commit |

## Visual verification

1. **Data oracle:** the engine's own `unified.equivalence.test.ts`, carried over in F1.
2. **Pixel oracle:** the F4 harness. The reduced-motion path renders one static resolved frame: the layers pin their
   shader time to constants under `ctx.reduce` (`noiseFill.tsx` and `gradient.tsx` use 2.0, `shape.tsx` 0, checked
   2026-11-08). F4's first step confirms the post passes (grain in particular) are equally fixed and, where one reads
   the clock or a random seed, the harness injects a fixed one. lumitra-web and Sites rendering the same config must
   then produce the same pixels within a small tolerance (driver rounding). This is a real
   comparison, not an eyeballed screenshot. It runs locally and in CI with SwiftShader.
3. **Browser proof after deploy (F7, F8):** through the `dev-browser` skill on the automation profile: open the test page
   on a sites.lumitra.co address and lumitra.co side by side at desktop and phone widths, record the WebGL context count,
   the network chunk list with and without an FX node, the reduced-motion rendering (emulated), and screenshots of the
   settled hero. The evidence goes into this plan's build log.

## Dependencies

- **3D scene primitive** ([plan](2026-11-02-3d-scene-primitive.md)): shares the marked-div node pattern, the WebGL probe,
  the island shape and the one three.js version. Whichever lands first pins three.js; neither blocks the other.
- **Immutable published copy** ([plan](2026-11-01-immutable-published-copy.md), in progress): FX nodes are ordinary
  props, so they are frozen into a revision like any other node; no work beyond F2's parse on read.
- **Agent plugin** ([plan](2026-11-02-lumitra-sites-agent-plugin.md)): F6 uses its site operations; F8 is part of its
  dogfood step 6.
- **Motion effects** ([plan](2026-10-23-motion-effects.md), completed): an FX box can also carry an appear effect; the two
  islands do not interact.
- **Content Security Policy on published pages** (report-only today, review due 2026-11-09): the FX chunk is first-party
  script; WebGL needs no policy exception. Checked again in F7.
- **lumitra-studio:** none in the build. scene-core stays Studio's package; Sites consumes it from npm.

## Decided here, say so if you disagree

- **Home:** `src/lib/fx/` inside framer-clone behind an import boundary, a plain copy (squash merges would drop imported history), not a published package.
- **lumitra-web is untouched apart from a README notice** until the apex moves. lumitra.co and services.lumitra.co keep
  running exactly as today throughout F1 to F8.
- **Keep react-three-fiber;** no rewrite onto plain three.js. One three.js version shared with the 3D primitive.
- **leva does not ship in Sites;** the properties panel generates its controls from the engine's parameter schema.
- **Fallback is the box's own CSS background;** no required poster image, unlike the 3D primitive, because an FX scene is
  decorative (its meaning lives in the children). `calm: frame` is the option for a richer reduced-motion state.
- **One live FX context per published page, one per editor canvas** at version 1.
- **Name:** "FX scene" in the palette, "FX" in the panel, marker `data-fx`, prop `fx`. Never "Effects".
- **No author-supplied layers or shaders;** image layers only from the site's own uploads.
- **Keep the Studio bridge** and update scene-core to 0.2.x.
- **Pricing:** FX scenes are included in every plan until pricing is decided, by analogy with Marlin's answer on 3D
  quotas (D1, 2026-11-02).
- **Supersedes** D4 of the 2026-06-27 Studio surface plan and decision 5 of the 2026-06-07 composition plan for FX's
  home; amendment notes in both, and in the package naming standard.

## For Marlin to decide

**Answered by Marlin on 2026-11-08: option B,** rebuild services in Sites and retire lumitra-web. The question as asked:

- **What lumitra-web becomes once lumitra.co moves to Sites.** Option A: lumitra-web keeps serving services.lumitra.co
  alone; FX, the hub and the `/fx` demos are removed from it, and the services copy work on its roadmap continues there.
  Option B: the services page is rebuilt in Sites too (it is a German one-pager with an offer ladder, which Sites can
  express), and lumitra-web is retired. Option C: services.lumitra.co is dropped. Recommendation: B, once the apex has held
  on Sites, because it ends the second Next.js app, image and deploy pipeline for one page; but it depends on whether the
  agency pitch stays at all, which is his call.

Already his and already recorded elsewhere, not asked again here: the yes before lumitra.co points at Sites (agent plugin
plan, step 6).

## Build log

### 2026-11-11: Marlin approved the plan and the build started

Marlin asked for the migration to be built from this plan as written. Status moved from draft to in-progress.

### F1 `fx-import` (2026-11-11)

Source: lumitra-web `packages/fx/src` at commit `8a77254ee5d66f2c8b7e4005933290c6c0796393` (package `@lumitra-web/fx`
0.4.0), copied from the git object, into `src/lib/fx/`. The three scenes the tests need (`src/scenes/v7.json`,
`demo-phase-2.json`, `hub-hero.json`) came along as fixtures from the same commit.

What landed:

- The engine (15 layer types, registry, serializer, the Studio bridge, presets, `createScene`, `LumitraScene`) and its
  equivalence test, which passes in framer-clone's Vitest.
- Dependencies, pinned exactly to what lumitra-web resolves, so the F4 pixel comparison compares the same libraries:
  `three` 0.184.0, `@react-three/fiber` 9.6.1, `@react-three/postprocessing` 3.0.4, `postprocessing` 6.39.1,
  `@types/three` 0.184.1. **This is the app's one three.js version; the 3D scene primitive inherits it** (noted in that
  plan's bundle section).
- `@marlinjai/studio-scene-core` 0.3.0, the current release (the plan said 0.2.x, which was current on 2026-11-08). The
  equivalence test passes against it unchanged.
- Import boundary: rules FX1 and FX2 in `scripts/check-guards.mjs` (`pnpm lint:guards`), with their own tests in
  `src/lib/fx/__tests__/boundaryGuard.test.ts`. FX1: the engine imports nothing from the rest of the repository and
  only a fixed list of packages. FX2: the rest of the app imports the engine only through `@/lib/fx`.
- "The production bundle is unchanged", asserted twice: a test fails when any file outside the engine imports it
  (F3 replaces that test with the bundle tests), and a real `next build` on this slice contains no chunk with three.js,
  react-three-fiber or postprocessing in it (0 files under `.next/static` and `.next/server` match).

Decided in F1, say so if you disagree:

- **The leva tuning panel is left behind, not split into an optional entry.** The plan asked for an optional editor
  entry that Sites never imports. Such an entry would be code nothing runs, and it would put leva into `package.json`
  only so it typechecks. So `LevaEditor`, `EditorTools`, `LayerListPanel` and the localStorage autosave
  (`editor/persistence.ts`) were not copied; lumitra-web's frozen copy keeps them. `layerOps.ts`, the pure layer list
  operations F5 builds on, is kept and exported. The guard's package list keeps leva out for good.
- **`LumitraScene` is controlled.** With its own panel it held a private copy of the scene and treated the `config`
  prop as a seed. Without the panel it draws exactly the `config` it is handed and re-draws on a new one, which is what
  the F5 "Live" toggle needs. `createScene().setParam` now produces a new scene object for each change (it mutated in
  place, which the seed-only component never drew).
- **drei is replaced by a local frame rate sampler** (`frameRate.ts`, `FrameRateMonitor.tsx`, about 90 lines with
  tests), not imported by deep path: drei brings a large dependency tree for one component. It samples as drei's
  `PerformanceMonitor` did (250 millisecond windows, batches of ten, a floor of 40 frames per second, 60 on displays
  faster than 100 hertz) with one deliberate difference: drei also counted batches that were faster than the upper
  bound, and after four of them called its fallback, which the engine routed to the same step down. A machine holding
  its frame rate therefore lost its heavy passes (bloom, god rays) after about ten seconds. That is a defect in the
  lumitra-web copy too and was never the intent; here only a sustained low frame rate steps down, once. Read from
  drei 10.7.7's `core/PerformanceMonitor.js` (`flipped++` on incline, `flipped > flipflops` calls `onFallback`; the
  engine passed `flipflops={3}` and routed `onFallback` to the step down). lumitra-web's frozen copy keeps the defect:
  it is retired by R1 to R5, and a fix there is not worth a deploy of an app being switched off. Consequences for later
  slices: F4 compares the static reduced-motion frame but must still capture before the first batch of ten windows
  completes (2.5 seconds) or switch the monitor off on both sides, because software WebGL is slow enough to step both
  copies down at uncontrolled moments; and F8's animated side-by-side recording will show lumitra.co losing bloom after
  about ten seconds on a fast machine while Sites keeps it, which is the fix, not a mismatch.
- **No Dependabot rule needed for the pins:** `.github/dependabot.yml` covers only the Docker base image, so nothing
  bumps the WebGL packages automatically. A deliberate bump runs the F4 comparison once that exists.
- **The engine's allowed packages are a fixed list** in the guard (react, react-dom, three, the two react-three
  packages, postprocessing, scene-core, vitest for its tests). A new one is a decision, not a drive-by.

Checks run locally: `pnpm typecheck`, `pnpm lint`, `pnpm lint:guards`, `pnpm test`, `pnpm check:roadmap`, `pnpm build`.

Landed as pull request #365 on 2026-11-11.

### F2 `fx-format` (2026-11-11)

What it builds:

- **`src/lib/fx/format.ts`, the one reader of a stored scene.** `parseFx` reads the node's envelope
  (`{ version, scene, start, calm }`) and `parseFxScene` the scene. Both rebuild the scene field by field from the layer
  schemas: an unknown field is not carried over, a value outside its schema is clamped or replaced by the default, and
  each repair is returned as a note in plain words. Three things are refused with a message instead of repaired: a
  version this code does not read, more than 16 layers, and an image layer whose address the host does not allow.
- **The engine has a render-free half.** The 15 layer schemas (type, kind, label, default parameters with ranges) moved
  out of the three.js component files into `src/lib/fx/schemas.ts`; each component file spreads its schema, so the two
  cannot drift. The loader, the format, the layer list operations and the presets now work without React or three.js,
  and `@/lib/fx/format` is the engine's second public entry (rule FX2). An import graph test proves that entry reaches
  no package and no component file. The defaults of all 15 layer types were dumped before and after the move and are
  identical, apart from the image address below.
- **`src/lib/fxScene/fxScene.ts`, the node in Sites:** the marker (`data-fx="scene"`, on a `div` only), the prop
  (`fx`), `readFxScene` (the one way the app reads the prop) and the app's image rule.
- **`fx` is denied as a DOM prop** in both renderers, hidden from the Custom section together with the marker, and
  not settable as a loose prop through site operations (F6 adds the checked way in). A box whose scene is missing or
  refused is drawn as the plain box with its children; the published markup of an FX box equals the same box without
  the scene, apart from the marker (tested).

Decided in F2, say so if you disagree:

- **The image rule is passed into the engine, not copied into it.** Rule FX1 forbids the engine to import app code, so
  `parseFx` takes the host's rule as an option and refuses every address when none is given. Sites passes
  `isSiteImagePath`: exactly `/site-images/<sha256>.<ext>`, the site's own uploads.
- **The image layer's address is a text parameter, empty by default.** In lumitra-web it was a choice among that app's
  seven demo pictures (`/fx/thumbs/...`), files Sites does not have. No comparison fixture of F4 uses an image layer.
- **An image an FX scene shows counts as in use.** Saving a site checks that each one is stored for this site (the
  existing `SiteImageMissingError`), for scenes on pages and in reusable component definitions. The existing delete
  check already finds it: it searches the stored text of the settings, the definitions, every page, every kept
  revision and every branch for the path. So an image a scene shows cannot be deleted and another site's path is
  refused on save, both proven against a real database in `siteImages.itest.ts`. Uploading an
  image from the FX panel is F5's work; the upload limits (2 MB, 8000 pixels a side) are the resolution clamp the plan
  names.
- **`background`, `dpr`, `fps`, ids and names are rebuilt too.** The engine's loader passed `background` through as a
  string, and the scene writes it into CSS, where `url(...)` would have fetched any address. Only hex and numeric
  `rgb()`/`hsl()` colours pass; the pixel ratio stays inside 1 to 1.75; a fixed size is ignored (the box sizes the
  scene); ids are made unique.
- **Per-parameter `animate` is left out with a note.** The engine has the hook (`resolveAnimatedNumber`) but no layer
  calls it and no scene uses it, so storing it would promise motion that does not happen. **Flash safety** therefore
  rests on the layer parameters' own ranges, which the format now enforces (the engine's loader did not clamp): no
  stored value can drive a layer faster than its range allows. F3 checks the fastest full-screen layers against the
  three-per-second limit in a browser before a scene reaches a visitor.
- **A post pass names its source among the scene's content layers.** God rays read a content layer by id; the format
  offers the scene's content layers as the choices and moves a source that names none of them to the first. In the
  renderer, a pass whose source is hidden or missing is now left out on its own (`pipeline.ts`): before, it held the
  whole composer back, which switched off every other post pass for good.
- **Clamps do not change a real scene.** The hub hero, lumitra-web's two own scenes and the three presets read through
  the strict reader to exactly what the engine's loader gives, with no note (tested), so F4 compares like with like.
- **Custom `serialize` and `deserialize` hooks on a layer are removed.** No layer used them, and with no
  author-supplied layers nothing can.
- **The marker's names live apart from the reader** (`src/lib/fxScene/marker.ts`, which imports nothing). The
  renderers' prop gates, the bindings resolver and site operations need only the names, and some of that code reaches
  the client code of published pages; importing the reader there would have carried the layer schemas and presets onto
  pages without an FX scene.
- **Nothing is bound into a scene.** The bindings resolver skips the `fx` slot and every path under it, as it does for
  `behaviour`: a bound value would reach the scene without the format's check.
- **React import and detaching a component need no rule of their own.** Whatever puts an `fx` prop on a node, the
  only code that reads it is `readFxScene`, so an imported or detached node with a bad scene is a plain box.

Checks run locally: `pnpm typecheck`, `pnpm lint`, `pnpm lint:guards`, `pnpm test`, `pnpm test:render-gate`,
`pnpm test:behaviour`, the site images integration file against a real Postgres, `pnpm check:roadmap`, `pnpm build`
(still no three.js in any built file).
