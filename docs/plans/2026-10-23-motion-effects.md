---
type: plan
status: in-progress
date: 2026-10-23
title: Motion and effects, appear on scroll, restrained hover, image parallax and optional smooth scrolling
summary: An Effects section in the properties panel (appear on scroll with distance, duration, delay and stagger; a restrained hover; a small parallax for images), stored as props.effects and cascaded per breakpoint like a style, shown on the canvas as a badge with a Play control, played by the preview and the published page through a tiny IntersectionObserver plus Web Animations runtime that never hides content without JavaScript, plus an optional per-site Lenis smooth-scroll toggle and sparing appear effects in the AI page generator. Decided by the owner on 2026-10-23.
tags: [framer-clone, editor, motion, publishing, ai, accessibility]
projects: [framer-clone]
---

# Motion and effects

## Why

The roadmap line "Motion and effects" (decided by Marlin on 2026-10-23): sites built in the editor
were completely static, while a real marketing site reveals its sections as they scroll in, gives
links and cards a small hover response and sometimes moves an image slightly with the scroll. The
same line asks for an optional smooth-scroll toggle per site (Lenis), off by default.

The motion rules are binding, from the owner's design-skill precedence (the `animate` and
`emil-design-eng` skills): interface animations under 300ms, entrances ease out with a strong curve
(never ease-in), nothing perpetual (no pulse, float, shimmer or marquee), no animation on
high-frequency actions, only `transform` and `opacity` move, and everything is off under
`prefers-reduced-motion`. Generated pages must not show the tells listed in
`docs/plans/2026-10-23-ai-design-quality-round-2.md` (perpetual motion, hover on everything).

## Decisions

1. **Storage: a dedicated `props.effects` object**, not a new model field:
   `{ appear, hover, scroll }`. It travels with the existing frozen `props` record, so it is saved
   in every page snapshot, undoable (one MST action per edit: `setEffect`, `resetEffect` on
   `ComponentModel`), copied with collection rows on the published page and carried by the yjs
   shape, where it is a nested `Y.Map` per group (`YJS_PROPS_KEYS.effects`) so two people editing
   the appear and the hover of one element do not overwrite each other. `getResolvedProps` never
   routes it into DOM attributes, and the server renderer denies it as well.
2. **Per breakpoint, whole group at a time.** `appear` and `scroll` cascade desktop-first through
   `src/lib/responsive/cascade.ts` like any responsive style (`{ base, <breakpointId>: effect }`),
   so "no appear on Phone" is one override, with the same source dot and reset in the panel as a
   style row. `hover` is one value everywhere: it is gated by the pointer (touch screens have no
   hover), not by the width. Groups that end up as none are dropped, so an element without
   effects stores nothing.
3. **Limits in one module** (`src/lib/effects/effects.ts`, read by the panel, the normalizer and
   the generator): appear kinds none, fade, slide up, slide from left, slide from right, scale in
   (from 0.96, never 0); distance 4 to 48px (16 default); duration 150 to 400ms with a default of
   280ms (content reveals on a marketing page may run a little longer than interface motion, the
   default stays under 300ms); delay up to 600ms; stagger off or 30 to 80ms between children;
   easing `cubic-bezier(0.23, 1, 0.32, 1)`. Hover: lift (2px), dim (opacity 0.8), underline (links
   only), 160ms, only on a fine pointer, lift and the dim transition off under reduced motion.
   Scroll: parallax on images only, at most 40px shift (16 default). Lift is not offered on an
   element with a parallax (both move it; switching parallax on clears a lift).
4. **DOM contract: data attributes plus custom properties.** An effect element renders
   `data-fx-a` (appear), `data-fx-st` (staggered children), `data-fx-p` (parallax) and
   `data-fx-h` (hover kind), and its values as custom properties (`--fx-o0`, `--fx-x0`,
   `--fx-y0`, `--fx-s0`, `--fx-d`, `--fx-dl`, `--fx-st`, `--fx-ps`). On the published page the
   properties become responsive maps where a breakpoint differs, and the existing responsive
   stylesheet turns them into media queries, so the runtime reads computed values and never needs
   to know the width. The preview renders one breakpoint and writes them inline.
