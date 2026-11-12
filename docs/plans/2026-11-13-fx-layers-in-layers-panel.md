---
type: plan
status: draft
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
layer's settings follow below that list. On the lumitra.co hero scene (seven layers) the god rays settings start below
the fold of the panel. Marlin wants the scene's layers visible and selectable on the left, with the right panel
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
  (656 lines, 38 tests in `__tests__/FxSceneSection.test.tsx` covering the four stateful paths). Which layer is picked
  is `useState` inside that section: lost when the section unmounts, and nothing else can point at a layer.
- **Render order** (`src/lib/fx/pipeline.ts`): content layers draw back to front in stored order; post effects run
  after ALL content, in their own stored order, wherever they sit in the array. Only god rays read another layer
  (`sourceLayerId`, a content layer).
- **The text layer** (`text`, label "Text Lockup") draws a fixed lockup of three lines (`eyebrowText`,
  `headlineText`, `taglineText`) into a canvas texture: fonts from a list of seven, weight, three sizes, one colour,
  width, height, reveal, parallax. It is pixels, not HTML, length-clamped (`FX_LIMITS.text`, 200 characters). Its three
  strings are already editable in the panel today, as ordinary text fields among its 17 settings.
- **Pointer settings** (`interactivity`: track mouse, momentum, spring, axes) are read and stored by the format but
  not shown in the panel.
- **The Layers panel** (`src/components/sidebars/left/LayersPanel.tsx`) renders the node tree per breakpoint. Rows are
  click targets, drag sources and drop targets (`data-inner-component-id`), with hide, lock, delete and a menu. It has
  no tree roles and no arrow-key navigation today. Its "Hide layer" (`canvasVisible`) hides a node on the editor canvas
  only; an FX layer's `visible` is stored and published.
- **Editor shortcuts** (`src/lib/keyBindings.ts`, `src/lib/canvas/deleteSelection.ts`): Delete and Backspace remove
  every selected node, Cmd+D duplicates, Escape clears the selection. With the FX box selected, Delete removes the box.
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
- Rows are visibly not HTML: the sparkles group, a kind icon per layer (text, noise, gradient, image, shape, effect),
  and the kind in muted text after the name. A god rays row says which layer it reads.
- A box whose `fx` cannot be read shows no Scene group; selecting the box leads to a preset, as today.
- The rows are derived from `props.fx.scene.layers` on every render. They are not nodes: not drag sources for the node
  tree, not drop targets, never resolved by the drop resolver (no `data-inner-component-id`).
- The mechanism is a small "derived rows" provider per marker type, so the 3D scene node (plan
  [3D scene primitive](2026-11-02-3d-scene-primitive.md), owner w5:pG) can list its objects the same way later.

### Selection

- `EditorUIStore` gains `selectedFxLayer: {componentId, layerId} | undefined`, session state like `fxLive`: not saved,
  not in the undo history. Keyed by node id plus layer id, never by element, because one node can be drawn many times.
- Picking a layer row selects the box as the primary selection (handles and the breadcrumb stay on the box) and sets
  `selectedFxLayer`. Picking the row in another breakpoint moves Live there, as picking the box does today.
- It is cleared when the selection moves to another node, page or project, and it is derived as invalid (falls back to
  the box) whenever its layer id is not in the current scene: after an undo of an add, a preset, an import, a remote
  adoption. `setFxLayerType` returns the new id; the selection follows it.
- Shift and Cmd click on a layer row pick that layer alone (multi-select of layers is not offered).

### The properties panel

- **Box selected, no layer picked:** the FX section shows the scene-level settings (preset, start, reduced motion) and
  a compact summary of the layers with a hint that they are in the Layers panel; each summary entry picks that layer.
  The normal box sections follow, as today.
- **A layer picked:** the header reads the layer's name and kind, with a way back to the box ("FX scene" crumb). Only
  that layer's sections show: Layer (name, visible, blend, kind behind a confirmation because changing the kind resets
  its settings), then its settings grouped. Groups come from an optional `group` on each setting in
  `src/lib/fx/schemas.ts` (presentation only: the serializer writes values only, so the stored format and what any
  scene draws do not change). Settings without a group fall in one group, so a new layer kind still needs no panel
  change.
- **Text lockup picked:** the group "Text" comes first with the three lines as larger text fields (headline,
  eyebrow, tagline), then "Type" (fonts, weight, sizes, colour), "Layout" (width, height), "Motion" (reveal,
  parallax). Pressing Enter or double-clicking the lockup row focuses the headline field. A hint under the group says
  the lockup is drawn as pixels and that the box's HTML headline is what search engines and screen readers read.
- **Pointer** group for content layers with `interactivity` (track mouse, momentum, spring, axes), now shown.
- The notes and refusals of an edit stay tied to the scene they were said about (an undo clears them), as today.

