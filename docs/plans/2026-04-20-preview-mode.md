---
type: plan
status: draft
date: 2026-04-20
title: Preview mode (Framer-style)
summary: Headless responsive renderer + /preview route + viewport-resize toolbar, reusing the existing MST tree. Direct render (no iframe) for v1; full Framer parity is the long-term goal.
tags: [framer-clone, preview, renderer, breakpoints]
projects: [framer-clone]
---

# Preview Mode (Framer-style)

## Context

The editor today renders every breakpoint side-by-side on the canvas as design surfaces with selection chrome, drag handles, and HUD overlays. There is no way to see the actual page running at a single chosen breakpoint, drag the viewport width to test responsive behavior, or hand a link to a stakeholder.

Framer's preview is the canonical reference: a separate "view" toggled via the URL (`?view=preview`), with a toolbar for breakpoint presets, W/H number inputs, draggable side gutters that re-flow the design at any pixel width, and reload/fullscreen/invite/publish controls. It renders the same React components the canvas uses, but stripped of editor chrome and constrained to one viewport at a time.

The architectural goal: pull a clean "headless renderer" out of the existing editor render path so the same code drives both surfaces, and wrap it with a preview shell that can run anywhere (today: a sibling route in the same app; later: an iframe or a published static export).

## Decisions locked in

1. **Direct render in the same Next.js app at `/preview`.** Reads the same in-memory MST RootStore. No iframe, no postMessage, no snapshot serialization. Future iframe path stays open because the headless renderer accepts plain props.
2. **Auto-resolve breakpoint from width.** Toolbar offers presets (Desktop / Tablet / Mobile / custom W input), but the active `breakpointId` is always derived from the current container width: largest viewport whose `breakpointMinWidth ≤ width`. Mirrors Framer.
3. **MVP first; full parity is the long-term north star.** Multi-page nav is the first stretch goal once MVP lands.

## Current-state gaps

| Gap | Where | Why it matters |
|---|---|---|
| Renderer is editor-coupled | `ComponentRenderer.tsx`, `GroundWrapper.tsx`, `ResponsivePageRenderer.tsx` | Inject `data-component-id`, `onClick`/`onPointerDown`, contenteditable, `useDragSource`. None of this can run in preview. |
| Reads editor stores during render | `ComponentRenderer.tsx:23,39,70,77` | Selection state, edit state, tool state. Headless render must not depend on these. |
| Responsive resolution is inline, not media-query | `getResolvedProps` in `ComponentModel.ts:375` | Drag-to-resize alone won't change anything; we must re-pick `breakpointId` and re-render on width change. |
| No `/preview` route or shell | `src/app/` only has `/` | Route, layout, toolbar, resize gutters, fullscreen handling all missing. |
| No "page snapshot" or read-only mode contract | `EditorUIStore.ts` | Currently the editor mutates `currentPage`; preview must observe without writing. |
| HudSurface and drag overlays are global to EditorApp | `src/components/EditorApp.tsx` | Preview mounts a different shell, not EditorApp. |
| Pages have `slug` but no inter-page link primitive | `PageModel`, `ComponentModel.ts:40` (style allowlist) | Blocks v2 (multi-page nav inside preview). Out of scope for v1. |
| No `window.matchMedia` participation | n/a | Designs that rely on browser media queries (custom code in future) won't work in direct-render mode. iframe path solves this when needed. |

## Architecture: the headless renderer

Goal: extract a pure React tree that can render any viewport of any page from MST data, with **zero editor dependencies**. Editor and preview both consume it; editor wraps it with selection/drag chrome, preview wraps it with a width frame.

```
                    ┌──────────────────────────┐
                    │  HeadlessPageRenderer    │  pure function of (page, breakpointId)
                    │   ─ resolves styles      │  no editor stores read
                    │   ─ no data-* IDs        │  no event handlers
                    │   ─ no contenteditable   │
                    └────────────▲─────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
   ┌──────────┴──────────┐               ┌──────────┴──────────┐
   │  EditorPageRenderer  │               │  PreviewShell        │
   │  (today's behavior)  │               │  (toolbar + gutters) │
   │  + selection / drag  │               │  + width-driven      │
   │  + multi-viewport    │               │    breakpoint pick   │
   └──────────────────────┘               └──────────────────────┘
```

Minimum new surface area:

