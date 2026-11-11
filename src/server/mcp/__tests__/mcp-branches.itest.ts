// src/server/mcp/__tests__/mcp-branches.itest.ts
//
// The site branches tools of the Lumitra Sites MCP endpoint (docs/plans/2026-11-10-site-branches.md, slice
// S6) against a REAL Postgres, through the REAL route (src/app/api/mcp/route.ts), the REAL key
// verification, the REAL branch repository and merge service, and the REAL approval route a signed-in
// person decides through. Only the outside services are mocked, as in mcp.itest.ts.
//
// What an agent does, as MCP calls: build a site, make a branch, write on the branch (the site stays as it
// was), read its status, bring the site's changes in (a conflict answered), ask for review, and merge with
// the person's approval. Around that, everything that must write nothing: a merge without an approval, with
// a declined one, with one given for a state that moved; a merge of a branch behind main; publish on a
// branch; another company's key; a key discarding a branch it did not make; and the switch being off.
//
// Stateful-flow paths (knowledge-base standards, stateful-flow testing): forward (the chain), backtrack (an
// edit after the approval makes it useless; an answer given for a conflict), resume (every call is a fresh
// request on the stored state; the answers given are kept between calls), re-entry (a second merge answers
// the first; a closed branch's id answers branch_closed; a discarded branch stays discarded).
//
// Runs only under `pnpm test:integration` (Docker Postgres).

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const fakeCredential = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const fakeKey = () => fakeCredential(['sk', 'live'].join('_'));

const KEY_A = fakeKey();
/** A second key of company A: the same sites, another agent. */
const KEY_A2 = fakeKey();
const KEY_B = fakeKey();
// Tenant groups of this file alone (src/server/__tests__/integrationTenantGroups.test.ts guards this).
const GROUP_A = '018f9c10-0000-7000-8000-0000000000f6';
const GROUP_B = '018f9c10-0000-7000-8000-0000000000f7';
const COMPANY_A = 'mcp-br-tenant-a';
const COMPANY_B = 'mcp-br-tenant-b';
const SCOPE_A = { workspaceId: 'mcp_br_ws_a', tenantGroupId: GROUP_A };
const STRUCTURE: Record<string, { groupIds: string[]; workspaceIds: string[] }> = {
  [COMPANY_A]: { groupIds: [GROUP_A], workspaceIds: ['mcp_br_ws_a'] },
  [COMPANY_B]: { groupIds: [GROUP_B], workspaceIds: ['mcp_br_ws_b'] },
};

function verified(tenant: string, keyId: string) {
  return {
    principal: { type: 'service_account', id: `sa-${keyId}`, scope: { type: 'tenant', id: tenant, slug: `${tenant}-slug`, app_grants: ['sites'] }, role: 'admin' },
    key: { id: keyId, name: 'agent', expires_at: null },
    effective_roles: { tenant_groups: [], tenants: [{ id: tenant, role: 'admin', source: 'direct' }], workspaces: [] },
  };
}

