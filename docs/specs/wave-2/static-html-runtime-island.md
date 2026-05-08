---
name: static-html-runtime-island
track: static-html
wave: 2
priority: P1
status: draft
depends_on: [static-html-spike]
estimated_value: 7
estimated_cost: 4
owner: unassigned
---

# Vanilla-JS runtime island for published sites

## Goal

Phase 1 published sites are read-only HTML, but a few things need a tiny runtime layer regardless: Lumitra Studio variant application (`window.__framerRuntime.applyExperimentVariant`), navigation interception for SPA-feel page transitions (optional), and a hydration seam that Wave 3's `static-html-data-binding-hydration` can plug into. This spec builds that seam as a single small vanilla-JS bundle: no React, no framework, framework-neutral DOM mutations against `data-component-id`-keyed elements. The bundle is optional (the manifest opts in via `runtimeBundle`); pages without it stay zero-JS.

## Scope

**In:**
- New package shape `src/lib/renderer/publish/runtime/` with `index.ts` as the bundle entry. Builds via the existing build tooling (verify; may need a `tsup` or vite-library config) into a single self-contained JS file.
- Public global `window.__framerRuntime` with the methods sketched in the renderer plan: `applyExperimentVariant(experimentKey, variantKey)`, `findByFingerprint(...)`, `mutateNode(componentId, patch)`. Stub-level implementations.
- Hydration seam: `__framerRuntime.registerDataBinding(componentId, fetcher)` so Wave 3 can wire CMS polling without changing the runtime.
- Bundle size budget: under 5 KB gzipped. Anything beyond that is a smell.
- Tests: unit-test the public API with JSDOM; integration-test that the bundle runs in a real browser via Playwright or vitest browser mode.

**Out (explicitly deferred):**
- Actual data-binding implementation (Wave 3: `static-html-data-binding-hydration`).
- Lumitra Studio integration (separate track).
- End-user auth on published sites (Phase 2).
- Form submission handling. Phase 1 sites are read-only; Forms are Phase 2.
- Real-time / WebSocket subscriptions. Phase 1 ships polling only.
- SPA-style client-side navigation. Reserve the seam (`__framerRuntime.intercept(href)`) but do not build.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/publish/runtime/index.ts` | new | Public API surface and bundle entry. |
| `src/lib/renderer/publish/runtime/variantApply.ts` | new | DOM mutation primitives keyed off `data-component-id`. |
| `src/lib/renderer/publish/runtime/dataBindings.ts` | new | Registration shape for Wave 3 to wire fetchers. Stub. |
| `src/lib/renderer/publish/runtime/build.config.ts` | new | Build config for the standalone bundle. |
| `src/lib/renderer/publish/runtime/__tests__/runtime.test.ts` | new | Unit tests in JSDOM. |
| `src/lib/renderer/publish/projectPublisher.ts` | edit | Inject `<script src="/runtime.js" defer>` into emitted HTML when `options.runtimeBundle` is set. |

## API surface

```ts
// src/lib/renderer/publish/runtime/index.ts
declare global {
  interface Window {
    __framerRuntime?: FramerRuntime;
  }
}

export interface FramerRuntime {
  // Lumitra Studio variant application. DOM mutation against data-component-id-keyed elements.
  applyExperimentVariant(experimentKey: string, variantKey: string): void;

  // Find an element by its componentId (the fingerprint surviving from the editor).
  findByFingerprint(componentId: string): HTMLElement | null;

  // Mutate a node's attributes / text / style.
  mutateNode(
    componentId: string,
    patch: { attributes?: Record<string, string>; text?: string; style?: Partial<CSSStyleDeclaration> },
  ): void;

  // Wave 3 seam: register a data-binding for a component. The runtime calls
  // the fetcher on hydrate and on poll, then mutates the node with the result.
  registerDataBinding(
    componentId: string,
    fetcher: () => Promise<unknown>,
    options?: { pollIntervalMs?: number },
  ): void;
}
```

## Data shapes

No persisted data. The runtime is stateless; per-page registrations live in memory.

```ts
// Inline registration shape (emitted into the page by the publish pipeline):
// <script>
//   window.__framerRuntime?.registerDataBinding('comp_abc', async () => {
//     const res = await fetch('/api/cms/posts/123');
//     return res.json();
//   }, { pollIntervalMs: 30000 });
// </script>
```

The runtime touches the DOM, never MST (MST does not exist in published-site context). This is the cleanest possible separation.

## Test plan

- [ ] Unit: `runtime.test.ts` in JSDOM. (a) `findByFingerprint` returns the right element, null otherwise. (b) `mutateNode` patches attributes, text, style without clobbering siblings. (c) `applyExperimentVariant` no-ops gracefully when no variants are registered.
- [ ] Unit: `registerDataBinding` calls the fetcher on register and again after the poll interval (use fake timers).
- [ ] Integration: bundle the runtime, embed in a published HTML fixture, load in a real browser (Playwright or vitest browser), call `__framerRuntime.mutateNode` and assert the DOM updates.
- [ ] Bundle size check: assert gzipped output is under 5 KB. Fail the build if it grows past 8 KB without a flag.
- [ ] Manual: open a published page from the Wave 2 publisher with the runtime injected, run `window.__framerRuntime.findByFingerprint('...')` from devtools, eyeball.

## Definition of done

- [ ] Runtime bundle builds via `pnpm build` (or equivalent) into a single JS file
- [ ] All public API methods implemented at stub level and pass unit tests
- [ ] Integration test passes in real browser
- [ ] Bundle size budget respected
- [ ] `projectPublisher` injects the script tag when configured
- [ ] No regressions in zero-JS publish path (sites without runtime opt-in stay zero-JS)
- [ ] Spec status moved to `done` in STATUS.md

## Open questions

- **Bundle distribution.** Self-host on the same domain as the published site (simple, no CORS) or pin to a CDN URL the publish pipeline references? Self-host wins for v1; flag.
- **Versioning.** When the runtime API evolves, published sites pinned to an old bundle keep working but lose new features. Do we content-hash the runtime URL per publish (immutable, no upgrades) or float a `runtime-latest.js` URL (auto-upgrades, breakage risk)? Content-hash per publish recommended.
- **Lumitra Studio ownership.** `applyExperimentVariant` is conceptually Lumitra-owned. Should this spec stub it and let Lumitra-Studio track replace, or should Lumitra-Studio own the runtime island entirely? Cross-track question. Spec defaults to "stub here, polish in Lumitra Studio integration phase".
- **CSP and inline scripts.** The publish pipeline currently injects a script tag. Inline registrations (e.g., `<script>window.__framerRuntime?.register(...)</script>`) violate strict CSP. Wave 3 may need to externalize registrations into a per-page `bindings.json` the runtime fetches.
- **Performance budget.** What is the latency target for first variant application after page load? Lumitra Studio plan likely answers; align here.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (recommendation 3: "Define `window.__framerRuntime.applyExperimentVariant` as a tiny vanilla-JS module independent of React")
- Cross-track: lumitra-studio (consumer), data-bindings (Wave 3 hydration plug-in)
- Code touchpoints: `src/lib/renderer/publish/projectPublisher.ts`
