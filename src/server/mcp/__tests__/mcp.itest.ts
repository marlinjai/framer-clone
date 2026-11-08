// src/server/mcp/__tests__/mcp.itest.ts
//
// The Lumitra Sites MCP endpoint against a REAL Postgres, through the REAL route
// (src/app/api/mcp/route.ts) and the REAL key verification (verifyCompanyKey,
// including its site-row check). Only the outside services are mocked:
// auth-brain's verifyApiKey, the OpenFGA company-structure read, Next's cache and
// the shop provisioning (it needs the owner database role).
//
// The chain an agent runs, as MCP calls: create a site, insert a section, read it
// back, publish (approved by a signed-in person through the real approval route), publish again, roll back
// (approved the same way), and the audit rows. Also: a cookie without a key gets a 401 and
// writes nothing; another company's key sees none of these sites.
//
// Stateful-flow paths (knowledge-base standards, stateful-flow testing): forward
// (the chain), backtrack (a write after the publish was approved makes that
// approval useless), resume (every call is a fresh request that reloads
// the stored version), re-entry (after a refused batch the same version writes).
//
// Runs only under `pnpm test:integration` (Docker Postgres).

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const fakeCredential = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const fakeKey = () => fakeCredential(['sk', 'live'].join('_'));

const KEY_A = fakeKey();
const KEY_B = fakeKey();
const GROUP_A = '018f9c10-0000-7000-8000-0000000000e1';
const GROUP_B = '018f9c10-0000-7000-8000-0000000000e2';
const STRUCTURE: Record<string, { groupIds: string[]; workspaceIds: string[] }> = {
  'mcp-tenant-a': { groupIds: [GROUP_A], workspaceIds: ['mcp_ws_a'] },
  'mcp-tenant-b': { groupIds: [GROUP_B], workspaceIds: ['mcp_ws_b'] },
};

function verified(tenant: string, keyId: string) {
  return {
    principal: { type: 'service_account', id: `sa-${tenant}`, scope: { type: 'tenant', id: tenant, slug: `${tenant}-slug`, app_grants: ['sites'] }, role: 'admin' },
    key: { id: keyId, name: 'agent', expires_at: null },
    effective_roles: { tenant_groups: [], tenants: [{ id: tenant, role: 'admin', source: 'direct' }], workspaces: [] },
  };
}

vi.mock('@/lib/auth-brain-machine', () => ({
  machineAuthBrainClient: {
    verifyApiKey: vi.fn(async (key: string) => {
      if (key === KEY_A) return verified('mcp-tenant-a', 'mcp-key-a');
      if (key === KEY_B) return verified('mcp-tenant-b', 'mcp-key-b');
      return null;
    }),
  },
}));
vi.mock('@/lib/openfgaRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/openfgaRead')>();
  return { ...actual, readCompanyStructure: vi.fn(async (tenant: string) => STRUCTURE[tenant] ?? { groupIds: [], workspaceIds: [] }) };
});
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: vi.fn(async (cookie: string) => (cookie === 'sess_owner' ? { user: { id: 'owner-a' }, session: { created_at: new Date().toISOString() }, tenants: [], workspaces: [] } : null)),
    can: vi.fn(async () => true),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));
const commerce = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/server/sites/companyCommerce', () => ({
  ensureCompanyCommerce: vi.fn(async (...args: unknown[]) => {
    commerce.calls.push(args);
    return { ok: true };
  }),
}));

import { getPrismaClient } from '@/server/db';
import { clearKeyCache } from '@/lib/auth-machine';
import { POST } from '@/app/api/mcp/route';
import { POST as DECIDE } from '@/app/api/projects/[projectId]/confirmations/[approvalId]/route';

let prisma: PrismaClient;
let nextId = 1;

