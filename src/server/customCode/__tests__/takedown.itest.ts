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
//                version whose code was taken down shows the fallback; a branch id and an unknown id are refused;
//                rows an erase rewrote the code into keep their own state and are reported for the operator.
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
import { customCodeHashes } from '@/lib/renderer/server/applyCustomCode';
import { parseRevisionDocument } from '@/server/sites/revision';
import { readCustomCodeStatus, writeCustomCodeBlob } from '@/server/customCode/authoring';
import { REWRITTEN_REPORT_MAX, blockCustomCodeHash, disableCustomCodeForSite, liftCustomCodeDisable, readRewrittenRows, unblockCustomCodeHash } from '@/server/customCode/takedown';
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

/** What the published page may run. Null is a failed read (or a closed gate), which must never pass as "nothing served". */
const live = async (site: TestSite, hashes: string[]) => {
  const loaded = await loadLiveCustomCode({ siteId: site.siteId, preview: false, hashes }, ENV);
  if (!loaded) throw new Error('the live custom code read answered null');
  return loaded.blobs;
};

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
    expect(result).toEqual({ sha256: onA, listChanged: true, sites: [a.siteId, b.siteId].sort() });

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
    expect(again).toEqual({ sha256, listChanged: false, sites: [] });
    const listed = await prisma.customCodeBlockedHash.findUnique({ where: { sha256 } });
    expect(listed?.blockedAt.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(listed?.reason).toBe(OPERATOR.reason);
    expect((await audit(a)).map((row) => row.action)).toEqual(['blob-block']);
  });
});

describe('overlapping calls on one hash', () => {
  /**
   * How many backends wait behind the holder, directly or through one another. Only this chain: the other
   * integration files share the database and run at the same time, so their lock waits must not count.
   */
  const queuedBehind = async (holderPid: number) =>
    Number((await prisma.$queryRaw<{ n: bigint }[]>`
      WITH RECURSIVE queued(pid) AS (
        SELECT a.pid FROM pg_catalog.pg_stat_activity a WHERE ${holderPid}::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid FROM pg_catalog.pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_catalog.pg_blocking_pids(a.pid))
      )
      SELECT pg_catalog.count(*) AS n FROM queued`)[0].n);

  it('serializes a block behind an unblock, so the list and the rows never disagree', async () => {
    const sha256 = await blob(a, `render("overlap ${randomUUID()}")`);
    await blockCustomCodeHash(sha256, OPERATOR);

    // Hold the site row, so the unblock stops before it changes anything, then start the block behind it.
    let release!: () => void;
    let locked!: (pid: number) => void;
    const held = new Promise<number>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT s.id FROM public.sites s WHERE s.id = ${a.siteId} FOR NO KEY UPDATE`;
      locked((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`)[0].pid);
      await gate;
    }, { timeout: 12_000 });
    const holderPid = await held;
    const untilQueued = (n: number) => expect.poll(() => queuedBehind(holderPid), { timeout: 4_000, interval: 25 }).toBe(n);
    let unblock: ReturnType<typeof unblockCustomCodeHash> | undefined;
    let block: ReturnType<typeof blockCustomCodeHash> | undefined;
    try {
      unblock = unblockCustomCodeHash(sha256, OPERATOR);
      await untilQueued(1);
      block = blockCustomCodeHash(sha256, OPERATOR);
      await untilQueued(2);
    } finally {
      release();
      await holder;
    }

    expect(await unblock).toEqual({ sha256, listChanged: true, sites: [a.siteId] });
    expect(await block).toEqual({ sha256, listChanged: true, sites: [a.siteId] });
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256 } })).not.toBeNull();
    expect((await prisma.customCodeBlob.findUniqueOrThrow({ where: { siteId_sha256: { siteId: a.siteId, sha256 } } })).blockedAt).not.toBeNull();
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
    expect(result).toEqual({ sha256, listChanged: true, sites: [a.siteId, b.siteId].sort() });
    expect(await prisma.customCodeBlockedHash.findUnique({ where: { sha256 } })).toBeNull();
    expect((await prisma.customCodeBlob.findMany({ where: { sha256 }, select: { blockedAt: true } })).every((row) => row.blockedAt === null)).toBe(true);
    expect((await audit(a)).map((row) => row.action)).toEqual(['blob-block', 'blob-unblock']);
    expect((await live(a, [sha256])).has(sha256)).toBe(true);

    // Unblocking again changes nothing.
    expect(await unblockCustomCodeHash(sha256, OPERATOR)).toEqual({ sha256, listChanged: false, sites: [] });
  });
});

