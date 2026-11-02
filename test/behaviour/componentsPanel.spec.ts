// Create component to a published page (docs/plans/2026-11-02-reusable-components.md,
// slice 8), as a visitor gets it: a real build, the real `(site)/[...slug]` route,
// real Chromium and WebKit, a real Postgres. The project is changed through the same
// model calls the editor's controls make (Create component's dialog, Make input,
// a row of the placement's Component section, This site's tap), then saved and
// published through the repository, since the publish route needs a signed-in
// session. The controls themselves are proven in jsdom and in the editor in a browser.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { randomUUID } from 'node:crypto';
import { getSnapshot } from 'mobx-state-tree';
import ProjectStore from '@/stores/ProjectStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { inputDraftFor } from '@/lib/components/makeInput';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';

const SCOPE: TenantScope = {
  workspaceId: `ws_panel_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c3',
};

/** A two page site whose home holds a hero, made into a component and placed on both pages. */
function buildSite(siteId: string): ProjectModelType {
  const store = ProjectStore.create({});
  store.ingestProjectSnapshot({ id: siteId, metadata: { title: 'Panel' }, pages: {} } as never);
  const project = store.getProject(siteId) as ProjectModelType;
  const home = project.createPage('Home');
  home.setSlug('');
  const about = project.createPage('About');
  const root = home.appComponentTree as unknown as ComponentInstance;
  root.addChildren([createIntrinsicComponent('hero', 'section', { 'data-t': 'hero' })]);
  const hero = root.children.find((c: ComponentInstance) => c.id === 'hero')!;
  hero.addChildren([createIntrinsicComponent('hero-title', 'h2', { children: 'Welcome', 'data-t': 'title' })]);

  // Create component, as its dialog confirms it.
  const created = project.createComponentFromSelection(home.id, ['hero'], 'Hero');
  if (!created.ok) throw new Error(created.message);
  // Make input on the heading's text, inside the definition.
  const definition = project.components.get(created.definitionId)!;
  const title = definition.page.findComponent('hero-title')!;
  const { input, expression } = inputDraftFor(
    { type: title.type, props: (getSnapshot(title) as { props: Record<string, unknown> }).props },
    'children',
    'Text',
    definition.inputs,
  );
  const made = project.makeInput(definition.id, title.id, 'children', input, expression);
  if (!made.ok) throw new Error(made.message);
  // The home placement's row, then a tap on This site with the About page open.
  created.placement.setProps({ inputs: { [input.id]: 'Home title' } });
  const placed = project.placeComponent(about.id, definition.id, { kind: 'appTree' });
  if (!placed.ok) throw new Error(placed.message);
  return project;
}

async function origin(siteId: string): Promise<string> {
  const { subdomain } = await getSiteRepository().ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${process.env.BEHAVIOUR_PORT}`;
}

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

describe.each(ENGINES)('in %s', (_name, engine) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function titles(address: string): Promise<string[]> {
    const page = await browser.newPage();
    try {
      const response = await page.goto(address);
      expect(response?.status()).toBe(200);
      return await page.locator('[data-t="hero"] [data-t="title"]').allTextContents();
    } finally {
      await page.close();
    }
  }

  it('a component made in the editor reaches both published pages with each placement value', async () => {
    const repo = getSiteRepository();
    const siteId = randomUUID();
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(buildSite(siteId))));
    const saved = await repo.saveProject(SCOPE, snapshot);
    await repo.publishProject(SCOPE, snapshot, { expectedVersion: saved.version });
    const site = await origin(siteId);
    expect(await titles(`${site}/`)).toEqual(['Home title']);
    // No value of its own: the default Make input took from the heading.
    expect(await titles(`${site}/about`)).toEqual(['Welcome']);
  });
});
