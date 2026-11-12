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

Landed as pull request #368 on 2026-11-11.

### F3 `fx-published-island` (2026-11-11)

What it builds:

- **`applyFx`** (`src/lib/renderer/server/applyFx.ts`), a pure pass in `renderPublishedPage` after `applyEffects`. Each
  FX box whose scene reads cleanly becomes an entry of the page's FX program (what the strict reader gives back, never
  the stored prop) and gets a mark, `data-fc-fx="<index>"`. `fx` leaves every node, refused scenes included, and the
  `data-fc-fx` names, which only this step may write, are dropped from every stored node.
- **`FxIsland`** (`src/lib/renderer/server/FxIsland.tsx`), rendered only on a page whose program is not empty. It
  imports no engine code. In order: one context per page, reduced motion, a WebGL probe, the start (`settled`,
  `visible`, `immediate`), then one dynamic import.
- **`src/lib/fxScene/mount.tsx`, the lazy chunk:** the engine with three.js and the scene reader. It reads the scene
  through the strict reader a second time on the client, puts a layer behind the box's content (first child, absolute,
  `z-index: -1` inside `isolation: isolate` on the box, no pointer, hidden from assistive technology), and fades it in
  over 300 milliseconds on the first drawn frame. On any failure the layer is taken out and the box is what the server
  sent.
- **What the island is doing is written on the box** as `data-fc-fx-state` (`waiting`, `loading`, `live`, `calm`,
  `off`). The tests wait on it instead of on timers, and F4's harness will too.
- **Engine:** `LumitraScene` gained `onFirstFrame` and `onFail` (no WebGL, a renderer error, a lost context), so a host
  can fade in and fall back; image layer textures are scaled to at most 2560 pixels on the longer side before they
  reach the GPU (the upload limit of 8000 pixels is not a GPU limit).

Found by the browser tests and fixed in the engine:

- **The "still frame" under reduced motion was not still.** Every layer pins its own clock, but the grain pass draws
  new noise on every frame: two screenshots 0.7 seconds apart differed in 52 percent of their pixels. The canvas now
  draws on demand under reduced motion (a frame when the scene or its size changes, never otherwise). lumitra-web never
  showed this because its hero does not mount under reduced motion. **For F4:** lumitra-web's frozen copy still animates
  its grain there, so the comparison must fix the grain on that side (the plan's "inject a fixed seed") or compare
  scenes without grain.
- **The scene re-rendered itself without end.** Content layers hand their object to the scene through an inline ref
  callback, which React calls again on every render; each call changed the registry, which re-rendered the scene,
  which called the refs again. It was invisible while every frame is drawn anyway, and showed as soon as frames were
  drawn on demand: about 150 frames a second on a scene that should draw none. A removal now waits one microtask and
  is dropped when the same layer registers again. A test counts drawn frames on a settled scene under reduced motion
  and requires zero. This defect is in lumitra-web's frozen copy too (it costs processor time on lumitra.co, nothing
  visible).
- **The canvas took the pointer.** react-three-fiber's canvas sets `pointer-events: auto` on itself, which overrode the
  layer's `none`: a click on the box landed on the canvas. The scene now sets `none` on the canvas (layers that follow
  the pointer listen on the window).

Decided in F3, say so if you disagree:

- **The first FX box in the document gets the page's one context.** Every other box stays calm and shows its own
  background, also when its calm state is `frame`: a still frame needs a context too.
- **`settled` is the `load` event plus 1.5 seconds**, as on lumitra.co, counted from now when `load` already fired
  before the island ran.
- **Leaving the page releases the context** (`pagehide`), a pending start is cancelled, and a page restored from the
  back/forward cache starts again (`pageshow`).
- **The bundle budget is 371,000 bytes on the wire for what a scene adds**, set from the first measurement plus 5
  percent as the plan says: about 353,000 bytes in 7 scripts (Next 15.5.28). The plan expected about 230,000. Where it goes:
  three.js about 189,000 (the engine imports it whole, `import * as THREE`), the react-three packages with their own
  reconciler about 113,000, postprocessing about 22,000, the engine and the scene reader about 29,000. The page's own
  scripts are byte for byte the same with and without a scene (254,177). Narrowing the three.js imports is the one
  lever that would lower it; it is not done here, because how much it saves is unmeasured and the plan sets the budget
  from the measurement.
