// src/app/site-images/__tests__/siteImages.itest.ts
//
// Uploaded site images against a REAL Postgres (the `20261103000000_site_images`
// migration applied by the integration globalSetup). The real route handlers,
// guard, repository, public resolver and head builders run; only the
// auth-brain boundary (the session verify and the OpenFGA check) and Next's
// request cache and headers are faked.
//
// Proofs:
//   1. upload: a PNG favicon is stored (201) and the same bytes again answer
//      the same row (200), one row per site and hash; a sharing image of an
//      odd shape is stored with warnings;
//   2. refusals: SVG, a type the kind does not take, more than 2 MB (with and
//      without a Content-Length), a bad kind, nothing stored for any of them;
//   3. the guard: no session 401, a member of another company 403, a member
//      without `editSite` 403, a published host 404;
//   4. the editor preview: the bytes privately, 304 on the hash, another
//      site's hash 404;
//   5. the public route: the bytes on the site's subdomain and custom domain,
//      immutable, with nosniff and a closed content security policy; 304; 404
//      on another site's host, on the editor host, for a wrong extension;
//   6. the published head: the icon relative, og:image and twitter:image
//      absolute on the primary host (the custom domain), the page's own image
//      before the site default, and the address resolves on that host;
//   7. a published revision keeps showing the image it was published with
//      after the settings are saved with another one.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';

// unstable_cache needs a running Next server; the site resolves uncached here.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
let requestHost = '';
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: requestHost }),
}));
// The (site) layout's stylesheet is a build input, not part of its metadata.
vi.mock('../../(site)/site.css', () => ({}));
vi.mock('@/lib/auth-api', () => ({ getVerifiedSession: vi.fn() }));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn() }));

import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { ico, icoWith, jpegHeader, png, pngHeader, svgText } from '@/lib/images/__tests__/fixtures';
import { MAX_SITE_IMAGE_BYTES } from '@/lib/site/siteImages';
import { GET as listGET, POST as uploadPOST } from '@/app/api/projects/[projectId]/images/route';
import { DELETE as editorDELETE, GET as editorGET } from '@/app/api/projects/[projectId]/images/[sha256]/route';
import { SiteImageError, storeSiteImage } from '@/server/sites/siteImages';
import { __resetUploadRateLimiterForTests } from '@/server/uploads/rateLimit';
import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';
import { GET as publicGET } from '../[file]/route';
import { generateMetadata as layoutMetadata } from '@/app/(site)/layout';
import { generateMetadata as pageMetadata } from '@/app/(site)/[...slug]/page';

const sessionMock = vi.mocked(getVerifiedSession);
const accessMock = vi.mocked(checkWorkspaceAccess);

const EDITOR = 'app.example.org';

interface TestSite {
  id: string;
  scope: TenantScope;
  companyId: string;
  host: string;
}

let prisma: PrismaClient;
let siteA: TestSite;
let siteB: TestSite;
let customHost: string;

function project(id: string, siteSettings: object = {}, aboutImage = '') {
  const page = (pageId: string, slug: string, ogImage = '') => ({
    id: pageId,
    slug,
    metadata: { title: pageId === 'home' ? 'Home' : 'About', ...(ogImage ? { ogImage } : {}) },
    appComponentTree: { id: `root-${pageId}`, type: 'div', componentType: 'host', props: {}, children: [] },
    canvasNodes: {},
  });
  return {
    id,
    metadata: { title: 'Image site', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: page('home', ''), about: page('about', 'about', aboutImage) },
    siteSettings,
  } as never;
}

const createdSites: string[] = [];

async function makeSite(label: string, options: { published?: boolean } = {}): Promise<TestSite> {
  const id = randomUUID();
  const scope: TenantScope = { workspaceId: `ws_img_${label}_${randomUUID().slice(0, 8)}`, tenantGroupId: randomUUID() };
  const repo = getSiteRepository();
  const { version } = await repo.saveProject(scope, project(id));
  createdSites.push(id);
  if (options.published !== false) await repo.publishProject(scope, project(id), { expectedVersion: version });
  const { subdomain } = await repo.ensureSiteDomain(scope, id);
  return { id, scope, companyId: randomUUID(), host: `${subdomain}.example.com` };
}

