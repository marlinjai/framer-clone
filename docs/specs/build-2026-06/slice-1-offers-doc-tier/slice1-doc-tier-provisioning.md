---
name: slice1-doc-tier-provisioning
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: []
touchesSharedState: true
sharedState: [lockfile, prisma]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# Idempotent provisioning of the 5 offers/CRM collections + relations over adapter-prisma (one schema)

> Build sequence reference: see `docs/specs/build-2026-06/ROADMAP.md`. This is Slice 1 spec 1 of 8.
> Critique fixes applied (see end of file): relations declared via `createColumn(type:'relation')` not `createRelation`; the full 8-model Prisma datasource including `SelectOption`; money/default-value assertions moved to the domain/serialization layer.

## Goal

Stand up the data-table document tier that the offers/CRM domain runs on, single-tenant, in-process, inside lumitra-web. Add `@marlinjai/data-table-adapter-prisma@0.2.1` plus `@prisma/client` and `prisma` as dependencies, lay down the adapter-prisma Prisma datasource against ONE Postgres schema, and write an idempotent `provisionDocTier()` that creates the 5 collections (Clients, Projects, Offers, LineItems, Activities) as real Postgres tables with their relation columns and select option sets. This is the substrate; the atomic write path and all domain logic live in sibling specs.

## Scope

**In:**
- Add deps: `@marlinjai/data-table-adapter-prisma@0.2.1` (from public npm, NOT workspace), `@prisma/client@^6.9.0`, `prisma@^6.9.0`, `vitest`.
- Copy the adapter's `prisma/schema.prisma` VERBATIM (all 8 models, see Data shapes) into lumitra-web `prisma/schema.prisma`, datasource pointed at `DATABASE_URL`.
- `provisionDocTier(adapter, workspaceId)`: creates the 5 collections via `adapter.createTable` + `adapter.createColumn`, the 4 relations via `adapter.createColumn({ type:'relation', config:{ targetTableId } })`, and the select option sets via `adapter.createSelectOption`.
- Idempotency: looks up existing `DtTable` rows by a stable seed key before creating; second run is a no-op and returns the same ids.
- A seed-key registry persisting stable collection identifiers -> `DtTable` ids so sibling specs resolve collections by name.
- The verbatim section-5.1 column manifest, including `variant_ref` (nullable TEXT carrier) and `variant_ref_source` (select `none|datatable|owned`).

**Out (explicitly deferred):**
- Any domain logic: numbering, totals, status machine, Activity writer (sibling spec `slice1-domain-numbering-totals-status-activity`).
- The atomic multi-row write path (sibling spec `slice1-repository-and-withtenant-seam`).
- The BoardView (sibling spec `slice1-crm-boardview-wiring`).
- Any commerce engine, multi-tenant CMS service, or HTTP routes.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `package.json` | edit | add adapter-prisma@0.2.1, @prisma/client@^6.9.0, prisma@^6.9.0, vitest |
| `prisma/schema.prisma` | new | adapter-prisma datasource copied VERBATIM (8 models) |
| `src/server/offers/docTier/schema.ts` | new | the 5 collection column manifests (integer-cents money columns, variant_ref/variant_ref_source) |
| `src/server/offers/docTier/provision.ts` | new | `provisionDocTier`, `COLLECTION_KEYS`, `resolveCollectionId` |
| `src/server/offers/docTier/adapterClient.ts` | new | builds `PrismaClient` + `PrismaAdapter` from `DATABASE_URL` |
| `src/server/offers/docTier/__tests__/provision.test.ts` | new | idempotency + option-set + select round-trip |

## API surface

```ts
// src/server/offers/docTier/provision.ts
export const COLLECTION_KEYS = {
  clients: 'lumitra.clients',
  projects: 'lumitra.projects',
  offers: 'lumitra.offers',
  lineItems: 'lumitra.line_items',
  activities: 'lumitra.activities',
} as const;

export interface ProvisionResult {
  tableIds: Record<keyof typeof COLLECTION_KEYS, string>;
  columnIds: Record<string, Record<string, string>>; // tableKey -> fieldName -> columnId
}

export async function provisionDocTier(
  adapter: PrismaAdapter,
  workspaceId: string,
): Promise<ProvisionResult>;

export async function resolveCollectionId(
  adapter: PrismaAdapter,
  key: keyof typeof COLLECTION_KEYS,
): Promise<string | null>;
```

## Data shapes

The Prisma datasource is copied VERBATIM from `data-table/packages/adapter-prisma/prisma/schema.prisma`. It has EIGHT models, do NOT hand-retype a 7-model subset:

