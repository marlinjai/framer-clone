---
name: static-html-data-binding-hydration
track: static-html
wave: 3
priority: P1
status: draft
depends_on: [static-html-publish-pipeline, static-html-runtime-island]
estimated_value: 8
estimated_cost: 6
owner: unassigned
---

# Hydrate read-only data bindings into the static HTML output

## Goal

Phase 1 sites are read-only with respect to end-users, but they DO display CMS-managed content (lists, detail pages, conditional sections). The static HTML pipeline needs a clean story for how a component bound to a CMS query gets its data into the page. Two shapes are on the table: (a) fetch at publish time and bake into the HTML, (b) ship a placeholder and fetch at request time via the runtime island. This spec implements both, picks one as the default, and architects the Phase 2 seam (write data-bindings, end-user-scoped reads) without building it. It is the integration point between the `static-html` track and the `data-bindings` track.

## Scope

**In:**
- New module `src/lib/renderer/publish/dataBindingResolver.ts` that walks the MST tree, collects every component carrying a CMS binding (shape defined by the `data-bindings` track), and produces a binding plan: which bindings are publish-time-resolvable, which require request-time hydration.
- Two execution modes:
  - **Publish-time mode.** During `publishProject`, fetch each binding's data, splice the resolved values into the HTML before serialization. Components with bound props get real values baked in; downstream layout and SEO benefit (content is in the HTML at first byte).
  - **Request-time mode.** Emit `<script>` registrations against `window.__framerRuntime.registerDataBinding` from the Wave 2 runtime island. The page ships with placeholders; the runtime fetches and hydrates after load.
- Default: publish-time for everything resolvable. Bindings flagged `live: true` (e.g., a "latest news" feed where staleness matters) fall through to request-time. The flag lives on the component's binding metadata.
- Test fixtures that cover both modes against a fake CMS adapter.

**Out (explicitly deferred):**
- The CMS service itself, schema, multi-tenant ops (cms track).
- The component-side binding API (data-bindings track).
- Push-based real-time (LISTEN/NOTIFY+SSE, Supabase Realtime). Phase 1 ships polling only; Phase 2 may revisit.
- Write data-bindings (Form submission, LoginForm). Phase 2.
- End-user-scoped reads (queries that depend on the logged-in app_user). Phase 2 once auth-brain Phase 3.5 / Option B end-user auth lands.
- Schema-evolution UX (column rename / delete on populated collections). Open architectural question, not blocking.
- OIDC integration for service-account reads. Phase 2.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/publish/dataBindingResolver.ts` | new | Walk + classify + resolve binding plans. |
| `src/lib/renderer/publish/dataBindingHydrator.ts` | new | Splice publish-time results into HTML and emit request-time registration scripts. |
| `src/lib/renderer/publish/__tests__/dataBindingResolver.test.ts` | new | Unit tests on classification (live vs static, valid vs missing). |
| `src/lib/renderer/publish/__tests__/dataBindingHydrator.test.ts` | new | Unit tests on output splicing. |
| `src/lib/renderer/publish/projectPublisher.ts` | edit | Wire the resolver + hydrator into the publish flow. Optional `cmsAdapter` in `PublishOptions`. |
| `src/lib/renderer/publish/runtime/dataBindings.ts` | edit | Wave 2 stub fleshed out: actual fetch, polling timer, error fallback. |

## API surface

```ts
// src/lib/renderer/publish/dataBindingResolver.ts
export interface BindingPlan {
  componentId: string;
  bindingKey: string;
  query: unknown; // shape owned by data-bindings track
  mode: 'publish-time' | 'request-time';
  pollIntervalMs?: number; // request-time only
}

export interface CmsAdapter {
  // Read-only, server-side, scoped to the publish actor (site-owner only in Phase 1).
  fetch(query: unknown): Promise<unknown>;
}

export function planBindings(project: ProjectModelType): BindingPlan[];
export function resolvePublishTimeBindings(
  plans: BindingPlan[],
  adapter: CmsAdapter,
): Promise<Record<string, unknown>>; // componentId -> resolved value
```

## Data shapes

```ts
// Publish-time: resolved values spliced directly into HTML (no runtime needed for that node).
// Request-time: emitted as inline registrations the runtime picks up.

