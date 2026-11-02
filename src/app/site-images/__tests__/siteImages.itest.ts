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
import { ico, jpegHeader, png, svgText } from '@/lib/images/__tests__/fixtures';
import { MAX_SITE_IMAGE_BYTES } from '@/lib/site/siteImages';
import { POST as uploadPOST } from '@/app/api/projects/[projectId]/images/route';
import { GET as editorGET } from '@/app/api/projects/[projectId]/images/[sha256]/route';
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

async function makeSite(label: string): Promise<TestSite> {
  const id = randomUUID();
  const scope: TenantScope = { workspaceId: `ws_img_${label}_${randomUUID().slice(0, 8)}`, tenantGroupId: randomUUID() };
  const repo = getSiteRepository();
  await repo.saveProject(scope, project(id));
  await repo.publishProject(scope, project(id));
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
      body: bytes,
    }),
    { params: Promise.resolve({ projectId }) },
  );
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
  const ids = [siteA?.id, siteB?.id].filter((id): id is string => Boolean(id));
  await prisma.site.deleteMany({ where: { id: { in: ids } } });
  // Deleting a site deletes its images.
  expect(await prisma.siteImage.count({ where: { siteId: { in: ids } } })).toBe(0);
});

beforeEach(() => {
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