5. **Runtime: vanilla, no library** (`src/lib/effects/runtime.ts`, a few kilobytes): one
   IntersectionObserver reveals each appear element once (when its top passes the lower 10% of the
   scroll root; an element already scrolled past is shown without a reveal), the Web Animations
   API plays a one-keyframe reveal from the start values to the element's own resting state
   (`fill: backwards` holds the start state through the delay in the same frame the start-state
   rule stops applying, so there is no flash), and a passive scroll listener batched through
   requestAnimationFrame moves parallax images with the `translate` property only. A
   MutationObserver picks up elements added later (the preview re-renders while editing). Motion
   (MIT) was considered and not used: a fade and a slide do not earn a library.
6. **Nothing hidden without JavaScript.** The start-state rule is never part of the server HTML.
   The published page carries a tiny inline boot script ahead of the content that injects it into
   `<head>` unless the visitor asks for reduced motion, and removes it again after three seconds
   if the runtime island has not started (a failed or slow script load). The runtime island
   (`EffectsIsland`) then marks elements shown without animating when the start state is gone. In
   the preview the rule is scoped to the frame's `data-fx-on`, set before the first paint only
   when motion is allowed. No layout shift: only transform and opacity change.
7. **Editor canvas shows the final state**, always: it renders no effect attributes. A badge on
   the selection names the effects on the edited breakpoint, and a Play button in the Effects
   section plays the appear once on the selected element in that breakpoint's frame (a Web
   Animation with no lasting trace). Play is disabled, with the reason, under reduced motion.
8. **Lenis smooth scrolling as a site setting**: `smoothScroll` in the Site settings object
   (`src/lib/site/siteSettings.ts`, from the site essentials plan, so it is persisted in the
   `site_settings` column and the yjs project blob without further changes), a switch in the
   Site settings dialog's Motion section. Lenis 1.3.26 (MIT, pinned, older than two weeks) is
   imported on demand only when the setting is on, never under reduced motion, never on the
   editor canvas (which pans its own camera), on the preview frame (as wrapper) and the
   published window, with `anchors: true` so in-page links keep working. The few rules of
   `lenis.css` are inlined only when on.
9. **The generator uses appear only, sparingly.** The rules sit in a new
   `src/lib/ai/pageGen/promptSections/effects.ts` and reach the model as a "Motion" section of the
   schema docs (the cached prefix; the design brief's word budget in `prompt.ts` stays untouched):
   hero and section reveals and staggered lists, never navigation, footer, body text or every
   element. The validator keeps only an appear (clamped, duration and distance always the
   editor's defaults), drops hover and scroll, turns stagger off without two children and caps a
   generation at eight appear effects, deciding outer nodes first.

## Build

- [x] Effects model, limits, cascade, DOM contract, stylesheets and boot script
  (`src/lib/effects/effects.ts`), runtime, Play and Lenis helpers.
- [x] `ComponentModel.setEffect` / `resetEffect` / `getEffect` / `getEffectSource`, effects kept out
  of DOM attributes, yjs nested map.
- [x] Effects section (registered for containers, text, images and generic elements), source dot
  and reset, Play, canvas badge on the selection.
- [x] Preview: effects rendered per breakpoint, runtime on the frame, Lenis on the frame.
- [x] Published page: `applyEffects` before the responsive pass, effects stylesheet, boot script,
  `EffectsIsland`, smooth scrolling from the site settings.
- [x] Generator: Motion docs section, validator, golden docs.
- [x] Tests: model and cascade, panel, runtime (reduced motion, once, stagger, scrolled past, no
  hidden content without JavaScript), published output, preview output, Lenis wiring, generator.
- [ ] Verified in the browser on the demo editor and its preview.

## Out of scope

- Exit animations and re-playing on scroll back (reveals fire once by design).
- Scroll-driven sequences and pinning: the separate "Scroll-driven page type" roadmap line.
- Hover effects from the generator, and hover on the editor canvas (selection would fight it).
