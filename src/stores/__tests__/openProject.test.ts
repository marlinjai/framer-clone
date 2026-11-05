// openProject: how the editor and Preview put a project in the shared store.
import { describe, it, expect, beforeEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { changedElsewhereMessage, changedElsewhereVersion, knownServerVersion, markServerVersion, openProject, pickPage } from '../openProject';
import { withDefaultViewports } from '@/lib/canvas/defaultViewports';
import { pageWithShopParts } from '@/lib/commerce/parts';

let store: RootStoreType;

function serverSnapshot(title = 'Untitled Project'): ProjectSnapshotOut {
  const p = ProjectModel.create({ id: 'site_1', metadata: { title, description: '' }, pages: {} });
  const home = p.createPage('test page');
  home.setSlug('');
  p.createPage('About');
  return getSnapshot(p) as ProjectSnapshotOut;
}

beforeEach(() => {
  store = createRootStore();
});

describe('openProject', () => {
  it('a fresh load ingests the server snapshot and opens the home page', () => {
    const snap = serverSnapshot();
    const out = openProject(store, snap, null, 1);
    expect(out.keptWorkingCopy).toBe(false);
    expect(store.editorUI.currentProject?.id).toBe('site_1');
    expect(store.editorUI.currentPage?.slug).toBe(pickPage(out.project, null).page?.slug);
  });

  it('opens the page from ?page= when it exists', () => {
    const snap = serverSnapshot();
    const aboutId = Object.values(snap.pages).find((p) => p.metadata.title === 'About')!.id;
    const out = openProject(store, snap, aboutId, 1);
    expect(out.page?.id).toBe(aboutId);
    expect(out.missingPageId).toBeUndefined();
  });

  it('an unknown ?page= falls back to home and reports it', () => {
    const out = openProject(store, serverSnapshot(), 'page-never-saved', 1);
    expect(out.page).toBeDefined();
    expect(out.missingPageId).toBe('page-never-saved');
  });

  it('back from Preview: keeps the working copy (an unsaved generated page survives)', () => {
    openProject(store, serverSnapshot(), null, 1);
    const project = store.editorUI.currentProject!;
    const generated = project.createPage('Crumb & Hearth Bakery'); // not saved
    const out = openProject(store, serverSnapshot(), generated.id, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.page?.id).toBe(generated.id);
    expect(store.editorUI.currentProject?.getPage(generated.id)).toBeDefined();
  });

  it('keeping the working copy still takes the name from the server, outside undo history', () => {
    openProject(store, serverSnapshot('Old name'), null, 1);
    openProject(store, serverSnapshot('Renamed on the dashboard'), null, 1);
    expect(store.editorUI.currentProject?.metadata.title).toBe('Renamed on the dashboard');
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('a fresh load is not an undo step (Preview first, then Editor, then Cmd+Z used to delete the project)', () => {
    openProject(store, serverSnapshot(), null, 1); // the preview's load
    openProject(store, serverSnapshot(), null, 1); // "Editor": keeps the working copy
    expect(getHistoryStore()!.canUndo).toBe(false);
    getHistoryStore()!.undo();
    expect(store.projectStore.getProject('site_1')).toBeDefined();
  });

  it('undo history belongs to one project: switching project starts it afresh', () => {
    openProject(store, serverSnapshot(), null, 1);
    const other = ProjectModel.create({ id: 'site_2', metadata: { title: 'B', description: '' }, pages: {} });
    other.createPage('B home');
    openProject(store, getSnapshot(other) as ProjectSnapshotOut, null, 1);
    store.editorUI.currentProject!.updateMetadata({ description: 'edited B' });
    expect(getHistoryStore()!.canUndo).toBe(true);
    openProject(store, serverSnapshot(), null, 1); // back to A
    expect(getHistoryStore()!.canUndo).toBe(false);
  });
});

describe('openProject compares reusable components too', () => {
  const definition = (name: string) => ({
    id: 'nav',
    name,
    page: {
      id: 'nav-page',
      slug: '',
      metadata: { title: 'Nav' },
      appComponentTree: { id: 'n-root', type: 'header', componentType: 'host', props: {}, children: [] },
      canvasNodes: {},
    },
    inputs: [],
    states: [],
  });

  function withDefinition(name: string | null): ProjectSnapshotOut {
    const snap = JSON.parse(JSON.stringify(serverSnapshot())) as ProjectSnapshotOut;
    if (name === null) return snap;
    return JSON.parse(JSON.stringify(getSnapshot(ProjectModel.create({ ...snap, components: { nav: definition(name) } as never }))));
  }

  // The pages must stay exactly alike, so only a definition can differ.
  function samePages(base: ProjectSnapshotOut, name: string | null): ProjectSnapshotOut {
    return { ...base, components: withDefinition(name).components };
  }

  it('no unsaved work here: takes a definition changed elsewhere, with identical pages', () => {
    const base = withDefinition('Navbar');
    openProject(store, base, null, 1);
    const out = openProject(store, samePages(base, 'Navbar edited elsewhere'), null, 1);
    expect(out.keptWorkingCopy).toBe(false);
    expect(out.changedElsewhere).toBe(false);
    expect(store.editorUI.currentProject!.components.get('nav')!.name).toBe('Navbar edited elsewhere');
  });

  it('a definition changed on both sides is a conflict that names it, with identical pages', () => {
    const base = withDefinition('Navbar');
    openProject(store, base, null, 1);
    store.editorUI.currentProject!.components.get('nav')!.page.setSlug('edited-here');
    const out = openProject(store, samePages(base, 'Navbar edited elsewhere'), null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    expect(out.changedDefinitions).toEqual(['Navbar edited elsewhere']);
    expect(store.editorUI.currentProject!.components.get('nav')!.page.slug).toBe('edited-here');
  });

  it('unsaved page work against a definition changed elsewhere is a conflict too', () => {
    const base = withDefinition('Navbar');
    openProject(store, base, null, 1);
    store.editorUI.currentProject!.createPage('Generated here, not saved');
    const out = openProject(store, samePages(base, 'Navbar edited elsewhere'), null, 1);
    expect(out.changedElsewhere).toBe(true);
    expect(out.changedDefinitions).toEqual(['Navbar edited elsewhere']);
  });

  it('names a definition deleted elsewhere from the copy in this tab', () => {
    const base = withDefinition('Navbar');
    openProject(store, base, null, 1);
    store.editorUI.currentProject!.components.get('nav')!.page.setSlug('edited-here');
    expect(openProject(store, samePages(base, null), null, 1).changedDefinitions).toEqual(['Navbar']);
  });

  it('a conflict in pages alone names no component', () => {
    const base = withDefinition('Navbar');
    openProject(store, base, null, 1);
    store.editorUI.currentProject!.createPage('Generated here, not saved');
    const p = ProjectModel.create(JSON.parse(JSON.stringify(base)));
    p.createPage('Added elsewhere');
    const out = openProject(store, JSON.parse(JSON.stringify(getSnapshot(p))), null, 1);
    expect(out.changedElsewhere).toBe(true);
    expect(out.changedDefinitions).toEqual([]);
  });

  it('this tab saving a definition is not a change elsewhere', () => {
    openProject(store, withDefinition('Navbar'), null, 1);
    const project = store.editorUI.currentProject!;
    project.components.get('nav')!.page.setSlug('saved-here');
    const saved = getSnapshot(project) as unknown as ProjectSnapshotOut;
    markServerVersion(project.id, saved, 1);
    const out = openProject(store, JSON.parse(JSON.stringify(saved)) as ProjectSnapshotOut, null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
  });

  it('a snapshot with no components key compares equal to none', () => {
    const base = withDefinition(null);
    openProject(store, base, null, 1);
    const oldShape: Partial<ProjectSnapshotOut> = { ...base };
    delete oldShape.components;
    const out = openProject(store, oldShape as ProjectSnapshotOut, null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
  });

  it('the warning names the components and stays as it was without any', () => {
    expect(changedElsewhereMessage(['Footer', 'Navbar'])).toContain('Components changed there: Footer, Navbar.');
    expect(changedElsewhereMessage([])).not.toContain('Components');
  });
});

describe('openProject compares the site theme and head items too', () => {
  const ACCENT = { id: 'ab12cd34', name: 'Accent', kind: 'color', light: '#ff0000' };

  function withTheme(light: string | null, head: unknown[] = []): ProjectSnapshotOut {
    const snap = JSON.parse(JSON.stringify(serverSnapshot())) as ProjectSnapshotOut;
    const tokens = light === null ? [] : [{ ...ACCENT, light }];
    (snap as { siteSettings: unknown }).siteSettings = { ...snap.siteSettings, theme: { tokens, document: {} }, head };
    return snap;
  }

  it('a second tab with unsaved work of its own, reloading after a token edit, is warned and told the theme moved', () => {
    openProject(store, withTheme('#ff0000'), null, 1);
    store.editorUI.currentProject!.createPage('Unsaved here');
    const out = openProject(store, withTheme('#00ff00'), null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    expect(out.changedSiteParts).toEqual(['theme']);
    expect(changedElsewhereMessage(out.changedDefinitions, out.changedSiteParts)).toContain('the site theme (colours, fonts and colour mode)');
  });

  it('with no unsaved work here, takes the theme saved elsewhere', () => {
    openProject(store, withTheme('#ff0000'), null, 1);
    const out = openProject(store, withTheme('#00ff00'), null, 1);
    expect(out.keptWorkingCopy).toBe(false);
    expect(store.editorUI.currentProject!.site.theme.tokens[0]).toMatchObject({ light: '#00ff00' });
  });

  it('an unsaved token edit here, with the server unchanged, keeps the working copy', () => {
    const base = withTheme('#ff0000');
    openProject(store, base, null, 1);
    const project = store.editorUI.currentProject!;
    expect(project.updateTheme({ ...project.site.theme, mode: 'dark' })).toEqual({ ok: true });
    const out = openProject(store, base, null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
    expect(store.editorUI.currentProject!.site.theme.mode).toBe('dark');
  });

  it('a token edit here against a theme changed elsewhere is a conflict too', () => {
    openProject(store, withTheme('#ff0000'), null, 1);
    const project = store.editorUI.currentProject!;
    project.updateTheme({ ...project.site.theme, mode: 'dark' });
    const out = openProject(store, withTheme('#00ff00'), null, 1);
    expect(out.changedElsewhere).toBe(true);
    expect(out.changedSiteParts).toEqual(['theme']);
  });

  it('site head items changed elsewhere are named too', () => {
    openProject(store, withTheme(null), null, 1);
    store.editorUI.currentProject!.createPage('Unsaved here');
    const out = openProject(store, withTheme(null, [{ kind: 'meta', name: 'author', content: 'x' }]), null, 1);
    expect(out.changedSiteParts).toEqual(['head']);
    expect(changedElsewhereMessage([], out.changedSiteParts)).toContain("the site's head items");
  });

  it('a server copy from before the keys existed compares equal to an empty theme', () => {
    const base = withTheme(null);
    openProject(store, base, null, 1);
    const old = JSON.parse(JSON.stringify(base)) as ProjectSnapshotOut;
    delete (old.siteSettings as { theme?: unknown }).theme;
    delete (old.siteSettings as { head?: unknown }).head;
    store.editorUI.currentProject!.createPage('Unsaved here');
    expect(openProject(store, old, null, 1).changedElsewhere).toBe(false);
  });

  it('other site settings are not compared, as before', () => {
    const base = withTheme(null);
    openProject(store, base, null, 1);
    store.editorUI.currentProject!.createPage('Unsaved here');
    const renamed = { ...base, siteSettings: { ...base.siteSettings, siteName: 'Elsewhere' } } as ProjectSnapshotOut;
    expect(openProject(store, renamed, null, 1).changedElsewhere).toBe(false);
  });
});

describe('openProject when the server copy changed meanwhile', () => {
  function savedElsewhere(): ProjectSnapshotOut {
    // Same project, a page added by another tab or person and saved.
    const snap = serverSnapshot();
    const p = ProjectModel.create(JSON.parse(JSON.stringify(snap)));
    p.createPage('Added elsewhere');
    return getSnapshot(p) as ProjectSnapshotOut;
  }

  it('no unsaved work here: takes the newer server copy', () => {
    openProject(store, serverSnapshot(), null, 1);
    const newer = savedElsewhere();
    const out = openProject(store, newer, null, 1);
    expect(out.keptWorkingCopy).toBe(false);
    expect(out.changedElsewhere).toBe(false);
    expect(store.editorUI.currentProject!.pagesArray.map((p) => p.metadata.title)).toContain('Added elsewhere');
  });

  it('unsaved work here too: keeps it and reports the conflict', () => {
    openProject(store, serverSnapshot(), null, 1);
    store.editorUI.currentProject!.createPage('Generated here, not saved');
    const out = openProject(store, savedElsewhere(), null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    expect(store.editorUI.currentProject!.pagesArray.map((p) => p.metadata.title)).toContain('Generated here, not saved');
  });

  it('after this tab saved, its own save is not mistaken for a change elsewhere', () => {
    openProject(store, serverSnapshot(), null, 1);
    const project = store.editorUI.currentProject!;
    project.createPage('Saved from here');
    const saved = getSnapshot(project) as unknown as ProjectSnapshotOut;
    markServerVersion(project.id, saved, 1);
    // The server now returns what this tab saved (key order may differ).
    const fromServer = JSON.parse(JSON.stringify(saved)) as ProjectSnapshotOut;
    const out = openProject(store, fromServer, null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
  });

  it('a frameless page repaired on load compares equal on the next load', () => {
    const snap = JSON.parse(JSON.stringify(serverSnapshot())) as ProjectSnapshotOut;
    const firstPage = Object.keys(snap.pages)[0];
    (snap.pages[firstPage] as { canvasNodes: unknown }).canvasNodes = {};
    const repaired = { ...snap, pages: { ...snap.pages, [firstPage]: withDefaultViewports(snap.pages[firstPage]) } };
    openProject(store, repaired as ProjectSnapshotOut, null, 1);
    const again = { ...snap, pages: { ...snap.pages, [firstPage]: withDefaultViewports(snap.pages[firstPage]) } };
    const out = openProject(store, again as ProjectSnapshotOut, null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
  });

  it('a checkout given its parts on load compares equal to the stored one without them', () => {
    // The server's load path writes a shop control's parts (src/lib/commerce/parts.ts);
    // the row keeps the old shape until the next Save. Neither is a change elsewhere.
    const snap = JSON.parse(JSON.stringify(serverSnapshot())) as ProjectSnapshotOut;
    const firstPage = Object.keys(snap.pages)[0];
    const tree = (snap.pages[firstPage] as { appComponentTree: { children?: unknown[] } }).appComponentTree;
    tree.children = [
      ...(tree.children ?? []),
      { id: 'co', type: 'div', componentType: 'host', props: { 'data-component-kind': 'checkout-button', label: 'Kaufen' } },
    ];
    const repaired = { ...snap, pages: { ...snap.pages, [firstPage]: pageWithShopParts(snap.pages[firstPage], 'en') } };
    openProject(store, repaired as ProjectSnapshotOut, null, 1);
    const out = openProject(store, snap, null, 1);
    expect(out.changedElsewhere).toBe(false);
    expect(out.keptWorkingCopy).toBe(true);
  });

});

describe('openProject after personal data was erased (plan 2026-11-01-immutable-published-copy)', () => {
  /** The server copy after an erase: a business detail rewritten, which no compared part shows, and the epoch moved. */
  function erased(from: ProjectSnapshotOut = serverSnapshot()): ProjectSnapshotOut {
    const snap = JSON.parse(JSON.stringify(from)) as ProjectSnapshotOut;
    return {
      ...snap,
      metadata: { ...snap.metadata, erasureEpoch: 1 },
      siteSettings: { ...snap.siteSettings, business: { ...snap.siteSettings.business, managingDirectors: ['[entfernt]'] } },
    } as ProjectSnapshotOut;
  }

  it('no unsaved work here: takes the server copy, epoch included', () => {
    const base = serverSnapshot();
    openProject(store, base, null, 1);
    // Pages, components, theme and head are the same: only the epoch tells the copies apart.
    const out = openProject(store, erased(base), null, 1);
    expect(out.keptWorkingCopy).toBe(false);
    expect(store.editorUI.currentProject!.metadata.erasureEpoch).toBe(1);
    expect(store.editorUI.currentProject!.siteSettings.business.managingDirectors).toEqual(['[entfernt]']);
  });

  it('unsaved work here: keeps it at the old epoch and warns, so its Save is refused by the server', () => {
    const base = serverSnapshot();
    openProject(store, base, null, 1);
    store.editorUI.currentProject!.createPage('Unsaved here');
    const out = openProject(store, erased(base), null, 1);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    expect(store.editorUI.currentProject!.metadata.erasureEpoch).toBe(0);
  });

  it('a copy with no baseline in this tab is compared by its epoch alone, without failing', () => {
    // A project in the store with no baseline recorded for it (ingested without openProject).
    const base = serverSnapshot();
    const unknown = { ...base, id: 'site_no_baseline' } as ProjectSnapshotOut;
    store.projectStore.ingestProjectSnapshot(unknown);
    const out = openProject(store, erased(unknown), null, 1);
    expect(out.changedElsewhere).toBe(true);
    expect(out.changedDefinitions).toEqual([]);
  });

  it('the same epoch on both sides changes nothing', () => {
    const snap = erased();
    openProject(store, snap, null, 1);
    expect(openProject(store, JSON.parse(JSON.stringify(snap)) as ProjectSnapshotOut, null, 1).keptWorkingCopy).toBe(true);
  });
});

describe('restoreStashedDemo (back on `/` after choosing a company or signing in)', () => {
  it('brings the stashed demo project back as the demo, on the requested page', async () => {
    const { stashDemoProject } = await import('@/lib/projects/demoStash');
    const { restoreStashedDemo } = await import('../openProject');
    const demo = ProjectModel.create({ id: 'demo-1', metadata: { title: 'Framer Clone Demo', description: '' }, pages: {} });
    const page = demo.createPage('Generated');
    stashDemoProject(getSnapshot(demo));

    expect(restoreStashedDemo(store, page.id)).toBe(true);
    expect(store.editorUI.currentProject?.id).toBe('demo-1');
    expect(store.editorUI.currentPage?.id).toBe(page.id);
    expect(store.editorUI.isUnsavedDemo).toBe(true);
    // Taken once: a second mount seeds a fresh demo instead.
    expect(restoreStashedDemo(store, null)).toBe(false);
  });

  it('ignores a stash that is not a project', async () => {
    const { stashDemoProject } = await import('@/lib/projects/demoStash');
    const { restoreStashedDemo } = await import('../openProject');
    stashDemoProject({ nope: true });
    expect(restoreStashedDemo(store, null)).toBe(false);
    stashDemoProject({ id: 'x', pages: 'broken' });
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(restoreStashedDemo(store, null)).toBe(false);
    spy.mockRestore();
  });
});

describe('openProject and the version order (review of 2026-11-04)', () => {
  let n = 0;
  function snapshotFor(id: string, description = ''): ProjectSnapshotOut {
    const p = ProjectModel.create({ id, metadata: { title: 'Site', description }, pages: {} });
    p.createPage('Home').setSlug('');
    return getSnapshot(p) as ProjectSnapshotOut;
  }

  it('a LOWER server version is a stale read: the working copy and its version stand, nothing is adopted', () => {
    const id = `site_order_${++n}`;
    const project = openProject(store, snapshotFor(id, 'version 5'), null, 5).project!;
    // Autosave went on to version 9 with this tab's work.
    project.updateMetadata({ description: 'saved at 9' });
    markServerVersion(id, getSnapshot(project), 9);
    project.updateMetadata({ description: 'typed after 9' });
    // Back after Preview: the router cache replays the payload read at version 5.
    const out = openProject(store, snapshotFor(id, 'version 5'), null, 5);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(false);
    expect(store.editorUI.currentProject?.metadata.description).toBe('typed after 9');
    expect(knownServerVersion(id)).toBe(9);
    expect(changedElsewhereVersion(id)).toBeUndefined();
  });

  it('a stale read of a clean tab changes nothing either', () => {
    const id = `site_order_${++n}`;
    const project = openProject(store, snapshotFor(id), null, 4).project!;
    project.updateMetadata({ description: 'saved at 6' });
    markServerVersion(id, getSnapshot(project), 6);
    const out = openProject(store, snapshotFor(id), null, 4);
    expect(out.project).toBe(project);
    expect(project.metadata.description).toBe('saved at 6');
    expect(knownServerVersion(id)).toBe(6);
  });

  it('an unsaved edit of the legal details is kept over a newer server copy, and warned about', () => {
    const id = `site_order_${++n}`;
    const project = openProject(store, snapshotFor(id), null, 3).project!;
    project.updateSiteSettings({ business: { legalName: 'Bäckerei Müller GmbH' } });
    // Someone else saved meanwhile (the version moved), with the old legal details.
    const out = openProject(store, snapshotFor(id), null, 4);
    expect(out.keptWorkingCopy).toBe(true);
    expect(out.changedElsewhere).toBe(true);
    expect(store.editorUI.currentProject?.site.business.legalName).toBe('Bäckerei Müller GmbH');
    expect(knownServerVersion(id)).toBe(3);
  });

  it('an unsaved description edit is kept too', () => {
    const id = `site_order_${++n}`;
    const project = openProject(store, snapshotFor(id), null, 3).project!;
    project.updateMetadata({ description: 'mine' });
    const out = openProject(store, snapshotFor(id), null, 4);
    expect(out.keptWorkingCopy).toBe(true);
    expect(store.editorUI.currentProject?.metadata.description).toBe('mine');
  });
});
