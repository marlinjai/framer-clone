// scripts/commerce-codegen.ts
//
// Generates src/server/commerce/db-types.ts, the typed `CommerceDB` interface
// every commerce and Books repository is generic over, from the LIVE per-tenant
// DDL. The committed file is exactly this script's output, so the check
//
//   pnpm db:codegen-commerce && git diff --exit-code src/server/commerce/db-types.ts
//
// proves the types match the migrations (Books plan P1.11). Run it after every
// tenant migration change and commit the result.
//
// HOW IT WORKS:
//   1. boot a disposable `postgres:16-alpine` via testcontainers (TRUST auth, no
//      password literals; Docker found the same way the integration setup finds
//      it, scripts/docker-host.ts);
//   2. create the `commerce_app` role (the migrations' REVOKEs are guarded on
//      it), `migratePublic`, then `provisionTenant` with the full tenant
//      migration set, materialising one real `tg_<id>` schema;
//   3. introspect pg_catalog: the schema's enum types (in creation order, labels
//      in sort order), its tables (in creation order) and their columns (in
//      column order), plus the global `public.tenant_groups`;
//   4. emit the file: global tables under `public.<name>` keys only, tenant
//      tables under bare keys only (the public-prefix discipline), every column
//      with a database default (or a GENERATED expression) wrapped in
//      `Generated<>`.
//
// What introspection cannot see is declared below, next to the reason, and an
// unmapped case fails the run instead of guessing:
//   - COLUMN_OVERRIDES: trigger-maintained columns and the registry's status;
//   - JSON_COLUMNS: the TypeScript shape of every JSONB column (a JSONB column
//     without an entry is an error), written through toJsonb;
//   - TABLE_DOCS / COLUMN_NOTES: the documentation printed into the file.
//
// The earlier version piped kysely-codegen's output through a small fix-up and
// left a hand-annotated file as the contract, so the two could never be equal
// (and kysely-codegen needed the `pg` driver, which this repository does not
// carry). Generating the contract itself is what makes the diff check hold.
//
// RUN IT:  pnpm db:codegen-commerce   (requires Docker; never runs at build time)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import {
  assertTenantGroupId,
  migratePublic,
  provisionTenant,
  tenantSchema,
} from '@marlinjai/tenant-db';

import { COMMERCE_TENANT_MIGRATIONS } from '../src/server/commerce/migrations/tenant/index';
import { ensureDockerHost } from './docker-host';

const DB_NAME = 'framer_clone_codegen';
const APP_ROLE = 'commerce_app';
// A fixed throwaway tenant-group id, so the run is reproducible.
const TG = assertTenantGroupId('018f9c10-0000-7000-8000-0000000000c5');
const SCHEMA = tenantSchema(TG);

const OUT_FILE = fileURLToPath(new URL('../src/server/commerce/db-types.ts', import.meta.url));

// --- declarations introspection cannot make ----------------------------------

/** Column types that differ from what the catalog says, with the reason. */
const COLUMN_OVERRIDES: Record<string, string> = {
  // The registry's status is TEXT with a fixed vocabulary in the package DDL.
  'public.tenant_groups.status': "Generated<'provisioning' | 'active' | 'suspended'>",
  // Maintained EXCLUSIVELY by the 003_catalog triggers: never inserted or updated.
  'product_variant.option_signature': 'Generated<string | null>',
  // 010_books_upload_import: TEXT columns with a CHECK vocabulary (no enum type).
  'historical_import_item.status': 'Generated<HistoricalImportStatus>',
  'historical_import_extraction.outcome':
    "'ok' | 'refused' | 'invalid_output' | 'max_tokens' | 'unreadable' | 'error' | 'aborted' | null",
  // 015_books_products: TEXT columns with a CHECK vocabulary (no enum type).
  'books_product.kind': "Generated<'service' | 'product'>",
  'books_product.price_basis': "Generated<'net' | 'gross'>",
  'books_product.tax_class': "Generated<'standard' | 'reduced' | 'zero'>",
};

/** Named types the overrides above refer to, emitted with the scalar aliases. */
const EXTRA_TYPES =
  '/** The status of a staging row (a CHECK, not an enum type). */\n' +
  "export type HistoricalImportStatus = 'uploaded' | 'extracting' | 'ready' | 'needs_attention' | 'imported' | 'discarded';\n";

