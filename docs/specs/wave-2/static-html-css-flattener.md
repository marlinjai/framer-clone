---
name: static-html-css-flattener
track: static-html
wave: 2
priority: P0
status: draft
depends_on: [static-html-spike]
estimated_value: 8
estimated_cost: 6
owner: unassigned
---

# Flatten per-breakpoint resolved props into a single CSS file

## Goal

The Wave 1 spike emits one HTML tree at one breakpoint with inline styles. A real published page needs to look correct across ALL breakpoints from the same DOM, because we ship one HTML structure and let CSS media queries swap styles. This spec flattens the MST tree's per-breakpoint resolved props into a deterministic CSS file with `@media (min-width: ...)` rules per viewport, plus a base layer for the smallest breakpoint. Output: one HTML file per page (no inline styles) plus one CSS file. This is the table-stakes responsive-publish behaviour Framer ships.

## Scope

**In:**
- New module `src/lib/renderer/cssFlattener.ts` that walks a page's app tree across all breakpoints and produces:
  - A keyed style map: `{ [componentId]: { [breakpointId]: styleObject } }`
  - A serialized CSS string with one base block plus one `@media (min-width: X)` block per non-primary breakpoint, scoped via `[data-inner-component-id="..."]` selectors.
- Update `staticHtmlEmitter.ts` to accept a flattened CSS file alongside the HTML, replacing inline styles with `data-inner-component-id`-keyed class selectors (or use the existing data attribute as the selector directly: simpler).
- Decide and document the canonical value of `data-component-id` for static output. Recommendation: drop the breakpoint prefix on static HTML (use bare `componentId`), keep editor behaviour unchanged. Aligns with "one DOM tree per page" model.
- Tests covering: (a) base styles only for non-overridden props, (b) media-query overrides for breakpoint-specific props, (c) `display: none` toggles for `canvasVisible: false` per breakpoint, (d) no duplicate rules.

**Out (explicitly deferred):**
- Multi-page bundling, asset (image / font) handling, output to disk (Wave 2: `static-html-publish-pipeline`).
- Per-breakpoint structural variants (different children at different breakpoints). Phase 1 keeps the MST tree shape constant across breakpoints; only props vary. The plan calls this out as sufficient for 90 percent of design intent.
- CSS minification / autoprefixing. Use vanilla CSS strings; downstream tooling can minify if needed.
- Container queries. Stay with `min-width` media queries (matches Framer behaviour).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/cssFlattener.ts` | new | `flattenPageStyles(page)` walks every component, collects resolved props per breakpoint via `getResolvedProps`, diffs against the primary breakpoint, produces a `FlattenedStyles` shape. |
| `src/lib/renderer/cssFlattener.ts` | new | `serializeFlattenedStyles(flattened, breakpoints)` returns the final CSS string with deterministic ordering (sorted by minWidth ascending, primary first). |
| `src/lib/renderer/staticHtmlEmitter.ts` | edit | New signature returns `{ html, css }`. Inline styles are removed from emitted HTML; selectors target `[data-inner-component-id="<id>"]`. |
| `src/lib/renderer/__tests__/cssFlattener.test.ts` | new | Unit tests on the flattener. |
| `src/lib/renderer/__tests__/staticHtmlEmitter.test.tsx` | edit | Expand to assert HTML now has no inline styles and CSS string carries the right rules. |

## API surface

```ts
// src/lib/renderer/cssFlattener.ts
export interface FlattenedStyles {
  // For each component, its base style (primary breakpoint) and any per-breakpoint
  // overrides (only properties that differ from the base).
  perComponent: Record<string, {
    base: Record<string, string | number>;
    overrides: Record<string, Record<string, string | number>>; // breakpointId -> props
  }>;
}

export function flattenPageStyles(page: PageModelType): FlattenedStyles;

export function serializeFlattenedStyles(
  flattened: FlattenedStyles,
  breakpoints: { id: string; minWidth: number }[],
): string;

// src/lib/renderer/staticHtmlEmitter.ts (revised)
export interface EmittedPage {
  html: string;
  css: string;
}

export function emitStaticHtmlForPage(
  page: PageModelType,
  options?: EmitStaticHtmlOptions,
): EmittedPage;
```

`breakpointId` is no longer an input: the emitter now produces one DOM tree plus all breakpoints baked into CSS.

## Data shapes

```ts
// CSS output shape (deterministic ordering, primary breakpoint first):
//
// /* base (primary breakpoint) */
// [data-inner-component-id="abc"] { display: flex; gap: 16px; }
// [data-inner-component-id="def"] { color: #111; }
//
// @media (min-width: 768px) {
//   [data-inner-component-id="abc"] { gap: 24px; }
// }
//
// @media (min-width: 1280px) {
//   [data-inner-component-id="abc"] { gap: 32px; }
// }
```

The renderer touches MST in read-only mode (no MST writes from the flattener).

## Test plan

- [ ] Unit: `cssFlattener.test.ts` covers (a) prop unchanged across breakpoints emits only base, (b) prop changed at one breakpoint emits one media-query block, (c) `canvasVisible: false` at a breakpoint emits `display: none` in that media block, (d) deterministic output (same input always produces same string).
- [ ] Unit: `staticHtmlEmitter.test.tsx` updated to assert HTML carries no `style="..."` attributes and the returned CSS is non-empty for a multi-breakpoint fixture.
- [ ] Integration: render the fixture page's HTML+CSS into a JSDOM window, set viewport widths simulating each breakpoint, assert computed styles match the resolved props from `getResolvedProps`. (May require a small JSDOM media-query polyfill.)
- [ ] Manual: open the emitted HTML+CSS in a browser, resize the viewport across all breakpoints, eyeball that styles change at the right widths.

## Definition of done

- [ ] Flattener and serializer land and typecheck
- [ ] `emitStaticHtmlForPage` returns `{ html, css }` and HTML contains no inline styles
- [ ] All flattener unit tests pass
- [ ] Integration test passes in JSDOM
- [ ] Manual cross-breakpoint visual check captured
- [ ] Spec status moved to `done` in STATUS.md

## Open questions

- **Selector strategy.** Use `[data-inner-component-id="..."]` (zero-tooling) or generate scoped class names (`.fc-abc123`)? Attribute selectors have lower specificity, which matters if users add custom CSS later. Class names are cleaner but add a generation step. Spec recommends attribute selectors for v1; revisit if specificity bites.
- **`data-component-id` value on static output.** Strip the breakpoint prefix (recommendation: yes, since static HTML has one DOM tree). Editor keeps the prefixed form. This is a divergence; Lumitra Studio cross-domain matching needs to know which form to expect.
- **Style inheritance and CSS reset.** Should the published HTML ship a baseline reset (Tailwind preflight, normalize.css)? The editor relies on Tailwind. The published site does not currently. Punt the answer to `static-html-publish-pipeline`; flag now.
- **Pseudo-classes (`:hover`, `:focus`).** Not currently expressible in MST props. Out of scope for Phase 1, but the CSS emitter shape should not box us out of adding them later.
- **CSS variables for theme tokens.** If the editor introduces design tokens, the flattener should emit `--token: value` definitions. Not built today; reserve a hook.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (section 2c: "CSS-driven per-breakpoint output... For 90% of the user's design intent, CSS media queries cover it")
- Code touchpoints: `src/lib/renderer/HeadlessComponentRenderer.tsx` (resolved-props shape), `src/models/ComponentModel.ts` (`getResolvedProps`), `src/lib/renderer/staticHtmlEmitter.ts` (consumer)
