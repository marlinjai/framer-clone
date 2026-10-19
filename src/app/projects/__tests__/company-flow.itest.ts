// src/app/projects/__tests__/company-flow.itest.ts
//
// END-TO-END proof, against a REAL Postgres, of the editor working per COMPANY
// (the `framer_company` selector) and only for companies holding the
// auth-brain app grant `sites`, for the session shape that broke production on
// 2026-10-19: one user, several companies, `active_workspace` null. Only
// auth-brain (the verified session) and next/headers (the cookie jar) are
// mocked; the dashboard loader, the project loader, the selection, the legacy
// cookie migration handler, the create route and the site repository all run
// for real.
//
// The four stateful-flow paths:
//   1. forward: no selection -> chooser listing only the granted companies
//      (never a login URL) -> choose -> the create route writes into the
//      chosen company's workspace and the dashboard lists it,
//   2. change: switching makes the project list (derived state) follow, and a
//      project of the other company is no longer loadable,
//   3. resume: a fresh request carrying the same cookie keeps the company,
//   (plus an auth-brain outage mid-flow: a retry notice and a JSON 503, never
//   the login, and the selection survives the recovery)
//   4. re-entry after membership removal or a revoked grant: the stale cookie
//      falls back safely (to the only remaining company, the chooser or the
//      not-enabled page), never to a foreign tenant's data.
// Plus the one-time migration of the retired `framer_ws` cookie.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const TG_A = '018f9c10-0000-7000-8000-00000000f1a1';
const TG_B = '018f9c10-0000-7000-8000-00000000f1b1';
const TG_C = '018f9c10-0000-7000-8000-00000000f1c1';
const TG_D = '018f9c10-0000-7000-8000-00000000f1d1';
const ALL = [
  { id: 'ws_flow_a', tenant: 'tenant-flow-a', group: TG_A, name: 'Acme' },
  { id: 'ws_flow_b', tenant: 'tenant-flow-b', group: TG_B, name: 'Beta' },
  { id: 'ws_flow_c', tenant: 'tenant-flow-c', group: TG_C, name: 'Cactus' },
  { id: 'ws_flow_d', tenant: 'tenant-flow-d', group: TG_D, name: 'Dune' },
];