/** The TypeScript shape of every JSONB column (read parsed, written through toJsonb). */
const JSON_COLUMNS: Record<string, string> = {
  'books_company_settings.sender_block': 'SenderBlockV1',
  'document_template_version.document': 'TemplateDocumentV2',
  'sales_document.tax_summary': 'TaxSummary',
  'sales_document.customer_snapshot': 'CustomerSnapshotV1',
  'sales_document.sender_snapshot': 'SenderSnapshotV1',
  'sales_document.template_snapshot': 'TemplateSnapshot',
  // 018_books_text_format: the run model of render/richText.ts.
  'sales_document.intro_format': 'RichText',
  'sales_document.outro_format': 'RichText',
  'sales_document_event.payload': 'EventPayload',
  // 010_books_upload_import: parsed with zod on read (src/server/books/upload/staging.ts).
  'historical_import_item.extracted': 'Record<string, unknown>',
  'historical_import_item.corrected': 'Record<string, unknown>',
  'historical_import_item.problems': 'Array<Record<string, unknown>>',
  // 017_form_submissions: parsed with zod on read (src/server/forms/repository.ts).
  'form_submission.fields': 'Array<Record<string, unknown>>',
  // 020_catalogue_company: the formatted descriptions, the run model of render/richText.ts.
  'product.description_format': 'RichText',
  'collection.description_format': 'RichText',
};

/** The type-only imports the JSON shapes need. */
const JSON_IMPORTS = "import type {\n  CustomerSnapshotV1,\n  EventPayload,\n  SenderBlockV1,\n  SenderSnapshotV1,\n  TaxSummary,\n  TemplateDocumentV2,\n  TemplateSnapshot,\n} from '../books/snapshots';\nimport type { RichText } from '../books/render/richText';";

