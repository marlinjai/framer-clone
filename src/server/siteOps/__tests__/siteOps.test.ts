// @vitest-environment node
//
// The site operations library with the repository, the audit table, the cache
// and the model mocked: permissions are checked before anything is read or
// written, a stale version and a refused batch write nothing and leave no audit
// row, a successful write saves on the version it read and audits the actor,
// publish and rollback mirror the editor's routes, the stock photo key never
// leaves the server, and generatePage runs the editor's generator under its rate
// limit and saves the result through the version lock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, isStateTreeNode } from 'mobx-state-tree';

const audits = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({
    siteOperationAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => audits.rows.push(data)) },
  }),
}));
const cache = vi.hoisted(() => ({ sites: [] as string[], customHosts: [] as string[] }));
vi.mock('@/server/sites/cachedResolver', () => ({
  revalidateSiteCache: (subdomain: string) => cache.sites.push(subdomain),
  revalidateCustomHostsForSiteId: async (siteId: string) => {
    cache.customHosts.push(siteId);
    return [];
  },
}));
const commerce = vi.hoisted(() => ({ outcome: { ok: true } as Record<string, unknown>, calls: [] as unknown[] }));
vi.mock('@/server/sites/companyCommerce', () => ({
  ensureCompanyCommerce: async (...args: unknown[]) => {
    commerce.calls.push(args);
    return commerce.outcome;
  },
}));

import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { SiteChangedError, SiteNotFoundError, type SiteRepository } from '@/server/sites';
import { __resetPageGenRateLimiterForTests, getPageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { __resetStockImageCacheForTests, __resetStockOffersForTests } from '@/lib/ai/pageGen/stockImages';
import type { SiteOpsCaller } from '@/lib/siteOps/types';
import { publishSiteEvent, resetLiveBusForTests, subscribeSite } from '@/server/sites/liveBus';
import { generationSnapshot, resetLiveGenerationForTests } from '@/server/sites/liveGeneration';
import {
  applyBatch,
  createSite,
  describeVocabulary,
  findImages,
  generatePage,
  getPage,
  getSite,
  listRevisions,
  listSites,
  previewUrl,
  publish,
  rollback,
} from '..';

const scope = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };

function caller(allowed: string[] = ['viewSite', 'editSite', 'publishSite']): SiteOpsCaller {
  return {
    scope,
    companyId: 'tenant-a',
    companySlug: 'bakery',
    actor: { kind: 'key', id: 'key_1' },
    actorDetail: { serviceAccountId: 'sa_1' },
    can: (action) => allowed.includes(action),
  };
}

