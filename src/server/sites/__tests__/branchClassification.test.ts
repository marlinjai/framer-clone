// src/server/sites/__tests__/branchClassification.test.ts
//
// Every place that reads or writes the site tables must have decided what it does with a site branch, a hidden
// `sites` row (docs/plans/2026-11-10-site-branches.md, section 7, "Every place keyed by a site"). This test walks
// src (as hostRoutes.test.ts walks the routes) and fails on a file that touches the site tables and is not in the
// table below, and on an entry whose file no longer touches them, so a new query has to be classified before it
// ships.
//
// What counts as touching: a Prisma delegate call on a model keyed by a site (`.site.findMany(`, `tx.sitePage.update(`,
// `.siteOperationAudit.create(`, ...)
// or raw SQL naming a site table (`FROM public.sites`, `public.site_pages p`, ...).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Kind =
  /** Reads or writes branch rows on purpose, or by id where a branch id behaves as its own site. */
  | 'sees-branches'
  /** Must never see a branch, and makes sure of it (a filter, a refusal, or rows a branch can never have). */
  | 'mains-only';

/**
 * `uses` is how many matches the file holds: a new query in an already listed file changes it, so the test fails
 * until whoever added the query has decided what it does with a branch and updated the count (and the why).
 */
const CLASSIFIED: Record<string, { uses: number; kind: Kind; why: string }> = {
  'src/server/sites/repository.ts': {
    uses: 65, kind: 'sees-branches',
    why: 'listSites filters to mains; save works on a branch id, its image check against the images of main; publish, rollback, unpublish, domains, delete and erase refuse a branch; erase of a main covers its branches, moves an up-to-date fork point with main, and removes a kept pre-merge copy it could not clean fully and one past its 30 days, and lists the records with one narrow read; a rename of a branch drops its approval (the name is part of what a merge writes)',
  },
  'src/server/sites/branches/repository.ts': { uses: 35, kind: 'sees-branches', why: 'the branch repository itself; listing a site\'s branches also removes a kept pre-merge copy whose 30 days are over (only when its read found one) and always holds the latest merges and the closed branches they name; closing a branch deletes its public preview link and prunes the site\'s oldest closed records beyond 50, under main\'s lock; the fork point\'s name is read from its stored column' },
  'src/server/sites/branches/previewLinks.ts': {
    uses: 15, kind: 'sees-branches',
    why: 'the public preview link of a branch: made, read and revoked through the caller\'s workspace and the branch\'s main; resolved for a visitor by the token\'s hash only, for an open branch of a company with the switch on, and rendered under main\'s id with analytics off; the branch\'s row is read for its version before its content is reused, and the favicon reads its settings only',
  },
  'src/server/sites/branches/merge.ts': { uses: 26, kind: 'sees-branches', why: 'the review, update and merge of a branch: resolves the branch and its main through the caller\'s workspace, locks main then the branch; undoing a merge locks main, writes it back and makes the new branch row, all scoped the same way, without counting the open branches (the undo is outside their limit); storing an answer returns when the record was written, for the review\'s state key' },
  'src/server/sites/branches/editorState.ts': { uses: 5, kind: 'sees-branches', why: 'the editor page\'s main, branch or closed branch (and the branch an undone merge went into), through the caller\'s workspace; nothing while the switch is off' },
  'src/server/sites/branches/closed.ts': { uses: 1, kind: 'sees-branches', why: 'answers a closed branch id with 410' },
  'src/server/sites/siteImages.ts': {
    uses: 19, kind: 'sees-branches',
    why: 'a branch id resolves to its main site, which owns the images; the delete check scans every branch copy',
  },
  'src/server/models/prismaModels.ts': {
    uses: 1, kind: 'mains-only',
    why: 'the stored 3D models belong to a main site, as images do: one read of the site row stamps the isolation columns and REFUSES a branch id (callers resolve a branch to its main first); every other query is on site_models, keyed by the site',
  },
  'src/server/sites/publicResolver.ts': {
    uses: 3, kind: 'mains-only',
    why: 'resolves only `published` sites by a domain row; a branch is never published (CHECK) and holds no domain (trigger)',
  },
  'src/server/sites/cachedResolver.ts': { uses: 2, kind: 'mains-only', why: 'reads through the public resolver' },
  'src/server/sites/primaryHost.ts': { uses: 1, kind: 'mains-only', why: 'domain rows only; a branch has none (trigger)' },
  'src/server/sites/siteCompany.ts': {
    uses: 2, kind: 'sees-branches',
    why: 'stamps the company on open; a branch carries its main company from creation, the same by the foreign key',
  },
  'src/server/domains/guard.ts': {
    uses: 1, kind: 'sees-branches',
    why: 'resolves a project id to its workspace; the domain service and the trigger refuse a branch, images resolve to main',
  },
  'src/server/domains/service.ts': { uses: 16, kind: 'mains-only', why: 'addDomain refuses a branch (409) before the trigger would' },
  'src/server/erasure/public.ts': {
    uses: 12, kind: 'sees-branches',
    why: 'deletes every site of the company, branches included (same company and workspace); names the branches that cascade with a main of the batch, so each one is forgotten in memory too',
  },
  'src/server/commerce/editorTenant.ts': {
    uses: 1, kind: 'sees-branches',
    why: 'resolves the company of an editor request by site id; a branch has its main company',
  },
  'src/server/commerce/mail/runtime.ts': { uses: 1, kind: 'mains-only', why: 'sites of orders, placed only on published sites' },
  'src/server/commerce/payment/expirySweep.ts': { uses: 1, kind: 'mains-only', why: 'sites of orders, placed only on published sites' },
  'src/server/forms/editorScope.ts': {
    uses: 1, kind: 'sees-branches',
    why: 'resolves the scope of an editor forms request by site id; a branch collects no submissions (it has no host)',
  },
  'src/server/forms/repository.ts': { uses: 1, kind: 'mains-only', why: 'sites of submissions, posted only to published sites' },
  'src/lib/auth-machine.ts': {
    uses: 1, kind: 'sees-branches',
    why: 'checks that every site row of a workspace carries its tenant group and company; a branch copies both from its main site',
  },
  'src/lib/renderer/server/seedDemoSite.ts': { uses: 5, kind: 'mains-only', why: 'seeds the demo main site; creates no branch' },
  'src/server/siteOps/audit.ts': {
    uses: 2, kind: 'sees-branches',
    why: 'audit rows of a write are keyed by the site id written, a branch id included; the company erasure deletes them by workspace, which a branch shares',
  },
  'src/server/sites/cspReportStore.ts': {
    uses: 7, kind: 'mains-only',
    why: 'counts browser reports from published pages; a branch is never published and has no host, so it sends none',
  },
};

const ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(ROOT, 'src');

const TOUCHES = new RegExp(
  [
    String.raw`\.(?:site|sitePage|siteDomain|siteRevision|siteImage|siteExperiment|siteBranch|siteBranchPreview|siteErasure|siteOperationAudit|cspReportCount)\.(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|updateMany|update|deleteMany|delete|create|createMany|upsert|groupBy|aggregate)\(`,
    String.raw`\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?"?(?:sites|site_pages|site_domains|site_revisions|site_images|site_branches|site_branch_previews|site_experiments|site_erasures|site_operation_audits|csp_report_counts)"?\b`,
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

const ALL_USES = new RegExp(TOUCHES.source, 'g');

const uses = new Map(
  walk(SRC)
    .map((file) => [path.relative(ROOT, file).split(path.sep).join('/'), readFileSync(file, 'utf8').match(ALL_USES)?.length ?? 0] as const)
    .filter(([, count]) => count > 0),
);
const touching = [...uses.keys()].sort();

describe('every use of the site tables is classified for site branches', () => {
  it('finds the uses at all (the detector works)', () => {
    expect(touching).toContain('src/server/sites/repository.ts');
    expect(touching).toContain('src/server/sites/siteImages.ts');
  });

  it.each(touching)('%s is classified', (file) => {
    expect(CLASSIFIED[file], `${file} touches the site tables: add it to CLASSIFIED with what it does with a branch`).toBeDefined();
    expect(
      uses.get(file),
      `${file} has a new or removed use of the site tables: decide what it does with a site branch, then update uses and why`,
    ).toBe(CLASSIFIED[file].uses);
  });

  it('has no stale entry', () => {
    const stale = Object.keys(CLASSIFIED).filter((file) => !touching.includes(file));
    expect(stale).toEqual([]);
  });
});
