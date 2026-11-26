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

  it('does not count code a kept revision already names as new', async () => {
    await repo.publishProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c')]));
    await repo.saveProject(SCOPE, project(SITE_ID, [big('a')]));
    // Bringing b and c back adds nothing the revision did not already keep alive.
    await expect(repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c')]))).resolves.toBeDefined();
  });

  it('refuses a branch save that brings code to life past the budget, and not one naming code main already names', async () => {
    await repo.saveProject(SCOPE, project(SITE_ID, [big('a'), big('b'), big('c')]));
    await expect(repo.saveProject(SCOPE, project(BRANCH_ID, [big('a'), big('b'), big('c')]))).resolves.toBeDefined();
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