- **Flash safety, measured, and one range narrowed.** Black and white scenes with every moving full-screen layer at
  the top of its range were read frame by frame, with the engine's clock stepped one sixtieth of a second per drawn
  frame, in Chromium and WebKit: a gradient at full speed with the hardest edges under each of the distortion's three
  kinds, from its coarsest density (one wave across the whole box, the largest area moving as one) to its finest. With
  the distortion's speed at lumitra-web's top value of 4, parts of the picture reached exactly three flashes a second,
  the most WCAG 2.3.1 allows. **The distortion's speed now tops out at 3**, which measures at most two flashes a second
  in any sixty-fourth of the box and none for the box as a whole. No existing scene uses the distortion, and a stored
  value above 3 is clamped with a note. Grain at full opacity keeps every sixty-fourth of the box within 0.11 of mid
  grey. The test stays in the suite, so a new layer or a wider range is held to the same limit.
- **`/preview` and the editor canvas** draw the plain box until F5, which owns the panel, the canvas "Live" toggle and
  the preview.
- **Naming, noticed:** the motion effects feature already uses `data-fx-a`, `data-fx-st`, `data-fx-p`, `data-fx-in`
  and `data-fx-on` on elements. The plan's marker `data-fx="scene"` does not collide with any of them (no selector or
  script reads a bare `data-fx`), so it is kept as decided.

Published tests (`test/behaviour/fx.spec.ts`, a real production build, Chromium and WebKit, 60 tests): the hub hero
draws with a real WebGL context; the scene shows over the box background and under content that is not positioned,
and takes no click; a box without a position still contains the layer; no byte of the engine on a page without a
scene; a refused scene is the plain box with no island; no WebGL; reduced motion with either calm state, including scenes with an intro (a text reveal, a focus pull) held at their end, and no frame drawn once settled; the engine
chunk failing; a lost context; two scenes on one page; `settled` and `visible` timing; put away and shown again; a
start cancelled before it ran; no JavaScript; the box's HTML equal to the same box without a scene apart from its two
marks; the bundle budget; flash safety.

For F4: `fx.spec.ts` reads its scenes from files inside the engine, and the guard does not scan `test/` yet. The F4
harness lives there too, so F4 extends the guard's roots and gives tests a public way to the fixtures.

Landed as pull request #369 on 2026-11-11. The unattended fixer of the merge driver added two things on CodeRabbit's
findings before it merged: an image layer asks for a frame when its picture arrives (under reduced motion the canvas
draws on demand), and the island runs again when the reduced motion preference changes on an open page. Both got
their browser tests in F4.

### F4 `fx-visual-oracle` (2026-11-11)

**Result: this app draws the lumitra.co hub hero, `godrays-hero` and `noise-gradient` pixel for pixel as the engine
does in lumitra-web.** In Chromium and in WebKit, 0 of 518,400 pixels differ at all (the plan allowed 0.5 percent
differing by more than 2 in a channel).

What it builds:

- **The reference:** `test/fx-oracle/lumitra-web-fx-8a77254.tar.gz`, the engine's source at the lumitra-web commit it
  was copied from (`git archive` of `packages/fx/src`, 50 KB, checksum checked before use). An archive and not a
  folder, so the frozen copy is never typechecked, linted or mistaken for this app's code. The test unpacks it,
  bundles it with esbuild and mounts it on a blank page.
- **`test/behaviour/fxOracle.spec.ts`** (18 tests, a real production build, both browsers): each scene drawn by the
  published page's island and by the reference, compared pixel by pixel. It can fail: each side reproduces itself
  exactly from a fresh page, one changed colour on either side is far over the tolerance, and the grain is really in
  the picture (it changes 46.5 percent of the pixels on both sides).
- **Score rows:** a new row kind "FX scene promises" with one row per reference scene
  (`test/score/fx.score.ts`, `test/score/data/fx-scenes.json`). Format and renderer pass and are held by the floor;
  canvas, panel and AI fail under the new gap `fx-scene` until F5 and F6.
