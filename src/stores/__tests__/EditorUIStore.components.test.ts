// Editing a definition on the canvas, over the four stateful paths: forward (enter,
// edit, leave), backtrack (undo from the page), resume (the way back is volatile, and
// a reloaded project keeps ids) and re-entry (a definition gone while it is open).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';

const host = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  id,
  type,
  componentType: 'host',
  props,
  children,
});

const placement = (id: string, component: string) => host(id, '#component', { component });

const definition = (id: string, tree: Record<string, unknown>) => ({
  id,
  name: id === 'card' ? 'Card' : id,
  page: { id: `page-${id}`, metadata: { title: 'Stale title' }, appComponentTree: tree, canvasNodes: {} },
  inputs: [],
  states: [],
});

const CARD = definition('card', host('c-root', 'article', {}, [host('c-title', 'h3', { children: 'Title' })]));
const GRID = definition('grid', host('g-root', 'section', {}, [placement('inner', 'card')]));

let store: RootStoreType;
let project: ProjectModelType;
let home: PageModelType;

const ui = () => store.editorUI;
const rootOf = (page: PageModelType) => page.appComponentTree as unknown as ComponentInstance;

function setup() {
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: { card: CARD, grid: GRID } as never });
  project = store.projectStore.getProject('site') as ProjectModelType;
  home = project.createPage('Home');
  project.createPage('About');
  const placed = project.placeComponent(home.id, 'card', { kind: 'appTree' });
  if (!placed.ok) throw new Error(placed.message);
  ui().setCurrentProject(project);
  ui().setCurrentPage(home);
  ui().selectComponent(placed.placement, home.sortedViewportNodes[0].breakpointId);
  return placed.placement.id;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('entering and leaving a definition', () => {
  it('opens the definition, then restores the page, the selection, its frame and the camera', () => {
    const placementId = setup();
    const frame = ui().selectedViewportNode?.breakpointId;
    const camera = { position: { zoom: 2, panX: 5, panY: 6 }, read() { return this.position; }, write(next: { zoom: number; panX: number; panY: number }) { this.position = next; } };
    ui().setCanvasCamera(camera);

    ui().enterComponent('card', placementId);
    expect(ui().inComponent).toBe(true);
    expect(ui().currentPage?.id).toBe('page-card');
    expect(ui().selectedComponent?.id).toBe('c-root');

    camera.position = { zoom: 1, panX: 0, panY: 0 };
    ui().leaveComponent();
    expect(ui().inComponent).toBe(false);
    expect(ui().currentPage?.id).toBe(home.id);
    expect(ui().selectedComponent?.id).toBe(placementId);
    expect(ui().selectedViewportNode?.breakpointId).toBe(frame);
    expect(camera.position).toEqual({ zoom: 2, panX: 5, panY: 6 });
  });

  it('walks back through a nested definition one step at a time, or all the way', () => {
    const placementId = setup();
    ui().enterComponent('grid', placementId);
    ui().enterComponent('card', 'inner');
    expect(ui().componentTrail.map(back => back.pageId)).toEqual([home.id, 'page-grid']);
    ui().leaveComponent();
    expect(ui().currentPage?.id).toBe('page-grid');
    expect(ui().selectedComponent?.id).toBe('inner');
    ui().enterComponent('card', 'inner');
    ui().leaveComponent(0);
    expect(ui().currentPage?.id).toBe(home.id);
    expect(ui().inComponent).toBe(false);
  });

  it('does nothing for a definition that does not exist or is already open', () => {
    setup();
    ui().enterComponent('gone');
    expect(ui().inComponent).toBe(false);
    ui().enterComponent('card');
    ui().enterComponent('card');
    expect(ui().componentTrail).toHaveLength(1);
  });

  it('leaves through the Pages panel: the return page comes back as it was, another page simply opens', () => {
    const placementId = setup();
    ui().enterComponent('card', placementId);
    ui().setCurrentPage(home);
    expect(ui().inComponent).toBe(false);
    expect(ui().selectedComponent?.id).toBe(placementId);

    ui().enterComponent('card', placementId);
    const about = project.findPageBySlug('about') as PageModelType;
    ui().setCurrentPage(about);
    expect(ui().inComponent).toBe(false);
    expect(ui().currentPage?.id).toBe(about.id);
  });

  it('forgets the way back with the project', () => {
    const placementId = setup();
    ui().enterComponent('card', placementId);
    store.projectStore.ingestProjectSnapshot({ id: 'other', metadata: { title: 'Other' }, pages: {} });
    ui().setCurrentProject(store.projectStore.getProject('other'));
    expect(ui().inComponent).toBe(false);
  });

  it('names the definition and the page for the breadcrumb, from the definition and not its stale title', () => {
    const placementId = setup();
    ui().enterComponent('card', placementId);
    expect(project.pageName('page-card')).toBe('Card');
    expect(project.pageName(home.id)).toBe('Home');
    expect(ui().leaveTarget).toBe('Home');
    expect(project.placementCount('card')).toBe(2);
  });
});

