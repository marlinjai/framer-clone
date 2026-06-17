---
name: slice1-agent-tools-and-cli
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-admin-http-routes]
touchesSharedState: true
sharedState: [lockfile]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# Five agent tools (create_client/create_project/create_offer/add_line_item/transition_offer) + lumitra CLI wrapper, schema-validated

> Slice 1 spec 7 of 8. Critique fix applied: the "one shared domain" DoD now asserts both the route handler and the tool handler INVOKE the same `offerService` function (spy/mock hit identically from both surfaces), not merely that they produce the same fixture output.

## Goal

The agent-first surface. Define the five domain tools as Anthropic structured-output tool schemas (Zod -> JSON schema) so the agent literally cannot emit an invalid status transition or a line item missing unit_price. Each tool is a thin typed call into the SAME domain service the HTTP routes call (one shared API, no parallel logic). A `lumitra offers ...` CLI wraps the same domain calls.

## Scope

**In:**
- Five tool schemas: `create_client`, `create_project`, `create_offer`, `add_line_item`, `transition_offer`, each Zod-validated and exported as Anthropic-tool-compatible JSON schema.
- Each tool handler delegates to `offerService`/`clientService`/`projectService` (the same functions the routes call).
- `lumitra offers` CLI bin (create-client, create-project, create-offer, add-line-item, transition, send).

**Out (explicitly deferred):**
- A standalone agent API or LLM client (the LLM loop is a consuming-app concern; network LLM calls stay server-side per the director-core principle).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/offers/agent/tools.ts` | new | the 5 tool definitions (name, Zod input, handler delegating to domain) |
| `src/server/offers/agent/toolSchemas.ts` | new | Zod -> Anthropic JSON schema export |
| `src/cli/offers.ts` | new | lumitra offers CLI |
| `package.json` | edit | bin entry + zod-to-json-schema |
| `src/server/offers/agent/__tests__/tools.test.ts` | new | validation + shared-domain assertion |

## API surface

```ts
export const offerTools = [
  { name: 'create_client',     input: ZodClientInput,     handler: (i) => clientService.create(i) },
  { name: 'create_project',    input: ZodProjectInput,    handler: (i) => projectService.create(i) },
  { name: 'create_offer',      input: ZodOfferInput,      handler: (i) => offerService.createOffer(i) },
  { name: 'add_line_item',     input: ZodLineItemInput,   handler: (i) => offerService.addLineItem(i.offer_id, i) },
  { name: 'transition_offer',  input: ZodTransitionInput, handler: (i) => offerService.transitionOffer(i.offer_id, i.new_status, { kind:'agent' }) },
] as const;
export function toAnthropicTools(): AnthropicToolDef[]; // Zod -> JSON schema
```

## Test plan

- [ ] Unit: each tool rejects an invalid payload (e.g. `transition_offer` with illegal new_status, `add_line_item` missing unit_price) BEFORE any DB write.
- [ ] Integration: `create_client -> create_project -> create_offer(3 lines) -> transition_offer(active)` asserts ANG number, totals, Activity entries.
- [ ] Shared-domain: a spy/mock on `offerService.createOffer` is hit identically from BOTH the route handler and the tool handler (proves no parallel logic, holistic 2.5).
- [ ] CLI: the bin runs the same tools end-to-end against Dockerized Postgres and prints the created offer number.

## Definition of done

- [ ] Five tool schemas defined, validated, exported as Anthropic JSON schema.
- [ ] Invalid-payload rejection test passes before any write.
- [ ] Shared-domain spy assertion passes (route and tool invoke the same offerService fn).
- [ ] CLI bin works end-to-end.
- [ ] `pnpm exec tsc --noEmit` + tests pass.
- [ ] No standalone agent API or LLM client built.

## Open questions

- None blocking.

## References

- Plan: holistic plan 5.5, 2.5 (one shared API)
