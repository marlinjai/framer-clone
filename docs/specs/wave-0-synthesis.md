---
type: documentation
title: Wave 0 synthesis (Phase 1 spec decomposition)
summary: Cross-track integration map, open architectural decisions, and Wave 1 dispatch readiness.
date: 2026-05-06
---

# Wave 0 synthesis

Six parallel spec-writing agents decomposed Phase 1 into 44 leaf specs across three execution waves. This document is the integration view: what the agents agreed on, what they disagreed on, and what Marlin must decide before Wave 1 dispatch.

## Inventory

| Track | Wave 1 | Wave 2 | Wave 3 | Total |
|-------|--------|--------|--------|-------|
| cms | 3 | 5 | 1 | 9 |
| multiplayer | 4 | 3 | 2 | 9 |
| data-bindings | 3 | 3 | 1 | 7 |
| ai-pattern-a | 4 | 2 | 1 | 7 |
| static-html | 2 | 3 | 1 | 6 |
| lumitra-studio | 2 | 3 | 1 | 6 |
| **Total** | **18** | **19** | **7** | **44** |

## Cross-track integration map

These are the seams where two or more tracks must agree on a contract. Each is the kind of thing a bad decomposition silently breaks.

### Agreed (no decision needed, just verify spec alignment)

1. **Resolver stays React-free** under `src/lib/bindings/resolver/*` so the static-html build-time path can evaluate bindings in Node. Confirmed by both `data-bindings` and `static-html` agents. **Action:** none, alignment is in the specs.

2. **Static HTML head injection seam.** `static-html-publish-pipeline` exposes a `transformHead` hook. `lumitra-studio-snippet-injection` consumes it. Confirmed in both tracks. **Action:** when the publish-pipeline spec is dispatched, the worker must implement the hook signature exactly as the snippet spec assumes.

3. **AI tool schema registry pre-declares Phase 2 tools** with `registered: false` stubs. A grep on `mutates: true` enumerates the Yjs cutover surface. Coordinates the `ai-pattern-a` to `multiplayer` migration cleanly. **Action:** none.

4. **MST mutation tagging.** Every spec that writes MST is tagged "MST-WRITE" in the body. Wave 2 multiplayer cutover (yjs-mst-binding-full) inverts the writers: after that lands, every MST-WRITE either becomes a Yjs write or is removed. **Action:** none.

### Needs decision before Wave 1 dispatch

5. **CMS runtime: Workers vs Coolify Node.js.** Plan says "Single Cloudflare Worker (or Hetzner Coolify Node.js)". CMS agent recommends Coolify because Prisma and long migrations push hard against Workers. **Decision needed before `cms-service-scaffold` dispatches.** Recommendation: Coolify. Cost: same Hetzner ops envelope as everything else. Risk: moving away from Workers if a per-request edge surface ever matters (low for an internal CMS API).

6. **CMS plan internal contradictions.** Original Recommendation paragraphs 1 (RLS-first deferred isolation) and 2 (service-account global key) are reversed by Revisions B and H. Specs correctly follow the revisions. The plan still reads contradictory for any future reader. **Decision needed:** edit the plan to strike the original paragraphs, or leave them with a note. Recommendation: edit the plan, then promote to `status: decided` since the architectural points are settled.

### Needs decision before Wave 2 dispatch

7. **AI vs human mutation precedence in multiplayer.** Both agents (multiplayer and ai-pattern-a) converged on the same default: human edit aborts the AI turn via an SSE `conflict` event. Alternative: let Yjs CRDT-merge both. **Decision needed before AI canvas-mutation-tools or multiplayer-yjs-mst-binding-full lands.** Recommendation: human-aborts-AI. CRDT-merge produces unintended hybrid states the user did not author.

8. **AI turn origin tagging in Y.UndoManager.** AI patches get origin `ai-<runId>`. Open question: does the initiating user's undo stack include the AI turn?
    - **Option A (proposed by ai-pattern-a):** AI is excluded from all `trackedOrigins` by default. AI turns are never undone via Cmd+Z.
    - **Option B (alternative):** AI turn origin tagged with the initiating user's id, so user A can Cmd+Z their own AI prompts. Other users cannot.
    Recommendation: Option B. User intuition is "I asked the AI to do X, now I undo X". Option A breaks that.

9. **Yjs canonical cutover removes legacy MST writes.** Wave 2 `multiplayer-yjs-mst-binding-full` flips Yjs to canonical. After it lands, every MST-WRITE callsite is either removed or routed through Yjs. **Decision needed:** confirm we delete the legacy direct-MST path (no backcompat). Marlin's existing memory `feedback_pre_mvp_no_backcompat.md` says yes; surfacing for explicit ack since this is a destructive change.

### Strategic / external

10. **Lumitra Studio Phase A/B not specced in `analytics-platform`.** No formal Phase A or Phase B specs exist there. The closest is a `status: draft` framework-agnostic-analytics-architecture plan. Lumitra-studio specs were written against best inference and may need revision when analytics-platform commits. **Decision needed:**
    - Ship Wave 1 lumitra-studio specs (component-id attribution + project binding) as foundation regardless. Both are framer-clone-internal and low-risk.
    - **Defer Wave 2/3** lumitra-studio work until analytics-platform writes its Phase A spec. Recommendation: yes, defer, OR start a parallel Wave 0 spec-writing pass on the analytics-platform side.

