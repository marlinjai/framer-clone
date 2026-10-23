// src/server/commerce/__tests__/checkGuards.test.ts
//
// Pins the vendored tenant isolation guard scanner (scripts/check-guards.mjs,
// run by `pnpm lint:guards` and CI). Each rule is fed a known-bad sample and
// must trip; the safe forms the commerce code actually uses must stay clean.
// Without this, a regex regression could turn the CI guard into a silent pass.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOTS,
  collectFiles,
  readKnownTenantTables,
  scanFiles,
  scanText,
} from '../../../../scripts/check-guards.mjs';

const knownTables = readKnownTenantTables();

function rules(text: string, opts: { isWorkersConfig?: boolean } = {}): string[] {
  return scanText({ path: 'sample.ts', text, knownTables, ...opts }).map((v) => v.rule);
}

describe('KNOWN_TENANT_TABLES (read from the per-tenant migration set)', () => {
  it('lists exactly the 19 commerce and 12 Books tenant tables', () => {
    expect(knownTables).toEqual(
      [
        // Books (007_books, 008_books_files, 010_books_upload_import, 012_books_template_v2, 013_books_assets)
        'books_asset',
        'books_company_settings',
        'customer',
        'document_number_counter',
        'document_template',
        'document_template_version',
        'historical_import_extraction',
        'historical_import_item',
        'sales_document',
        'sales_document_event',
        'sales_document_file',
        'sales_document_line',
        // Commerce (001 to 006)
        'credit_note',
        'credit_note_ref',
        'fulfillment_location_default',
        'inventory_item',
        'inventory_level',
        'order',
        'order_line_item',
        'price',
        'price_list',
        'price_rule',
        'price_set',
        'product',
        'product_option',
        'product_option_value',
        'product_variant',
        'product_variant_option',
        'reservation',
        'stock_location',
        'stock_movement',
      ].sort(),
    );
  });
});

describe('G1: withSchema is reserved to tenant-db', () => {
  it('trips on a direct call, a call split across lines, computed access and an alias', () => {
    expect(rules('db.withSchema("tg_x").selectFrom("product")')).toContain('G1');
    expect(rules('db.withSchema\n  ("tg_x")')).toContain('G1');
    expect(rules('db["withSchema"]("tg_x")')).toContain('G1');
    expect(rules('const m = db.withSchema;')).toContain('G1');
  });

  it('ignores a comment that names it', () => {
    expect(rules('// never call db.withSchema( here\nconst x = 1;')).toEqual([]);
  });
});

describe('G2: no runtime search_path SET in commerce', () => {
  it('trips on SET search_path and on SET LOCAL search_path', () => {
    expect(rules("await tx.$executeRawUnsafe('SET search_path TO tg_x')")).toEqual(['G2']);
    expect(rules('await tx.$executeRawUnsafe(`SET LOCAL search_path TO "commerce"`)')).toEqual(['G2']);
    expect(rules('await sql`SET SESSION search_path = public`.execute(db)')).toEqual(['G2']);
  });

  it('allows the role default and a function-level FROM CURRENT clause', () => {
    expect(rules('await owner`ALTER ROLE ${owner(role)} SET search_path = ext`')).toEqual([]);
    expect(rules('const ddl = `CREATE FUNCTION f() RETURNS trigger SET search_path FROM CURRENT AS $$ $$`;')).toEqual([]);
  });
});