// <script>
// (function () {
//   const reg = () => window.__framerRuntime?.registerDataBinding(
//     'comp_abc',
//     () => fetch('/api/cms/q/abc').then(r => r.json()),
//     { pollIntervalMs: 30000 },
//   );
//   if (window.__framerRuntime) reg();
//   else window.addEventListener('framer-runtime-ready', reg, { once: true });
// })();
// </script>
```

The renderer touches MST in read-only mode. The CMS adapter is invoked during publish only; static-html code never writes to MST or to CMS.

## Test plan

- [ ] Unit: `dataBindingResolver.test.ts`. Fixture project with three bound components (one publish-time-eligible, one `live:true` → request-time, one with malformed query → omitted with warning). Assert plan shape.
- [ ] Unit: `dataBindingHydrator.test.ts`. Given a plan + a fake adapter that returns deterministic values, assert publish-time results splice into HTML at the right `data-inner-component-id` selector, and request-time registrations appear as inline scripts.
- [ ] Integration: full publish run against a fixture project + a fake CMS adapter. Output bundle has correct content baked in, plus a registration script for live bindings.
- [ ] Integration (browser): load published page in Playwright, runtime island present, assert request-time bindings hydrate within 1 second and the DOM mutates as expected.
- [ ] Manual: Marlin runs publish on a page that pulls a CMS list, eyeballs the output for both modes (toggle `live` flag).

## Definition of done

- [ ] Resolver, hydrator land and typecheck
- [ ] Unit + integration tests pass
- [ ] `projectPublisher` integrates with the new modules and stays backward-compatible (projects with no bindings publish unchanged)
- [ ] Runtime island registers, polls, and mutates DOM correctly for live bindings
- [ ] No regressions in static-html publish for non-bound projects
- [ ] Phase 2 seams documented inline (where end-user-scoped reads will plug in)
- [ ] Spec status moved to `done` in STATUS.md

## Open questions

- **Default mode: publish-time vs request-time.** Spec recommends publish-time for everything not flagged `live`. Investor demos and SEO want HTML-first; runtime hydration causes layout shift. Marlin to confirm before merge.
- **Republish-on-CMS-edit UX.** If the default is publish-time, every CMS edit needs a republish to show up. Is that triggered manually (publish button), webhook from CMS service, or scheduled? Cross-track decision with `cms` track.
- **CMS adapter shape and authorization.** Publish-time fetches run server-side under a service-account scoped per published app (per the strategic-thesis decision). Request-time fetches go through a runtime endpoint that also authorizes per-app. Both need a clean API contract with the cms track. Cross-track dependency: must not block on full CMS service; design for swap-in later.
- **Pagination, sorting, filtering.** Phase 1 may only need "fetch a list, render it". Phase 2 likely wants query params from URL. Reserve the seam.
- **Cache control.** Publish-time results are stale-by-publish-time. Request-time results poll. Should the runtime cache between polls? What's the ETag / Last-Modified story? Defer until customer signal.
- **Fallback content.** What does the user see while a request-time binding is loading? Skeleton, last-known value (requires runtime cache), nothing? UX decision; flag.
- **Phase 2 seams to architect now.** Component binding metadata should already carry an optional `principal: 'site-owner' | 'app-user'` field that defaults to `'site-owner'` in Phase 1. The resolver should refuse to publish-time-resolve `app-user` bindings (they require a logged-in end-user; only request-time is sound). Reserve the field; do not implement Phase 2 logic.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (recommendation 3: framework-neutral runtime)
- Plan (cross-track): `docs/plans/2026-05-05-cms-data-layer-research.md` (Shape A: hosted multi-tenant Postgres, schema-per-tenant; Phase 1 polling, Phase 2 push)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` ("Real-time on published apps: Phase 1 ships polling")
- Cross-track: data-bindings (component-side binding API), cms (service backing), lumitra-studio (variants apply on top of resolved bindings)
- Code touchpoints: `src/lib/renderer/publish/projectPublisher.ts`, `src/lib/renderer/publish/runtime/dataBindings.ts`