- **The guard covers `test/`** for the two FX rules (not the tenant SQL rules): tests reach the engine through its
  public entries, with one exception, the engine's own test scenes.

Decided in F4, say so if you disagree:

- **Vendored, so it runs in CI.** framer-clone's CI cannot read the private lumitra-web repository, and a comparison
  that only runs on one machine protects nothing. The archive can be deleted with the test once lumitra.co runs on
  Sites and lumitra-web is retired.
- **leva and drei are replaced by stand-ins when the reference is bundled.** This app does not carry them; leva's
  panel is hidden without `?tune=1`, and drei's monitor would drop passes at moments no test controls. Neither draws a
  pixel. The reference runs on this app's React; lumitra.co itself, on its own Next and React, is F8's comparison.
- **The frame compared is the reduced motion frame with the page's clock stopped at zero.** Every layer pins its time
  there, and the one pass that reads a clock, the grain, is seeded with the time the composer has counted: with no
  time passing the seed is the same on both sides, so the grain is the same pattern, and still grain. This is the
  plan's "inject a fixed seed". It also makes the result independent of how many frames each side draws (the reference
  every frame, this app on demand). Animated frames are not compared; F8 records them side by side.

Found and fixed in the engine:

- **A scene without a post pass was drawn too dark.** The composer converts to the screen's colour space at its end; a
  layer drawn straight to the screen converted nothing. An uploaded picture of colour (30, 200, 90) came out as
  (3, 147, 26) with no post pass and correct with one. The four content shaders now convert at their end, which is the
  identity into the composer's buffer, so every scene with a post pass, all reference scenes among them, is drawn
  exactly as before (the oracle still reads 0 differing pixels). lumitra-web's copy has the defect; no scene it
  shipped is without a post pass.

Two regressions of this plan's own earlier slices, found in F4 and fixed here:

- **The prop name `fx` collided with a real attribute (from F2, on main for a few hours).** `fx` is also the focal
  point of an SVG `radialGradient`. F2 kept the name off every element, so published gradients lost that attribute.
  The project's score caught it: its run on main turned red after #369 (`svg-attribute:radialGradient.fx`, renderer),
  and the local run for this slice named the row. `fx` is now the scene prop everywhere except on a `radialGradient`,
  where it is the attribute (`isFxSceneProp`), on every path: both renderers, `applyFx`, bindings, the Custom section,
  site operations and their render gate, each with a test. The plan's prop name `fx` is kept. It never reached
  production: deploys are started by hand, and the last one (2026-11-09) is older than F2.
- **Layers that follow the pointer stopped following it (from F3).** F3 made the canvas take no pointer events, and
  the text parallax, the noise field and the distortion read the pointer from the canvas. They now read it from the
  window (`useWindowPointer`), as the layers with pointer settings always did. A browser test moves the mouse and
  measures the headline moving, and the box still gets the click.

Tests added for F3's late additions (`test/behaviour/fx.spec.ts`, now 70 tests): an image layer draws a picture really
uploaded to the site, fetched once from the site's own image route, in its own colours with and without a post pass,
and under reduced motion; a scene follows the reduced motion preference when it changes on an open page, in both calm
states.


### F5 `fx-panel` (2026-11-12)

The editor: an FX scene can be dropped from the palette, edited in the properties panel, drawn live on the canvas and
previewed as it will be published.

- **The hub hero is the engine's first preset.** `src/lib/fx/presets/preset-gold-noise-gradient.json` is lumitra.co's
  hero scene, so the guard's exception for test fixtures is gone, and the palette entry "FX scene"
  (`src/lib/componentRegistry.ts`) starts from it, over lumitra.co's own painted background as the box background.
  The entry carries `generation: false`: the generator is not taught the box until F6.
- **One implementation of every change** (`src/lib/fxScene/edit.ts`): each change is a pure function from the stored
  prop to the next one, and its result passes the strict reader again before it is stored. The panel uses it now; F6's
  generator and the agent's site operations will use the same functions.