- `src/lib/renderer/HeadlessPageRenderer.tsx` — accepts `{ page, breakpointId }`, returns the rendered tree. No `useStore`, no `editorUI` reads.
- `src/lib/renderer/HeadlessComponentRenderer.tsx` — extracted from `ComponentRenderer.tsx`. Just `getResolvedProps` + `React.createElement`. Same path for HOST and registry-resolved FUNCTION components.
- `src/lib/renderer/pickBreakpoint.ts` — `pickBreakpointForWidth(viewportNodes, width): breakpointId`. Largest `breakpointMinWidth ≤ width`, fallback to smallest.

Existing code that **stays put** (used only by the editor wrapper):
- `ResponsivePageRenderer.tsx` keeps the multi-viewport rendering loop and editor click handlers.
- `GroundWrapper.tsx` keeps drag wiring; the headless renderer doesn't use `GroundWrapper` at all.
- `HudSurface.tsx` is editor-only by definition.

Refactor strategy for `ComponentRenderer.tsx`: split into two files. The new `HeadlessComponentRenderer` is the pure render. The existing `ComponentRenderer` becomes a thin wrapper that calls `HeadlessComponentRenderer` and adds editor handlers/IDs as a higher-order layer (or as wrapping `<div>`s around it). Goal: zero behavior change for the editor, zero editor leakage in preview.

## Roadmap

### Phase 1: Headless renderer extraction (no UI work)

**Outcome:** `ResponsivePageRenderer` continues to work bit-identical; under the hood it now delegates leaf rendering to `HeadlessComponentRenderer`. Tests pass.

- Create `src/lib/renderer/HeadlessComponentRenderer.tsx` with the pure render path (no `useStore`, no editor handlers, no `data-component-id`).
- Refactor `src/components/ComponentRenderer.tsx` to wrap the headless renderer with editor concerns (`data-component-id`, click/pointerdown, contenteditable, drag binding).
- Add `src/lib/renderer/pickBreakpoint.ts` + Vitest unit tests covering: exact-match width, between-breakpoint width, below smallest, above largest, single-breakpoint page, empty viewports.
- Run `pnpm exec tsc --noEmit` and `pnpm exec vitest run` — must stay green.

Definition of done: the editor canvas behaves identically, but there is now a function I can call from anywhere that returns a clean React tree for `(page, breakpointId)`.

### Phase 2: `/preview` route + minimal shell (MVP)

**Outcome:** Navigating to `/preview` shows the active page rendered headlessly inside a width-controlled frame, with a top toolbar.

- Add Next.js route `src/app/preview/page.tsx` (client-only, `ssr: false`, same as `/`). Reads the same `useStore()` — no separate state plumbing.
- Add `src/components/preview/PreviewShell.tsx`: top toolbar + a centered scroll region containing the framed render.
- Add `src/components/preview/PreviewFrame.tsx`: a width-controlled wrapper that mounts `HeadlessPageRenderer`. Width comes from local UI state; breakpointId derives from width via `pickBreakpointForWidth`.
- Toolbar v1: Back (returns to `/`), Reload (force-remount the frame), Fullscreen (Fullscreen API on the scroll region), breakpoint preset dropdown (built from `currentPage.viewportNodes`), W/H number inputs synced to the frame width.
- Add draggable resize gutters on left and right edges of the frame: pointer-drag adjusts width, releases commit. ESC cancels mid-drag.
- Add an entry point in the editor (small "Play" icon in the existing top bar) that navigates to `/preview`.

Definition of done: I can switch to `/preview`, drag the side gutters from 320 → 1440, and watch the rendered page re-resolve through Mobile → Tablet → Desktop variants live, with no editor chrome anywhere.

### Phase 3: Polish + URL state

**Outcome:** Preview is shareable (link encodes view state) and feels production-quality.

- URL query state: `?page=<slug>&w=<px>&h=<px>&bp=<id>`. Use `next/navigation` `useSearchParams`. Reload / refresh preserves state.
- Toolbar: page selector (lists `currentProject.pages`).
- Preset chips with snap-to-width on click; show current breakpoint name as a passive badge.
- Performance: React.memo around `HeadlessComponentRenderer` keyed on `(componentId, breakpointId)`.
- Visual: subtle device-frame outline, drop shadow, scroll-region grid background — match the Framer screenshot's vibe.

### Phase 4: Multi-page navigation inside preview

Requires a new model primitive: `link` / `href` on components (button, container, image). Today the style allowlist (`ComponentModel.ts:40`) is style-only; we need an `attributes` shape that survives serialization.

- Extend the model to allow per-component `href`/`target` attributes.
- In preview, intercept clicks on elements with `href`: if internal (matches a page slug in the project), `router.push('/preview?page=<slug>')` instead of full nav. If external, open in new tab.
- Add a "Page → Link to" picker in the right sidebar.