describe('a definition gone while it is open', () => {
  it('returns to the page with a message when this tab deletes it, and the placement is a plain copy', () => {
    const placementId = setup();
    ui().enterComponent('card', placementId);
    expect(project.deleteDefinition('card').ok).toBe(true);
    expect(ui().currentPage?.id).toBe(home.id);
    expect(ui().inComponent).toBe(false);
    expect(ui().editorNotice?.message).toContain('back on Home');
  });

  it('returns to the page when an undo takes it away', () => {
    setup();
    const made = project.createComponentFromSelection(home.id, [rootOf(home).children[0].id], 'Made');
    if (!made.ok) throw new Error(made.message);
    const history = getHistoryStore()!;
    ui().enterComponent(made.definitionId, made.placement.id);
    history.undo();
    expect(project.components.has(made.definitionId)).toBe(false);
    expect(ui().currentPage?.id).toBe(home.id);
    expect(ui().editorNotice?.kind).toBe('missingPage');
  });

  it('goes further out when the page it came from went too', () => {
    const placementId = setup();
    ui().enterComponent('grid', placementId);
    ui().enterComponent('card', 'inner');
    project.deleteDefinition('grid');
    expect(ui().currentPage?.id).toBe('page-card');
    project.deleteDefinition('card');
    expect(ui().currentPage?.id).toBe(home.id);
    expect(ui().inComponent).toBe(false);
  });
});

describe('a definition gone from a newer copy of the project', () => {
  it('returns to the page when a reload of the same project no longer holds it', () => {
    const placementId = setup();
    ui().enterComponent('card', placementId);
    const stored = JSON.parse(JSON.stringify(getSnapshot(project))) as { components: Record<string, unknown> };
    delete stored.components.card;
    store.projectStore.ingestProjectSnapshot(stored as never);
    const reloaded = store.projectStore.getProject('site') as ProjectModelType;
    expect(ui().currentPage?.id).toBe(reloaded.pages.get(home.id)?.id);
    expect(ui().inComponent).toBe(false);
  });
});

describe('the address', () => {
  it('keeps naming the real page while a definition is open', () => {
    const placementId = setup();
    ui().enterComponent('card', placementId);
    expect(ui().addressPageId).toBe(home.id);
    ui().leaveComponent();
    expect(ui().addressPageId).toBe(home.id);
  });
});

describe('a placement\'s name', () => {
  it('reads as its definition, follows a rename, and says so when the definition is gone', () => {
    const placementId = setup();
    const node = home.findComponent(placementId) as ComponentInstance;
    expect(node.displayName).toBe('Card');
    expect(project.renameDefinition('card', 'Tile').ok).toBe(true);
    expect(node.displayName).toBe('Tile');
    node.setProps({ component: 'gone' });
    expect(node.displayName).toBe('Missing component');
  });
});

describe('undo across placements', () => {
  it('undoes an edit made inside a definition from the page, under the definition\'s name', () => {
    const placementId = setup();
    const history = getHistoryStore()!;
    ui().enterComponent('card', placementId);
    const title = project.components.get('card')!.page.findComponent('c-title') as ComponentInstance;
    title.setProps({ children: 'Edited' });
    ui().leaveComponent();
    const entry = history.history[history.history.length - 1];
    expect(history.labelFor(entry)).toContain('Card: ');
    history.undo();
    expect(title.props.children).toBe('Title');
    expect(ui().currentPage?.id).toBe(home.id);
  });
});
