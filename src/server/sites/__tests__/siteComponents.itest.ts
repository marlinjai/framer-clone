// src/server/sites/__tests__/siteComponents.itest.ts
//
// Reusable component definitions against a REAL Postgres (the
// `20261102120000_site_components` migration applied by the integration
// globalSetup): a definition survives save, load, publish and render; a body from
// a tab loaded before the column leaves it alone; the column commits and fails
// with the pages; and a stored definition that cannot be read costs that
// definition, never the site.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSnapshot } from 'mobx-state-tree';
import { getPrismaClient } from '@/server/db';
import { InvalidPageSlugError, type TenantScope } from '@/server/sites';
import { matchPageBySlug, resolvePublishedSiteByKey } from '@/server/sites/publicResolver';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { projectBodySchema } from '@/app/api/projects/_schema';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { latestVersionRepository } from './latestVersionRepository';

const SCOPE: TenantScope = {
  workspaceId: `ws_components_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c1',
};

const CARD = {
  id: 'card',
  name: 'Card',
  page: {
    id: 'card-page',
    slug: '',
    metadata: { title: 'Card' },
    appComponentTree: {
      id: 'c-root',
      type: 'article',
      componentType: 'host',
      props: { className: 'card' },
      children: [
        {
          id: 'c-title',
          type: 'h3',
          componentType: 'host',
          props: { children: 'Card title' },
          bindings: { children: { mode: 'read', expression: '{{input.title}}' } },
        },
      ],
    },
    canvasNodes: {},
  },
  inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'A default title' }],
  states: [],
};

const placement = (id: string, inputs: Record<string, unknown> = {}) => ({
  id,
  type: '#component',
  componentType: 'host',
  props: { component: 'card', inputs },
});

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

function project(siteId: string, over: { slug?: string; children?: unknown[]; components?: unknown } = {}) {
  return {
    id: siteId,
    metadata: { title: 'Components site', description: '', createdAt: 1, updatedAt: 2 },
    pages: {
      home: {
        id: 'home',
        slug: over.slug ?? '',
        metadata: { title: 'Home' },
        appComponentTree: { id: 'root-home', type: 'div', componentType: 'host', props: {}, children: over.children ?? [] },
        canvasNodes: frames,
      },
    },
    ...('components' in over ? { components: over.components } : {}),
  } as never;
}

let prisma: PrismaClient;
const created: string[] = [];

function newSiteId(): string {
  const id = randomUUID();
  created.push(id);
  return id;
}

async function storedComponents(siteId: string): Promise<unknown> {
  const row = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { components: true } });
  return row.components;
}

beforeAll(() => {
  prisma = getPrismaClient();
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe('sites.components on a real database', () => {
  it('a site created without the key starts with no definitions', async () => {
    const siteId = newSiteId();
    await latestVersionRepository().saveProject(SCOPE, project(siteId));
    expect(await storedComponents(siteId)).toEqual({});
    expect((await latestVersionRepository().loadProject(SCOPE, siteId)).components.size).toBe(0);
  });

  it('a definition survives save, load, publish and render', async () => {
    const repo = latestVersionRepository();
    const siteId = newSiteId();
    const children = [placement('p1', { title: 'First card' }), placement('p2')];
    await repo.saveProject(SCOPE, project(siteId, { children, components: { card: CARD } }));

    const loaded = await repo.loadProject(SCOPE, siteId);
    const definition = loaded.components.get('card')!;
    expect(definition.name).toBe('Card');
    expect(definition.inputs).toEqual(CARD.inputs);
    expect(definition.page.appComponentTree.children[0].id).toBe('c-title');

    // A second round, as the editor's Save does: what it loaded is what it sends.
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(loaded)));
    await repo.saveProject(SCOPE, snapshot, { mustExist: true });
    expect(JSON.parse(JSON.stringify(getSnapshot(await repo.loadProject(SCOPE, siteId))))).toEqual(snapshot);

    // Publish, as the publish route does: the working copy and its frozen revision in one step.
    await repo.publishProject(SCOPE, snapshot);
    const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);

    const site = await resolvePublishedSiteByKey({ kind: 'subdomain', value: subdomain }, prisma);
    expect(Object.keys(site!.components)).toEqual(['card']);
    // Through JSON, as the cross-request cache hands it back.
    const cached = JSON.parse(JSON.stringify(site));
    const matched = matchPageBySlug(cached.pages, [])!;
    const adapted = snapshotToComponentNode(matched.page.snapshot, cached.components);
    const { body } = await renderPublishedPage({
      root: adapted.root!,
      budget: adapted.budget,
      pageParams: {},
      cmsRepo: {} as never,
      breakpoints: adapted.breakpoints,
    });
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null, body));
    expect(html).toContain('<h3');
    expect(html).toContain('First card');
    expect(html).toContain('A default title');
    expect(html).not.toContain('Missing');
  });

  it('a body from a tab older than the column leaves it alone, and a present key replaces it', async () => {
    const repo = latestVersionRepository();
    const siteId = newSiteId();
    await repo.saveProject(SCOPE, project(siteId, { components: { card: CARD } }));
    const before = await storedComponents(siteId);

    // Through the save route's own schema, which keeps unknown keys and adds none.
    const old = projectBodySchema.parse({ project: project(siteId, { children: [placement('p1')] }) });
    expect('components' in old.project).toBe(false);
    await repo.saveProject(SCOPE, old.project as never, { mustExist: true });
    expect(await storedComponents(siteId)).toEqual(before);
    // The save itself landed.
    const page = await prisma.sitePage.findFirstOrThrow({ where: { siteId } });
    expect(JSON.stringify(page.snapshot)).toContain('#component');

    // Malformed is not absent's opposite: it must not reach a Json column either.
    await repo.saveProject(SCOPE, project(siteId, { components: null }), { mustExist: true });
    await repo.saveProject(SCOPE, project(siteId, { components: ['card'] }), { mustExist: true });
    expect(await storedComponents(siteId)).toEqual(before);

    await repo.saveProject(SCOPE, project(siteId, { components: {} }), { mustExist: true });
    expect(await storedComponents(siteId)).toEqual({});
  });

  it('commits with the pages: a save that fails writes neither', async () => {
    const repo = latestVersionRepository();
    const siteId = newSiteId();
    await repo.saveProject(SCOPE, project(siteId, { components: { card: CARD } }));
    const before = await storedComponents(siteId);

    const changed = { ...CARD, name: 'Changed' };
    await expect(
      repo.saveProject(SCOPE, project(siteId, { slug: 'Not A Slug!', components: { card: changed } }), { mustExist: true }),
    ).rejects.toBeInstanceOf(InvalidPageSlugError);
    expect(await storedComponents(siteId)).toEqual(before);
  });

  it('a site in another workspace is not reached', async () => {
    const repo = latestVersionRepository();
    const siteId = newSiteId();
    await repo.saveProject(SCOPE, project(siteId, { components: { card: CARD } }));
    const foreign = { ...SCOPE, workspaceId: `${SCOPE.workspaceId}_other` };
    await expect(repo.saveProject(foreign, project(siteId, { components: {} }))).rejects.toThrow();
    expect(Object.keys(await storedComponents(siteId) as object)).toEqual(['card']);
  });

  it('a stored definition that cannot be read costs that definition, never the site', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = latestVersionRepository();
    const siteId = newSiteId();
    await repo.saveProject(SCOPE, project(siteId, { children: [placement('p1'), placement('p2', {})] }));
    await prisma.site.update({
      where: { id: siteId },
      data: {
        components: {
          card: { ...CARD, inputs: 'not a list' },
          broken: { ...CARD, id: 'broken', page: { ...CARD.page, appComponentTree: { type: 'div', props: 7 } } },
        },
      },
    });

    expect((await repo.loadProject(SCOPE, siteId)).components.size).toBe(0);
    // A publish from a tab older than the column sends no key: the column freezes as stored.
    await repo.publishProject(SCOPE, project(siteId, { children: [placement('p1'), placement('p2', {})] }));
    const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
    const site = await resolvePublishedSiteByKey({ kind: 'subdomain', value: subdomain }, prisma);
    expect(site).not.toBeNull();
    expect(Object.keys(site!.components)).toEqual(['broken']);
    const adapted = snapshotToComponentNode(site!.pages[0].snapshot, site!.components);
    expect(adapted.root?.children?.map((child) => child.type)).toEqual(['#missing', '#missing']);
    warn.mockRestore();
  });
});
