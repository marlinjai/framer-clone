// src/server/sites/__tests__/eraseCustomCode.itest.ts
//
// An erase of personal data reaching the code of custom code blocks, against a REAL Postgres (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, D9 and slice C5's D115). A blob row is never changed, so an erase
// inside code writes the rewritten code under a new hash, deletes the old row, and points every copy that named the
// old hash (working copy, kept revisions, branch copies) at the new one, in the same transaction.
//
// The four paths of the stateful flow standard:
//   forward      the value in a block's code is found and erased; every copy follows the new hash; the live site
//                serves the rewritten code; the audit names both hashes and never the value;
//   backtrack    a match in code that is not ticked leaves the code and every hash as they were; an erase the code
//                cannot take (empty code) is refused and changes nothing;
//   resume       a refused erase is simply repeated with a replacement and succeeds;
//   re-entry     a second erase finds nothing; taken-down code stays taken down under its new hash; blocks whose
//                rewritten code meets other code share one row.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites';
import { EraseCodeRefusedError } from '@/server/sites/erase';
import { customCodeHash, parseDeclaration, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { loadLiveCustomCode } from '@/server/customCode/liveBlocks';
import { latestVersionRepository } from './latestVersionRepository';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000c5e01';
const VALUE = 'Max Mustermann';
const QUERY = { value: VALUE, caseSensitive: false };
const OWNER = 'user-owner';
const ENV = { CUSTOM_CODE_DISABLED: '0', SANDBOX_ORIGIN: 'https://run.example.test' };

const parsed = parseDeclaration({ reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true });
if (!parsed.ok) throw new Error('the test declaration must parse');
const DECLARATION: CustomCodeDeclaration = parsed.declaration;

let prisma: PrismaClient;
let scope: TenantScope;
let siteId: string;
const repo = latestVersionRepository();

function block(id: string, sha256: string, title = id) {
  return { id, type: 'div', componentType: 'host', props: { customCode: { sha256, title } }, children: [] };
}

/** A site whose home page holds one block per hash. */
function project(hashes: string[], text = 'Hello') {
  return {
    id: siteId,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home' },
        appComponentTree: {
          id: 'root-home',
          type: 'div',
          componentType: 'host',
          props: {},
          children: [
            { id: 'text', type: 'p', componentType: 'host', props: { children: text }, children: [] },
            ...hashes.map((sha256, index) => block(`block-${index}`, sha256)),
          ],
        },
        canvasNodes: {},
      },
    },
  } as never;
}

/** Stores a blob of the site under the hash its code really gives, and returns that hash. */
async function blob(code: string, options: { title?: string; blockedAt?: Date } = {}): Promise<string> {
  const sha256 = await customCodeHash(code, DECLARATION);
  await prisma.customCodeBlob.create({
    data: {
      siteId,
      sha256,
      document: code,
      declaration: DECLARATION as never,
      title: options.title ?? 'Team',
      createdBy: OWNER,
      blockedAt: options.blockedAt ?? null,
    },
  });
  return sha256;
}

const rows = async () =>
  prisma.customCodeBlob.findMany({ where: { siteId }, select: { sha256: true, document: true, title: true, blockedAt: true }, orderBy: { sha256: 'asc' } });

/** Every hash the working copy and the kept revisions name, as `place:hash` strings. */
async function namedEverywhere(): Promise<string[]> {
  const pages = await prisma.sitePage.findMany({ where: { siteId }, select: { snapshot: true } });
  const revisions = await prisma.siteRevision.findMany({ where: { siteId }, select: { number: true, document: true }, orderBy: { number: 'asc' } });
  const hashes = (value: unknown) => [...JSON.stringify(value).matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((m) => m[1]);
  return [
    ...pages.flatMap((page) => hashes(page.snapshot).map((h) => `working:${h}`)),
    ...revisions.flatMap((revision) => hashes(revision.document).map((h) => `revision ${revision.number}:${h}`)),
  ];
}

async function erase(over: { replacement?: string; chosen?: (preview: Awaited<ReturnType<typeof repo.searchPersonalData>>) => string[] } = {}) {
  const preview = await repo.searchPersonalData(scope, siteId, QUERY);
  const chosen = over.chosen ? over.chosen(preview) : preview.matches.filter((m) => m.blocked === null).map((m) => m.id);
  return repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: over.replacement ?? '[entfernt]', token: preview.token, chosen, erasedBy: OWNER });
}

beforeAll(() => {
  prisma = getPrismaClient();
});

