// src/server/sites/__tests__/branchClassification.test.ts
//
// Every place that reads or writes the site tables must have decided what it does with a site branch, a hidden
// `sites` row (docs/plans/2026-11-10-site-branches.md, section 7, "Every place keyed by a site"). This test walks
// src (as hostRoutes.test.ts walks the routes) and fails on a file that touches the site tables and is not in the
// table below, and on an entry whose file no longer touches them, so a new query has to be classified before it
// ships.
//
// What counts as touching: a Prisma delegate call on a site model (`.site.findMany(`, `tx.sitePage.update(`, ...)
// or raw SQL naming a site table (`FROM public.sites`, `public.site_pages p`, ...).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Kind =
  /** Reads or writes branch rows on purpose, or by id where a branch id behaves as its own site. */
  | 'sees-branches'
  /** Must never see a branch, and makes sure of it (a filter, a refusal, or rows a branch can never have). */
  | 'mains-only';

const CLASSIFIED: Record<string, { kind: Kind; why: string }> = {
  'src/server/sites/repository.ts': {
    kind: 'sees-branches',
    why: 'listSites filters to mains; save works on a branch id; publish, rollback, unpublish, domains, delete and erase refuse a branch; erase of a main covers its branches',
  },
  'src/server/sites/branches/repository.ts': { kind: 'sees-branches', why: 'the branch repository itself' },
  'src/server/sites/branches/closed.ts': { kind: 'sees-branches', why: 'answers a closed branch id with 410' },
  'src/server/sites/siteImages.ts': {
    kind: 'sees-branches',
    why: 'a branch id resolves to its main site, which owns the images; the delete check scans every branch copy',
  },
  'src/server/sites/publicResolver.ts': {
    kind: 'mains-only',
    why: 'resolves only `published` sites by a domain row; a branch is never published (CHECK) and holds no domain (trigger)',
  },
  'src/server/sites/cachedResolver.ts': { kind: 'mains-only', why: 'reads through the public resolver' },
  'src/server/sites/primaryHost.ts': { kind: 'mains-only', why: 'domain rows only; a branch has none (trigger)' },
  'src/server/sites/siteCompany.ts': {
    kind: 'sees-branches',
    why: 'stamps the company on open; a branch carries its main company from creation, the same by the foreign key',
  },
  'src/server/domains/guard.ts': {
    kind: 'sees-branches',
    why: 'resolves a project id to its workspace; the domain service and the trigger refuse a branch, images resolve to main',
  },
  'src/server/domains/service.ts': { kind: 'mains-only', why: 'addDomain refuses a branch (409) before the trigger would' },
  'src/server/erasure/public.ts': {
    kind: 'sees-branches',
    why: 'deletes every site of the company, branches included (same company and workspace), and forgets each one in memory',
  },
  'src/server/commerce/editorTenant.ts': {
    kind: 'sees-branches',
    why: 'resolves the company of an editor request by site id; a branch has its main company',
  },
  'src/server/commerce/mail/runtime.ts': { kind: 'mains-only', why: 'sites of orders, placed only on published sites' },
  'src/server/commerce/payment/expirySweep.ts': { kind: 'mains-only', why: 'sites of orders, placed only on published sites' },
  'src/server/forms/editorScope.ts': {
    kind: 'sees-branches',
    why: 'resolves the scope of an editor forms request by site id; a branch collects no submissions (it has no host)',
  },
  'src/server/forms/repository.ts': { kind: 'mains-only', why: 'sites of submissions, posted only to published sites' },
  'src/lib/auth-machine.ts': {
    kind: 'sees-branches',
    why: 'checks that every site row of a workspace carries its tenant group and company; a branch copies both from its main site',
  },
  'src/lib/renderer/server/seedDemoSite.ts': { kind: 'mains-only', why: 'seeds the demo main site; creates no branch' },
};

const ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(ROOT, 'src');

const TOUCHES = new RegExp(
  [
    String.raw`\.(?:site|sitePage|siteDomain|siteRevision|siteImage|siteExperiment|siteBranch)\.(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|updateMany|update|deleteMany|delete|create|createMany|upsert|groupBy|aggregate)\(`,
    String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?"?(?:sites|site_pages|site_domains|site_revisions|site_images|site_branches|site_experiments)"?\b`,
  ].join('|'),
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec|itest)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const touching = walk(SRC)
  .filter((file) => TOUCHES.test(readFileSync(file, 'utf8')))
  .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
  .sort();

describe('every use of the site tables is classified for site branches', () => {
  it('finds the uses at all (the detector works)', () => {
    expect(touching).toContain('src/server/sites/repository.ts');
    expect(touching).toContain('src/server/sites/siteImages.ts');
  });

  it.each(touching)('%s is classified', (file) => {
    expect(CLASSIFIED[file], `${file} touches the site tables: add it to CLASSIFIED with what it does with a branch`).toBeDefined();
  });

  it('has no stale entry', () => {
    const stale = Object.keys(CLASSIFIED).filter((file) => !touching.includes(file));
    expect(stale).toEqual([]);
  });
});
