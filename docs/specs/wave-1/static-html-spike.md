---
name: static-html-spike
track: static-html
wave: 1
priority: P0
status: draft
depends_on: [static-html-data-component-id-fix]
estimated_value: 8
estimated_cost: 4
owner: unassigned
---

# Static HTML emitter spike: prove a single page renders to a string

## Goal

Prove that the existing headless render plumbing (`HeadlessComponentRenderer`, `createComponentElement`, `getResolvedProps`) can produce a static HTML string for a single page at a single breakpoint, with no React in the published output. This is the foundational slice of the static HTML publish target. It does not ship to customers; it is a spike that proves the architecture before we invest in CSS flattening, multi-page publish, and the runtime island in Wave 2. The spike also surfaces any structural assumptions in the headless renderer that block string emission (server-only React imports, browser globals like `window.__componentRegistry`, etc.) so we can fix them before scaling.

## Scope

**In:**
- New module `src/lib/renderer/staticHtmlEmitter.ts` that walks a single page's app component tree, resolves props for one chosen breakpoint, and returns an HTML string.
- Use `react-dom/server` `renderToStaticMarkup` against `HeadlessPageRenderer` as the simplest correct implementation. The MST tree is React-renderable; static markup is the standard React way to get a string. This avoids reimplementing tag/attribute serialization and keeps a single render path.
- A vitest test that loads a fixture project (snapshot of a small MST tree), emits HTML, and asserts the string contains the expected tags, text, and `data-component-id` attributes.
- A manual smoke run: a CLI / dev-server route or a vitest harness that prints HTML for one of Marlin's existing pages, so he can eyeball the output.
- Inline styles only (no flattened CSS file). The current `getResolvedProps` returns inline `style`; the spike emits exactly that.

**Out (explicitly deferred):**
- Multi-breakpoint CSS flattening (Wave 2: `static-html-css-flattener`).
- Multi-page publish pipeline / asset bundling / image hosting (Wave 2: `static-html-publish-pipeline`).
- Runtime JS island for `window.__framerRuntime` (Wave 2: `static-html-runtime-island`).
- Hydration of read-only data bindings into the output (Wave 3: `static-html-data-binding-hydration`).
- Server-side rendering on a real worker / Next route handler. Spike runs in Node test process only.
- Form / interactive bits. Phase 1 only renders read-only sites.
- End-user-writable rendering, OIDC integration, login forms (Phase 2 deferrals).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/staticHtmlEmitter.ts` | new | Public function `emitStaticHtmlForPage(page, breakpointId)` returning a string. Internally calls `react-dom/server`'s `renderToStaticMarkup` on a `HeadlessPageRenderer` element. |
| `src/lib/renderer/__tests__/staticHtmlEmitter.test.tsx` | new | Vitest. Build a fixture project + page with an app tree, mount registry stubs, emit HTML, assert string shape. |
| `src/lib/renderer/__tests__/fixtures/sampleProject.ts` | new | Helper that builds a deterministic MST `ProjectModel` for the test (one page, one viewport, container with text + image children). Reusable by later static-html specs. |
| `package.json` | edit if needed | Confirm `react-dom/server` is available in the test runtime. It ships with React; no install expected. |

## API surface

```ts
// src/lib/renderer/staticHtmlEmitter.ts
import type { PageModelType } from '@/models/PageModel';

export interface EmitStaticHtmlOptions {
  // Optional doctype / wrapper. If omitted, returns just the body fragment.
  // Wave 2 publish pipeline supplies a full document shell.
  documentShell?: 'fragment' | 'minimal-html5';
}

export function emitStaticHtmlForPage(
  page: PageModelType,
  breakpointId: string,
  options?: EmitStaticHtmlOptions,
): string;
```

## Data shapes

No new persistent data. The spike consumes existing MST shapes:

```ts
// Input: a PageModelType with appComponentTree and sortedViewportNodes already populated.
// Output: an HTML string. Inline styles only at this stage.
```

The renderer touches MST in read-only mode (no MST writes from the static HTML path). This is non-negotiable: static HTML emission must be idempotent and side-effect-free against the MST tree.

## Test plan

- [ ] Unit: `staticHtmlEmitter.test.tsx` builds a 3-node tree, emits HTML at the primary breakpoint, asserts: (a) tag names match, (b) text content appears, (c) `data-component-id` and `data-inner-component-id` survive (depends on `static-html-data-component-id-fix` landing first), (d) inline `style` attributes are present where `getResolvedProps` returns style.
- [ ] Unit: void-tag handling. An `img` node renders as `<img ... />` with no children, never `<img></img>`.
- [ ] Unit: function-component path. A registered `Container` from `componentRegistry` emits its expected root tag with attributes intact.
- [ ] Unit: hidden node (`canvasVisible: false`) is omitted from output.
- [ ] Manual: run a one-shot script (or temporary route) that prints HTML for an existing project page. Marlin eyeballs it.

## Definition of done

- [ ] `emitStaticHtmlForPage` exists, typechecks, and produces a non-empty HTML string for the fixture
- [ ] All four unit tests pass
- [ ] `pnpm test` is green overall (no regressions)
- [ ] One manual smoke run captured (HTML output pasted into the spec PR or a comment)
- [ ] Spec status moved to `done` in STATUS.md
- [ ] Open questions resolved or explicitly punted to Wave 2 specs

## Open questions

- **Hydration model.** Static HTML alone is enough for read-only Phase 1 pages. Do we need any client-side runtime at all in Wave 1, or does that wait for `static-html-runtime-island` in Wave 2? Current assumption: Wave 1 ships zero-JS HTML and the runtime island lands in Wave 2 alongside Lumitra Studio variant hooks.
- **`__componentRegistry` lookup at emit time.** `createComponentElement` reads `(window as any).__componentRegistry`. In a Node test process there is no `window`. Spike has to either polyfill `window` in the test, populate the registry as a module export the emitter reads directly, or refactor the registry lookup. Worker's call; flag the chosen approach.
- **`react-dom/server` vs hand-rolled string emitter.** `renderToStaticMarkup` is the smallest diff but pulls React-DOM-server into the publish pipeline forever. A hand-rolled walker (1 to 2 days) decouples publish from React entirely, which the strategic thesis hints is desirable long-term. Spike picks `renderToStaticMarkup` for speed; raise the question explicitly so Wave 2 can revisit if the dependency footprint matters.
- **Breakpoint scope of `data-component-id`.** Static HTML emits one DOM tree (not one per breakpoint). The current value `${breakpointId}-${componentId}` becomes ambiguous: which breakpoint does the published `data-component-id` carry? Punt to `static-html-css-flattener` but record the question.
- **Output cleanliness.** `renderToStaticMarkup` emits React-isms (`class` instead of `className` is fine; `style` becomes a string; data-* attributes survive verbatim). Confirm and document.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (recommendation 1: ship a static-HTML publish target as the next renderer evolution; option 3c, "Static HTML + minimal hydration islands": "Verdict: Strong. Cleanest architecture.")
- Memory: `memory/project_strategic_thesis_bubble_killer.md` (Phase 1 includes static HTML publish)
- Code touchpoints: `src/lib/renderer/HeadlessPageRenderer.tsx`, `src/lib/renderer/HeadlessComponentRenderer.tsx`, `src/lib/renderer/createComponentElement.tsx`, `src/models/PageModel.ts`, `src/models/ComponentModel.ts`
- External: `react-dom/server` `renderToStaticMarkup` docs