function storedProject(): ProjectModelType {
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: {
          id: 'root', type: 'div', componentType: 'host', props: {}, children: [
            { id: 'title', type: 'h1', componentType: 'host', parentId: 'root', props: { children: 'Fresh bread' }, children: [] },
          ],
        },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

/** A repository holding one site at `version`, recording what is written. */
function fakeRepository(version = 3) {
  const state = { version, saved: [] as Array<{ snapshot: unknown; options: Record<string, unknown> }>, published: [] as Array<Record<string, unknown>>, rolledBack: [] as number[] };
  const repository = {
    listSites: vi.fn(async () => [
      { siteId: 'site-1', name: 'Bakery', description: '', status: 'draft', lumitraEnabled: false, createdAt: new Date(0), updatedAt: new Date(0), subdomain: null, customDomains: [] },
    ]),
    loadProjectWithVersion: vi.fn(async (_scope: unknown, siteId: string) => {
      if (siteId !== 'site-1') throw new SiteNotFoundError(siteId);
      return { project: storedProject(), version: state.version };
    }),
    saveProject: vi.fn(async (_scope: unknown, project: ProjectModelType, options: Record<string, unknown>) => {
      if (options.expectedVersion !== undefined && options.expectedVersion !== state.version) throw new SiteChangedError(state.version);
      state.saved.push({ snapshot: isStateTreeNode(project) ? getSnapshot(project) : project, options });
      state.version = options.expectedVersion === undefined ? 1 : state.version + 1;
      // As the repository does: the pre-announcement step, then the announcement.
      (options.beforeAnnounce as ((v: number) => void) | undefined)?.(state.version);
      publishSiteEvent('site-1', 'site:version', { version: state.version });
      return { version: state.version };
    }),
    publishProject: vi.fn(async (_scope: unknown, _project: unknown, options: Record<string, unknown>) => {
      if (options.expectedVersion !== state.version) throw new SiteChangedError(state.version);
      state.published.push(options);
      state.version += 1;
      return { revision: 7, version: state.version };
    }),
    ensureSiteDomain: vi.fn(async () => ({ subdomain: 'abc123' })),
    getSiteAddress: vi.fn(async () => ({ host: 'abc123.sites.example', everPublished: true })),
    listRevisions: vi.fn(async () => ({ live: 7, status: 'published', revisions: [] })),
    rollbackToRevision: vi.fn(async (_scope: unknown, _siteId: string, number: number) => {
      state.rolledBack.push(number);
    }),
  };
  return { repository: repository as unknown as SiteRepository, state, mock: repository };
}

beforeEach(() => {
  audits.rows = [];
  cache.sites = [];
  cache.customHosts = [];
  commerce.outcome = { ok: true };
  commerce.calls = [];
  __resetPageGenRateLimiterForTests();
  __resetStockImageCacheForTests();
  __resetStockOffersForTests();
  resetLiveBusForTests();
  resetLiveGenerationForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe('permissions', () => {
  it('refuses every operation the caller may not do, before reading anything', async () => {
    const { repository, mock } = fakeRepository();
    const viewer = caller(['viewSite']);
    expect((await applyBatch(viewer, { siteId: 'site-1', expectedVersion: 3, ops: [{ op: 'removeNode', nodeId: 'title' }] }, { repository })).ok).toBe(false);
    const pub = await publish(viewer, { siteId: 'site-1', expectedVersion: 3 }, { repository });
    expect(pub.ok ? null : pub.error.code).toBe('forbidden');
    expect((await rollback(viewer, { siteId: 'site-1', number: 1 }, { repository })).ok).toBe(false);
    expect((await createSite(viewer, {}, { repository })).ok).toBe(false);
    expect(mock.loadProjectWithVersion).not.toHaveBeenCalled();
    const nobody = caller([]);
    const listed = await listSites(nobody, { repository });
    expect(listed.ok ? null : listed.error.code).toBe('forbidden');
  });

  it('answers unavailable when the permission check itself fails', async () => {
    const { repository } = fakeRepository();
    const broken: SiteOpsCaller = { ...caller(), can: () => Promise.reject(new Error('openfga down')) };
    const result = await getSite(broken, { siteId: 'site-1' }, { repository });
    expect(result.ok ? null : result.error.code).toBe('unavailable');
  });
});

describe('reads', () => {
  it('lists sites, shows a site with its version and pages, and outlines a page', async () => {
    const { repository } = fakeRepository(3);
    const listed = await listSites(caller(), { repository });
    expect(listed.ok && listed.value[0].siteId).toBe('site-1');
    const site = await getSite(caller(), { siteId: 'site-1' }, { repository });
    expect(site.ok).toBe(true);
    if (!site.ok) return;
    expect(site.value.version).toBe(3);
    expect(site.value.pages[0]).toMatchObject({ id: 'home', isHome: true });
    expect(site.value.pages[0].breakpoints.map((b) => b.key)).toEqual(['desktop', 'tablet', 'mobile']);
    expect(site.value.address).toBe('https://abc123.sites.example');
    const page = await getPage(caller(), { siteId: 'site-1', pageId: 'home' }, { repository });
    expect(page.ok && page.value.nodes.map((n) => n.id)).toEqual(['root', 'title']);
    const missing = await getPage(caller(), { siteId: 'site-1', pageId: 'nope' }, { repository });
    expect(missing.ok ? null : missing.error.code).toBe('page_not_found');
  });

  it('treats a site outside the scope as missing', async () => {
    const { repository } = fakeRepository();
    const result = await getSite(caller(), { siteId: 'other-tenant-site' }, { repository });
    expect(result.ok ? null : result.error.code).toBe('site_not_found');
  });

  it('describes the vocabulary, with the site parts when a site is named', async () => {
    const { repository } = fakeRepository();
    const plain = await describeVocabulary(caller(), {}, { repository });
    expect(plain.ok && plain.value.generationFormat.length).toBeGreaterThan(1000);
    expect(plain.ok && plain.value.operations).toMatch(/insertNodes/);
    const withSite = await describeVocabulary(caller(), { siteId: 'site-1' }, { repository });
    expect(withSite.ok && withSite.value.site?.pages[0].breakpoints[0].key).toBe('desktop');
  });
});

describe('applyBatch', () => {
  const batch = (ops: unknown[], expectedVersion = 3) => ({ siteId: 'site-1', expectedVersion, ops });

  it('saves on the version it read, returns the new one and audits the actor', async () => {
    const { repository, state } = fakeRepository(3);
    const result = await applyBatch(caller(), batch([
      { op: 'insertNodes', pageId: 'home', nodes: [{ ref: 'cta', type: 'section', children: [{ type: 'p', props: { children: 'Hi' } }] }] },
      { op: 'updateText', nodeId: 'title', text: 'Bread since 1920' },
    ]), { repository });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(4);
    expect(result.value.created.cta).toMatch(/^section-/);
    expect(state.saved[0].options).toMatchObject({ expectedVersion: 3, mustExist: true, companyId: 'tenant-a' });
    expect(audits.rows).toEqual([
      expect.objectContaining({
        siteId: 'site-1', workspaceId: 'ws_a', actorKind: 'key', actorId: 'key_1', operation: 'batch',
        // The ids the batch created ride in the detail, apart from `ops` (the change count stays the batch's).
        actorDetail: { serviceAccountId: 'sa_1', createdNodeIds: [expect.any(String)] }, versionBefore: 3, versionAfter: 4,
        ops: [{ op: 'insertNodes', pageId: 'home' }, { op: 'updateText', nodeId: 'title' }],
      }),
    ]);
  });

  it('refuses a stale version before applying anything', async () => {
    const { repository, state } = fakeRepository(5);
    const result = await applyBatch(caller(), batch([{ op: 'updateText', nodeId: 'title', text: 'x' }], 3), { repository });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'site_changed', currentVersion: 5 });
    expect(state.saved).toHaveLength(0);
    expect(audits.rows).toHaveLength(0);
  });

  it('answers site_changed when another write lands between the read and the save', async () => {
    const { repository, state, mock } = fakeRepository(3);
    mock.saveProject.mockImplementationOnce(async () => {
      throw new SiteChangedError(4);
    });
    const result = await applyBatch(caller(), batch([{ op: 'updateText', nodeId: 'title', text: 'Mine' }]), { repository });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'site_changed', currentVersion: 4 });
    expect(state.saved).toHaveLength(0);
    expect(audits.rows).toHaveLength(0);
  });

  it('writes nothing for a refused batch and names each refusal', async () => {
    const { repository, state } = fakeRepository(3);
    const result = await applyBatch(caller(), batch([
      { op: 'updateText', nodeId: 'title', text: 'Fine' },
      { op: 'insertNodes', pageId: 'home', nodes: [{ type: 'iframe', props: { src: 'https://evil.example' } }] },
    ]), { repository });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rejected');
    if (result.error.code !== 'rejected') return;
    expect(result.error.rejected[0]).toMatchObject({ index: 1, op: 'insertNodes' });
    expect(result.error.rejected[0].reason).toMatch(/iframe/);
    expect(state.saved).toHaveLength(0);
    expect(audits.rows).toHaveLength(0);
  });

  it('refuses a malformed batch with the issues', async () => {
    const { repository } = fakeRepository();
    const result = await applyBatch(caller(), { siteId: 'site-1', ops: [] }, { repository });
    expect(result.ok ? null : result.error.code).toBe('invalid_request');
  });
});