- **The FX section** (`src/components/sidebars/right/sections/FxSceneSection.tsx`): presets, `start`, `calm`, the scene
  background, the layer list (add, remove, reorder, show or hide, rename, change kind, blend), one control per setting
  generated from the layer's schema (number, colour, choice, switch, text, pair of numbers), a picture upload for an
  image layer (a new upload kind `scene`; never a typed address), "Copy scene JSON" and "Import scene JSON" (the
  engine's own format, and Lumitra Studio's through the bridge, loaded only then). What the reader repaired is shown;
  a change it refuses is shown as an error and stores nothing.
- **Canvas "Live"** (`src/components/fx/FxLayer.tsx`, state in `EditorUIStore.fxLive`): off by default, so every
  breakpoint frame shows the box with its own background. On, the scene is drawn for that box in ONE frame, the one the
  box is picked in, and follows the box when it is picked in another. Every change in the panel is drawn in the same
  WebGL context (`renderFxScene(...).update` in `src/lib/fxScene/mount.tsx`). What the scene is doing, and why it is
  not drawn (no WebGL, a lost context, a refused scene, the engine not loading), shows under the switch with the way on.
- **Preview** behaves as the published page because it runs the same steps: the island's start logic moved to
  `src/lib/fxScene/start.ts` (reduced motion, the WebGL probe, `settled` / `visible` / `immediate`), and both the
  island and the preview's layer call it. One scene per preview frame, a second one stays calm.
- **Pictures in the editor** are fetched from the editor's own image address (behind sign-in), resolved after the
  strict read, which keeps accepting site paths only. Site settings counts a scene's pictures as in use, saved or not,
  so "Uploaded images" never offers one for deletion.

Decided in F5, say so if you disagree:

- **The layer is a React child of the box in the editor, not inserted by hand as on the published page.** The canvas
  re-renders a box on every edit, and React replaces the whole content of a box that holds only text; a layer put
  there behind React's back would be wiped with its WebGL context left running. The published page never re-renders,
  so its island keeps inserting the layer itself. Both use one description of how the layer sits in the box
  (`src/lib/fxScene/box.ts`).
- **The one context belongs to a rendered element, not to a node.** One node can be drawn many times in a frame (a
  repeated child, a component placed twice). The first element to ask holds the claim (`src/lib/fxScene/claim.ts`);
  when it goes away another takes over.
- **Live stands down in two situations:** while the box's own text is being typed (the text box replaces the box's
  content), and under the preview over the editor, which draws the scene itself. It comes back by itself.
- **On the canvas the scene starts at once**, whatever its `start` setting says: the person asked for it. The preview
  honours `start`.
- **The canvas is sized from its layout size in the editor** (`layoutSize` on `LumitraScene`), because the editor's
  canvas is scaled by a CSS transform and react-three-fiber measures the scaled rectangle by default: at 60 percent
  zoom the drawing would have been scaled twice. Checked in a browser at 60 percent: the drawing fills the box.
  The published page keeps the default measure, so the pixel comparison of F4 is untouched.
- **Live is session state:** never saved, never in undo history, off when another project opens.
- **The presets are offered in the panel, not as separate palette entries.** The plan put them in the insert palette.
  The palette has one entry, "FX scene", which starts as the lumitra.co hero, and "Replace with a preset" is the first
  control of its section: four more palette tiles for one kind of box would crowd the palette, and a preset can be
  changed later only from the panel anyway.
- **In the preview the first scene holds the frame's one slot even when it is not drawn** (reduced motion with the
  background as calm state, or no WebGL), exactly as the published island gives the page's slot to the first box. A
  second scene is never drawn in its place.

Found by the tests and fixed:

- **JSON that was neither format replaced the scene with an empty one.** The Studio bridge reads any object as a scene
  without layers, so pasting `{"hello":"world"}` into Import silently emptied the scene. Import now takes the bridge
  only for a value that has `root.children`, and refuses everything else with the reason.
- **A note or a refusal stayed on screen after an undo.** Both are now kept with the scene they were said about.
- **An upload in the demo project** (which no server holds) failed with a server error. It now says to choose "Keep as
  project" first.
- **A set-up that threw after the engine arrived left the box at `loading`** with an unhandled rejection, on the
  published page too. One handler now covers it and the chunk that does not arrive.
