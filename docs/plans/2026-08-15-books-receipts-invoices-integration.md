---
title: "The Books: receipts + invoices as one own-tax-use accounting suite"
type: plan
status: decided
date: 2026-08-15
summary: "Cross-repo plan joining receipt-ocr-app (expenses) and framer-clone commerce (revenue) into a single per-company set of books for Marlin's own tax use. Audits what actually exists, defines the minimal Customer + SalesDocument + DocumentTemplate schema, fixes the identity seam on the auth-brain tenant (company) rather than the workspace, and sequences five phases with per-phase verify commands."
tags: [commerce, invoices, offers, customers, receipts, ocr, auth-brain, tax, gobd, ustg, cross-repo]
projects: [framer-clone, receipt-ocr-app, auth-brain, lumitra]
---

# The Books: receipts + invoices as one own-tax-use accounting suite

Companion pointer: `receipt-ocr-app/docs/plans/2026-08-15-books-integration-pointer.md`.
Backlog intent: `knowledge-base/backlog/intents/receipts-ocr-own-tax-use.md`.
Prior architecture: `knowledge-base/research/2026-06-01-owned-realtime-commerce-architecture.md` (status draft, never decided).

Homed in framer-clone because roughly 85 percent of the new code lands here: the entire document tier (customers, offers, invoices, credit notes, templates, numbering) is new work in `framer-clone/prisma/schema.prisma` and `src/server/`. receipt-ocr-app needs one prerequisite change (tenant awareness) and one read endpoint.

---

## Amendment 2026-10-15: build order, storage tier, historical import

Decided with Marlin on 2026-10-15; supersedes the body where they conflict.

1. **Storage tier.** Section 3 put the document tables in the shared `commerce` schema with a
   row-level `tenantId`, because the per-company schemas were blocked (MT-18). They are no longer
   blocked: the commerce tenant plan (`2026-06-27-commerce-tenant-db-migration-plan.md`) has
   shipped CM-01 to CM-12. The Books tables are therefore written as per-tenant Kysely migrations
   in each tenant group's `tg_<hex32>` schema, beside the commerce tables, and not as Prisma
   models. They keep a `tenant_id` column (the auth-brain company), because one tenant group can
   hold more than one company. The repository code takes the scoped handle like the commerce
   repos; no `withTenant`, no Prisma.
2. **Order.** Books phase 1 starts after CM-10 and CM-13 (the per-company switch and the guard
   checks) and after the app runs again (roadmap lines 1 and 2). Phase 0 (receipts tenant
   awareness) is largely there: receipt-ocr-app's finance tables carry `auth_tenant_id`.
