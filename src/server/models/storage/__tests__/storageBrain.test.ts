// The Storage Brain blob adapter against a fake written from the service's source, synthetic data only, no network.
// Safety-critical paths: the key-to-file-id mapping (exact context + ownership tag), duplicates, cross-tenant and
// stranger files, delete on ambiguity, pagination ties, partial uploads, retries, and where the key may travel.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StorageBrainBlobStore, StorageBrainError } from '../storageBrain';
import { randomUUID } from 'node:crypto';
import { FakeStorageBrain, TOKEN, type Fault } from './fakeStorageBrain';

const KEY_A = 'key-tenant-a-synthetic-0001';
const KEY_B = 'key-tenant-b-synthetic-0002';
const BASE = 'https://storage-brain.invalid';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (tag: string, n = 64) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (tag.charCodeAt(i % tag.length) + i) & 0xff; return b; };
const glb = (tag: string) => { const b = bytes(tag, 80); b.set([0x67, 0x6c, 0x54, 0x46]); return b; };
const served = (b: Uint8Array) => `served/${sha(b)}`;
const original = (b: Uint8Array) => `original/${sha(b)}`;

function world(over: { namespace?: string } = {}) {
  const fake = new FakeStorageBrain({ [KEY_A]: 'tenant-a', [KEY_B]: 'tenant-b' });
  const sleeps: number[] = [];
  const make = (apiKey = KEY_A) => new StorageBrainBlobStore({ baseUrl: BASE, apiKey, fetch: fake.fetch, sleep: async (ms) => { sleeps.push(ms); }, ...over });
  return { fake, make, store: make(), sleeps };
}
const fault = (f: Fault): Fault => f;
const refusal = async (p: Promise<unknown>): Promise<StorageBrainError> => { try { await p; } catch (e) { if (e instanceof StorageBrainError) return e; throw e; } throw new Error('expected a StorageBrainError'); };

describe('configuration', () => {
  const make = (over: Record<string, unknown>) => () => new StorageBrainBlobStore({ baseUrl: BASE, apiKey: KEY_A, ...over } as never);
  it('refuses an unsafe address, a bad key and a bad namespace', () => {
    for (const baseUrl of ['http://storage-brain.invalid', 'ftp://x', 'not a url', 'https://user:pw@x.invalid', 'https://x.invalid/path', 'https://x.invalid/?a=1', 'https://x.invalid/#f']) expect(make({ baseUrl }), baseUrl).toThrow(/Storage Brain address/);
    for (const apiKey of ['', 'short', 'has space in it here', 'line\nbreak-key-12345', 5]) expect(make({ apiKey }), String(apiKey)).toThrow(/API key/);
    for (const namespace of ['', 'Upper', 'has/slash', 'x'.repeat(27), '-lead']) expect(make({ namespace }), namespace).toThrow(/namespace/);
    // 26 characters is the longest that keeps `<namespace>/original/<sha256>` within the service's 100 character context.
    expect(make({ namespace: 'a'.repeat(26) })).not.toThrow();
  });
  it('allows plain http only for a loopback address', () => {
    for (const baseUrl of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) expect(make({ baseUrl })).not.toThrow();
  });
});

describe('keys', () => {
  it('accepts only served/<sha256> and original/<sha256>', async () => {
    const { store } = world();
    for (const key of ['', 'served/abc', `served/${'A'.repeat(64)}`, `other/${'a'.repeat(64)}`, `served/${'a'.repeat(64)}/x`, `../served/${'a'.repeat(64)}`, `served/${'a'.repeat(64)}\n`]) {
      expect((await refusal(store.has(key))).code, key).toBe('invalid-key');
    }
  });
});

