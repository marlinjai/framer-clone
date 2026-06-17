---
name: slice2-read-binding-resolver-runtime
track: cms-content-tier
wave: 1
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [track0-backend-foundation]
touchesSharedState: true
sharedState: [vitest-config]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# React-free read-binding resolver runtime (Node-evaluable, build-time safe)

> Depends ONLY on Track 0 (for the vitest `projects` substrate it consumes; no other coupling). NO doc-tier-core coupling. The resolver is PURE, provider-free, React-free, so the static-publish path can evaluate bindings in Node at build time. It SUPERSEDES the wave-2 `applyBindings(node, props, scope, dataSource)` signature with a PROVIDER-FREE `applyBindings(node, baseProps, scope)` (callers feed already-fetched rows).

> SHARED-STATE NOTE (vitest-config): Track 0 is the SOLE owner of the `vitest.config.ts` `projects` migration (jsdom project for `src/**`, node project for `src/server/**` + the resolver). Because this spec now `dependsOn: [track0-backend-foundation]`, Track 0 has already merged before this spec launches, so this spec ONLY ADDS its resolver test glob to the existing node project (additive, no restructure, no migrate branch). This collapses the prior migrate-vs-additive ambiguity into a single deterministic path and makes the `vitest-config` serialization explicit in the dep graph (not just an implicit shared-state lock).

## Goal

The expression parser, scope chain, and `applyBindings`, all under `src/lib/bindings/resolver/*` with ZERO React imports so the static-publish path can evaluate bindings in Node at build time. Mustache-style `{{path.segments}}` only. Never throws on miss.

## Scope

**In:**
- `expression.ts`: `parseExpression`, `evaluateExpression`. Single-segment `{{title}}` resolves against the innermost row frame; multi-segment `{{row.title}}`, `{{collection.name}}`, `{{page.params.id}}`. No JS expressions, no filters, no method calls. Returns `null` for `{{a + b}}`. Returns `undefined` (NEVER throws) on unknown paths.
- `scope.ts`: `BindingScope`, `BindingFrame`, `pushRowFrame`, `pushCollectionFrame`, `lookup`.
- `applyBindings.ts`: `applyBindings(node, baseProps, scope)` (PROVIDER-FREE: callers feed already-fetched rows). Merges resolved value into `props.children` for Text nodes and into `style.X` for dot-path slots; returns `isLoading:true` when any slot is `LOADING_SENTINEL`. Memoization per (binding, scope-snapshot) within a render pass.
- vitest-config: ensure resolver tests run under `environment:'node'` by ADDING the resolver glob to Track 0's existing node project (see SHARED-STATE NOTE: Track 0 owns the `projects` migration, this spec is additive only).

**Out (explicitly deferred):**
- Renderer wiring (data-components spec owns ComponentRenderer/HeadlessComponentRenderer scope threading).
- Commerce scope frames (`pushProductFrame`/`pushVariantFrame`/`pushAvailabilityFrame`): Track C `trackc-commerce-binding-scope-frame-and-resolver` extends THIS module.
- Write bindings.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/bindings/resolver/expression.ts` | new | parse/evaluate, no React |
| `src/lib/bindings/resolver/scope.ts` | new | BindingScope/Frame, push*, lookup |
| `src/lib/bindings/resolver/applyBindings.ts` | new | applyBindings (provider-free), LOADING_SENTINEL |
| `src/lib/bindings/resolver/__tests__/expression.test.ts` | new (node project) | parse + lookup |
| `src/lib/bindings/resolver/__tests__/applyBindings.test.ts` | new (node project) | merge + isLoading + node-env |
| `vitest.config.ts` | edit | `projects` form: jsdom for `src/**`, node for `src/lib/bindings/resolver/**` (+ `src/server/**`). Regression check on the existing jsdom suite |

## API surface

```ts
// SUPERSEDES the wave-2 applyBindings(node, props, scope, dataSource) signature.
export function parseExpression(input: string): ParsedExpression | null;
export function evaluateExpression(expr: ParsedExpression, scope: BindingScope): unknown;
export interface BindingScope { frames: BindingFrame[] }
export function pushRowFrame(scope: BindingScope, row: Row): BindingScope;
export function pushCollectionFrame(scope: BindingScope, collection: Collection): BindingScope;
export function lookup(scope: BindingScope, path: string[]): unknown; // undefined on miss
export const LOADING_SENTINEL: unique symbol;
export function applyBindings(node: ComponentNode, baseProps: Props, scope: BindingScope):
  { resolvedProps: Props; isLoading: boolean }; // PROVIDER-FREE: rows already fetched by caller
```

## Test plan

- [ ] `src/lib/bindings/resolver/*` has NO React import (grep/lint check).
- [ ] Parser accepts `{{title}}`/`{{row.title}}`/`{{page.params.id}}`, returns null for `{{a + b}}`.
- [ ] `lookup` resolves `page.params.id`, single-segment against innermost row, returns undefined (not throw) on miss.
- [ ] `applyBindings` merges resolved value into `props.children` for a Text node and into `style.X` for dot-path slots; returns `isLoading:true` for LOADING_SENTINEL.
- [ ] Node env: the resolver module imported and run under `environment:'node'` (no jsdom) asserts identical output.
- [ ] Regression: the existing 16-test drag suite + wave-1 bindings tests stay green under the `projects` config (jsdom project unchanged for `src/**`).

## Definition of done

- [ ] Resolver lands with NO React import (enforced by test/lint).
- [ ] Parser + lookup + applyBindings tests pass under the node project.
- [ ] Memoization per (binding, scope-snapshot) within a render pass.
- [ ] `vitest.config.ts` `projects` form runs resolver tests under node env; the existing jsdom suite stays green (regression asserted).
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Critique (minor, RESOLVED): the current `vitest.config.ts` is single jsdom env with no `projects`/`workspace` array; a node-env scope requires the `projects` migration. That migration is now owned solely by Track 0 (which this spec `dependsOn`), so by the time this spec runs the node project already exists and this spec only adds its resolver glob to it. No migrate branch, no jsdom regression risk owned here.
- Code touchpoints: `src/lib/bindings/types.ts` (ReadBinding), `dataSource/types.ts` (Collection/Row), `vitest.config.ts`
- Supersedes: wave-2 `data-bindings-read-binding-resolver-runtime.md` applyBindings signature