/** A verified session for a member of exactly one site's company. */
function memberOf(site: TestSite): SessionVerifyResponse {
  return {
    user: { id: `user-${site.scope.workspaceId}` },
    workspaces: [{ id: site.scope.workspaceId, tenant_id: site.companyId }],
    tenants: [{ id: site.companyId, app_grants: ['sites'], group_id: site.scope.tenantGroupId }],
    active_workspace: { id: site.scope.workspaceId },
  } as unknown as SessionVerifyResponse;
}

function upload(projectId: string, bytes: Uint8Array, kind = 'favicon', headers: Record<string, string> = {}, host = EDITOR) {
  return uploadPOST(
    new Request(`https://${host}/api/projects/${projectId}/images?kind=${kind}`, {
      method: 'POST',
      headers: { host, cookie: 'lumitra_session=faked', 'content-type': 'image/png', ...headers },
      body: bytes as BodyInit,
    }),
    { params: Promise.resolve({ projectId }) },
  );
}

function list(projectId: string) {
  return listGET(new Request(`https://${EDITOR}/api/projects/${projectId}/images`, { headers: { host: EDITOR } }), {
    params: Promise.resolve({ projectId }),
  });
}

function remove(projectId: string, sha256: string) {
  return editorDELETE(new Request(`https://${EDITOR}/api/projects/${projectId}/images/${sha256}`, { method: 'DELETE', headers: { host: EDITOR } }), {
    params: Promise.resolve({ projectId, sha256 }),
  });
}

/** Fill a site's image rows directly (tiny distinct PNGs), to stand at a limit without uploading each. */
async function fillImages(site: TestSite, count: number): Promise<void> {
  await prisma.siteImage.createMany({
    data: Array.from({ length: count }, (_, i) => {
      const bytes = png(1, 1, [i % 256, Math.floor(i / 256), 7]);
      return {
        id: randomUUID(),
        siteId: site.id,
        workspaceId: site.scope.workspaceId,
        tenantGroupId: site.scope.tenantGroupId,
        sha256: sha(bytes),
        contentType: 'image/png',
        byteSize: bytes.byteLength,
        width: 1,
        height: 1,
        content: Buffer.from(bytes),
        uploadedBy: 'fixture',
      };
    }),
  });
}

function preview(projectId: string, sha256: string, headers: Record<string, string> = {}) {
  return editorGET(new Request(`https://${EDITOR}/api/projects/${projectId}/images/${sha256}`, { headers: { host: EDITOR, ...headers } }), {
    params: Promise.resolve({ projectId, sha256 }),
  });
}

function visit(host: string, file: string, headers: Record<string, string> = {}) {
  return publicGET(new Request(`https://${host}/site-images/${file}`, { headers: { host, ...headers } }), {
    params: Promise.resolve({ file }),
  });
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  process.env.EDITOR_HOST = EDITOR;
  prisma = getPrismaClient();
  siteA = await makeSite('a');
  siteB = await makeSite('b');
  customHost = `www.img-${randomUUID().slice(0, 8)}.example.net`;
  await prisma.siteDomain.create({
    data: {
      siteId: siteA.id,
      workspaceId: siteA.scope.workspaceId,
      tenantGroupId: siteA.scope.tenantGroupId,
      hostname: customHost,
      customHostname: customHost,
      verificationToken: `tok-${customHost}`,
      verificationStatus: 'active',
      verifiedAt: new Date(),
      activatedAt: new Date(),
    },
  });
}, 120_000);

afterAll(async () => {
  delete process.env.EDITOR_HOST;
  const ids = [...createdSites];
  await prisma.site.deleteMany({ where: { id: { in: ids } } });
  // Deleting a site deletes its images.
  expect(await prisma.siteImage.count({ where: { siteId: { in: ids } } })).toBe(0);
});

beforeEach(() => {
  __resetUploadRateLimiterForTests();
  sessionMock.mockReset();
  accessMock.mockReset();
  // OpenFGA, faked: a user holds every right on the one workspace their session names.
  accessMock.mockImplementation(async (userId, workspaceId) => userId === `user-${workspaceId}`);
  sessionMock.mockResolvedValue(memberOf(siteA));
});