describe('round trip', () => {
  it('stores, reads back verified bytes, reports presence, and deletes', async () => {
    const { store, fake } = world();
    const b = glb('one');
    const key = served(b);
    expect(await store.has(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    await store.put(key, b);
    expect(await store.has(key)).toBe(true);
    expect(await store.get(key)).toEqual(b);
    const [file] = fake.live('tenant-a');
    expect(file).toMatchObject({ context: `framer-models/${key}`, fileType: 'model/gltf-binary', tags: { owner: 'framer-models', blob: key }, processingStatus: 'completed' });
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
    expect(fake.live('tenant-a')).toEqual([]);
  });

  it('stores a text glTF original with its own type', async () => {
    const { store, fake } = world();
    const b = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
    await store.put(original(b), b);
    expect(fake.live('tenant-a')[0].fileType).toBe('model/gltf+json');
    expect(await store.get(original(b))).toEqual(b);
  });

  it('writes nothing again for content it already holds verified', async () => {
    const { store, fake } = world();
    const b = glb('same');
    await store.put(served(b), b);
    await store.put(served(b), b);
    expect(fake.live('tenant-a').length).toBe(1);
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(1);
  });
});

describe('content addressing is verified, never trusted', () => {
  it('refuses to write bytes that do not hash to the key, or empty or oversized bytes', async () => {
    const { store, fake } = world();
    expect((await refusal(store.put(served(glb('a')), glb('b')))).code).toBe('integrity');
    expect((await refusal(store.put(`served/${sha(new Uint8Array(0))}`, new Uint8Array(0)))).code).toBe('invalid-key');
    const small = new StorageBrainBlobStore({ baseUrl: BASE, apiKey: KEY_A, fetch: fake.fetch, maxBytes: 10 });
    expect((await refusal(small.put(served(glb('c')), glb('c')))).code).toBe('invalid-key');
    expect(fake.files.size).toBe(0);
  });

  it('never returns bytes that do not hash to the key (a corrupted or swapped file), and tries the next copy', async () => {
    const { store, fake } = world();
    const good = glb('good');
    const key = served(good);
    const evil = fake.plant('tenant-a', { context: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key }, bytes: glb('evil'), sizeBytes: 80, createdAt: 1 });
    expect(await store.get(key)).toBeNull();
    await store.put(key, good);
    expect(fake.live('tenant-a').length).toBe(2);
    expect(await store.get(key)).toEqual(good);
    void evil;
  });

  it('a stored file of the right size but wrong content is not "stored": put writes a verified copy beside it', async () => {
    const { store, fake } = world();
    const good = glb('real');
    const key = served(good);
    fake.plant('tenant-a', { context: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key }, bytes: glb('fake'), sizeBytes: good.byteLength });
    await store.put(key, good);
    expect(await store.get(key)).toEqual(good);
  });

  it('rejects a download whose length differs from the stored size', async () => {
    const { store, fake } = world();
    const b = glb('len');
    await store.put(served(b), b);
    fake.faults.push(fault({ when: (r) => r.url.endsWith('/download'), respond: () => new Response(b, { status: 200, headers: { 'content-length': String(b.byteLength + 5) } }) }));
    expect(await store.get(served(b))).toBeNull();
  });

  it('stops reading a download that is larger than its declared size', async () => {
    const { store, fake } = world();
    const b = glb('big');
    await store.put(served(b), b);
    fake.faults.push(fault({ when: (r) => r.url.endsWith('/download'), respond: () => new Response(new Uint8Array(b.byteLength * 3), { status: 200 }) }));
    expect(await store.get(served(b))).toBeNull();
  });
});

