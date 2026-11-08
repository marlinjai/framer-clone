// src/app/api/projects/__tests__/liveSync.itest.ts
//
// Live sync against a REAL Postgres (plan docs/plans/2026-11-08-live-agent-canvas.md,
// slice 1): an agent writes through the real MCP route while an editor holds
// the site's real events stream open; the editor hears the committed write,
// fetches the stored copy through the real document route, and adopts it into
// its store as one undo step. Only the outside services are mocked (auth-brain,
// the OpenFGA company read, Next's cache, the shop provisioning).
//
// Also, at the repository: a write is announced once, after it committed, with
// the version it moved from and to; a refused write (stale version) and the
// repeat of a lost answer (same attempt key) announce nothing; a publish
// announces with origin `publish`.
//
// Runs only under `pnpm test:integration` (Docker Postgres).

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const fakeKey = () => `${['sk', 'live'].join('_')}_${randomBytes(16).toString('hex')}`;
const KEY = fakeKey();
const GROUP = '018f9c10-0000-7000-8000-0000000001a1';
const TENANT = 'live-tenant';
const WORKSPACE = 'live_ws';

vi.mock('@/lib/auth-brain-machine', () => ({
  machineAuthBrainClient: {
    verifyApiKey: vi.fn(async (key: string) =>
      key === KEY
        ? {
            principal: { type: 'service_account', id: 'sa-live', scope: { type: 'tenant', id: TENANT, slug: 'live-slug', app_grants: ['sites'] }, role: 'admin' },
            key: { id: 'live-key', name: 'agent', expires_at: null },
            effective_roles: { tenant_groups: [], tenants: [{ id: TENANT, role: 'admin', source: 'direct' }], workspaces: [] },
          }
        : null,
    ),
  },
}));
vi.mock('@/lib/openfgaRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/openfgaRead')>();
  return { ...actual, readCompanyStructure: vi.fn(async (tenant: string) => (tenant === TENANT ? { groupIds: [GROUP], workspaceIds: [WORKSPACE] } : { groupIds: [], workspaceIds: [] })) };
});
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) =>
      cookie === 'sess_editor'
        ? {
            user: { id: 'editor-1', name: 'Marlin' },
            session: {},
            tenants: [{ id: TENANT, app_grants: ['sites'], group_id: GROUP }],
            workspaces: [{ id: WORKSPACE, tenant_id: TENANT }],
            active_tenant: { id: TENANT },
            active_workspace: { id: WORKSPACE },
          }
        : null,
    ),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/sites/companyCommerce', () => ({ ensureCompanyCommerce: vi.fn(async () => ({ ok: true })) }));

import { getSnapshot } from 'mobx-state-tree';
import { getPrismaClient } from '@/server/db';
import { clearKeyCache } from '@/lib/auth-machine';
import { POST as MCP } from '@/app/api/mcp/route';
import { GET as EVENTS } from '../[projectId]/events/route';
import { GET as DOCUMENT } from '../[projectId]/document/route';
import { SiteChangedError, SiteRepository, type TenantScope } from '@/server/sites';
import { subscribeSite } from '@/server/sites/liveBus';
import { createRootStore, getHistoryStore } from '@/stores/RootStore';
import { adoptServerCopy, knownServerVersion, openProject } from '@/stores/openProject';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import type { SiteVersionEvent } from '@/lib/projects/liveEvents';

