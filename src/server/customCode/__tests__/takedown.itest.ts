// src/server/customCode/__tests__/takedown.itest.ts
//
// The operator's takedown of custom code against a REAL Postgres (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// "Abuse handling", D116 to D119): blocking a hash, unblocking it, and switching one site's custom code off.
//
// The four paths of the stateful flow standard:
//   forward      a block lists the hash, blocks every site's row of it with one audit line per site, and nothing
//                serves or writes it any more; a site disable turns the switch off and its editors read the reason;
//   backtrack    an unblock reverses a block: list, rows and service; the owner's own switch change later hides
//                the operator's reason;
//   resume       a repeated block or disable keeps the first time and adds no second block line;
//   re-entry     a hash no site holds is listed alone and refused when written later; a rollback to a published
//                version whose code was taken down shows the fallback; a branch id and an unknown id are refused.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { customCodeHash, parseDeclaration, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { loadLiveCustomCode } from '@/server/customCode/liveBlocks';
import { readCustomCodeStatus, writeCustomCodeBlob } from '@/server/customCode/authoring';
import { DerivedChainTooLongError, blockCustomCodeHash, disableCustomCodeForSite, liftCustomCodeDisable, unblockCustomCodeHash } from '@/server/customCode/takedown';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000c5e03';
const OWNER = 'user-owner';
const ENV = { CUSTOM_CODE_DISABLED: '0', SANDBOX_ORIGIN: 'https://run.example.test' };
const OPERATOR = { label: 'operator:abuse-report', reason: 'phishing form reported on 2026-11-27' };

const parsed = parseDeclaration({ reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true });
if (!parsed.ok) throw new Error('the test declaration must parse');
const DECLARATION: CustomCodeDeclaration = parsed.declaration;

let prisma: PrismaClient;
const repo = latestVersionRepository();

interface TestSite { siteId: string; scope: TenantScope }

function project(siteId: string, hashes: string[], text = 'Hello') {
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
            ...hashes.map((sha256, index) => ({ id: `block-${index}`, type: 'div', componentType: 'host', props: { customCode: { sha256, title: 'Team' } }, children: [] })),
          ],
        },
        canvasNodes: {},
      },
    },
  } as never;
}