describe('what counts as a blob: only our own, exact, completed files', () => {
  it('ignores pending and failed rows for has and get, and never deletes them', async () => {
    const { store, fake } = world();
    const b = glb('pend');
    const key = served(b);
    const ctx = `framer-models/${key}`;
    const tags = { owner: 'framer-models', blob: key };
    const pending = fake.plant('tenant-a', { context: ctx, tags, processingStatus: 'pending', bytes: null, sizeBytes: 80 });
    const failed = fake.plant('tenant-a', { context: ctx, tags, processingStatus: 'failed', bytes: null, sizeBytes: 0 });
    expect(await store.has(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    await store.delete(key);
    expect(pending.deletedAt).toBeNull();
    expect(failed.deletedAt).toBeNull();
  });

  it('does not see another tenant\'s file with the same context (the key decides the tenant)', async () => {
    const { make, fake } = world();
    const b = glb('tenant');
    const key = served(b);
    await make(KEY_B).put(key, b);
    expect(await make(KEY_A).has(key)).toBe(false);
    expect(await make(KEY_A).get(key)).toBeNull();
    await make(KEY_A).delete(key);
    expect(fake.live('tenant-b').length).toBe(1);
  });

  it('a wrong API key is refused and nothing else happens', async () => {
    const { make, fake } = world();
    const e = await refusal(make('key-not-known-synthetic-9').has(`served/${'a'.repeat(64)}`));
    expect(e.code).toBe('unauthorized');
    expect(fake.files.size).toBe(0);
  });
});

describe('DELETE ON AMBIGUITY REFUSES', () => {
  const setup = async () => {
    const w = world();
    const b = glb('del');
    const key = served(b);
    await w.store.put(key, b);
    return { ...w, b, key, ctx: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key } };
  };

  it('deletes every duplicate of one key when the listing is complete and all are ours', async () => {
    const { store, fake, key, ctx, tags } = await setup();
    fake.plant('tenant-a', { context: ctx, tags });
    expect(fake.live('tenant-a').length).toBe(2);
    await store.delete(key);
    expect(fake.live('tenant-a')).toEqual([]);
  });

  it('refuses, deleting nothing, when a file with our exact context has no ownership tag (a stranger\'s or an older convention)', async () => {
    const { store, fake, key, ctx } = await setup();
    const stranger = fake.plant('tenant-a', { context: ctx, tags: null });
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    expect(stranger.deletedAt).toBeNull();
    expect(fake.live('tenant-a').length).toBe(2);
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('refuses when the tag names another blob or another namespace', async () => {
    for (const tags of [{ owner: 'framer-models', blob: `served/${'f'.repeat(64)}` }, { owner: 'someone-else', blob: '' }]) {
      const { store, fake, key, ctx } = await setup();
      fake.plant('tenant-a', { context: ctx, tags: { ...tags, blob: tags.blob || key } });
      expect((await refusal(store.delete(key))).code).toBe('ambiguous');
      expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    }
  });

  it('refuses when a same-context file is of a non-model type', async () => {
    const { store, fake, key, ctx, tags } = await setup();
    fake.plant('tenant-a', { context: ctx, tags, fileType: 'application/pdf' });
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('refuses on a malformed listing entry, a duplicate id, or a total that does not match', async () => {
    const { store, fake, key } = await setup();
    const listing = (mutate: (body: { files: unknown[]; total: number }) => void) => fault({
      when: (r) => r.url.includes('/api/v1/files?'), times: 1,
      respond: async () => {
        const res = await fake.rawFetch(`${BASE}/api/v1/files?context=${encodeURIComponent(`framer-models/${key}`)}&limit=100`, { headers: { authorization: `Bearer ${KEY_A}` } });
        const body = (await res.json()) as { files: unknown[]; total: number };
        mutate(body);
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    fake.faults = [listing((b) => { b.files.push({ id: 'not-a-uuid' }); })];
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    fake.faults = [listing((b) => { b.files.push(b.files[0]); b.total += 1; })];
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    fake.faults = [listing((b) => { b.total += 3; })];
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(fake.live('tenant-a').length).toBe(1);
  });

  it('refuses when a listed file\'s context differs from the one asked for', async () => {
    const { store, fake, key } = await setup();
    fake.faults = [fault({ when: (r) => r.url.includes('/api/v1/files?'), times: 1, respond: async () => {
      const f = fake.live('tenant-a')[0];
      return new Response(JSON.stringify({ files: [{ id: f.id, context: 'someone-else/thing', tags: f.tags, fileType: f.fileType, sizeBytes: f.sizeBytes, processingStatus: 'completed', createdAt: new Date(f.createdAt).toISOString() }], nextCursor: null, total: 1 }), { status: 200 });
    } })];
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('never deletes a file of another tenant or another namespace sharing the tenant', async () => {
    const { store, fake, key } = await setup();
    const other = fake.plant('tenant-a', { context: `other-app/${key}`, tags: { owner: 'other-app', blob: key } });
    const foreign = fake.plant('tenant-b', { context: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key } });
    await store.delete(key);
    expect(other.deletedAt).toBeNull();
    expect(foreign.deletedAt).toBeNull();
  });

  it('treats a 404 on delete as done, and surfaces any other delete failure without hiding it', async () => {
    const { store, fake, key } = await setup();
    fake.faults = [fault({ when: (r) => r.method === 'DELETE', times: 1, respond: () => new Response('{}', { status: 404 }) })];
    await store.delete(key);
    const { store: s2, fake: f2, key: k2 } = await setup();
    f2.faults = [fault({ when: (r) => r.method === 'DELETE', respond: () => new Response('{}', { status: 400 }) })];
    expect((await refusal(s2.delete(k2))).code).toBe('bad-response');
    void fake;
  });
});

describe('pagination', () => {
  it('follows every page of a long listing', async () => {
    const { store, fake } = world();
    fake.pageLimit = 2;
    const b = glb('pages');
    const key = served(b);
    for (let i = 0; i < 5; i++) fake.plant('tenant-a', { context: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key }, bytes: glb(`x${i}`), sizeBytes: 80 });
    await store.put(key, b);
    const pages = fake.calls.filter((c) => c.path === '/api/v1/files').length;
    expect(pages).toBeGreaterThan(2);
    await store.delete(key);
    expect(fake.live('tenant-a')).toEqual([]);
  });

  it('notices rows skipped by a timestamp tie at a page boundary and refuses to delete on that incomplete picture', async () => {
    const { store, fake } = world();
    fake.sameTimestamp = true;
    fake.pageLimit = 2;
    const b = glb('tie');
    const key = served(b);
    for (let i = 0; i < 5; i++) fake.plant('tenant-a', { context: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key }, bytes: glb(`t${i}`), sizeBytes: 80 });
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    expect(fake.live('tenant-a').length).toBe(5);
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('gives up on an endless cursor instead of looping', async () => {
    const { store, fake } = world();
    const key = served(glb('loop'));
    fake.faults = [fault({ when: (r) => r.url.includes('/api/v1/files?'), respond: () => new Response(JSON.stringify({ files: [], nextCursor: 'AAAA', total: 0 }), { status: 200 }) })];
    expect((await refusal(store.delete(key))).code).toBe('ambiguous');
    expect(fake.calls.filter((c) => c.path === '/api/v1/files').length).toBeLessThanOrEqual(20);
  });
});

describe('partial uploads and retries', () => {
  it('removes the row it created when the PUT is cut off, and starts over once', async () => {
    const { store, fake } = world();
    fake.cutNextPut = true;
    const b = glb('cut');
    await store.put(served(b), b);
    expect(await store.get(served(b))).toEqual(b);
    const rows = [...fake.files.values()];
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.deletedAt === null).map((r) => r.processingStatus)).toEqual(['completed']);
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(2);
  });

  it('gives up after two attempts, leaves no row of its own behind and says the upload failed', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: (r) => r.method === 'PUT', respond: () => new Response('{}', { status: 500 }) })];
    const e = await refusal(store.put(served(glb('fail')), glb('fail')));
    expect(e.code).toBe('unavailable');
    expect(fake.live('tenant-a')).toEqual([]);
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(2);
  });

  it('never retries the handshake blindly: a quota refusal stops at once and creates nothing', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: (r) => r.url.endsWith('/upload/request'), respond: () => new Response('{}', { status: 413 }) })];
    expect((await refusal(store.put(served(glb('q')), glb('q')))).code).toBe('quota');
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(1);
  });

  it('does not take an upload for stored until the service says it is completed with the right size', async () => {
    const { store, fake } = world();
    const b = glb('conf');
    let n = 0;
    fake.faults = [fault({ when: (r) => /\/api\/v1\/files\/[0-9a-f-]{36}$/.test(new URL(r.url).pathname) && r.method === 'GET' && n++ === 0, times: 1, respond: () => new Response(JSON.stringify({ id: [...fake.files.keys()][0], context: 'x', tags: null, fileType: 'model/gltf-binary', sizeBytes: 1, processingStatus: 'completed', createdAt: new Date().toISOString() }), { status: 200 }) })];
    await store.put(served(b), b);
    expect(await store.get(served(b))).toEqual(b);
  });

  it('refuses an upload address that is absolute or odd, sending the bytes nowhere, and removes its row', async () => {
    for (const address of ['https://evil.invalid/_internal/upload/x', '//evil.invalid/_internal/upload/x', '/other/path', '/_internal/upload/../../x', '/_internal/upload//x']) {
      const { store, fake } = world();
      fake.absolutePresigned = address;
      const b = glb('abs');
      expect((await refusal(store.put(served(b), b))).code, address).toBe('bad-response');
      expect(fake.calls.some((c) => c.method === 'PUT'), address).toBe(false);
      expect(fake.live('tenant-a'), address).toEqual([]);
    }
  });

  it('retries reads on network errors, 429 and 5xx with back-off, and then gives up', async () => {
    const { store, fake, sleeps } = world();
    fake.faults = [fault({ when: (r) => r.url.includes('/api/v1/files?'), times: 2, respond: () => new Response('{}', { status: 503 }) })];
    expect(await store.has(`served/${'a'.repeat(64)}`)).toBe(false);
    expect(sleeps).toEqual([200, 400]);
    fake.faults = [fault({ when: () => true, respond: () => new Response('{}', { status: 503 }) })];
    expect((await refusal(store.has(`served/${'a'.repeat(64)}`))).code).toBe('unavailable');
    fake.faults = [fault({ when: () => true, respond: () => { throw new TypeError('socket hang up https://secret-address.invalid/?token=ABC'); } })];
    const e = await refusal(store.has(`served/${'a'.repeat(64)}`));
    expect(e.code).toBe('unavailable');
    expect(e.message).not.toMatch(/secret-address|token|ABC/);
  });

  it('does not retry the PUT itself (a claimed session answers 409 on a repeat)', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: (r) => r.method === 'PUT', times: 1, respond: () => { throw new TypeError('reset'); } })];
    const b = glb('put');
    await store.put(served(b), b);
    // The first PUT died; the whole upload restarted from a fresh handshake rather than repeating the PUT.
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(2);
    expect(await store.get(served(b))).toEqual(b);
  });

  it('times a stalled request out instead of waiting for ever', async () => {
    const fake = new FakeStorageBrain({ [KEY_A]: 'tenant-a' });
    const never: typeof fetch = (_i, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    const s = new StorageBrainBlobStore({ baseUrl: BASE, apiKey: KEY_A, fetch: never, sleep: async () => undefined, timeoutMs: 30 });
    expect((await refusal(s.has(`served/${'a'.repeat(64)}`))).code).toBe('unavailable');
    void fake;
  });
});