/** One doc comment per table (a table without one fails the run). */
const TABLE_DOCS: Record<string, string> = {
  'public.tenant_groups':
    "`public.tenant_groups`: the runner's registry (one row per `tg_<id>` schema),\nowned by @marlinjai/tenant-db's `002_tenant_groups` public migration.",
  inventory_item: '001_inventory_ledger: owned inventory item (SKU-bridged to variants).',
  stock_location: '001_inventory_ledger: a physical stock location.',
  inventory_level:
    '001_inventory_ledger: per-(item, location) stock level. `available_quantity`\nis GENERATED ALWAYS (stocked - reserved) STORED: read-only, never written.',
  stock_movement: '001_inventory_ledger: append-only stock movement ledger (no updated_at).',
  reservation: '002_guarded_reservation: soft stock reservation.',
  fulfillment_location_default: '002_guarded_reservation: per-workspace default fulfillment location.',
  product:
    '003_catalog (+ 004 tax_class, 020 company and shop fields): product or service of one company.\nA service has exactly one variant and no options (BK017).',
  product_option: '003_catalog: product option (e.g. "Size").',
  product_option_value: '003_catalog: product option value (e.g. "Large").',
  product_variant:
    '003_catalog (+ 004 tax_class, 006 policy flags): product variant.\n`option_signature` is NULLABLE and maintained EXCLUSIVELY by triggers.',
  product_variant_option: '003_catalog: the variant<->option-value matrix (composite PK).',
  price_set: '004_pricing_and_tax: one price set per variant.',
  price: '004_pricing_and_tax (+ 020 company, compare_at_amount): a price (amount = INTEGER minor units / cents).',
  catalog_image: '020_catalogue_company: an image of the catalogue (bytes beside the documents, one per company and hash).',
  product_image: '020_catalogue_company: the ordered images of a product, optionally tied to one variant.',
  collection: '020_catalogue_company: a manual collection of products.',
  collection_product: '020_catalogue_company: the ordered products of a collection.',
  product_site_hidden: '020_catalogue_company: a product switched off for one site of its company.',
  price_rule: '004_pricing_and_tax: price rule (attribute match).',
  price_list: '004_pricing_and_tax: price list (override / sale window).',
  credit_note:
    '004_pricing_and_tax (+ 005 order_id): storefront credit note (Storno /\nGutschrift). Append-only, no updated_at. amount = INTEGER cents.',
  credit_note_ref: '004_pricing_and_tax: credit-note reference (append-only, no updated_at).',
  order:
    '005_minimal_orders: order ("order" is a reserved word; the key stays bare).\nFull German order-level tax model; money columns are INTEGER cents.',
  order_line_item:
    '005_minimal_orders: order line item (variant snapshot + tax treatment).\nAppend-only, no updated_at. `tax_rate` is integer BASIS POINTS (1900 = 19%).',
  books_company_settings:
    '007_books: one row per company: tax status, exemption note, sender block,\ndefault payment terms.',
  document_number_counter:
    '007_books: one row per company and document type, the only source of\ndocument numbers. `next_value` is BIGINT (read as a string).',
  customer:
    '007_books: the tax fields of a recipient; name and address live in the shared\ncontacts database (`contact_id`).',
  document_template:
    '007_books (+ 012 versions): a document template: name, default flag, locale,\nthe default texts of a new draft, and its current version. Archived, never\ndeleted, once it has a version.',
  document_template_version:
    '012_books_template_v2: one saved version of a template (the template model\nversion 2 document), append-only (no updated_at).',
  sales_document:
    '007_books (+ 008 template_snapshot, 011 replaces_document_id): offer,\ninvoice and credit note. DATE columns are written and read as `YYYY-MM-DD`\ntext (select them through the Books column lists, never selectAll);\n`number_value` is BIGINT (read as a string). Frozen after issue by the\nsales_document_guard trigger.',
  sales_document_line:
    '007_books: a document line. `tax_class` / `tax_rate_override` are inputs;\n`tax_rate`, `tax_amount`, `tax_treatment` are derived.',
  sales_document_event: '007_books: the append-only audit trail (no updated_at).',
  sales_document_file:
    '008_books_files: the stored document of record (the rendered PDF of an issued\ndocument), one per document, append-only (no updated_at).',
  historical_import_item:
    "010_books_upload_import: the staging row of one uploaded past-invoice PDF.\nMutable until `imported` (then frozen by trigger, BK010). The JSONB columns\nare parsed with zod on read (src/server/books/upload/staging.ts); they hold\nthe extracted printed invoice, the user's corrected record (keyed to the\nextraction it corrects) and the named problems.",
  historical_import_extraction:
    '010_books_upload_import: one model call of the upload import (the daily ceiling counts these).',
  books_asset:
    '013_books_assets: an uploaded logo (PNG or JPEG bytes), one per company and\nSHA-256, append-only (no updated_at).',
  form_submission:
    '017_form_submissions: one accepted submission of a form on a published site.\nDeleted for real (owner, project delete, company erasure); `read_at` is the only\ncolumn that changes. No IP address is stored.',
  books_product:
    '015_books_products: an item of the company\'s product and service list. Mutable,\narchived instead of deleted; draft lines copy its values and never reference it.\n`name_key` and `search_text` are folded by the repository (src/lib/books/searchKey.ts).',
};

/** Inline notes printed above a column. */
const COLUMN_NOTES: Record<string, string> = {
  'inventory_level.available_quantity': 'GENERATED ALWAYS AS (stocked_quantity - reserved_quantity) STORED.',
  'product.tax_class': 'Added in 004_pricing_and_tax (classification string, not a rate).',
  'product_variant.option_signature': 'Trigger-maintained (003_catalog). Nullable: a bare variant has NULL.',
  'product_variant.tax_class': 'Added in 004_pricing_and_tax (per-variant override of product.tax_class).',
  'product_variant.manage_inventory': 'Added in 006_inventory_policy (default TRUE).',
  'product_variant.allow_backorder': 'Added in 006_inventory_policy (default FALSE).',
  'sales_document.intro_format': "The intro text's formatting (017; the run model of render/richText.ts); null prints the plain text.",
  'credit_note.order_id': 'Added in 005_minimal_orders (hard FK to "order").',
};

// --- introspection -----------------------------------------------------------

interface EnumType {
  name: string;
  labels: string[];
}

interface Column {
  name: string;
  typeName: string;
  typeKind: string; // pg_type.typtype: 'b' base, 'e' enum
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}

interface Table {
  key: string; // 'public.tenant_groups' or the bare name
  name: string;
  columns: Column[];
}

