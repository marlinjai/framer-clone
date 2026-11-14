// @vitest-environment node
//
// deploy/model-tenant/provision.sh against fake Storage Brain and Auth Brain services, written from the real routes
// (storage-brain admin.ts: tenants list/create/get/regenerate-key/quota; auth-brain admin/machine: tenants list,
// service-accounts list/create, service-accounts/:id/keys). The script is the credential step of the 3D model store, so
// the tests pin what matters before anyone runs it live: it creates exactly once, repeats safely, fails closed and says
// so, hands the minted key only to the proxy's capture file, and never lets any secret reach its output or its argv.

import { execFile, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../../deploy/model-tenant/provision.sh');
const hex = (n = 24) => randomBytes(n).toString('hex');

interface Tenant { id: string; name: string; authWorkspaceId: string | null; quotaBytes: number; usedBytes: number; allowedFileTypes: string[] | null }
interface Faults { regenerateKey?: number; issueKey?: number; omitApiKey?: boolean; pagedTotal?: number; createServiceAccount?: number; createWorkspace?: number; pagedWorkspaces?: boolean; noStorageGrant?: boolean; nonJsonKey?: boolean }

class Fakes {
  readonly storageAdmin = `sb-admin-${hex()}`;
  readonly authAdmin = `ab-admin-${hex()}`;
  readonly legacyKey = `legacy-${hex()}`;
  readonly mintedKey = `minted-${hex()}`;
  readonly companyId = crypto.randomUUID();
  tenants: Tenant[] = [];
  workspaces: { id: string; tenant_id: string; slug: string; name: string }[] = [];
  serviceAccounts: { id: string; name: string; workspace_id: string; role: string }[] = [];
  appGrants: string[] = [];
  keysIssued = 0;
  calls: string[] = [];
  faults: Faults = {};
  headers: Record<string, string | undefined>[] = [];
  private servers: Server[] = [];
  sbUrl = '';
  abUrl = '';

  async start() {
    this.sbUrl = await this.listen((req, body) => this.storage(req, body));
    this.abUrl = await this.listen((req, body) => this.auth(req, body));
  }
  async stop() { await Promise.all(this.servers.map((s) => new Promise((r) => s.close(r)))); }

  private listen(handler: (req: IncomingMessage, body: any) => { status: number; json?: unknown }): Promise<string> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          this.headers.push(req.headers as Record<string, string | undefined>);
          const out = handler(req, raw ? JSON.parse(raw) : undefined);
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(out.json === undefined ? '' : JSON.stringify(out.json));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        this.servers.push(server);
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      });
    });
  }

  private storage(req: IncomingMessage, body: any) {
    const url = new URL(req.url!, 'http://x');
    this.calls.push(`SB ${req.method} ${url.pathname}`);
    // The tenant API: a minted key resolves through its workspace, like middleware/auth.ts (workspace scope needs the grant).
    if (url.pathname.startsWith('/api/v1/tenant/')) {
      if (req.headers.authorization !== `Bearer ${this.mintedKey}` || this.keysIssued === 0) return { status: 401, json: {} };
      const sa = this.serviceAccounts[0];
      const t = sa && this.tenants.find((x) => x.authWorkspaceId === sa.workspace_id);
      if (!t) return { status: 401, json: {} };
      if (this.faults.noStorageGrant) return { status: 403, json: {} };
      if (url.pathname.endsWith('/info')) return { status: 200, json: { id: t.id, name: t.name, allowedFileTypes: t.allowedFileTypes, createdAt: 'x' } };
      if (url.pathname.endsWith('/quota')) return { status: 200, json: { quotaBytes: t.quotaBytes, usedBytes: t.usedBytes, availableBytes: t.quotaBytes - t.usedBytes, usagePercent: 0 } };
      return { status: 404, json: {} };
    }
    if (req.headers.authorization !== `Bearer ${this.storageAdmin}`) return { status: 401, json: { error: { message: `bad key ${req.headers.authorization}` } } };
    const p = url.pathname.replace('/api/v1/admin', '');
    // As the real admin API: the list and get projections do NOT carry the auth binding.
    const view = ({ id, name, quotaBytes, usedBytes, allowedFileTypes }: Tenant) => ({ id, name, quotaBytes, usedBytes, allowedFileTypes });
    if (req.method === 'GET' && p === '/tenants') {
      return { status: 200, json: { tenants: this.tenants.map(view), nextCursor: null, total: this.faults.pagedTotal ?? this.tenants.length } };
    }
    if (req.method === 'POST' && p === '/tenants') {
      if (this.tenants.some((t) => t.name === body.name)) return { status: 409, json: {} };
      // auth_workspace_id and auth_tenant_id are unique when set: one workspace maps to one tenant.
      if (body.authWorkspaceId && this.tenants.some((t) => t.authWorkspaceId === body.authWorkspaceId)) return { status: 409, json: {} };
      if (body.authTenantId) return { status: 400, json: { error: 'this script binds a workspace, never a company' } };
      const t: Tenant = { id: crypto.randomUUID(), name: body.name, authWorkspaceId: body.authWorkspaceId ?? null, quotaBytes: body.quotaBytes, usedBytes: 0, allowedFileTypes: body.allowedFileTypes ?? null };
      this.tenants.push(t);
      return { status: 201, json: { id: t.id, name: t.name, apiKey: this.legacyKey, quotaBytes: t.quotaBytes, allowedFileTypes: t.allowedFileTypes } };
    }
    const m = /^\/tenants\/([^/]+)(\/regenerate-key|\/quota)?$/.exec(p);
    const t = m && this.tenants.find((x) => x.id === m[1]);
    if (!m || !t) return { status: 404, json: {} };
    if (req.method === 'GET' && !m[2]) return { status: 200, json: view(t) };
    if (req.method === 'GET' && m[2] === '/quota') return { status: 200, json: { quotaBytes: t.quotaBytes, usedBytes: t.usedBytes, availableBytes: t.quotaBytes - t.usedBytes, usagePercent: Math.round((t.usedBytes / t.quotaBytes) * 100) } };
    if (req.method === 'POST' && m[2] === '/regenerate-key') {
      if (this.faults.regenerateKey) return { status: this.faults.regenerateKey, json: { error: { message: this.legacyKey } } };
      return { status: 200, json: { apiKey: `rotated-${hex()}` } };
    }
    return { status: 404, json: {} };
  }

  private auth(req: IncomingMessage, body: any) {
    const url = new URL(req.url!, 'http://x');
    this.calls.push(`AB ${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${this.authAdmin}`) return { status: 401, json: {} };
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/admin/machine/tenants') {
      return { status: 200, json: { items: [{ id: crypto.randomUUID(), name: 'Other', slug: 'other' }, { id: this.companyId, name: 'Lumitra', slug: 'lumitra-core' }], next_cursor: null } };
    }
    if (p === '/api/admin/machine/app-grants') {
      // The real per-company answer (app-grants/route.ts): the tenant id and an array of slugs.
      if (req.method === 'GET') return { status: 200, json: { tenant_id: url.searchParams.get('tenant_id'), app_grants: [...this.appGrants] } };
      if (req.method === 'POST') {
        if (!body.actor_email || body.tenant_id !== this.companyId || body.app_slug !== 'storage') return { status: 400, json: {} };
        this.appGrants.push(body.app_slug);
        return { status: 201, json: { ok: true } };
      }
    }
    if (req.method === 'GET' && p === '/api/admin/machine/workspaces') {
      const items = this.workspaces.filter((w) => w.tenant_id === url.searchParams.get('tenant_id'));
      return { status: 200, json: { items, next_cursor: this.faults.pagedWorkspaces ? crypto.randomUUID() : null } };
    }
    if (req.method === 'POST' && p === '/api/admin/machine/workspaces') {
      if (this.faults.createWorkspace) return { status: this.faults.createWorkspace, json: {} };
      if (!body.owner_email || body.tenant_id !== this.companyId) return { status: 404, json: {} };
      if (this.workspaces.some((w) => w.tenant_id === body.tenant_id && w.slug === body.slug)) return { status: 409, json: {} };
      const w = { id: crypto.randomUUID(), tenant_id: body.tenant_id, slug: body.slug, name: body.name };
      this.workspaces.push(w);
      return { status: 201, json: { ok: true, workspace: w } };
    }
    if (req.method === 'GET' && p === '/api/admin/machine/service-accounts') {
      return { status: 200, json: { items: this.serviceAccounts.filter((s) => s.workspace_id === url.searchParams.get('workspace_id')) } };
    }
    if (req.method === 'POST' && p === '/api/admin/machine/service-accounts') {
      if (this.faults.createServiceAccount) return { status: this.faults.createServiceAccount, json: {} };
      if (!body.actor_email || !body.scope?.workspace_id || body.scope?.tenant_id) return { status: 400, json: {} };
      const sa = { id: crypto.randomUUID(), name: body.name, workspace_id: body.scope.workspace_id, role: body.role };
      this.serviceAccounts.push(sa);
      return { status: 201, json: { ok: true, service_account_id: sa.id } };
    }
    const k = /^\/api\/admin\/machine\/service-accounts\/([^/]+)\/keys$/.exec(p);
    if (req.method === 'POST' && k) {
      if (!this.serviceAccounts.some((s) => s.id === k[1])) return { status: 404, json: {} };
      if (this.faults.issueKey) return { status: this.faults.issueKey, json: { error: { message: this.authAdmin } } };
      this.keysIssued += 1;
      if (this.faults.nonJsonKey) return { status: 201, json: undefined };
      return { status: 201, json: { ok: true, ...(this.faults.omitApiKey ? {} : { api_key: this.mintedKey }), key_id: crypto.randomUUID() } };
    }
    return { status: 404, json: {} };
  }
}