```
model DtTable          @@map("dt_tables")
model DtColumn         @@map("dt_columns")
model SelectOption     @@map("select_options")   // REQUIRED: createSelectOption writes here (adapter.ts:282)
model DtRowSelectValue @@map("dt_row_select_values")
model DtRelation       @@map("dt_relations")
model DtFile           @@map("dt_files")
model DtView           @@map("dt_views")
model DtRow            @@map("dt_rows")            // legacy row model
```

Relations are declared as relation-TYPE COLUMNS at provisioning time (no rows exist yet):

```ts
// Project.client, Offer.client, Offer.project, LineItem.offer
await adapter.createColumn({
  tableId: projectsTableId,
  name: 'client',
  type: 'relation',
  config: { targetTableId: clientsTableId } satisfies RelationColumnConfig,
});
// adapter.createColumn at data-table adapter.ts:193
// type 'relation' is a JUNCTION_TYPE (type-mapping.ts): no real SQL column, the link lives in dt_relations.
// adapter.createRelation (adapter.ts:670) is ROW-TIME ONLY (sourceRowId/targetRowId) and is used by the
// domain layer's row-write path, NEVER at provisioning.
```

Column manifest (section 5.1 verbatim). Money columns are `number` type but storage is TEXT (every scalar user column is plain TEXT per ddl.ts:30,69); cents math and the `'none'` default for `variant_ref_source` are owned by the domain/serialization layer, NOT a DB DEFAULT:

- Client: name(text), type(select), email(text), phone(text), address(text), vat_id(text), status(select)
- Project: name(text), client(relation->Clients), stage(select), budget(number, integer cents), due_date(date)
- Offer: title(text), client(relation->Clients), project(relation->Projects), stage(select: Lead/Qualified/Offer Sent/Won/Lost), status(select: draft/active/accepted/completed/cancelled), subtotal(number, cents), tax_amount(number, cents), total_amount(number, cents), valid_until(date), customer_notes(text), internal_notes(text), accepted_at(date), completed_at(date), cancelled_at(date)
- LineItem: offer(relation->Offers), item_type(select), title(text), quantity(number), unit(select), unit_price(number, cents), total_price(number, cents), tax_amount(number, cents), tax_rate(number), discount_percentage(number), variant_ref(text, nullable), variant_ref_source(select: none|datatable|owned)
- Activity: subject_type(select), subject_id(text), event_type(select), actor(text), previous_status(text), new_status(text), note(text)

## Test plan

- [ ] Integration (Dockerized Postgres): `provisionDocTier` creates 5 collections + 4 relation columns + option sets; second call creates nothing and returns identical ids.
- [ ] `prisma generate` succeeds and the generated client exposes a `selectOption` delegate.
- [ ] Smoke: `createSelectOption` + `getSelectOptions` round-trips for `Offer.stage` (Lead/Qualified/Offer Sent/Won/Lost).
- [ ] Select columns carry the exact option sets from section 5.1.
- [ ] Money values round-trip as integer-cents strings through `serializeCell`/`deserializeCell`; `variant_ref_source` defaults to `'none'` applied at the DOMAIN layer on insert (NOT asserted via `information_schema.column_default`).
- [ ] `variant_ref` is nullable TEXT (vacuously true: every column is nullable TEXT; assert it accepts null).

## Definition of done

- [ ] `provisionDocTier(adapter, workspaceId)` creates all 5 collections + 4 relation columns on a fresh schema and is verifiably idempotent.
- [ ] `prisma generate` succeeds; client exposes `selectOption`; `createSelectOption`/`getSelectOptions` smoke test passes.
- [ ] Seed-key registry persists stable collection identifiers -> ids; `resolveCollectionId` works.
- [ ] `pnpm exec tsc --noEmit` and the new Vitest suite pass.
- [ ] No domain logic (numbering/totals/status) in this spec.

## Open questions

- None blocking. The Postgres instance for Slice 1 is a dedicated Hetzner-managed Postgres (one schema, hard-coded tenant); `DATABASE_URL` injected by Coolify at build, never in `.env`. (See ROADMAP open decisions.)

## References

- Plan: `knowledge-base/research/2026-05-31-holistic-lumitra-platform-plan.md` section 5.1
- Code touchpoints: data-table `packages/adapter-prisma/src/adapter.ts` createTable:91, createColumn:193, createSelectOption:282, createRelation:670 (row-time only); `prisma/schema.prisma` (8 models); `src/ddl.ts:30,69` (TEXT storage), `:91` (expression index)
