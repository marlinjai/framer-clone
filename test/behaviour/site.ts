// Saves and publishes PAGES through the real repository, then gives the address the
// real `(site)/[...slug]` route answers on.

import { randomUUID } from 'node:crypto';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { storeSiteImage } from '@/server/sites/siteImages';
import { COMPONENTS, PAGES, type StoredNode } from './pages';

const SCOPE: TenantScope = {
  workspaceId: `ws_behaviour_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c2',
};

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

const stored = (slug: string, tree: StoredNode) => ({
  id: slug || 'home',
  slug,
  metadata: { title: slug || 'Home' },
  appComponentTree: tree.id === 'page-root' ? tree : { id: `root-${slug || 'home'}`, type: 'div', componentType: 'host', props: {}, children: [tree] },
  canvasNodes: frames,
});

export interface PublishOptions {
  /** Turns analytics on, so the real consent banner asks about it. */
  analytics?: boolean;
  /** Saved and frozen with the publish. */
  siteSettings?: Record<string, unknown>;
  /** The pages to publish instead of PAGES, one per slug. */
  pages?: Readonly<Record<string, () => StoredNode>>;
  /** The site language (Site settings), `en` when not given; joins `siteSettings`. */
  language?: string;
}

/**
 * The origin of a published site holding every page, one page per slug. With `analytics`,
 * the real consent banner shows; `siteSettings` is saved and frozen with the publish.
 */
export async function publishPages(
  port: string,
  { analytics = false, siteSettings, pages: only, language }: PublishOptions = {},
): Promise<string> {
  const repo = getSiteRepository();
  const siteId = randomUUID();
  const source = only ?? PAGES;
  const pages = { home: stored('', PAGES.plain()), ...Object.fromEntries(Object.entries(source).map(([slug, tree]) => [slug, stored(slug, tree())])) };
  const project = {
    id: siteId,
    metadata: { title: 'Behaviour', description: '', createdAt: 1, updatedAt: 2 },
    pages,
    components: COMPONENTS,
    // Publish freezes the binding with the pages, so it travels in the project.
    ...(analytics ? { lumitra: { enabled: true } } : {}),
    ...(siteSettings || language ? { siteSettings: { ...(siteSettings ?? {}), ...(language ? { language } : {}) } } : {}),
  };
  const saved = await repo.saveProject(SCOPE, project as never);
  await repo.publishProject(SCOPE, project as never, { expectedVersion: saved.version });
  const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${port}`;
}

/**
 * As publishPages, for pages that show images uploaded to the site: the site is saved
 * first (an image belongs to a stored site), each image is stored through the real
 * upload path, and `pages` is then built with the paths the site stores them under.
 */
export async function publishPagesWithImages(
  port: string,
  images: Readonly<Record<string, Uint8Array>>,
  pages: (paths: Readonly<Record<string, string>>) => Readonly<Record<string, () => StoredNode>>,
): Promise<string> {
  const repo = getSiteRepository();
  const siteId = randomUUID();
  const base = { id: siteId, metadata: { title: 'Behaviour', description: '', createdAt: 1, updatedAt: 2 }, components: COMPONENTS };
  const saved = await repo.saveProject(SCOPE, { ...base, pages: { home: stored('', PAGES.plain()) } } as never);
  const paths: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(images)) {
    const { image } = await storeSiteImage({ id: siteId, ...SCOPE }, bytes, 'sharing', 'behaviour-test');
    paths[name] = image.path;
  }
  const project = {
    ...base,
    pages: { home: stored('', PAGES.plain()), ...Object.fromEntries(Object.entries(pages(paths)).map(([slug, tree]) => [slug, stored(slug, tree())])) },
  };
  await repo.publishProject(SCOPE, project as never, { expectedVersion: saved.version });
  const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${port}`;
}