3. **Settings** (from receipt-ocr-app's plan "Invoicing and income" of 2026-10-14): company
   Whiz-Art Media, small-business default (section 19, section 34a fields), invoice numbers
   continue the plain integer series at 62, `Customer` points to the shared contacts database.
4. **Services as products.** Lines for services reference the commerce catalog (`variantRef`,
   already in the schema), so offers, invoices and the shop share one product and service list.
5. **Historical import** (new, after phase 3): invoices 28 to 61 are imported as issued documents
   with `source = import`, their original PDF attached as the document of record and never
   re-rendered, numbers kept as printed (58 under 58, with the corrected copy). The list to
   import from (number, date, amount, payment day; no client names) is in the owner's tax folder,
   `Finanzen/Steuern/2026/ausgangsrechnungen-2024-2026.md`. The numbering counter starts after
   the highest imported number.
6. **Connections** (after the import): the read-only machine endpoint receipt-ocr-app pulls
   issued documents from (section 3's pull model, service-account key, company-scoped),
   storage-brain for PDFs, the shared contacts database for recipients.

## Phase 1 build specification (2026-10-17)

This section is the build order for phase 1, the document domain with no routes and no
interface. It applies the amendment of 2026-10-15 to sections 4 and 5 and supersedes them where
they conflict (the conflicts are listed in P1.12). A builder executes it without asking; every
choice below that the earlier text left open is resolved in place and recorded in 1.12.

**Starts after:** CM-13 (Prisma removed from commerce, the Kysely exports renamed to their
canonical names, the tenant isolation guards in CI, the post-grant REVOKE re-apply in
provisioning) has merged, per amendment item 2. Modules are named by role below ("the order
orchestrator" is `src/server/commerce/order/createOrder.ts`, "the commerce Database interface"
is `src/server/commerce/db-types.ts`, "the scoped handle" is what `commerceTenantDb(tgId)`
returns), so a later rename does not invalidate the spec.

**Where the code goes:**

| What | Path |
|---|---|
| The per-tenant migration | `src/server/commerce/migrations/tenant/007_books.ts`, appended to the tenant migration set in `index.ts` (if CM-13 or anything else has taken id `007`, use the next free id; the id below is written as `007`) |
| The Books domain | `src/server/books/` (new module beside `src/server/commerce/`): `scope.ts`, `errors.ts`, `totals.ts`, `numbering.ts`, `issue.ts`, `cancel.ts`, `recipients.ts`, `settings.ts`, `repository/{customers,documents,lines,read}.ts`, `index.ts` |
| The shared German VAT rules | `src/server/tax/germanVat.ts` (new), imported by both the Books domain and the order orchestrator |
| Types | the commerce Database interface gains the seven Books tables (bare keys, like the commerce tables) |
| Operator script | `scripts/books-init-company.ts`, exposed as `pnpm books:init-company` |

### P1.1 The per-tenant migration `007_books`

Written in the house style of `001` to `006`: raw postgres.js DDL with BARE names (the runner
injects `SET LOCAL search_path = <tg_id>, ext`), `IF NOT EXISTS` where Postgres allows it,
MixedCase enum types double-quoted, ids `TEXT` minted by application code (`randomUUID()`, no DB
default, as in every commerce table), `created_at TIMESTAMP(3) NOT NULL DEFAULT
CURRENT_TIMESTAMP`, `updated_at TIMESTAMP(3) NOT NULL` with no default (stamped by the
repository, as in `001` to `005`), trigger functions created `LANGUAGE plpgsql SET search_path
FROM CURRENT` (the `002`/`003` pattern, so a function body's bare names resolve to its own
schema). The file header comment states the reasoning of each structural guarantee, as the
existing migrations do.

Units, everywhere: money is `INTEGER` cents, tax rates are `INTEGER` basis points (1900 = 19
percent, ceiling 10000), quantities are `INTEGER` thousandths (1.5 hours = 1500), discounts are
`INTEGER` basis points. Calendar dates (issue, service, due) are `DATE`, because an invoice date
is a calendar day and a timestamp invites a time-zone shift. The base handle cannot carry a
custom parser (`createNodeDb` of `@marlinjai/tenant-db` 0.1.0 accepts only the connection
string, pool size and timeouts, and postgres.js parses `DATE` into a JavaScript `Date` at UTC
midnight), so the Books read helpers select every `DATE` column as text through one shared
column list per table (`eb.cast<string>('issue_date', 'text').as('issue_date')`), never with
`selectAll()` on a Books table, and write dates as `YYYY-MM-DD` strings (round-trip test in
P1.10).

**New enum types** (created in `007`; `000_enums` is already applied and is never edited):

```sql
CREATE TYPE "SalesDocType"      AS ENUM ('offer', 'invoice', 'credit_note');
CREATE TYPE "SalesDocStatus"    AS ENUM ('draft', 'issued', 'sent', 'accepted', 'rejected', 'paid', 'cancelled');
CREATE TYPE "SalesDocSource"    AS ENUM ('editor', 'import');
CREATE TYPE "SalesDocLineKind"  AS ENUM ('service', 'product', 'text');
CREATE TYPE "SalesDocEventType" AS ENUM ('draft_created', 'customer_set', 'issued', 'cancelled');
CREATE TYPE "CompanyTaxStatus"  AS ENUM ('small_business', 'regular');
```

The existing `"CustomerType"`, `"NetOrGross"`, `"TaxTreatment"` and `"VariantRefSource"` are
reused, never redefined (section 4's rule).

**`tenant_id` and how it is enforced.** Every Books table carries `tenant_id TEXT NOT NULL CHECK
(tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`, the auth-brain
company id, because one tenant group schema can hold more than one company (amendment item 1).
Enforcement has three layers:

1. **Schema wall** (existing): the scoped handle only reaches its own `tg_<hex32>` schema.
2. **Composite foreign keys** (new, the `003` composite-FK pattern): every table that a Books row
   references has `UNIQUE (tenant_id, id)`, and every reference is `(tenant_id, x_id) ->
   target(tenant_id, id)`. A document of company A can therefore never point at a customer, a
   template or a corrected invoice of company B in the same schema, and a line or event can
   never belong to another company's document, whatever the application code does.
3. **Repository scope**: every Books function takes a `BooksScope = { db, tgId, tenantId }`
   built once per request by `booksScope(db, tgId, tenantId)` (`scope.ts`); every query filters
   `tenant_id = scope.tenantId`, every insert writes it. A row of another company reads as
   `NOT_FOUND`, never as a permission error that confirms it exists. Phase 2's routes build the
   scope from the session's active company after the `books` grant check; phase 1 takes it as an
   argument.

**Table `books_company_settings`** (one row per company: its tax status and sender identity):

| Column | Type | Rule |
|---|---|---|
| `tenant_id` | TEXT | primary key |
| `tax_status` | `"CompanyTaxStatus"` | NOT NULL DEFAULT `'small_business'` |
| `exemption_note` | TEXT | NOT NULL; printed on every document while `tax_status = 'small_business'` |
| `sender_block` | JSONB | NOT NULL; the issuer's legal identity, shape `SenderBlockV1` (P1.5) |
| `default_payment_terms_days` | INTEGER | NOT NULL DEFAULT 14, CHECK `BETWEEN 0 AND 365` |
| `created_at`, `updated_at` | TIMESTAMP(3) | house style |

**Table `document_number_counter`** (one row per company and document type, the only source of
document numbers):

| Column | Type | Rule |
|---|---|---|
| `tenant_id` | TEXT | part of the primary key |
| `doc_type` | `"SalesDocType"` | part of the primary key: `PRIMARY KEY (tenant_id, doc_type)` |
| `next_value` | BIGINT | NOT NULL, CHECK `>= 1`; the number the next issue receives |
| `format` | TEXT | NOT NULL, CHECK `format ~ '^[A-Za-z0-9/._ -]{0,16}\{n(:[1-9])?\}[A-Za-z0-9/._ -]{0,16}$'`; tokens: `{n}` the plain number, `{n:4}` zero-padded to 4 digits; literal text around it |
| `created_at`, `updated_at` | TIMESTAMP(3) | house style |

Trigger `document_number_counter_monotonic` (BEFORE UPDATE): raises SQLSTATE `BK003` when
`NEW.next_value < OLD.next_value`. A counter only ever moves forward.

**Table `customer`** (tax fields only; name, address and customer number live in the shared
contacts database):

| Column | Type | Rule |
|---|---|---|
| `id` | TEXT | primary key |
| `tenant_id` | TEXT | NOT NULL, uuid CHECK |
| `contact_id` | TEXT | NOT NULL; the contact's id in the shared contacts database (no FK: another database) |
| `customer_type` | `"CustomerType"` | NOT NULL DEFAULT `'b2c'` |
| `vat_id` | TEXT | NULL; CHECK `vat_id IS NULL OR vat_id ~ '^[A-Z]{2}[A-Z0-9+*]{2,13}$'` (stored normalized: upper case, no spaces) |
| `country_code` | TEXT | NOT NULL DEFAULT `'DE'`, CHECK `~ '^[A-Z]{2}$'` |
| `tax_number` | TEXT | NULL; the recipient's domestic tax number, informational |
| `archived_at` | TIMESTAMP(3) | NULL |
| `created_at`, `updated_at` | TIMESTAMP(3) | house style |

Constraints and indexes: `UNIQUE (tenant_id, id)` (composite-FK target), `UNIQUE (tenant_id,
contact_id)` (one customer per contact per company). No CHECK ties `vat_id` to `customer_type`: a
business may have no VAT id and that is legal; the combination only matters for reverse charge,
where the shared guard (P1.4) and the document CHECK refuse it.

**Table `document_template`** (layout only; phase 3 renders with it, phase 1 only creates it):

| Column | Type | Rule |
|---|---|---|
| `id` | TEXT | primary key |
| `tenant_id` | TEXT | NOT NULL, uuid CHECK |
| `name` | TEXT | NOT NULL |
| `is_default` | BOOLEAN | NOT NULL DEFAULT false |
| `locale` | TEXT | NOT NULL DEFAULT `'de-DE'` |
| `logo_file_id` | TEXT | NULL (storage-brain file id) |
| `accent_color` | TEXT | NULL, CHECK `~ '^#[0-9a-fA-F]{6}$'` |
| `footer_blocks` | JSONB | NOT NULL DEFAULT `'[]'` |
| `default_intro_text`, `default_outro_text` | TEXT | NULL |
| `created_at`, `updated_at` | TIMESTAMP(3) | house style |

Constraints and indexes: `UNIQUE (tenant_id, id)`, `UNIQUE (tenant_id, name)`, partial unique
`document_template_one_default_key ON (tenant_id) WHERE is_default`. Section 4.5's
`sender_block` and `number_formats` are NOT on the template (they moved to
`books_company_settings` and `document_number_counter`, see P1.12).

**Table `sales_document`** (offer, invoice and credit note in one table, section 4.2):

| Column | Type | Rule |
|---|---|---|
| `id` | TEXT | primary key |
| `tenant_id` | TEXT | NOT NULL, uuid CHECK |
| `doc_type` | `"SalesDocType"` | NOT NULL |
| `status` | `"SalesDocStatus"` | NOT NULL DEFAULT `'draft'` |
| `source` | `"SalesDocSource"` | NOT NULL DEFAULT `'editor'` (`import` is for the historical import after phase 3, amendment item 5) |
| `version` | INTEGER | NOT NULL DEFAULT 0; +1 on every draft mutation (optimistic concurrency for phase 2's editor) |
| `customer_id` | TEXT | NULL while a draft has no customer; required at issue |
| `template_id` | TEXT | NULL |
| `corrects_document_id` | TEXT | NULL; set only on a credit note, the invoice it cancels |
| `source_order_id` | TEXT | NULL; loose link to a storefront `order` (phase 5), no FK |
| `document_number` | TEXT | NULL until issued; the formatted number as printed |
| `number_value` | BIGINT | NULL until issued; the raw counter value (sorting, import checks) |
| `issue_date` | DATE | set at issue |
| `service_date` | DATE | NULL |
| `service_period_start`, `service_period_end` | DATE | NULL; both or neither, start <= end |
| `due_date` | DATE | set at issue for invoices: `issue_date + payment_terms_days` |
| `valid_until` | DATE | offers only (not used in phase 1) |
| `payment_terms_days` | INTEGER | NOT NULL, CHECK `BETWEEN 0 AND 365`; copied from the company setting at draft creation, editable on the draft |
| `payment_reference` | TEXT | set at issue: `'Rechnung ' || document_number` for invoices (receipts plan D5) |
| `contract_reference` | TEXT | NULL; a contract or maintenance reference, never part of the number (receipts plan D4) |
| `currency_code` | TEXT | NOT NULL DEFAULT `'EUR'`, CHECK `= 'EUR'` (section 4.7: EUR only) |
| `tax_region` | TEXT | NOT NULL DEFAULT `'DE'` |
| `customer_type` | `"CustomerType"` | NULL on a draft without customer; copied from the customer on every recompute |
| `vat_id` | TEXT | NULL; the recipient's VAT id, copied on every recompute |
| `reverse_charge` | BOOLEAN | NOT NULL DEFAULT false |
| `net_or_gross` | `"NetOrGross"` | NOT NULL DEFAULT `'net'` |
| `kleinunternehmer` | BOOLEAN | NOT NULL DEFAULT true; derived from the company's `tax_status` on every recompute, never set by a caller |
| `tax_note` | TEXT | NULL; the exemption or reverse-charge note |
| `tax_profile_key` | TEXT | NULL; the key the line taxes were computed under (P1.4); NULL means "never computed" |
| `subtotal`, `tax_amount`, `total` | INTEGER | NOT NULL DEFAULT 0, each CHECK `>= 0`, plus `CHECK (total = subtotal + tax_amount)` (the `005` accounting identity) |
| `tax_summary` | JSONB | NOT NULL DEFAULT `'[]'`; `[{ taxRate, taxTreatment, net, tax }]` per rate group |
| `customer_snapshot` | JSONB | NULL until issued (P1.5) |
| `sender_snapshot` | JSONB | NULL until issued (P1.5) |
| `intro_text`, `outro_text` | TEXT | NULL |
| `rendered_pdf_file_id` | TEXT | NULL; set once by phase 3 |
| `issued_at` | TIMESTAMP(3) | NULL until issued |
| `created_at`, `updated_at` | TIMESTAMP(3) | house style |

Constraints:

- `UNIQUE (tenant_id, id)` (composite-FK target).
- Foreign keys, all `ON DELETE RESTRICT ON UPDATE RESTRICT`: `(tenant_id, customer_id) ->
  customer(tenant_id, id)`, `(tenant_id, template_id) -> document_template(tenant_id, id)`,
  `(tenant_id, corrects_document_id) -> sales_document(tenant_id, id)`.
- `sales_document_draft_unnumbered_check`: `CHECK (status <> 'draft' OR (document_number IS NULL
  AND number_value IS NULL AND issued_at IS NULL AND customer_snapshot IS NULL AND
  sender_snapshot IS NULL))`. A draft has no number, ever.
- `sales_document_issued_complete_check`: `CHECK (status = 'draft' OR (document_number IS NOT
  NULL AND number_value IS NOT NULL AND issue_date IS NOT NULL AND issued_at IS NOT NULL AND
  customer_id IS NOT NULL AND customer_snapshot IS NOT NULL AND sender_snapshot IS NOT NULL AND
  customer_type IS NOT NULL AND tax_profile_key IS NOT NULL) OR source = 'import')`. (The
  import phase may relax what an imported row must carry; phase 1 rows always satisfy the first
  branch.)
- `sales_document_credit_note_ref_check`: `CHECK ((doc_type = 'credit_note') = (corrects_document_id IS NOT NULL))`.
- `sales_document_reverse_charge_check`: `CHECK (NOT reverse_charge OR (customer_type = 'b2b' AND vat_id IS NOT NULL AND NOT kleinunternehmer))`, the DB-level twin of the shared guard in 1.4.
- `sales_document_service_period_check`: `CHECK ((service_period_start IS NULL) = (service_period_end IS NULL) AND (service_period_start IS NULL OR service_period_start <= service_period_end))`.

Indexes:

- `sales_document_number_key`: partial unique `ON (tenant_id, doc_type, document_number) WHERE document_number IS NOT NULL`.
- `sales_document_number_value_key`: partial unique `ON (tenant_id, doc_type, number_value) WHERE number_value IS NOT NULL`.
- `sales_document_one_credit_note_key`: partial unique `ON (tenant_id, corrects_document_id) WHERE corrects_document_id IS NOT NULL` (phase 1 cancels in full, so one credit note per invoice).
- `sales_document_tenant_type_status_idx ON (tenant_id, doc_type, status)`, `sales_document_tenant_issue_date_idx ON (tenant_id, issue_date)`, `sales_document_tenant_customer_idx ON (tenant_id, customer_id)`.

**Table `sales_document_line`:**

| Column | Type | Rule |
|---|---|---|
| `id` | TEXT | primary key |
| `tenant_id` | TEXT | NOT NULL, uuid CHECK |
| `document_id` | TEXT | NOT NULL |
| `position` | INTEGER | NOT NULL, CHECK `>= 1` |
| `kind` | `"SalesDocLineKind"` | NOT NULL DEFAULT `'service'` |
| `title` | TEXT | NOT NULL, CHECK `length(title) BETWEEN 1 AND 300` |
| `description` | TEXT | NULL, CHECK `length <= 4000` |
| `quantity` | INTEGER | NOT NULL; thousandths |
| `unit_label` | TEXT | NOT NULL DEFAULT `'Stk'` |
| `unit_price` | INTEGER | NOT NULL, CHECK `>= 0`; cents, in the document's `net_or_gross` basis |
| `discount_bp` | INTEGER | NOT NULL DEFAULT 0, CHECK `BETWEEN 0 AND 10000` |
| `subtotal` | INTEGER | NOT NULL, CHECK `>= 0`; cents after discount, before tax (net basis) |
| `tax_class` | TEXT | NULL, CHECK `tax_class IS NULL OR tax_class IN ('standard', 'reduced', 'zero')`; the INPUT the rate is derived from |
| `tax_rate_override` | INTEGER | NULL, CHECK `BETWEEN 0 AND 10000`; an explicit INPUT rate, wins over `tax_class` |
| `tax_rate` | INTEGER | NOT NULL, CHECK `BETWEEN 0 AND 10000`; the DERIVED rate actually applied |
| `tax_amount` | INTEGER | NOT NULL, CHECK `>= 0`; DERIVED |
| `tax_treatment` | `"TaxTreatment"` | NULL only for text lines; DERIVED |
| `variant_ref` | TEXT | NULL; a `product_variant.id` of the same schema when `variant_ref_source = 'owned'` (loose ref, no FK, the section 4.3 socket) |
| `variant_ref_source` | `"VariantRefSource"` | NOT NULL DEFAULT `'none'` |
| `created_at`, `updated_at` | TIMESTAMP(3) | house style |

Constraints and indexes:

- FK `(tenant_id, document_id) -> sales_document(tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT`.
- `sales_document_line_position_key UNIQUE (document_id, position) DEFERRABLE INITIALLY DEFERRED`, so a reorder can rewrite every position in one transaction without a mid-statement collision.
- `sales_document_line_kind_check`: `CHECK ((kind = 'text' AND quantity = 0 AND unit_price = 0 AND discount_bp = 0 AND subtotal = 0 AND tax_rate = 0 AND tax_amount = 0 AND tax_treatment IS NULL) OR (kind <> 'text' AND quantity > 0 AND tax_treatment IS NOT NULL))`.
- `sales_document_line_variant_ref_check`: `CHECK ((variant_ref_source = 'none') = (variant_ref IS NULL))`.
- `sales_document_line_document_idx ON (tenant_id, document_id, position)`.

Input versus derived is the point of `tax_class` and `tax_rate_override`: when a customer swap
switches a draft to reverse charge, `tax_rate` becomes 0, and when it switches back, the
intended 19 or 7 percent is recomputed from the inputs. Without stored inputs a swap back would
silently keep 0 percent.

**Table `sales_document_event`** (append-only audit trail, section 4.6):

| Column | Type | Rule |
|---|---|---|
| `id` | TEXT | primary key |
| `tenant_id` | TEXT | NOT NULL, uuid CHECK |
| `document_id` | TEXT | NOT NULL; FK `(tenant_id, document_id) -> sales_document(tenant_id, id) ON DELETE RESTRICT` |
| `event_type` | `"SalesDocEventType"` | NOT NULL |
| `from_status`, `to_status` | `"SalesDocStatus"` | NULL where not a transition |
| `actor_user_id` | TEXT | NULL (an auth-brain user id; NULL only for system writes such as the import) |
| `payload` | JSONB | NOT NULL DEFAULT `'{}'`; never contains a recipient's name or address (receipts plan D3) |
| `created_at` | TIMESTAMP(3) | house style; no `updated_at` (append-only) |

Index `sales_document_event_document_idx ON (tenant_id, document_id, created_at)`.

**Frozen after issue, and how.** The existing append-only tables (`stock_movement`,
`credit_note`, `order`, ...) are protected by `REVOKE UPDATE, DELETE ... FROM commerce_app`,
re-applied after provisioning grants (CM-13's `APPEND_ONLY_TABLES`). A REVOKE cannot protect
`sales_document` or its lines, because drafts must stay editable; and a REVOKE binds only the app
role. So Books uses row-conditional triggers, which bind every role including the owner and
survive any later GRANT. Errors use custom SQLSTATEs so tests and the repository can tell them
apart from a permission error (`42501`):

| SQLSTATE | Meaning |
|---|---|
| `BK001` | write to a frozen document or to a line of a non-draft document |
| `BK002` | UPDATE, DELETE or TRUNCATE on `sales_document_event` |
| `BK003` | a counter moved backwards |
| `BK004` | a status transition that is not allowed |
| `BK005` | issue with totals that do not equal the sum of the lines |

1. `sales_document_guard()` on `sales_document`, BEFORE UPDATE OR DELETE, FOR EACH ROW:
   - DELETE: always raises `BK001` (a draft is never deleted either: it carries its
     `draft_created` event, and an abandoned draft simply stays a draft and consumes nothing).
   - UPDATE with `OLD.status = 'draft'` and `NEW.status = 'draft'`: allowed.
   - UPDATE with `OLD.status = 'draft'` and `NEW.status = 'issued'`: allowed only if `SUM(subtotal)`
     and `SUM(tax_amount)` over the document's lines equal `NEW.subtotal` and `NEW.tax_amount`
     (else `BK005`); the CHECK constraints above enforce the number and snapshots.
   - UPDATE with `OLD.status <> 'draft'`: the row with `status`, `rendered_pdf_file_id` and
     `updated_at` removed must be identical (`to_jsonb(NEW) - ARRAY[...] = to_jsonb(OLD) -
     ARRAY[...]`), else `BK001`. `rendered_pdf_file_id` may change only from NULL to a value
     (else `BK001`).
   - Allowed status transitions (anything else is `BK004`): invoice `draft -> issued -> sent ->
     paid`, `issued | sent | paid -> cancelled`; credit note `draft -> issued -> sent`; offer
     `draft -> issued -> sent -> accepted | rejected | cancelled`, `issued -> draft` only while
     unsent (section 4.2's machine; offers are not used by phase 1's API but the machine is
     complete so the trigger never needs a weaker version). `-> cancelled` on an invoice
     additionally requires an issued credit note with `corrects_document_id = OLD.id` to exist
     in the same transaction (`BK004` otherwise): "cancelled only via a credit note, never by
     mutation" (section 4.2) is enforced by the database.
   - Every column is frozen, which is stricter than a list and cannot go stale when a column is
     added; the three-name allowlist is the only exception.
2. `sales_document_line_guard()` on `sales_document_line`, BEFORE INSERT OR UPDATE OR DELETE, FOR
   EACH ROW: reads the parent's status with `SELECT status ... FOR SHARE` (serializes with an
   issue that holds the parent `FOR UPDATE`) for `NEW.document_id` (INSERT, UPDATE) and
   `OLD.document_id` (UPDATE, DELETE); raises `BK001` unless every parent read is `'draft'`.
3. `sales_document_event_append_only()` on `sales_document_event`, BEFORE UPDATE OR DELETE FOR
   EACH ROW and BEFORE TRUNCATE FOR EACH STATEMENT: always raises `BK002`. In addition, the house
   REVOKE: `REVOKE UPDATE, DELETE, TRUNCATE ON sales_document_event FROM commerce_app` in the
   migration body (role-guarded `DO` block, as in `001`), and `sales_document_event` is added to
   `APPEND_ONLY_TABLES` in the provisioning module so the REVOKE survives the grant.
4. `document_number_counter_monotonic()` as above (`BK003`).

**Registration with the guards and the types.**

- The isolation guard reads its known tenant tables from every `CREATE TABLE` in the tenant
  migration directory (CM-13's `scripts/check-guards.mjs`), so the seven tables are guarded the
  moment `007_books.ts` lands there. Add `'src/server/books'` and `'src/server/tax'` to its
  `DEFAULT_ROOTS`, so Books code is scanned for G1 to G5 (no `.withSchema`, no runtime `SET
  search_path`, no bare tenant table inside a `sql` template: raw fragments use
  `tenantSchemaRef(tgId)`).
- Run `pnpm db:codegen-commerce` and reconcile the commerce Database interface: the seven tables
  as bare keys; every column with a DB default as `Generated<>`; JSONB columns as `ColumnType<T,
  string, string>` with `T` the zod-inferred shape, written through one helper `toJsonb(value)`
  (`JSON.stringify`); `DATE` columns as `ColumnType<string, string, string>`. Extend
  `type-discipline.test-d.ts` with one Books key on the bare side.
- `pnpm db:migrate-tenants` rolls `007` across every provisioned schema; new companies get it
  through provisioning.

### P1.2 Customer and the shared contacts database

A `customer` row holds the tax fields an invoice needs and a `contact_id`; name, address and the
customer number come from the shared contacts database, opened through the published package
`@marlinjai/contacts-core` (receipts plan D3; the contacts wave-2 plan: one PostgreSQL instance,
one package, company-scoped by the auth-brain company id, no cross-database transactions).

Plumbing, all in phase 1:

- Dependency `@marlinjai/contacts-core` (current published version, caret range) and its peer
  `postgres`.
- `CONTACTS_DATABASE_URL` in framer-clone's Infisical project, scaffolded as
  `PLACEHOLDER_REPLACE_ME` (split-responsibility pattern); the real value is copied from the
  receipts project with `copy_secret`, never typed.
- `src/server/books/recipients.ts`: `contactsDb()` lazily opens one handle
  (`createContactsDb(url, { applicationName: 'books' })`, cached on `globalThis`), and throws
  `ContactsNotConfiguredError` when the variable is missing (the receipts app's pattern, never
  swallowed). It exposes a port, so tests can substitute it:

```ts
export interface RecipientDirectory {
  /** The company's contact, or null when it does not exist for that company. Throws on connection failure. */
  getContact(tenantId: string, contactId: string): Promise<RecipientContact | null>;
}
```

  The production implementation calls `contactsFor(contactsDb(), tenantId).get(contactId)` and
  maps the package's `Contact` (kind, name, companyOrRole, legalForm, addressLine1, addressLine2,
  postalCode, city, country, vatId, customerNumber, archived) to `RecipientContact`. Any thrown
  error that is not the package's `not_found` becomes `BooksError('RECIPIENT_UNAVAILABLE')`
  with the original error as `cause`.

Rules:

- `createCustomer` requires the contact to exist for the company (`RECIPIENT_NOT_FOUND`
  otherwise; `RECIPIENT_UNAVAILABLE` when the contacts database cannot be reached). The tax
  fields are explicit inputs; when `vatId` or `countryCode` is omitted, the contact's `vatId`
  and `country` prefill them once, at creation. After that the customer row is authoritative for
  tax, the contact for name and address (a later edit of the contact's VAT id does not change the
  customer's; phase 2's editor shows both when they differ).
- **At issue, the contact is read BEFORE the Books transaction opens** (a network read must not
  hold the document and counter locks, and there is no cross-database transaction). Outcomes:
  - contacts database unreachable or not configured: `RECIPIENT_UNAVAILABLE`, nothing written,
    no transaction opened, no number consumed. The document stays a draft; the caller retries.
  - contact missing: `RECIPIENT_NOT_FOUND`.
  - contact archived: `RECIPIENT_ARCHIVED` (an archived contact is one the company stopped
    using; issuing to it is almost certainly a wrong pick, and unarchiving is one action).
  - a field section 34a requires is empty (`name`, `addressLine1`, `postalCode`, `city`,
    `country`): `RECIPIENT_INCOMPLETE` with the list of missing field names (names only, no
    values).
  - **Never issue with an empty or partial recipient.** There is no fallback to a cached or older
    snapshot.
- Inside the transaction, after locking the document, the repository re-checks that the
  document's `customer_id` still points to the customer whose contact was read; if a concurrent
  `setCustomer` changed it, `CONCURRENT_EDIT` and nothing is written.

### P1.3 Numbering

- **One counter row per company and document type** (`document_number_counter`), no yearly
  reset. Section 4.4's per-year `SEQUENCE` is superseded: a sequence burns numbers on rollback,
  the counter row does not, and receipts plan D4 decided the counter row.
- **Allocated at issue, inside the issue transaction, never at draft creation.** Lock order,
  identical in issue and cancel so two transactions can never deadlock: (1) the document row
  `SELECT ... FOR UPDATE`, (2) the counter row `SELECT next_value, format FROM
  document_number_counter WHERE tenant_id = $1 AND doc_type = $2 FOR UPDATE`. Then `number_value
  = next_value`, `document_number = format(format, next_value)`, `UPDATE ... SET next_value =
  next_value + 1`. A rollback anywhere in the transaction restores the counter: no gap, and an
  abandoned draft never touched it.
- READ COMMITTED (`db.transaction().setIsolationLevel('read committed')`), like the order path.
  The counter row lock serializes concurrent issues of one company; different companies never
  contend.
- A missing counter row is `COUNTER_MISSING` (the company was not initialised, P1.8), never an
  implicit insert: an implicit row would start at 1 and collide with the historical series.
- **Format for Whiz-Art Media:** invoices `{n}` (the plain integer, as printed since invoice 1),
  `next_value = 62` (after the highest historical number, 61). Credit notes `GS-{n}` from 1;
  offers `ANG-{n}` from 1 (seeded now, used when offers are built). Formats are company
  configuration in the counter row, set by the init script (P1.8), never constants in the code.
- **Uniqueness:** the partial unique indexes `sales_document_number_key` and
  `sales_document_number_value_key`. The historical import (after phase 3) inserts its rows with
  `source = 'import'` and their printed numbers, and must assert `number_value < next_value` for
  every imported row; it never moves the counter.
- **Issue date order:** `issue_date` must not be in the future (Europe/Berlin calendar day) and
  must not be earlier than the `issue_date` of the highest-numbered issued document of the same
  company and type (`ISSUE_DATE_OUT_OF_ORDER`), so numbers and dates never run against each
  other.

### P1.4 Tax profile

`src/server/tax/germanVat.ts` becomes the one implementation of the German VAT rules ("one
semantic, one implementation"). Moved there from the order orchestrator, unchanged in behaviour:
`STANDARD_RATE_BPS`, `REDUCED_RATE_BPS`, `ZERO_RATE_BPS`, `MAX_RATE_BPS`,
`REVERSE_CHARGE_NOTICE`, `KLEINUNTERNEHMER_NOTICE`, `computeLineTax`, `resolveLineRate`, and the
reverse-charge precondition out of `validateCart`, as:

```ts
export function assertReverseChargeAllowed(p: { customerType: 'b2c' | 'b2b'; vatId: string | null | undefined }): void
// throws ReverseChargeNotAllowedError unless customerType === 'b2b' and vatId is non-empty after trim
```

The order orchestrator imports all of these and calls `assertReverseChargeAllowed` from
`validateCart`; its existing tests stay green unchanged (they are the proof the move kept
behaviour). The Books domain maps `ReverseChargeNotAllowedError` to
`BooksError('REVERSE_CHARGE_NOT_ALLOWED')`.

Books adds, in the same module:

```ts
export type CompanyTaxStatus = 'small_business' | 'regular';
export interface TaxProfileInput {
  companyTaxStatus: CompanyTaxStatus;
  exemptionNote: string;              // the company's configured note
  customerType: 'b2c' | 'b2b';
  vatId: string | null;
  countryCode: string;                // recipient, ISO 3166-1 alpha-2
}
export interface TaxProfile {
  kleinunternehmer: boolean;
  reverseCharge: boolean;
  taxNote: string | null;
  key: string;                        // tax_profile_key
}
export function resolveTaxProfile(input: TaxProfileInput): TaxProfile
```

The logic, in this order:

1. `companyTaxStatus = 'small_business'` (the default, section 19): `kleinunternehmer = true`,
   `reverseCharge = false`, `taxNote = exemptionNote`. Every non-text line gets treatment
   `kleinunternehmer`, rate 0, tax 0, whatever the customer is. The document carries no tax lines:
   `tax_summary` is one group `{ taxRate: 0, taxTreatment: 'kleinunternehmer', net, tax: 0 }` and
   `tax_amount = 0`. Default `exemption_note` written by the init script: `Gemäß § 19 UStG wird
   keine Umsatzsteuer berechnet (Kleinunternehmerregelung).`, editable per company.
2. `regular`, recipient `b2b` with a non-empty VAT id and `countryCode` an EU member state other
   than `DE`: `reverseCharge = true` (after `assertReverseChargeAllowed`), every non-text line
   treatment `reverse_charge`, rate 0, tax 0, `taxNote = REVERSE_CHARGE_NOTICE`.
3. `regular`, recipient outside the EU: `TAX_CASE_UNSUPPORTED` at issue (a third-country service
   is not taxable in Germany and needs its own note; section 4.7 scopes the books to domestic
   plus EU business reverse charge). A draft may still be built; only issue refuses.
4. `regular`, everything else (domestic, or an EU consumer below the delivery threshold, since
   one-stop-shop accumulation is out of scope per section 4.7): each line's rate is
   `resolveLineRate(tax_class, tax_rate_override)` and its tax `computeLineTax(...)` with the
   document's `net_or_gross`; `taxNote = null`.

`key = [companyTaxStatus, customerType, vatId ?? '', countryCode].join('|')`. It is the key of
all derived tax state (the stateful-flow invariant): every draft mutation compares the key it
would compute now with the stored `tax_profile_key`; when they differ every line's `tax_rate`,
`tax_amount` and `tax_treatment` and the document totals, `tax_summary`, `tax_note`,
`reverse_charge`, `kleinunternehmer`, `customer_type` and `vat_id` are recomputed from the inputs
and the new key stored; when equal, untouched lines are not rewritten. Issue always recomputes
and compares before freezing.

`totals.ts` holds the pure money math, integer only:

- line net before discount `= Math.round(quantity * unit_price / 1000)`;
- line `subtotal = Math.round(net_before_discount * (10000 - discount_bp) / 10000)`;
- line tax from `computeLineTax(subtotal, ...)`: per line, as the order path does, so the
  document's `tax_amount` is exactly the sum of the line taxes (the identity `BK005` checks);
- `tax_summary`: group the non-text lines by `(tax_rate, tax_treatment)`, sum `subtotal` and
  `tax_amount`, sorted by rate descending;
- document `subtotal = SUM(line.subtotal)`, `tax_amount = SUM(line.tax_amount)`, `total =
  subtotal + tax_amount`.

For `net_or_gross = 'gross'` the line `unit_price` is gross; `computeLineTax` extracts the tax and
the stored `subtotal` is the net part (so `total = subtotal + tax_amount` holds in both modes).

### P1.5 Snapshots frozen at issue, and the event log

Both snapshots are zod schemas in `src/server/books/snapshots.ts`, versioned (`v: 1`), parsed on
write and on read.

- `CustomerSnapshotV1 = { v: 1, contactId, kind, name, companyOrRole, legalForm, addressLine1,
  addressLine2, postalCode, city, country, customerNumber, customerType, vatId, taxNumber }`:
  name and address from the contact read in P1.2, the tax fields from the `customer` row, all
  taken at issue time. Never recomputed (section 5, phase 3's immutability rule). Never returned
  by `listDocuments`, never written to a log or an event payload (receipts plan D3).
- `SenderBlockV1` (the shape of `books_company_settings.sender_block`) and `SenderSnapshotV1 = {
  v: 1, ...SenderBlockV1 }`: `legalName`, `addressLine1`, `addressLine2`, `postalCode`, `city`,
  `countryCode`, `taxNumber`, `vatId`, `smallBusinessId`, `email`, `phone`, `website`,
  `bankName`, `iban`, `bic`, `registerCourt`, `registerNumber`, `managingDirector`. Required at
  issue: `legalName`, `addressLine1`, `postalCode`, `city`, `countryCode`, and at least one of
  `taxNumber`, `vatId`, `smallBusinessId` (section 34a); missing ones give `SENDER_INCOMPLETE`
  with the field names. The sender comes from the company setting row, which the init script
  fills from the auth-brain company record (`legal_name`, `vat_id`, `billing_address`) plus a
  local file for the fields auth-brain does not hold. It is never a constant in this repository.

Events written (one row per state transition and per customer assignment, section 4.6; line
edits of a draft are not records and write no event):

| When | `event_type` | `from_status -> to_status` | `payload` |
|---|---|---|---|
| `createDraft` | `draft_created` | `null -> draft` | `{ docType }` |
| `setCustomer` (customer actually changed) | `customer_set` | `null -> null` | `{ customerId, previousCustomerId, taxProfileChanged }` |
| `issue` | `issued` | `draft -> issued` | `{ documentNumber, numberValue, issueDate, total, taxProfileKey }` |
| `cancelInvoice`, on the credit note | `issued` | `draft -> issued` | `{ documentNumber, numberValue, issueDate, total, correctsDocumentId }` |
| `cancelInvoice`, on the invoice | `cancelled` | `issued/sent/paid -> cancelled` | `{ creditNoteId, creditNoteNumber, reason }` |

### P1.6 The repository API

All functions live under `src/server/books/repository/`, take the `BooksScope` first, run every
write in ONE `db.transaction().setIsolationLevel('read committed')`, stamp `updated_at`, and
throw `BooksError` (`errors.ts`: `class BooksError extends Error { code: BooksErrorCode; details?:
Record<string, unknown> }`). A trigger error is mapped by SQLSTATE: `BK001` to `NOT_DRAFT`,
`BK004` to `INVALID_TRANSITION`, `BK005` to `TOTALS_MISMATCH`; anything else propagates
unchanged (errors surface, never swallowed). Every draft mutation locks the document `FOR
UPDATE`, checks `status = 'draft'` (`NOT_DRAFT`), checks `expectedVersion` when given
(`CONCURRENT_EDIT`), and increments `version`. Inputs are validated with zod at the boundary
(`INVALID_INPUT` with the zod issue paths).

| Function | Transaction and effect | Error codes |
|---|---|---|
| `createCustomer(scope, { contactId, customerType, vatId?, countryCode?, taxNumber? })` | contact read first (P1.2), then one insert | `RECIPIENT_UNAVAILABLE`, `RECIPIENT_NOT_FOUND`, `DUPLICATE_CUSTOMER` (unique `(tenant_id, contact_id)`, detected on `23505` plus the constraint name), `INVALID_INPUT` |
| `updateCustomerTaxFields(scope, id, { customerType?, vatId?, countryCode?, taxNumber? })` | one update; drafts pick the change up on their next mutation or at issue (key mismatch) | `NOT_FOUND`, `INVALID_INPUT` |
| `archiveCustomer(scope, id)` | sets `archived_at` | `NOT_FOUND` |
| `getCustomer`, `listCustomers(scope, { includeArchived?, limit, cursor })` | reads | `NOT_FOUND` |
| `createDraft(scope, { docType, actorUserId, customerId?, templateId?, netOrGross?, serviceDate?, servicePeriod?, contractReference?, introText?, outroText? })` | insert document (`payment_terms_days` from the company setting, `kleinunternehmer` from `tax_status`) plus `draft_created` event; with `customerId`, as `setCustomer` in the same transaction | `DOC_TYPE_NOT_SUPPORTED` (phase 1 accepts `invoice` only; credit notes come from `cancelInvoice`, offers later), `SETTINGS_MISSING`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED` |
| `updateDraft(scope, id, { expectedVersion?, templateId?, netOrGross?, serviceDate?, servicePeriod?, paymentTermsDays?, contractReference?, introText?, outroText? })` | lock, update; a `netOrGross` change recomputes every line | `NOT_FOUND`, `NOT_DRAFT`, `CONCURRENT_EDIT`, `INVALID_INPUT` |
| `setCustomer(scope, id, { customerId, actorUserId, expectedVersion? })` | lock, set `customer_id`; recompute only when the tax profile key changes; `customer_set` event only when the customer actually changed (same customer is a no-op that returns the document unchanged, version included) | `NOT_FOUND`, `NOT_DRAFT`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`, `CONCURRENT_EDIT` |
| `addLine(scope, id, { kind, title?, description?, quantity, unitLabel?, unitPrice?, discountBp?, taxClass?, taxRateOverride?, variantRef?, expectedVersion? })` | lock, insert at `max(position) + 1`, compute the line and the totals | `NOT_FOUND`, `NOT_DRAFT`, `INVALID_LINE` (quantity, price, discount or text-line rules), `VARIANT_NOT_FOUND`, `CONCURRENT_EDIT` |
| `updateLine(scope, id, lineId, patch)` | lock, update, recompute the line and the totals | as `addLine`, plus `LINE_NOT_FOUND` |
| `reorderLines(scope, id, { lineIds, expectedVersion? })` | lock, rewrite positions `1..n` in the given order (the deferred unique constraint allows it) | `INVALID_POSITIONS` (not exactly the document's line ids), `NOT_DRAFT`, `CONCURRENT_EDIT` |
| `removeLine(scope, id, lineId, { expectedVersion? })` | lock, delete, close the position gap, recompute totals | `LINE_NOT_FOUND`, `NOT_DRAFT`, `CONCURRENT_EDIT` |
| `issue(scope, id, { actorUserId, issueDate? })` | see below | `NOT_FOUND`, `CUSTOMER_REQUIRED`, `NO_BILLABLE_LINES`, `RECIPIENT_*`, `SENDER_INCOMPLETE`, `SETTINGS_MISSING`, `COUNTER_MISSING`, `SERVICE_DATE_REQUIRED`, `TAX_CASE_UNSUPPORTED`, `REVERSE_CHARGE_NOT_ALLOWED`, `ISSUE_DATE_OUT_OF_ORDER`, `CONCURRENT_EDIT`, `DOC_TYPE_NOT_SUPPORTED` |
| `cancelInvoice(scope, invoiceId, { actorUserId, reason, issueDate? })` | see below | `NOT_FOUND`, `NOT_CANCELLABLE` (draft, or a type other than invoice), `SENDER_INCOMPLETE`, `COUNTER_MISSING`, `ISSUE_DATE_OUT_OF_ORDER` |
| `getDocument(scope, id)` | read: document, lines by position, events by time, snapshots | `NOT_FOUND` |
| `listDocuments(scope, { docType?, status?, issuedFrom?, issuedTo?, customerId?, limit (1..100, default 50), cursor? })` | read, ordered `issue_date DESC NULLS FIRST, created_at DESC`, keyset cursor; returns no snapshots | none |

`addLine` with `variantRef` (services as catalog products, amendment item 4): the line gets
`variant_ref_source = 'owned'`; the repository reads the variant and its product from the same
schema (`product_variant` joined to `product`, live rows only) and, for every input the caller
left out, defaults `title` (product title, plus the variant title when it is not the default
one), `unitPrice` (the pricing repository's price resolution for `EUR`, quantity 1) and
`taxClass` (the variant's `tax_class`, else the product's). Those values are copied onto the line:
a later catalog change never alters a draft line already added, and never an issued one.
`kind` defaults to `service`.

**`getDocument` on a draft with a stale key** (the resume rule): when the stored
`tax_profile_key` does not equal the key computed from the current customer and company setting,
or is NULL, the read returns the document recomputed in memory with `stale: true`; it never
returns the persisted figures as current. The next mutation or the issue persists the
recomputation.

**`issue`, step by step:**

1. Validate input. Outside any transaction, read the document (scope-filtered). If it is not a
   draft and is `issued` or later, return it as the result (idempotency, see below). Require
   `doc_type = 'invoice'`, a `customer_id` (`CUSTOMER_REQUIRED`) and at least one non-text line
   (`NO_BILLABLE_LINES`).
2. Read the customer, then the contact through the `RecipientDirectory` (P1.2). Validate and build
   `CustomerSnapshotV1`. Any failure ends here with nothing written.
3. Open the transaction. Lock the document `FOR UPDATE`. If its status is no longer `draft`,
   return it (a concurrent issue won). If its `customer_id` differs from step 2,
   `CONCURRENT_EDIT`.
4. Read `books_company_settings` (`SETTINGS_MISSING`), validate the sender block, build
   `SenderSnapshotV1`. Under `regular`, require `service_date` or the service period
   (`SERVICE_DATE_REQUIRED`); under section 19 both stay optional.
5. Resolve the tax profile from the customer and the setting; recompute every line and the totals
   from the inputs; write the changed lines.
6. Determine `issue_date` (argument or today in Europe/Berlin), check it (P1.3).
7. Lock the counter row, allocate the number, advance the counter.
8. Update the document: `status = 'issued'`, number fields, `issue_date`, `due_date = issue_date +
   payment_terms_days`, `payment_reference`, snapshots, the tax fields, `issued_at`. The guard
   trigger checks the totals (`BK005`); the CHECKs check completeness.
9. Insert the `issued` event. Commit. Return `{ document, alreadyIssued: false }`.

**Idempotency of `issue`:** the document id is the idempotency key. A retry after a lost response,
or a second click, finds the document issued and returns `{ document, alreadyIssued: true }` with
the same number; two concurrent calls serialize on the document row lock and the loser returns the
winner's result. No call ever allocates a second number for one document.

**`cancelInvoice`, step by step** (a full cancellation, receipts plan section 6 item 6 defers
partial credit notes):

1. Open the transaction. Lock the invoice `FOR UPDATE`. If it is `cancelled`, return the existing
   credit note (`alreadyCancelled: true`; idempotent like issue, the partial unique index makes a
   second credit note impossible). If it is `draft` or not an invoice, `NOT_CANCELLABLE`.
2. Read the settings and build a fresh `SenderSnapshotV1` (the credit note is a document issued
   today by the company). The customer snapshot is copied from the invoice, so a cancellation
   never depends on the contacts database being reachable and always names the invoice's
   recipient.
3. Insert the credit note as a draft row: `corrects_document_id = invoiceId`, same customer,
   currency, `net_or_gross`, `payment_terms_days`, tax fields and `tax_profile_key` as the
   invoice (a credit note has no `due_date` and no `payment_reference`); its lines are copies
   of the invoice's lines with the same derived values (no recompute: a cancellation offsets
   exactly what was invoiced). Amounts stay non-negative; the document type carries the sign
   (the `credit_note` table of `004` does the same).
4. Lock the `credit_note` counter row, allocate, update the credit note to `issued` (snapshots,
   number, `issue_date`, `issued_at`); write its `draft_created` and `issued` events.
5. Update the invoice to `cancelled` (the trigger finds the issued credit note and allows it);
   write the invoice's `cancelled` event. Commit.

The `credit_note` and `credit_note_ref` tables of `004` (the storefront order correction) are
untouched; Books credit notes are `sales_document` rows.

### P1.7 What phase 1 does not change

The storefront order tables, the commerce routes, the render path, the seed, `prisma/schema.prisma`
(after CM-13 it holds no commerce or Books model) and `.github/workflows/ci.yml` (the integration
suite already runs every `.itest.ts`; the contacts test boots its own container).

### P1.8 Company initialisation

`initBooksCompany(scope, { taxStatus, exemptionNote?, senderBlock, defaultPaymentTermsDays?,
counters: [{ docType, format, nextValue }] })` in `settings.ts`, one transaction, idempotent:
inserts the settings row and any missing counter rows; an existing counter is never lowered or
reformatted (a changed `format` or a lower `nextValue` for an existing row is
`COUNTER_EXISTS`). `scripts/books-init-company.ts` (`pnpm books:init-company --tenant-group <id>
--tenant <id> --sender <local-json-file>`) reads the auth-brain company record through the
admin machine API for `legal_name`, `vat_id` and `billing_address`, merges the local file for the
rest (tax number, bank details), and calls `initBooksCompany`. For Whiz-Art Media it is run
once with `taxStatus = 'small_business'` and counters `invoice {n} 62`, `credit_note GS-{n} 1`,
`offer ANG-{n} 1`. The sender file stays on the operator's machine.

### P1.9 Pure unit tests (`pnpm test`)

| File | Test | Asserts |
|---|---|---|
| `src/server/tax/__tests__/germanVat.test.ts` | `resolveTaxProfile small business ignores the customer` | DE b2c, FR b2b with VAT id, US b2b all give `kleinunternehmer`, no reverse charge, the company's note |
| | `resolveTaxProfile regular EU business with VAT id is reverse charge` | FR b2b plus VAT id: reverse charge, `REVERSE_CHARGE_NOTICE` |
| | `resolveTaxProfile regular domestic and EU consumer use German rates` | DE b2b, FR b2c: no reverse charge, null note |
| | `resolveTaxProfile regular third country is unsupported` | US b2b flagged for `TAX_CASE_UNSUPPORTED` |
| | `assertReverseChargeAllowed rejects b2c and empty VAT id` | throws for b2c, for b2b with `''` or whitespace; passes for b2b plus VAT id |
| | `tax profile key changes exactly when an input changes` | same inputs same key; each of the four inputs changes it |
| `src/server/books/__tests__/totals.test.ts` | `line subtotal from thousandths quantity and discount` | 1500 x 8000 cents = 12000; 10 percent discount = 10800; rounding half up on odd halves |
| | `mixed-rate tax summary groups per rate` | 19 and 7 percent lines give two groups, sums match lines |
| | `gross basis extracts tax and keeps the identity` | `total = subtotal + tax_amount` for net and gross |
| | `text lines are excluded from totals and summary` | |
| `src/server/books/__tests__/numbering.test.ts` | `format renders plain, prefixed and padded numbers` | `{n}` 62 = `62`, `GS-{n}` 1 = `GS-1`, `{n:4}` 7 = `0007` |
| `src/server/books/__tests__/snapshots.test.ts` | `sender block requires name, address and one tax id` | each missing field reported by name |
| | `customer snapshot requires the section 34a recipient fields` | |
| `src/server/commerce/order/__tests__/createOrder.test.ts` | existing suite, unchanged | still green after the move to the shared module (behaviour kept) |

### P1.10 Integration tests (`pnpm test:integration`, real Postgres via testcontainers)

All in `src/server/books/__tests__/`, each provisioning schemas with the full tenant migration set
through the production provisioning function, connecting the repository as `commerce_app`, and
using a fake `RecipientDirectory` except where named.

**`books-migration.itest.ts`** (structure, the `provision.itest.ts` probe style: assert by
behaviour, not catalog presence):

- `007 creates the seven tables, enums, constraints and triggers in tg_<id>`; re-provision is a
  no-op.
- `a draft cannot carry a number` (CHECK); `an issued row without snapshots is refused` (CHECK);
  `a credit note without corrects_document_id is refused`; `reverse charge on b2c is refused`.
- `composite FKs refuse cross-company references in one schema`: raw insert of a document of
  company B pointing at a customer of company A fails; same for a line and an event.
- `the deferred position constraint allows swapping two positions in one transaction`.
- `DATE columns round-trip as YYYY-MM-DD` (2026-12-31 stays 2026-12-31).
- `the event REVOKE survives provisioning grants`: as `commerce_app`, UPDATE on
  `sales_document_event` is denied with `42501` (the REVOKE) and, as the owner, still refused with
  `BK002` (the trigger).

**`books-immutability.itest.ts`** (DB-level rejection of edits to an issued document, as
`commerce_app` AND as the owner role, so the triggers are proven independent of grants):

- `UPDATE of any content column of an issued document raises BK001` (total, customer_snapshot,
  issue_date, document_number each).
- `INSERT, UPDATE and DELETE of a line of an issued document raise BK001`.
- `DELETE of a document raises BK001`, for an issued one and for a draft.
- `issued -> draft raises BK004`; `issued -> cancelled without a credit note raises BK004`.
- `rendered_pdf_file_id may be set once and never changed` (NULL to value passes, value to other
  raises `BK001`).
- `UPDATE, DELETE and TRUNCATE on sales_document_event raise BK002`.
- `a counter can never move backwards` (`BK003`).
- `issuing with totals that disagree with the lines raises BK005`.

**`books-tax.itest.ts`** (the phase 1 verify list of section 5, through the repository):
domestic 19 percent, reduced 7 percent, EU business reverse charge (zero VAT plus the note),
section 19 suppression (zero VAT plus the exemption note, no tax groups other than the
`kleinunternehmer` group), mixed-rate `tax_summary` grouping, and
`a credit note references and offsets an issued invoice` (same totals, invoice `cancelled`, both
numbered from their own series, both events written).

**`books-flow.itest.ts`** (the four stateful-flow paths, named exactly so; the backtrack test
needs a company with `tax_status = 'regular'` because under section 19 no swap changes tax):

1. `forward: draft, three lines, issue` (company `small_business`, invoice counter at 62): the
   document gets number `62`, `number_value 62`, both snapshots, `due_date = issue_date + 14`,
   `payment_reference 'Rechnung 62'`, the exemption note, an `issued` event; the counter is at
   63.
2. `backtrack and revise: customer swap to an EU business flips every line to reverse charge`
   (company `regular`): draft with a German consumer and lines at 19 and 7 percent; swap to a
   French business with VAT id; every line `reverse_charge`, rate 0, tax 0, totals recomputed,
   `tax_note` is the reverse-charge note, `tax_profile_key` changed, a `customer_set` event with
   `taxProfileChanged: true`. Swap back to a German consumer: the lines are again 19 and 7
   percent (recomputed from `tax_class` and `tax_rate_override`).
   `backtrack and revise counter-case: swap to another German consumer leaves line tax untouched`:
   the line rows' `updated_at` and values are unchanged, the key is unchanged, only `customer_id`,
   `version` and the event change. Plus `backtrack under section 19: swapping to an EU business
   changes no tax` (all lines stay `kleinunternehmer`).
   `backtrack and revise: a line edit recomputes only that line and the totals`.
3. `resume: a draft read in a new session carries its key and recomputes when stale`: create a
   draft, drop the handle, open a new base handle and scope, `getDocument` returns the same lines,
   totals and `stale: false`. Then change the customer's VAT id and country through
   `updateCustomerTaxFields` (company `regular`): `getDocument` returns `stale: true` with
   recomputed figures, the next mutation persists them, `issue` freezes the recomputed figures,
   never the stored stale ones. A draft whose `tax_profile_key` is NULL (a row as an older writer
   would leave it) reads as stale and recomputes.
4. `re-entry: a new draft after an issue starts clean and an abandoned draft consumes no number`:
   after issuing 62, a new draft has a new id, `document_number NULL`, no snapshots, no events but
   its own `draft_created`; abandon it (never issue it), create a third draft, issue it: it gets
   `63`. The abandoned draft is still a draft, still unnumbered.
   `re-entry after a failed issue`: issue with the contacts directory throwing
   (`RECIPIENT_UNAVAILABLE`): no event, counter unchanged, document still a draft; retry with the
   directory back: the number is the one the failed attempt would have had.

**`books-concurrency.itest.ts`:**

- `two parallel issues of different drafts get consecutive distinct numbers`: two drafts of one
  company, `Promise.all` of two `issue` calls on separate connections: numbers `{62, 63}`, counter
  64, no error.
- `two parallel issues of the same draft allocate one number`: both calls return the same number,
  one with `alreadyIssued: true`, counter advanced by one, one `issued` event.
- `a rolled-back issue leaves no gap`: a fault injected after the counter update (a test-only
  hook in `issue.ts` behind an explicit options argument, not an environment flag) rolls the
  transaction back; the next issue gets the same number.
- `two companies issue in parallel without contending`: each gets its own next number.
- `two parallel cancellations create one credit note`.

**`books-isolation.itest.ts`** (two companies in ONE tenant group schema; the cross-schema wall is
already proven by the commerce isolation specs and is not duplicated beyond one smoke check):

- `company A cannot read, list, edit, issue or cancel company B's documents`: every call with A's
  scope and B's id is `NOT_FOUND`; `listDocuments` for A contains no B row.
- `company A cannot attach company B's customer` (`CUSTOMER_NOT_FOUND`, and the composite FK as
  backstop).
- `counters are per company`: A at 62 and B at 1 stay independent.
- `smoke: a scope on tg_b sees nothing of tg_a`.
- `every Books query carries tenant_id`: run the full repository flow with a Kysely logging
  plugin; every compiled SELECT, UPDATE and DELETE on a Books table has `tenant_id` in its WHERE
  clause.

**`books-contacts.itest.ts`** (the real package against a second Postgres container, schema
parity over the mocked boundary):

- `createCustomer and issue read name and address from the real contacts database`: contacts
  `migrate()`, create an organization contact for company A, create the customer, issue; the
  snapshot equals the contact's fields.
- `a contact of another company is not found`.
- `an archived contact refuses issue` and `an incomplete contact reports the missing fields`.
- `a stopped contacts container gives RECIPIENT_UNAVAILABLE and writes nothing`.

### P1.11 Out of scope for phase 1, and the verify commands

Out of scope: routes and the editor interface (phase 2, with the `books` grant check and the
route-level 403 tests), template CRUD, rendering, the PDF and the section 34a completeness check
on rendered output (phase 3), the historical import of invoices 28 to 61 (after phase 3,
amendment item 5), the machine endpoint receipt-ocr-app pulls from, storage-brain and the
production wiring of `CONTACTS_DATABASE_URL` into a deployed app (roadmap line 4), offers and
partial credit notes (receipts plan section 6 item 6), a draft discard action (phase 2 decides
whether the editor needs one).

Verify, all green before phase 1 is done:

```
pnpm lint && pnpm lint:guards && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
pnpm db:codegen-commerce   # then: git diff --exit-code src/server/commerce/db-types.ts
pnpm check:roadmap
```

Acceptance (section 5, phase 1): an invoice can be created, issued and cancelled through the
repository API with correct totals and a legally complete field set, with zero interface, and no
database role can change an issued document.

### P1.12 Resolutions of what the earlier text left open

Each follows from the documents named; none needed Marlin.

1. **Numbering mechanism.** Section 4.4 says one `SEQUENCE` per company, type and year; receipts
   plan D4 (later, decided) says a counter row per company locked for the transaction, and the
   amendment says the counter starts after the highest imported number. Taken: the counter row,
   no yearly reset (D4's reason against a year prefix applies to a yearly series too).
2. **Where the number format lives.** Section 4.5 put `number_formats` on the template; with one
   series per company (D4), a format per template could split or reformat the series when a
   template changes. Taken: the format lives on the counter row.
3. **Credit note and offer series.** The amendment and D4 changed only invoices. Section 4.4's
   separate `GS` and `ANG` series are kept, minus the year (resolution 1): `GS-{n}`, `ANG-{n}`,
   from 1. Reversible configuration until the first credit note is issued; decided, say so if you
   disagree.
4. **Sender block and tax status.** Section 4.5 put the sender on the template; receipts plan D3
   says it is a company setting, read from the auth-brain company record where it holds the
   field, never in the repository; auth-brain holds no tax number, bank details or section 19
   status. A per-company value on a template row would change with `is_default`, so a small
   `books_company_settings` table holds `tax_status`, the exemption note, the sender block and the
   default payment terms; the template keeps layout only. "Never in the repository" is read as
   "no constant in the code": the init script fills the row from auth-brain plus a local file.
5. **`kleinunternehmer` per document.** Section 4.2 has it as a document column; section 19 is
   all or nothing for the company. Taken: derived from `tax_status` on every recompute, never a
   caller input.
6. **Customer fields.** Section 4.1's `Customer` held name, address and `customer_number`; the
   amendment and receipts plan D3 move name and address to the shared contacts database, whose
   package also owns the customer number. The receipts plan keeps "business or consumer, VAT id,
   country" on `Customer`, although the contact also has `vatId` and `country`. Taken: the
   customer row is authoritative for tax, the contact prefills it once at creation; drift is shown
   by phase 2's editor, not resolved silently.
7. **When the contacts database is first used.** Amendment item 6 lists "the shared contacts
   database for recipients" under the connections built after the import, but item 3 and D3 make
   the contact the only source of the recipient's name and address, which an issued invoice must
   carry (section 34a). Taken: phase 1 builds the port, the package adapter and its tests; the
   connection of a deployed app to the production contacts database is roadmap line 4.
8. **Import versus "stays in receipt-ocr-app".** The answered-questions block of section 6
   (2026-10-14) says invoices 28 to 61 stay in receipt-ocr-app and are not imported; the
   amendment (2026-10-15, later) imports them after phase 3. The amendment wins; phase 1 is not
   affected except that `source` and the import-relaxed CHECK branch exist, and the counter starts
   at 62 either way.
9. **Immutability mechanism.** Section 4.6 says "enforced the same way `stock_movement` is" (a
   REVOKE); a REVOKE cannot keep drafts editable and binds only the app role, and CM-13 found the
   commerce REVOKEs undone by provisioning grants. Taken: row-conditional triggers for
   documents, lines and events, plus the house REVOKE on the event table registered in
   `APPEND_ONLY_TABLES`.
10. **Status machine in phase 1.** Receipts plan D2 uses `draft, issued, cancelled`; section 4.2
    has the full machine with `sent` and `paid`, and receipts plan D6 keeps payments in the
    receipts app. Taken: the full enum and trigger machine (no later migration), phase 1's API
    performs only `draft -> issued` and `-> cancelled`.
11. **Credit note amounts.** Positive amounts with the type carrying the sign, matching the money
    CHECKs and the `004` `credit_note` table; one full credit note per invoice in phase 1
    (partial ones are deferred by receipts plan section 6 item 6).
12. **Group-scoped catalog.** Lines reference `product_variant` in the tenant group schema, which
    has no `tenant_id`; two companies in one group therefore share one product and service list.
    That is the commerce design (catalog per tenant group), not something Books changes.
13. **Third-country recipients under regular taxation.** Not covered by section 4.7's scope
    (domestic plus EU business reverse charge); issue refuses with `TAX_CASE_UNSUPPORTED` instead
    of printing a wrong note. Irrelevant while the company is under section 19.
14. **Where the shared tax guard lives.** Section 5 phase 1 item 3 says lift it into the Books
    `taxProfile.ts`; the order orchestrator importing from the Books module would invert the
    dependency. Taken: `src/server/tax/germanVat.ts`, imported by both, which keeps the plan's
    point (one place).
15. **Exemption note wording.** Section 34a requires "a note that the small-business exemption
    applies", no fixed text. Default `Gemäß § 19 UStG wird keine Umsatzsteuer berechnet
    (Kleinunternehmerregelung).`, stored per company and editable; decided, say so if you
    disagree.

**Deviations found while building phase 1 (2026-10-17).** Each follows from the spec's own
reasoning; decided, say so if you disagree.

16. **The codegen diff check could not hold as written.** `pnpm db:codegen-commerce` failed on
    main (kysely-codegen needs the `pg` driver, which the repository does not carry), and even
    when it ran it wrote a three-line header over kysely-codegen's raw output while the committed
    `db-types.ts` was hand-annotated, so `git diff --exit-code` could never be clean. Taken: the
    script now introspects the provisioned schema itself and writes the whole committed file,
    with what introspection cannot see (trigger-maintained columns, JSONB shapes, docs) declared
    next to its reason; an unmapped JSONB column or type fails the run. kysely-codegen is removed.
    The commerce types came out unchanged except for one fix: the file now defines its own
    `Generated<T>` (as kysely-codegen does), because kysely's does not unwrap a nested
    `ColumnType`, so `Generated<Timestamp>` had been selecting as an object type.
17. **`toJsonb` is a cast expression, not `JSON.stringify`.** postgres.js JSON-serializes a
    parameter the server types as jsonb, so a pre-serialized string was stored as a JSON string
    scalar. `toJsonb(value)` returns `sql\`${JSON.stringify(value)}::text::jsonb\`` (the
    contacts-core pattern), and `JsonColumn<T>` accepts only that branded expression on write, so
    passing a plain string is a compile error.
18. **Guards `DEFAULT_ROOTS`.** Already `['src', 'scripts']` since CM-13, so `src/server/books`
    and `src/server/tax` are scanned without adding them; nothing added.
19. **Re-running `initBooksCompany`.** Read literally, "a lower `nextValue` is `COUNTER_EXISTS`"
    makes every re-run fail once a document was issued (the counter is then above the configured
    start), which contradicts "idempotent". Taken: an existing counter is never changed; a
    different format, or a requested `nextValue` ABOVE the current value (it would skip numbers),
    is `COUNTER_EXISTS`; a value at or below the current one leaves it as it is. The settings row
    is upserted (configuration; issued documents carry their own sender snapshot).
20. **The issue-date order check runs after the counter lock** (step 7, not step 6), where
    concurrent issues of one company are already serialized; the format and "not in the future"
    checks run up front, before any read. Same rule, no race.
21. **Event timestamps are stamped by the repository**, strictly increasing within the process,
    because `CURRENT_TIMESTAMP` is frozen per transaction and a cancellation writes three events
    in one; events are read ordered by `(created_at, id)`.
22. **Small extensions of the stated interfaces:** `TaxProfile` carries `supported` (false for a
    third country under regular taxation, the flag issue turns into `TAX_CASE_UNSUPPORTED`);
    `booksScope` takes an optional fourth argument `{ recipients }` (the `RecipientDirectory` the
    tests substitute; the default is the contacts database); a draft without a customer is
    computed as a domestic consumer under its own key (`<status>|||`), so the first customer
    always changes the key; the shared column lists live in `repository/columns.ts`, the derived
    tax state in `repository/taxState.ts`, the event writer in `repository/events.ts`; an offer's
    `issued -> draft` skips the frozen-row comparison (the draft CHECK forces the number off).
23. **`books:init-company` flags.** Beside `--tenant-group`, `--tenant` and `--sender`, the script
    takes `--tax-status` and repeated `--counter 'invoice={n}:62'` (formats are configuration,
    never constants), and `--sender-file-only` to skip auth-brain. It reads the company through
    `GET /api/admin/machine/tenants?group_id=...` with `AUTH_BRAIN_ADMIN_API_KEY` (the SDK has no
    company read); auth-brain wins for legal name, VAT id and billing address.
24. **Not done in phase 1, because it is a live action:** scaffolding `CONTACTS_DATABASE_URL` as a
    placeholder in framer-clone's Infisical project and copying the value with `copy_secret`.
    The variable is documented in `.env.example`; unset, issuing answers
    `RECIPIENT_UNAVAILABLE`. It belongs with roadmap line 4's production wiring.
25. **Review hardening (2026-10-18), so that no database role can change an issued document.**
    `007_books` (never applied outside test containers) is tightened in place:
    - a document is inserted as a draft unless `source = 'import'` (BK004), an import carries
      its number, dates and snapshots and is never a draft (CHECKs; this replaces the earlier
      "the import may relax the issued CHECK" branch), and `id`, `tenant_id`, `doc_type` and
      `source` are fixed on every update, drafts included (BK001), so a draft cannot become an
      import;
    - number counters cannot be deleted, truncated or moved to another company or type (BK003),
      and `commerce_app` has no DELETE on them (`NO_DELETE_TABLES`, re-applied after the
      provisioning and fleet grants);
    - TRUNCATE is refused on `sales_document` and `sales_document_line` (BK001) as on the event
      table (BK002); `books_company_settings` is configuration, not frozen, and has none;
    - the JSONB columns carry shape CHECKs (snapshots, sender block and payload are objects,
      tax summary and footer blocks are lists), and `toJsonb` refuses null and undefined.
    In the domain: `issue` repeats the billable-line check on the lines read under the document
    lock; the issuer's tax id follows section 14 (4) no. 2 UStG and section 34a UStDV (under
    Section 19 tax number, VAT id or small-business identification number; under regular
    taxation tax number or VAT id; a reverse-charge invoice needs the VAT id, section 14a); a
    credit note is never dated before its invoice; line and document amounts are capped at
    2^31 - 1 cents (`INVALID_LINE`); `issued_at` follows the injected clock; `getDocument` reads
    in one REPEATABLE READ snapshot; a forged list cursor is `INVALID_INPUT`; the cancellation
    reason is capped at 200 characters and must not contain personal data.
    `books:init-company` (refining item 23): `--tax-status` is required only the first time, and
    on a re-run an omitted tax status, exemption note or payment terms keeps the stored value;
    the sender's country must be an ISO 3166-1 alpha-2 code; the address is taken whole from one
    source (auth-brain's billing address when it has one, otherwise the file), never mixed.

## 1. Audit: what actually exists today

Verified by reading the repos on 2026-08-15, not inferred from docs.

### 1.1 framer-clone commerce

Single schema file `prisma/schema.prisma` (~1050 lines, `schemas = ["commerce", "public"]` at line 40).

**Exists, and is genuinely rigorous:**

| Area | Models | Location |
|---|---|---|
| Inventory | `InventoryItem`, `StockLocation`, `InventoryLevel`, `StockMovement` (append-only), `Reservation`, `FulfillmentLocationDefault` | schema.prisma:438-562 |
| Catalog | `Product`, `ProductOption`, `ProductOptionValue`, `ProductVariant`, `ProductVariantOption` | 607-716 |
| Pricing | `PriceSet`, `Price`, `PriceRule`, `PriceList` | 768-840 |
| Orders | `Order`, `OrderLineItem` | 980-1047 |
| Corrections | `CreditNote`, `CreditNoteRef` | 856-885 |

The German tax model on `Order` is already correct and load-bearing: `taxRegion`, `vatId`, `customerType (b2c|b2b)`, `reverseCharge`, `netOrGross`, `kleinunternehmer`, `taxNote`, plus per-line `taxClass`, `taxRate` as integer basis points (1900 = 19 percent), `taxAmount`, `taxTreatment (standard|reduced|zero|reverse_charge|kleinunternehmer)`. Money is integer cents everywhere. `src/server/commerce/order/createOrder.ts:472-480` actively rejects the illegal `{customerType:'b2c', reverseCharge:true}` combination. Tax is snapshotted at order time and never recomputed on reprint (`createOrder.ts:36`). Placed order lines are append-only, enforced at the DB level (`order/__tests__/createOrder.itest.ts:83, 481, 511`).

**Missing, plainly:**

- **Customer: does not exist.** No `Customer`, `Contact`, `Client`, or `Company` model. `CustomerType` is an enum (`b2c|b2b`, schema.prisma:940), a tax classification flag on `Order`, not an entity. `src/app/api/commerce/orders/route.ts:32-37` says it in code: "This is an ANONYMOUS storefront write: the published storefront has no session. The full D4 guest-customer DB model is deferred."
- **Invoice: no entity.** "Invoice" exists only as semantics attached to `Order`. The only invoice-named model is the corrective one, `CreditNote`.
- **Offer: does not exist.** No `src/server/offers/`, no `src/app/api/offers/`, no `src/app/o/`. The one artifact that survived the offers design is the binding socket, and it did land: `OrderLineItem.variantRef` + `variantRefSource (none|datatable|owned)` (schema.prisma:958, 1036-1039), exactly the shape `slice1-variant-resolver-socket.md` specified, with the "NO 'medusa'" rule honored.

**Two live risks that this plan must route around, not inherit:**

1. Commerce is **not actually multi-tenant yet**. `src/server/commerce/tenant.ts:43` does `void site;` and returns the constant `COMMERCE_SCHEMA = 'commerce'` (`withTenant.ts:43`). The in-code comment names the blocker: "LIMITATION (UNTIL MT-18): multi-tenant commerce is BLOCKED to one tenant. This resolver maps EVERY site to the single shared COMMERCE_SCHEMA." The per-tenant `tg_<hex32>` provisioning machinery exists (`src/server/commerce/provisioning/provision.ts:73-76`, PRs #72 to #83) but is not wired into the render path.
2. The four `/api/commerce/*` routes carry **no session guard**. Reads are intentionally public (PR #20); the order POST is guarded only by published-host resolution (`orders/route.ts:54, 145-150`).

Auth in framer-clone is real and auth-brain-based: `@marlinjai/auth-brain-sdk ^1.1.0` (package.json:29), `src/server/auth/requireWorkspaceScope.ts` reads the `lumitra_session` cookie, calls `verifySession`, `resolveActiveScope`, then `checkWorkspaceAccess`. Fail-closed, typed `AuthError` 401/403.

### 1.2 receipt-ocr-app

Next.js 16 + Prisma 6.19 + Postgres, deployed at receipts.lumitra.co (GHCR image, Coolify, `prisma migrate deploy` at boot). Branch `main`, working tree clean.

**There is no `Receipt` model.** Receipts are rows in a generic Notion-style data table: `DtRow.cells Json` in `prisma/schema.prisma`, keyed by column UUID. The actual receipt field list is code, `COLUMNS` in `src/app/app/actions.ts:302-338`, created idempotently per workspace by `initializeReceiptsTable()`: Name, Vendor, Gross, Net, Tax Rate, Date, Category (10 German SKR03 categories), Konto, Status (Pending|Processed|Rejected), Confidence, Receipt Image (multi-file), OCR Text, Zuordnung (Universität|Geschäftlich|Privat), Currency, FX Rate, EUR Equivalent (formula), Business Share %, Attributed EUR (formula), Project.

SKR03 account mapping lives in `src/lib/receipts-constants.ts` (`CATEGORY_TO_KONTO`: Bewirtung 4650, Reisekosten 4670, Bürobedarf 4930, Software 4806, Telefon 4920, Hardware 4855, Miete 4210, Versicherungen 4360, Fachliteratur 4940, Sonstige 4900).

OCR: Google Cloud Vision `DOCUMENT_TEXT_DETECTION` plus regex extraction (`src/lib/extract-receipt-fields.ts`, 537 lines) and LLM classification via OpenRouter, or a multimodal single-shot path (`src/lib/multimodal-ocr.ts`) behind `USE_MULTIMODAL_OCR`.

Export: `src/lib/export-csv.ts`, a simplified DATEV-shaped semicolon CSV (`Datum;Belegnummer;Buchungstext;Betrag Brutto;Betrag Netto;Steuersatz;Konto;Gegenkonto;Kategorie;Zuordnung`). Not the official DATEV EXTF/ASCII format. `Belegnummer` and `Gegenkonto` are in the header but have no source column, so they always export empty. Zero references anywhere in the repo to ELSTER, GoBD, UStVA, or Vorsteuer.

Auth is fully integrated and is the most advanced integration in the suite: `@marlinjai/auth-brain-nextjs ^0.4.1`, `src/lib/auth.ts` calls `createAuthBrainNextjs({ appName:'receipts', workspaces:{appGrant:{app:'receipts'}}, activeWorkspaceCookie:'receipts_ws', permissions:{...} })`, `src/middleware.ts` is `auth.createAuthMiddleware()`, and `src/lib/auth-guards.ts` does per-resource inner checks against OpenFGA.

**Scoping key: `dt_tables.workspace_id` is an auth-brain workspace UUID.** Newer app tables use `auth_workspace_id`. This is the mismatch this plan has to fix, see section 3.

### 1.3 auth-brain

Located at `ERP-suite/projects/lumitra-infra/auth-brain`. No Prisma at all: raw SQL migrations, `packages/app/migrations/001..017`.

Hierarchy (`002_tenants.sql`, `003_workspaces.sql`):

```
tenant_groups            (recursive, is_personal flag)
  └─ tenants             THE COMPANY: slug, legal_name, vat_id, billing_address, stripe_customer_id
       └─ workspaces      tenant_id FK, slug, UNIQUE(tenant_id, slug)
```

Membership is a join table per tier, never a direct FK. Roles: `tenant_group.{owner,admin,member}`, `tenant.{owner,admin,billing_admin,member,viewer}`, `workspace.{admin,member,viewer}`, `platform.{admin,auditor}`.

"tenant = company" (PR #49, commit `c387b96`, 2026-07-24) was a vocabulary and UX decision, not a table rename. Tenants have carried the company-shaped columns since migration 002.

Consumer surface: `@marlinjai/auth-brain-sdk@1.6.1`, `@marlinjai/auth-brain-nextjs@0.4.x`, `@marlinjai/auth-brain-shared@1.6.0`. Session is an **opaque server-side session id in the `lumitra_session` cookie**, not a JWT, verified over HTTP against `POST /api/sessions/verify`. The verify payload (`packages/shared/src/types.ts:148`) carries:

```ts
{ user, session,
  tenants: Array<Tenant & { role, app_grants: string[] }>,
  workspaces: Array<Workspace & { role }>,   // each has .tenant_id
  active_tenant: Tenant | null,
  active_workspace: Workspace | null,
  effective_roles: EffectiveRoles }
```

App entitlements are granted at the **tenant** level, deliberately: `docs/plans/2026-07-24-app-entitlements.md` (status completed) says "companies are the billing unit". Admin machine API is `ADMIN_API_KEY`-Bearer under `packages/app/src/app/api/admin/machine/*` and covers orgs, tenants, workspaces, memberships, invitations, app-grants, service accounts and keys.

Note the existing divergence: **receipts scopes data by workspace UUID; analytics scopes by tenant UUID** (`analytics-platform/packages/dashboard/src/lib/scope.ts`, `projects.company_id` is the auth-brain tenant UUID). Both read the same verify payload. Section 3 picks a side for the books.

---

## 2. Item (d): was the offers-first inversion deliberate or drift?

**Answer: deliberate, documented, and dated, but the answer is more specific than "they changed their mind about sequencing", and there is a real residual decision left for Marlin.**

Evidence, in the repo:

- `framer-clone/docs/specs/build-2026-06/ROADMAP.md`, frontmatter `status: decided`, `date: 2026-06-16`, contains an explicit supersede note: it "SUPERSEDES the prior P0-P6 ROADMAP (which sequenced lumitra-web offers as Slice 1)... Per the 2026-06-16 re-scope, this workstream is framer-clone-ONLY... The 8 lumitra-web offers/CRM specs (`slice-1-offers-doc-tier/`) plus the dropped `slice2-doc-tier-shared-package` are PARKED to a separate lumitra-web workstream."
- All 8 spec files in `docs/specs/build-2026-06/slice-1-offers-doc-tier/` carry `targetRepo: .../projects/lumitra-web` and an identical PARKED banner. **They were never framer-clone specs.**
- `docs/specs/STATUS.md:20,43` records the same: "PARKED (lumitra-web workstream)".
- Git corroborates: the 8 specs were committed once in `938587b` (2026-06-17, PR #28) and never touched again, while commerce ran the full b1 to b7 chain (PRs #3 to #20) and then CM-01 to CM-12 (PRs #71 to #83).

So the inversion was not drift and it was not a rejection of offers-first on the merits. The framer-clone build loop was **narrowed to one repo**, and the offers work, which targeted a different repo (lumitra-web), fell out of scope by construction. Nothing was decided about offers being wrong; they were simply not in the narrowed scope.

**What is genuinely undecided, and is a real question for Marlin:** the 2026-06-16 re-scope pointed the offers/invoices document tier at **lumitra-web**, over the data-table doc tier (collections Clients/Projects/Offers/LineItems/Activities as `dt_*` rows). Since then, framer-clone grew the correct German tax model, the integer-cents money path, the append-only invoice semantics, the Storno/Gutschrift entity, and the `variantRef` socket. Building invoices in lumitra-web now would mean reimplementing all of that against a JSON grid.

**Recommendation (and what this plan assumes): re-home the offers/invoices document tier into framer-clone as native Prisma models, and formally supersede the 8 parked lumitra-web specs.** The reasons are concrete: the tax engine, the credit-note model, the money type discipline, and the binding socket already live here, and the 2026-06-01 architecture's own locked decision 2 says the document tier must not be the data-table grid for anything that carries money semantics. The parked specs' genuinely portable content (the `ANG-YYYY-####` sequence approach, the status machine, the totals formula, the activity log, the token-based public offer page) is lifted into sections 4 and 5 below rather than discarded.

If Marlin wants the doc tier in lumitra-web instead, phases 1 to 3 move repos wholesale and this plan needs a rewrite, so this is the one gate to answer before Phase 1 starts.

**DECIDED 2026-08-16: re-home into framer-clone, per the recommendation above.**
Confirmed lumitra-web is the lumitra.co public marketing/sales website (the
Mittelstand-KI positioning site, offer-ladder pricing pages), not a
candidate backend for any repo's document tier regardless of the tax-engine
reuse argument, it is simply the wrong kind of system. Phase 1 is clear to
start.

---

## 3. Identity: the books belong to the company, not the workspace

The two apps already share the same session: one `lumitra_session` cookie on `.lumitra.co`, one `verifySession` call, one OpenFGA model. Nothing new is needed for authentication. The work is in **scoping**.

**Decision: the books are scoped to the auth-brain tenant (the company), not the workspace.**

Reasons, not preference:

1. `tenants` is the only tier carrying the legal-entity fields an invoice needs: `legal_name`, `vat_id`, `billing_address` (migration `002_tenants.sql`). A workspace has a slug and nothing else.
2. App grants are already tenant-level ("companies are the billing unit", `auth-brain/docs/plans/2026-07-24-app-entitlements.md`).
3. A tax year and a USt-Voranmeldung are per legal entity. Splitting one company's books across two workspaces would be a bug, not a feature.
4. analytics already scopes this way (`projects.company_id` is the tenant UUID), so this follows existing precedent rather than inventing a third convention.

**Consequence for receipt-ocr-app:** it scopes by workspace today. Do **not** re-scope receipts storage, that would be a risky migration for no gain. Instead denormalize: add `authTenantId` alongside the existing workspace column, resolved from the verify payload (each `workspaces[]` entry carries `.tenant_id`, and `active_tenant` is right there), and backfill once. Receipts keeps working exactly as it does; the books read by tenant.

**Consequence for framer-clone:** the new document-tier tables carry an explicit `tenantId String` column (auth-brain tenant UUID) and are **not** placed behind the `withTenant` schema-per-tenant seam. That seam is blocked on MT-18 and would make the dogfood wait on unrelated work. Row-level `tenantId` scoping is the same pattern the CMS already uses (`Site.workspaceId`) and is what analytics does. When MT-18 lands, the document tier can move behind the schema seam as a mechanical migration; nothing in the API shape depends on the choice.

**App grant:** add a new tenant-level grant slug `books`. receipts keeps its `receipts` grant (do not widen it). framer-clone's document-tier routes require `books`. Grant it to the `marlinjai` tenant only, via the admin machine API (`POST /api/admin/machine/app-grants`).

**Cross-app data flow: pull, never push, and no shared database.** framer-clone never connects to the receipts Postgres. In Phase 4, receipt-ocr-app exposes one read-only machine endpoint that returns normalized expense lines for a tenant and date range, authenticated by an auth-brain service-account API key (`verifyApiKey` in the SDK, keys minted through `POST /api/admin/machine/service-accounts/[id]/keys`). Note that receipts' current `SERVICE_TOKEN` bearer path is not tenant-scoped, which is already flagged in its own ROADMAP; the new endpoint must use the service-account key path and enforce the tenant, not the shared token.

---

## 4. The minimal schema

New Prisma models in `framer-clone/prisma/schema.prisma`, `commerce` schema. Money is integer cents throughout, matching the existing `Order`. Tax rates are integer basis points, matching `OrderLineItem.taxRate`.

### 4.1 Customer

```prisma
model Customer {
  id             String   @id @default(uuid())
  tenantId       String   @map("tenant_id")
  customerNumber String   @map("customer_number")   // KD-00042, allocated on create
  kind           CustomerKind                        // person | organization
  displayName    String   @map("display_name")       // what you search by
  legalName      String?  @map("legal_name")         // renders on the invoice if set
  email          String?
  phone          String?
  vatId          String?  @map("vat_id")             // USt-IdNr, drives reverse charge
  taxNumber      String?  @map("tax_number")         // Steuernummer, DE domestic
  addressLine1   String?  @map("address_line1")
  addressLine2   String?  @map("address_line2")
  postalCode     String?  @map("postal_code")
  city           String?
  countryCode    String   @default("DE") @map("country_code")   // ISO 3166-1 alpha-2
  defaultCustomerType CustomerType @default(b2c) @map("default_customer_type")
  defaultCurrency     String       @default("EUR") @map("default_currency")
  defaultNetOrGross   NetOrGross   @default(net) @map("default_net_or_gross")
  defaultPaymentTermsDays Int      @default(14) @map("default_payment_terms_days")
  notes          String?
  archivedAt     DateTime? @map("archived_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  documents      SalesDocument[]

  @@unique([tenantId, customerNumber])
  @@index([tenantId, displayName])
  @@map("customer")
  @@schema("commerce")
}

enum CustomerKind { person organization @@schema("commerce") }
```

`CustomerType` and `NetOrGross` are the **existing** enums at schema.prisma:940 and 976. Reuse them, do not define parallel ones.

### 4.2 SalesDocument

One entity for offer, invoice, and credit note. They share totals, tax summary, snapshot semantics, numbering, and rendering; only the status machine and the number series differ. Three near-identical tables would be three places to get §14 UStG wrong.

`SalesDocument` is deliberately **separate from `Order`**. An `Order` is a storefront transaction with inventory effects. A `SalesDocument` is a legal document, and the dogfood case (a consulting invoice from Marlin to a client) has no order behind it at all. The two are joined by a nullable `sourceOrderId`, which is how a future storefront order gets an invoice without either model bending.

```prisma
model SalesDocument {
  id            String   @id @default(uuid())
  tenantId      String   @map("tenant_id")
  docType       SalesDocType                      // offer | invoice | credit_note
  status        SalesDocStatus @default(draft)
  documentNumber String? @map("document_number")  // NULL until issued. See 4.4.

  customerId    String   @map("customer_id")
  customerSnapshot Json  @map("customer_snapshot") // frozen at issue: name, address, vatId
  senderSnapshot   Json  @map("sender_snapshot")   // frozen at issue: the template sender block

  issueDate     DateTime? @map("issue_date")       // Rechnungsdatum, set at issue
  serviceDate   DateTime? @map("service_date")     // Leistungsdatum, required by §14 UStG
  servicePeriodStart DateTime? @map("service_period_start")
  servicePeriodEnd   DateTime? @map("service_period_end")
  dueDate       DateTime? @map("due_date")         // invoices
  validUntil    DateTime? @map("valid_until")      // offers

  currencyCode  String   @default("EUR") @map("currency_code")
  taxRegion     String   @default("DE") @map("tax_region")
  customerType  CustomerType @map("customer_type")
  vatId         String?  @map("vat_id")
  reverseCharge Boolean  @default(false) @map("reverse_charge")
  netOrGross    NetOrGross @default(net) @map("net_or_gross")
  kleinunternehmer Boolean @default(false)
  taxNote       String?  @map("tax_note")

  subtotal      Int      // cents, net
  taxAmount     Int      @map("tax_amount")
  total         Int
  taxSummary    Json     @map("tax_summary")  // [{ taxRate: 1900, net: 100000, tax: 19000 }]

  templateId    String?  @map("template_id")
  renderedPdfFileId String? @map("rendered_pdf_file_id")  // storage-brain file id
  introText     String?  @map("intro_text")
  outroText     String?  @map("outro_text")

  sourceOrderId String?  @map("source_order_id")   // nullable link to a storefront Order
  correctsDocumentId String? @map("corrects_document_id") // credit_note -> the invoice it storniert

  issuedAt      DateTime? @map("issued_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  customer      Customer  @relation(fields: [customerId], references: [id], onDelete: Restrict)
  lines         SalesDocumentLine[]
  events        SalesDocumentEvent[]

  @@unique([tenantId, docType, documentNumber])
  @@index([tenantId, docType, status])
  @@index([tenantId, issueDate])
  @@map("sales_document")
  @@schema("commerce")
}

enum SalesDocType   { offer invoice credit_note @@schema("commerce") }
enum SalesDocStatus { draft issued sent accepted rejected paid cancelled @@schema("commerce") }
```

Status machine, per type (lifted from `slice1-domain-numbering-totals-status-activity.md`, adapted):

- offer: `draft -> issued -> sent -> (accepted | rejected | cancelled)`; `issued -> draft` is allowed **only while unsent**
- invoice: `draft -> issued -> sent -> paid`; `cancelled` only via a `credit_note` that references it, never by mutation
- credit_note: `draft -> issued -> sent`

### 4.3 SalesDocumentLine

```prisma
model SalesDocumentLine {
  id          String @id @default(uuid())
  documentId  String @map("document_id")
  position    Int
  kind        LineKind @default(service)   // service | product | text
  title       String
  description String?
  quantity    Int                          // thousandths, so 1.5 h = 1500
  unitLabel   String @default("Stk") @map("unit_label")
  unitPrice   Int    @map("unit_price")    // cents, net
  discountBp  Int    @default(0) @map("discount_bp")
  subtotal    Int                          // cents, net after discount
  taxClass    String? @map("tax_class")
  taxRate     Int    @map("tax_rate")      // basis points, 1900 = 19%
  taxAmount   Int    @map("tax_amount")
  taxTreatment TaxTreatment
  variantRef       String? @map("variant_ref")
  variantRefSource VariantRefSource @default(none) @map("variant_ref_source")

  document    SalesDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@unique([documentId, position])
  @@map("sales_document_line")
  @@schema("commerce")
}

enum LineKind { service product text @@schema("commerce") }
```

`TaxTreatment` and `VariantRefSource` are the **existing** enums (schema.prisma:970-975, 1038-1039). This is the surviving offers socket, reused exactly as designed: a nullable loose TEXT ref with no FK, so a product line binds later without a migration.

### 4.4 Numbering

A German invoice number must be unique and gapless-in-intent (`§14 Abs. 4 Nr. 4 UStG`: "fortlaufende Nummer"). Two rules:

1. **One Postgres `SEQUENCE` per `(tenantId, docType, year)`**, created lazily, read with `nextval`. Gap-tolerant by design: a rolled-back transaction burns a number, which is legally acceptable and far safer than a `MAX(n)+1` race. This matches the parked spec's approach.
2. **The number is allocated at issue, inside the same transaction that flips `status` to `issued`, never at draft creation.** Drafts have `documentNumber = NULL`. This is the single most important rule in the schema: allocating at draft creation means every abandoned draft leaves a permanent hole in the invoice series, which is exactly the thing a Betriebsprüfer asks about.

Format: `RE-2026-0001` (invoice), `ANG-2026-0001` (offer), `GS-2026-0001` (Gutschrift). Prefix and padding configurable per template.

### 4.5 DocumentTemplate

```prisma
model DocumentTemplate {
  id          String @id @default(uuid())
  tenantId    String @map("tenant_id")
  name        String
  isDefault   Boolean @default(false) @map("is_default")
  locale      String  @default("de-DE")

  senderBlock Json    @map("sender_block")  // see below
  logoFileId  String? @map("logo_file_id")  // storage-brain
  accentColor String? @map("accent_color")
  footerBlocks Json   @map("footer_blocks")  // up to 4 columns of small print
  numberFormats Json  @map("number_formats") // { invoice: "RE-{YYYY}-{####}", ... }
  defaultPaymentTermsDays Int @default(14) @map("default_payment_terms_days")
  defaultIntroText String? @map("default_intro_text")
  defaultOutroText String? @map("default_outro_text")

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@unique([tenantId, name])
  @@map("document_template")
  @@schema("commerce")
}
```

`senderBlock` is a typed Json shape validated by zod, holding the fields German law requires on the issuer side: `legalName`, `addressLine1`, `postalCode`, `city`, `countryCode`, `vatId` or `taxNumber` (at least one is mandatory), `email`, `phone`, `website`, `bankName`, `iban`, `bic`, `registerCourt`, `registerNumber`, `managingDirector`. Seed the default template for the `marlinjai` tenant from auth-brain's `tenants.legal_name` / `vat_id` / `billing_address` so the letterhead is not typed twice.

### 4.6 SalesDocumentEvent

Append-only audit trail, one row per state transition and per issue/send/render, carrying `actorUserId`, `fromStatus`, `toStatus`, `payload Json`, `createdAt`. This is the GoBD Aufzeichnungspflicht surface and the offers spec's Activity log collapsed into one thing. No UPDATE, no DELETE, enforced the same way `stock_movement` is.

### 4.7 What is deliberately NOT in scope

- No `Vendor` entity on the receipts side. Vendor stays a string plus the existing `workspace_vendor_attribution` rows. A real supplier model is a Phase 5+ question.
- No OSS threshold accumulation. Marlin's own books are domestic plus occasional EU B2B reverse charge. OSS is a real stateful computation (see the 2026-06-01 doc, section 6.3) and does not belong in a dogfood.
- No Stripe, no dunning, no payment reconciliation. Payment status is a manual flag in Phase 2.
- No multi-currency invoicing. Receipts already handles FX for expenses; invoices are EUR only until a non-EUR client exists.

---

## 5. Phased sequencing

Five phases. Each ships something usable on its own and each has a verify command that must be green before the next starts.

### Phase 0: receipts tenant awareness (prerequisite, small)

Repo: receipt-ocr-app.

1. Add `authTenantId String?` to `DtTable` and to the four app-level models that already carry `authWorkspaceId` (`SheetImportConfig`, `WorkspaceVendorAttribution`, `OverviewSelection`, `WorkspaceNotes`). Migration `0007_tenant_scoping`.
2. Resolve it in `src/lib/auth-workspace.ts`: add `sessionTenantId(session)` reading `active_tenant.id`, and `tenantIdForWorkspace(session, workspaceId)` reading the matching `workspaces[].tenant_id`. Populate `authTenantId` on every write path.
3. One-shot backfill script resolving existing rows' workspace to its tenant via the auth-brain machine API.
4. Housekeeping, in the same PR: three plan files carry stale frontmatter for shipped work (`2026-07-16-auth-brain-multi-tenant-integration.md` and `2026-07-24-import-page-drive-browser.md` say in-progress, `2026-07-20-google-sheets-import.md` says draft) and both README and `docs/public/architecture.md` still describe the retired Cloudflare D1/Workers stack. Fix them.

**Verify:** `pnpm test && pnpm build && pnpm tsc --noEmit && pnpm lint`, plus a new unit test asserting that a write with a session whose `active_tenant` is null is rejected rather than silently writing a NULL tenant, plus a manual login at receipts.lumitra.co confirming rows carry the tenant.

**Acceptance:** every receipts row is attributable to exactly one auth-brain tenant, with no change to existing workspace behavior.

### Phase 1: the document domain, no UI

Repo: framer-clone.

1. Prisma models from section 4, one migration.
2. `src/server/books/` (new bounded module, sibling to `src/server/commerce/`): `numbering.ts` (the per-tenant-year sequence), `totals.ts` (pure functions: line subtotal from quantity/unitPrice/discount, `taxSummary` grouping per rate, document totals), `taxProfile.ts` (resolve `{customerType, vatId, countryCode, kleinunternehmer}` into the per-line `taxTreatment` and rate), `issue.ts` (the transactional issue: allocate number, freeze snapshots, write the event, flip status), `repository/`.
3. Reuse, do not re-derive: lift the reverse-charge guard from `src/server/commerce/order/createOrder.ts:472-480` into `taxProfile.ts` and have `createOrder` call the shared function, so the illegal B2C-plus-reverse-charge combination is rejected in exactly one place.

**Verify:** `pnpm test && pnpm build && pnpm tsc --noEmit && pnpm lint`, plus integration tests on a real Postgres covering: domestic 19 percent, reduced 7 percent, EU B2B reverse charge (zero VAT plus the "Steuerschuldnerschaft des Leistungsempfängers" note), Kleinunternehmer §19 suppression, mixed-rate `taxSummary` grouping, a credit note that references and offsets an issued invoice, and DB-level rejection of an UPDATE or DELETE on an issued document's lines.

**Acceptance:** an invoice can be created, issued, and corrected through the repository API with correct totals and a legally complete field set, with zero UI.

### Phase 2: admin routes and the draft-to-issue flow

Repo: framer-clone. This is the multi-step flow, so `knowledge-base/standards/stateful-flow-testing.md` binds here in full.

Routes under `src/app/api/books/`: customers CRUD, documents CRUD, `POST /documents/:id/lines`, `PATCH /documents/:id/lines/:lineId`, `POST /documents/:id/issue`, `POST /documents/:id/transition`, `POST /documents/:id/credit-note`. All guarded by the existing `requireWorkspaceScope` pattern extended to a `requireTenantScope` that also checks the `books` app grant. UI: a customer list, a document list, and a document editor.

The flow is: pick customer -> add lines -> pick template -> preview -> issue. Derived state and its keys:

| Derived state | Keyed to | Invalidated when |
|---|---|---|
| Per-line `taxTreatment` and `taxRate` | the customer's tax profile (`customerType`, `vatId`, `countryCode`) plus the document's `kleinunternehmer` flag | the customer is swapped, or the customer's VAT-ID or country changes |
| Document `subtotal` / `taxAmount` / `total` / `taxSummary` | the full line set | any line add, edit, reorder, or delete |
| The rendered preview | `(templateId, document updatedAt)` | either changes |
| `customerSnapshot` / `senderSnapshot` | `customerId` / `templateId` **at issue time only** | never after issue; that is the point |

The four required test paths:

1. **Forward:** draft, three lines, issue. Number allocated, snapshots frozen, event written.
2. **Backtrack and revise:** on a draft with lines priced at 19 percent, swap the customer from a German B2C person to a French B2B organization with a VAT-ID. Assert every line flips to `taxTreatment: reverse_charge` and `taxRate: 0`, the totals recompute, the `taxNote` appears, and any cached preview is discarded. Assert the counter-case too: swapping to a *different* German B2C customer leaves line tax untouched and does not re-render or re-price.
3. **Resume:** reload the editor mid-draft at each step. Persisted draft state carries the customer id and template id; on load, if the persisted computed totals do not match a recomputation from the persisted lines plus the current customer tax profile, discard the cached totals and recompute. Legacy draft state without the keys fails the match and safely recomputes.
4. **Re-entry:** after issuing, "new invoice" starts clean. Explicitly assert the new draft has `documentNumber = NULL` and did not inherit the previous document's id, number, or snapshots. Also assert that abandoning a draft and starting another consumes no number.

**Verify:** `pnpm test && pnpm build && pnpm tsc --noEmit && pnpm lint`, plus the four flow tests above named explicitly in the suite, plus a route-level test that an unauthenticated and a wrong-tenant request both get 403.

**Acceptance:** Marlin can create a customer and issue a real invoice from the UI, and no revision path can produce a document whose tax treatment disagrees with its customer.

### Phase 3: template rendering and PDF

Repo: framer-clone.

`DocumentTemplate` CRUD, a render pipeline (HTML to PDF), the rendered file stored to storage-brain with the id on `renderedPdfFileId`. Seed the default template from the auth-brain tenant record.

The load-bearing test is a **§14 UStG completeness check as code**, not a visual review: given an issued invoice, the rendered output must contain the supplier's full name and address, the recipient's full name and address, the supplier's USt-IdNr or Steuernummer, the recipient's USt-IdNr when reverse charge applies, the issue date, the document number, the service date or period, quantity and description per line, the net amount grouped per tax rate, the tax rate and tax amount per group, and the exemption or reverse-charge notice where applicable. A missing field fails the build.

Immutability rule: re-rendering an issued document must reproduce byte-identical content from the frozen snapshots, with zero recomputation. This mirrors `createOrder.ts:36`. Test it by mutating the underlying `Customer` row after issue and asserting the re-render is unchanged.

**Verify:** `pnpm test && pnpm build && pnpm tsc --noEmit && pnpm lint`, plus the completeness test, plus the re-render-after-customer-mutation test.

**Acceptance:** a rendered PDF is something Marlin would actually send to a paying client, and the law-required fields are enforced by CI rather than by eyeball.

### Phase 4: the books view (the actual payoff)

Both repos.

1. receipt-ocr-app exposes `GET /api/books/expenses?tenantId=&from=&to=`, authenticated by an auth-brain service-account API key (not the shared `SERVICE_TOKEN`), returning normalized lines: `{ date, vendor, description, grossCents, netCents, taxRateBp, taxAmountCents, konto, category, attributionPercent, attributedNetCents, currency, fxRate, receiptFileIds }`. Derived from the existing `dt_rows` cells via a mapper, tenant-enforced server-side.
2. framer-clone adds a Books page: per tenant, per period, revenue from issued invoices minus credit notes, expenses from the receipts endpoint, the resulting Ergebnis, and a USt block (Umsatzsteuer collected from invoices, Vorsteuer paid from receipts, the difference) suitable as UStVA preparation. Explicitly labeled preparation, not a filing.
3. Export: one combined DATEV-shaped CSV covering both sides, replacing the receipts-only export as the canonical one. Populate `Belegnummer` (which is currently always empty) from the invoice number on the revenue side and the receipt row id on the expense side.

**Verify:** both repos' full gates, plus a fixture test that a known set of invoices and receipts produces the expected revenue, expense, USt, and Vorsteuer figures, plus a test that a request for a tenant the caller has no grant on returns 403 and leaks no row count.

**Acceptance:** Marlin can open one page and see, for a real quarter, real revenue and real expenses for one company, and hand the CSV to a Steuerberater.

### Phase 5: deferred, listed so it is not rediscovered as a surprise

Invoice-from-Order (`sourceOrderId` wiring), the public token-addressed offer page and accept flow (spec 6 of the parked set, still good), Resend send-and-track, payment reconciliation, dunning, official DATEV EXTF export, OSS, and moving the document tier behind the `withTenant` schema seam once MT-18 lands.

---

## 6. Open questions for Marlin

1. **The one gate before Phase 1:** confirm the section 2 recommendation, that the offers/invoices document tier is re-homed into framer-clone as native Prisma models and the 8 parked lumitra-web specs are formally superseded. If not, phases 1 to 3 move repos and this plan is rewritten.
2. **Company scope:** these books are for one legal entity. Which tenant is it, `marlinjai` or a separate ON AG tenant? The plan assumes one tenant and the schema supports several, but the default template seed needs the right one.
3. **Kleinunternehmer status:** is the invoicing entity §19 UStG or regular VAT? It flips the default on every document and changes what the completeness test asserts.

**Answered 2026-10-14** (receipt-ocr-app `docs/plans/2026-10-14-invoicing-and-income.md`, where Marlin also re-confirmed this repo as the home of the invoice document): question 2, the company is Whiz-Art Media, the auth-brain company that holds the receipts; question 3, the business is under section 19 (every invoice from 2024 on, limits far from reached), so documents default to `kleinunternehmer` and the completeness test asserts the section 34a fields; while under section 19 neither a running number nor a service date is legally required, the Phase 3 check adds them once regular taxation starts. Two changes to this plan follow: invoice numbers continue the existing plain integer series at 62 (the configurable format with a start value, not `RE-2026-0001`), and `Customer` references the shared contacts database for name and address rather than storing its own copy. The register of earlier invoices (28 to 61) stays in receipt-ocr-app and is not imported here.