Out of scope for MVP. Listing here so it doesn't get rediscovered as a surprise.

### Phase 5: Long-term parity (north star, not roadmap)

These shape the architecture decisions in earlier phases but are not committed:

- **Iframe sandbox path.** The headless renderer is already plain React; the iframe path is a new route `/preview/embed` that mounts only `HeadlessPageRenderer` and accepts a snapshot via `postMessage`. Needed once we add user code components or want true CSS isolation.
- **Publish.** A static export of `HeadlessPageRenderer` per page per breakpoint, with breakpoints expressed as real CSS `@media` queries (a *separate* render mode that emits CSS, not inline styles). This is a substantial extra render path.
- **Invite / share links.** Requires auth + persistence. Currently project state is in-memory only.
- **Presence avatars + cursor chat.** Multiplayer. Requires backend (Liveblocks / Y.js) and is a separate epic.
- **Inspect / Performance tooling.** Devtools-style overlays inside preview.

## Critical files

To create:
- `src/lib/renderer/HeadlessPageRenderer.tsx`
- `src/lib/renderer/HeadlessComponentRenderer.tsx`
- `src/lib/renderer/pickBreakpoint.ts`
- `src/lib/renderer/__tests__/pickBreakpoint.test.ts`
- `src/app/preview/page.tsx`
- `src/components/preview/PreviewShell.tsx`
- `src/components/preview/PreviewFrame.tsx`
- `src/components/preview/PreviewToolbar.tsx`
- `src/components/preview/ResizeGutter.tsx`

To refactor (behavior-preserving):
- `src/components/ComponentRenderer.tsx` — extract pure render into headless module; keep editor wrapper here.
- `src/components/ResponsivePageRenderer.tsx` — leaf rendering now goes through the headless module.
- `src/components/Toolbar.tsx` (or wherever the editor top bar lives) — add the "open preview" entry point.

To reuse as-is (read-only references, no edits):
- `src/models/ComponentModel.ts` — `getResolvedProps`, `resolveResponsiveValue`, `getResponsiveStyleValue` are the resolution heart of preview.
- `src/models/PageModel.ts` — `appComponentTree`, `viewportNodes`, `sortedViewportNodes`.
- `src/models/ProjectModel.ts` — `pages` map (used by Phase 3 page selector).
- `src/lib/componentRegistry.ts` — registry lookup is identical for editor and preview.
- `src/hooks/useStore.ts` — preview reads the same RootStore.

## Risks and tradeoffs

- **Editor-style bleed in preview.** Tailwind reset, body styles, etc. apply to preview too. For our current component set this is the desired behavior (we want the same rendering). When we add code components or want pixel-true publish parity, escalate to the iframe path.
- **Refactor blast radius on `ComponentRenderer.tsx`.** This file is on the critical render path of every viewport. Changes must be behavior-preserving and verified by the existing 17-test Vitest suite plus a manual editor smoke test before moving to Phase 2.
- **No CSS media queries in preview.** Drag-to-resize re-resolves styles at the React level, not in the browser's media-query engine. Smooth enough for the value chain we have, but it means custom CSS using `@media` (if a user ever writes some) won't react to the preview width. Document this.
- **Single in-memory store.** `/preview` only works while `/` is the previous page in the same tab — open a fresh tab on `/preview` and the project is empty (no persistence yet). Acceptable for MVP since it's an internal tool. Persistence is a separate epic, and when it lands preview gets it for free.

## Verification

Phase 1:
- `pnpm exec tsc --noEmit` — clean
- `pnpm exec vitest run` — 17/17 still pass
- Manual: open `/`, select components in viewports, drag, resize, edit text — all behavior identical to before refactor

Phase 2:
- New Vitest suite for `pickBreakpoint`: 5+ cases, all passing
- Manual: open `/preview`
  - frame mounts at the page's largest viewport's width by default
  - dragging the right gutter from 1280 → 320 visibly switches Desktop → Tablet → Mobile variants at the right widths (use a styled element with different per-breakpoint colors as a sanity probe)
  - selecting a preset from the dropdown snaps width and updates the W input
  - typing in the W input snaps the gutter
  - Reload force-remounts the frame
  - Fullscreen enters/exits via the button
  - no selection overlay, no resize handles, no `data-component-id` attributes appear in the rendered DOM (DevTools inspect)
  - clicking a button or link inside the frame does not select it (preview is not editor)
- DevTools Network/Console: no errors, no warnings about MobX-State-Tree mutation outside actions

Phase 3+ verifications added when those phases are picked up.