// The current membership set and the companies holding `sites` that the
// mocked auth-brain verifies the session to. Dune never has the grant.
let memberOf = ALL.map((w) => w.tenant);
let granted = ['tenant-flow-a', 'tenant-flow-b', 'tenant-flow-c'];
function session() {
  const rows = ALL.filter((w) => memberOf.includes(w.tenant));
  return {
    user: { id: 'user-flow' },
    session: {},
    tenants: rows.map((w) => ({
      id: w.tenant,
      group_id: w.group,
      name: w.name,
      slug: w.name.toLowerCase(),
      app_grants: granted.includes(w.tenant) ? ['sites'] : ['studio'],
    })),
    workspaces: rows.map((w) => ({ id: w.id, tenant_id: w.tenant, name: 'Main', slug: 'main' })),
    // The suite default company is Dune, which has no Sites: never used.
    active_tenant: { id: 'tenant-flow-d' },
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
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      // An expiring write is how the server deletes a cookie.
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
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
import { selectActiveCompany } from '@/server/auth/activeCompany';
import { POST as createProject } from '@/app/api/projects/route';
import { GET as migrateCompany } from '../migrate-company/route';

let prisma: PrismaClient;
const savedOwnerUrl = process.env.COMMERCE_OWNER_DATABASE_URL;

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** A request from the same browser: it carries the jar's cookies. */
function createReq(name: string): Request {
  return new Request('http://t/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ name }),
  });
}

/** Apply a response's Set-Cookie lines to the jar, like the browser would. */
function applySetCookies(res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (/Max-Age=0/i.test(line) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
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

describe('editor active company (integration)', () => {
  it('forward, change, resume and re-entry with a real database', async () => {
    // ---- forward: nothing selected -------------------------------------
    const first = await loadDashboard();
    if (first.status !== 'choose_company') throw new Error(`expected chooser, got ${first.status}`);
    expect(JSON.stringify(first)).not.toContain('/login');
    // Only the companies with Sites; Dune (the active_tenant) is not listed.
    expect(first.companies.map((c) => c.name)).toEqual(['Acme', 'Beta', 'Cactus']);

    const refused = await createProject(createReq('nowhere'));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('no_active_company');
    expect(await prisma.site.count({ where: { name: 'nowhere' } })).toBe(0);

    // A forged id and a company without the grant are not written.
    expect(await selectActiveCompany('tenant-someone-else')).toEqual({
      ok: false,
      reason: 'not_available',
    });
    expect(await selectActiveCompany('tenant-flow-d')).toEqual({
      ok: false,
      reason: 'not_available',
    });
    expect(jar.has('framer_company')).toBe(false);

    // ---- choose Beta, create there --------------------------------------
    expect(await selectActiveCompany('tenant-flow-b')).toMatchObject({ ok: true });
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
    expect(inB.activeCompany).toMatchObject({ id: 'tenant-flow-b', name: 'Beta' });
    expect(inB.sites.map((s) => s.siteId)).toContain(siteId);
    expect((await loadProjectSnapshot(siteId)).status).toBe('ok');

    // ---- resume: a fresh request with the same cookie ------------------
    const resumed = await loadDashboard();
    expect(resumed.status === 'ok' && resumed.activeCompany.id).toBe('tenant-flow-b');

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
    expect(recovered.status === 'ok' && recovered.activeCompany.id).toBe('tenant-flow-b');

    // ---- change: switch to Acme; the list follows, Beta's project is gone
    expect(await selectActiveCompany('tenant-flow-a')).toMatchObject({ ok: true });
    const inA = await loadDashboard();
    if (inA.status !== 'ok') throw new Error(`expected ok, got ${inA.status}`);
    expect(inA.activeCompany.id).toBe('tenant-flow-a');
    expect(inA.sites.map((s) => s.siteId)).not.toContain(siteId);
    // Beta's project opened while Acme is active: Beta has Sites too, so the
    // forced chooser is offered (continuing to the project), not a 404.
    expect(await loadProjectSnapshot(siteId)).toEqual({
      status: 'choose_company',
      chooserUrl: `/projects?switch=1&next=${encodeURIComponent(`/projects/${siteId}`)}`,
    });
    // A site id that exists nowhere in the session stays a plain 404.
    expect((await loadProjectSnapshot('00000000-0000-7000-8000-00000000dead')).status).toBe(
      'not_found',
    );

    // ---- re-entry after membership removal ------------------------------
    // Back to Beta, then the user loses Beta: the stale cookie must not reach
    // Beta's data. Two granted companies left -> chooser.
    expect(await selectActiveCompany('tenant-flow-b')).toMatchObject({ ok: true });
    memberOf = ['tenant-flow-a', 'tenant-flow-c', 'tenant-flow-d'];
    expect((await loadDashboard()).status).toBe('choose_company');
    const staleProject = await loadProjectSnapshot(siteId);
    expect(staleProject.status).toBe('choose_company');
    expect(JSON.stringify(staleProject)).not.toContain('/login');
    const staleCreate = await createProject(createReq('stale'));
    expect(staleCreate.status).toBe(403);
    expect(await prisma.site.count({ where: { name: 'stale' } })).toBe(0);

    // One granted company left -> that one, and Beta's project stays invisible.
    memberOf = ['tenant-flow-c', 'tenant-flow-d'];
    const onlyC = await loadDashboard();
    if (onlyC.status !== 'ok') throw new Error(`expected ok, got ${onlyC.status}`);
    expect(onlyC.activeCompany.id).toBe('tenant-flow-c');
    expect(onlyC.sites.map((s) => s.siteId)).not.toContain(siteId);
    expect((await loadProjectSnapshot(siteId)).status).toBe('not_found');

    // ---- re-entry after the grant is revoked ----------------------------
    // Cactus loses Sites: no company of this user can use the editor. The
    // dashboard renders the not-enabled page and every write is a 403
    // sites_not_enabled; nothing redirects to the login.
    granted = ['tenant-flow-a', 'tenant-flow-b'];
    expect(await loadDashboard()).toEqual({ status: 'not_enabled', grantedWithoutWorkspace: [] });
    const notEnabled = await createProject(createReq('not enabled'));
    expect(notEnabled.status).toBe(403);
    expect((await notEnabled.json()).error.code).toBe('sites_not_enabled');
    expect(await prisma.site.count({ where: { name: 'not enabled' } })).toBe(0);
  });

  it('migrates the retired framer_ws cookie once, without a loop', async () => {
    memberOf = ALL.map((w) => w.tenant);
    granted = ['tenant-flow-a', 'tenant-flow-b', 'tenant-flow-c'];
    jar.clear();
    jar.set('lumitra_session', 'sess_flow');
    jar.set('framer_ws', 'ws_flow_c');

    // The dashboard sends the browser to the migration handler, once.
    const before = await loadDashboard();
    expect(before).toEqual({ status: 'migrate_legacy', migrateUrl: '/projects/migrate-company' });

    const res = await migrateCompany(
      new Request('http://t/projects/migrate-company', { headers: { cookie: cookieHeader() } }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/projects?migrated=1');
    applySetCookies(res);
    expect(jar.get('framer_company')).toBe('tenant-flow-c');
    expect(jar.has('framer_ws')).toBe(false);

    // Back on the dashboard: Cactus is active, no further redirect.
    const after = await loadDashboard({ legacyMigrated: true });
    expect(after.status === 'ok' && after.activeCompany.id).toBe('tenant-flow-c');
    // And without the marker too, because framer_ws is gone.
    expect((await loadDashboard()).status).toBe('ok');
  });
});