describe('createSite', () => {
  it('provisions the company shop first, then saves an empty draft and audits it', async () => {
    const { repository, state } = fakeRepository();
    const result = await createSite(caller(), { name: 'Landing' }, { repository });
    expect(result.ok).toBe(true);
    expect(commerce.calls).toEqual([['tg_a', 'bakery']]);
    expect(state.saved[0].options).toEqual({ companyId: 'tenant-a' });
    const snapshot = state.saved[0].snapshot as { metadata: { title: string }; pages: Record<string, { slug: string; canvasNodes: object }> };
    expect(snapshot.metadata.title).toBe('Landing');
    const [home] = Object.values(snapshot.pages);
    expect(home.slug).toBe('');
    expect(Object.keys(home.canvasNodes)).toHaveLength(3);
    expect(audits.rows[0]).toMatchObject({ operation: 'create_site', versionAfter: 1 });
  });

  it('writes nothing when the shop cannot be provisioned', async () => {
    const { repository, state } = fakeRepository();
    commerce.outcome = { ok: false, code: 'commerce_busy', message: 'busy', status: 503, retryAfterSec: 10 };
    const result = await createSite(caller(), {}, { repository });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'unavailable', retryAfterSec: 10 });
    expect(state.saved).toHaveLength(0);
  });
});