async function readEnums(sql: postgres.Sql, schema: string): Promise<EnumType[]> {
  const rows = await sql<{ name: string; labels: string[] }[]>`
    SELECT t.typname AS name,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = ${schema}
     GROUP BY t.oid, t.typname
     ORDER BY t.oid
  `;
  return rows.map((r) => ({ name: r.name, labels: r.labels }));
}

async function readTables(sql: postgres.Sql, schema: string, keyPrefix: string, only?: string[]): Promise<Table[]> {
  const tables = await sql<{ oid: number; name: string }[]>`
    SELECT c.oid::int AS oid, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema}
       AND c.relkind = 'r'
       AND c.relname NOT LIKE '\\_\\_%'
     ORDER BY c.oid
  `;
  const out: Table[] = [];
  for (const t of tables) {
    if (only && !only.includes(t.name)) continue;
    const columns = await sql<Column[]>`
      SELECT a.attname AS name,
             ty.typname AS "typeName",
             ty.typtype AS "typeKind",
             a.attnotnull AS "notNull",
             a.atthasdef AS "hasDefault",
             (a.attgenerated <> '' OR a.attidentity <> '') AS generated
        FROM pg_attribute a
        JOIN pg_type ty ON ty.oid = a.atttypid
       WHERE a.attrelid = ${t.oid}
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum
    `;
    out.push({ key: `${keyPrefix}${t.name}`, name: t.name, columns });
  }
  return out;
}

// --- emission ----------------------------------------------------------------

const SCALARS: Record<string, string> = {
  text: 'string',
  varchar: 'string',
  uuid: 'string',
  int2: 'number',
  int4: 'number',
  int8: 'Int8',
  bool: 'boolean',
  timestamp: 'Timestamp',
  timestamptz: 'Timestamp',
  date: 'DateString',
  // postgres.js reads BYTEA as a Node Buffer and writes a Buffer (or Uint8Array) as BYTEA.
  bytea: 'Buffer',
  // postgres.js reads TEXT[] as a string array (020_catalogue_company: product.tags).
  _text: 'string[]',
};

function pascal(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function columnType(table: Table, col: Column, enumNames: Set<string>): string {
  const id = `${table.key}.${col.name}`;
  const override = COLUMN_OVERRIDES[id];
  if (override) return override;

  let base: string;
  if (col.typeName === 'jsonb' || col.typeName === 'json') {
    const shape = JSON_COLUMNS[id];
    if (!shape) throw new Error(`commerce-codegen: JSONB column ${id} has no JSON_COLUMNS entry`);
    base = `JsonColumn<${shape}>`;
  } else if (col.typeKind === 'e') {
    if (!enumNames.has(col.typeName)) throw new Error(`commerce-codegen: enum ${col.typeName} (${id}) not found`);
    base = col.typeName;
  } else {
    const scalar = SCALARS[col.typeName];
    if (!scalar) throw new Error(`commerce-codegen: no TypeScript mapping for ${col.typeName} (${id})`);
    base = scalar;
  }

  const nullable = col.notNull ? base : `${base} | null`;
  return col.hasDefault || col.generated ? `Generated<${nullable}>` : nullable;
}

function docComment(text: string, indent = ''): string {
  const lines = text.split('\n');
  if (lines.length === 1 && text.length + indent.length + 7 <= 100) return `${indent}/** ${text} */`;
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`].join('\n');
}

function emitEnum(e: EnumType): string {
  const oneLine = `export type ${e.name} = ${e.labels.map((l) => `'${l}'`).join(' | ')};`;
  if (oneLine.length <= 80) return oneLine;
  return [`export type ${e.name} =`, ...e.labels.map((l, i) => `  | '${l}'${i === e.labels.length - 1 ? ';' : ''}`)].join('\n');
}

function emitTable(table: Table, enumNames: Set<string>): string {
  const doc = TABLE_DOCS[table.key];
  if (!doc) throw new Error(`commerce-codegen: table ${table.key} has no TABLE_DOCS entry`);
  const body = table.columns.map((col) => {
    const note = COLUMN_NOTES[`${table.key}.${col.name}`];
    const line = `  ${col.name}: ${columnType(table, col, enumNames)};`;
    return note ? `  // ${note}\n${line}` : line;
  });
  return `${docComment(doc)}\nexport interface ${pascal(table.name)}Table {\n${body.join('\n')}\n}`;
}