describe('POST /api/projects/<id>/images', () => {
  it('stores a PNG favicon once per site and hash', async () => {
    const icon = png(256, 256);
    const first = await upload(siteA.id, icon);
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body).toMatchObject({
      sha256: sha(icon),
      contentType: 'image/png',
      width: 256,
      height: 256,
      byteSize: icon.byteLength,
      path: `/site-images/${sha(icon)}.png`,
      warnings: [],
    });
    const again = await upload(siteA.id, icon);
    expect(again.status).toBe(200);
    expect((await again.json()).sha256).toBe(sha(icon));
    expect(await prisma.siteImage.count({ where: { siteId: siteA.id, sha256: sha(icon) } })).toBe(1);
  });

  it('stores an ICO favicon and a sharing image of an odd shape, with warnings', async () => {
    const icon = ico([16, 32, 48]);
    const stored = await upload(siteA.id, icon, 'favicon', { 'content-type': 'image/x-icon' });
    expect(stored.status).toBe(201);
    expect(await stored.json()).toMatchObject({ contentType: 'image/x-icon', path: `/site-images/${sha(icon)}.ico` });

    const square = jpegHeader(800, 800);
    const res = await upload(siteA.id, square, 'sharing', { 'content-type': 'image/jpeg' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toBe(`/site-images/${sha(square)}.jpg`);
    expect(body.warnings.join(' ')).toMatch(/cut off/);
  });

  it('refuses SVG, a wrong type for the kind, a bad kind, and stores nothing', async () => {
    const before = await prisma.siteImage.count({ where: { siteId: siteA.id } });

    const svg = await upload(siteA.id, svgText(), 'favicon', { 'content-type': 'image/png' });
    expect(svg.status).toBe(415);
    expect((await svg.json()).error).toMatchObject({ code: 'unsupported_image_type', message: expect.stringMatching(/SVG can carry script/) });

    const icoAsSharing = await upload(siteA.id, ico([32]), 'sharing');
    expect(icoAsSharing.status).toBe(415);

    const jpegAsFavicon = await upload(siteA.id, jpegHeader(64, 64), 'favicon');
    expect(jpegAsFavicon.status).toBe(415);

    const badKind = await upload(siteA.id, png(64, 64), 'logo');
    expect(badKind.status).toBe(400);
    expect((await badKind.json()).error.code).toBe('bad_kind');

    const tiny = await upload(siteA.id, png(8, 8), 'favicon');
    expect(tiny.status).toBe(422);

    expect(await prisma.siteImage.count({ where: { siteId: siteA.id } })).toBe(before);
  });

  it('refuses more than 2 MB, by Content-Length and by the streamed body', async () => {
    const declared = await upload(siteA.id, png(4, 4), 'sharing', { 'content-length': String(MAX_SITE_IMAGE_BYTES + 1) });
    expect(declared.status).toBe(413);
    expect((await declared.json()).error.code).toBe('image_too_large');

    const big = new Uint8Array(MAX_SITE_IMAGE_BYTES + 1);
    big.set(png(4, 4));
    const streamed = await upload(siteA.id, big, 'sharing');
    expect(streamed.status).toBe(413);
  });

  it('guards: no session 401, another company 403, no editSite 403, a published host 404', async () => {
    sessionMock.mockResolvedValue(null);
    expect((await upload(siteA.id, png(64, 64))).status).toBe(401);

    // A member of site B's company uploading to site A.
    sessionMock.mockResolvedValue(memberOf(siteB));
    const foreign = await upload(siteA.id, png(65, 65));
    expect(foreign.status).toBe(403);
    expect(await prisma.siteImage.count({ where: { siteId: siteA.id, sha256: sha(png(65, 65)) } })).toBe(0);

    // A member of site A who may view but not edit.
    sessionMock.mockResolvedValue(memberOf(siteA));
    accessMock.mockImplementation(async (_userId, _workspaceId, action) => action === 'viewSite');
    expect((await upload(siteA.id, png(66, 66))).status).toBe(403);

    accessMock.mockImplementation(async () => true);
    expect((await upload(siteA.id, png(67, 67), 'favicon', {}, siteA.host)).status).toBe(404);
    // An unknown project answers like a foreign one.
    expect((await upload(randomUUID(), png(68, 68))).status).toBe(403);
  });
});

describe('GET /api/projects/<id>/images/<sha256> (the editor preview)', () => {
  it('serves the bytes privately, 304 on the hash, 404 for another site', async () => {
    const icon = png(300, 300);
    await upload(siteA.id, icon);
    const res = await preview(siteA.id, sha(icon));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(icon);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    expect((await preview(siteA.id, sha(icon), { 'if-none-match': `"${sha(icon)}"` })).status).toBe(304);

    sessionMock.mockResolvedValue(memberOf(siteB));
    expect((await preview(siteB.id, sha(icon))).status).toBe(404);
    expect((await preview(siteB.id, sha(icon), { 'if-none-match': `"${sha(icon)}"` })).status).toBe(404);
    expect((await preview(siteB.id, 'not-a-hash')).status).toBe(404);
  });
});

describe('GET /site-images/<sha256>.<ext> (visitors)', () => {
  it("serves the site's image on its subdomain and custom domain, and nowhere else", async () => {
    const icon = png(320, 320);
    await upload(siteA.id, icon);
    const file = `${sha(icon)}.png`;

    for (const host of [siteA.host, customHost]) {
      const res = await visit(host, file);
      expect(res.status, host).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(icon);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('etag')).toBe(`"${sha(icon)}"`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    }
    expect((await visit(siteA.host, file, { 'if-none-match': `"${sha(icon)}"` })).status).toBe(304);

    expect((await visit(siteB.host, file)).status).toBe(404);
    expect((await visit(siteB.host, file, { 'if-none-match': `"${sha(icon)}"` })).status).toBe(404);
    expect((await visit(EDITOR, file)).status).toBe(404);
    expect((await visit(siteA.host, `${sha(icon)}.jpg`)).status).toBe(404);
    expect((await visit(siteA.host, `${sha(icon)}.svg`)).status).toBe(404);
    expect((await visit(siteA.host, 'whatever.png')).status).toBe(404);
  });
});

describe('the published head and the published revision', () => {
  it('emits the icon relative and the sharing images absolute on the primary host, which resolve there', async () => {
    const icon = png(512, 512);
    const sharing = png(1200, 630);
    const about = png(1200, 631, [10, 20, 30]);
    const iconPath = (await (await upload(siteA.id, icon)).json()).path as string;
    const sharingPath = (await (await upload(siteA.id, sharing, 'sharing')).json()).path as string;
    const aboutPath = (await (await upload(siteA.id, about, 'sharing')).json()).path as string;

    await getSiteRepository().publishProject(siteA.scope, project(siteA.id, { faviconUrl: iconPath, ogImageUrl: sharingPath }, aboutPath));

    requestHost = siteA.host;
    const base = await layoutMetadata();
    expect(base.icons).toEqual({ icon: [{ url: iconPath, type: 'image/png' }], apple: [{ url: iconPath }] });
    // The primary host is the live custom domain, whichever host the visitor came in on.
    expect(base.openGraph).toMatchObject({ images: [{ url: `https://${customHost}${sharingPath}` }] });
    expect(base.twitter).toMatchObject({ images: [`https://${customHost}${sharingPath}`] });

    const aboutMeta = await pageMetadata({ params: Promise.resolve({ slug: ['about'] }) } as never);
    expect(aboutMeta.openGraph).toMatchObject({ images: [{ url: `https://${customHost}${aboutPath}` }] });
    expect(aboutMeta.twitter).toMatchObject({ images: [`https://${customHost}${aboutPath}`] });

    // The absolute address resolves on its own host.
    const served = await visit(customHost, sharingPath.slice('/site-images/'.length));
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(sharing);
  });

  it('keeps the published image after the settings are saved with another one', async () => {
    const published = png(512, 512, [1, 2, 3]);
    const later = png(512, 512, [4, 5, 6]);
    const publishedPath = (await (await upload(siteA.id, published)).json()).path as string;
    const laterPath = (await (await upload(siteA.id, later)).json()).path as string;
    const repo = getSiteRepository();
    await repo.publishProject(siteA.scope, project(siteA.id, { faviconUrl: publishedPath }));
    await repo.saveProject(siteA.scope, project(siteA.id, { faviconUrl: laterPath }), { mustExist: true });

    requestHost = siteA.host;
    const base = await layoutMetadata();
    expect(base.icons).toMatchObject({ icon: [{ url: publishedPath }] });
    const res = await visit(siteA.host, publishedPath.slice('/site-images/'.length));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(published);
  });
});

describe('limits', () => {
  it('refuses the next image at 100 with 409 image_limit, naming the way forward', async () => {
    const site = await makeSite('count');
    await fillImages(site, 100);
    sessionMock.mockResolvedValue(memberOf(site));
    const res = await upload(site.id, png(64, 64, [9, 9, 9]));
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe('image_limit');
    expect(error.message).toMatch(/100 images or 50 MB/);
    expect(error.message).toMatch(/Delete images you no longer use under "Uploaded images" in Site settings/);
    // A file the site already stores is still answered at the limit (nothing new is stored).
    expect((await upload(site.id, png(1, 1, [0, 0, 7]), 'sharing')).status).toBe(200);
  });

  it('refuses an image that would pass the byte budget with the same 409', async () => {
    const site = await makeSite('bytes');
    const first = png(64, 64, [1, 1, 1]);
    const owner = { id: site.id, workspaceId: site.scope.workspaceId, tenantGroupId: site.scope.tenantGroupId };
    const limits = { maxImages: 100, maxBytes: first.byteLength + 10 };
    await storeSiteImage(owner, first, 'sharing', 'u', prisma, limits);
    await expect(storeSiteImage(owner, png(64, 64, [2, 2, 2]), 'sharing', 'u', prisma, limits)).rejects.toMatchObject({
      code: 'image_limit',
      status: 409,
    });
  });

  it('cannot be raced past: concurrent uploads at the limit store exactly up to it', async () => {
    const site = await makeSite('race');
    const owner = { id: site.id, workspaceId: site.scope.workspaceId, tenantGroupId: site.scope.tenantGroupId };
    const limits = { maxImages: 3, maxBytes: 50 * 1024 * 1024 };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => storeSiteImage(owner, png(32, 32, [i, 100, 100]), 'sharing', 'u', prisma, limits)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(SiteImageError);
      expect(r.reason.code).toBe('image_limit');
    }
    expect(await prisma.siteImage.count({ where: { siteId: site.id } })).toBe(3);
  });

  it('caps a favicon at 1024 px and refuses an ICO whose entry data disagrees with its directory', async () => {
    expect((await upload(siteA.id, png(1025, 1025))).status).toBe(422);
    const forged = icoWith([{ declared: 16, data: pngHeader(9000, 9000) }]);
    const res = await upload(siteA.id, forged);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('image_invalid');
  });

  it('limits one user to 30 upload attempts in 10 minutes (429 with Retry-After)', async () => {
    for (let i = 0; i < 30; i++) expect((await upload(siteA.id, png(8, 8))).status).toBe(422);
    const limited = await upload(siteA.id, png(64, 64));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe('rate_limited');
  });
});