beforeEach(async () => {
  siteId = randomUUID();
  scope = { workspaceId: `ws_erase_cc_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  await repo.saveProject(scope, project([]));
  await prisma.site.updateMany({ where: { id: siteId }, data: { customCodeEnabled: true } });
});

afterAll(async () => {
  await prisma.customCodeAudit.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.siteErasure.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('forward: the value in code is erased, and every copy follows the new hash', () => {
  it('rewrites the code under a new hash, points the working copy and every kept revision at it, and serves it', async () => {
    const old = await blob(`const owner = "${VALUE}";\nrender(owner);`, { title: `Team of ${VALUE}` });
    await repo.publishProject(scope, project([old]), { publishedBy: OWNER });
    await repo.publishProject(scope, project([old], 'Second'), { publishedBy: OWNER });
    await repo.saveProject(scope, project([old], 'Draft'), { mustExist: true });

    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    const inCode = preview.locations.find((l) => l.location.kind === 'custom-code');
    expect(inCode).toMatchObject({ location: { kind: 'custom-code', sha256: old }, matches: 2, erasable: 2 });

    const result = await erase();
    const fresh = await customCodeHash('const owner = "[entfernt]";\nrender(owner);', DECLARATION);
    expect(result).toMatchObject({ remaining: 0, rewrittenCode: ['Team of [entfernt]'] });

    // One row, the rewritten one; the old row is gone.
    expect(await rows()).toEqual([{ sha256: fresh, document: 'const owner = "[entfernt]";\nrender(owner);', title: 'Team of [entfernt]', blockedAt: null }]);
    // Every copy names the new hash, none the old one.
    const named = await namedEverywhere();
    expect(named).toEqual(['working:' + fresh, 'revision 1:' + fresh, 'revision 2:' + fresh]);

    // The live site serves the rewritten code.
    const live = await loadLiveCustomCode({ siteId, preview: false, hashes: [fresh, old] }, ENV);
    expect(live?.blobs.has(fresh)).toBe(true);
    expect(live?.blobs.has(old)).toBe(false);

    // The audit names both hashes and never the value; the proof search finds nothing.
    const audit = await prisma.customCodeAudit.findMany({ where: { siteId }, select: { action: true, sha256: true, detail: true } });
    expect(audit).toEqual([{ action: 'blob-erase', sha256: fresh, detail: { replaces: old } }]);
    expect((await repo.searchPersonalData(scope, siteId, QUERY)).total).toBe(0);
    expect(JSON.stringify(await prisma.customCodeBlob.findMany({ where: { siteId } }))).not.toContain(VALUE);
  });

  it('rewrites only the title under the same hash when the code does not hold the value', async () => {
    const sha256 = await blob('render("hello");', { title: `Team of ${VALUE}` });
    await repo.saveProject(scope, project([sha256]), { mustExist: true });

    const result = await erase();
    expect(result.rewrittenCode).toEqual(['Team of [entfernt]']);
    expect(await rows()).toEqual([{ sha256, document: 'render("hello");', title: 'Team of [entfernt]', blockedAt: null }]);
    expect(await namedEverywhere()).toEqual([`working:${sha256}`]);
  });

  it('rewrites a proposal in place: never served, so no hash to follow', async () => {
    const proposal = await prisma.customCodeProposal.create({
      data: { siteId, workspaceId: scope.workspaceId, tenantGroupId: TENANT_GROUP, source: 'agent', document: `say("${VALUE}")`, declaration: DECLARATION as never, title: 'Hi', createdBy: OWNER },
    });
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    expect(preview.locations.map((l) => l.location)).toContainEqual({ kind: 'custom-code-proposal', proposalId: proposal.id, title: 'Hi' });

    const result = await erase();
    expect(result.rewrittenCode).toEqual([]);
    expect(await prisma.customCodeProposal.findUniqueOrThrow({ where: { id: proposal.id }, select: { document: true } })).toEqual({ document: 'say("[entfernt]")' });
  });

  it('never reaches the code or proposals of a site in another workspace', async () => {
    const otherSite = siteId;
    const otherScope = scope;
    await blob(`say("${VALUE}")`);
    siteId = randomUUID();
    scope = { workspaceId: `ws_erase_cc_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
    await repo.saveProject(scope, project([]));
    await prisma.customCodeProposal.create({
      data: { siteId: otherSite, workspaceId: otherScope.workspaceId, tenantGroupId: TENANT_GROUP, source: 'agent', document: `say("${VALUE}")`, declaration: DECLARATION as never, title: 'Hi', createdBy: OWNER },
    });
    expect((await repo.searchPersonalData(scope, siteId, QUERY)).total).toBe(0);
    // Searching the other site under this workspace finds no site at all.
    await expect(repo.searchPersonalData(scope, otherSite, QUERY)).rejects.toThrow();
  });
});

