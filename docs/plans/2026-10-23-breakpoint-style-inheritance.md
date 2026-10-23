---
type: plan
status: in-progress
date: 2026-10-23
title: Desktop-first breakpoint style inheritance, in the editor, the panel and the published site
summary: One cascade rule for responsive styles (own value, then each larger breakpoint, then base), used by the canvas, the properties panel and the published page; the largest breakpoint writes the base; the panel shows where each value comes from and can reset an override; the published page emits real max-width media queries instead of dropping every breakpoint edit.
tags: [framer-clone, responsive, breakpoints, properties-panel, publishing]
projects: [framer-clone]
---

# Desktop-first breakpoint style inheritance

## Why

Asked by the owner on 2026-10-23: a change on Tablet should cascade down to Phone, and the
properties panel should show which breakpoint a value comes from (Framer behaviour).

A probe on a real `ComponentModel` (Desktop colour edit, Tablet font-size edit) showed three
different, wrong resolutions today:

| Path | Code | Behaviour today |
|---|---|---|
| Editor canvas and preview | `resolveResponsiveValue` in `src/models/ComponentModel.ts` | own, then the primary, then **smaller**, then larger, then base. A Tablet override leaks up to Desktop; Phone takes Desktop's value, never Tablet's. |
| Properties panel | `getResponsiveStyleValue` | own, else `base`. Shows empty on Phone and Desktop while the canvas shows the Tablet value. |
| Published page | `flattenStyleValue` in `src/lib/renderer/server/renderComponentNode.tsx` | always `base`. Every edit made in the panel with a breakpoint selected (that is, every panel edit) never reaches the live site. |

## Decisions

1. **One rule, desktop-first.** Breakpoints are ordered by `breakpointMinWidth`. A value for
   breakpoint B resolves to: B's own value, else the next larger breakpoint's, and so on up to
   the largest, else `base`. A value stored under the primary (largest) breakpoint's id counts
   as that breakpoint's own value, so existing projects resolve correctly without a migration.
2. **The largest breakpoint writes the base.** Editing on Desktop writes `base` (and drops a
   stale primary-id key); editing on a smaller breakpoint writes an override under its id.
   Clearing a field on a smaller breakpoint removes the override (it inherits again); clearing
   on Desktop clears the base.
3. **One resolver module** (`src/lib/responsive/cascade.ts`) returns `{ value, source }`, where
   source is `own`, a larger breakpoint's id, or `base`. The canvas, the panel and the published
   renderer all use it.
4. **Panel indicator.** Each property row shows where its value comes from: a filled brand dot
   when the value is set on this breakpoint (an override), a muted "from Desktop" (or Tablet) hint
   when inherited. Clicking the dot (or a Reset item) removes the override. On the largest
   breakpoint values are the base, so no dot.
5. **Published page uses real CSS.** Responsive style values move out of the inline `style`
   into a per-page stylesheet: base rules, then for each smaller breakpoint (descending)
   `@media (max-width: <next larger min width - 1>px) { ... }` with its overrides, keyed by a
   stable class per node. Media queries cascade naturally in the same direction as the editor
   rule. Non-responsive values stay inline.

## Tests (all four paths of the stateful flow standard where they apply)

- Resolver: own, inherit from the next larger, skip to the largest, base, primary-id legacy
  value, unknown breakpoint.
- Writes: Desktop edit writes base; Tablet edit then Phone resolves to Tablet; Phone override
  wins; reset removes it and Phone inherits again; undo of each.
- Panel: indicator shows own versus inherited source; reset works.
- Published: the generated CSS for a Desktop edit, a Tablet override and a Phone override, the
  media query widths, and that inline style no longer carries responsive maps.
