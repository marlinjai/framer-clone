// @vitest-environment node
//
// The integration files (src/**/*.itest.ts, test/integration/**) run in
// parallel against ONE shared Postgres (vitest.integration.setup.ts), and many
// clean up with "delete every site of my tenant group". Two files that name the
// same tenant group therefore delete each other's rows mid-test: mcp.itest.ts and
// deleteSite.itest.ts did exactly that (an MCP chain lost the site it had just
// created), and auth-machine.itest.ts shared a group with the domain service's
// test. This guard keeps every hard-coded tenant group id to one file.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A constant whose name says it is a tenant group (TG, GROUP, TENANT_GROUP, OTHER_TG, ...) set to a literal id. */
const GROUP_CONST = new RegExp(`const\\s+(\\w*(?:TG|GROUP)\\w*)\\s*=\\s*['"](${UUID})['"]`, 'g');

function integrationFiles(): string[] {
  const files: string[] = [];
  for (const dir of ['src', 'test/integration']) {
    for (const entry of readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
      const rel = path.join(dir, entry);
      if (rel.endsWith('.itest.ts') || (dir === 'test/integration' && /\.(test|spec)\.ts$/.test(rel))) files.push(rel);
    }
  }
  return files;
}

describe('integration test tenant groups', () => {
  it('finds the integration files it guards', () => {
    expect(integrationFiles()).toEqual(expect.arrayContaining(['src/server/mcp/__tests__/mcp.itest.ts', 'src/server/sites/__tests__/deleteSite.itest.ts']));
  });

  it('never names one tenant group id in two integration files', () => {
    const owners = new Map<string, Set<string>>();
    for (const file of integrationFiles()) {
      for (const match of readFileSync(path.join(ROOT, file), 'utf8').matchAll(GROUP_CONST)) {
        const id = match[2].toLowerCase();
        owners.set(id, (owners.get(id) ?? new Set()).add(file));
      }
    }
    const shared = [...owners].filter(([, files]) => files.size > 1).map(([id, files]) => `${id}: ${[...files].sort().join(', ')}`);
    expect(shared).toEqual([]);
  });
});
