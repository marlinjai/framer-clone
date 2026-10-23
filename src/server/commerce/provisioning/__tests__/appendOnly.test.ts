// src/server/commerce/provisioning/__tests__/appendOnly.test.ts
//
// Keeps APPEND_ONLY_TABLES, NO_DELETE_TABLES and NO_UPDATE_TABLES (the lists
// provisioning and the fleet runner re-apply the revokes for, after their
// grant-all) in lockstep with the tenant migration bodies. The migrations are
// read in order and every REVOKE and GRANT of a write right to commerce_app is
// applied to a per-table state, so a later migration that changes a table's
// rights (014 gave back DELETE on books_asset) moves it to the list matching
// its final rights. A migration that adds an append-only table must REVOKE in
// its own body AND be listed; a listed table whose final rights differ is a
// stale entry. Either drift fails this headless test.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APPEND_ONLY_TABLES, NO_DELETE_TABLES, NO_UPDATE_TABLES } from '../provision';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/tenant');

type Right = 'UPDATE' | 'DELETE' | 'TRUNCATE';

/** Per table, the write rights the migrations, applied in order, leave revoked from commerce_app. */
function revokedRights(): Map<string, Set<Right>> {
  const state = new Map<string, Set<Right>>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.*\.ts$/.test(name))
    .sort();
  const statement = /(REVOKE|GRANT)\s+([A-Z ,]+?)\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+(?:FROM|TO)\s+commerce_app/g;
  for (const name of files) {
    const text = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
      // Ignore comments: only executed SQL counts.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    statement.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = statement.exec(text)) !== null) {
      const [, verb, rightList, table] = m;
      const rights = rightList
        .split(',')
        .map((r) => r.trim())
        .filter((r): r is Right => r === 'UPDATE' || r === 'DELETE' || r === 'TRUNCATE');
      if (rights.length === 0) continue;
      const revoked = state.get(table) ?? new Set<Right>();
      for (const r of rights) {
        if (verb === 'REVOKE') revoked.add(r);
        else revoked.delete(r);
      }
      state.set(table, revoked);
    }
  }
  return state;
}

function tablesWhere(test: (revoked: Set<Right>) => boolean): string[] {
  return [...revokedRights()].filter(([, revoked]) => test(revoked)).map(([table]) => table).sort();
}

describe('APPEND_ONLY_TABLES', () => {
  it('lists exactly the tables the tenant migrations leave without UPDATE and DELETE', () => {
    const revoked = tablesWhere((r) => r.has('UPDATE') && r.has('DELETE'));
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked).not.toContain('books_asset');
    expect([...APPEND_ONLY_TABLES].sort()).toEqual(revoked);
  });

  it('NO_DELETE_TABLES lists exactly the tables the tenant migrations leave without DELETE only', () => {
    const revoked = tablesWhere((r) => r.has('DELETE') && !r.has('UPDATE'));
    expect(revoked).toEqual(['document_number_counter', 'historical_import_extraction', 'historical_import_item']);
    expect([...NO_DELETE_TABLES].sort()).toEqual(revoked);
  });

  it('NO_UPDATE_TABLES lists exactly the tables the tenant migrations leave without UPDATE only (014: books_asset)', () => {
    const revoked = tablesWhere((r) => r.has('UPDATE') && !r.has('DELETE'));
    expect(revoked).toEqual(['books_asset']);
    expect([...NO_UPDATE_TABLES].sort()).toEqual(revoked);
  });
});