describe('publish, revisions and rollback', () => {
  it('publishes on the version read, records the key as the author and refreshes the caches', async () => {
    const { repository, state } = fakeRepository(3);
    const result = await publish(caller(), { siteId: 'site-1', expectedVersion: 3 }, { repository, publicBaseHost: 'sites.example' });
    expect(result.ok && result.value).toEqual({ siteId: 'site-1', revision: 7, version: 4, subdomain: 'abc123', liveUrl: 'https://abc123.sites.example' });
    expect(state.published[0]).toMatchObject({ publishedBy: 'key:key_1', expectedVersion: 3, companyId: 'tenant-a' });
    expect(cache.sites).toEqual(['abc123']);
    expect(cache.customHosts).toEqual(['site-1']);
    expect(audits.rows[0]).toMatchObject({ operation: 'publish', revision: 7, versionAfter: 4 });
  });

  it('refuses to publish a version the caller did not read', async () => {
    const { repository, state } = fakeRepository(4);
    const result = await publish(caller(), { siteId: 'site-1', expectedVersion: 3 }, { repository });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'site_changed', currentVersion: 4 });
    expect(state.published).toHaveLength(0);
  });

  it('reports the written version when a step after the publish fails', async () => {
    const { repository, mock } = fakeRepository(3);
    mock.ensureSiteDomain.mockRejectedValueOnce(new Error('address allocation failed'));
    const result = await publish(caller(), { siteId: 'site-1', expectedVersion: 3 }, { repository });
    expect(result.ok ? null : result.error).toMatchObject({ code: 'failed', writtenVersion: 4 });
  });

  it('lists revisions and rolls back with the same cache refresh', async () => {
    const { repository, state } = fakeRepository();
    const list = await listRevisions(caller(), { siteId: 'site-1' }, { repository });
    expect(list.ok && list.value.live).toBe(7);
    const result = await rollback(caller(), { siteId: 'site-1', number: 5 }, { repository });
    expect(result.ok && result.value).toEqual({ siteId: 'site-1', live: 5 });
    expect(state.rolledBack).toEqual([5]);
    expect(cache.sites).toEqual(['abc123']);
    expect(audits.rows[0]).toMatchObject({ operation: 'rollback', revision: 5 });
    const bad = await rollback(caller(), { siteId: 'site-1', number: 0 }, { repository });
    expect(bad.ok ? null : bad.error.code).toBe('revision_not_found');
  });

  it('builds the preview link on the editor host', async () => {
    const { repository } = fakeRepository();
    const url = await previewUrl(caller(), { siteId: 'site-1', pageId: 'home' }, { repository, editorHost: 'app.lumitra.co' });
    expect(url.ok && url.value.url).toBe('https://app.lumitra.co/projects/site-1/preview?page=home');
    const missing = await previewUrl(caller(), { siteId: 'site-1', pageId: 'nope' }, { repository, editorHost: 'app.lumitra.co' });
    expect(missing.ok).toBe(false);
  });
});

