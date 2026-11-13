---
type: plan
status: in-progress
date: 2026-11-13
title: "FX scene layers in the Layers panel: each layer of a scene is a row on the left, its settings alone on the right"
summary: "Marlin compared Unicorn Studio's effects editor with Lumitra Sites on 2026-11-12: in Unicorn every effect and text layer is a row in the left layer list and the right panel adapts to the one picked; in Sites the scene's layers are a list buried inside the FX section of the properties panel. This plan makes each layer of an FX scene a derived row under its box in the Layers panel (select, hide, rename, delete, duplicate, reorder by keys and menu), keeps which layer is picked in the editor store, and shows only that layer's settings on the right, grouped, with the text lockup's three lines first. No change to the stored format (fx version 1) and nothing a published page or the gold preset draws, so the FX owner's pixel comparison with lumitra.co is untouched. Three slices; the first is about 2 to 3 agent days. Three product questions for Marlin: free text layers instead of the three-line lockup, effects nested under one layer, and picking layers on the canvas."
tags: [framer-clone, lumitra-sites, fx, editor, layers-panel, properties-panel, unicorn-studio]
projects: [framer-clone]
---

# FX scene layers in the Layers panel

## Why (2026-11-12)

Marlin put Unicorn Studio's editor beside Lumitra Sites (screenshots of 2026-11-12 and 2026-11-13 in
`~/sharred screenshots/`). In Unicorn every layer of a scene, effects and text alike, is a row in the left layer list
(`2D SDF Shape`, `Chromatic abb.`, a text layer `IN FOCU` with a `Mini Blur` nested under it, `Paper Wind Tunnel`,
`Background`), and the right panel shows only the picked layer's settings, grouped (`Mix`, `Animation`,
`Interactivity`, for text `Text` with font, size, alignment, line height, letter spacing, fill, stroke). In Sites the
FX scene box (an `FX scene` row in the Layers panel) has no rows for its layers; they are a list of buttons inside the
FX section of the properties panel, below the preset, start, reduced motion and background controls, and the picked
layer's settings follow below that list. On the seven-layer scene in Marlin's screenshot of the new landing page the
god rays settings start below the fold of the panel. Marlin wants the scene's layers visible and selectable on the left, with the right panel
adapting to the picked one, and the text editable there. The screenshots are a visual reference, not a list of
features to copy.

This is a change to the editor of the decided [Lumitra FX plan](2026-11-08-lumitra-fx-in-sites.md), whose section
"The editor" puts the layer list in the properties panel. When this plan is decided, that sentence is amended to point
here, in the same pull request as the first slice.

## What exists today (read on origin/main at ea99bc2, 2026-11-13)

- **An FX scene is one site node,** a `div` marked `data-fx="scene"` with one prop `fx` =
  `{version: 1, scene, start, calm}` (`src/lib/fxScene/marker.ts`, `fxScene.ts`). `scene.layers` is a flat array of
  engine layers (`src/lib/fx/types.ts`: `id`, `type`, `name`, `visible`, `blend`, `params`, optional `interactivity`).
  The layers are not site nodes. The prop is the same in every breakpoint (the section reads `component.props.fx`).
- **The box's children are real HTML** drawn over the scene (headline, buttons). They are what search engines and
  screen readers read, and what a visitor sees without WebGL or with reduced motion.
- **Every edit goes through `src/lib/fxScene/edit.ts`**, which re-reads the scene through the strict reader before it
  is stored and returns notes or a refusal: `setFxParam`, `addFxLayer`, `removeFxLayer`, `moveFxLayer` (one step),
  `toggleFxLayer`, `renameFxLayer`, `setFxLayerBlend`, `setFxLayerType` (gives the layer a NEW id), `applyFxPreset`,
  `importFxScene`, `setFxStart`, `setFxCalm`, `setFxBackground`. Each stored change is one undo step
  (`component.setProps`).
