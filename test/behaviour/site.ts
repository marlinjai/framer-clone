// Saves and publishes PAGES through the real repository, then gives the address the
// real `(site)/[...slug]` route answers on.

import { randomUUID } from 'node:crypto';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { PAGES, type StoredNode } from './pages';

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
  appComponentTree: { id: `root-${slug || 'home'}`, type: 'div', componentType: 'host', props: {}, children: [tree] },
  canvasNodes: frames,
});

/** The origin of a published site holding every page, one page per slug. With `analytics`, the real consent banner shows. */
export async function publishPages(port: string, { analytics = false } = {}): Promise<string> {
  const repo = getSiteRepository();
  const siteId = randomUUID();
  const pages = { home: stored('', PAGES.plain()), ...Object.fromEntries(Object.entries(PAGES).map(([slug, tree]) => [slug, stored(slug, tree())])) };
  const project = { id: siteId, metadata: { title: 'Behaviour', description: '', createdAt: 1, updatedAt: 2 }, pages };
  await repo.saveProject(SCOPE, project as never);
  if (analytics) await getPrismaClient().site.update({ where: { id: siteId }, data: { lumitraEnabled: true } });
  await repo.publishProject(SCOPE, siteId);
  const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${port}`;
}
