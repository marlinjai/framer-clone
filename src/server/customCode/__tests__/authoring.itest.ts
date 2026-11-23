// src/server/customCode/__tests__/authoring.itest.ts
//
// Writing a custom code block against a REAL Postgres (the C1b migration applied by the
// integration globalSetup): plan docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4,
// decisions D100 to D108. Through the four paths of the stateful flow standard:
//
//   forward      a block saved on its stored page is written with its audit line;
//   backtrack    changed code and a changed declaration are new hashes, the same code is not a new write;
//   resume       what was written reads back for the panel, keyed by the site;
//   re-entry     a site switched off and on, a hash taken down, the hourly limit after an hour.
//
// And the refusals the route passes on, each with its reason: a branch, another workspace, a node
// the stored copy does not hold, an element that is not a block, a declaration naming a value
// that is not in reach or is text, the hourly limit, the site budget, and two writes at once.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites';
import { customCodeHash, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { checkCustomCodeInput, CUSTOM_CODE_WRITES_PER_HOUR, type CheckedCustomCode } from '@/lib/customCode/authoring';
import { readCustomCodeBlob, readCustomCodeStatus, writeCustomCodeBlob, type CustomCodeWriteInput } from '../authoring';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';

const SCOPE: TenantScope = {
  workspaceId: `ws_cc_author_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000c4c01',
};
const OTHER_SCOPE: TenantScope = { workspaceId: `ws_cc_other_${randomUUID().slice(0, 8)}`, tenantGroupId: SCOPE.tenantGroupId };
const SITE_ID = randomUUID();
const OTHER_SITE_ID = randomUUID();
const BRANCH_ID = randomUUID();
const ACTOR = 'user_cc_author';

let prisma: PrismaClient;

const STATES = [
  { id: 'open', name: 'Open', type: 'boolean', initial: false },
  { id: 'step', name: 'Step', type: 'number', initial: 0, min: 0, max: 9 },
  { id: 'label', name: 'Label', type: 'text', initial: '' },
];

function project(id: string, blockProps: Record<string, unknown> = { customCode: null }) {
  return {
    id,
    metadata: { title: 'Custom code site', description: '', createdAt: 1, updatedAt: 2 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home' },
        appComponentTree: {
          id: 'root-home',
          type: 'div',
          componentType: 'host',
          props: { behaviour: { state: STATES } },
          children: [
            { id: 'block', type: 'div', componentType: 'host', props: blockProps, children: [
              { id: 'fallback', type: 'p', componentType: 'host', props: { children: 'Fallback' }, children: [] },
            ] },
            { id: 'plain', type: 'div', componentType: 'host', props: {}, children: [] },
          ],
        },
        canvasNodes: {},
      },
    },
  } as never;
}

const DECLARATION: CustomCodeDeclaration = { reads: ['open'], writes: ['step'], emits: ['custom:done'], sizing: 'fixed', interactive: true };

function code(document = '<p>hello</p>', declaration: unknown = DECLARATION, title = 'Greeting'): CheckedCustomCode {
  const checked = checkCustomCodeInput({ title, document, declaration });
  if (!checked.ok) throw new Error(checked.refusal.message);
  return checked.value;
}

function input(overrides: Partial<CustomCodeWriteInput> = {}): CustomCodeWriteInput {
  return { siteId: SITE_ID, ...SCOPE, actor: ACTOR, pageId: 'home', nodeId: 'block', code: code(), ...overrides };
}

async function expectRefusal(result: Awaited<ReturnType<typeof writeCustomCodeBlob>>, code: string, status: number) {
  expect(result.ok).toBe(false);
  if (result.ok || 'notFound' in result) throw new Error(`expected the refusal ${code}`);
  expect(result.refusal.code).toBe(code);
  expect(result.refusal.status).toBe(status);
  expect(result.refusal.message.length).toBeGreaterThan(20);
}

const audits = () => prisma.customCodeAudit.findMany({ where: { siteId: SITE_ID }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  prisma = getPrismaClient();
  const repo = latestVersionRepository();
  await repo.saveProject(SCOPE, project(SITE_ID));
  await repo.saveProject(OTHER_SCOPE, project(OTHER_SITE_ID));
  await prisma.site.updateMany({ where: { id: { in: [SITE_ID, OTHER_SITE_ID] } }, data: { customCodeEnabled: true } });
  const now = new Date();
  await prisma.site.create({
    data: {
      id: BRANCH_ID, ...SCOPE, name: 'Branch', branchOfSiteId: SITE_ID, customCodeEnabled: true,
      projectCreatedAt: now, projectUpdatedAt: now,
    },
  });
});

beforeEach(async () => {
  await prisma.customCodeAudit.deleteMany({ where: { siteId: { in: [SITE_ID, OTHER_SITE_ID, BRANCH_ID] } } });
  await prisma.customCodeBlob.deleteMany({ where: { siteId: { in: [SITE_ID, OTHER_SITE_ID, BRANCH_ID] } } });
  await prisma.siteRevision.deleteMany({ where: { siteId: SITE_ID } });
  await prisma.site.updateMany({ where: { id: { in: [SITE_ID, OTHER_SITE_ID] } }, data: { customCodeEnabled: true } });
});

afterAll(async () => {
  await prisma.customCodeAudit.deleteMany({ where: { siteId: { in: [SITE_ID, OTHER_SITE_ID, BRANCH_ID] } } });
  await prisma.customCodeBlockedHash.deleteMany({ where: { reason: 'authoring itest' } });
  await prisma.site.deleteMany({ where: { id: { in: [BRANCH_ID, SITE_ID, OTHER_SITE_ID] } } });
  await prisma.$disconnect();
});

describe('forward: a block saved on its page is written', () => {
  it('stores the blob with its canonical declaration and one audit line holding no code', async () => {
    const result = await writeCustomCodeBlob(input());
    expect(result).toEqual({ ok: true, sha256: await customCodeHash('<p>hello</p>', DECLARATION), created: true });
    if (!result.ok) return;
    const row = await prisma.customCodeBlob.findUnique({ where: { siteId_sha256: { siteId: SITE_ID, sha256: result.sha256 } } });
    expect(row).toMatchObject({ document: '<p>hello</p>', title: 'Greeting', createdBy: ACTOR, blockedAt: null });
    expect(row?.declaration).toEqual({ emits: ['custom:done'], interactive: true, reads: ['open'], sizing: 'fixed', writes: ['step'] });
    const lines = await audits();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'blob-write', actor: ACTOR, sha256: result.sha256, workspaceId: SCOPE.workspaceId, tenantGroupId: SCOPE.tenantGroupId });
    expect(lines[0].detail).toEqual({ pageId: 'home', nodeId: 'block', bytes: code().bytes });
    expect(JSON.stringify(lines[0])).not.toContain('hello');
  });

  it('reads back for the panel, and the status counts nothing no save names yet', async () => {
    const result = await writeCustomCodeBlob(input());
    if (!result.ok) throw new Error('not written');
    const blob = await readCustomCodeBlob({ siteId: SITE_ID, workspaceId: SCOPE.workspaceId }, result.sha256);
    expect(blob).toMatchObject({ sha256: result.sha256, document: '<p>hello</p>', title: 'Greeting', declaration: DECLARATION, blocked: false });
    expect(await readCustomCodeStatus({ siteId: SITE_ID, ...SCOPE })).toEqual({ enabled: true, branch: false, usedBytes: 0 });
  });
});

describe('backtrack and revise: the hash follows code and declaration', () => {
  it('a changed declaration with the same code is a new hash, stored beside the first', async () => {
    const first = await writeCustomCodeBlob(input());
    const second = await writeCustomCodeBlob(input({ code: code('<p>hello</p>', { ...DECLARATION, interactive: false }) }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.created).toBe(true);
    expect(await prisma.customCodeBlob.count({ where: { siteId: SITE_ID } })).toBe(2);
  });

  it('changed code is a new hash', async () => {
    const first = await writeCustomCodeBlob(input());
    const second = await writeCustomCodeBlob(input({ code: code('<p>hello again</p>') }));
    if (!first.ok || !second.ok) throw new Error('not written');
    expect(second.sha256).not.toBe(first.sha256);
  });

  it('the same code again writes nothing, keeps the first title and adds no audit line', async () => {
    const first = await writeCustomCodeBlob(input());
    const again = await writeCustomCodeBlob(input({ code: code('<p>hello</p>', DECLARATION, 'Another title') }));
    if (!first.ok || !again.ok) throw new Error('not written');
    expect(again).toEqual({ ok: true, sha256: first.sha256, created: false });
    expect((await prisma.customCodeBlob.findFirst({ where: { siteId: SITE_ID } }))?.title).toBe('Greeting');
    expect(await audits()).toHaveLength(1);
  });

  it('the same declaration in another order is the same hash', async () => {
    const first = await writeCustomCodeBlob(input({ code: code('<p>x</p>', { ...DECLARATION, reads: ['open', 'open'] }) }));
    const second = await writeCustomCodeBlob(input({ code: code('<p>x</p>', { interactive: true, sizing: 'fixed', emits: ['custom:done'], writes: ['step'], reads: ['open'] }) }));
    if (!first.ok || !second.ok) throw new Error('not written');
    expect(second).toEqual({ ok: true, sha256: first.sha256, created: false });
  });
});

describe('the declaration against the stored working copy', () => {
  it('refuses a read of a value that does not stand above the block, naming it', async () => {
    const result = await writeCustomCodeBlob(input({ code: code('<p>x</p>', { ...DECLARATION, reads: ['gone'] }) }));
    await expectRefusal(result, 'declaration_state', 422);
    if (!result.ok && 'refusal' in result) expect(result.refusal.message).toContain('gone');
    expect(await prisma.customCodeBlob.count({ where: { siteId: SITE_ID } })).toBe(0);
  });

  it('refuses a write of a text value, naming it', async () => {
    const result = await writeCustomCodeBlob(input({ code: code('<p>x</p>', { ...DECLARATION, writes: ['label'] }) }));
    await expectRefusal(result, 'declaration_state', 422);
    if (!result.ok && 'refusal' in result) expect(result.refusal.message).toContain('Label');
  });

  it('refuses a node the stored page does not hold, and an element that is not a block', async () => {
    await expectRefusal(await writeCustomCodeBlob(input({ nodeId: 'not-saved-yet' })), 'node_not_saved', 409);
    await expectRefusal(await writeCustomCodeBlob(input({ pageId: 'no-such-page' })), 'node_not_saved', 409);
    await expectRefusal(await writeCustomCodeBlob(input({ nodeId: 'plain' })), 'not_a_block', 409);
    expect(await audits()).toHaveLength(0);
  });
});

describe('re-entry: switched off, taken down, and another site or workspace', () => {
  it('refuses while the site is off and writes once it is on again', async () => {
    await prisma.site.update({ where: { id: SITE_ID }, data: { customCodeEnabled: false } });
    await expectRefusal(await writeCustomCodeBlob(input()), 'custom_code_off', 409);
    expect(await readCustomCodeStatus({ siteId: SITE_ID, ...SCOPE })).toMatchObject({ enabled: false });
    await prisma.site.update({ where: { id: SITE_ID }, data: { customCodeEnabled: true } });
    expect(await writeCustomCodeBlob(input())).toMatchObject({ ok: true, created: true });
  });

  it('refuses a hash on the takedown list, and one blocked on any other site', async () => {
    const listed = await customCodeHash('<p>listed</p>', DECLARATION);
    await prisma.customCodeBlockedHash.create({ data: { sha256: listed, blockedBy: 'operator', reason: 'authoring itest' } });
    await expectRefusal(await writeCustomCodeBlob(input({ code: code('<p>listed</p>') })), 'blocked', 410);

    const elsewhere = await writeCustomCodeBlob(input({ siteId: OTHER_SITE_ID, ...OTHER_SCOPE, code: code('<p>elsewhere</p>') }));
    if (!elsewhere.ok) throw new Error('not written');
    await prisma.customCodeBlob.update({ where: { siteId_sha256: { siteId: OTHER_SITE_ID, sha256: elsewhere.sha256 } }, data: { blockedAt: new Date() } });
    await expectRefusal(await writeCustomCodeBlob(input({ code: code('<p>elsewhere</p>') })), 'blocked', 410);
    const blob = await readCustomCodeBlob({ siteId: OTHER_SITE_ID, workspaceId: OTHER_SCOPE.workspaceId }, elsewhere.sha256);
    expect(blob?.blocked).toBe(true);
  });

  it('refuses a branch, even one whose switch is on', async () => {
    await expectRefusal(await writeCustomCodeBlob(input({ siteId: BRANCH_ID })), 'branch_site', 409);
    expect(await readCustomCodeStatus({ siteId: BRANCH_ID, ...SCOPE })).toMatchObject({ branch: true });
  });

  it('finds nothing under another workspace, and reads no blob of another site', async () => {
    expect(await writeCustomCodeBlob(input({ ...OTHER_SCOPE }))).toEqual({ ok: false, notFound: true });
    const mine = await writeCustomCodeBlob(input());
    if (!mine.ok) throw new Error('not written');
    expect(await readCustomCodeBlob({ siteId: OTHER_SITE_ID, workspaceId: OTHER_SCOPE.workspaceId }, mine.sha256)).toBeNull();
    expect(await readCustomCodeBlob({ siteId: SITE_ID, workspaceId: OTHER_SCOPE.workspaceId }, mine.sha256)).toBeNull();
    expect(await readCustomCodeStatus({ siteId: SITE_ID, ...OTHER_SCOPE })).toBeNull();
  });
});

describe('the hourly limit', () => {
  async function seedWrites(count: number, at: Date) {
    await prisma.customCodeAudit.createMany({
      data: Array.from({ length: count }, () => ({ siteId: SITE_ID, ...SCOPE, actor: ACTOR, action: 'blob-write', createdAt: at })),
    });
  }

  it('refuses the 31st write of the hour with the seconds to wait, and counts only the last hour', async () => {
    const now = new Date('2026-11-23T12:00:00Z');
    await seedWrites(CUSTOM_CODE_WRITES_PER_HOUR, new Date(now.getTime() - 10 * 60 * 1000));
    const refused = await writeCustomCodeBlob(input(), undefined, () => now);
    await expectRefusal(refused, 'rate_limited', 429);
    if (!refused.ok && 'refusal' in refused) expect(refused.refusal.retryAfterSeconds).toBe(50 * 60);
    // An hour after those writes, the next one goes through.
    const later = new Date(now.getTime() + 51 * 60 * 1000);
    expect(await writeCustomCodeBlob(input(), undefined, () => later)).toMatchObject({ ok: true, created: true });
  });

  it('answers a write of code the site already holds even at the limit: it is not a new write (D105)', async () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const first = await writeCustomCodeBlob(input(), undefined, () => new Date(now.getTime() - 20 * 60 * 1000));
    expect(first).toMatchObject({ ok: true, created: true });
    await seedWrites(CUSTOM_CODE_WRITES_PER_HOUR, new Date(now.getTime() - 10 * 60 * 1000));
    const again = await writeCustomCodeBlob(input(), undefined, () => now);
    expect(again).toMatchObject({ ok: true, created: false });
  });

  it('serialises two writes at once: with room for one, exactly one is written', async () => {
    const now = new Date();
    await seedWrites(CUSTOM_CODE_WRITES_PER_HOUR - 1, new Date(now.getTime() - 60 * 1000));
    const results = await Promise.all([
      writeCustomCodeBlob(input({ code: code('<p>one</p>') })),
      writeCustomCodeBlob(input({ code: code('<p>two</p>') })),
    ]);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    if (!refused || refused.ok || 'notFound' in refused) throw new Error('expected one refusal');
    expect(refused.refusal.code).toBe('rate_limited');
    expect(await prisma.customCodeBlob.count({ where: { siteId: SITE_ID } })).toBe(1);
  });

  it('two identical writes at once store one row and one audit line', async () => {
    const results = await Promise.all([writeCustomCodeBlob(input()), writeCustomCodeBlob(input())]);
    expect(results.map((r) => r.ok && r.created).sort()).toEqual([false, true]);
    expect(await prisma.customCodeBlob.count({ where: { siteId: SITE_ID } })).toBe(1);
    expect(await audits()).toHaveLength(1);
  });
});

describe('the site budget (live code: named by the working copy or a kept revision)', () => {
  const big = (fill: string) => `<script>/*${fill.repeat(250 * 1024)}*/</script>`;

  async function storeNamed(fills: string[]): Promise<string[]> {
    const hashes: string[] = [];
    for (const fill of fills) {
      const document = big(fill);
      const sha256 = await customCodeHash(document, DECLARATION);
      await prisma.customCodeBlob.create({ data: { siteId: SITE_ID, sha256, document, declaration: DECLARATION as never, title: fill, createdBy: ACTOR } });
      hashes.push(sha256);
    }
    return hashes;
  }

  async function nameInRevision(hashes: string[]) {
    await prisma.siteRevision.create({
      data: {
        siteId: SITE_ID, ...SCOPE, number: 1,
        document: { pages: { home: { appComponentTree: { id: 'r', children: hashes.map((sha256, i) => ({ id: `b${i}`, props: { customCode: { sha256, title: 'x' } } })) } } } },
      },
    });
  }

  it('refuses a block that would take the site past 1 MB, saying what is used', async () => {
    const hashes = await storeNamed(['a', 'b', 'c', 'd']);
    await nameInRevision(hashes);
    const status = await readCustomCodeStatus({ siteId: SITE_ID, ...SCOPE });
    expect(status?.usedBytes).toBeGreaterThan(1000 * 1024);
    const refused = await writeCustomCodeBlob(input({ code: code('<p>one more</p>'.repeat(2000)) }));
    await expectRefusal(refused, 'site_budget', 413);
    if (!refused.ok && 'refusal' in refused) expect(refused.refusal.message).toMatch(/MB/);
  });

  it('counts no blob that nothing names, and no blocked one', async () => {
    const [unnamed, blocked] = await storeNamed(['e', 'f']);
    await nameInRevision([blocked]);
    await prisma.customCodeBlob.update({ where: { siteId_sha256: { siteId: SITE_ID, sha256: blocked } }, data: { blockedAt: new Date() } });
    void unnamed;
    expect(await readCustomCodeStatus({ siteId: SITE_ID, ...SCOPE })).toMatchObject({ usedBytes: 0 });
  });

  it('leaves out the block being replaced unless a kept revision names it', async () => {
    const hashes = await storeNamed(['g', 'h', 'i', 'j']);
    // Three named by a revision, the fourth only by the working copy.
    await nameInRevision(hashes.slice(0, 3));
    await latestVersionRepository().saveProject(SCOPE, project(SITE_ID, { customCode: { sha256: hashes[3], title: 'Greeting' } }));
    try {
      const addition = code('<p>replacement</p>'.repeat(5000));
      await expectRefusal(await writeCustomCodeBlob(input({ code: addition })), 'site_budget', 413);
      // Replacing the working copy's block frees its share.
      expect(await writeCustomCodeBlob(input({ code: addition, replaces: hashes[3] }))).toMatchObject({ ok: true, created: true });
      // Replacing a block a kept revision names frees nothing.
      await expectRefusal(await writeCustomCodeBlob(input({ code: code('<p>other</p>'.repeat(5000)), replaces: hashes[0] })), 'site_budget', 413);
    } finally {
      await latestVersionRepository().saveProject(SCOPE, project(SITE_ID));
    }
  });
});