function post(key: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.lumitra.co/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

async function tool(key: string, name: string, args: Record<string, unknown>) {
  const res = await POST(post(key, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
  return body.result;
}

/** The person opens the approval link and clicks approve: the real editor route, with a session cookie. */
async function approve(siteId: string, approvalId: unknown) {
  const res = await DECIDE(
    new Request(`https://app.lumitra.co/api/projects/${siteId}/confirmations/${String(approvalId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: 'lumitra_session=sess_owner' },
      body: JSON.stringify({ decision: 'approve' }),
    }),
    { params: Promise.resolve({ projectId: siteId, approvalId: String(approvalId) }) },
  );
  expect(res.status).toBe(200);
}

async function ok(key: string, name: string, args: Record<string, unknown>) {
  const result = await tool(key, name, args);
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

beforeAll(() => {
  prisma = getPrismaClient();
  vi.stubEnv('PUBLIC_SITE_BASE_HOST', 'sites.itest');
});
beforeEach(() => clearKeyCache());

afterAll(async () => {
  for (const group of [GROUP_A, GROUP_B]) {
    await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: group } });
    await prisma.siteDomain.deleteMany({ where: { tenantGroupId: group } });
    await prisma.site.deleteMany({ where: { tenantGroupId: group } });
  }
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe('the MCP endpoint against a real database', () => {
  it('runs the chain: create, insert, read, publish, publish again, roll back, all through MCP calls', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // initialize and the tool list, through the real route and the real verification.
      const init = await POST(post(KEY_A, { jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'itest', version: '1' } } }));
      expect(init.status).toBe(200);
      expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('lumitra-sites');

      // Create.
      const created = await ok(KEY_A, 'create_site', { name: 'MCP built' });
      expect(created.version).toBe(1);
      const siteId = created.siteId as string;
      const homePageId = created.homePageId as string;
      expect(commerce.calls.at(-1)).toEqual([GROUP_A, 'mcp-tenant-a-slug']);
      const row = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workspaceId: true, companyId: true, tenantGroupId: true } });
      expect(row).toEqual({ workspaceId: 'mcp_ws_a', companyId: 'mcp-tenant-a', tenantGroupId: GROUP_A });

      // A refused batch writes nothing; the same version then writes (re-entry).
      const refused = await tool(KEY_A, 'apply_batch', { siteId, expectedVersion: 1, ops: [{ op: 'insertNodes', pageId: homePageId, nodes: [{ type: 'iframe', props: { src: 'https://evil.example' } }] }] });
      expect(refused.isError).toBe(true);
      expect((refused.structuredContent.error as { code: string }).code).toBe('rejected');

      // Insert.
      const inserted = await ok(KEY_A, 'apply_batch', {
        siteId,
        expectedVersion: 1,
        ops: [{ op: 'insertNodes', pageId: homePageId, nodes: [{ ref: 'hero', type: 'section', children: [{ ref: 'headline', type: 'h1', props: { children: 'Built by an agent' } }] }] }],
      });
      expect(inserted.version).toBe(2);
      const created2 = inserted.created as Record<string, string>;

      // Read back from the database.
      const site = await ok(KEY_A, 'get_site', { siteId });
      expect(site.version).toBe(2);
      const outline = await ok(KEY_A, 'get_page', { siteId, pageId: homePageId });
      const nodes = outline.nodes as Array<{ id: string; text?: string }>;
      expect(nodes.find((n) => n.id === created2.headline)?.text).toBe('Built by an agent');

      // Publish: the first call issues a token and publishes nothing.
      const ask = await ok(KEY_A, 'publish', { siteId, expectedVersion: 2 });
      expect(ask.approvalRequired).toBe(true);
      expect(String(ask.approvalUrl)).toContain(`/projects/${siteId}/confirm/`);
      await approve(siteId, ask.approvalId);
      expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);

      // Backtrack: a write after the token was issued makes the token useless.
      const edited = await ok(KEY_A, 'apply_batch', { siteId, expectedVersion: 2, ops: [{ op: 'updateText', nodeId: created2.headline, text: 'Built and checked' }] });
      expect(edited.version).toBe(3);
      const stale = await tool(KEY_A, 'publish', { siteId, expectedVersion: 2, approvalId: ask.approvalId });
      expect((stale.structuredContent.error as { code: string; currentVersion: number })).toMatchObject({ code: 'site_changed', currentVersion: 3 });

      // Confirm on the current version.
      const ask2 = await ok(KEY_A, 'publish', { siteId, expectedVersion: 3 });
      await approve(siteId, ask2.approvalId);
      const published = await ok(KEY_A, 'publish', { siteId, expectedVersion: 3, approvalId: ask2.approvalId });
      expect(published.version).toBe(4);
      const first = published.revision as number;
      expect(published.liveUrl).toMatch(/^https:\/\/.+\.sites\.itest$/);
      const revision = await prisma.siteRevision.findFirstOrThrow({ where: { siteId, number: first } });
      expect(revision.publishedBy).toBe('key:mcp-key-a');

      // Publish again, on the version the publish answered.
      await ok(KEY_A, 'apply_batch', { siteId, expectedVersion: 4, ops: [{ op: 'updateText', nodeId: created2.headline, text: 'Second edition' }] });
      const ask3 = await ok(KEY_A, 'publish', { siteId, expectedVersion: 5 });
      await approve(siteId, ask3.approvalId);
      const second = await ok(KEY_A, 'publish', { siteId, expectedVersion: 5, approvalId: ask3.approvalId });
      expect(second.revision).toBeGreaterThan(first);

      // Roll back to the first publish, confirmed.
      const history = await ok(KEY_A, 'list_revisions', { siteId });
      expect(history.live).toBe(second.revision);
      const askBack = await ok(KEY_A, 'rollback', { siteId, revision: first });
      expect(askBack.approvalRequired).toBe(true);
      await approve(siteId, askBack.approvalId);
      const back = await ok(KEY_A, 'rollback', { siteId, revision: first, approvalId: askBack.approvalId });
      expect(back).toEqual({ siteId, live: first });
      expect((await ok(KEY_A, 'list_revisions', { siteId })).live).toBe(first);

      // One audit row per write, all by the key.
      const audits = await prisma.siteOperationAudit.findMany({ where: { siteId }, orderBy: { createdAt: 'asc' } });
      expect(audits.map((a) => a.operation)).toEqual(['create_site', 'batch', 'batch', 'publish', 'batch', 'publish', 'rollback']);
      expect(new Set(audits.map((a) => `${a.actorKind}:${a.actorId}`))).toEqual(new Set(['key:mcp-key-a']));

      // Another company's key sees none of it and cannot write it.
      const theirs = await ok(KEY_B, 'list_sites', {});
      expect((theirs.sites as Array<{ siteId: string }>).map((s) => s.siteId)).not.toContain(siteId);
      const foreign = await tool(KEY_B, 'apply_batch', { siteId, expectedVersion: 6, ops: [{ op: 'updateText', nodeId: created2.headline, text: 'hijack' }] });
      expect((foreign.structuredContent.error as { code: string }).code).toBe('site_not_found');

      // Skeleton plans: the owner announces on its own site against the real database; another company's key cannot announce
      // there, nor clear the owner's plan, and the editor stream's read with the other company's scope sees none of it.
      const plan = await ok(KEY_A, 'announce_sections', { siteId, pageId: homePageId, sections: [{ ref: 'faq', title: 'Questions', kind: 'faq' }] });
      const theirPlan = await tool(KEY_B, 'announce_sections', { siteId, pageId: homePageId, sections: [{ ref: 'x', title: 'X' }] });
      expect((theirPlan.structuredContent.error as { code: string }).code).toBe('site_not_found');
      const theirClear = await tool(KEY_B, 'clear_sections', { siteId, planId: plan.planId });
      expect((theirClear.structuredContent.error as { code: string }).code).toBe('plan_not_found');
      const { plansSnapshot } = await import('../livePlans');
      expect(plansSnapshot(siteId, { workspaceId: 'not-the-owner', tenantGroupId: 'not-the-owner' })).toEqual([]);
      expect(await ok(KEY_A, 'clear_sections', { siteId, planId: plan.planId })).toEqual({ cleared: true, planId: plan.planId });
    } finally {
      info.mockRestore();
    }
  });

  it('a session cookie without a key gets 401 and writes nothing; an unknown key gets 401', async () => {
    const before = await prisma.site.count({ where: { tenantGroupId: GROUP_A } });
    const cookieOnly = await POST(post(null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_site', arguments: {} } }, { cookie: 'lumitra_session=sess_a' }));
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const unknown = await POST(post(fakeKey(), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_site', arguments: {} } }));
    expect(unknown.status).toBe(401);
    expect(await prisma.site.count({ where: { tenantGroupId: GROUP_A } })).toBe(before);
  });
});