11. **Auth-brain seam.** Auth-brain v1 SDK is ~4 to 6 weeks out per the auth-brain design spec. Multiplayer (Wave 1 `auth-brain-seam`) and CMS (Wave 1 `auth-middleware-dual-principal`) ship stubs. Production deploy of multiplayer and CMS both require the real adapter. **No decision needed:** sequencing is correct, just call out that Wave 1 work can land but production deploy waits.

## CMS API contract: data-bindings <-> cms

The data-bindings agent declared the read-side contract it depends on:

- `listCollections() -> Collection[]`
- `getCollection(id) -> Collection`
- `listRows(collectionId, query) -> { rows: Row[], cursor: string | null }`
- `getRow(collectionId, rowId) -> Row`
- `Row.values` keyed by `Column.id` (stable slug, not display name)
- Filter ops: `eq | ne | gt | lt | contains`
- Cursor pagination, default polling cadence 5s

The CMS agent's `cms-row-crud-api` aligns at a high level (filter + sort + cursor + ETag). **Action when both specs are dispatched:** workers must cross-reference and surface drift early.

## Wave 1 dispatch readiness

Wave 1 has 18 specs. After Marlin decides on items 5 and 6 above:

- **15 specs are unblocked** and can dispatch immediately to workers.
- **3 specs** are minor variants of overlapping concerns:
  - `lumitra-studio-component-id-attribution` overlaps `static-html-data-component-id-fix`. Same code surface, different framing. **Action:** dispatch one worker on the bug fix, the other spec becomes a checklist verification.
  - `cms-service-scaffold` blocks on the runtime decision (item 5).
  - `cms-tenant-schema-bootstrap` and `cms-auth-middleware-dual-principal` chain after `cms-service-scaffold`.

Suggested Wave 1 dispatch order (after decisions land):

```
batch A (parallel, 6 workers):
  static-html-data-component-id-fix  (subsumes lumitra-studio-component-id-attribution)
  multiplayer-yjs-doc-shape
  ai-pattern-a-anthropic-sdk-bootstrap
  ai-pattern-a-mst-snapshot-serializer
  data-bindings-binding-shape-on-component-model
  data-bindings-data-source-provider-interface
  lumitra-studio-project-binding
  cms-service-scaffold (after runtime decision)

batch B (parallel, after batch A):
  static-html-spike
  multiplayer-hocuspocus-server-scaffold
  multiplayer-yjs-mst-binding-slice
  ai-pattern-a-tool-schema-registry
  data-bindings-component-registry-bindable-slots
  cms-tenant-schema-bootstrap

batch C (parallel, after batch B):
  ai-pattern-a-read-tools-and-context
  multiplayer-auth-brain-seam
  cms-auth-middleware-dual-principal
```

## Decisions matrix (the ask)

| # | Decision | Block | Recommendation |
|---|----------|-------|----------------|
| 5 | CMS runtime | Wave 1 (cms-service-scaffold) | Coolify Node.js |
| 6 | Edit CMS plan to remove contradictory paragraphs | Cleanup, not blocking | Edit plan + promote to `decided` |
| 7 | AI mutation conflict resolution | Wave 2 (canvas-mutation-tools, yjs-mst-binding-full) | Human-aborts-AI via SSE `conflict` event |
| 8 | AI undo origin tagging | Wave 2 (canvas-mutation-tools, per-user-undo) | Tag with initiating user; user A can undo, others cannot |
| 9 | Delete legacy MST writes after Yjs cutover | Wave 2 (yjs-mst-binding-full) | Yes, no backcompat (consistent with `feedback_pre_mvp_no_backcompat`) |
| 10 | Lumitra Studio Wave 2/3 sequencing | Wave 2 (lumitra-studio specs) | Ship Wave 1 only; defer W2/W3 until analytics-platform Phase A spec lands |

## Suggested next moves

1. **Marlin:** decide items 5 through 10. Items 5 and 6 are blocking Wave 1 dispatch; the others can be parked until Wave 2 prep.
2. **Marlin:** spot-check 3 to 5 specs across different tracks to gut-check decomposition quality. Specifically recommend:
    - `cms-tenant-schema-bootstrap.md` (most complex backend spec)
    - `multiplayer-yjs-mst-binding-slice.md` (the de-risking spike)
    - `data-bindings-binding-shape-on-component-model.md` (touches MST shape)
    - `ai-pattern-a-tool-schema-registry.md` (cross-track keystone)
    - `static-html-data-component-id-fix.md` (must-fix bug, simplest spec)
3. **After approval:** dispatch Batch A as parallel workers in worktree isolation.
4. **Future Wave 0 task:** if Lumitra Studio Wave 2/3 is deferred (item 10), schedule a parallel Wave 0 pass on the `analytics-platform` repo to spec Phase A there.

## Hard constraints carrying forward

- Decomposition quality dominates. The synthesis above is the integration view. If a worker finds a spec is wrong mid-execution, halt the worker and revise the spec, do not let workers improvise.
- MST-touching work in Wave 1 must be serialized OR confined to the binding-shape spec (which owns the MST node modification).
- Yjs becomes canonical in Wave 2. Any Wave 1 spec that adds new direct-MST writers makes the Wave 2 cutover harder. Workers should write minimal new MST surface in Wave 1.
- The last 20 percent (integration, edge cases) does NOT compress with agents. Wave 4 is human-led and serial.