describe('G3: no bare commerce table inside a sql`` template', () => {
  it('trips on a bare table in a plain and in a typed template', () => {
    expect(rules('await sql`SELECT * FROM inventory_level WHERE id = ${id}`.execute(db)')).toEqual(['G3']);
    expect(rules('await sql<{ n: number }>`UPDATE stock_movement SET x = 1`.execute(db)')).toEqual(['G3']);
    expect(rules('await sql<Array<Row>>`DELETE FROM reservation`.execute(db)')).toEqual(['G3']);
  });

  it('trips on a quoted bare reserved-word table (FROM "order")', () => {
    expect(rules('await sql`SELECT id FROM "order" WHERE request_id = ${r}`.execute(db)')).toEqual(['G3']);
  });

  it('trips on a bare table across a multi-line template', () => {
    expect(rules('await sql`\n  SELECT id\n    FROM product\n`.execute(db)')).toEqual(['G3']);
  });

  it('accepts a tenantSchemaRef-qualified table, quoted or not', () => {
    expect(rules('await sql`UPDATE ${schema}.inventory_level SET reserved_quantity = 1`.execute(trx)')).toEqual([]);
    expect(rules('await sql`SELECT id FROM ${schema}."order"`.execute(trx)')).toEqual([]);
  });

  it('does not mistake ORDER BY, column names or interpolated identifiers for tables', () => {
    expect(
      rules(
        'await sql`SELECT inventory_item_id FROM ${schema}.inventory_level ORDER BY inventory_item_id ASC FOR UPDATE`.execute(trx)',
      ),
    ).toEqual([]);
    expect(rules('await sql`SELECT unit_price, order_number FROM ${schema}.order_line_item`.execute(trx)')).toEqual([]);
    expect(rules('await sql`SELECT ${product.id} AS id`.execute(trx)')).toEqual([]);
  });

  it('honours a disable comment on the line above (hazard fixtures only)', () => {
    expect(
      rules('// tenant-db-guard-disable-next-line G3\nawait sql`SELECT * FROM inventory_level`.execute(db)'),
    ).toEqual([]);
  });
});

describe('G4 and G5', () => {
  it('G4 trips on GRANT ... ON ALL SCHEMAS', () => {
    expect(rules('await owner`GRANT USAGE ON ALL SCHEMAS TO app`')).toEqual(['G4']);
  });

  it('G5 trips when a Workers config omits prepare:false, and passes when set', () => {
    expect(rules('postgres(url, { max: 1 })', { isWorkersConfig: true })).toEqual(['G5']);
    expect(rules('postgres(url, { prepare: false })', { isWorkersConfig: true })).toEqual([]);
  });
});