const HEADER = `// src/server/commerce/db-types.ts
//
// GENERATED by scripts/commerce-codegen.ts (pnpm db:codegen-commerce) from the
// live per-tenant DDL. Do not edit by hand: change the migration (or the
// generator's declarations) and regenerate. CI-style check:
//   pnpm db:codegen-commerce && git diff --exit-code src/server/commerce/db-types.ts
//
// The typed \`CommerceDB\` Database interface every commerce and Books repository
// is generic over: \`Kysely<CommerceDB>\`.
//
// PUBLIC-PREFIX DISCIPLINE. Inside a \`tenantDb(...)\` query Kysely's withSchema
// rewrites every BARE table identifier to the tenant schema (\`tg_<id>.<table>\`).
// A GLOBAL table therefore MUST be referenced with an explicit \`public.\` prefix,
// or it silently resolves against the tenant schema (and a same-named DECOY
// there would be a cross-tenant read). Forgetting the prefix is a COMPILE error,
// because global tables are registered under their \`public.<name>\` key ONLY and
// per-tenant tables under their BARE key ONLY. The two namespaces are disjoint
// (proved by __tests__/type-discipline.test-d.ts).
//
// TYPE RULES:
//   - every column with a database DEFAULT or a GENERATED expression is
//     \`Generated<>\` (optional on INSERT); trigger-maintained columns too;
//   - money columns are INTEGER cents and rates integer basis points: \`number\`;
//   - BIGINT is \`Int8\`: postgres.js reads it as a string, so convert explicitly;
//   - DATE is \`DateString\`: written as \`YYYY-MM-DD\` and read as text (the base
//     handle carries no custom parser and postgres.js would parse DATE into a
//     Date at UTC midnight, so the Books read helpers cast every DATE column to
//     text);
//   - JSONB is \`JsonColumn<T>\`: read as the parsed shape T, written only
//     through \`toJsonb(value)\` (src/server/books/snapshots.ts), a text parameter
//     cast to jsonb.
//
// Pure type module (no runtime), so it needs no \`server-only\` and adds nothing
// to the build.
`;

const SCALAR_ALIASES = `// --- scalar aliases ------------------------------------------------------------

/**
 * A column the database fills when an INSERT omits it (a DEFAULT, a GENERATED
 * expression or a trigger). Defined here rather than imported from kysely,
 * because kysely's own \`Generated<T>\` does not unwrap a nested ColumnType:
 * \`Generated<Timestamp>\` would select as the ColumnType object instead of a
 * Date. Same definition kysely-codegen emits.
 */
export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

/** A \`TIMESTAMP(3)\` / \`timestamptz\` column: selected as a Date, written as a Date or ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** A \`BIGINT\` column: postgres.js reads it as a string; written as a number, bigint or string. */
export type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;

/** A \`DATE\` column: a calendar day as \`YYYY-MM-DD\` text (select it cast to text). */
export type DateString = ColumnType<string, string, string>;

/**
 * What a \`JSONB\` column accepts on write: only the expression \`toJsonb(value)\`
 * (src/server/books/snapshots.ts) produces, a text parameter cast to jsonb. A
 * plain string would not do: postgres.js JSON-serializes a parameter the server
 * types as jsonb, so a pre-serialized string would be stored as a JSON string
 * scalar. The brand makes that mistake a compile error.
 */
export type JsonbWrite = { readonly __brand: 'JsonbWrite' };

/** A \`JSONB\` column: read as the parsed shape T, written through toJsonb. */
export type JsonColumn<T> = ColumnType<T, JsonbWrite, JsonbWrite>;
`;