const scope: TenantScope = { workspaceId: WORKSPACE, tenantGroupId: GROUP };
let prisma: PrismaClient;
let repo: SiteRepository;
let nextId = 1;

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await MCP(
    new Request('https://app.lumitra.co/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
  if (body.result.isError) throw new Error(`${name} failed: ${JSON.stringify(body.result.structuredContent)}`);
  return body.result.structuredContent;
}

function editorRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.lumitra.co${path}`, {
    headers: { host: 'app.lumitra.co', cookie: 'lumitra_session=sess_editor', ...headers },
  });
}

/** Named events off an SSE response, as they arrive. */
function eventReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(): Promise<{ event: string; data: unknown; id?: string }> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(':')) continue;
          const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
          return { event: fields.event, data: JSON.parse(fields.data), ...(fields.id ? { id: fields.id } : {}) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    },
    /** The next stored write: presence (`agent:activity`) is transient and may arrive on either side of it. */
    async nextWrite(): Promise<{ event: string; data: unknown; id?: string }> {
      for (;;) {
        const e = await this.next();
        if (e.event !== 'agent:activity') return e;
      }
    },
    cancel: () => reader.cancel(),
  };
}

beforeAll(() => {
  prisma = getPrismaClient();
  repo = new SiteRepository(prisma);
});
beforeEach(() => clearKeyCache());

afterAll(async () => {
  await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: GROUP } });
  await prisma.siteDomain.deleteMany({ where: { tenantGroupId: GROUP } });
  await prisma.site.deleteMany({ where: { tenantGroupId: GROUP } });
  await prisma.$disconnect();
});

describe('live sync against a real database', () => {
  it('an agent batch reaches the open stream, and the adopted store equals the stored copy', async () => {
    const created = await tool('create_site', { name: 'Live built' });
    const siteId = created.siteId as string;
    const homePageId = created.homePageId as string;

    // The editor opens the project (the page load) and its stream.
    const loaded = await repo.loadProjectWithVersion(scope, siteId);
    const store = createRootStore();
    openProject(store, getSnapshot(loaded.project) as ProjectSnapshotOut, null, loaded.version);
    const stream = await EVENTS(editorRequest(`/api/projects/${siteId}/events`), { params: Promise.resolve({ projectId: siteId }) });
    expect(stream.status).toBe(200);
    const events = eventReader(stream);
    expect(await events.next()).toMatchObject({ event: 'state', data: { version: 1 } });

    // The agent writes through the MCP endpoint.
    const inserted = await tool('apply_batch', {
      siteId,
      expectedVersion: 1,
      ops: [{ op: 'insertNodes', pageId: homePageId, nodes: [{ ref: 'hero', type: 'section', children: [{ ref: 'headline', type: 'h1', props: { children: 'Built live' } }] }] }],
    });
    const refs = inserted.created as Record<string, string>;

    const heard = await events.nextWrite();
    expect(heard.event).toBe('site:version');
    expect(heard.id).toBe('2');
    const event = heard.data as SiteVersionEvent;
    expect(event).toMatchObject({ origin: 'mcp', version: 2, versionBefore: 1, created: refs, actor: { kind: 'key', label: 'agent' } });
    expect(event.ops).toEqual([{ op: 'insertNodes', pageId: homePageId }]);
    // Ids and server-written lines only: never the headline's text, never the key id.
    expect(JSON.stringify(event)).not.toContain('Built live');
    expect(JSON.stringify(event)).not.toContain('live-key');

    // The editor fetches the stored copy and adopts it.
    const doc = await DOCUMENT(editorRequest(`/api/projects/${siteId}/document`, { 'if-none-match': '"1"' }), { params: Promise.resolve({ projectId: siteId }) });
    expect(doc.status).toBe(200);
    const body = (await doc.json()) as { version: number; snapshot: ProjectSnapshotOut };
    const adopted = adoptServerCopy(store, body.snapshot, body.version, 'Agent: inserted');
    expect(adopted?.created).toEqual([refs.hero, refs.headline]);
    expect(knownServerVersion(siteId)).toBe(2);
    expect(getHistoryStore()!.history).toHaveLength(1);
    const stored = await repo.loadProjectWithVersion(scope, siteId);
    expect(getSnapshot(store.projectStore.getProject(siteId)!)).toEqual(getSnapshot(stored.project));

    // The same version again answers 304.
    const again = await DOCUMENT(editorRequest(`/api/projects/${siteId}/document`, { 'if-none-match': '"2"' }), { params: Promise.resolve({ projectId: siteId }) });
    expect(again.status).toBe(304);

    // A refused batch writes nothing and announces nothing: the next event is the next real write.
    await expect(tool('apply_batch', { siteId, expectedVersion: 1, ops: [{ op: 'updateText', nodeId: refs.headline, text: 'stale' }] })).rejects.toThrow(/site_changed/);
    await tool('apply_batch', { siteId, expectedVersion: 2, ops: [{ op: 'updateText', nodeId: refs.headline, text: 'Fresh' }] });
    expect((await events.nextWrite()).id).toBe('3');
    await events.cancel();
  });

  it('the repository announces a write once, after commit, and never a refused write or a repeated answer', async () => {
    const created = await tool('create_site', { name: 'Announced' });
    const siteId = created.siteId as string;
    const heard: SiteVersionEvent[] = [];
    const unsubscribe = subscribeSite(siteId, (name, data) => {
      if (name === 'site:version') heard.push(data as SiteVersionEvent);
    });
    try {
      const { project } = await repo.loadProjectWithVersion(scope, siteId);
      const snapshot = getSnapshot(project) as ProjectSnapshotOut;

      await repo.saveProject(scope, snapshot, {
        mustExist: true,
        expectedVersion: 1,
        requestKey: 'k_live_attempt_1',
        event: { origin: 'editor', originTab: 'tab_live_0001', actor: { kind: 'user', label: 'Marlin' } },
      });
      expect(heard).toEqual([{ origin: 'editor', originTab: 'tab_live_0001', actor: { kind: 'user', label: 'Marlin' }, version: 2, versionBefore: 1 }]);

      // The repeat of that attempt (its answer was lost) writes nothing and announces nothing.
      await expect(repo.saveProject(scope, snapshot, { mustExist: true, expectedVersion: 1, requestKey: 'k_live_attempt_1' })).resolves.toEqual({ version: 2 });
      // A stale write is refused before anything is written.
      await expect(repo.saveProject(scope, snapshot, { mustExist: true, expectedVersion: 1 })).rejects.toBeInstanceOf(SiteChangedError);
      expect(heard).toHaveLength(1);

      await repo.publishProject(scope, snapshot, { expectedVersion: 2, event: { actor: { kind: 'user', label: 'Marlin' } } });
      expect(heard[1]).toMatchObject({ origin: 'publish', version: 3, versionBefore: 2 });
    } finally {
      unsubscribe();
    }
  });
});