describe('re-entry: hashes no site holds, and published versions', () => {
  it('lists a hash no site holds, with no audit line, and refuses it when written later', async () => {
    const code = `render("never stored ${randomUUID()}")`;
    const sha256 = await customCodeHash(code, DECLARATION);
    expect(await blockCustomCodeHash(sha256, OPERATOR)).toEqual({ sha256, listChanged: true, sites: [] });
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
    const site = await prisma.site.findUniqueOrThrow({ where: { id: a.siteId }, select: { publishedRevisionId: true } });
    const revision = await prisma.siteRevision.findUniqueOrThrow({ where: { id: site.publishedRevisionId! }, select: { number: true, document: true } });
    expect(revision.number).toBe(1);
    const named = parseRevisionDocument(revision.document).pages.flatMap((page) => customCodeHashes(page.snapshot.appComponentTree as never));
    expect(named).toEqual([first]);
    // The first version's blob is kept (a kept revision names it) and stays blocked: its block shows the fallback.
    const row = await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: a.siteId, sha256: first } }, select: { blockedAt: true } });
    expect(row).not.toBeNull();
    expect(row!.blockedAt).toBeInstanceOf(Date);
    expect((await live(a, named)).size).toBe(0);
    // The code that was not taken down is still servable, so the empty answer above is the block's doing.
    expect((await live(a, [second])).has(second)).toBe(true);
  });
});

describe('rows a personal-data erase rewrote the code into (D115, D117)', () => {
  const hex = () => createHash('sha256').update(randomUUID()).digest('hex');
  async function row(site: TestSite, sha256: string, blockedAt: Date | null = null) {
    await prisma.customCodeBlob.create({ data: { siteId: site.siteId, sha256, document: `render("${sha256}")`, declaration: DECLARATION as never, title: 'Team', createdBy: OWNER, blockedAt } });
  }
  async function eraseLine(site: TestSite, to: string, from: string) {
    await prisma.customCodeAudit.create({ data: { siteId: site.siteId, ...site.scope, actor: OWNER, action: 'blob-erase', sha256: to, detail: { replaces: from } } });
  }
  const blockedAt = async (site: TestSite, sha256: string) =>
    (await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: site.siteId, sha256 } }, select: { blockedAt: true } }))?.blockedAt ?? null;

  it('a block changes only the hash it names, and the report names the rewritten row, unblocked', async () => {
    const h = await blob(a, `render("abusive ${randomUUID()}")`);
    const x = hex();
    await eraseLine(a, x, h);
    await row(a, x);
    expect(await blockCustomCodeHash(h, OPERATOR)).toEqual({ sha256: h, listChanged: true, sites: [a.siteId] });
    expect(await blockedAt(a, x)).toBeNull();
    expect(await readRewrittenRows(h)).toEqual({ rows: [{ siteId: a.siteId, sha256: x, blocked: false }], truncated: false });
    // The operator judges it and blocks it by its own hash.
    await blockCustomCodeHash(x, OPERATOR);
    expect(await readRewrittenRows(h)).toEqual({ rows: [{ siteId: a.siteId, sha256: x, blocked: true }], truncated: false });
  });

  it('an unblock leaves an erase-carried block in place and names it; unblocking that hash then clears it', async () => {
    const h = await blob(b, `render("mistake ${randomUUID()}")`);
    const x = hex();
    await blockCustomCodeHash(h, OPERATOR);
    // Site A held H blocked and erased it into X, which the erase blocked too.
    await eraseLine(a, x, h);
    await row(a, x, new Date());
    await unblockCustomCodeHash(h, OPERATOR);
    expect(await blockedAt(a, x)).not.toBeNull();
    expect(await readRewrittenRows(h)).toEqual({ rows: [{ siteId: a.siteId, sha256: x, blocked: true }], truncated: false });
    expect((await unblockCustomCodeHash(x, OPERATOR)).sites).toEqual([a.siteId]);
    expect(await blockedAt(a, x)).toBeNull();
  });

  it('the block lands whatever erase lines exist, and the report skips title-only erases and says when it stops', async () => {
    const h = await blob(a, `render("abusive ${randomUUID()}")`);
    await prisma.customCodeAudit.createMany({
      data: [
        ...Array.from({ length: 300 }, () => ({ siteId: a.siteId, ...a.scope, actor: OWNER, action: 'blob-erase', sha256: h, detail: { replaces: h } })),
        ...Array.from({ length: REWRITTEN_REPORT_MAX + 1 }, () => ({ siteId: a.siteId, ...a.scope, actor: OWNER, action: 'blob-erase', sha256: hex(), detail: { replaces: h } })),
      ],
    });
    expect(await blockCustomCodeHash(h, OPERATOR)).toEqual({ sha256: h, listChanged: true, sites: [a.siteId] });
    expect((await live(a, [h])).has(h)).toBe(false);
    // The rewritten hashes hold no rows here, so the report names none, and says it did not read every line.
    expect(await readRewrittenRows(h)).toEqual({ rows: [], truncated: true });
  });

  it('the report reaches only the site where the erase happened', async () => {
    const h = await blob(a, `render("shared ${randomUUID()}")`);
    const [x, other] = [hex(), hex()];
    await eraseLine(a, x, h);
    await row(a, x);
    // Site B holds X too and erased it into its own row: B never held H, so nothing of B is named.
    await row(b, x);
    await eraseLine(b, other, x);
    await row(b, other);
    expect(await readRewrittenRows(h)).toEqual({ rows: [{ siteId: a.siteId, sha256: x, blocked: false }], truncated: false });
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
// ci-replay touch