- **The layer list and the generated controls** live in `src/components/sidebars/right/sections/FxSceneSection.tsx`
  (656 lines; its tests in `__tests__/FxSceneSection.test.tsx`, 38 by the FX owner's count, cover the four stateful paths). Which layer is picked
  is `useState` inside that section: lost when the section unmounts, and nothing else can point at a layer.
- **Render order** (`src/lib/fx/pipeline.ts`): content layers draw back to front in stored order; post effects run
  after ALL content, in their own stored order, wherever they sit in the array. Only god rays read another layer
  (`sourceLayerId`, a content layer).
- **The text layer** (`text`, label "Text Lockup") draws a fixed lockup of three lines (`eyebrowText`,
  `headlineText`, `taglineText`) into a canvas texture: fonts from a list of seven, weight, three sizes, one colour,
  width, height, reveal, parallax. It is pixels, not HTML, length-clamped (`FX_LIMITS.text`, 200 characters). Its three
  strings are already editable in the panel today, as ordinary text fields among its 14 settings.
- **Pointer settings** (`interactivity`: track mouse, momentum, spring, axes) are read and stored by the format but
  not shown in the panel.
- **The Layers panel** (`src/components/sidebars/left/LayersPanel.tsx`) renders the node tree per breakpoint. Rows are
  click targets, drag sources and drop targets (`data-inner-component-id`), with hide, lock, delete and a menu. It has
  no tree roles and no arrow-key navigation today. Its "Hide layer" (`canvasVisible`) hides a node on the editor canvas
  only (`HeadlessComponentRenderer.tsx` says so: the published render does not honour it); an FX layer's `visible` is
  stored and published.
- **Editor shortcuts** (`src/lib/keyBindings.ts`, `src/lib/canvas/deleteSelection.ts`): Delete and Backspace remove
  every selected node, Cmd+D duplicates, Escape clears the selection, Enter enters a component. With the FX box selected, Delete removes the box.
- **Live drawing** is one breakpoint at a time (`fxLive` in `EditorUIStore`); selecting the box in another breakpoint
  moves Live there.
- **Collaboration** (`src/lib/projects/liveSync.ts`) adopts another writer's whole document snapshot as one undo step,
  or holds it behind the "site changed" dialog when this tab has unsaved work. Nothing is merged per field.

## Target

### Rows

Under an FX scene box's row in the Layers panel, after the box's own HTML children, a group row **Scene** (sparkles
icon, foldable, folded state kept like any other row) holds one row per scene layer:

```
FX scene                      (the box: its HTML children first)
  Eyebrow                     (HTML child, as today)
  Headline
  Scene                       (group row: the scene itself)
    Effects                   (post effects, top = applied last)
      Lens / Chromatic ab.
      Bloom
      God Rays    reads Lockup
    Lockup                    (content layers, top = front)
    Noise Field
    Background  #08080b       (the scene background colour)
```

- **Front at the top,** as in Unicorn, Figma and Framer, and as the HTML children already read (they are in front of
  the scene). Content layers list front to back; post effects sit above them in a sub-group "Effects", because they
  apply to everything below whatever their place in the array. Moving a row never crosses between the two groups: the
  array position across groups changes nothing on screen, so allowing it would only mislead.
- **Background** is a pseudo-row for the scene's background colour (selecting it shows the colour and the reduced
  motion choice). It cannot be hidden, moved or deleted.
- The picked row is highlighted in the breakpoint whose frame is selected, as node rows are.
- Rows are visibly not HTML: the sparkles group, a kind icon per layer (text, noise, gradient, image, shape, effect),
  and the kind in muted text after the name. A god rays row says which layer it reads, and says "off: its layer is hidden" when that layer is hidden, because the
  renderer then leaves the pass out (`pipeline.ts`).
- A box whose `fx` cannot be read shows no Scene group; selecting the box leads to a preset, as today.
- The rows are derived from `props.fx.scene.layers` on every render. They are not nodes: not drag sources for the node
  tree, not drop targets, never resolved by the drop resolver (no `data-inner-component-id`).
- The mechanism is a small "derived rows" provider per marker type, so the 3D scene node (plan
  [3D scene primitive](2026-11-02-3d-scene-primitive.md)) can list its objects the same way later.

### Selection

- `EditorUIStore` gains `selectedFxLayer`, session state like `fxLive`: not saved, not in the undo history. It is
  `{componentId, kind: 'layer', layerId}` for a scene layer or `{componentId, kind: 'background'}` for the Background
  row, which has no scene layer id and is never subject to the layer-id check below. Keyed by node id plus layer id, never by element, because one node can be drawn many times.
- Picking a layer row selects the box as the primary selection (handles and the breadcrumb stay on the box) and sets
  `selectedFxLayer`. Picking the row in another breakpoint moves Live there, as picking the box does today.