- **A registry render test had been failing since the palette entry** (`savedPagesRender.test.ts` took the stored scene
  for a dropped attribute).
- **A race in three published FX tests**, seen in CI on another pull request (WebKit, "start settled": `expected null
  to be 'waiting'`): they read the island's state once at the `load` event, before hydration had written it. They now
  wait for it. Landed on its own as #375.

Tests:

- `src/components/sidebars/right/__tests__/FxSceneSection.test.tsx` (38): one per kind of control, the layer list, the
  upload, copy and import, the Live switch with each reason, and the four stateful paths: forward; another kind resets
  that layer's settings and keeps every other layer, and the same kind keeps them; a reload restores the scene; undo
  after a removal restores the layer, another box starts clean, and a box whose scene cannot be read leads to a preset.
- `src/lib/fxScene/__tests__/edit.test.ts`, `mount.test.tsx` (18), `src/components/fx/__tests__/FxLayer.test.tsx` (15).
- `src/app/site-images/__tests__/siteImages.itest.ts`: the real upload route stores a picture sent with `kind=scene`
  (what the panel posts), of any shape without warnings, and refuses an icon file for it.
- `test/behaviour/fxCanvas.spec.ts` (18, Chromium and WebKit, the real EditorApp): **no more than one WebGL context**,
  counted in the page where contexts are made: nothing drawn by default, Live draws one box in one frame, five changes
  of the scene keep the same context, the frame and the box can be switched, the preview over the editor takes the
  context and gives it back, Live off releases it, a lost context and a refused scene are reported.
- `test/behaviour/fx.spec.ts` (72): the page without a scene also fetches no layer schema and no preset (the palette
  now imports the presets, so this is checked on the real build).
- Score: the FX rows now pass the canvas and the panel columns (`test/score/fx.canvas.score.ts`,
  `fx.panel.jsdom.score.tsx`); the generator column fails under the gap `fx-scene` until F6.

Seen in a real browser (headless Chrome on the automation profile, the local dev server, the demo editor, 2026-11-12):
an FX scene box added; its section first in the panel with the five layers of the hub hero; Live on: one canvas of
1248 by 480 pixels in the Desktop frame, state `live`; at 60 percent zoom the canvas rectangle equals the box
(749 by 288) with the same drawing buffer; two gradient colours changed to red and the drawing turned red without a
new context; the box picked in the Tablet frame and the scene moved there, still one canvas; the preview opened with
Live on: the canvas scene gone, the preview scene `waiting` and then `live` after 1.6 seconds (the `settled` start),
one canvas; preview closed and the canvas scene back; Live off: no canvas, the boxes as before.

### F6 `fx-ai-and-agent` (2026-11-12)

The page generator and an agent's site operations can write an FX scene, through one reader.

- **`src/lib/fxScene/generation.ts`, `readGeneratedFx`:** the one function that reads what is written under `fx` on an
  FX scene box. It reads two forms. The **preset form** is the only one that is taught: `{ preset, start?, calm?,
  background?, layers?: [{ id, visible?, params? }] }`, a preset recoloured and retuned inside each setting's range. It
  cannot gain a layer: an entry that names no layer of the preset is left out with a note, an invented kind of layer
  included, and a picture address is never written. The **stored form** (`{ version, scene, start, calm }`) is what a
  box already holds; it goes through the strict reader exactly as a stored page does. Every change is made with the
  functions of `edit.ts`, the ones the panel uses.
- **The generator** (`validateGeneration`): the palette entry `fxScene` is a preset the model may name, and a box sent
  back with its marker and its stored scene is read too (the model is shown the nodes it replaces, scene included, so a
  regeneration keeps a hand-tuned scene). What was repaired or left out is a review note. An unknown preset falls back
  to the default scene; a returned scene the reader refuses leaves a plain box with its content. The box's own CSS
  background follows the preset unless the model set one.
- **One scene per page:** a generation keeps its first FX scene in document order and any other as a plain box, and
  none when the page already holds one outside what is replaced (`pageHasFxScene`, sent by the editor and by site
  operations).
