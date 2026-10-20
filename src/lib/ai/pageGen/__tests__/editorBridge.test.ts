// Apply and undo of generated components against a REAL editor store
// (RootStore + HistoryStore), so "one generation = one undo step" is proven,
// not assumed.

import { beforeEach, describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { validateGeneration } from '../validate';
import { deriveBreakpointKeys } from '../schema';
import {
  applyResult,
  buildRequest,
  captureTarget,
  describeTargetAvailability,
  undoGeneration,
  type CapturedTarget,
} from '../editorBridge';
import type { PageGenResultPayload } from '../protocol';

let store: RootStoreType;
let project: ProjectModelType;
let page: PageModelType;

function result(raw: unknown, target: CapturedTarget): PageGenResultPayload {
  const out = validateGeneration(raw, {
    breakpoints: deriveBreakpointKeys(target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth }))),
  });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { generationId: 'gen-1', model: 'claude-sonnet-5-5', ...out.result };
}

const HERO = {
  title: 'Bakery',
  nodes: [
    {
      type: 'section',
      label: 'Hero',
      props: { style: { padding: { base: '64px', mobile: '24px' } } },
      children: [{ type: 'h1', props: { children: 'Fresh bread' } }],
    },
    { type: 'footer', label: 'Footer', props: { children: 'Bye' } },
  ],
};

function tree(): ComponentInstance {
  return page.appComponentTree as ComponentInstance;
}

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  project = store.projectStore.findProjectByTitle('Crumb')!;
  page = project.createPage('Home');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  // A known starting tree: root > [intro section > [p]]
  page.insertRegistryComponent('container', { kind: 'appTree' });
  getHistoryStore()!.clear();
});

describe('captureTarget / buildRequest', () => {
  it('captures the page breakpoints with their real ids, largest first in the request keys', () => {
    const target = captureTarget('newPage', page, undefined);
    expect(target.breakpoints.map((b) => b.label).sort()).toEqual(['Desktop', 'Mobile', 'Tablet']);
    const req = buildRequest({ brief: ' A bakery ', model: 'SONNET', target, project, pageTitle: 'Menu' });
    expect(req.brief).toBe('A bakery');
    expect(req.target).toEqual({ kind: 'newPage', title: 'Menu' });
    expect(req.existingPageTitles).toContain('Home');
    expect(JSON.stringify(req)).not.toContain(target.breakpoints[0].id); // ids never leave the client
  });

  it('sends the selected subtree as context for replace', () => {
    const container = tree().children[0] as ComponentInstance;
    const req = buildRequest({ brief: 'x', model: 'HAIKU', target: captureTarget('replace', page, container), project });
    expect(req.target.kind).toBe('replace');
    expect(JSON.stringify(req.target)).toContain(container.id);
  });

  it('explains why a target is unavailable', () => {
    expect(describeTargetAvailability('replace', page, undefined)).toMatchObject({ ok: false });
    const viewport = page.viewportNodes[0] as ComponentInstance;
    expect(describeTargetAvailability('insert', page, viewport)).toMatchObject({ ok: false });
    expect(describeTargetAvailability('replace', page, tree())).toEqual({ ok: true, label: 'Everything on this page' });
    expect(describeTargetAvailability('newPage', page, undefined)).toEqual({ ok: true, label: 'A new page' });
    // A void tag cannot receive children: the dialog says so, matching applyGeneratedNodes.
    page.insertRegistryComponent('image', { kind: 'appTree' });
    const img = tree().children.at(-1) as ComponentInstance;
    expect(describeTargetAvailability('insert', page, img)).toMatchObject({ ok: false });
  });
});

