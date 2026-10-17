// src/server/commerce/provisioning/__tests__/appendOnly.test.ts
//
// Keeps APPEND_ONLY_TABLES (the list provisioning and the fleet runner re-apply
// the UPDATE / DELETE revokes for) in lockstep with the tenant migration bodies.
// A migration that adds an append-only table must REVOKE in its own body AND be
// listed here; a listed table without a REVOKE in any migration is a stale entry.
// Either drift fails this headless test.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APPEND_ONLY_TABLES } from '../provision';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/tenant');

/** Every table a tenant migration body REVOKEs UPDATE / DELETE on from commerce_app. */
function revokedTablesInMigrations(): string[] {
  const tables = new Set<string>();
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!/^\d{3}_.*\.ts$/.test(name)) continue;
    const text = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
      // Ignore comments: only executed SQL counts.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const re = /REVOKE\s+UPDATE\s*,\s*DELETE\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+FROM\s+commerce_app/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) tables.add(m[1]);
  }
  return [...tables].sort();
}

describe('APPEND_ONLY_TABLES', () => {
  it('lists exactly the tables the tenant migrations REVOKE UPDATE / DELETE on', () => {
    const revoked = revokedTablesInMigrations();
    expect(revoked.length).toBeGreaterThan(0);
    expect([...APPEND_ONLY_TABLES].sort()).toEqual(revoked);
  });
});