- **What is taught** (`fxGenerationDocs`, part of the generation format the generator's prompt and
  `describe_vocabulary` both carry): the four presets, each layer with every setting's range and the preset's value,
  built from the engine's own presets and schemas, the same text on every run. The stored scene itself is never
  printed into a prompt: the registry entry is listed without it.
- **Site operations:** `insertNodes` places an FX scene through the generator's validator, as it places everything.
  A new operation `setFxScene { nodeId, fx }` replaces the scene of an existing FX scene box, in either form.
  `setProps` keeps refusing `fx` and the marker and now points to `setFxScene`. `getPage` shows a box's stored scene
  whole, so an agent can read it, change it and send it back.
- **Score:** the generator column of the three FX rows passes (`test/score/fx.score.ts`): written from its preset the
  scene is the reference scene exactly, one retuned setting changes only that setting, an invented layer is left out
  with a note.

Decided in F6, say so if you disagree:

- **A generator repairs, an agent is refused.** The generator keeps a scene with review notes. A site operation
  refuses on any note: the site operations promise that nothing is dropped silently, so an agent never gets a scene
  other than the one it wrote.
- **Both forms are accepted from both.** The plan says the generator starts from presets only. It is taught only the
  preset form, but a stored scene must be accepted back, or a regeneration next to an existing FX box would replace a
  hand-tuned scene with a default. An agent needs the stored form to place a scene tuned elsewhere, such as the
  lumitra.co hero in F8. The strict reader is the safety line for both.
- **A text layer never shows the engine's sample words.** Two presets draw text ("Introducing", "Lumitra"). In the
  preset form the words come from whoever writes the scene: text that is not given is left empty, and a text layer
  given no text at all is hidden, with a note.
- **A wrong kind of value keeps the preset's value.** The strict reader answers one with the layer kind's own default,
  which is right for a stored page and would have turned a preset's bloom of 0.35 into 0 here.
- **The fonts of a text layer are not taught.** The engine's list holds typefaces the page generator is told not to
  use. The preset's font stays.
- **No picture through the generator.** No preset holds an image layer, and the preset form cannot add one. An agent
  can send a stored scene with a picture, which must be one of the site's own uploads; agents have no upload yet, so
  that picture has to be uploaded in the editor first.
- **Site operations have no undo of their own.** A batch is all or nothing, and a refused scene writes nothing; going
  back is the site's revisions, as for every other operation.

Found by the tests and fixed:

- **An agent was told "the operation failed unexpectedly"** when the save refused a scene's picture that the site does
  not store (a path of the right shape, so the reader accepts it). The write was refused correctly, but the reason was
  swallowed. Every content refusal of the save (status 422) now reaches the agent with its reason.
- **A setting given the wrong kind of value silently lost the preset's value** (see above).
- Two presets' descriptions were engine shorthand ("v7 lockup...", "Phase 3 depth showcase..."); they now say what
  the scene looks like, since the generator and the panel both show them.

Tests:

- `src/lib/fxScene/__tests__/generation.test.ts` (23): both forms; unknown preset, invented layer by id and by kind,
  unknown setting, wrong kind, out of range, a colour that is none, bad `start`, `calm`, `background` and `layers`;
  the text rule; a foreign, an editor-only and a script address refused; every documented setting accepted at the end
  of its range.
- `src/lib/ai/pageGen/__tests__/validateFxScene.test.ts` (17): **a generated FX node from a preset survives
  `validateGeneration`**; **an invented layer type is dropped with a review note**; the marker or a scene on a node
  that is no FX box makes none; an SVG `radialGradient` keeps its `fx`; a scene sent back is kept exactly; one scene
  per page; nothing of a stored scene in the prompts.
- `src/lib/siteOps/__tests__/applyOps.test.ts` (the real operations engine): `insertNodes` places a scene with
  nothing repaired; six kinds of wrong scene each refuse with the reason and write nothing; a second scene on a page
  is refused; `setFxScene` in both forms; **a foreign image address is refused**, as are the editor's own image
  address, an unknown layer kind and an unknown version; a refused scene takes its whole batch with it.
- `src/server/siteOps/__tests__/siteOps.itest.ts` (real Postgres): an agent places a scene, reads it back, retunes
  it; a picture the site does not store is refused when the batch commits, with the reason and the version unchanged.