describe('findImages', () => {
  const photo = (id: string) => ({
    id,
    urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=1`, regular: `https://images.unsplash.com/photo-${id}?w=1080` },
    user: { name: 'Ana Baker', links: { html: 'https://unsplash.com/@ana' } },
    links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
    alt_description: 'a loaf of bread',
  });

  it('returns credited photos ready to place and never the key', async () => {
    const secret = ['unit', 'test', 'access', 'value'].join('-');
    vi.stubEnv('UNSPLASH_ACCESS_KEY', secret);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [photo('a1'), photo('b2')] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await findImages(caller(), { query: 'sourdough bread', count: 2, widthPx: 600 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.photos).toHaveLength(2);
      const [first] = result.value.photos;
      expect(first.imgProps.src).toMatch(/^https:\/\/images\.unsplash\.com\/photo-a1/);
      expect(first.imgProps['data-credit-name']).toBe('Ana Baker');
      expect(first.description).toBe('a loaf of bread');
      expect(JSON.stringify(result.value)).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('counts the download when a write places an offered photo, not when it is listed', async () => {
    vi.stubEnv('UNSPLASH_ACCESS_KEY', ['unit', 'test', 'value'].join('-'));
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/search/') ? new Response(JSON.stringify({ results: [photo('c3')] }), { status: 200 }) : new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const found = await findImages(caller(), { query: 'rye bread' });
      if (!found.ok) throw new Error('search failed');
      const downloads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/download'));
      expect(downloads()).toHaveLength(0);
      const { repository } = fakeRepository(3);
      const result = await applyBatch(caller(), {
        siteId: 'site-1',
        expectedVersion: 3,
        ops: [{ op: 'insertNodes', pageId: 'home', nodes: [{ type: 'img', props: { alt: 'Rye bread', ...found.value.photos[0].imgProps } }] }],
      }, { repository });
      expect(result.ok).toBe(true);
      await vi.waitFor(() => expect(downloads()).toHaveLength(1));
      expect(String(downloads()[0][0])).toBe('https://api.unsplash.com/photos/c3/download');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says when stock photos are not configured', async () => {
    vi.stubEnv('UNSPLASH_ACCESS_KEY', '');
    const result = await findImages(caller(), { query: 'bread' });
    expect(result.ok ? null : result.error.code).toBe('unavailable');
  });
});

describe('generatePage', () => {
  const page = {
    title: 'Menu',
    description: 'What we bake',
    nodes: [
      { type: 'section', label: 'Hero', children: [
        { type: 'h1', props: { children: 'Our bread' } },
        { type: 'button', props: { children: 'Order now' } },
      ] },
    ],
  };
  function scriptedAnthropic(input: unknown) {
    return () =>
      ({
        beta: {
          messages: {
            stream: () => ({
              on() {
                return this;
              },
              currentMessage: undefined,
              finalMessage: async () => ({
                content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_page', input }],
                stop_reason: 'tool_use',
                stop_details: null,
                usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              }),
            }),
          },
        },
      }) as never;
  }

  it('generates a new page and saves it on the version read', async () => {
    const { repository, state } = fakeRepository(3);
    const result = await generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'A menu page for a bakery', target: { kind: 'newPage', title: 'Menu' } },
      { repository, anthropic: scriptedAnthropic(page) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(4);
    const saved = state.saved[0].snapshot as { pages: Record<string, { metadata: { title: string }; appComponentTree: { children: unknown[] } }> };
    expect(saved.pages[result.value.pageId].metadata.title).toBe('Menu');
    expect(saved.pages[result.value.pageId].appComponentTree.children).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({ operation: 'generate_page', versionBefore: 3, versionAfter: 4 });
  });

  it('inserts a generated section into a page and keeps the generator repairs as warnings', async () => {
    const { repository } = fakeRepository(3);
    const section = { nodes: [{ type: 'div', props: { onclick: 'x', children: 'Hello there' } }] };
    const result = await generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'A greeting', target: { kind: 'insert', pageId: 'home' } },
      { repository, anthropic: scriptedAnthropic(section) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.insertedIds).toHaveLength(1);
    expect(result.value.warnings.join(' ')).toMatch(/onclick/);
  });

  it('refuses a stale version without calling the model, and holds the rate limit', async () => {
    const { repository } = fakeRepository(5);
    const anthropic = vi.fn(scriptedAnthropic(page));
    const stale = await generatePage(caller(), { siteId: 'site-1', expectedVersion: 3, brief: 'x', target: { kind: 'newPage' } }, { repository, anthropic });
    expect(stale.ok ? null : stale.error.code).toBe('site_changed');
    expect(anthropic).not.toHaveBeenCalled();

    const held = getPageGenRateLimiter().acquire('key:key_1');
    expect(held.ok).toBe(true);
    const busy = await generatePage(caller(), { siteId: 'site-1', expectedVersion: 5, brief: 'x', target: { kind: 'newPage' } }, { repository, anthropic });
    expect(busy.ok ? null : busy.error.code).toBe('rate_limited');
    if (held.ok) held.release();
  });

  // The model as a stream: the tool input arrives in fragments (as the SDK hands
  // them to the inputJson listener) before the final message; `gate` holds the
  // stream open until the test lets it finish, and the request's signal stops it.
  function streamingAnthropic(input: unknown, gate?: Promise<void>) {
    return () =>
      ({
        beta: {
          messages: {
            stream: (_params: unknown, options: { signal?: AbortSignal }) => {
              const listeners: Array<(fragment: string) => void> = [];
              const json = JSON.stringify(input);
              return {
                on(event: string, listener: (fragment: string) => void) {
                  if (event === 'inputJson') listeners.push(listener);
                  return this;
                },
                currentMessage: undefined,
                finalMessage: async () => {
                  for (let i = 0; i < json.length; i += 40) for (const listener of listeners) listener(json.slice(i, i + 40));
                  if (gate) {
                    await new Promise<void>((resolve, reject) => {
                      options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                      void gate.then(resolve);
                    });
                  }
                  return {
                    content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_page', input }],
                    stop_reason: 'tool_use',
                    stop_details: null,
                    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                  };
                },
              };
            },
          },
        },
      }) as never;
  }

  const outlined = {
    outline: [{ title: 'Hero', kind: 'hero' }, { title: 'Order', kind: 'cta' }],
    title: 'Menu',
    description: 'What we bake',
    nodes: [
      { type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Our bread' } }] },
      { type: 'section', label: 'Order', children: [{ type: 'p', props: { children: 'Order by noon for the next morning.' } }] },
    ],
  };

  function listen() {
    const heard: Array<[string, Record<string, unknown>]> = [];
    subscribeSite('site-1', (event, data) => heard.push([event, data as Record<string, unknown>]));
    return heard;
  }

  it("streams the draft to the site's editors and ends it before the version of its save", async () => {
    const heard = listen();
    const { repository } = fakeRepository(3);
    const result = await generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'A menu page for a bakery', target: { kind: 'newPage', title: 'Menu' } },
      { repository, anthropic: streamingAnthropic(outlined) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = heard.map(([event]) => event);
    expect(events[0]).toBe('gen:outline');
    expect(events.filter((e) => e === 'gen:section')).toHaveLength(2);
    // The draft ends at the saved version, before the announcement that makes an editor fetch it.
    expect(events.slice(-2)).toEqual(['gen:done', 'site:version']);
    const runIds = new Set(heard.filter(([e]) => e.startsWith('gen:')).map(([, d]) => d.runId));
    expect(runIds.size).toBe(1);
    const outline = heard.find(([e]) => e === 'gen:outline')![1];
    expect(outline.target).toEqual({ kind: 'newPage', title: 'Menu' });
    expect((outline.outline as unknown[]).length).toBe(2);
    // The model's context (the wire target's serialised subtree) never travels.
    expect(JSON.stringify(heard)).not.toContain('context');
    const done = heard.find(([e]) => e === 'gen:done')![1];
    expect(done).toMatchObject({ status: 'saved', version: 4, insertedIds: result.value.insertedIds });
    expect((done.drawnAs as unknown[]).length).toBe(result.value.insertedIds.length);
    expect(generationSnapshot('site-1', scope)).toBeUndefined();
  });

  it('names an insert by its resolved parent, and a reload mid-run gets the draft so far from the state', async () => {
    const heard = listen();
    const { repository } = fakeRepository(3);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const running = generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'Two sections', target: { kind: 'insert', pageId: 'home' } },
      { repository, anthropic: streamingAnthropic(outlined, gate) },
    );
    await vi.waitFor(() => expect(heard.filter(([e]) => e === 'gen:section')).toHaveLength(2));
    const snapshot = generationSnapshot('site-1', scope);
    expect(snapshot?.target).toEqual({ kind: 'insert', pageId: 'home', parentId: 'root' });
    expect(snapshot?.outline).toHaveLength(2);
    expect(snapshot?.sections.map((s) => s.index)).toEqual([0, 1]);
    // Another company's stream sees nothing of it.
    expect(generationSnapshot('site-1', { workspaceId: 'ws_b', tenantGroupId: 'tg_b' })).toBeUndefined();
    open();
    expect((await running).ok).toBe(true);
    expect(generationSnapshot('site-1', scope)).toBeUndefined();
  });

  it('a run stopped mid-generation (the MCP client went away) drops the draft, writes nothing and frees the slot', async () => {
    const heard = listen();
    const { repository, state } = fakeRepository(3);
    const controller = new AbortController();
    const running = generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'A menu', target: { kind: 'newPage' }, signal: controller.signal },
      { repository, anthropic: streamingAnthropic(outlined, new Promise(() => {})) },
    );
    await vi.waitFor(() => expect(heard.some(([e]) => e === 'gen:section')).toBe(true));
    controller.abort();
    const result = await running;
    expect(result.ok ? null : result.error.code).toBe('failed');
    expect(state.saved).toEqual([]);
    expect(audits.rows).toEqual([]);
    const done = heard.filter(([e]) => e === 'gen:done');
    expect(done).toHaveLength(1);
    expect(done[0][1]).toMatchObject({ status: 'stopped' });
    expect(done[0][1].version).toBeUndefined();
    expect(heard.some(([e]) => e === 'site:version')).toBe(false);
    expect(generationSnapshot('site-1', scope)).toBeUndefined();
    const again = getPageGenRateLimiter().acquire('key:key_1');
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
  });

  it('a failed model call and a refused save end the draft with their reason and write nothing', async () => {
    const heard = listen();
    const { repository, state } = fakeRepository(3);
    const failing = () =>
      ({
        beta: {
          messages: {
            stream: () => ({
              on() {
                return this;
              },
              currentMessage: undefined,
              finalMessage: async () => {
                throw Object.assign(new Error('boom'), { status: 500 });
              },
            }),
          },
        },
      }) as never;
    const failed = await generatePage(caller(), { siteId: 'site-1', expectedVersion: 3, brief: 'x', target: { kind: 'newPage' } }, { repository, anthropic: failing });
    expect(failed.ok).toBe(false);
    expect(heard.filter(([e]) => e === 'gen:done').map(([, d]) => d.status)).toEqual(['failed']);

    // The site moves on while the model writes: the save is refused.
    heard.length = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const running = generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'A menu', target: { kind: 'newPage' } },
      { repository, anthropic: streamingAnthropic(outlined, gate) },
    );
    await vi.waitFor(() => expect(heard.some(([e]) => e === 'gen:section')).toBe(true));
    state.version = 5;
    open();
    const changed = await running;
    expect(changed.ok ? null : changed.error.code).toBe('site_changed');
    expect(state.saved).toEqual([]);
    expect(heard.filter(([e]) => e === 'gen:done').map(([, d]) => d.status)).toEqual(['site_changed']);
  });

  it('a second generation on the site replaces the first one\'s draft', async () => {
    const heard = listen();
    const { repository } = fakeRepository(3);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const first = generatePage(
      caller(),
      { siteId: 'site-1', expectedVersion: 3, brief: 'First', target: { kind: 'newPage' } },
      { repository, anthropic: streamingAnthropic(outlined, gate) },
    );
    await vi.waitFor(() => expect(heard.some(([e]) => e === 'gen:section')).toBe(true));
    const firstRun = heard[0][1].runId;
    // Another key of the same company starts its own on the same site.
    const second = generatePage(
      { ...caller(), actor: { kind: 'key', id: 'key_2' } },
      { siteId: 'site-1', expectedVersion: 3, brief: 'Second', target: { kind: 'newPage' } },
      { repository, anthropic: streamingAnthropic(outlined, gate) },
    );
    await vi.waitFor(() => expect(heard.some(([e, d]) => e === 'gen:section' && d.runId !== firstRun)).toBe(true));
    expect(heard.find(([e, d]) => e === 'gen:done' && d.runId === firstRun)?.[1].status).toBe('superseded');
    expect(generationSnapshot('site-1', scope)?.runId).not.toBe(firstRun);
    open();
    await Promise.all([first, second]);
    // The superseded run's own end sends nothing more.
    expect(heard.filter(([e, d]) => e === 'gen:done' && d.runId === firstRun)).toHaveLength(1);
  });
});