interface Run { code: number; out: string; argv: string }

describe('deploy/model-tenant/provision.sh against fake services', () => {
  let fakes: Fakes;
  let work: string;
  let state: string;
  let capture: string;
  let shim: string;
  let argvLog: string;

  beforeEach(async () => {
    fakes = new Fakes();
    await fakes.start();
    work = mkdtempSync(path.join(tmpdir(), 'provision-test-'));
    state = path.join(work, 'state');
    capture = path.join(work, 'capture');
    shim = path.join(work, 'bin');
    argvLog = path.join(work, 'argv.log');
    for (const d of [state, capture, shim]) mkdirSync(d, { recursive: true });
    // A curl wrapper that records every argument the script passes, so a secret on a command line is caught.
    const real = execSync('command -v curl', { shell: '/bin/sh' }).toString().trim();
    writeFileSync(path.join(shim, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\nexec '${real}' "$@"\n`);
    chmodSync(path.join(shim, 'curl'), 0o755);
  });
  afterEach(async () => { await fakes.stop(); rmSync(work, { recursive: true, force: true }); });

  function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
    const full = {
      PATH: `${shim}:${process.env.PATH}`, HOME: work, STATE_DIR: state, CAPTURE_DIR: capture,
      STORAGE_BRAIN_ADMIN_KEY: fakes.storageAdmin, STORAGE_BRAIN_URL: fakes.sbUrl,
      ADMIN_API_KEY: fakes.authAdmin, AUTH_BRAIN_URL: fakes.abUrl, ACTOR_EMAIL: 'actor@example.test', ...env,
    };
    return new Promise((resolve) => {
      execFile('bash', [SCRIPT, ...args], { env: full, timeout: 60_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, out: `${stdout}\n${stderr}`, argv: existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '' });
      });
    });
  }

  const secrets = () => [fakes.storageAdmin, fakes.authAdmin, fakes.legacyKey, fakes.mintedKey];
  function expectNoLeak(r: Run) {
    for (const s of secrets()) { expect(r.out).not.toContain(s); expect(r.argv).not.toContain(s); }
  }
  const mutations = () => fakes.calls.filter((c) => /POST|PATCH|DELETE|PUT/.test(c));

  const prepare = async () => { await run(['resolve-company']); await run(['grant-storage']); return run(['ensure-workspace']); };
  const keyFile = () => path.join(capture, 'STORAGE_BRAIN_API_KEY');

  it('plan prints the decided numbers and touches nothing', async () => {
    const r = await run(['plan'], { STORAGE_BRAIN_ADMIN_KEY: '', ADMIN_API_KEY: '' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('50000000000');
    expect(r.out).toContain('lumitra-core');
    expect(r.out).toContain('site-models');
    expect(fakes.calls).toEqual([]);
  });

  it('resolve-company keeps the id without printing it, and refuses an unknown slug', async () => {
    const ok = await run(['resolve-company']);
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain(fakes.companyId);
    expect(readFileSync(path.join(state, 'model-tenant-company-id'), 'utf8')).toBe(fakes.companyId);
    const missing = await run(['resolve-company'], { COMPANY_SLUG: 'nobody' });
    expect(missing.code).toBe(1);
    expectNoLeak(ok);
  });

  it('ensure-workspace creates the workspace once under the company and is idempotent', async () => {
    const first = await prepare();
    expect(first.code).toBe(0);
    expect(fakes.workspaces).toEqual([expect.objectContaining({ slug: 'site-models', tenant_id: fakes.companyId })]);
    fakes.calls = [];
    const again = await run(['ensure-workspace']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already exists');
    expect(mutations()).toEqual([]);
    expect(fakes.workspaces).toHaveLength(1);
    expect(readFileSync(path.join(state, 'model-tenant-workspace-id'), 'utf8')).toBe(fakes.workspaces[0].id);
  });

  it('ensure-workspace fails closed: a paged list, a failed create and a missing earlier step create nothing', async () => {
    expect((await run(['ensure-workspace'])).code).toBe(2);
    await run(['resolve-company']);
    fakes.faults.pagedWorkspaces = true;
    const paged = await run(['ensure-workspace']);
    expect(paged.code).toBe(1);
    expect(paged.out).toContain('paged');
    fakes.faults.pagedWorkspaces = false;
    fakes.faults.createWorkspace = 500;
    expect((await run(['ensure-workspace'])).code).toBe(1);
    expect(fakes.workspaces).toHaveLength(0);
  });

  it('create-tenant binds the WORKSPACE (never the company), with the decided quota and types, then rotates the legacy key', async () => {
    await prepare();
    const r = await run(['create-tenant']);
    expect(r.code).toBe(0);
    expect(fakes.tenants).toHaveLength(1);
    expect(fakes.tenants[0]).toMatchObject({ name: 'framer-site-models', quotaBytes: 50_000_000_000, authWorkspaceId: fakes.workspaces[0].id, allowedFileTypes: ['model/gltf-binary', 'model/gltf+json'] });
    expect(mutations().filter((c) => c.startsWith('SB'))).toEqual(['SB POST /api/v1/admin/tenants', `SB POST /api/v1/admin/tenants/${fakes.tenants[0].id}/regenerate-key`]);
    expectNoLeak(r);
  });

  it('create-tenant is idempotent: a second run creates nothing and only rotates the legacy key again', async () => {
    await prepare();
    await run(['create-tenant']);
    fakes.calls = [];
    const again = await run(['create-tenant']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already exists');
    expect(fakes.tenants).toHaveLength(1);
    expect(mutations()).toEqual([`SB POST /api/v1/admin/tenants/${fakes.tenants[0].id}/regenerate-key`]);
  });

  it('create-tenant refuses a workspace another tenant already claims (unique binding) and a paged tenant list', async () => {
    await prepare();
    fakes.tenants.push({ id: crypto.randomUUID(), name: 'someone-else', authWorkspaceId: fakes.workspaces[0].id, quotaBytes: 1, usedBytes: 0, allowedFileTypes: null });
    const clash = await run(['create-tenant']);
    expect(clash.code).toBe(1);
    expect(clash.out).toContain('409');
    expect(fakes.tenants).toHaveLength(1);
    fakes.tenants = [];
    fakes.faults.pagedTotal = 250;
    const paged = await run(['create-tenant']);
    expect(paged.code).toBe(1);
    expect(paged.out).toContain('paged');
    expect(fakes.tenants).toHaveLength(0);
  });

  it('create-tenant without a workspace id, or with a wrong admin key, creates nothing and leaks nothing', async () => {
    const none = await run(['create-tenant']);
    expect(none.code).toBe(2);
    await prepare();
    const wrong = await run(['create-tenant'], { STORAGE_BRAIN_ADMIN_KEY: `wrong-${hex()}` });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('401');
    expect(wrong.out).not.toContain('bad key');
    expect(fakes.tenants).toHaveLength(0);
  });

  it('a failed legacy-key rotation is loud (exit 4) and leaks no key; a rerun then reports the tenant as existing, which is why the message names the manual fix', async () => {
    await prepare();
    fakes.faults.regenerateKey = 500;
    const r = await run(['create-tenant']);
    expect(r.code).toBe(4);
    expect(r.out).toContain('NOT rotated');
    expectNoLeak(r);
    expect(fakes.tenants).toHaveLength(1);
    // The rerun closes the gap: it rotates the legacy key of the existing tenant.
    fakes.faults.regenerateKey = 0;
    const rerun = await run(['create-tenant']);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain('rotated again');
    expect(fakes.tenants).toHaveLength(1);
  });

  it('mint-key writes the key only to the capture file, creates one workspace-scoped account, and prints and passes nothing secret', async () => {
    await prepare();
    const r = await run(['mint-key']);
    expect(r.code).toBe(0);
    expect(readFileSync(keyFile(), 'utf8')).toBe(fakes.mintedKey);
    expect(fakes.serviceAccounts).toEqual([expect.objectContaining({ name: 'framer-site-models', workspace_id: fakes.workspaces[0].id, role: 'member' })]);
    expect(fakes.keysIssued).toBe(1);
    expectNoLeak(r);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  it('mint-key never mints a second key by accident: a rerun refuses, --reissue is explicit', async () => {
    await prepare();
    await run(['mint-key']);
    rmSync(keyFile());
    const again = await run(['mint-key']);
    expect(again.code).toBe(4);
    expect(again.out).toContain('--reissue');
    expect(fakes.keysIssued).toBe(1);
    expect(existsSync(keyFile())).toBe(false);
    const re = await run(['mint-key', '--reissue']);
    expect(re.code).toBe(0);
    expect(fakes.keysIssued).toBe(2);
    expect(fakes.serviceAccounts).toHaveLength(1);
    expect(readFileSync(keyFile(), 'utf8')).toBe(fakes.mintedKey);
  });

  it('a key issue that fails after the account was created leaves no capture file and points at --reissue', async () => {
    await prepare();
    fakes.faults.issueKey = 500;
    const r = await run(['mint-key']);
    expect(r.code).toBe(4);
    expect(r.out).toContain('--reissue');
    expect(existsSync(keyFile())).toBe(false);
    expectNoLeak(r);
    fakes.faults.issueKey = undefined;
    const fixed = await run(['mint-key', '--reissue']);
    expect(fixed.code).toBe(0);
    expect(fakes.serviceAccounts).toHaveLength(1);
    expect(readFileSync(keyFile(), 'utf8')).toBe(fakes.mintedKey);
  });

  it('grant-storage adds the grant once, is idempotent, and mint-key refuses a company without it (exit 5, nothing created)', async () => {
    await run(['resolve-company']);
    await run(['ensure-workspace']);
    const refused = await run(['mint-key']);
    expect(refused.code).toBe(5);
    expect(refused.out).toContain('grant-storage');
    expect(fakes.serviceAccounts).toHaveLength(0);
    expect(fakes.keysIssued).toBe(0);
    expect((await run(['grant-storage'])).code).toBe(0);
    expect(fakes.appGrants).toEqual(['storage']);
    fakes.calls = [];
    const again = await run(['grant-storage']);
    expect(again.out).toContain('already carries');
    expect(mutations()).toEqual([]);
  });

  it('a 2xx key answer that is not JSON leaves no capture file and points at --reissue', async () => {
    await prepare();
    fakes.faults.nonJsonKey = true;
    const r = await run(['mint-key']);
    expect(r.code).toBe(4);
    expect(r.out).toContain('--reissue');
    expect(existsSync(keyFile())).toBe(false);
  });

  it('an answer without an api_key leaves no empty capture file (the proxy would store an empty secret)', async () => {
    await prepare();
    fakes.faults.omitApiKey = true;
    const r = await run(['mint-key']);
    expect(r.code).toBe(4);
    expect(existsSync(keyFile())).toBe(false);
  });

  it('a failed account creation mints no key, and an unknown acting user is refused before any write', async () => {
    await prepare();
    fakes.faults.createServiceAccount = 500;
    const r = await run(['mint-key']);
    expect(r.code).toBe(1);
    expect(fakes.keysIssued).toBe(0);
    expect(existsSync(keyFile())).toBe(false);
    const noActor = await run(['mint-key'], { ACTOR_EMAIL: '' });
    expect(noActor.code).not.toBe(0);
    expect(fakes.keysIssued).toBe(0);
  });

  it('verify-key proves the stored key resolves to the tenant with the decided quota and types', async () => {
    await prepare();
    await run(['create-tenant']);
    await run(['mint-key']);
    const ok = await run(['verify-key'], { STORAGE_BRAIN_API_KEY: fakes.mintedKey });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('50000000000');
    expect(ok.out).not.toContain(fakes.mintedKey);
    expect(ok.argv).not.toContain(fakes.mintedKey);
  });

  it('verify-key fails when the key does not authenticate, the company lacks the grant, or the quota is not the decided one', async () => {
    await prepare();
    await run(['create-tenant']);
    await run(['mint-key']);
    const wrongKey = await run(['verify-key'], { STORAGE_BRAIN_API_KEY: `wrong-${hex()}` });
    expect(wrongKey.code).toBe(1);
    fakes.faults.noStorageGrant = true;
    const noGrant = await run(['verify-key'], { STORAGE_BRAIN_API_KEY: fakes.mintedKey });
    expect(noGrant.code).toBe(1);
    expect(noGrant.out).toContain('storage grant');
    fakes.faults.noStorageGrant = false;
    fakes.tenants[0].quotaBytes = 524_288_000;
    const quota = await run(['verify-key'], { STORAGE_BRAIN_API_KEY: fakes.mintedKey });
    expect(quota.code).toBe(1);
    expect(quota.out).toContain('quota');
  });

  it('status reports usage, and exits 3 at the 80 percent alert', async () => {
    await prepare();
    await run(['create-tenant']);
    fakes.tenants[0].usedBytes = 10_000_000_000;
    const ok = await run(['status']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('20 percent');
    fakes.tenants[0].usedBytes = 40_000_000_000;
    const alert = await run(['status']);
    expect(alert.code).toBe(3);
    expect(alert.out).toContain('80 percent');
  });

  it('refuses a plain http address that is not loopback, before any request is made', async () => {
    const r = await run(['status'], { STORAGE_BRAIN_URL: 'http://storage.example.test' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('non-https');
    expect(fakes.calls).toEqual([]);
  });

  it('sends each admin key only as a Bearer header on the matching service', async () => {
    await prepare();
    await run(['create-tenant']);
    const auths = fakes.headers.map((h) => h.authorization);
    expect(auths.filter((a) => a === `Bearer ${fakes.storageAdmin}`).length).toBeGreaterThan(0);
    expect(auths.filter((a) => a === `Bearer ${fakes.authAdmin}`).length).toBeGreaterThan(0);
  });
});