describe('backtrack: what is not ticked or cannot be taken stays as it was', () => {
  it('leaves code, hash and copies alone when the match in code is not ticked', async () => {
    const old = await blob(`say("${VALUE}")`);
    await repo.saveProject(scope, project([old], `Ask ${VALUE}`), { mustExist: true });

    const result = await erase({ chosen: (preview) => preview.matches.filter((m) => m.blocked === null && m.location.kind === 'working').map((m) => m.id) });
    expect(result.rewrittenCode).toEqual([]);
    expect(result.remaining).toBe(1);
    expect((await rows()).map((row) => [row.sha256, row.document])).toEqual([[old, `say("${VALUE}")`]]);
    expect(await namedEverywhere()).toEqual([`working:${old}`]);
    expect(await prisma.customCodeAudit.count({ where: { siteId } })).toBe(0);
  });

  it('refuses an erase that would leave a block with no code, and changes nothing', async () => {
    const old = await blob(VALUE);
    await repo.saveProject(scope, project([old], `Ask ${VALUE}`), { mustExist: true });
    const before = await namedEverywhere();
    const versionBefore = (await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version;

    const refused = await erase({ replacement: '' }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(EraseCodeRefusedError);
    expect(refused).toMatchObject({ code: 'custom_code_empty' });
    expect(String((refused as Error).message)).not.toContain(VALUE);

    expect((await rows()).map((row) => row.sha256)).toEqual([old]);
    expect(await namedEverywhere()).toEqual(before);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version).toBe(versionBefore);
    expect(await prisma.siteErasure.count({ where: { siteId } })).toBe(0);

    // resume: the same erase with a replacement goes through.
    const result = await erase({ replacement: '[entfernt]' });
    expect(result.remaining).toBe(0);
    expect((await rows()).map((row) => row.document)).toEqual(['[entfernt]']);
  });
});

describe('re-entry: taken-down code, meeting code, and a second erase', () => {
  it('keeps taken-down code taken down under its new hash, on the row and on the takedown list', async () => {
    const old = await blob(`say("${VALUE}")`, { blockedAt: new Date('2026-11-01T00:00:00Z') });
    await prisma.customCodeBlockedHash.create({ data: { sha256: old, blockedBy: 'operator', reason: 'abuse report' } });
    await repo.saveProject(scope, project([old]), { mustExist: true });

    await erase();
    const fresh = await customCodeHash('say("[entfernt]")', DECLARATION);
    expect(await rows()).toEqual([{ sha256: fresh, document: 'say("[entfernt]")', title: 'Team', blockedAt: new Date('2026-11-01T00:00:00Z') }]);
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256: fresh }, select: { blockedBy: true } })).toEqual({ blockedBy: 'operator' });
    const live = await loadLiveCustomCode({ siteId, preview: false, hashes: [fresh] }, ENV);
    expect(live?.blobs.has(fresh)).toBe(false);
    await prisma.customCodeBlockedHash.deleteMany({ where: { sha256: { in: [old, fresh] } } });
  });

  it('gives blocks whose rewritten code meets other code one shared row, and every copy that row', async () => {
    // Two blocks that differ only in how the value is written, and one that already holds the result.
    const upper = await blob(`say("${VALUE}")`);
    const lower = await blob(`say("${VALUE.toLowerCase()}")`);
    const already = await blob('say("[entfernt]")', { title: 'Already' });
    await repo.saveProject(scope, project([upper, lower, already]), { mustExist: true });

    await erase();
    expect((await rows()).map((row) => [row.sha256, row.title])).toEqual([[already, 'Already']]);
    expect(await namedEverywhere()).toEqual([`working:${already}`, `working:${already}`, `working:${already}`]);
  });

  it('gives a block whose rewritten code is another rewritten block\'s old code a row of its own', async () => {
    // Only the first of the two matches in `first` is ticked, which turns it into exactly `second`'s old code, and
    // `second` is rewritten in the same erase. Each must end with a row for the code it now holds.
    const first = await blob(`a("${VALUE}"); b("${VALUE}")`);
    const second = await blob(`a("[entfernt]"); b("${VALUE}")`);
    await repo.saveProject(scope, project([first, second]), { mustExist: true });

    await erase({
      chosen: (preview) => {
        const inFirst = preview.matches.filter((m) => m.location.kind === 'custom-code' && m.location.sha256 === first);
        expect(inFirst).toHaveLength(2);
        return preview.matches.filter((m) => m.blocked === null && m.id !== inFirst[1].id).map((m) => m.id);
      },
    });
    const secondAfter = await customCodeHash('a("[entfernt]"); b("[entfernt]")', DECLARATION);
    // `first` now holds `second`'s old code, so that hash has a row again, holding that code.
    expect((await rows()).map((row) => [row.sha256, row.document]).sort()).toEqual(
      [[second, `a("[entfernt]"); b("${VALUE}")`], [secondAfter, 'a("[entfernt]"); b("[entfernt]")']].sort(),
    );
    expect(await namedEverywhere()).toEqual([`working:${second}`, `working:${secondAfter}`]);
  });

  it('finds nothing on a second erase', async () => {
    const old = await blob(`say("${VALUE}")`);
    await repo.saveProject(scope, project([old]), { mustExist: true });
    await erase();
    expect((await repo.searchPersonalData(scope, siteId, QUERY)).total).toBe(0);
    await expect(erase()).rejects.toThrow();
  });
});
