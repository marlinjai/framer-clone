---
name: slice2-publish-read-binding-hydration
track: cms-content-tier
wave: 3
priority: P1
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-read-only-data-components, slice2-data-loading-empty-error-states, slice2-cms-server-adapter-and-repo]
touchesSharedState: false
sharedState: []
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Read-binding hydration in preview + (gated) static publish

> `hydrateBindings` takes the local `src/server/cms` read repo (`CmsReadRepository`) instead of a `@marlinjai/doc-tier-core` `DocTierRepository`; doc-tier-core import dropped. This is the "direct import for build-time" reader (the live client reads `/api/cms/*` over HTTP; the build-time hydrator imports the repo directly in Node, no HTTP, no React). Static-publish WIRING stays gated on the static-html wave (`projectPublisher.ts`/`staticHtmlEmitter.ts` do NOT exist yet); this spec builds the reusable helper + the preview-parity assertion against `HeadlessPageRenderer` (which DOES exist). Track C's commerce hydration EXTENDS this helper's signature with a `commerceRepo`; see `trackc-commerce-binding-preview-and-publish-hydration`.

> SIGNATURE NOTE: the options-object form `hydrateBindings(pageTree, pageParams, { cmsRepo })` is used so Track C can add `{ cmsRepo, commerceRepo }` additively without breaking this call site.

## Goal

Prove a data-bound tree resolves correctly through the React-free resolver by asserting parity between the preview render and the build-time-resolvable shape. Build the reusable `hydrateBindings` helper (build-time expansion via the React-free resolver, reading the `src/server/cms` repo directly) so the static-publish wave can call it without re-deriving the logic. Wire it into the actual publish pipeline ONLY once that pipeline exists.

## Scope

**In:**
- `src/lib/renderer/publish/hydrateBindings.ts`: build-time expansion of Collection (per row) / RecordView (from page slug params) using the React-free resolver, producing concrete prop values. Runs in Node (no React/jsdom). Fetches rows server-side via the `src/server/cms` `CmsReadRepository` DIRECTLY (NOT a React hook, NOT `/api/cms`). Empty -> `emptyContent`; error -> render nothing for the slot, never throw the build.
- A parity test: the resolved bound tree (via `hydrateBindings`) matches the preview render's text content (`HeadlessPageRenderer`).
- Preview mode keeps the live polling provider (unchanged from `slice2-prisma-datasource-provider`).

**Out (explicitly deferred / GATED):**
- Wiring `hydrateBindings` into `projectPublisher.ts` / the per-page emitter: GATED on `static-html/spike` + `static-html/publish-pipeline` landing.
- Commerce hydration (`trackc-commerce-binding-preview-and-publish-hydration` extends the signature).
- Client-side runtime island hydration (wave-3).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/publish/hydrateBindings.ts` | new | build-time Collection/RecordView expansion via React-free resolver, reads CmsReadRepository directly; options-object signature |
| `src/lib/renderer/publish/__tests__/hydrateBindings.test.ts` | new (node project) | per-row expansion, empty/error, Node env |
| `src/lib/renderer/publish/__tests__/parity.test.ts` | new | preview vs hydrated parity against HeadlessPageRenderer |

## API surface

```ts
// reads rows server-side via the local src/server/cms repo directly (NOT a React hook, NOT HTTP)
export async function hydrateBindings(
  pageTree: ComponentNode,
  pageParams: Record<string, string>,
  repos: { cmsRepo: CmsReadRepository },   // options-object so Track C adds { cmsRepo, commerceRepo } additively
): Promise<ComponentNode>; // Collection templates expanded, RecordView resolved, props baked in
```

## Test plan

- [ ] A fixture project with an Events Collection->gallery template, hydrated via `hydrateBindings`, yields one DOM block per Events row with `{{row.field}}` values baked in (no LOADING text).
- [ ] RecordView resolved from a page slug param yields the matching row's content.
- [ ] An empty collection yields the configured `emptyContent`.
- [ ] A forced fetch error during hydration renders nothing for that slot and does NOT throw.
- [ ] `hydrateBindings` runs in Node (no React/jsdom) in its test (uses the resolver-runtime node-env config).
- [ ] Parity: the hydrated tree's text content matches the `HeadlessPageRenderer` preview render of the same bound tree.

## Definition of done

- [ ] `hydrateBindings` lands, takes the options-object `{ cmsRepo }`, runs in Node, never throws the build on empty/error.
- [ ] NO `@marlinjai/doc-tier-core` import.
- [ ] Parity test green against `HeadlessPageRenderer`.
- [ ] A clear TODO + follow-on spec stub records that wiring into the publish pipeline is gated on the static-html wave.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- The static-html publish pipeline must land before `hydrateBindings` can be wired into actual published output. Recommendation: defer the WIRING; build the helper + parity now so the wave-pickup is a one-line call.

## References

- Re-scope brief (2026-06-16): hydrateBindings takes the local `src/server/cms` repo; drop doc-tier-core; static-publish wiring gated on the static-html wave.
- Code touchpoints: `src/lib/renderer/HeadlessPageRenderer.tsx` / `HeadlessComponentRenderer.tsx` (exist), resolver (`applyBindings`/`pushRowFrame`), `src/server/cms` (`CmsReadRepository`)
- Depends on: `slice2-read-only-data-components`, `slice2-data-loading-empty-error-states`, `slice2-cms-server-adapter-and-repo`
- Gated on: wave static-html `static-html-publish-pipeline.md`, `static-html-spike.md` (both draft, not in this track)