vi.mock('@/lib/auth-brain-machine', () => ({
  machineAuthBrainClient: {
    verifyApiKey: vi.fn(async (key: string) => {
      if (key === KEY_A) return verified(COMPANY_A, 'mcp-br-key-a');
      if (key === KEY_A2) return verified(COMPANY_A, 'mcp-br-key-a2');
      if (key === KEY_B) return verified(COMPANY_B, 'mcp-br-key-b');
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
vi.mock('@/server/sites/companyCommerce', () => ({ ensureCompanyCommerce: vi.fn(async () => ({ ok: true })) }));

import { getPrismaClient } from '@/server/db';
import { clearKeyCache } from '@/lib/auth-machine';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { POST } from '@/app/api/mcp/route';
import { POST as DECIDE } from '@/app/api/projects/[projectId]/confirmations/[approvalId]/route';

let prisma: PrismaClient;
let nextId = 1;

function post(key: string, body: unknown): Request {
  return new Request('https://app.lumitra.co/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function rpc(key: string, method: string, params?: Record<string, unknown>) {
  const res = await POST(post(key, { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }));
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

async function tool(key: string, name: string, args: Record<string, unknown>) {
  const body = await rpc(key, 'tools/call', { name, arguments: args });
  if (!body.result) throw new Error(`${name} answered a JSON-RPC error: ${body.error?.message}`);
  return body.result as { isError: boolean; structuredContent: Record<string, unknown> };
}

async function ok(key: string, name: string, args: Record<string, unknown>) {
  const result = await tool(key, name, args);
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

async function refusal(key: string, name: string, args: Record<string, unknown>) {
  const result = await tool(key, name, args);
  expect(result.isError, `${name} should be refused: ${JSON.stringify(result.structuredContent)}`).toBe(true);
  return result.structuredContent.error as Record<string, unknown>;
}

/** The person opens the approval link and decides: the real editor route, with a session cookie. */
async function decide(siteId: string, approvalId: unknown, decision: 'approve' | 'decline' = 'approve') {
  return DECIDE(
    new Request(`https://app.lumitra.co/api/projects/${siteId}/confirmations/${String(approvalId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: 'lumitra_session=sess_owner' },
      body: JSON.stringify({ decision }),
    }),
    { params: Promise.resolve({ projectId: siteId, approvalId: String(approvalId) }) },
  );
}

/** A site with a headline and a paragraph on its home page, built through the tools. */
async function builtSite(name: string) {
  const created = await ok(KEY_A, 'create_site', { name });
  const siteId = created.siteId as string;
  const homePageId = created.homePageId as string;
  const inserted = await ok(KEY_A, 'apply_batch', {
    siteId,
    expectedVersion: 1,
    ops: [{ op: 'insertNodes', pageId: homePageId, nodes: [{ ref: 'headline', type: 'h1', props: { children: 'Fresh bread' } }, { ref: 'intro', type: 'p', props: { children: 'Baked daily' } }] }],
  });
  const ids = inserted.created as Record<string, string>;
  return { siteId, homePageId, headline: ids.headline, intro: ids.intro, version: inserted.version as number };
}

const textOf = async (key: string, siteId: string, pageId: string, nodeId: string) => {
  const outline = await ok(key, 'get_page', { siteId, pageId });
  return (outline.nodes as Array<{ id: string; text?: string }>).find((n) => n.id === nodeId)?.text;
};
const mainVersion = async (siteId: string) => (await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { version: true } })).version;

let info: { mockRestore: () => void };

beforeAll(() => {
  prisma = getPrismaClient();
  vi.stubEnv('PUBLIC_SITE_BASE_HOST', 'sites.itest');
  vi.stubEnv('EDITOR_HOST', 'app.itest');
});
beforeEach(() => {
  clearKeyCache();
  // On for both companies, so a foreign key is refused by the scope, not by the switch.
  vi.stubEnv('SITE_BRANCHES_COMPANIES', '*');
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  return () => info.mockRestore();
});

afterAll(async () => {
  for (const group of [GROUP_A, GROUP_B]) {
    await prisma.siteOperationAudit.deleteMany({ where: { tenantGroupId: group } });
    await prisma.siteDomain.deleteMany({ where: { tenantGroupId: group } });
    await prisma.site.deleteMany({ where: { tenantGroupId: group, branchOfSiteId: { not: null } } });
    await prisma.site.deleteMany({ where: { tenantGroupId: group } });
  }
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe('the branch tools against a real database', () => {
  it('the switch decides who is offered the tools: listed and callable for a company with branches, unknown for one without', async () => {
    vi.stubEnv('SITE_BRANCHES_COMPANIES', COMPANY_A);
    const names = async (key: string) => (((await rpc(key, 'tools/list')).result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    const on = await names(KEY_A);
    const off = await names(KEY_B);
    for (const name of ['list_branches', 'create_branch', 'branch_status', 'update_branch', 'request_review', 'merge_branch', 'discard_branch']) {
      expect(on).toContain(name);
      expect(off).not.toContain(name);
    }
    expect(off).toContain('apply_batch');
    const theirs = await ok(KEY_B, 'create_site', { name: 'No branches here' });
    const refused = await rpc(KEY_B, 'tools/call', { name: 'create_branch', arguments: { siteId: theirs.siteId, name: 'Try' } });
    expect(refused.result).toBeUndefined();
    expect(refused.error?.message).toBe('unknown tool: create_branch');
    expect(await prisma.siteBranch.count({ where: { siteId: theirs.siteId as string } })).toBe(0);
    const instructions = async (key: string) => ((await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })).result as { instructions: string }).instructions;
    expect(await instructions(KEY_A)).toContain('create_branch');
    expect(await instructions(KEY_B)).not.toContain('create_branch');
  });

  it('runs the chain: branch, write, status, update from main with a conflict answered, review, merge with the person', async () => {
    const site = await builtSite('Branch chain');
    const { siteId, homePageId, headline, intro } = site;

    // Create: a copy of the site as stored now, made by the key.
    const made = await ok(KEY_A, 'create_branch', { siteId, name: 'New headline' });
    const branchId = made.branchId as string;
    expect(made.version).toEqual(expect.any(Number));
    expect(made.previewUrl).toBe(`https://app.itest/projects/${branchId}/preview`);
    const record = await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(record).toMatchObject({ siteId, status: 'open', createdByKind: 'key', createdBy: 'mcp-br-key-a', baseVersion: site.version, workspaceId: SCOPE_A.workspaceId, tenantGroupId: GROUP_A });

    // A branch is not a site in a listing, and its id is one for every read and write.
    const sites = (await ok(KEY_A, 'list_sites', {})).sites as Array<{ siteId: string }>;
    expect(sites.map((s) => s.siteId)).toContain(siteId);
    expect(sites.map((s) => s.siteId)).not.toContain(branchId);
    const listed = await ok(KEY_A, 'list_branches', { siteId });
    expect((listed.open as Array<Record<string, unknown>>).map((b) => [b.branchId, b.name, b.status, b.createdByCaller])).toEqual([[branchId, 'New headline', 'open', true]]);

    // Write on the branch: the site stays as it was.
    const branchRead = await ok(KEY_A, 'get_site', { siteId: branchId });
    const edited = await ok(KEY_A, 'apply_batch', { siteId: branchId, expectedVersion: branchRead.version, ops: [{ op: 'updateText', nodeId: headline, text: 'Bread from the branch' }] });
    expect(await textOf(KEY_A, branchId, homePageId, headline)).toBe('Bread from the branch');
    expect(await textOf(KEY_A, siteId, homePageId, headline)).toBe('Fresh bread');
    expect(await mainVersion(siteId)).toBe(site.version);

    // Status: up to date, one thing changed, a merge would go through.
    const status = await ok(KEY_A, 'branch_status', { branchId });
    expect(status).toMatchObject({ upToDate: true, conflictsTotal: 0, mergeable: true, reviewUrl: `https://app.itest/projects/${branchId}/review` });
    expect(status.changeCount).toBeGreaterThan(0);
    expect((status.branch as Record<string, unknown>).version).toBe(edited.version);

    // A branch is never published: refused before anyone is asked.
    expect(await refusal(KEY_A, 'publish', { siteId: branchId, expectedVersion: edited.version })).toMatchObject({ code: 'branch_cannot_publish', mainSiteId: siteId });
    expect(await refusal(KEY_A, 'rollback', { siteId: branchId, revision: 1 })).toMatchObject({ code: 'branch_cannot_publish' });

    // The site moves: the same headline (a conflict) and the paragraph (no conflict).
    const moved = await ok(KEY_A, 'apply_batch', {
      siteId,
      expectedVersion: site.version,
      ops: [{ op: 'updateText', nodeId: headline, text: 'Bread from main' }, { op: 'updateText', nodeId: intro, text: 'Baked every morning' }],
    });

    // The token read before no longer names the state; behind main there is no merge and nobody is asked.
    expect((await refusal(KEY_A, 'merge_branch', { branchId, token: status.token })).code).toBe('branch_review_stale');
    const behind = await ok(KEY_A, 'branch_status', { branchId });
    expect(behind).toMatchObject({ upToDate: false, conflictsTotal: 1, mergeable: false });
    expect(behind.token).not.toBe(status.token);
    expect((await refusal(KEY_A, 'merge_branch', { branchId, token: behind.token })).code).toBe('branch_behind_main');

    // Update without an answer: refused with the conflict, nothing written to the branch.
    const open = await refusal(KEY_A, 'update_branch', { branchId, token: behind.token });
    expect(open).toMatchObject({ code: 'branch_conflicts', conflictsTotal: 1 });
    const [conflict] = open.conflicts as Array<{ id: string; fingerprint: string; main: unknown; branch: unknown }>;
    expect([conflict.main, conflict.branch]).toEqual(['Bread from main', 'Bread from the branch']);
    expect(await textOf(KEY_A, branchId, homePageId, intro)).toBe('Baked daily');

    // An answer for values that are not the conflict's applies to nothing.
    const wrong = await refusal(KEY_A, 'update_branch', { branchId, token: open.token, answers: [{ conflictId: conflict.id, fingerprint: 'not-the-fingerprint', pick: 'branch' }] });
    expect(wrong).toMatchObject({ code: 'branch_conflicts', conflictsTotal: 1 });

    // The answer: the branch's headline stays, main's paragraph comes in, as one new version of the branch.
    const updated = await ok(KEY_A, 'update_branch', { branchId, token: wrong.token, answers: [{ conflictId: conflict.id, fingerprint: conflict.fingerprint, pick: 'branch' }] });
    expect(updated.updated).toBe(true);
    expect(await textOf(KEY_A, branchId, homePageId, headline)).toBe('Bread from the branch');
    expect(await textOf(KEY_A, branchId, homePageId, intro)).toBe('Baked every morning');
    expect(await mainVersion(siteId)).toBe(moved.version);
    // Again: nothing left to bring in, nothing written.
    const again = await ok(KEY_A, 'update_branch', { branchId, token: updated.token });
    expect(again).toMatchObject({ updated: false, version: updated.version });

    // Ask for review: ready, with the two links.
    const review = await ok(KEY_A, 'request_review', { branchId });
    expect(review).toMatchObject({ previewUrl: `https://app.itest/projects/${branchId}/preview`, reviewUrl: `https://app.itest/projects/${branchId}/review` });
    expect((review.branch as Record<string, unknown>).status).toBe('ready');

    // Merge without the person: a link, and nothing merged, however often it is called.
    const ready = await ok(KEY_A, 'branch_status', { branchId });
    expect(ready).toMatchObject({ upToDate: true, mergeable: true });
    const ask = await ok(KEY_A, 'merge_branch', { branchId, token: ready.token });
    expect(ask.approvalRequired).toBe(true);
    expect(String(ask.approvalUrl)).toBe(`https://app.itest/projects/${siteId}/confirm/${String(ask.approvalId)}`);
    expect(String(ask.summary)).toContain('Merge branch "New headline"');
    expect((await ok(KEY_A, 'merge_branch', { branchId, token: ready.token, approvalId: ask.approvalId })).approvalPending).toBe(true);
    // Another key of the same company cannot spend this key's request.
    expect((await ok(KEY_A2, 'merge_branch', { branchId, token: ready.token, approvalId: ask.approvalId })).approvalRequired).toBe(true);
    expect(await mainVersion(siteId)).toBe(moved.version);

    // Declined: spent, nothing merged.
    expect((await decide(siteId, ask.approvalId, 'decline')).status).toBe(200);
    expect(await ok(KEY_A, 'merge_branch', { branchId, token: ready.token, approvalId: ask.approvalId })).toMatchObject({ confirmed: false, declined: true });
    expect(await mainVersion(siteId)).toBe(moved.version);

    // Backtrack: approved, then the branch is edited. The approval was for what the person saw.
    const ask2 = await ok(KEY_A, 'merge_branch', { branchId, token: ready.token });
    expect((await decide(siteId, ask2.approvalId)).status).toBe(200);
    await ok(KEY_A, 'apply_batch', { siteId: branchId, expectedVersion: updated.version, ops: [{ op: 'updateText', nodeId: intro, text: 'Baked every morning, early' }] });
    expect((await refusal(KEY_A, 'merge_branch', { branchId, token: ready.token, approvalId: ask2.approvalId })).code).toBe('branch_review_stale');
    const fresh = await ok(KEY_A, 'branch_status', { branchId });
    const stale = await ok(KEY_A, 'merge_branch', { branchId, token: fresh.token, approvalId: ask2.approvalId });
    expect(stale.approvalRequired).toBe(true);
    expect(stale.approvalId).not.toBe(ask2.approvalId);
    expect(await mainVersion(siteId)).toBe(moved.version);
    // The person cannot approve a request whose branch moved after it was opened either.
    const ask3 = await ok(KEY_A, 'merge_branch', { branchId, token: fresh.token });
    await ok(KEY_A, 'apply_batch', { siteId: branchId, expectedVersion: (fresh.branch as { version: number }).version, ops: [{ op: 'updateText', nodeId: intro, text: 'Baked every morning, very early' }] });
    const late = await decide(siteId, ask3.approvalId);
    expect(late.status).toBe(409);

    // Forward: approved on the state as it is, merged once.
    const final = await ok(KEY_A, 'branch_status', { branchId });
    const ask4 = await ok(KEY_A, 'merge_branch', { branchId, token: final.token });
    expect((await decide(siteId, ask4.approvalId)).status).toBe(200);
    const merged = await ok(KEY_A, 'merge_branch', { branchId, token: final.token, approvalId: ask4.approvalId });
    expect(merged).toMatchObject({ merged: true, siteId, version: (moved.version as number) + 1 });
    expect(await mainVersion(siteId)).toBe((moved.version as number) + 1);
    expect(await textOf(KEY_A, siteId, homePageId, headline)).toBe('Bread from the branch');
    expect(await textOf(KEY_A, siteId, homePageId, intro)).toBe('Baked every morning, very early');

    // Nothing was published, and the branch's content is gone while its record stays.
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { status: true } })).status).toBe('draft');
    expect(await prisma.site.count({ where: { id: branchId } })).toBe(0);
    expect(await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId }, select: { status: true, mergedBy: true, branchSiteId: true } })).toEqual({ status: 'merged', mergedBy: 'mcp-br-key-a', branchSiteId: null });

    // Re-entry: a second merge answers the first and writes nothing; the closed id says what happened.
    const repeat = await ok(KEY_A, 'merge_branch', { branchId, token: final.token, approvalId: ask4.approvalId });
    expect(repeat).toMatchObject({ merged: false, siteId, version: (moved.version as number) + 1 });
    expect(await mainVersion(siteId)).toBe((moved.version as number) + 1);
    expect(await refusal(KEY_A, 'branch_status', { branchId })).toMatchObject({ code: 'branch_closed', branchStatus: 'merged', siteId });
    expect((await refusal(KEY_A, 'apply_batch', { siteId: branchId, expectedVersion: 1, ops: [{ op: 'updateText', nodeId: headline, text: 'late' }] })).code).toBe('site_not_found');
    expect((await refusal(KEY_A, 'discard_branch', { branchId })).code).toBe('branch_closed');
    const after = await ok(KEY_A, 'list_branches', { siteId });
    expect(after.open).toEqual([]);
    expect((after.closed as Array<Record<string, unknown>>).map((b) => [b.branchId, b.status])).toEqual([[branchId, 'merged']]);

    // Audited on the site, by the key, with ids and versions only.
    const audits = await prisma.siteOperationAudit.findMany({ where: { siteId, operation: { startsWith: 'branch_' } }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.operation)).toEqual(['branch_create', 'branch_review', 'branch_merge']);
    expect(new Set(audits.map((a) => `${a.actorKind}:${a.actorId}`))).toEqual(new Set(['key:mcp-br-key-a']));
    expect(JSON.stringify(audits)).not.toContain('New headline');
  });

  it('another company sees and changes nothing: every branch tool answers like a missing site', async () => {
    const site = await builtSite('Branch isolation');
    const made = await ok(KEY_A, 'create_branch', { siteId: site.siteId, name: 'Ours' });
    const branchId = made.branchId as string;
    const status = await ok(KEY_A, 'branch_status', { branchId });
    const before = {
      branches: await prisma.siteBranch.count({ where: { siteId: site.siteId } }),
      audits: await prisma.siteOperationAudit.count({ where: { siteId: site.siteId } }),
      branchVersion: await mainVersion(branchId),
    };

    for (const [name, args] of [
      ['list_branches', { siteId: site.siteId }],
      ['create_branch', { siteId: site.siteId, name: 'Theirs' }],
      ['branch_status', { branchId }],
      ['update_branch', { branchId, token: status.token }],
      ['request_review', { branchId }],
      ['merge_branch', { branchId, token: status.token }],
      ['discard_branch', { branchId }],
      ['get_site', { siteId: branchId }],
      ['publish', { siteId: branchId, expectedVersion: 1 }],
    ] as const) {
      const error = await refusal(KEY_B, name, args);
      expect(error.code, name).toBe('site_not_found');
      expect(JSON.stringify(error), name).not.toContain('Ours');
    }
    expect(await prisma.siteBranch.count({ where: { siteId: site.siteId } })).toBe(before.branches);
    expect(await prisma.siteOperationAudit.count({ where: { siteId: site.siteId } })).toBe(before.audits);
    expect(await mainVersion(branchId)).toBe(before.branchVersion);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: branchId }, select: { status: true } })).status).toBe('open');
    expect(await prisma.siteBranch.count({ where: { tenantGroupId: GROUP_B } })).toBe(0);
  });

  it("a key discards only a branch it created: never a person's, never another key's, and its own once", async () => {
    const site = await builtSite('Branch discard');
    const mine = (await ok(KEY_A, 'create_branch', { siteId: site.siteId, name: 'Trial' })).branchId as string;
    const persons = (await getSiteBranchRepository().createBranch(SCOPE_A, site.siteId, { name: 'By a person', actor: { kind: 'user', id: 'owner-a' } })).branch.branchId;

    // Another key of the same company may work on the branch, but not discard it.
    expect((await ok(KEY_A2, 'branch_status', { branchId: mine })).upToDate).toBe(true);
    expect((await refusal(KEY_A2, 'discard_branch', { branchId: mine })).code).toBe('forbidden');
    expect((await refusal(KEY_A, 'discard_branch', { branchId: persons })).code).toBe('forbidden');
    expect((await refusal(KEY_A, 'discard_branch', { branchId: site.siteId })).code).toBe('not_a_branch');
    expect(await prisma.site.count({ where: { id: { in: [mine, persons] } } })).toBe(2);
    // The answers name no person: who made a branch is a kind and whether it was this key.
    const listed = await ok(KEY_A, 'list_branches', { siteId: site.siteId });
    expect(JSON.stringify(listed)).not.toContain('owner-a');
    expect((listed.open as Array<Record<string, unknown>>).map((b) => [b.name, b.createdByKind, b.createdByCaller])).toEqual([['Trial', 'key', true], ['By a person', 'user', false]]);

    const gone = await ok(KEY_A, 'discard_branch', { branchId: mine });
    expect(gone.discarded).toBe(true);
    expect(await prisma.site.count({ where: { id: mine } })).toBe(0);
    expect((await prisma.siteBranch.findUniqueOrThrow({ where: { id: mine }, select: { status: true, discardedBy: true } }))).toEqual({ status: 'discarded', discardedBy: 'mcp-br-key-a' });
    // Re-entry: the id is closed for good, and its name is free for a new branch from the site as it is now.
    expect(await refusal(KEY_A, 'discard_branch', { branchId: mine })).toMatchObject({ code: 'branch_closed', branchStatus: 'discarded' });
    expect(await refusal(KEY_A, 'merge_branch', { branchId: mine, token: 'any' })).toMatchObject({ code: 'branch_closed', branchStatus: 'discarded' });
    const renewed = await ok(KEY_A, 'create_branch', { siteId: site.siteId, name: 'Trial' });
    expect(renewed.branchId).not.toBe(mine);
    expect((await refusal(KEY_A, 'create_branch', { siteId: site.siteId, name: 'trial' })).code).toBe('branch_name_taken');
    expect((await refusal(KEY_A, 'create_branch', { siteId: renewed.branchId, name: 'Nested' })).code).toBe('site_is_branch');
    // The site itself was never touched.
    expect(await mainVersion(site.siteId)).toBe(site.version);
    const audits = await prisma.siteOperationAudit.findMany({ where: { siteId: site.siteId, operation: { startsWith: 'branch_' } }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.operation)).toEqual(['branch_create', 'branch_discard', 'branch_create']);
  });
});