describe('bypasses the scanner closes (reviewer findings)', () => {
  it('G3 follows the Kysely sql tag under an import alias', () => {
    expect(
      rules("import { sql as q } from 'kysely';\nawait q`SELECT * FROM product`.execute(db);"),
    ).toEqual(['G3']);
    expect(
      rules("import { type Kysely, sql as raw } from 'kysely';\nawait raw<{ n: number }>`DELETE FROM reservation`.execute(db);"),
    ).toEqual(['G3']);
  });

  it('G3-raw flags SQL it cannot read: sql.raw(, sql.table( (any alias) and .unsafe(', () => {
    expect(rules('await sql.raw(`SELECT * FROM product`).execute(db)')).toEqual(['G3-raw']);
    expect(rules("import { sql as q } from 'kysely';\nq.table('product')")).toEqual(['G3-raw']);
    expect(rules('await owner.unsafe(`DELETE FROM stock_movement`)')).toEqual(['G3-raw']);
    expect(rules('await owner.unsafe<{ n: number }[]>(`SELECT 1`)')).toEqual(['G3-raw']);
    expect(rules('await fx.owner\n  .unsafe(text)')).toEqual(['G3-raw']);
  });

  it("G2 flags set_config('search_path', ...)", () => {
    expect(rules("await sql`SELECT set_config('search_path', ${s}, true)`.execute(db)")).toEqual(['G2']);
    expect(rules('await tx`SELECT set_config("search_path", ${s}, false)`')).toEqual(['G2']);
  });

  it('G3 covers postgres.js tags: tx, owner, owner!, fx.owner, postgres() results, typed Sql, .begin params', () => {
    expect(rules('await tx`UPDATE stock_movement SET quantity = 1`')).toEqual(['G3']);
    expect(rules('await owner!`SELECT * FROM inventory_level`')).toEqual(['G3']);
    expect(rules('await fx.owner`DELETE FROM reservation`')).toEqual(['G3']);
    expect(rules('const pg = postgres(url, { max: 1 });\nawait pg`DELETE FROM reservation`;')).toEqual(['G3']);
    expect(rules('async function f(conn: postgres.Sql) { await conn`SELECT * FROM price`; }')).toEqual(['G3']);
    expect(rules('let probe: Sql | undefined;\nawait probe!`SELECT * FROM product`;')).toEqual(['G3']);
    expect(rules('await db.begin(async (t) => { await t`SELECT id FROM "order"`; });')).toEqual(['G3']);
  });

  it('G3 accepts only an INTERPOLATED schema qualifier in front of a tenant table', () => {
    expect(rules('await sql`SELECT * FROM commerce.product`.execute(db)')).toEqual(['G3']);
    expect(rules('await owner`SELECT * FROM public.stock_movement`')).toEqual(['G3']);
    expect(rules('await owner`SELECT * FROM "commerce"."order"`')).toEqual(['G3']);
    expect(rules('await tx`SELECT * FROM commerce.${tx(\'order\')}`')).toEqual(['G3']);
    expect(rules('await sql`SELECT * FROM ${schema}.product`.execute(db)')).toEqual([]);
    expect(rules('await tx`SELECT * FROM ${tx(schema)}.${tx(\'order\')}`')).toEqual([]);
  });

  it('G3 treats an identifier helper with a literal tenant table as that table', () => {
    expect(rules('await tx`DELETE FROM ${tx(\'stock_movement\')}`')).toEqual(['G3']);
    expect(rules('await sql`SELECT * FROM ${sql.id("product")}`.execute(db)')).toEqual(['G3']);
    expect(rules('await tx`DELETE FROM ${tx(name)}`')).toEqual([]);
  });

  it('a single-quoted string value is data, not a table', () => {
    expect(rules("await owner`SELECT 1 FROM information_schema.tables WHERE table_name IN ('order', 'product')`")).toEqual([]);
  });

  it('the path-scoped allowances are narrow: only the named rule, only the named file', () => {
    const backfill = 'src/server/commerce/provisioning/backfill-demo.ts';
    const raw = 'await sql.unsafe(`INSERT INTO x SELECT * FROM y`)';
    expect(scanText({ path: backfill, text: raw, knownTables })).toEqual([]);
    expect(
      scanText({ path: backfill, text: 'await owner`SELECT * FROM product`', knownTables }).map((v) => v.rule),
    ).toEqual(['G3']);
    expect(scanText({ path: 'src/server/commerce/other.ts', text: raw, knownTables }).map((v) => v.rule)).toEqual([
      'G3-raw',
    ]);
    const cmsSet = 'await tx.$executeRawUnsafe(`SET LOCAL search_path TO "cms"`)';
    expect(scanText({ path: 'src/server/cms/withTenant.ts', text: cmsSet, knownTables })).toEqual([]);
    expect(scanText({ path: 'src/server/cms/other.ts', text: cmsSet, knownTables }).map((v) => v.rule)).toEqual([
      'G2',
    ]);
  });
});

describe('the repository scan (what `pnpm lint:guards` runs)', () => {
  it('walks all of src and scripts, skips the tenant migrations, and finds no violation', () => {
    const files = collectFiles(DEFAULT_ROOTS);
    expect(DEFAULT_ROOTS).toEqual(['src', 'scripts']);
    expect(files.some((f) => f.includes('/migrations/tenant/'))).toBe(false);
    for (const expected of [
      'src/server/commerce/inventory/reserve.ts',
      'src/app/api/projects/[projectId]/commerce/products/route.ts',
      'src/app/(site)/[...slug]/page.tsx',
      'src/lib/renderer/server/seedDemoSite.ts',
      'scripts/db-backfill-demo.ts',
    ]) {
      expect(files.some((f) => f.endsWith(expected)), expected).toBe(true);
    }
    expect(scanFiles(files, { knownTables })).toEqual([]);
  });
});