describe('listing and deleting', () => {
  it('lists the images with what is in use, deletes an unused one, and refuses one in use', async () => {
    const site = await makeSite('delete');
    sessionMock.mockResolvedValue(memberOf(site));
    const used = png(200, 200, [3, 3, 3]);
    const old = png(200, 200, [4, 4, 4]);
    const unused = png(200, 200, [5, 5, 5]);
    const usedPath = (await (await upload(site.id, used)).json()).path as string;
    const oldPath = (await (await upload(site.id, old)).json()).path as string;
    await upload(site.id, unused);

    const repo = getSiteRepository();
    // `old` is in revision 2 only (kept for rollback); `used` is in the working copy and revision 3.
    await repo.publishProject(site.scope, project(site.id, { faviconUrl: oldPath }));
    await repo.publishProject(site.scope, project(site.id, { faviconUrl: usedPath }));

    const listed = await (await list(site.id)).json();
    const inUse = Object.fromEntries(listed.items.map((i: { sha256: string; inUse: boolean }) => [i.sha256, i.inUse]));
    expect(inUse).toEqual({ [sha(used)]: true, [sha(old)]: true, [sha(unused)]: false });
    expect(listed).toMatchObject({ maxImages: 100, maxBytes: 50 * 1024 * 1024, totalBytes: used.byteLength + old.byteLength + unused.byteLength });

    const inUseRes = await remove(site.id, sha(used));
    expect(inUseRes.status).toBe(409);
    expect((await inUseRes.json()).error.code).toBe('image_in_use');
    expect((await remove(site.id, sha(old))).status).toBe(409);

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect((await remove(site.id, sha(unused))).status).toBe(204);
    expect(info.mock.calls.flat().join(' ')).toMatch(new RegExp(`audit: user user-${site.scope.workspaceId} deleted ${sha(unused)} from site ${site.id}`));
    info.mockRestore();
    expect(await prisma.siteImage.count({ where: { siteId: site.id, sha256: sha(unused) } })).toBe(0);
    expect((await visit(site.host, `${sha(unused)}.png`)).status).toBe(404);
    expect((await remove(site.id, sha(unused))).status).toBe(404);
  });

  it('keeps an image an A/B test variant names', async () => {
    const site = await makeSite('experiment');
    sessionMock.mockResolvedValue(memberOf(site));
    const variant = png(240, 240, [11, 11, 11]);
    const path = (await (await upload(site.id, variant, 'sharing')).json()).path as string;
    await prisma.siteExperiment.create({
      data: {
        siteId: site.id,
        workspaceId: site.scope.workspaceId,
        tenantGroupId: site.scope.tenantGroupId,
        experimentKey: 'hero',
        config: { variants: [{ key: 'b', ogImage: path }] },
      },
    });
    expect((await (await list(site.id)).json()).items[0].inUse).toBe(true);
    const res = await remove(site.id, sha(variant));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('image_in_use');
  });

  it("keeps an image a content agent's undo would write back", async () => {
    const site = await makeSite('undo');
    sessionMock.mockResolvedValue(memberOf(site));
    const restored = png(250, 250, [12, 12, 12]);
    const path = (await (await upload(site.id, restored, 'sharing')).json()).path as string;
    const run = await prisma.agentRun.create({
      data: { collectionId: randomUUID(), workspaceId: site.scope.workspaceId, prompt: 'swap the hero image', model: 'test', status: 'done' },
    });
    await prisma.agentChange.create({
      data: {
        runId: run.id,
        position: 1,
        tool: 'update_row',
        entityType: 'row',
        inverseTool: 'update_row',
        inversePayload: { values: { image: path } },
      },
    });
    try {
      const res = await remove(site.id, sha(restored));
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('image_in_use');
    } finally {
      await prisma.agentRun.delete({ where: { id: run.id } });
    }
    // Once the undo record is gone, nothing names it and it can go.
    expect((await remove(site.id, sha(restored))).status).toBe(204);
  });

  it('guards the delete: editSite needed, another site answers 404', async () => {
    const icon = png(210, 210);
    await upload(siteA.id, icon);
    accessMock.mockImplementation(async (_u, _w, action) => action === 'viewSite');
    expect((await remove(siteA.id, sha(icon))).status).toBe(403);
    accessMock.mockImplementation(async (userId, workspaceId) => userId === `user-${workspaceId}`);
    sessionMock.mockResolvedValue(memberOf(siteB));
    expect((await remove(siteB.id, sha(icon))).status).toBe(404);
    expect(await prisma.siteImage.count({ where: { siteId: siteA.id, sha256: sha(icon) } })).toBe(1);
  });
});

