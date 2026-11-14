// @vitest-environment jsdom
//
// A completed new-page generation against a REAL Postgres (scratch container, no paid model call: the
// model is a scripted stub), followed all the way to an open editor:
//   1. the agent path: siteOps.generatePage saves the page; the stored site holds it as a SEPARATE page,
//      and an editor that had the site open adopts that version (the live sync's adoptServerCopy) and lists it;
//   2. the editor's own path: the Generate dialog's applyResult adds the page in the editor store; the project
//      as the editor's save sends it is stored and read back with the page as a separate page.
// Reported by the owner on 2026-11-14 ("a generated page appears on the same canvas as another page instead of
// in the Pages selector"); plan docs/plans/2026-11-14-generate-new-page-draft-placement.md.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getSnapshot } from 'mobx-state-tree';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { generatePage } from '@/server/siteOps';
import type { SiteOpsCaller } from '@/lib/siteOps/types';
import { createRootStore } from '@/stores/RootStore';
import { openProject, adoptServerCopy } from '@/stores/openProject';
import { captureTarget, applyResult } from '@/lib/ai/pageGen/editorBridge';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { __resetPageGenRateLimiterForTests } from '@/lib/ai/pageGen/rateLimit';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000b5e77';
const scope = { workspaceId: `ws_gpa_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
const caller: SiteOpsCaller = {
  scope,
  companyId: 'company-gpa',
  companySlug: 'bakery',
  actor: { kind: 'key', id: 'key_gpa' },
  actorDetail: { serviceAccountId: 'sa_gpa' },
  can: () => true,
};
const PAGE = {
  title: 'Menu',
  description: 'What we bake',
  nodes: [{ type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Our bread' } }] }],
};
const scripted = (input: unknown) => () =>
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

let prisma: PrismaClient;
const repo = latestVersionRepository();

function homeProject(siteId: string) {
  return ProjectModel.create({
    id: siteId,
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

beforeAll(() => {
  prisma = getPrismaClient();
});
afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('a completed new-page generation, stored and adopted', () => {
  it('agent path: stored as a separate page; an open editor adopts it into the Pages list and leaves the open page alone', async () => {
    __resetPageGenRateLimiterForTests();
    const siteId = randomUUID();
    const { version: v0 } = await repo.saveProject(scope, homeProject(siteId), { companyId: caller.companyId });

    // An editor tab has the site open on its home page.
    const store = createRootStore();
    const before = await repo.loadProjectWithVersion(scope, siteId);
    openProject(store, getSnapshot(before.project) as ProjectSnapshotOut, null, before.version);
    const open = store.editorUI.currentProject!;
    expect(open.pages.size).toBe(1);
    expect(store.editorUI.currentPage?.id).toBe('home');

    // The agent generates a new page (scripted model) and the real repository saves it.
    const result = await generatePage(
      caller,
      { siteId, expectedVersion: v0, brief: 'A menu page', target: { kind: 'newPage', title: 'Menu' } },
      { repository: repo, anthropic: scripted(PAGE) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Read back from Postgres: two pages, the new one its own, the home page untouched.
    const stored = await repo.loadProjectWithVersion(scope, siteId);
    expect(stored.version).toBe(v0 + 1);
    expect(stored.project.pages.size).toBe(2);
    const created = stored.project.getPage(result.value.pageId)!;
    expect(created.id).not.toBe('home');
    expect(created.metadata.title).toBe('Menu');
    expect(created.slug).toBe('menu');
    expect(created.appComponentTree.children).toHaveLength(1);
    expect(created.viewportNodes.length).toBe(3);
    expect(stored.project.getPage('home')!.appComponentTree.children).toHaveLength(1);

    // The open editor adopts that version (what the live sync does on `site:version`).
    const adopted = adoptServerCopy(store, getSnapshot(stored.project) as ProjectSnapshotOut, stored.version, 'Agent added a page');
    expect(adopted).not.toBeNull();
    const list = store.editorUI.currentProject!.pagesArray.map((p) => p.metadata.title);
    expect(list).toEqual(['Home', 'Menu']);
    expect(store.editorUI.currentPage?.id).toBe('home'); // the person's view stays; the Pages panel lists the new page
    expect(open.getPage('home')!.appComponentTree.children).toHaveLength(1); // nothing was put into the home page
  });

  it("the editor's own path: the dialog's apply, then the save, then a reload: a separate page", async () => {
    const siteId = randomUUID();
    const { version: v0 } = await repo.saveProject(scope, homeProject(siteId), { companyId: caller.companyId });
    const store = createRootStore();
    const loaded = await repo.loadProjectWithVersion(scope, siteId);
    openProject(store, getSnapshot(loaded.project) as ProjectSnapshotOut, null, loaded.version);
    const project = store.editorUI.currentProject!;
    const home = store.editorUI.currentPage!;

    const target = captureTarget('newPage', home, undefined);
    const breakpoints = target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth }));
    const out = validateGeneration(PAGE, { breakpoints: deriveBreakpointKeys(breakpoints) });
    if (!out.ok) throw new Error(out.errors.join('; '));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { imageRequests, ...rest } = out.result as never as Record<string, unknown>;
    const payload = { generationId: 'g', model: 'm', ...rest, images: { requested: 0, resolved: 0, fellBack: {}, credits: [] } };
    const applied = applyResult(project, target, payload as never);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(project.pages.size).toBe(2);

    // The save the editor sends is the project as it stands; the server stores it as the working copy.
    const sent = ProjectModel.create(getSnapshot(project) as never);
    await repo.saveProject(scope, sent, { companyId: caller.companyId, expectedVersion: v0, mustExist: true });
    const back = await repo.loadProjectWithVersion(scope, siteId);
    expect(back.project.pages.size).toBe(2);
    const created = back.project.getPage(applied.value.pageId)!;
    expect(created.metadata.title).toBe('Menu');
    expect(back.project.getPage('home')!.appComponentTree.children).toHaveLength(1);
    // A fresh editor load shows both pages in the list, the home page open.
    const fresh = createRootStore();
    openProject(fresh, getSnapshot(back.project) as ProjectSnapshotOut, null, back.version);
    expect(fresh.editorUI.currentProject!.pagesArray.map((p) => p.metadata.title).sort()).toEqual(['Home', 'Menu']);
  });
});
