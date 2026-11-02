// src/server/siteOps/__tests__/siteOps.itest.ts
//
// The site operations against a REAL Postgres (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, build step 3): the whole
// chain an agent runs (create a site, insert, read back, update, publish, roll
// back) through the real repository, and an editor tab that loaded before the
// agent's write meeting a 409 from the real save route instead of overwriting it.
// Only the auth-brain client, Next's cache and the shop provisioning (which needs
// the owner database role) are mocked.
//
// The stateful-flow paths (knowledge-base standards, stateful-flow testing):
// forward (the chain), backtrack (an update on top of the insert keeps the rest),
// resume (every step starts from a fresh load of the stored version) and
// re-entry after a failure (a refused batch moves nothing, and the same version
// then writes).
//
// Runs only under `pnpm test:integration` (Docker Postgres).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const TENANT_GROUP = '018f9c10-0000-7000-8000-00000000a0c5';
const WORKSPACE = 'ws_site_ops';
const OTHER_WORKSPACE = 'ws_site_ops_other';
const SESSION = {
  user: { id: 'user-ops' },
  session: {},
  tenants: [{ id: 'tenant-ops', app_grants: ['sites'], group_id: TENANT_GROUP }],
  workspaces: [{ id: WORKSPACE, tenant_id: 'tenant-ops' }],
  active_tenant: { id: 'tenant-ops' },
  active_workspace: { id: WORKSPACE },
};

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) => (cookie === 'sess_ops' ? SESSION : null)),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/sites/companyCommerce', () => ({ ensureCompanyCommerce: vi.fn(async () => ({ ok: true })) }));

import { getSnapshot } from 'mobx-state-tree';
import { getPrismaClient } from '@/server/db';
import { SiteRepository } from '@/server/sites';
import type { SiteOpsCaller } from '@/lib/siteOps/types';
import { applyBatch, createSite, getPage, getSite, listRevisions, publish, rollback } from '..';
import { POST as SAVE } from '@/app/api/projects/save/route';

let prisma: PrismaClient;
let repository: SiteRepository;

const agent: SiteOpsCaller = {
  scope: { workspaceId: WORKSPACE, tenantGroupId: TENANT_GROUP },
  companyId: 'tenant-ops',
  actor: { kind: 'key', id: 'key_ops' },
  actorDetail: { serviceAccountId: 'sa_ops' },
  can: () => true,
};
const stranger: SiteOpsCaller = { ...agent, scope: { workspaceId: OTHER_WORKSPACE, tenantGroupId: TENANT_GROUP } };

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeAll(() => {
  prisma = getPrismaClient();
  repository = new SiteRepository(prisma);
});

