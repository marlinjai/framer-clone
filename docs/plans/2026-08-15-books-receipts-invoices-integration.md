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
