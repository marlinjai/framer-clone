// The offline model store (plan S2, the parts that need no credentials, dependency or migration):
// quotas, address and headers, the upload pipeline against fakes, serving, collection.
// The real validator, re-encoder, Storage Brain adapter, Prisma repository and route are gated.

import { describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES } from '@/lib/scene/glb';
import { MODEL_QUOTAS, checkModelQuota, checkSceneQuota } from '@/lib/scene/modelQuota';
import { matchesModelEtag, parseSiteModelFile, siteModelHeaders } from '@/lib/scene/modelFile';
import { MemoryBlobStore, MemorySiteModels } from '../memory';
import { DECODED_LIMITS, acceptModelUpload, decodedProblem, type UploadDeps } from '../uploadModel';
import { serveSiteModel } from '../serveModel';
import { planCollection } from '../collect';
import type { DecodedStats, ModelReencoder, ModelValidator } from '../ports';

const MB = 1024 * 1024;
const enc = new TextEncoder();

/** A GLB that passes checkGlb (a bin chunk of `bin` bytes), distinguished by `tag`. */
function glb(tag: string, bin = 8): Uint8Array {
  const json = enc.encode(JSON.stringify({ asset: { version: '2.0', generator: tag }, buffers: [{ byteLength: bin }], bufferViews: [{ buffer: 0, byteLength: bin }] }));
  const jl = Math.ceil(json.length / 4) * 4;
  const bl = Math.ceil(bin / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + 8 + bl);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
  v.setUint32(12, jl, true); v.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl); out.set(json, 20);
  v.setUint32(20 + jl, bl, true); v.setUint32(24 + jl, 0x004e4942, true);
  return out;
}

const SMALL: DecodedStats = { triangles: 1000, maxTextureSide: 1024, boundingBox: [4, 2, 8], materials: 2, nodes: 5, clips: 0 };
const okValidator: ModelValidator = { validate: async () => ({ ok: true }) };
/** A re-encoder that returns a fixed output, measuring whatever it is told to. */
const reencoder = (output: Uint8Array, input: Partial<DecodedStats> = {}, out: Partial<DecodedStats> = {}): ModelReencoder => ({
  reencode: async () => ({ bytes: output, input: { ...SMALL, ...input }, output: { ...SMALL, maxTextureSide: 1024, ...out } }),
});
const deps = (extra: Partial<UploadDeps> = {}): UploadDeps & { blobs: MemoryBlobStore; models: MemorySiteModels } => ({
  blobs: new MemoryBlobStore(), models: new MemorySiteModels(), validator: okValidator, reencoder: reencoder(glb('out')), ...extra,
}) as never;
const refused = (r: Awaited<ReturnType<typeof acceptModelUpload>>) => { if (r.ok) throw new Error('expected a refusal'); return r; };

describe('quotas (D1: the defaults, never raised here)', () => {
  it('keeps the plan\'s figures', () => {
    expect(MODEL_QUOTAS).toEqual({ perModel: 8 * MB, firstVariant: 4 * MB, perScene: 12 * MB, perSite: 200 * MB });
  });
  it('refuses a model over 8 MB with the measured figure and a hint, and accepts exactly 8 MB', () => {
    expect(checkModelQuota(8 * MB, 0).ok).toBe(true);
    const r = checkModelQuota(8 * MB + 1, 0);
    expect(r).toMatchObject({ ok: false, status: 413, code: 'model-too-large' });
    if (!r.ok) expect(r.message).toMatch(/8\.00 MB after optimising.*Fewer triangles or smaller textures/);
  });
  it('refuses the model that would pass the site quota, and accepts exactly the limit', () => {
    expect(checkModelQuota(MB, 199 * MB).ok).toBe(true);
    const r = checkModelQuota(MB + 1, 199 * MB);
    expect(r).toMatchObject({ ok: false, code: 'site-quota' });
  });
  it('refuses sizes that are not measurable', () => {
    for (const bad of [NaN, -1, Infinity]) expect(checkModelQuota(bad, 0).ok).toBe(false);
    expect(checkModelQuota(1, NaN).ok).toBe(false);
    expect(checkSceneQuota([NaN]).ok).toBe(false);
  });
  it('holds a scene to 4 MB for its first model and 12 MB in total', () => {
    expect(checkSceneQuota([4 * MB, 8 * MB]).ok).toBe(true);
    expect(checkSceneQuota([4 * MB + 1])).toMatchObject({ ok: false, code: 'scene-too-large' });
    expect(checkSceneQuota([2 * MB, 8 * MB, 2 * MB + 1])).toMatchObject({ ok: false, code: 'scene-too-large' });
    expect(checkSceneQuota([]).ok).toBe(true);
  });
});