function emitFile(enums: EnumType[], globals: Table[], tenants: Table[]): string {
  const enumNames = new Set(enums.map((e) => e.name));
  const parts: string[] = [];
  parts.push(HEADER);
  parts.push("import type { ColumnType } from 'kysely';");
  parts.push(
    "// The package's brand types for the two key namespaces: GlobalKey forces\n// `public.<name>` keys, TenantKey forbids a `public.` prefix on a bare key.\nimport type { GlobalKey, TenantKey } from '@marlinjai/tenant-db';\n\n// The shapes of the Books JSONB columns (zod-inferred; type-only import).\n" +
      JSON_IMPORTS +
      '\n',
  );
  parts.push(SCALAR_ALIASES);
  parts.push(EXTRA_TYPES);
  parts.push(
    '// --- enum types (string unions, in the order of pg_enum.enumsortorder) -------\n\n' +
      enums.map(emitEnum).join('\n') +
      '\n',
  );
  parts.push(
    '// =============================================================================\n// GLOBAL tables: registered under `public.<name>` keys ONLY.\n// =============================================================================\n\n' +
      globals.map((t) => emitTable(t, enumNames)).join('\n\n') +
      '\n',
  );
  parts.push(
    '// =============================================================================\n// PER-TENANT tables (commerce and Books): registered under BARE keys ONLY, in\n// the order their migrations create them.\n// =============================================================================\n\n' +
      tenants.map((t) => emitTable(t, enumNames)).join('\n\n') +
      '\n',
  );
  const keys = [
    '  // --- global tables (public.<name> keys ONLY) ---',
    ...globals.map((t) => `  '${t.key}': ${pascal(t.name)}Table;`),
    '',
    '  // --- per-tenant tables (bare keys ONLY) ---',
    ...tenants.map((t) => `  ${t.key}: ${pascal(t.name)}Table;`),
  ];
  parts.push(
    '// =============================================================================\n// The Database interface. GLOBAL keys are `public.`-qualified; tenant tables\n// are BARE. The two namespaces are disjoint by construction.\n// =============================================================================\n\nexport interface CommerceDB {\n' +
      keys.join('\n') +
      '\n}\n',
  );
  parts.push(`// --- compile-time discipline guards (the package's brand types) --------------
// These aliases partition CommerceDB's keys by namespace and prove (consumed by
// type-discipline.test-d.ts) that the two halves stay disjoint.

/** The \`public.\`-qualified global keys of CommerceDB (a {@link GlobalKey} subset). */
export type CommerceGlobalKey = Extract<keyof CommerceDB, GlobalKey>;

/** The bare per-tenant keys of CommerceDB (a {@link TenantKey} subset). */
export type CommerceTenantKey = TenantKey<Extract<keyof CommerceDB, string>>;
`);
  return parts.join('\n');
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDockerHost();
  let container: StartedTestContainer | undefined;
  let owner: postgres.Sql | undefined;
  try {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'postgres',
        POSTGRES_DB: DB_NAME,
        // trust auth: roles log in by username alone, no password literals.
        POSTGRES_HOST_AUTH_METHOD: 'trust',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const ownerUrl = `postgresql://postgres@${container.getHost()}:${container.getMappedPort(5432)}/${DB_NAME}`;
    owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });

    // The app role must exist before migrating (REVOKEs are guarded on it).
    await owner`CREATE ROLE ${owner(APP_ROLE)} LOGIN`;
    // The superuser sets the app role's search_path, as prisma/sql/commerce-roles.sql
    // does: provisioning only verifies it (appRoleBootstrap 'verify').
    await owner`ALTER ROLE ${owner(APP_ROLE)} SET search_path = ext`;
    await migratePublic(owner);
    await provisionTenant(owner, {
      tenantGroupId: TG,
      slug: 'codegen',
      appRole: APP_ROLE,
      appRoleBootstrap: 'verify',
      tenantMigrations: COMMERCE_TENANT_MIGRATIONS,
    });

    const enums = await readEnums(owner, SCHEMA);
    const globals = await readTables(owner, 'public', 'public.', ['tenant_groups']);
    const tenants = await readTables(owner, SCHEMA, '');
    if (globals.length !== 1) throw new Error('commerce-codegen: public.tenant_groups not found');

    writeFileSync(OUT_FILE, emitFile(enums, globals, tenants), 'utf8');
    console.log(`Wrote ${OUT_FILE} (${tenants.length} tenant tables, ${enums.length} enums).`);
  } finally {
    await owner?.end();
    await container?.stop();
  }
}

main().catch((err) => {
  console.error('db:codegen-commerce failed:', err);
  process.exitCode = 1;
});