describe('review findings', () => {
  it('maps the real service\'s exhausted quota (403 QUOTA_EXCEEDED) to quota, not to bad credentials, and creates nothing', async () => {
    const { store, fake } = world();
    fake.quotaExhausted = true;
    const e = await refusal(store.put(served(glb('q403')), glb('q403')));
    expect(e.code).toBe('quota');
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(1);
    expect(fake.files.size).toBe(0);
  });

  it('still reads a plain 403 as refused credentials', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: () => true, respond: () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 }) })];
    expect((await refusal(store.has(`served/${'a'.repeat(64)}`))).code).toBe('unauthorized');
  });

  it('honours Retry-After on a 429 instead of backing off for a few hundred milliseconds', async () => {
    const { store, fake, sleeps } = world();
    fake.faults = [fault({ when: (r) => r.url.includes('/api/v1/files?'), times: 1, respond: () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) })];
    expect(await store.has(`served/${'a'.repeat(64)}`)).toBe(false);
    expect(sleeps).toEqual([30_000]);
    fake.faults = [fault({ when: (r) => r.url.includes('/api/v1/files?'), times: 1, respond: () => new Response('{}', { status: 429, headers: { 'retry-after': '99999' } }) })];
    await store.has(`served/${'a'.repeat(64)}`);
    expect(sleeps.at(-1)).toBe(65_000);
  });

  it('a body that fails part way is "unavailable", never "not found" (so no duplicate upload follows)', async () => {
    const { store, fake } = world();
    const b = glb('mid');
    await store.put(served(b), b);
    const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.error(new TypeError('reset')); } }), { status: 200 });
    fake.faults = [fault({ when: (r) => r.url.endsWith('/download'), respond: broken })];
    expect((await refusal(store.get(served(b)))).code).toBe('unavailable');
    fake.faults = [fault({ when: (r) => r.url.includes('/api/v1/files?'), respond: broken })];
    expect((await refusal(store.has(served(b)))).code).toBe('unavailable');
  });

  it('never repeats the handshake after a time-out (it may have committed): one handshake, an error, no second reservation', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: (r) => r.url.endsWith('/upload/request'), times: 1, respond: () => { throw new TypeError('timed out'); } })];
    expect((await refusal(store.put(served(glb('hs')), glb('hs')))).code).toBe('unavailable');
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(1);
  });

  it('stops, without a second attempt, when the half-written file cannot be removed, and says so', async () => {
    const { store, fake } = world();
    fake.faults = [
      fault({ when: (r) => r.method === 'PUT', respond: () => new Response('{}', { status: 500 }) }),
      fault({ when: (r) => r.method === 'DELETE', respond: () => new Response('{}', { status: 503 }) }),
    ];
    const e = await refusal(store.put(served(glb('cl')), glb('cl')));
    expect(e.message).toMatch(/could not be removed/);
    expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length).toBe(1);
  });

  it('restarts with a fresh handshake when the upload session expired or was already claimed (410, 409)', async () => {
    for (const status of [410, 409]) {
      const { store, fake } = world();
      fake.faults = [fault({ when: (r) => r.method === 'PUT', times: 1, respond: () => new Response('{}', { status }) })];
      const b = glb(`st${status}`);
      await store.put(served(b), b);
      expect(await store.get(served(b)), String(status)).toEqual(b);
      expect(fake.calls.filter((c) => c.path === '/api/v1/upload/request').length, String(status)).toBe(2);
    }
  });

  it('refuses an upload address that is not exactly this file\'s own path (encoded dots, other file, injected query or control characters)', async () => {
    const hash = 'a'.repeat(64);
    const good = (id: string, tail = `?token=${TOKEN}&expires=1700000000000`) => `/_internal/upload/tenants%2Ftenant-a%2Ffiles%2F${id}%2F${hash}.glb${tail}`;
    const cases = [
      '/_internal/upload/%2e%2e/%2e%2e/api/v1/files',
      '/_internal/upload/%2E%2E%2Fsecret',
      good(randomUUID()),
      good(randomUUID(), `?token=${TOKEN}&expires=1700000000000&x=1`),
      good(randomUUID(), `?token=${TOKEN}&expires=1700000000000#frag`),
      `${good(randomUUID())}\t`,
      `/_internal/upload/tenants%2Ftenant-a%2Ffiles%2F${randomUUID()}%2F${hash}.exe?token=${TOKEN}&expires=1700000000000`,
    ];
    for (const address of cases) {
      const { store, fake } = world();
      fake.absolutePresigned = address;
      const b = glb('ps');
      const e = await refusal(store.put(`served/${sha(b)}`, b));
      expect(e.code, address).toBe('bad-response');
      expect(fake.calls.some((c) => c.method === 'PUT'), address).toBe(false);
      expect(fake.live('tenant-a'), address).toEqual([]);
    }
  });

  it('accepts a compressed download whose Content-Length is the compressed size, by size and hash alone', async () => {
    const { store, fake } = world();
    const b = glb('gz');
    await store.put(served(b), b);
    fake.faults = [fault({ when: (r) => r.url.endsWith('/download'), respond: () => new Response(b, { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '3' } }) })];
    expect(await store.get(served(b))).toEqual(b);
  });

  it('has() says a copy is listed; get() is what verifies it', async () => {
    const { store, fake } = world();
    const key = served(glb('hv'));
    fake.plant('tenant-a', { context: `framer-models/${key}`, tags: { owner: 'framer-models', blob: key }, bytes: glb('swapped'), sizeBytes: 80 });
    expect(await store.has(key)).toBe(true);
    expect(await store.get(key)).toBeNull();
  });
});

