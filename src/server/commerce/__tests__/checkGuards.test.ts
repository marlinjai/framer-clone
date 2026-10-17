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
  it('lists exactly the 19 commerce tenant tables', () => {
    expect(knownTables).toEqual(
      [
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
    expect(rules('await owner.unsafe(`ALTER ROLE "app" SET search_path = ext`)')).toEqual([]);
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
    expect(rules('await owner.unsafe(`GRANT USAGE ON ALL SCHEMAS TO app`)')).toEqual(['G4']);
  });

  it('G5 trips when a Workers config omits prepare:false, and passes when set', () => {
    expect(rules('postgres(url, { max: 1 })', { isWorkersConfig: true })).toEqual(['G5']);
    expect(rules('postgres(url, { prepare: false })', { isWorkersConfig: true })).toEqual([]);
  });
});

describe('the repository scan (what `pnpm lint:guards` runs)', () => {
  it('walks the default roots, skips the tenant migrations, and finds no violation', () => {
    const files = collectFiles(DEFAULT_ROOTS);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes('/migrations/tenant/'))).toBe(false);
    expect(files.some((f) => f.endsWith('src/server/commerce/inventory/reserve.ts'))).toBe(true);
    expect(scanFiles(files, { knownTables })).toEqual([]);
  });
});
