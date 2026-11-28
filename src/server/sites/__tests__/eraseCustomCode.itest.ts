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
import { createHash, randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import { ErasePreviewStaleError, type TenantScope } from '@/server/sites';
import { EraseCodeRefusedError } from '@/server/sites/erase';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { SiteBranchMergeService } from '@/server/sites/branches/merge';
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
function project(hashes: string[], text = 'Hello', over: { id?: string; componentHash?: string } = {}) {
  return {
    id: over.id ?? siteId,
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
    ...(over.componentHash
      ? {
          components: {
            card: {
              id: 'card',
              name: 'Card',
              page: { id: 'card-page', slug: '', metadata: { title: 'Card' }, appComponentTree: { id: 'c-root', type: 'div', componentType: 'host', props: {}, children: [block('c-block', over.componentHash)] }, canvasNodes: {} },
            },
          },
        }
      : {}),
  } as never;
}

/** Every hash a value names, as `place:hash` strings. */
function hashesIn(place: string, value: unknown): string[] {
  return [...JSON.stringify(value ?? null).matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((m) => `${place}:${m[1]}`);
}

/** Stores a blob of the site under the hash its code really gives, and returns that hash. */
async function blob(code: string, options: { title?: string; blockedAt?: Date; site?: string; declaration?: unknown } = {}): Promise<string> {
  const sha256 = options.declaration ? createHash('sha256').update(code).digest('hex') : await customCodeHash(code, DECLARATION);
  await prisma.customCodeBlob.create({
    data: {
      siteId: options.site ?? siteId,
      sha256,
      document: code,
      declaration: (options.declaration ?? DECLARATION) as never,
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
    // Only the title changed: no code to check, so the panel names none.
    expect(result.rewrittenCode).toEqual([]);
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
  it('keeps taken-down code taken down under its new hash, on its new row', async () => {
    const old = await blob(`say("${VALUE}")`, { blockedAt: new Date('2026-11-01T00:00:00Z') });
    await prisma.customCodeBlockedHash.create({ data: { sha256: old, blockedBy: 'operator', reason: 'abuse report' } });
    await repo.saveProject(scope, project([old]), { mustExist: true });

    await erase();
    const fresh = await customCodeHash('say("[entfernt]")', DECLARATION);
    expect(await rows()).toEqual([{ sha256: fresh, document: 'say("[entfernt]")', title: 'Team', blockedAt: new Date('2026-11-01T00:00:00Z') }]);
    // The takedown list is never written by an erase (security review B1): the row keeps the code dark.
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256: fresh } })).toBeNull();
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

describe('review of part 2: every copy, the takedown boundary, and refusals', () => {
  const actor = { kind: 'user' as const, id: OWNER };

  it('points every copy at the new hash: components, an open branch and its base copy, and the copy kept to undo a merge', async () => {
    const old = await blob(`say("${VALUE}")`);
    await repo.saveProject(scope, project([old], 'Main', { componentHash: old }), { mustExist: true });
    const branches = new SiteBranchRepository(prisma);
    const merges = new SiteBranchMergeService(prisma, repo);
    // A first branch, merged: main keeps its copy from before, for "Undo this merge".
    const { branch: merged } = await branches.createBranch(scope, siteId, { name: 'Merged', actor });
    await repo.saveProject(scope, project([old], 'From the branch', { id: merged.branchId, componentHash: old }), { mustExist: true });
    const first = await merges.changes(scope, merged.branchId);
    await merges.approve(scope, merged.branchId, { token: first.token }, actor).catch(() => undefined);
    await merges.merge(scope, merged.branchId, { token: (await merges.changes(scope, merged.branchId)).token }, actor);
    // A second branch, open: its own working copy and the copy it started from.
    const { branch: open } = await branches.createBranch(scope, siteId, { name: 'Open', actor });

    await erase();
    const fresh = await customCodeHash('say("[entfernt]")', DECLARATION);
    const everywhere = async () => {
      const sites = await prisma.site.findMany({ where: { OR: [{ id: siteId }, { branchOfSiteId: siteId }] }, select: { id: true, components: true, pages: { select: { snapshot: true } } } });
      const records = await prisma.siteBranch.findMany({ where: { siteId }, select: { name: true, baseDocument: true, mainBeforeDocument: true } });
      return [
        ...sites.flatMap((site) => [...hashesIn(`${site.id === siteId ? 'main' : 'branch'} components`, site.components), ...site.pages.flatMap((page) => hashesIn(site.id === siteId ? 'main' : 'branch', page.snapshot))]),
        ...records.flatMap((record) => [...hashesIn(`${record.name} base`, record.baseDocument), ...hashesIn(`${record.name} undo`, record.mainBeforeDocument)]),
      ];
    };
    const named = await everywhere();
    expect(named.some((entry) => entry.endsWith(old))).toBe(false);
    for (const place of ['main', 'main components', 'branch', 'branch components', 'Open base', 'Merged undo']) {
      expect(named, place).toContain(`${place}:${fresh}`);
    }
    expect(open.branchId).toBeTruthy();
  }, 60_000);

  it('drops the copy kept to undo a merge when a match is left in it, and no copy names the old hash', async () => {
    const old = await blob(`say("${VALUE}")`);
    await repo.saveProject(scope, project([old], `Ask ${VALUE}`), { mustExist: true });
    const branches = new SiteBranchRepository(prisma);
    const merges = new SiteBranchMergeService(prisma, repo);
    const { branch } = await branches.createBranch(scope, siteId, { name: 'Merged', actor });
    await repo.saveProject(scope, project([old], 'From the branch', { id: branch.branchId }), { mustExist: true });
    const first = await merges.changes(scope, branch.branchId);
    await merges.approve(scope, branch.branchId, { token: first.token }, actor).catch(() => undefined);
    await merges.merge(scope, branch.branchId, { token: (await merges.changes(scope, branch.branchId)).token }, actor);

    // Everything ticked but the text in the undo copy: the copy is dropped rather than kept with a match.
    await erase({ chosen: (preview) => preview.matches.filter((m) => m.blocked === null && !(m.location.kind === 'merge-undo' && m.area === 'text')).map((m) => m.id) });
    const record = await prisma.siteBranch.findFirstOrThrow({ where: { siteId }, select: { mainBeforeDocument: true } });
    expect(record.mainBeforeDocument).toBeNull();
    expect((await rows()).map((row) => row.document)).toEqual(['say("[entfernt]")']);
    expect((await namedEverywhere()).some((entry) => entry.endsWith(old))).toBe(false);
  }, 60_000);

  it('never puts a hash on the takedown list, so another workspace\'s identical code stays live', async () => {
    // Another workspace's site serves `victim`. This site's listed block is `victim` plus the value.
    const victim = 'render("their widget");';
    const otherSite = siteId;
    const otherScope = scope;
    const theirs = await blob(victim);
    await repo.saveProject(otherScope, project([theirs], 'Theirs', { id: otherSite }), { mustExist: true });
    siteId = randomUUID();
    scope = { workspaceId: `ws_erase_cc_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
    await repo.saveProject(scope, project([]));
    await prisma.site.updateMany({ where: { id: siteId }, data: { customCodeEnabled: true } });
    const listed = await blob(`${victim}${VALUE}`);
    await prisma.customCodeBlockedHash.create({ data: { sha256: listed, blockedBy: 'operator', reason: 'abuse report' } });
    await repo.saveProject(scope, project([listed]), { mustExist: true });

    await erase({ replacement: '' });
    expect(theirs).toBe(await customCodeHash(victim, DECLARATION));
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256: theirs } })).toBeNull();
    // Their row is untouched and served; this site's new row under the same hash is dark.
    expect(await prisma.customCodeBlob.findUniqueOrThrow({ where: { siteId_sha256: { siteId: otherSite, sha256: theirs } }, select: { blockedAt: true } })).toEqual({ blockedAt: null });
    expect((await loadLiveCustomCode({ siteId: otherSite, preview: false, hashes: [theirs] }, ENV))?.blobs.has(theirs)).toBe(true);
    expect((await rows())[0]).toMatchObject({ sha256: theirs, blockedAt: expect.any(Date) });
    await prisma.customCodeBlockedHash.deleteMany({ where: { sha256: listed } });
  });

  it('keeps code taken down on another site taken down when the erase lands on it here', async () => {
    const takenDown = 'render("taken down elsewhere");';
    const elsewhere = randomUUID();
    await repo.saveProject(scope, project([], 'Elsewhere', { id: elsewhere }));
    const down = await blob(takenDown, { site: elsewhere, blockedAt: new Date() });
    const mine = await blob(`${takenDown}${VALUE}`);
    await repo.saveProject(scope, project([mine]), { mustExist: true });

    await erase({ replacement: '' });
    expect((await rows())[0]).toMatchObject({ sha256: down, blockedAt: expect.any(Date) });
    expect((await loadLiveCustomCode({ siteId, preview: false, hashes: [down] }, ENV))?.blobs.has(down)).toBe(false);
  });

  it('meets a taken-down block and a live one on one hash in either order, and the shared row stays dark', async () => {
    // Four spellings of the value that all erase to the same code; their old hashes sort in some order.
    const spellings = [VALUE, VALUE.toLowerCase(), VALUE.toUpperCase(), 'max Mustermann'];
    const coded = await Promise.all(spellings.map(async (spelling) => ({ code: `say("${spelling}")`, sha256: await customCodeHash(`say("${spelling}")`, DECLARATION) })));
    coded.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
    const fresh = await customCodeHash('say("[entfernt]")', DECLARATION);
    // The taken-down block first in the walk, then last.
    for (const [down, live] of [[coded[0], coded[1]], [coded[3], coded[2]]]) {
      // A fresh site per order: after an erase, a save from before it is refused (the erase epoch).
      siteId = randomUUID();
      await repo.saveProject(scope, project([]));
      await blob(down.code, { blockedAt: new Date() });
      await blob(live.code);
      await repo.saveProject(scope, project([down.sha256, live.sha256]), { mustExist: true });
      await erase();
      expect(await rows()).toEqual([expect.objectContaining({ sha256: fresh, blockedAt: expect.any(Date) })]);
    }
  });

  it('refuses code that would grow past 256 KB, and a block whose declaration no longer parses, changing nothing', async () => {
    const big = await blob(`${'x'.repeat(256 * 1024)} ${VALUE}`);
    await repo.saveProject(scope, project([big]), { mustExist: true });
    await expect(erase()).rejects.toMatchObject({ code: 'custom_code_too_large' });
    expect((await rows()).map((row) => row.sha256)).toEqual([big]);

    await prisma.customCodeBlob.deleteMany({ where: { siteId } });
    const odd = await blob(`say("${VALUE}")`, { declaration: { unknown: true }, title: `Of ${VALUE}` });
    await repo.saveProject(scope, project([odd]), { mustExist: true });
    const refused = await erase().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(EraseCodeRefusedError);
    expect(refused).toMatchObject({ code: 'custom_code_unreadable' });
    // Its title alone needs no new hash, so ticking only the title goes through.
    await erase({ chosen: (preview) => preview.matches.filter((m) => m.blocked === null && m.location.kind === 'custom-code' && m.path === '/title').map((m) => m.id) });
    expect(await rows()).toEqual([expect.objectContaining({ sha256: odd, title: 'Of [entfernt]', document: `say("${VALUE}")` })]);
  });

  it('names a block that met another under the title its kept row holds, since a blob row is never updated', async () => {
    const first = await blob(`say("${VALUE}")`, { title: 'Opening hours' });
    const second = await blob(`say("${VALUE.toLowerCase()}")`, { title: 'Team' });
    await repo.saveProject(scope, project([first, second]), { mustExist: true });
    const result = await erase();
    const kept = await rows();
    expect(kept).toHaveLength(1);
    // Both blocks are served by one row, under whichever title it was written with; the panel names that title twice.
    expect(result.rewrittenCode).toEqual([kept[0].title, kept[0].title]);
    expect(['Opening hours', 'Team']).toContain(kept[0].title);
  });

  it('reaches the code of a site whose custom code is switched off: erasing is not running it (D115)', async () => {
    const old = await blob(`say("${VALUE}")`);
    await repo.saveProject(scope, project([old]), { mustExist: true });
    await prisma.site.updateMany({ where: { id: siteId }, data: { customCodeEnabled: false } });
    const result = await erase();
    expect(result.rewrittenCode).toEqual(['Team']);
    expect((await rows()).map((row) => row.document)).toEqual(['say("[entfernt]")']);
  });

  it('says a stale preview is stale, not that the code cannot be erased', async () => {
    const old = await blob(VALUE);
    await repo.saveProject(scope, project([old]), { mustExist: true });
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    // Something holding the value is added after the preview.
    await repo.saveProject(scope, project([old], `Ask ${VALUE}`), { mustExist: true });
    const chosen = preview.matches.filter((m) => m.blocked === null).map((m) => m.id);
    await expect(repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: '', token: preview.token, chosen, erasedBy: OWNER })).rejects.toBeInstanceOf(ErasePreviewStaleError);
  });
});
// ci-replay touch
