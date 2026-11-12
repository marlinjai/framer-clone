// A fake Storage Brain, written from the service's own route source (storage-brain packages/api/src/routes/
// {upload,files,internal-upload}.ts and the D1 adapter), with synthetic data only. It reproduces the behaviours the
// adapter's safety rules answer to: rows that exist before their bytes, no uniqueness of a context, a list cursor cut by
// a millisecond timestamp (rows with the same timestamp at a page boundary are skipped), a total that counts the cursor
// condition, a DELETE that checks only the tenant, tenants told apart by their API key, and a presigned path that is
// relative. Faults can be injected per request.

import { randomBytes, randomUUID } from 'node:crypto';

export interface FakeFile {
  id: string; tenantId: string; storedPath: string; originalName: string; fileType: string; sizeBytes: number; context: string | null;
  tags: Record<string, string> | null; processingStatus: 'pending' | 'completed' | 'failed'; createdAt: number; deletedAt: number | null; bytes: Uint8Array | null;
}

export type Fault = { when: (req: Request) => boolean; times?: number; respond: () => Response | Promise<Response> | never };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Built when the test file loads, never written out in the source (test-credentials standard): the fake only compares
// it for equality, so any random value does.
export const TOKEN = randomBytes(32).toString('hex');
const FILE_NAME = /^[^<>:"/\\|?*\x00-\x1f]+$/;

export class FakeStorageBrain {
  readonly files = new Map<string, FakeFile>();
  readonly calls: { method: string; path: string; authorization: string | null; redirect: string | undefined }[] = [];
  readonly keys = new Map<string, string>();
  faults: Fault[] = [];
  /** Give every new row the same timestamp (a tie at a page boundary). */
  sameTimestamp = false;
  /** Make the handshake return an absolute presigned address. */
  absolutePresigned: string | null = null;
  /** Cut the next PUT off: the row ends `failed` and the answer is a 500. */
  cutNextPut = false;
  pageLimit: number | null = null;
  /** Requests per key before a 429 (the service's window is 100 a minute); null = unlimited. */
  rateLimit: number | null = null;
  private served = 0;
  /** Answer the handshake as an exhausted quota does in the real service: 403 QUOTA_EXCEEDED. */
  quotaExhausted = false;
  private clock = 1_700_000_000_000;

  constructor(tenants: Record<string, string>) { for (const [key, tenant] of Object.entries(tenants)) this.keys.set(key, tenant); }

  /** A file of another application, or another tenant, planted for the safety tests. */
  plant(tenantId: string, over: Partial<FakeFile> & { context: string }): FakeFile {
    const f: FakeFile = { id: randomUUID(), tenantId, storedPath: 'x', originalName: 'x.glb', fileType: 'model/gltf-binary', sizeBytes: 4, tags: null, processingStatus: 'completed', createdAt: this.stamp(), deletedAt: null, bytes: new Uint8Array([1, 2, 3, 4]), ...over };
    this.files.set(f.id, f);
    return f;
  }

  private stamp(): number { return this.sameTimestamp ? this.clock : (this.clock += 1); }

  /** The service's real answer, bypassing injected faults (a fault can start from it and corrupt it). */
  rawFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    return this.route(req, new URL(req.url));
  };

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    this.calls.push({ method: req.method, path: url.pathname, authorization: req.headers.get('authorization'), redirect: init?.redirect });
    for (const f of this.faults) {
      if (f.when(req) && (f.times === undefined || f.times > 0)) {
        if (f.times !== undefined) f.times--;
        return await f.respond();
      }
    }
    return this.route(req, url);
  };

  private tenantOf(req: Request): string | Response {
    const header = req.headers.get('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : '';
    const tenant = this.keys.get(key);
    return tenant ?? json({ error: { code: 'UNAUTHORIZED' } }, 401);
  }

  private async route(req: Request, url: URL): Promise<Response> {
    const p = url.pathname;
    if (req.method === 'PUT' && p.startsWith('/_internal/upload/')) return this.put(req, url);
    const tenant = this.tenantOf(req);
    if (tenant instanceof Response) return tenant;
    if (this.rateLimit !== null && ++this.served > this.rateLimit) { this.served = 0; return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } }); }
    if (req.method === 'POST' && p === '/api/v1/upload/request') { if (this.quotaExhausted) return json({ error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded' } }, 403); return this.request(req, tenant); }
    if (req.method === 'GET' && p === '/api/v1/files') return this.list(url, tenant);
    if (req.method === 'GET' && p === '/api/v1/files/contexts') return this.contexts(tenant);
    const m = /^\/api\/v1\/files\/([^/]+)(\/download)?$/.exec(p);
    if (m) {
      const file = this.files.get(m[1]);
      if (!file || file.tenantId !== tenant || file.deletedAt !== null) return json({ error: { code: 'NOT_FOUND' } }, 404);
      if (req.method === 'GET' && m[2]) {
        if (!file.bytes || file.processingStatus !== 'completed') return json({ error: { code: 'NOT_FOUND' } }, 404);
        return new Response(file.bytes.slice(), { status: 200, headers: { 'content-length': String(file.bytes.byteLength), 'content-type': file.fileType } });
      }
      if (req.method === 'GET') return json(this.view(file));
      if (req.method === 'DELETE') { file.deletedAt = Date.now(); return json({ success: true }); }
    }
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  private view(f: FakeFile) {
    return { id: f.id, url: `/api/v1/files/${f.id}/download`, originalName: f.originalName, fileType: f.fileType, sizeBytes: f.sizeBytes, context: f.context, tags: f.tags, metadata: null, processingStatus: f.processingStatus, workspaceId: null, createdAt: new Date(f.createdAt).toISOString() };
  }

  private async request(req: Request, tenant: string): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: { code: 'VALIDATION' } }, 400); }
    const { fileType, fileName, fileSizeBytes, context, tags } = body as { fileType?: string; fileName?: string; fileSizeBytes?: number; context?: string; tags?: Record<string, string> };
    if (typeof fileType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(fileType)) return json({ error: { code: 'VALIDATION' } }, 400);
    if (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255 || !FILE_NAME.test(fileName)) return json({ error: { code: 'VALIDATION' } }, 400);
    if (!Number.isInteger(fileSizeBytes) || (fileSizeBytes as number) < 1 || (fileSizeBytes as number) > 100 * 1024 * 1024) return json({ error: { code: 'VALIDATION' } }, 400);
    if (context !== undefined && (typeof context !== 'string' || context.length > 100)) return json({ error: { code: 'VALIDATION' } }, 400);
    if (tags !== undefined && (typeof tags !== 'object' || tags === null || Array.isArray(tags) || Object.values(tags).some((v) => typeof v !== 'string'))) return json({ error: { code: 'VALIDATION' } }, 400);
    const id = randomUUID();
    const storedPath = `tenants/${tenant}/files/${id}/${fileName}`;
    this.files.set(id, { id, tenantId: tenant, storedPath, originalName: fileName, fileType, sizeBytes: fileSizeBytes as number, context: context ?? null, tags: tags ?? null, processingStatus: 'pending', createdAt: this.stamp(), deletedAt: null, bytes: null });
    const presignedUrl = this.absolutePresigned ?? `/_internal/upload/${encodeURIComponent(storedPath)}?token=${TOKEN}&expires=${Date.now() + 900_000}`;
    return json({ fileId: id, presignedUrl, expiresAt: new Date(Date.now() + 900_000).toISOString(), uploadMetadata: { maxSizeBytes: 100 * 1024 * 1024, allowedTypes: null } });
  }

  private async put(req: Request, url: URL): Promise<Response> {
    const storedPath = decodeURIComponent(url.pathname.replace('/_internal/upload/', ''));
    if (url.searchParams.get('token') !== TOKEN) return json({ error: 'Invalid or expired upload token' }, 403);
    const file = [...this.files.values()].find((f) => f.storedPath === storedPath);
    if (!file) return json({ error: 'File record not found' }, 404);
    if (file.processingStatus !== 'pending') return json({ error: `Upload session already ${file.processingStatus}` }, 409);
    const body = new Uint8Array(await req.arrayBuffer());
    if (this.cutNextPut) { this.cutNextPut = false; file.processingStatus = 'failed'; return json({ error: 'cut off' }, 500); }
    if (body.byteLength === 0) { file.processingStatus = 'failed'; return json({ error: 'Empty file body' }, 400); }
    if (body.byteLength > file.sizeBytes) { file.processingStatus = 'failed'; return json({ error: 'too large' }, 413); }
    file.bytes = body;
    file.sizeBytes = body.byteLength;
    file.processingStatus = 'completed';
    return json({ ok: true });
  }

  /** The D1 adapter's listing: this tenant's live rows, ordered by created_at DESC, `created_at < cursor`, total counted with the cursor. */
  private list(url: URL, tenant: string): Response {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), this.pageLimit ?? 100);
    const context = url.searchParams.get('context');
    const cursor = url.searchParams.get('cursor');
    const cursorTs = cursor ? parseInt(atob(cursor), 10) : null;
    const rows = [...this.files.values()]
      .filter((f) => f.tenantId === tenant && f.deletedAt === null && (context === null || f.context === context) && (cursorTs === null || f.createdAt < cursorTs))
      .sort((a, b) => b.createdAt - a.createdAt);
    const total = rows.length;
    const page = rows.slice(0, limit + 1);
    const hasMore = page.length > limit;
    if (hasMore) page.pop();
    const last = page[page.length - 1];
    return json({ files: page.map((f) => this.view(f)), nextCursor: hasMore && last ? btoa(String(last.createdAt)) : null, total });
  }

  private contexts(tenant: string): Response {
    const agg = new Map<string, { context: string; fileCount: number; totalBytes: number }>();
    for (const f of this.files.values()) {
      if (f.tenantId !== tenant || f.deletedAt !== null) continue;
      const c = f.context || 'default';
      const a = agg.get(c) ?? { context: c, fileCount: 0, totalBytes: 0 };
      a.fileCount++; a.totalBytes += f.sizeBytes; agg.set(c, a);
    }
    return json({ contexts: [...agg.values()].sort((a, b) => b.totalBytes - a.totalBytes) });
  }

  live(tenant: string) { return [...this.files.values()].filter((f) => f.tenantId === tenant && f.deletedAt === null); }
}
