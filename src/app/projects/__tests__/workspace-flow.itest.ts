// src/app/projects/__tests__/workspace-flow.itest.ts
//
// END-TO-END proof, against a REAL Postgres, of the editor's app-local active
// workspace (the `framer_ws` selector) for the session shape that broke
// production on 2026-10-19: one user, several companies, `active_workspace`
// null. Only auth-brain (the verified session) and next/headers (the cookie
// jar) are mocked; the dashboard loader, the project loader, the selection
// action, the create route and the site repository all run for real.
//
// The four stateful-flow paths:
//   1. forward: no selection -> chooser (never a login URL) -> choose -> the
//      create route writes into the chosen workspace and the dashboard lists it,
//   2. change: switching makes the project list (derived state) follow, and a
//      project of the other workspace is no longer loadable,
//   3. resume: a fresh request carrying the same cookie keeps the workspace,
//   (plus an auth-brain outage mid-flow: a retry notice and a JSON 503, never
//   the login, and the selection survives the recovery)
//   4. re-entry after membership removal: the stale cookie falls back safely
//      (to the only remaining workspace, or to the chooser), never to a foreign
//      tenant's data.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const TG_A = '018f9c10-0000-7000-8000-00000000f1a1';
const TG_B = '018f9c10-0000-7000-8000-00000000f1b1';
const TG_C = '018f9c10-0000-7000-8000-00000000f1c1';
const ALL = [
  { id: 'ws_flow_a', tenant: 'tenant-flow-a', group: TG_A, name: 'Acme' },
  { id: 'ws_flow_b', tenant: 'tenant-flow-b', group: TG_B, name: 'Beta' },
  { id: 'ws_flow_c', tenant: 'tenant-flow-c', group: TG_C, name: 'Cactus' },
];

// The current membership set the mocked auth-brain verifies the session to.
let memberOf = ALL.map((w) => w.id);
function session() {
  const rows = ALL.filter((w) => memberOf.includes(w.id));
  return {
    user: { id: 'user-flow' },
    session: {},
    tenants: rows.map((w) => ({ id: w.tenant, group_id: w.group, name: w.name, slug: w.name.toLowerCase() })),
    workspaces: rows.map((w) => ({ id: w.id, tenant_id: w.tenant, name: w.name, slug: w.name.toLowerCase() })),
    active_tenant: rows[0] ? { id: rows[0].tenant } : null,
    active_workspace: null,
  };
}

// Flip to simulate an auth-brain outage (the SDK throws on network errors).
let authBrainDown = false;
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) => {
      if (authBrainDown) throw new Error('Network error: ECONNREFUSED');
      return cookie === 'sess_flow' ? session() : null;
    }),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

// A browser cookie jar shared by the server-component reads and the action's
// write, like one browser across requests.
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => ({
    get: (name: string) =>
      ({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.lumitra.co' })[name] ?? null,
  }),
}));

import { getPrismaClient } from '@/server/db';
import { loadDashboard } from '../loader';
import { loadProjectSnapshot } from '../[projectId]/loader';
import { selectActiveWorkspace } from '@/server/auth/activeWorkspace';
import { POST as createProject } from '@/app/api/projects/route';

let prisma: PrismaClient;
const savedOwnerUrl = process.env.COMMERCE_OWNER_DATABASE_URL;