describe('the address and headers of a model', () => {
  it('reads only <64 lower-case hex>.glb', () => {
    const sha = 'a'.repeat(64);
    expect(parseSiteModelFile(`${sha}.glb`)).toEqual({ sha256: sha });
    for (const bad of [`${sha}.gltf`, `${sha}.png`, `${'A'.repeat(64)}.glb`, `${'a'.repeat(63)}.glb`, `../${sha}.glb`, `${sha}.glb/x`, `${sha}.glb\n`, '']) expect(parseSiteModelFile(bad)).toBeNull();
  });
  it('is immutable and public on a published host, private and revalidated on a preview host', () => {
    const sha = 'b'.repeat(64);
    expect(siteModelHeaders(sha)).toMatchObject({ 'content-type': 'model/gltf-binary', etag: `"${sha}"`, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
    expect(siteModelHeaders(sha, 'private')['cache-control']).toBe('private, no-cache');
  });
  it('matches an entity tag in a list, weak, or *', () => {
    const sha = 'c'.repeat(64);
    expect(matchesModelEtag(`"${sha}"`, sha)).toBe(true);
    expect(matchesModelEtag(`"x", W/"${sha}"`, sha)).toBe(true);
    expect(matchesModelEtag('*', sha)).toBe(true);
    expect(matchesModelEtag(`"${'d'.repeat(64)}"`, sha)).toBe(false);
    expect(matchesModelEtag(null, sha)).toBe(false);
  });
});

describe('the upload pipeline fails closed', () => {
  it('stores nothing without the validator and the re-encoder', async () => {
    for (const missing of [{ validator: undefined }, { reencoder: undefined }]) {
      const d = deps(missing);
      expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', d))).toMatchObject({ status: 503, code: 'not-configured' });
      expect(d.blobs.files.size).toBe(0);
    }
  });

  it('stores the served file and the original, and a row', async () => {
    const d = deps();
    const r = await acceptModelUpload(glb('in'), 's1', 'u1', d);
    expect(r.ok && r.alreadyStored).toBe(false);
    expect(d.blobs.files.size).toBe(2);
    expect([...d.blobs.files.keys()].some((k) => k.startsWith('served/'))).toBe(true);
    expect([...d.blobs.files.keys()].some((k) => k.startsWith('original/'))).toBe(true);
    expect((await d.models.list('s1'))[0]).toMatchObject({ siteId: 's1', uploaderId: 'u1', triangles: 1000 });
  });

  it('is idempotent: the same result stored twice is one row and says so', async () => {
    const d = deps();
    await acceptModelUpload(glb('in'), 's1', 'u', d);
    const again = await acceptModelUpload(glb('in2'), 's1', 'u', d);
    expect(again.ok && again.alreadyStored).toBe(true);
    expect((await d.models.list('s1')).length).toBe(1);
  });

  it('runs the structure guard first: a hostile file never reaches the validator or the re-encoder', async () => {
    const validate = vi.fn(async () => ({ ok: true as const }));
    const reencode = vi.fn();
    const d = deps({ validator: { validate }, reencoder: { reencode } as never });
    const hostile = enc.encode('{"asset":{"version":"2.0"},"buffers":[{"byteLength":4,"uri":"https://evil.example/x.bin"}]}');
    expect(refused(await acceptModelUpload(hostile, 's1', 'u', d))).toMatchObject({ status: 422, code: 'external-reference' });
    expect(validate).not.toHaveBeenCalled();
    expect(reencode).not.toHaveBeenCalled();
    expect(d.blobs.files.size).toBe(0);
  });

  it('refuses a file over the read cap with 413 and an unusable input with 400', async () => {
    expect(refused(await acceptModelUpload(new Uint8Array(MAX_FILE_BYTES + 1), 's1', 'u', deps()))).toMatchObject({ status: 413, code: 'too-large' });
    expect(refused(await acceptModelUpload('x' as never, 's1', 'u', deps()))).toMatchObject({ status: 400 });
  });

  it('refuses what the validator refuses, and a validator or re-encoder that throws, storing nothing', async () => {
    let d = deps({ validator: { validate: async () => ({ ok: false, message: 'ACCESSOR_TOTAL_OFFSET_ALIGNMENT' }) } });
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', d))).toMatchObject({ status: 422, code: 'invalid-model' });
    d = deps({ validator: { validate: async () => { throw new Error('boom'); } } });
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', d))).toMatchObject({ status: 500, code: 'validator-failed' });
    d = deps({ reencoder: { reencode: async () => { throw new Error('boom'); } } });
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', d))).toMatchObject({ status: 500, code: 'reencode-failed' });
    expect(d.blobs.files.size).toBe(0);
  });

  it.each<[string, Partial<DecodedStats>, RegExp]>([
    ['too many triangles', { triangles: DECODED_LIMITS.triangles + 1 }, /triangles/],
    ['a texture over 4096 pixels', { maxTextureSide: 4097 }, /4096/],
    ['a bounding box over 1000 units', { boundingBox: [1001, 1, 1] }, /1000 units/],
    ['too many nodes', { nodes: 1001 }, /nodes/],
    ['too many clips', { clips: 33 }, /clips/],
    ['a size that is not finite', { boundingBox: [NaN, 1, 1] }, /finite/],
    ['a negative size', { triangles: -1 }, /finite/],
  ])('refuses on the decoded caps: %s (a measurement the decoder reports, enforced here)', async (_n, input, message) => {
    const d = deps({ reencoder: reencoder(glb('out'), input) });
    const r = refused(await acceptModelUpload(glb('in'), 's1', 'u', d));
    expect(r.status).toBe(413);
    expect(r.code).toBe('model-too-complex');
    expect(r.message).toMatch(message);
    expect(d.blobs.files.size).toBe(0);
  });

  it('accepts exactly the decoded caps', async () => {
    const edge = { triangles: 500000, maxTextureSide: 4096, boundingBox: [1000, 1000, 1000] as [number, number, number], nodes: 1000, clips: 32 };
    expect((await acceptModelUpload(glb('in'), 's1', 'u', deps({ reencoder: reencoder(glb('out'), edge) }))).ok).toBe(true);
    expect(decodedProblem({ ...SMALL, ...edge })).toBeNull();
  });

  it('refuses an output that breaks a limit the re-encoder promised, or fails the structure guard', async () => {
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', deps({ reencoder: reencoder(glb('out'), {}, { maxTextureSide: 4096 }) })))).toMatchObject({ status: 500, code: 'reencode-failed' });
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', deps({ reencoder: reencoder(enc.encode('not a model at all, really')) })))).toMatchObject({ status: 500, code: 'reencode-failed' });
    const external = enc.encode('{"asset":{"version":"2.0"},"images":[{"uri":"https://evil.example/a.png"}]}');
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', deps({ reencoder: reencoder(external) })))).toMatchObject({ code: 'reencode-failed' });
  });

  it('refuses an optimised model over 8 MB, and one that would pass the site quota', async () => {
    const big = glb('big', 8 * MB + 16);
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', deps({ reencoder: reencoder(big) })))).toMatchObject({ status: 413, code: 'model-too-large' });
    const d = deps();
    await d.models.insert({ siteId: 's1', sha256: 'f'.repeat(64), bytes: 200 * MB, triangles: 1, materials: 1, nodes: 1, clips: 0, extensions: [], uploaderId: 'u', createdAt: new Date() });
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', d))).toMatchObject({ status: 413, code: 'site-quota' });
    expect(d.blobs.files.size).toBe(0);
  });

  it('counts the site quota per site: another site\'s models do not count', async () => {
    const d = deps();
    await d.models.insert({ siteId: 's2', sha256: 'f'.repeat(64), bytes: 200 * MB, triangles: 1, materials: 1, nodes: 1, clips: 0, extensions: [], uploaderId: 'u', createdAt: new Date() });
    expect((await acceptModelUpload(glb('in'), 's1', 'u', d)).ok).toBe(true);
  });

  it('removes only what a failed save added, never a blob another site already holds', async () => {
    const d = deps();
    await acceptModelUpload(glb('in'), 's2', 'u', d);
    const before = new Set(d.blobs.files.keys());
    d.models.insert = async () => { throw new Error('db down'); };
    expect(refused(await acceptModelUpload(glb('in'), 's1', 'u', d))).toMatchObject({ status: 500, code: 'store-failed' });
    expect(new Set(d.blobs.files.keys())).toEqual(before);

    const fresh = deps({ reencoder: reencoder(glb('other')) });
    fresh.models.insert = async () => { throw new Error('db down'); };
    await acceptModelUpload(glb('in'), 's1', 'u', fresh);
    expect(fresh.blobs.files.size).toBe(0);
  });
});

describe('serving a model', () => {
  async function world() {
    const d = deps();
    const a = await acceptModelUpload(glb('in'), 'site-a', 'u', d);
    if (!a.ok) throw new Error('setup');
    const sha = a.model.sha256;
    const resolveSite = vi.fn(async (host: string | null) => (host === 'a.example' ? { siteId: 'site-a', preview: false } : host === 'b.example' ? { siteId: 'site-b', preview: false } : host === 'preview.example' ? { siteId: 'site-a', preview: true } : null));
    const get = (host: string, file = `${sha}.glb`, headers: Record<string, string> = {}) => serveSiteModel(new Request(`https://${host}/site-models/${file}`, { headers: { host, ...headers } }), file, { resolveSite, models: d.models, blobs: d.blobs });
    return { sha, get, resolveSite, d };
  }

  it('serves the bytes with immutable headers on the site\'s own host', async () => {
    const { sha, get } = await world();
    const res = await get('a.example');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${sha}"`);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('answers 304 without bytes to a matching tag, and 404 (not 304) for a hash the site does not hold', async () => {
    const { sha, get } = await world();
    const cached = await get('a.example', undefined, { 'if-none-match': `"${sha}"` });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    const other = 'e'.repeat(64);
    expect((await get('a.example', `${other}.glb`, { 'if-none-match': `"${other}"` })).status).toBe(404);
  });

  it('isolates hosts: site B cannot read site A\'s model, and an unknown host reads nothing', async () => {
    const { get } = await world();
    expect((await get('b.example')).status).toBe(404);
    expect((await get('nobody.example')).status).toBe(404);
  });

  it('answers 404 for anything but <sha>.glb, never touching storage', async () => {
    const { sha, get, d } = await world();
    const spy = vi.spyOn(d.blobs, 'get');
    for (const file of [`${sha}.png`, `${sha}`, `../${sha}.glb`, `${sha.toUpperCase()}.glb`]) expect((await get('a.example', file)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers 503 when the host cannot be resolved, and 502 when the row exists but the bytes are gone', async () => {
    const { sha, get, resolveSite, d } = await world();
    resolveSite.mockRejectedValueOnce(new Error('db'));
    expect((await get('a.example')).status).toBe(503);
    await d.blobs.delete(`served/${sha}`);
    expect((await get('a.example')).status).toBe(502);
  });

  it('serves a preview host privately, asked for again every time, never indexed', async () => {
    const { sha, get } = await world();
    const res = await get('preview.example');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await get('preview.example', undefined, { 'if-none-match': `"${sha}"` })).headers.get('cache-control')).toBe('private, no-cache');
    expect((await get('preview.example', `${'e'.repeat(64)}.glb`)).headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('collection', () => {
  const day = 86_400_000;
  const now = new Date('2026-12-01T00:00:00Z');
  const at = (days: number) => new Date(now.getTime() - days * day);

  it('collects an unreferenced model after 30 days, never before, never while referenced', () => {
    const plan = planCollection({
      now,
      models: [
        { siteId: 's', sha256: 'old-unused', createdAt: at(31) },
        { siteId: 's', sha256: 'exactly-30', createdAt: at(30) },
        { siteId: 's', sha256: 'new-unused', createdAt: at(29) },
        { siteId: 's', sha256: 'old-used', createdAt: at(400) },
      ],
      referenced: new Set(['s/old-used']),
    });
    expect(plan.rows.map((r) => r.sha256).sort()).toEqual(['exactly-30', 'old-unused']);
  });

  it('references are per site: another site\'s use does not keep this site\'s row, but keeps the shared blob', () => {
    const plan = planCollection({
      now,
      models: [{ siteId: 'a', sha256: 'shared', createdAt: at(60) }, { siteId: 'b', sha256: 'shared', createdAt: at(60) }, { siteId: 'a', sha256: 'solo', createdAt: at(60) }],
      referenced: new Set(['b/shared']),
    });
    expect(plan.rows).toEqual([{ siteId: 'a', sha256: 'shared' }, { siteId: 'a', sha256: 'solo' }]);
    expect(plan.blobs).toEqual(['solo']);
  });

  it('collects nothing from nothing', () => {
    expect(planCollection({ now, models: [], referenced: new Set() })).toEqual({ rows: [], blobs: [] });
  });
});