describe('where the key may travel', () => {
  it('sends the Bearer key to the origin only, no redirects, and never on the PUT', async () => {
    const { store, fake } = world();
    const b = glb('hdr');
    await store.put(served(b), b);
    await store.get(served(b));
    for (const c of fake.calls) {
      if (c.method === 'PUT') expect(c.authorization, 'the PUT carries no key').toBeNull();
      else expect(c.authorization).toBe(`Bearer ${KEY_A}`);
      expect(c.redirect).toBe('error');
    }
  });

  it('never puts the key or a signed address in an error message', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: (r) => r.method === 'PUT', respond: () => new Response('{}', { status: 403 }) })];
    const e = await refusal(store.put(served(glb('leak')), glb('leak')));
    expect(`${e.message} ${e.stack ?? ''}`).not.toMatch(new RegExp(`${KEY_A}|${TOKEN}|token=`));
  });

  it('does not follow a redirect (the real fetch refuses it with redirect: error)', async () => {
    const { store, fake } = world();
    fake.faults = [fault({ when: () => true, respond: () => { throw new TypeError('redirect mode is set to error'); } })];
    expect((await refusal(store.has(`served/${'a'.repeat(64)}`))).code).toBe('unavailable');
  });
});

describe('answers are parsed strictly and bounded', () => {
  it('refuses non-JSON, malformed and oversize answers', async () => {
    const key = `served/${'a'.repeat(64)}`;
    for (const body of ['not json', '{"files":"no"}', '[]', 'x'.repeat(2 * 1024 * 1024)]) {
      const { store, fake } = world();
      fake.faults = [fault({ when: () => true, respond: () => new Response(body, { status: 200 }) })];
      expect((await refusal(store.has(key))).code, body.slice(0, 20)).toBe('bad-response');
    }
  });
});

describe('listing for the orphan sweep', () => {
  it('lists only our own well-formed keys under a prefix, with when each was written', async () => {
    const { store, fake } = world();
    const [a, b] = [glb('l1'), glb('l2')];
    await store.put(served(a), a);
    await store.put(original(b), b);
    fake.plant('tenant-a', { context: 'other-app/served/xyz' });
    fake.plant('tenant-a', { context: `framer-models/served/${'Z'.repeat(64)}` });
    fake.plant('tenant-b', { context: `framer-models/served/${'b'.repeat(64)}` });
    expect((await store.list('served/')).map((x) => x.key)).toEqual([served(a)]);
    expect((await store.list('original/')).map((x) => x.key)).toEqual([original(b)]);
    expect((await store.list('')).map((x) => x.key).sort()).toEqual([served(a), original(b)].sort());
    expect((await store.list('served/'))[0].createdAt).toBeInstanceOf(Date);
    expect((await refusal(store.list('../'))).code).toBe('invalid-key');
  });
});