describe('applyResult', () => {
  it('creates a new page with the same breakpoint ids, responsive keys mapped, as ONE history entry', () => {
    const target = captureTarget('newPage', page, undefined);
    const applied = applyResult(project, target, result(HERO, target));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const created = project.getPage(applied.value.pageId)!;
    expect(created.metadata.title).toBe('Bakery');
    const hero = (created.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
    const desktop = target.breakpoints.find((b) => b.label === 'Desktop')!.id;
    const mobile = target.breakpoints.find((b) => b.label === 'Mobile')!.id;
    expect(hero.props.style.padding).toEqual({ base: '64px', [mobile]: '24px', [desktop]: '64px' });
    expect(hero.parentId).toBe(created.appComponentTree.id);
    expect((hero.children[0] as ComponentInstance).parentId).toBe(hero.id);
    expect(created.viewportNodes.map((v: ComponentInstance) => v.breakpointId).sort()).toEqual(
      target.breakpoints.map((b) => b.id).sort(),
    );
    // Responsive resolution through the real model.
    const bps = target.breakpoints.map((b) => ({ id: b.id, minWidth: b.minWidth }));
    expect(hero.getResolvedProps(mobile, bps, desktop).style.padding).toBe('24px');
    expect(hero.getResolvedProps(target.breakpoints.find((b) => b.label === 'Tablet')!.id, bps, desktop).style.padding).toBe('64px');

    const history = getHistoryStore()!;
    expect(history.history.length).toBe(1);
    history.undo();
    expect(project.getPage(applied.value.pageId)).toBeUndefined();
  });

  it('a user-given page title wins over the model title', () => {
    const target = captureTarget('newPage', page, undefined);
    const applied = applyResult(project, target, result(HERO, target), 'Our menu');
    if (!applied.ok) throw new Error(applied.reason);
    expect(project.getPage(applied.value.pageId)!.metadata.title).toBe('Our menu');
  });

  it('replaces a nested component in place, as ONE history entry Cmd+Z reverts', () => {
    const before = getSnapshot(tree());
    const container = tree().children[0] as ComponentInstance;
    const target = captureTarget('replace', page, container);
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(tree().children.map((c: ComponentInstance) => c.label)).toEqual(['Hero', 'Footer']);
    expect(getHistoryStore()!.history.length).toBe(1);
    getHistoryStore()!.undo();
    expect(getSnapshot(tree())).toEqual(before);
  });

  it('replacing the root swaps its children and keeps the root', () => {
    const rootId = tree().id;
    const target = captureTarget('replace', page, tree());
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(tree().id).toBe(rootId);
    expect(tree().children).toHaveLength(2);
    expect(applied.value.record.kind).toBe('replaceRootChildren');
  });

  it('inserts inside a container, appended after existing children', () => {
    const target = captureTarget('insert', page, tree());
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(tree().children.map((c: ComponentInstance) => c.label)).toEqual(['Container', 'Hero', 'Footer']);
  });

  it('refuses (and changes nothing) when the captured target was deleted meanwhile', () => {
    const container = tree().children[0] as ComponentInstance;
    const target = captureTarget('replace', page, container);
    page.deleteComponent(container.id);
    const before = getSnapshot(tree());
    const applied = applyResult(project, target, result(HERO, target));
    expect(applied).toEqual({ ok: false, reason: 'The selected component no longer exists on this page.' });
    expect(getSnapshot(tree())).toEqual(before);
  });

  it('refuses when the captured page was removed meanwhile', () => {
    const other = project.createPage('Other');
    const target = captureTarget('insert', other, other.appComponentTree as ComponentInstance);
    project.removePage(other.id);
    expect(applyResult(project, target, result(HERO, target)).ok).toBe(false);
  });

  it('refuses to insert into a text node', () => {
    page.insertRegistryComponent('text', { kind: 'appTree' });
    const text = tree().children[1] as ComponentInstance;
    const target = captureTarget('insert', page, text);
    const applied = applyResult(project, target, result(HERO, target));
    expect(applied.ok).toBe(false);
  });
});

describe('undoGeneration', () => {
  it('reverts a replace and restores the original subtree with its ids', () => {
    const container = tree().children[0] as ComponentInstance;
    const containerId = container.id;
    const target = captureTarget('replace', page, container);
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(undoGeneration(project, applied.value.record)).toEqual({ ok: true, value: null });
    expect(tree().children.map((c: ComponentInstance) => c.id)).toEqual([containerId]);
    expect((tree().children[0] as ComponentInstance).parentId).toBe(tree().id);
    // The undo is itself one history entry (so it can be redone).
    expect(getHistoryStore()!.history.length).toBe(2);
  });

  it('reverts an insert and a root replace', () => {
    let target = captureTarget('insert', page, tree());
    let applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(undoGeneration(project, applied.value.record).ok).toBe(true);
    expect(tree().children).toHaveLength(1);

    const originalChild = (tree().children[0] as ComponentInstance).id;
    target = captureTarget('replace', page, tree());
    applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(undoGeneration(project, applied.value.record).ok).toBe(true);
    expect(tree().children.map((c: ComponentInstance) => c.id)).toEqual([originalChild]);
  });

  it('reports "already undone" after Cmd+Z instead of guessing', () => {
    const target = captureTarget('insert', page, tree());
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    getHistoryStore()!.undo();
    expect(undoGeneration(project, applied.value.record)).toEqual({ ok: false, reason: 'This generation was already undone.' });
  });

  it('refuses when generated nodes were moved since, leaving the tree alone', () => {
    const target = captureTarget('insert', page, tree());
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    const container = tree().children[0] as ComponentInstance;
    const footer = tree().children[2] as ComponentInstance;
    page.moveTreeComponent(footer.id, { kind: 'parent', parentId: container.id });
    const before = getSnapshot(tree());
    expect(undoGeneration(project, applied.value.record).ok).toBe(false);
    expect(getSnapshot(tree())).toEqual(before);
  });

  it('removes a generated page and hands back the page to show', () => {
    const target = captureTarget('newPage', page, undefined);
    const applied = applyResult(project, target, result(HERO, target));
    if (!applied.ok) throw new Error(applied.reason);
    let shown: string | undefined;
    expect(undoGeneration(project, applied.value.record, (id) => (shown = id)).ok).toBe(true);
    expect(shown).toBe(page.id);
    expect(project.getPage(applied.value.pageId)).toBeUndefined();
    expect(undoGeneration(project, applied.value.record).ok).toBe(false);
  });
});
