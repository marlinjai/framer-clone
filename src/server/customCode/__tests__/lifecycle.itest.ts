// src/server/customCode/__tests__/lifecycle.itest.ts
//
// The life of a custom code blob against a REAL Postgres (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// slice C5, D4 and D113 to D115): what keeps a blob, when an unnamed one is pruned, and the site budget at save
// and publish. Through the four paths of the stateful flow standard:
//
//   forward      a save that names a block keeps its blob; a site without code pays nothing and is never refused;
//   backtrack    a save that removes a block leaves its blob for a week, then the next change of names prunes it;
//                a save that names code past the budget is refused and writes nothing, and removing a block saves;
//   resume       what a kept revision, a branch or a branch record's copy names survives every prune;
//   re-entry     a blocked blob is never pruned and stays blocked; a rollback to a revision whose blob was
//                blocked shows that block's fallback.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import { CustomCodeBudgetError, type TenantScope } from '@/server/sites';
import { checkCustomCodeInput } from '@/lib/customCode/authoring';
import { writeCustomCodeBlob } from '../authoring';
import { UNNAMED_BLOB_GRACE_MS } from '../named';
import { loadLiveCustomCode } from '../liveBlocks';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { SiteBranchMergeService } from '@/server/sites/branches/merge';

const SCOPE: TenantScope = {
  workspaceId: `ws_cc_life_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000c5c01',
};
const SITE_ID = randomUUID();
const PLAIN_SITE_ID = randomUUID();
const BRANCH_ID = randomUUID();
const BRANCH_RECORD_ID = randomUUID();
const ACTOR = 'user_cc_life';
const DECLARATION = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
const OLD = () => new Date(Date.now() - UNNAMED_BLOB_GRACE_MS - 60_000);

let prisma: PrismaClient;
const repo = latestVersionRepository();

/** A fake but well-shaped hash for a blob row written straight into the table. */
const hashOf = (label: string) => createHash('sha256').update(label).digest('hex');

function block(id: string, sha256: string | null) {
  return { id, type: 'div', componentType: 'host', props: { customCode: sha256 ? { sha256, title: id } : null }, children: [] };
}

/** A site whose home page holds one block per hash, and a paragraph whose text changes freely. */
function project(id: string, hashes: (string | null)[], text = 'Hello') {
  return {
    id,
    metadata: { title: 'Lifecycle site', description: '', createdAt: 1, updatedAt: 2 },
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

async function blob(sha256: string, options: { bytes?: number; createdAt?: Date; blockedAt?: Date; siteId?: string } = {}) {
  await prisma.customCodeBlob.create({
    data: {
      siteId: options.siteId ?? SITE_ID,
      sha256,
      document: 'x'.repeat(options.bytes ?? 100),
      declaration: DECLARATION,
      title: 'Block',
      createdBy: ACTOR,
      createdAt: options.createdAt ?? new Date(),
      blockedAt: options.blockedAt ?? null,
    },
  });
}

const stored = async (siteId = SITE_ID) =>
  (await prisma.customCodeBlob.findMany({ where: { siteId }, select: { sha256: true } })).map((row) => row.sha256).sort();
const version = async (siteId = SITE_ID) => (await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version;

beforeAll(async () => {
  prisma = getPrismaClient();
  await repo.saveProject(SCOPE, project(SITE_ID, []));
  await repo.saveProject(SCOPE, project(PLAIN_SITE_ID, []));
  await prisma.site.updateMany({ where: { id: SITE_ID }, data: { customCodeEnabled: true } });
  const now = new Date();
  await prisma.site.create({
    data: { id: BRANCH_ID, ...SCOPE, name: 'Branch', branchOfSiteId: SITE_ID, projectCreatedAt: now, projectUpdatedAt: now },
  });
});

beforeEach(async () => {
  await prisma.siteBranch.deleteMany({ where: { siteId: SITE_ID } });
  await prisma.customCodeAudit.deleteMany({ where: { siteId: SITE_ID } });
  await prisma.customCodeBlob.deleteMany({ where: { siteId: { in: [SITE_ID, PLAIN_SITE_ID] } } });
  // The site's pointer first: it holds the live revision by a foreign key.
  await prisma.site.updateMany({ where: { id: SITE_ID }, data: { publishedRevisionId: null, status: 'draft' } });
  await prisma.siteRevision.deleteMany({ where: { siteId: SITE_ID } });
  await repo.saveProject(SCOPE, project(SITE_ID, []));
  await repo.saveProject(SCOPE, project(BRANCH_ID, []));
});

afterAll(async () => {
  await prisma.customCodeAudit.deleteMany({ where: { siteId: SITE_ID } });
  await prisma.site.deleteMany({ where: { id: { in: [BRANCH_ID, SITE_ID, PLAIN_SITE_ID] } } });
  await prisma.$disconnect();
});

describe('forward: what a save names is kept', () => {
  it('keeps a blob the working copy names, however old', async () => {
    const named = hashOf('named');
    await blob(named, { createdAt: OLD() });
    await repo.saveProject(SCOPE, project(SITE_ID, [named]));
    await repo.saveProject(SCOPE, project(SITE_ID, [named, null]));
    expect(await stored()).toEqual([named]);
  });

  it('saves a site that stores no code without refusing anything, whatever its pages name', async () => {
    // Hashes this site does not store are fallbacks: they hold no code and count for nothing.
    const before = await version(PLAIN_SITE_ID);
    await repo.saveProject(SCOPE, project(PLAIN_SITE_ID, [hashOf('a'), hashOf('b'), hashOf('c')]));
    expect(await version(PLAIN_SITE_ID)).toBe(before + 1);
  });
});

describe('backtrack: an unnamed blob waits a week, then goes', () => {
  it('prunes an unnamed blob older than a week when a save changes the names, and keeps a younger one', async () => {
    const kept = hashOf('kept');
    const old = hashOf('old');
    const young = hashOf('young');
    await blob(kept);
    await blob(old, { createdAt: OLD() });
    await blob(young);
    await repo.saveProject(SCOPE, project(SITE_ID, [kept]));
    expect(await stored()).toEqual([kept, young].sort());
  });

  it('leaves blobs alone on a save that changes no names, however old the unnamed ones are', async () => {
    const old = hashOf('old-untouched');
    await blob(old, { createdAt: OLD() });
    await repo.saveProject(SCOPE, project(SITE_ID, [], 'Edited text'));
    expect(await stored()).toEqual([old]);
  });

  it('prunes at publish, after the revisions are pruned', async () => {
    const old = hashOf('old-at-publish');
    await blob(old, { createdAt: OLD() });
    await repo.publishProject(SCOPE, project(SITE_ID, [], 'Published'));
    expect(await stored()).toEqual([]);
  });

  it('prunes at a code write, so a site that writes and never saves cannot pile blobs up', async () => {
    // The guarded write needs a saved block to name; its own new blob is young and stays.
    await repo.saveProject(SCOPE, project(SITE_ID, [null]));
    const old = hashOf('old-at-write');
    await blob(old, { createdAt: OLD() });
    const checked = checkCustomCodeInput({ title: 'Block', document: '<p>new</p>', declaration: DECLARATION });
    if (!checked.ok) throw new Error(checked.refusal.message);
    const result = await writeCustomCodeBlob({ siteId: SITE_ID, ...SCOPE, actor: ACTOR, pageId: 'home', nodeId: 'block-0', code: checked.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await stored()).toEqual([result.sha256]);
  });
});

describe('backtrack: the site budget at save and publish (D114)', () => {
  const big = (label: string) => hashOf(`big-${label}`);
  // Four blobs of 300 KB: any three fit in the 1 MB budget, all four do not.
  beforeEach(async () => {
    for (const label of ['a', 'b', 'c', 'd']) await blob(big(label), { bytes: 300 * 1024 });
  });

  it('refuses a save that names code past the budget, with the reason, and writes nothing', async () => {
    await repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c')]));
    const before = await version();
    const refused = repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c'), big('d')]));
    await expect(refused).rejects.toBeInstanceOf(CustomCodeBudgetError);
    await expect(refused).rejects.toMatchObject({ code: 'custom_code_budget', status: 400 });
    await refused.catch((error: Error) => expect(error.message).toMatch(/Remove a custom code block, or make one smaller/));
    expect(await version()).toBe(before);
  });

  it('refuses a publish that names code past the budget, and publishes nothing', async () => {
    await repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c')]));
    await expect(repo.publishProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c'), big('d')]))).rejects.toBeInstanceOf(CustomCodeBudgetError);
    expect(await prisma.siteRevision.count({ where: { siteId: SITE_ID } })).toBe(0);
  });

  it('saves a site already over the budget when the save adds no code: a text edit, and removing a block', async () => {
    // Over the budget by a route the save check does not see (rows written straight into the table).
    await prisma.$executeRaw`UPDATE public.site_pages SET snapshot = jsonb_set(snapshot, '{appComponentTree,children}', ${JSON.stringify([
      block('block-0', big('a')), block('block-1', big('b')), block('block-2', big('c')), block('block-3', big('d')),
    ])}::jsonb) WHERE site_id = ${SITE_ID}`;
    const all = [big('a'), big('b'), big('c'), big('d')];
    await expect(repo.saveProject(SCOPE, project(SITE_ID, all, 'Only text changed'))).resolves.toBeDefined();
    await expect(repo.saveProject(SCOPE, project(SITE_ID, all.slice(0, 3)))).resolves.toBeDefined();
  });

  /** Puts a working copy's blocks straight into its page row, past the save check: a site over the budget. */
  async function nameRaw(siteId: string, labels: string[]) {
    await prisma.$executeRaw`UPDATE public.site_pages SET snapshot = jsonb_set(snapshot, '{appComponentTree,children}', ${JSON.stringify(
      labels.map((label, index) => block(`block-${index}`, big(label))),
    )}::jsonb) WHERE site_id = ${siteId}`;
  }

  it('does not count code a kept revision already names as new, also on a site over the budget', async () => {
    await repo.publishProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c')]));
    // The working copy names a and d: with the revision's b and c, the site holds all four, past the budget.
    await nameRaw(SITE_ID, ['a', 'd']);
    // Bringing b and c back adds nothing the revision did not already keep alive.
    await expect(repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c'), big('d')]))).resolves.toBeDefined();
  });

  it('refuses a branch save that brings code to life past the budget, and not one naming code main already names', async () => {
    await repo.saveProject(SCOPE, project(BRANCH_ID, []));
    // Main names all four, past the budget: a branch copying them brings nothing to life.
    await nameRaw(SITE_ID, ['a', 'b', 'c', 'd']);
    await expect(repo.saveProject(SCOPE, project(BRANCH_ID, [big('a'), big('b'), big('c'), big('d')]))).resolves.toBeDefined();
    // Under the budget, a branch bringing code to life past it is refused.
    await nameRaw(SITE_ID, ['a', 'b', 'c']);
    await repo.saveProject(SCOPE, project(BRANCH_ID, [big('a'), big('b'), big('c')]));
    await expect(repo.saveProject(SCOPE, project(BRANCH_ID, [big('a'), big('b'), big('c'), big('d')]))).rejects.toBeInstanceOf(CustomCodeBudgetError);
  });
});

describe('resume: what a revision, a branch or a branch record names survives', () => {
  it('keeps a blob a kept revision names after the working copy dropped it', async () => {
    const released = hashOf('released');
    await blob(released, { createdAt: OLD() });
    await repo.publishProject(SCOPE, project(SITE_ID, [released]));
    await repo.saveProject(SCOPE, project(SITE_ID, []));
    await repo.publishProject(SCOPE, project(SITE_ID, [], 'Second'));
    expect(await stored()).toEqual([released]);
  });

  it("keeps a blob a branch's working copy names after main dropped it", async () => {
    const onBranch = hashOf('on-branch');
    await blob(onBranch, { createdAt: OLD() });
    await repo.saveProject(SCOPE, project(SITE_ID, [onBranch]));
    await repo.saveProject(SCOPE, project(BRANCH_ID, [onBranch]));
    await repo.saveProject(SCOPE, project(SITE_ID, []));
    expect(await stored()).toEqual([onBranch]);
  });

  it('keeps a blob only the copy for "Undo this merge" names', async () => {
    const beforeMerge = hashOf('before-merge');
    await blob(beforeMerge, { createdAt: OLD() });
    await repo.saveProject(SCOPE, project(SITE_ID, [beforeMerge]));
    await prisma.siteBranch.create({
      data: {
        id: BRANCH_RECORD_ID, siteId: SITE_ID, ...SCOPE, name: 'Merged', status: 'merged', createdByKind: 'user', createdBy: ACTOR,
        mainBeforeDocument: { pages: [{ snapshot: { appComponentTree: block('kept', beforeMerge) } }] },
      },
    });
    await repo.saveProject(SCOPE, project(SITE_ID, []));
    expect(await stored()).toEqual([beforeMerge]);
  });
});

describe('re-entry: a blocked blob', () => {
  it('is never pruned, so the same code stays refused', async () => {
    const takenDown = hashOf('taken-down');
    await blob(takenDown, { createdAt: OLD(), blockedAt: new Date() });
    await repo.saveProject(SCOPE, project(SITE_ID, [null]));
    await repo.publishProject(SCOPE, project(SITE_ID, [], 'Published'));
    expect(await stored()).toEqual([takenDown]);
  });

  it('shows the fallback after a rollback to a revision that names it', async () => {
    const shown = hashOf('shown');
    const later = hashOf('later');
    await blob(shown);
    await blob(later);
    await repo.publishProject(SCOPE, project(SITE_ID, [shown]));
    await repo.publishProject(SCOPE, project(SITE_ID, [later]));
    await prisma.customCodeBlob.update({ where: { siteId_sha256: { siteId: SITE_ID, sha256: shown } }, data: { blockedAt: new Date() } });
    await repo.rollbackToRevision(SCOPE, SITE_ID, 1);
    const env = { CUSTOM_CODE_DISABLED: '0', SANDBOX_ORIGIN: 'https://run.example.test' };
    const live = await loadLiveCustomCode({ siteId: SITE_ID, preview: false, hashes: [shown] }, env);
    expect(live?.blobs.has(shown)).toBe(false);
    // The blob row is still there (blocked), and the revision still names it: only its block falls back.
    expect(await stored()).toEqual([later, shown].sort());
  });
});

describe('review of part 1: the edges of pruning and the budget', () => {
  const big = (label: string) => hashOf(`edge-${label}`);

  it('prunes when a save only removes a block', async () => {
    const dropped = hashOf('dropped');
    const kept = hashOf('kept-on-removal');
    await blob(dropped, { createdAt: OLD() });
    await blob(kept, { createdAt: OLD() });
    await repo.saveProject(SCOPE, project(SITE_ID, [dropped, kept]));
    await repo.saveProject(SCOPE, project(SITE_ID, [kept]));
    expect(await stored()).toEqual([kept]);
  });

  it('keeps an unnamed blob a minute short of the week', async () => {
    const almost = hashOf('almost-a-week');
    await blob(almost, { createdAt: new Date(Date.now() - UNNAMED_BLOB_GRACE_MS + 60_000) });
    await repo.saveProject(SCOPE, project(SITE_ID, [hashOf('other-name')]));
    expect(await stored()).toEqual([almost]);
  });

  it('does not count a blocked blob against the budget at save', async () => {
    for (const label of ['a', 'b', 'c']) await blob(big(label), { bytes: 300 * 1024 });
    await blob(big('d'), { bytes: 300 * 1024, blockedAt: new Date() });
    // Four blocks of 300 KB, one of them taken down: 900 KB of live code, under the budget.
    await expect(repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c'), big('d')]))).resolves.toBeDefined();
  });

  /** Holds the main site's row in another transaction until released. */
  async function holdMain(mode: 'no key update' | 'share') {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const done = prisma.$transaction(
      async (tx) => {
        if (mode === 'share') await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${SITE_ID} FOR SHARE`;
        else await tx.$queryRaw`SELECT id FROM public.sites WHERE id = ${SITE_ID} FOR NO KEY UPDATE`;
        locked();
        await gate;
      },
      { timeout: 60_000 },
    );
    await ready;
    return { release, done };
  }

  async function waitsBehind(mode: 'no key update' | 'share', label: string) {
    const hold = await holdMain(mode);
    let settled = false;
    const withCode = repo.saveProject(SCOPE, project(BRANCH_ID, [hashOf(label)])).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const waited = !settled;
    hold.release();
    await Promise.all([hold.done, withCode]);
    return waited;
  }

  it('serialises a branch save that names code with the writers of its main site, and not one that names none', async () => {
    // Naming no code: it can only remove names, so it does not wait even for the guarded write's lock.
    const hold = await holdMain('no key update');
    await repo.saveProject(SCOPE, project(BRANCH_ID, [], 'no code'));
    hold.release();
    await hold.done;
    // Naming code: it waits for the guarded write's lock, and for a shared holder too, so two branch saves naming
    // code can never count the site's code at the same time.
    expect(await waitsBehind('no key update', 'branch-code-1')).toBe(true);
    expect(await waitsBehind('share', 'branch-code-2')).toBe(true);
  }, 60_000);

  it('merges a branch into main without a budget check: what the branch names is already alive', async () => {
    const mainId = randomUUID();
    await repo.saveProject(SCOPE, project(mainId, []));
    for (const label of ['a', 'b', 'c', 'd']) await blob(big(label), { bytes: 300 * 1024, siteId: mainId });
    await repo.saveProject(SCOPE, project(mainId, [big('a'), big('b'), big('c')]), { mustExist: true });
    const actor = { kind: 'user' as const, id: ACTOR };
    const { branch } = await new SiteBranchRepository(prisma).createBranch(SCOPE, mainId, { name: 'Over', actor });
    // The branch names all four, past the budget, by a route the save check does not see.
    await prisma.$executeRaw`UPDATE public.site_pages SET snapshot = jsonb_set(snapshot, '{appComponentTree,children}', ${JSON.stringify(
      ['a', 'b', 'c', 'd'].map((label, index) => block(`block-${index}`, big(label))),
    )}::jsonb) WHERE site_id = ${branch.branchId}`;
    const merges = new SiteBranchMergeService(prisma, repo);
    const first = await merges.changes(SCOPE, branch.branchId);
    await merges.approve(SCOPE, branch.branchId, { token: first.token }, actor).catch(() => undefined);
    const { token } = await merges.changes(SCOPE, branch.branchId);
    await expect(merges.merge(SCOPE, branch.branchId, { token }, actor)).resolves.toBeDefined();
    const home = await prisma.sitePage.findFirstOrThrow({ where: { siteId: mainId, pageId: 'home' }, select: { snapshot: true } });
    expect(JSON.stringify(home.snapshot)).toContain(big('d'));
    await prisma.siteBranch.deleteMany({ where: { siteId: mainId } });
    await prisma.site.deleteMany({ where: { OR: [{ id: mainId }, { branchOfSiteId: mainId }] } });
  }, 60_000);
});