The plan's check names an agent `set_node`; there is no operation of that name. The same check runs against
`setFxScene` and `insertNodes`, the two operations that can carry a scene.

### F7 and F8, prepared offline (2026-11-12)

Nothing here touches production. It is what could be made ready without a deploy, so that the proof after one is a
single run with a known procedure.

- **`test/fx-proof/proof.ts`, `collectFxProof`:** for one address, in a fresh browser context, everything F7 asks to be
  recorded: the state of every FX box, the WebGL contexts the page holds (counted where contexts are made, installed
  before the page loads), every script file fetched with its size as text and as sent, which of them carry the engine
  or the scene format, Content Security Policy violations, console errors and FX warnings. `problemsOfDrawnScene` and
  `problemsOfNoScene` say whether a reading is what it must be.
- **`compareFxAddresses`:** F8's comparison. The scene at two addresses at the still frame (reduced motion asked for,
  the clock stopped before the page loads), everything on the page hidden but the canvas, the two pictures compared
  with the oracle's own tolerance. It refuses two canvases of different sizes, because then nothing can be compared.
- **`test/fx-proof/run.ts`, the command:** `pnpm tsx test/fx-proof/run.ts --fx <address with a scene> --plain <address
  without one> [--compare <address>]`. Chromium and WebKit, a desktop and a phone width, with and without reduced
  motion: 16 readings, and with `--compare` four comparisons with their pictures. It only reads pages. Exit code 0
  means every reading is as it must be.
- **Rehearsed on a real production build** inside the two existing FX browser specs (no new spec): the collector on
  pages with a scene, without one, with two, under reduced motion in both calm states, and on four wrong pages that it
  must name; the comparison on the same scene at two addresses (0 pixels differ), under content that covers it (still
  0), on a changed scene (over the tolerance) and on a box of another size (refused); and the command itself, run as it
  will be run, in both engines.

Decided here, say so if you disagree:

- **The proof runs as a Playwright command, not through the `dev-browser` skill** as the plan's "Visual verification"
  says. It needs a script installed before the page loads (the context counter and the stopped clock), reduced motion
  emulated, and two browser engines, and a published page needs no sign-in. `dev-browser` stays the tool for looking
  at the page beside lumitra.co and for the side by side recording of F8.

Found by rehearsing, fixed: run through `tsx`, the functions handed to the page are compiled with a helper that does
not exist in a page, so the counter was never installed and every reading failed. Reading the code did not show it;
running the command did.

**The procedure after a deploy** (each numbered step that writes to production is named to Marlin first):

1. The deploy itself, with its gates, as recorded above under "What a deploy of main would ship". Not this slice's to
   start.
2. **Production write:** a test site on a `sites.lumitra.co` address with two pages: one with an FX scene box (the
   default preset, a heading over it) and one without. Built through the agent endpoint with the company key
   (`insertNodes` with preset `fxScene`), or in the editor.
3. **Production write, needs a person's approval** (agent plugin plan, decision 6): publishing that test site.
4. Read only: `pnpm tsx test/fx-proof/run.ts --fx <the page with the scene> --plain <the page without>`. The readings
   go into this log: context count, the chunk list with and without a scene, the engine's size as sent, reduced motion,
   Content Security Policy violations.
5. Read only: the page looked at beside lumitra.co at a desktop and a phone width through `dev-browser`, screenshots
   into this log.
6. F8, once the FX hero is in the new lumitra.co site (the dogfood work's draft, with its owner): the same command with
   `--compare https://lumitra.co/` at a window width where both hero boxes have the same size.

What stays unknown until then, and cannot be learned offline:

- **Whether live lumitra.co matches.** F4 compared this app with the engine's source as lumitra-web runs it, with the
  tuning panel and the frame rate monitor replaced by stand-ins. lumitra.co runs the real ones, on its own React and
  Next versions.
- **Whether lumitra.co draws the still frame at all under reduced motion,** which the comparison needs. If it shows
  its painted background instead, F8's pixel comparison has nothing to read there and the side by side recording is
  the evidence.
- **The production Content Security Policy** (report-only today) and the sizes as the production server compresses
  them. The rehearsal ran on a local production build.