- It is cleared when the selection moves to another node, page or project, and it is derived as invalid (falls back to
  the box) whenever a `'layer'` variant's layer id is not in the current scene (the Background variant stays valid while
  the box has a readable scene): after an undo of an add, a preset, an import, a remote
  adoption. `setFxLayerType` returns the new id; the selection follows it.
- Shift and Cmd click on a layer row pick that layer alone (multi-select of layers is not offered).

### The properties panel

- **Box selected, no layer picked:** the FX section shows the scene-level settings (preset, start, reduced motion) and
  a compact summary of the layers with a hint that they are in the Layers panel; each summary entry picks that layer.
  The normal box sections follow, as today.
- **Background picked:** the header reads "Background" with the same way back to the box, and the panel shows only the
  scene background colour and the reduced motion choice.
- **A layer picked:** the header reads the layer's name and kind, with a way back to the box ("FX scene" crumb). Only
  that layer's sections show: Layer (name, visible, blend, kind behind a confirmation because changing the kind resets
  its settings), then its settings grouped. Groups come from an optional `group` on each setting in
  `src/lib/fx/schemas.ts` (presentation only: the serializer writes values only, so the stored format and what any
  scene draws do not change). Settings without a group fall in one group, so a new layer kind still needs no panel
  change.
- **Text lockup picked:** the group "Text" comes first with the three lines as larger text fields (headline,
  eyebrow, tagline), then "Type" (fonts, weight, sizes, colour), "Layout" (width, height), "Motion" (reveal,
  parallax). With the lockup picked, Enter focuses the headline field (it takes precedence over the editor's "enter
  component" shortcut, which has no meaning on a scene layer); double-clicking the lockup row does the same. A hint under the group says
  the lockup is drawn as pixels and that the box's HTML headline is what search engines and screen readers read.
- **Pointer** group (track mouse, momentum, spring, axes), now shown, for the layer kinds whose component reads
  `interactivity` (to be listed from `src/lib/fx/layers/` in L2). It needs a new `setFxLayerInteractivity` in `edit.ts`;
  none exists today.
- The notes and refusals of an edit stay tied to the scene they were said about (an undo clears them), as today.

### Actions on a layer row

| Action | Row | Keyboard (row focused or layer picked) | Edit |
|---|---|---|---|
| Pick | click | Enter or Space on the focused row | none |
| Hide or show (published) | eye button, distinct tooltip "Hide in the scene", menu | none (Cmd+Shift+H is the browser's; `h` is the grab tool) | `toggleFxLayer` |
| Rename | double-click the name, menu | F2 | `renameFxLayer` |
| Delete | trash button, menu | Delete, Backspace | `removeFxLayer` |
| Duplicate | menu | Cmd+D | new `duplicateFxLayer` (copy with a new id, refused past 16 layers) |
| Move | menu "Bring forward / Send backward" | Alt+Up, Alt+Down | new `moveFxLayerTo` (index within its group) |
| Back to the box | crumb | Escape | none |

With a layer picked, **Delete, Cmd+D and Escape act on the layer, never on the box.** That is the one safety rule of
this plan: today Delete with the box selected removes the box, and a picked layer must not inherit that. Lock does not
apply (layers cannot be moved on the canvas) and is not shown. `moveFxLayerTo` and `duplicateFxLayer` are pure helpers
in `src/lib/fx/layerOps.ts` with wrappers in `src/lib/fxScene/edit.ts` (the engine imports nothing from the app; a
guard test enforces it). A refused change shows its reason and stores nothing.

Drag to reorder inside a group is slice L2: drag in this editor is verified by Marlin by hand, not by synthetic pointer
events, so it ships separately from the keyboard and menu paths.

### Undo, persistence, collaboration, responsive, accessibility

- **Undo:** every action is one stored change, so one undo step; a slider drag stays one step (`commitBatch`). Undo
  and redo never leave the picked layer pointing at nothing (falls back to the box).
- **Persistence:** none new. Layers, order, visibility and names are already in `fx`; the picked layer and fold state
  are session state.
- **Collaboration:** an adopted snapshot keeps the picked layer when its id survives, otherwise falls back to the box.
  A concurrent edit of the same scene behaves as any concurrent edit today (adopt, or the "site changed" dialog). No
  per-layer merge; that would be the multiplayer plan's work.
- **Responsive:** the scene is the same in every breakpoint, so its rows repeat under the box in each breakpoint's
  tree and an edit shows in all. On a phone (no hover) the picked row shows its actions, as node rows do.
- **Accessibility:** rows are buttons with full names ("God Rays, effect, reads Lockup"), `aria-current` on the picked
  row, labelled icon buttons, a polite live region announcing moves and refusals ("Bloom moved behind God Rays").
  Arrow-key navigation through the whole Layers panel (a proper tree) does not exist today; this plan does not claim
  it. It is a separate roadmap line for the whole panel, not built for FX rows alone.

## Slices

| Slice | What | Tests | Days |
|---|---|---|---|
| L1 `fx-layer-rows` | Derived Scene rows (front at top, Effects sub-group, Background pseudo-row), `selectedFxLayer` in the store with its fallbacks, the panel showing only the picked layer (existing generated controls, ungrouped), the scene-level FX section and summary, row actions by button, menu and keys (hide, rename, delete, duplicate, move), the shortcut routing, `moveFxLayerTo` and `duplicateFxLayer`. FxSceneSection's 38 tests move with the code; the score rows in `test/score/fx.panel.jsdom.score.tsx` are updated so the floor holds. | Unit: layerOps helpers (move within group, never across; duplicate id; limit). Store: pick, follow `setFxLayerType`, fallback after undo of add, preset, import, adoption, node and page change. Panel: picked layer only, notes cleared on undo. Layers panel: rows per breakpoint, no drop target, unreadable scene shows none. Shortcuts: Delete with a layer picked removes the layer and not the box (and undo restores both), Cmd+D, Escape. Four paths per the stateful-flow standard: forward, backtrack (rename then undo), resume (reload keeps the scene, picks nothing), re-entry (delete the picked layer, pick again). Hide and show: stored, published, one undo step; hiding god rays' source marks the god rays row off. Keyboard: Alt+Up and Alt+Down within a group and refused at its edge, F2 rename, Enter and Space pick, `aria-current` on the picked row, the live region announces a move and a refusal. Rows repeat in every breakpoint and the highlight follows the selected frame. Collaboration: an adopted snapshot keeps or drops the pick; with unsaved work and a layer picked, the "site changed" dialog, then "Load the newer version", leaves a valid pick or the box. Browser proof locally with dev-browser on the automation profile: pick each row of the hub hero scene, edit the headline, hide god rays, move bloom, undo all. | 2 to 3 |
| L2 `fx-layer-panel-polish` | Setting groups (optional `group` on schema settings, presentation only), the Text group first with larger fields and focus on Enter, the Pointer group, kind change behind a confirmation, drag reorder within a group (Marlin verifies by hand), colour or thumbnail hint per row. | Schema groups do not change serialized output (golden test on every preset, including gold-noise-gradient). The same golden test covers the generator's schema documents (`fxGenerationDocs` in `src/lib/fxScene/generation.ts`) and the score's panel probe (`test/score/fx.panel.jsdom.score.tsx`): unchanged, or changed on purpose and said so in the pull request. `validateGeneration` unchanged; pixel oracle unchanged. `setFxLayerInteractivity` goes through `parseFx` like every other edit; tests prove its values are held by the flash safety clamps in `src/lib/fx/format.ts` at the top of every range, and that reduced motion with calm `frame` still draws one still frame with pointer settings on (the FX owner's F8 comparison is taken at that frame). | 2 to 3 |
| L3 `fx-text-box` | A new layer kind `textBox` (design below). Engine and schema only; its controls come from the generated panel. | Oracle and gold preset unchanged; the reader clamps every new setting; generator documents and `validateGeneration` know the kind; a scene with a text box round-trips; reduced motion draws one still frame. | 1.5 to 2 |
| L4 `fx-scoped-effects` | Effects nested under one content layer (design below): engine first, then the rows and the "Applies to" control in the panel phase. | A scene without `target` draws pixel-identical (oracle, still frame); a target that is hidden, deleted or not content; the performance step down; limits. | 2 to 3 |
| L5 `fx-canvas-pick` | Picking a layer on the live canvas, its outline, and dragging a text box (design below). | Pick on hit, miss falls through to the box, Live off means no pick, undo of a drag, one WebGL context. | 1.5 to 2 |
## Decided by Marlin (2026-11-13)

Marlin approved this plan and the first slice L1 on 2026-11-13 (relayed by the coordinator, pane w2:p11). He also
decided all three open questions the other way from this plan's recommendation: **free-positioned text, effects nested
under individual layers, and picking layers on the canvas are in**, built in the same overnight run after L1, with a
design review and a code review per slice and model tiers routed by complexity. The direction is his; the production
gates stay: no deploy, no publish, no production write, no spending, no external message without his yes.

### L3: free-positioned text (`textBox`)

- A **new** layer kind `textBox` next to the existing `text` lockup, which is unchanged (the hub hero and the gold
  preset keep drawing exactly what they draw). Format version stays 1: a new kind is additive.
- Settings: `text` (string, up to `FX_LIMITS.text`, line breaks allowed), `font` (the existing `FONT_OPTIONS`),
  `weight`, `size`, `lineHeight`, `letterSpacing`, `align` (left, centre, right), `color`, `strokeColor`,
  `strokeWidth`, `position` (two numbers, the anchor point in the box, 0 to 1 each), `anchor` (nine points), `width`
  (share of the box, text wraps inside), `rotation`, `opacity`, plus `reveal` and `parallax` as the lockup has them.
- Drawn into a canvas texture like the lockup; it can be a god rays source like any content layer.
- It is pixels, like the lockup: the panel's Text group says the box's HTML is what search engines and screen readers
  read. The generator may use it only for decorative text, never for the page's real headline (its schema document
  says so).
- Conditions from the FX owner (2026-11-13), part of the slice: it is the 16th built-in kind, so `builtins.ts`, the
  generator's schema documents, `validateGeneration`, the FX plan's "Safety" section (says 15) and
  `test/score/data/fx-scenes.json` are updated together. Its strings fall under the `FX_LIMITS.text` clamp and are
  plain text drawn to a canvas texture, never HTML. Fonts stay the lockup's fixed system stacks (`FONT_STACKS` in
  `layers/text.tsx`); site fonts are not offered, because a canvas only draws a font the page has already loaded and the
  published page would show a fallback the editor does not. A publish check warns when a scene has text layers and the
  box has no HTML text children (scene text is gone without WebGL and under reduced motion with calm `background`).

### L4: effects nested under one layer

- An optional field `target` on a post layer: the id of a content layer. Absent means the whole scene, exactly as
  today. Format version stays 1; the reader keeps `target` only when it names a content layer of the scene and drops
  it otherwise with a note (as it does for god rays' source).
- Renderer: content layers with targeted effects are drawn to their own render target, run through their own effect
  chain in stored order, and composited back in their place; untargeted effects then run on the whole scene as today.
  A scene with no `target` takes the existing path unchanged, so the pixel oracle and the still frame cannot move.
- At most 4 targeted layers per scene (each costs a render target); the performance step down drops targeted chains
  of heavy effects first. A hidden target leaves its effects out, like a hidden god rays source.
- Layers panel: a targeted effect is a row nested under its layer (as in Unicorn); untargeted ones stay in Effects.
  The panel gains "Applies to" (whole scene or a content layer) through a new `setFxLayerTarget` in `edit.ts`.
  Moving a nested effect keeps it among its siblings.
- Conditions from the FX owner (2026-11-13), part of the slice: every edit that changes ids keeps `target` right
  (`removeFxLayer` of the targeted layer, `setFxLayerType` which gives a new id, `importFxScene`, `applyFxPreset`),
  as `sourceLayerId` is handled. The reader refuses a target that names a post layer or the effect itself, not only a
  dangling one. The cap on targeted groups is a new entry in `FX_LIMITS`, and their render targets are sized through
  `textureSize.ts` and the pixel ratio range (phones are the limit). Because `pipeline.ts` is on every scene's path,
  the still frame comparison runs for all four presets and the score scenes before and after, not only the gold
  preset. When the `pipeline.ts` change merges, the FX owner is told so it can rerun the lumitra.co proof rehearsal
  (`test/fx-proof`) on main.

### L5: picking on the canvas

- Only while Live is on, in its one breakpoint. A click on the box with the FX box or one of its layers selected
  asks the live scene which content layer is under the pointer (a raycast against the objects layers already
  register); a hit picks that layer, a miss leaves the box selected, a click on an HTML child selects that child as
  today. Effects are picked from the panel or by their nested row.
- The picked content layer gets an outline on the canvas (an HTML overlay sized from the layer's projected bounds,
  not a second WebGL context).
- A picked text box can be dragged on the canvas; the drag writes `position` through `setFxParam` as one undo step.
- With Live off nothing changes: the canvas shows the box and its children.
- Conditions from the FX owner (2026-11-13), part of the slice: the pick API is exported from an editor-only entry,
  never reaching the published island's bundle (`fx.spec.ts` measures it). `noiseFill` and `gradient` fill the whole
  frame, so only bounded layers (text, text box, image, shape) are pickable, else the click falls to the box. An HTML
  child of the box lying over a layer wins the click (the children are in front of the scene). Pointer coordinates
  map through the layout size, not the measured rectangle (the canvas is scaled by a CSS transform); tested at 60
  percent zoom. Picking exists only in the frame that holds the live context.

## Decided here, say so if you disagree

- Rows are derived from the stored scene, not new site nodes: no migration; the only format additions are the
  additive `textBox` kind and the optional `target` (L3, L4), and the agent operation `setFxScene` stays sufficient.
- Front at the top; post effects in their own sub-group; no move across groups.
- The picked layer is session state in `EditorUIStore`, keyed by node id and layer id.
- With a layer picked, Delete, Cmd+D and Escape act on the layer.
- Drag reorder ships in L2, after the keyboard and menu paths.
- Tree keyboard navigation for the whole Layers panel is a separate roadmap item, not part of this plan.
- Setting groups are presentation metadata in the schemas; they never reach the stored scene.

## Ownership and gates

- Orchestrator and reviewer: fx-layer-editor (Herdr pane w5:pR). The FX owner lumitra-fx-build-2 (w5:pE) keeps F7
  (the production proof) and F8 (the lumitra.co hero and its pixel comparison) and was told about the `textBox` kind
  and the `target` field before they are built.
- Kept stable for the FX owner: `fx` version 1, `SCENE_SCHEMA_VERSION` 1, every existing layer kind's settings and
  defaults, and what `gold-noise-gradient` draws. The F4 pixel oracle must stay green in every slice.
- Nothing here deploys, publishes or writes to production.
- Rollback: an editor or published image from before L3 and L4 drops `textBox` layers and treats a targeted effect
  as scene-wide, and its editor strips `target` on the next edit of such a scene (the writer stores only what it
  knows). After a rollback, one edit changes such scenes for good. A rollback past these slices is therefore checked
  for scenes that use them first.

### Worker map for the overnight run (2026-11-13, deadline 10:01 CET)

One owner per file at any time; each worker works in its own git worktree off `origin/main`. Builders run on the
`complex` routing tier (Sonnet); each slice's design note and its diff are reviewed by a fresh agent on the
`planning` tier (Opus) given only the diff and the repo's instructions, and every finding is fixed before the pull
request opens. Pull requests land through land-pr on green checks.

| Phase | Worker | Slice | Owns (files) | Starts |
|---|---|---|---|---|
| A | fx-l1-rows | L1 | `LayersPanel.tsx` and its tests, new `src/lib/layers/fxRows.ts`, `layerIcon.ts`, `EditorUIStore.ts`, `FxSceneSection.tsx` and its tests, `keyBindings.ts`, `deleteSelection.ts`, the editor key handler, `src/lib/fx/layerOps.ts`, `src/lib/fxScene/edit.ts`, `test/score/fx.panel.jsdom.score.tsx`, the FX plan's "The editor" sentence | now |
| A | fx-l3-textbox | L3 | new `src/lib/fx/layers/textBox.tsx`, `src/lib/fx/schemas.ts` (the new kind only), `builtins.ts`, `src/lib/fxScene/generation.ts`, the generator's schema documents | now |
| A | fx-l4-engine | L4 engine | `src/lib/fx/types.ts`, `format.ts`, `serialize.ts`, `pipeline.ts`, `LumitraScene.tsx`, `src/lib/fx/effects/` | now, design note reviewed before code |
| B | fx-l2-panel | L2 plus the L4 panel part | `FxSceneSection.tsx`, `LayersPanel.tsx`, `fxRows.ts`, `edit.ts`, `schemas.ts` (groups) | when L1, L3 and L4 engine have merged |
| C | fx-l5-pick | L5 | `src/components/fx/FxLayer.tsx`, `src/lib/fxScene/mount.tsx`, a new canvas overlay, the pick API in `LumitraScene.tsx` | when L4 engine and L1 have merged |

Checkpoints (CET): 01:30 phase A running; 02:30 L4 design note reviewed; about 04:30 L1 and L3 open and reviewed;
about 06:00 L4 engine open; phase B and C start as their inputs merge; 09:00 local browser proof on the automation
profile (dev-browser) of every landed slice on the hub hero scene; 09:30 report to the coordinator with what landed,
what is open and why.

## Build log

### 2026-11-13, overnight run (orchestrator fx-layer-editor, pane w5:pR)

- 01:05 CET: phase A started: fx-l1-rows (L1), fx-l3-textbox (L3), fx-l4-engine (L4 engine), builders on the
  `complex` tier. From 01:13 Marlin asked for staggered, targeted local checks only (Mac load 27 to 84); broad suites
  and the pixel oracle run in hosted continuous integration, and local runs wait for a 1-minute load under 24.
- L1 adds three names to the `layerOps` re-export block of `src/lib/fx/format.ts` (`duplicateLayer`, `moveLayerTo`,
  `placeInGroup`), the only hunk shared with L4, which edits other regions; whichever merges second rebases.
- L3 `textBox`: PR #424. The 16th built-in kind; it reuses the lockup's fixed font stacks (`fontStack` exported from
  `layers/text.tsx`, no pixel change). Two Opus review rounds fixed phone sizing, padding, line cuts, parallax under
  rotation, grapheme splits and redraw under reduced motion. The FX plan's "Safety" section still says 15 kinds; it is
  updated after L1 merges (L1 owns that file). Until L1's multi-line text field lands, editing a text box's text in the
  panel flattens its line breaks.
- L4 engine: design note v2 approved at 01:17 (`/tmp/fxlayers/l4-design.approved.md`), PR #425. One render channel
  and composer per targeted layer, composited back in place; reader rules in `src/lib/fx/targets.ts`. Scenes without a
  target: the four presets, v7 and demo-phase-2 drawn on main and on the branch differ in 0 pixels. The edit path
  (`edit.ts`: removing, retyping or importing must keep `target` right, god rays never source a targeted layer, the new
  `setFxLayerTarget`) is handed to phase B; until then only Import JSON can create a target.
- Found on main by L4 (`/tmp/fxlayers/fx-l4-engine/diag.txt`): adding and removing an untargeted effect while a scene
  is live leaks one texture and one framebuffer per cycle, because the main effect composer is never disposed. The
  editor's live canvas grows a little with every such edit; published pages build their scene once. Fixed in its own
  pull request after #425 merges (roadmap line), before phase C touches `LumitraScene.tsx`.
- 01:58 CET: #424 (`textBox`) merged as 085b3ef9. 02:10: #425 (L4 engine) merged as b7dbb2a0; the FX owner was told.
  Main's own runs on b7dbb2a0, 17ef1e41 and 4a02a33c were each cancelled by the next docs merge (verify, render-gate,
  docker-build and roadmap-check passed on 4a02a33c before the cancel). The FX owner's browser recheck of b7dbb2a0
  (`fx.spec.ts`, `fxOracle.spec.ts` with the lumitra.co proof rehearsals, `fxScoped.spec.ts`; production build,
  Chromium and WebKit): 116 of 116 passed; gold preset, the other presets, `test/fx-oracle` and `test/fx-proof`
  unchanged against the production commit b1e19a32.
- From 02:12 every local browser run, broad suite, build or pixel comparison goes through one queue across the Mac
  (`/tmp/heavy-run/heavy-run.sh`: one lock, waits for a 1-minute load under 24, never cancels another run), at
  Marlin's request; agreed by the FX workers, sites-branching, receipts and the two Booking sessions.
- L1: PR #426, held by the orchestrator from 01:47 until its review fixes were on the head (layer-only right panel,
  mounted key test, phone menus never mixing layer and box actions, refusals shown on the phone, header with the
  layer's name). Main merged into it so its checks ran on top of #424 and #425; the head 82becef8 is exactly the clean
  merge of the reviewed 2b157369 with b7dbb2a0, and all five checks passed on it. Hold lifted, merged as 84bff0b3.
- Composer leak: PR #429 by fx-l4-engine (also fixes the same flaw in #425's group cleanup under React strict mode);
  leak counter flat over six cycles, four presets 0 differing pixels.
- 02:40: phase B started (fx-l2-panel, pane w5:pX). Phase C (fx-l5-pick) starts when #429 has merged.
- The FX plan's "Safety" section now counts 16 built-in kinds.