/** A request from the same browser: it carries the jar's cookies. */
function createReq(name: string): Request {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return new Request('http://t/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
}

beforeAll(async () => {
  prisma = getPrismaClient();
  // The create route provisions the company's commerce schema on the OWNER
  // connection; the container superuser plays the owner (see create-route.itest).
  process.env.COMMERCE_OWNER_DATABASE_URL = process.env.DATABASE_URL;
  jar.set('lumitra_session', 'sess_flow');
}, 120_000);

afterAll(async () => {
  if (savedOwnerUrl === undefined) delete process.env.COMMERCE_OWNER_DATABASE_URL;
  else process.env.COMMERCE_OWNER_DATABASE_URL = savedOwnerUrl;
  await prisma.$disconnect();
});

describe('editor active workspace (integration)', () => {
  it('forward, change, resume and re-entry with a real database', async () => {
    // ---- forward: nothing selected -------------------------------------
    const first = await loadDashboard();
    expect(first.status).toBe('choose_workspace');
    expect(JSON.stringify(first)).not.toContain('/login');

    const refused = await createProject(createReq('nowhere'));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('no_active_workspace');
    expect(await prisma.site.count({ where: { name: 'nowhere' } })).toBe(0);

    // A forged id is not written.
    expect(await selectActiveWorkspace('ws_someone_else')).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
    expect(jar.has('framer_ws')).toBe(false);

    // ---- choose B, create there ----------------------------------------
    expect(await selectActiveWorkspace('ws_flow_b')).toMatchObject({ ok: true });
    const created = await createProject(createReq('Flow B site'));
    expect(created.status).toBe(200);
    const { siteId } = await created.json();
    const row = await prisma.site.findUnique({
      where: { id: siteId },
      select: { workspaceId: true, tenantGroupId: true },
    });
    expect(row).toEqual({ workspaceId: 'ws_flow_b', tenantGroupId: TG_B });

    const inB = await loadDashboard();
    if (inB.status !== 'ok') throw new Error(`expected ok, got ${inB.status}`);
    expect(inB.activeWorkspace.id).toBe('ws_flow_b');
    expect(inB.sites.map((s) => s.siteId)).toContain(siteId);
    expect((await loadProjectSnapshot(siteId)).status).toBe('ok');

    // ---- resume: a fresh request with the same cookie ------------------
    const resumed = await loadDashboard();
    expect(resumed.status === 'ok' && resumed.activeWorkspace.id).toBe('ws_flow_b');

    // ---- auth-brain outage: no login, no write, then recovery ------------
    authBrainDown = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadDashboard()).toEqual({ status: 'auth_unavailable' });
    expect(await loadProjectSnapshot(siteId)).toEqual({ status: 'auth_unavailable' });
    const duringOutage = await createProject(createReq('outage'));
    expect(duringOutage.status).toBe(503);
    expect((await duringOutage.json()).error.code).toBe('auth_unavailable');
    expect(await prisma.site.count({ where: { name: 'outage' } })).toBe(0);
    authBrainDown = false;
    errSpy.mockRestore();
    const recovered = await loadDashboard();
    expect(recovered.status === 'ok' && recovered.activeWorkspace.id).toBe('ws_flow_b');

    // ---- change: switch to A; the list follows, B's project is gone ----
    expect(await selectActiveWorkspace('ws_flow_a')).toMatchObject({ ok: true });
    const inA = await loadDashboard();
    if (inA.status !== 'ok') throw new Error(`expected ok, got ${inA.status}`);
    expect(inA.activeWorkspace.id).toBe('ws_flow_a');
    expect(inA.sites.map((s) => s.siteId)).not.toContain(siteId);
    expect((await loadProjectSnapshot(siteId)).status).toBe('not_found');

    // ---- re-entry after membership removal ------------------------------
    // Back to B, then the user loses B: the stale cookie must not reach B's
    // data. Two workspaces left -> chooser.
    expect(await selectActiveWorkspace('ws_flow_b')).toMatchObject({ ok: true });
    memberOf = ['ws_flow_a', 'ws_flow_c'];
    expect((await loadDashboard()).status).toBe('choose_workspace');
    const staleProject = await loadProjectSnapshot(siteId);
    expect(staleProject.status).toBe('choose_workspace');
    expect(JSON.stringify(staleProject)).not.toContain('/login');
    const staleCreate = await createProject(createReq('stale'));
    expect(staleCreate.status).toBe(403);
    expect(await prisma.site.count({ where: { name: 'stale' } })).toBe(0);

    // One workspace left -> that one, and B's project stays invisible.
    memberOf = ['ws_flow_c'];
    const onlyC = await loadDashboard();
    if (onlyC.status !== 'ok') throw new Error(`expected ok, got ${onlyC.status}`);
    expect(onlyC.activeWorkspace.id).toBe('ws_flow_c');
    expect(onlyC.sites.map((s) => s.siteId)).not.toContain(siteId);
    expect((await loadProjectSnapshot(siteId)).status).toBe('not_found');
  });
});