async function newSite(hashes: string[] = []): Promise<TestSite> {
  const siteId = randomUUID();
  const scope = { workspaceId: `ws_takedown_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  await repo.saveProject(scope, project(siteId, hashes));
  await prisma.site.updateMany({ where: { id: siteId }, data: { customCodeEnabled: true } });
  return { siteId, scope };
}

async function blob(site: TestSite, code: string): Promise<string> {
  const sha256 = await customCodeHash(code, DECLARATION);
  await prisma.customCodeBlob.create({
    data: { siteId: site.siteId, sha256, document: code, declaration: DECLARATION as never, title: 'Team', createdBy: OWNER },
  });
  return sha256;
}

const live = async (site: TestSite, hashes: string[]) =>
  (await loadLiveCustomCode({ siteId: site.siteId, preview: false, hashes }, ENV))?.blobs ?? new Map();

const audit = (site: TestSite) =>
  prisma.customCodeAudit.findMany({ where: { siteId: site.siteId }, select: { action: true, actor: true, sha256: true, detail: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

const status = (site: TestSite) => readCustomCodeStatus({ siteId: site.siteId, ...site.scope });

beforeAll(() => {
  prisma = getPrismaClient();
});

let a: TestSite;
let b: TestSite;

beforeEach(async () => {
  a = await newSite();
  b = await newSite();
});

afterAll(async () => {
  await prisma.customCodeAudit.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.customCodeBlockedHash.deleteMany({ where: { reason: { startsWith: 'phishing form reported' } } });
  await prisma.$disconnect();
});

describe('forward: blocking a hash takes it down on every site', () => {
  it('lists it, blocks each site\'s row with one audit line per site, and nothing serves it', async () => {
    const code = `render("same code ${randomUUID()}")`;
    const onA = await blob(a, code);
    const onB = await blob(b, code);
    expect(onA).toBe(onB);
    await repo.saveProject(a.scope, project(a.siteId, [onA]), { mustExist: true });
    expect((await live(a, [onA])).has(onA)).toBe(true);

    const result = await blockCustomCodeHash(onA, OPERATOR);
    expect(result).toEqual({ sha256: onA, listChanged: true, sites: [a.siteId, b.siteId].sort(), derived: [] });

    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256: onA }, select: { blockedBy: true, reason: true } }))
      .toEqual({ blockedBy: OPERATOR.label, reason: OPERATOR.reason });
    const rows = await prisma.customCodeBlob.findMany({ where: { sha256: onA }, select: { blockedAt: true } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.blockedAt !== null)).toBe(true);
    for (const site of [a, b]) {
      expect(await audit(site)).toEqual([{ action: 'blob-block', actor: OPERATOR.label, sha256: onA, detail: { reason: OPERATOR.reason } }]);
    }
    expect((await live(a, [onA])).has(onA)).toBe(false);
  });

  it('refuses the same code when a third site writes it afterwards', async () => {
    const code = `render("taken down ${randomUUID()}")`;
    const sha256 = await blob(a, code);
    await blockCustomCodeHash(sha256, OPERATOR);
    const c = await newSite();
    await repo.saveProject(c.scope, project(c.siteId, [sha256]), { mustExist: true });
    const written = await writeCustomCodeBlob({
      siteId: c.siteId, ...c.scope, actor: OWNER, pageId: 'home', nodeId: 'block-0',
      code: { document: code, declaration: DECLARATION, title: 'Team', bytes: Buffer.byteLength(code) },
    });
    expect(written).toMatchObject({ ok: false, refusal: { code: 'blocked' } });
  });
});

describe('resume: a repeated block keeps the first time', () => {
  it('changes nothing and writes no second audit line', async () => {
    const sha256 = await blob(a, `render("again ${randomUUID()}")`);
    await blockCustomCodeHash(sha256, OPERATOR, undefined, () => new Date('2026-11-27T10:00:00Z'));
    const again = await blockCustomCodeHash(sha256, { ...OPERATOR, reason: 'phishing form reported twice' }, undefined, () => new Date('2026-11-27T11:00:00Z'));
    expect(again).toEqual({ sha256, listChanged: false, sites: [], derived: [] });
    const listed = await prisma.customCodeBlockedHash.findUnique({ where: { sha256 } });
    expect(listed?.blockedAt.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(listed?.reason).toBe(OPERATOR.reason);
    expect((await audit(a)).map((row) => row.action)).toEqual(['blob-block']);
  });
});

describe('backtrack: unblocking reverses a block made in error', () => {
  it('takes the hash off the list, clears every row and serves it again', async () => {
    const code = `render("mistake ${randomUUID()}")`;
    const sha256 = await blob(a, code);
    await blob(b, code);
    await repo.saveProject(a.scope, project(a.siteId, [sha256]), { mustExist: true });
    await blockCustomCodeHash(sha256, OPERATOR);

    const result = await unblockCustomCodeHash(sha256, { label: 'operator', reason: 'phishing form reported in error' });
    expect(result).toEqual({ sha256, listChanged: true, sites: [a.siteId, b.siteId].sort(), derived: [] });
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256 } })).toBeNull();
    expect((await prisma.customCodeBlob.findMany({ where: { sha256 }, select: { blockedAt: true } })).every((row) => row.blockedAt === null)).toBe(true);
    expect((await audit(a)).map((row) => row.action)).toEqual(['blob-block', 'blob-unblock']);
    expect((await live(a, [sha256])).has(sha256)).toBe(true);

    // Unblocking again changes nothing.
    expect(await unblockCustomCodeHash(sha256, OPERATOR)).toEqual({ sha256, listChanged: false, sites: [], derived: [] });
  });
});

describe('re-entry: hashes no site holds, and published versions', () => {
  it('lists a hash no site holds, with no audit line, and refuses it when written later', async () => {
    const code = `render("never stored ${randomUUID()}")`;
    const sha256 = await customCodeHash(code, DECLARATION);
    expect(await blockCustomCodeHash(sha256, OPERATOR)).toEqual({ sha256, listChanged: true, sites: [], derived: [] });
    await repo.saveProject(a.scope, project(a.siteId, [sha256]), { mustExist: true });
    const written = await writeCustomCodeBlob({
      siteId: a.siteId, ...a.scope, actor: OWNER, pageId: 'home', nodeId: 'block-0',
      code: { document: code, declaration: DECLARATION, title: 'Team', bytes: Buffer.byteLength(code) },
    });
    expect(written).toMatchObject({ ok: false, refusal: { code: 'blocked' } });
  });

  it('shows the fallback after a rollback to a published version whose code was taken down', async () => {
    const first = await blob(a, `render("first ${randomUUID()}")`);
    const second = await blob(a, `render("second ${randomUUID()}")`);
    await repo.publishProject(a.scope, project(a.siteId, [first]), { publishedBy: OWNER });
    await repo.publishProject(a.scope, project(a.siteId, [second], 'Second'), { publishedBy: OWNER });
    await blockCustomCodeHash(first, OPERATOR);

    await repo.rollbackToRevision(a.scope, a.siteId, 1);
    // The first version's blob is kept (a kept revision names it) and stays blocked: its block shows the fallback.
    const row = await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: a.siteId, sha256: first } }, select: { blockedAt: true } });
    expect(row?.blockedAt).not.toBeNull();
    const blobs = await live(a, [first, second]);
    expect(blobs.has(first)).toBe(false);
    expect(blobs.has(second)).toBe(true);
  });
});

describe('rows a personal-data erase rewrote the code into (D115)', () => {
  /** Stores a rewritten row on the site and the `blob-erase` line the erase writes for it. */
  async function rewritten(site: TestSite, from: string, blockedAt: Date | null = null): Promise<string> {
    const code = `render("rewritten ${randomUUID()}")`;
    const sha256 = await customCodeHash(code, DECLARATION);
    await prisma.customCodeBlob.create({ data: { siteId: site.siteId, sha256, document: code, declaration: DECLARATION as never, title: 'Team', createdBy: OWNER, blockedAt } });
    await prisma.customCodeAudit.create({ data: { siteId: site.siteId, ...site.scope, actor: OWNER, action: 'blob-erase', sha256, detail: { replaces: from } } });
    return sha256;
  }

  it('blocks them on their own site with the block, without listing them, and unblocks them with the unblock', async () => {
    const original = await customCodeHash(`render("original ${randomUUID()}")`, DECLARATION);
    const first = await rewritten(a, original);
    const second = await rewritten(a, first);

    const blocked = await blockCustomCodeHash(original, OPERATOR);
    expect(blocked.sites).toEqual([]);
    expect(blocked.derived).toEqual([{ siteId: a.siteId, sha256: first }, { siteId: a.siteId, sha256: second }].sort((x, y) => x.sha256.localeCompare(y.sha256)));
    for (const sha256 of [first, second]) {
      expect((await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: a.siteId, sha256 } } }))?.blockedAt).not.toBeNull();
      expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256 } })).toBeNull();
    }
    expect((await audit(a)).filter((row) => row.action === 'blob-block').map((row) => row.detail)).toEqual([
      { reason: OPERATOR.reason, follows: original },
      { reason: OPERATOR.reason, follows: original },
    ]);

    const unblocked = await unblockCustomCodeHash(original, OPERATOR);
    expect(unblocked.derived).toHaveLength(2);
    expect((await live(a, [first, second])).size).toBe(2);
  });

  const hex = () => createHash('sha256').update(randomUUID()).digest('hex');
  async function row(site: TestSite, sha256: string, blockedAt: Date | null = null) {
    await prisma.customCodeBlob.create({ data: { siteId: site.siteId, sha256, document: `render("${sha256}")`, declaration: DECLARATION as never, title: 'Team', createdBy: OWNER, blockedAt } });
  }
  async function eraseLine(site: TestSite, to: string, from: string) {
    await prisma.customCodeAudit.create({ data: { siteId: site.siteId, ...site.scope, actor: OWNER, action: 'blob-erase', sha256: to, detail: { replaces: from } } });
  }

  it('R2-1 (a): leaves a rewritten row blocked on unblock when a hash it came from in between is still taken down', async () => {
    const [h, x, x2] = [hex(), hex(), hex()];
    // H was erased into X (whose row a later erase deleted), and X into X2; X is on the list, so X2 carries its block.
    await eraseLine(a, x, h);
    await eraseLine(a, x2, x);
    await row(a, x2, new Date());
    await blockCustomCodeHash(x, OPERATOR);
    await blockCustomCodeHash(h, OPERATOR);
    expect((await unblockCustomCodeHash(h, OPERATOR)).derived).toEqual([]);
    expect((await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: a.siteId, sha256: x2 } } }))?.blockedAt).not.toBeNull();
  });

  it('R2-1 (b): leaves a row with two parents blocked when the other parent is taken down', async () => {
    const [z, z2, q] = [hex(), hex(), hex()];
    await eraseLine(a, z2, z);
    await row(a, z2, new Date());
    await blockCustomCodeHash(z, OPERATOR);
    // A later erase rewrote other code Q into the very same code, and kept the row.
    await eraseLine(a, z2, q);
    await blockCustomCodeHash(q, OPERATOR);
    expect((await unblockCustomCodeHash(q, OPERATOR)).derived).toEqual([]);
    expect((await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: a.siteId, sha256: z2 } } }))?.blockedAt).not.toBeNull();
  });

  it('R2-2: follows a chain only on the site where it started, never into another site\'s identical code', async () => {
    const [h, x, other] = [hex(), hex(), hex()];
    await eraseLine(a, x, h);
    await row(a, x);
    // Site B holds the same code X and erased it into its own row: B never held H.
    await row(b, x);
    await eraseLine(b, other, x);
    await row(b, other);
    const blocked = await blockCustomCodeHash(h, OPERATOR);
    expect(blocked.derived).toEqual([{ siteId: a.siteId, sha256: x }]);
    expect((await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: b.siteId, sha256: other } } }))?.blockedAt).toBeNull();
    expect((await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: b.siteId, sha256: x } } }))?.blockedAt).toBeNull();
  });

  it('refuses as a whole, changing nothing, when the chain is too long to follow', async () => {
    const h = hex();
    await prisma.customCodeAudit.createMany({
      data: Array.from({ length: 257 }, () => ({ siteId: a.siteId, ...a.scope, actor: OWNER, action: 'blob-erase', sha256: hex(), detail: { replaces: h } })),
    });
    await expect(blockCustomCodeHash(h, OPERATOR)).rejects.toBeInstanceOf(DerivedChainTooLongError);
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256: h } })).toBeNull();
  });

  it('leaves a rewritten row blocked on unblock when its own hash is taken down', async () => {
    const original = await customCodeHash(`render("original ${randomUUID()}")`, DECLARATION);
    const derived = await rewritten(a, original, new Date());
    await blockCustomCodeHash(derived, OPERATOR);
    expect((await unblockCustomCodeHash(original, OPERATOR)).derived).toEqual([]);
    expect((await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: a.siteId, sha256: derived } } }))?.blockedAt).not.toBeNull();
  });
});

describe('a site disable', () => {
  it('turns the switch off, stops every block, and tells the site\'s editors why', async () => {
    const sha256 = await blob(a, `render("site ${randomUUID()}")`);
    await repo.saveProject(a.scope, project(a.siteId, [sha256]), { mustExist: true });
    expect(await disableCustomCodeForSite(a.siteId, OPERATOR, undefined, () => new Date('2026-11-27T12:00:00Z')))
      .toEqual({ ok: true, siteId: a.siteId, wasEnabled: true });

    expect((await live(a, [sha256])).size).toBe(0);
    expect(await status(a)).toMatchObject({ enabled: false, disabledByLumitra: { reason: OPERATOR.reason, at: '2026-11-27T12:00:00.000Z' } });
    expect(await audit(a)).toEqual([{ action: 'disable', actor: OPERATOR.label, sha256: null, detail: { reason: OPERATOR.reason } }]);
    // The other site is untouched.
    expect(await status(b)).toMatchObject({ enabled: true, disabledByLumitra: null });
  });

  it('records a repeated disable, the last reason winning, and keeps the switch off', async () => {
    await disableCustomCodeForSite(a.siteId, OPERATOR, undefined, () => new Date('2026-11-27T12:00:00Z'));
    expect(await disableCustomCodeForSite(a.siteId, { ...OPERATOR, reason: 'phishing form reported again' }, undefined, () => new Date('2026-11-27T13:00:00Z')))
      .toEqual({ ok: true, siteId: a.siteId, wasEnabled: false });
    expect(await status(a)).toMatchObject({ enabled: false, disabledByLumitra: { reason: 'phishing form reported again' } });
  });

  it('keeps standing when the site\'s own people write a switch line afterwards (only a lift ends it)', async () => {
    await disableCustomCodeForSite(a.siteId, OPERATOR, undefined, () => new Date('2026-11-27T12:00:00Z'));
    // A stale "switch off" press, then (once slice C7 exists) an owner's enable: neither ends the takedown.
    await prisma.customCodeAudit.create({ data: { siteId: a.siteId, ...a.scope, actor: OWNER, action: 'disable', createdAt: new Date('2026-11-27T14:00:00Z') } });
    expect(await status(a)).toMatchObject({ enabled: false, disabledByLumitra: { reason: OPERATOR.reason } });
    await prisma.customCodeAudit.create({ data: { siteId: a.siteId, ...a.scope, actor: OWNER, action: 'enable', createdAt: new Date('2026-11-27T15:00:00Z') } });
    expect(await status(a)).toMatchObject({ disabledByLumitra: { reason: OPERATOR.reason } });
  });

  it('orders a lift after its disable even when the clock steps back', async () => {
    await disableCustomCodeForSite(a.siteId, OPERATOR, undefined, () => new Date('2026-11-27T12:00:00Z'));
    await liftCustomCodeDisable(a.siteId, OPERATOR, undefined, () => new Date('2026-11-27T11:00:00Z'));
    expect(await status(a)).toMatchObject({ disabledByLumitra: null });
  });

  it('is lifted only by the operator: the switch stays off and the reason is gone; a second lift writes nothing', async () => {
    await disableCustomCodeForSite(a.siteId, OPERATOR, undefined, () => new Date('2026-11-27T12:00:00Z'));
    expect(await liftCustomCodeDisable(a.siteId, { label: 'operator', reason: 'reviewed, the form is gone' }, undefined, () => new Date('2026-11-27T15:00:00Z')))
      .toEqual({ ok: true, siteId: a.siteId, lifted: true });
    expect(await status(a)).toMatchObject({ enabled: false, disabledByLumitra: null });
    expect(await liftCustomCodeDisable(a.siteId, OPERATOR)).toEqual({ ok: true, siteId: a.siteId, lifted: false });
    expect((await audit(a)).map((row) => [row.action, row.detail])).toEqual([
      ['disable', { reason: OPERATOR.reason }],
      ['disable', { reason: 'reviewed, the form is gone', lifted: true }],
    ]);
  });

  it('refuses a branch id and an unknown id, changing nothing', async () => {
    const { branch } = await new SiteBranchRepository(prisma).createBranch(a.scope, a.siteId, { name: 'Draft', actor: { kind: 'user', id: OWNER } });
    expect(await disableCustomCodeForSite(branch.branchId, OPERATOR)).toEqual({ ok: false, reason: 'branch_site' });
    expect(await disableCustomCodeForSite(randomUUID(), OPERATOR)).toEqual({ ok: false, reason: 'not_found' });
    expect(await liftCustomCodeDisable(branch.branchId, OPERATOR)).toEqual({ ok: false, reason: 'branch_site' });
    expect(await liftCustomCodeDisable(randomUUID(), OPERATOR)).toEqual({ ok: false, reason: 'not_found' });
    expect(await status(a)).toMatchObject({ enabled: true });
    expect(await audit(a)).toEqual([]);
  });
});