afterAll(async () => {
  await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.siteDomain.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('site operations against a real database', () => {
  it('runs the full chain: create, insert, read back, update, publish, roll back, with an audit row per write', async () => {
    const deps = { repository, publicBaseHost: 'sites.test' };

    // Create.
    const created = unwrap(await createSite(agent, { name: 'Agent built' }, deps));
    expect(created.version).toBe(1);
    const { siteId, homePageId } = created;

    // Insert.
    const inserted = unwrap(
      await applyBatch(agent, {
        siteId,
        expectedVersion: 1,
        ops: [
          {
            op: 'insertNodes',
            pageId: homePageId,
            nodes: [
              { ref: 'hero', type: 'section', props: { style: { padding: { desktop: '96px', mobile: '32px' } } }, children: [
                { ref: 'headline', type: 'h1', props: { children: 'Bread, baked at four' } },
              ] },
            ],
          },
        ],
      }, deps),
    );
    expect(inserted.version).toBe(2);

    // Read back, from the database.
    const site = unwrap(await getSite(agent, { siteId }, deps));
    expect(site.version).toBe(2);
    const outline = unwrap(await getPage(agent, { siteId, pageId: homePageId }, deps));
    const hero = outline.nodes.find((n) => n.id === inserted.created.hero)!;
    expect(hero.style?.padding).toEqual({ desktop: '96px', mobile: '32px' });
    expect(outline.nodes.find((n) => n.id === inserted.created.headline)?.text).toBe('Bread, baked at four');

    // A refused batch moves nothing; the same version then writes.
    const refused = await applyBatch(agent, {
      siteId,
      expectedVersion: 2,
      ops: [
        { op: 'updateText', nodeId: inserted.created.headline, text: 'Never stored' },
        { op: 'setProps', nodeId: inserted.created.headline, props: { onclick: 'alert(1)' } },
      ],
    }, deps);
    expect(refused.ok ? null : refused.error.code).toBe('rejected');
    expect((await repository.loadProjectWithVersion(agent.scope, siteId)).version).toBe(2);

    // Update on top: the rest of the insert stays.
    const updated = unwrap(
      await applyBatch(agent, {
        siteId,
        expectedVersion: 2,
        ops: [
          { op: 'updateText', nodeId: inserted.created.headline, text: 'Bread, baked at five' },
          { op: 'updateStyle', nodeId: inserted.created.hero, property: 'backgroundColor', value: '#f6efe6' },
        ],
      }, deps),
    );
    expect(updated.version).toBe(3);
    const after = unwrap(await getPage(agent, { siteId, pageId: homePageId }, deps));
    expect(after.nodes.find((n) => n.id === inserted.created.headline)?.text).toBe('Bread, baked at five');
    expect(after.nodes.find((n) => n.id === inserted.created.hero)?.style).toMatchObject({
      padding: { desktop: '96px', mobile: '32px' },
      backgroundColor: '#f6efe6',
    });

    // Publish, twice, then roll back to the first.
    const first = unwrap(await publish(agent, { siteId, expectedVersion: 3 }, deps));
    expect(first.version).toBe(4);
    expect(first.liveUrl).toBe(`https://${first.subdomain}.sites.test`);
    unwrap(await applyBatch(agent, { siteId, expectedVersion: 4, ops: [{ op: 'updateText', nodeId: inserted.created.headline, text: 'Second' }] }, deps));
    const second = unwrap(await publish(agent, { siteId, expectedVersion: 5 }, deps));
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.subdomain).toBe(first.subdomain);
    const revisions = unwrap(await listRevisions(agent, { siteId }, deps));
    expect(revisions.live).toBe(second.revision);
    expect(revisions.revisions.find((r) => r.number === first.revision)?.publishedBy).toBe('key:key_ops');
    unwrap(await rollback(agent, { siteId, number: first.revision }, deps));
    expect(unwrap(await listRevisions(agent, { siteId }, deps)).live).toBe(first.revision);
    // A rollback leaves the working copy and its version alone.
    expect((await repository.loadProjectWithVersion(agent.scope, siteId)).version).toBe(6);

    // One audit row per write, with the actor.
    const rows = await prisma.siteOperationAudit.findMany({ where: { siteId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.operation)).toEqual(['create_site', 'batch', 'batch', 'publish', 'batch', 'publish', 'rollback']);
    expect(rows.every((r) => r.actorKind === 'key' && r.actorId === 'key_ops' && r.workspaceId === WORKSPACE)).toBe(true);
    expect(rows[1]).toMatchObject({ versionBefore: 1, versionAfter: 2 });
  });

  it('an editor tab loaded before an agent write gets 409 from the real save route and overwrites nothing', async () => {
    const deps = { repository };
    const { siteId, homePageId } = unwrap(await createSite(agent, { name: 'Shared' }, deps));
    // The editor tab loads version 1.
    const tab = await repository.loadProjectWithVersion(agent.scope, siteId);
    // The agent writes.
    const written = unwrap(
      await applyBatch(agent, { siteId, expectedVersion: 1, ops: [{ op: 'insertNodes', pageId: homePageId, nodes: [{ ref: 'p', type: 'p', props: { children: 'From the agent' } }] }] }, deps),
    );
    // The tab saves its stale copy.
    const res = await SAVE(
      new Request('http://app.lumitra.co/api/projects/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'lumitra_session=sess_ops', host: 'app.lumitra.co' },
        body: JSON.stringify({ project: getSnapshot(tab.project), expectedVersion: tab.version }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'site_changed', currentVersion: 2 } });
    const stored = unwrap(await getPage(agent, { siteId, pageId: homePageId }, deps));
    expect(stored.nodes.find((n) => n.id === written.created.p)?.text).toBe('From the agent');

    // And the other way round: the editor saves first, the agent's stale batch is refused.
    const fresh = await repository.loadProjectWithVersion(agent.scope, siteId);
    const ok = await SAVE(
      new Request('http://app.lumitra.co/api/projects/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'lumitra_session=sess_ops', host: 'app.lumitra.co' },
        body: JSON.stringify({ project: getSnapshot(fresh.project), expectedVersion: fresh.version }),
      }),
    );
    expect(ok.status).toBe(200);
    const stale = await applyBatch(agent, { siteId, expectedVersion: 2, ops: [{ op: 'removeNode', nodeId: written.created.p }] }, deps);
    expect(stale.ok ? null : stale.error).toMatchObject({ code: 'site_changed', currentVersion: 3 });
  });

  it('a caller of another workspace sees no site and writes nothing', async () => {
    const deps = { repository };
    const { siteId, homePageId } = unwrap(await createSite(agent, { name: 'Private' }, deps));
    const read = await getSite(stranger, { siteId }, deps);
    expect(read.ok ? null : read.error.code).toBe('site_not_found');
    const write = await applyBatch(stranger, { siteId, expectedVersion: 1, ops: [{ op: 'createPage', title: 'Intruder' }] }, deps);
    expect(write.ok ? null : write.error.code).toBe('site_not_found');
    const pub = await publish(stranger, { siteId, expectedVersion: 1 }, deps);
    expect(pub.ok ? null : pub.error.code).toBe('site_not_found');
    const outline = unwrap(await getPage(agent, { siteId, pageId: homePageId }, deps));
    expect(outline.total).toBe(1);
  });
});