### Actions on a layer row

| Action | Row | Keyboard (row focused or layer picked) | Edit |
|---|---|---|---|
| Pick | click | Enter or Space on the row | none |
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
| L1 `fx-layer-rows` | Derived Scene rows (front at top, Effects sub-group, Background pseudo-row), `selectedFxLayer` in the store with its fallbacks, the panel showing only the picked layer (existing generated controls, ungrouped), the scene-level FX section and summary, row actions by button, menu and keys (hide, rename, delete, duplicate, move), the shortcut routing, `moveFxLayerTo` and `duplicateFxLayer`. FxSceneSection's 38 tests move with the code; the score rows in `test/score/fx.panel.jsdom.score.tsx` are updated so the floor holds. | Unit: layerOps helpers (move within group, never across; duplicate id; limit). Store: pick, follow `setFxLayerType`, fallback after undo of add, preset, import, adoption, node and page change. Panel: picked layer only, notes cleared on undo. Layers panel: rows per breakpoint, no drop target, unreadable scene shows none. Shortcuts: Delete with a layer picked removes the layer and not the box (and undo restores both), Cmd+D, Escape. Four paths per the stateful-flow standard: forward, backtrack (rename then undo), resume (reload keeps the scene, picks nothing), re-entry (delete the picked layer, pick again). Live adoption keeps or drops the pick. Browser proof locally with dev-browser on the automation profile: pick each row of the hub hero scene, edit the headline, hide god rays, move bloom, undo all. | 2 to 3 |
| L2 `fx-layer-panel-polish` | Setting groups (optional `group` on schema settings, presentation only), the Text group first with larger fields and focus on Enter, the Pointer group, kind change behind a confirmation, drag reorder within a group (Marlin verifies by hand), colour or thumbnail hint per row. | Schema groups do not change serialized output (golden test on every preset, including gold-noise-gradient); the generator schema docs and `validateGeneration` unchanged; pixel oracle unchanged. | 2 to 3 |
| L3 (only if Marlin says yes, see below) | Free text layers. | Oracle, format, generator, agent | 4 to 6 |

## For Marlin to decide

1. **Text in a scene: keep the three-line lockup, or add free text layers?** Today scene text is one lockup of three
   lines with seven fonts, drawn as pixels; Unicorn's text box has position, alignment, line height, letter spacing,
   stroke and any font. Free text layers are engine work (a new layer kind, with the generator, the agent operation
   and the reader taught about it), about 4 to 6 agent days. Recommendation: **keep the lockup for now** (L1 and L2
   make its three lines prominent and editable), because real headlines belong in the box's HTML, which is what search
   engines and screen readers read, and the lockup exists for the bright glow that god rays read. Add free text layers
   only if you want decorative text effects as a product feature. Any change here is told to the FX owner first,
   because the hub hero's pixel comparison with lumitra.co depends on the stored format and the gold preset.
2. **Effects scoped to one layer** (Unicorn's "Mini Blur" nested under its text). The engine applies every effect to
   the whole scene; only god rays read one layer. Scoping effects is a renderer change (render a layer to its own
   target, then compose). Recommendation: **not now**; L1 shows the honest flat model, with "reads Lockup" on god rays.
3. **Picking layers on the canvas** (click the glow to pick god rays). Needs hit testing inside the one live WebGL
   context and only works while Live is on in one breakpoint. Recommendation: **not now**; the Layers panel is the way
   in, and a picked layer can get an outline on the canvas later.

## Decided here, say so if you disagree

- Rows are derived from the stored scene, not new site nodes: no format change, no migration, the agent operation
  `setFxScene` stays sufficient (per-layer agent operations are not needed for this).
- Front at the top; post effects in their own sub-group; no move across groups.
- The picked layer is session state in `EditorUIStore`, keyed by node id and layer id.
- With a layer picked, Delete, Cmd+D and Escape act on the layer.
- Drag reorder ships in L2, after the keyboard and menu paths.
- Tree keyboard navigation for the whole Layers panel is a separate roadmap item, not part of this plan.
- Setting groups are presentation metadata in the schemas; they never reach the stored scene.

## Ownership and gates

- Planning and build owner: fx-layer-editor (Herdr pane w5:pR), in its own worktree. The FX owner lumitra-fx-build-2
  (w5:pE) keeps F7 (the production proof) and F8 (the lumitra.co hero and its pixel comparison) and has confirmed it
  holds no code branch on the files this plan touches.
- Kept stable for the FX owner: the stored format (`fx` version 1, `SCENE_SCHEMA_VERSION` 1) and what the preset
  `gold-noise-gradient` draws.
- Nothing here deploys, publishes or writes to production. Implementation starts only after Marlin decides this plan.