describe('a path the site does not store', () => {
  it('is refused on save and publish, for the settings and a page, typed or from another site', async () => {
    const theirs = png(220, 220, [8, 8, 8]);
    sessionMock.mockResolvedValue(memberOf(siteB));
    const theirPath = (await (await upload(siteB.id, theirs)).json()).path as string;
    const repo = getSiteRepository();
    const typed = `/site-images/${'f'.repeat(64)}.png`;

    for (const attempt of [
      () => repo.saveProject(siteA.scope, project(siteA.id, { faviconUrl: theirPath }), { mustExist: true }),
      () => repo.saveProject(siteA.scope, project(siteA.id, { ogImageUrl: typed }), { mustExist: true }),
      () => repo.saveProject(siteA.scope, project(siteA.id, {}, theirPath), { mustExist: true }),
      () => repo.publishProject(siteA.scope, project(siteA.id, { faviconUrl: typed })),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'site_image_missing', status: 422 });
    }
  });
});

describe('who may reach the routes', () => {
  it('answers 404 on a draft site, whose images exist', async () => {
    const draft = await makeSite('draft', { published: false });
    sessionMock.mockResolvedValue(memberOf(draft));
    const icon = png(230, 230);
    expect((await upload(draft.id, icon)).status).toBe(201);
    expect((await visit(draft.host, `${sha(icon)}.png`)).status).toBe(404);
  });

  it('refuses an upload from a published site origin before any handler runs (cross_origin_refused)', async () => {
    const attempts: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-site', origin: 'https://shop.sites.lumitra.co', 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://www.kunde.de', 'content-type': 'image/png' },
      { origin: 'https://shop.sites.lumitra.co', 'content-type': 'text/plain' },
    ];
    for (const headers of attempts) {
      const res = await middleware(
        new NextRequest(`https://${EDITOR}/api/projects/${siteA.id}/images?kind=favicon`, {
          method: 'POST',
          headers: { host: EDITOR, cookie: 'lumitra_session=faked', ...headers },
          body: 'not an image',
        }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('cross_origin_refused');
    }
  });
});
