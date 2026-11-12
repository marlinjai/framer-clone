// Apply and undo of generated components against a REAL editor store
// (RootStore + HistoryStore), so "one generation = one undo step" is proven,
// not assumed.

import { beforeEach, describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { validateGeneration, type ValidateContext } from '../validate';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
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

const NO_IMAGES = { requested: 0, resolved: 0, fellBack: {}, credits: [] };

let store: RootStoreType;
let project: ProjectModelType;
let page: PageModelType;

function result(raw: unknown, target: CapturedTarget): PageGenResultPayload {
  const out = validateGeneration(raw, {
    breakpoints: deriveBreakpointKeys(target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth }))),
  });
  if (!out.ok) throw new Error(out.errors.join('; '));
  // The image requests are server-side data the route never sends.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { imageRequests, ...result } = out.result;
  return { generationId: 'gen-1', model: 'claude-sonnet-5-5', ...result, images: NO_IMAGES };
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

describe('a page without breakpoint frames (dashboard "New project" before the fix)', () => {
  it('gets the default frames before capture, so generated styles key to real frame ids', () => {
    for (const v of [...page.viewportNodes]) page.removeCanvasNode(v.id);
    expect(page.viewportNodes).toHaveLength(0);
    const root = tree();

    const target = captureTarget('replace', page, root.children[0] as ComponentInstance);

    const frameIds = page.sortedViewportNodes.map((v) => v.breakpointId);
    expect(frameIds).toHaveLength(3);
    expect(target.breakpoints.map((b) => b.id).sort()).toEqual([...frameIds].sort());
    const applied = applyResult(project, target, result(HERO, target));
    expect(applied.ok).toBe(true);
    // The hero's Mobile padding is keyed to the Mobile frame, so it renders.
    const hero = tree().children.find((c: ComponentInstance) => c.label === 'Hero') as ComponentInstance;
    const padding = hero.props.style.padding as Record<string, string>;
    const mobileId = page.sortedViewportNodes.find((v) => v.label === 'Mobile')!.breakpointId!;
    expect(padding.base).toBe('64px');
    expect(padding[mobileId]).toBe('24px');
    // Every responsive key is base or a frame that exists on the page.
    for (const key of Object.keys(padding)) expect(['base', ...frameIds]).toContain(key);
  });
});

describe('frame repair at capture is not an undo step, and only for the target page', () => {
  it('undoing a generation into a frameless page keeps its frames', () => {
    for (const v of [...page.viewportNodes]) page.removeCanvasNode(v.id);
    getHistoryStore()!.clear();
    const target = captureTarget('replace', page, tree().children[0] as ComponentInstance);
    expect(getHistoryStore()!.canUndo).toBe(false); // the repair itself is not undoable
    expect(applyResult(project, target, result(HERO, target)).ok).toBe(true);
    getHistoryStore()!.undo(); // undo the generation
    expect(page.viewportNodes).toHaveLength(3);
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('a NEW page generated while a frameless page is open leaves that page alone', () => {
    for (const v of [...page.viewportNodes]) page.removeCanvasNode(v.id);
    const target = captureTarget('newPage', page, undefined);
    expect(page.viewportNodes).toHaveLength(0);
    expect(target.viewports.map((v) => v.label)).toEqual(['Desktop', 'Tablet', 'Mobile']);
    const applied = applyResult(project, target, result(HERO, target));
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(project.getPage(applied.value.pageId)!.viewportNodes).toHaveLength(3);
  });
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

  it('sends the site language and contact data from Site settings', () => {
    project.updateSiteSettings({ ...project.site, language: 'de', business: { ...project.site.business, phone: '+49 89 1' } });
    const req = buildRequest({ brief: 'x', model: 'SONNET', target: captureTarget('newPage', page, undefined), project });
    expect(req.siteContext).toMatchObject({ language: 'de', phone: '+49 89 1', siteName: project.metadata.title });
  });

  it('sends the selected subtree as context for replace', () => {
    const container = tree().children[0] as ComponentInstance;
    const req = buildRequest({ brief: 'x', model: 'HAIKU', target: captureTarget('replace', page, container), project });
    expect(req.target.kind).toBe('replace');
    expect(JSON.stringify(req.target)).toContain(container.id);
  });

  it('sends the closed element a result would stand under, so no preset is placed there', () => {
    const container = tree().children[0] as ComponentInstance;
    const placed = applyResult(project, captureTarget('insert', page, container), result({ nodes: [
      { type: 'p', children: [{ type: 'em', children: [{ type: '#text', props: { children: 'Fresh' } }] }] },
      { type: 'button', props: { type: 'button' }, children: [{ type: 'span', children: [{ type: '#text', props: { children: 'Go' } }] }] },
    ] }, captureTarget('insert', page, container)));
    expect(placed.ok).toBe(true);
    const [para, button] = container.children as ComponentInstance[];
    const request = (kind: 'insert' | 'replace', selected: ComponentInstance) =>
      buildRequest({ brief: 'x', model: 'HAIKU', target: captureTarget(kind, page, selected), project }).target;
    expect(request('insert', para)).toMatchObject({ kind: 'insert', closedAncestor: 'p' });
    expect(request('insert', para.children[0] as ComponentInstance)).toMatchObject({ closedAncestor: 'p' });
    expect(request('replace', button.children[0] as ComponentInstance)).toMatchObject({ kind: 'replace', closedAncestor: 'button' });
    expect(request('insert', container)).not.toHaveProperty('closedAncestor');
    expect(request('replace', para)).not.toHaveProperty('closedAncestor');
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
    expect(hero.props.style.padding).toEqual({ base: '64px', [mobile]: '24px' });
    expect(hero.parentId).toBe(created.appComponentTree.id);
    expect((hero.children[0] as ComponentInstance).parentId).toBe(hero.id);
    expect(created.viewportNodes.map((v: ComponentInstance) => v.breakpointId).sort()).toEqual(
      target.breakpoints.map((b) => b.id).sort(),
    );
    // Responsive resolution through the real model.
    const bps = target.breakpoints.map((b) => ({ id: b.id, minWidth: b.minWidth }));
    expect(hero.getResolvedProps(mobile, bps).style.padding).toBe('24px');
    expect(hero.getResolvedProps(target.breakpoints.find((b) => b.label === 'Tablet')!.id, bps).style.padding).toBe('64px');
    expect(hero.getResolvedProps(desktop, bps).style.padding).toBe('64px');

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
    expect(undoGeneration(project, applied.value.record)).toEqual({ ok: true, value: { kept: [] } });
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

// --- The tokens a generation adds to the site theme (slice T5) ---------------------------------
describe('a generation that adds site tokens', () => {
  const siteTheme = () => normalizeSiteSettings(project.siteSettings).theme;
  const ref = (id: string) => `var(--fc-t-${id})`;
  let n = 0;
  const fresh = () => ((n += 1) * 0.6180339887) % 1;

  /** A validated result against the project's own theme, as the server would have made it. */
  function themedResult(raw: unknown, target: CapturedTarget, over: Partial<ValidateContext> = {}): PageGenResultPayload {
    const out = validateGeneration(raw, {
      breakpoints: deriveBreakpointKeys(target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth }))),
      theme: siteTheme(),
      random: fresh,
      ...over,
    });
    if (!out.ok) throw new Error(out.errors.join('; '));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { imageRequests, ...rest } = out.result;
    return { generationId: 'gen-t', model: 'claude-sonnet-5-5', ...rest, images: NO_IMAGES };
  }

  const crust = { ref: 'new-1', name: 'Crust', kind: 'color', light: '#f3e9dc', dark: '#2b1b0f' };
  const PAGE = {
    title: 'Bakery',
    theme: { tokens: [crust] },
    nodes: [{ type: 'section', label: 'Hero', props: { style: { backgroundColor: 'var(--fc-t-new-1)' }, children: 'Hi' } }],
  };

  it('lands the page and its tokens as ONE history entry, and one undo takes both', () => {
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult(PAGE, target);
    const before = JSON.stringify(siteTheme());
    const applied = applyResult(project, target, payload);
    if (!applied.ok) throw new Error(applied.reason);
    expect(siteTheme().tokens.map((t) => t.name)).toEqual(['Crust']);
    const id = siteTheme().tokens[0].id;
    const created = project.getPage(applied.value.pageId)!;
    expect(((created.appComponentTree as ComponentInstance).children[0] as ComponentInstance).props.style.backgroundColor).toBe(ref(id));
    expect(getHistoryStore()!.history.length).toBe(1);
    getHistoryStore()!.undo();
    expect(project.getPage(applied.value.pageId)).toBeUndefined();
    expect(JSON.stringify(siteTheme())).toBe(before);
  });

  it('Undo then Redo restores the page, its nodes and the token exactly: the project is the same document as after the apply', () => {
    const target = captureTarget('newPage', page, undefined);
    const applied = applyResult(project, target, themedResult(PAGE, target));
    if (!applied.ok) throw new Error(applied.reason);
    const afterApply = JSON.stringify(getSnapshot(project));
    const tokenId = siteTheme().tokens[0].id;
    getHistoryStore()!.undo();
    expect(project.getPage(applied.value.pageId)).toBeUndefined();
    expect(siteTheme().tokens).toHaveLength(0);
    getHistoryStore()!.redo();
    const created = project.getPage(applied.value.pageId)!;
    expect(created).toBeDefined();
    expect(((created.appComponentTree as ComponentInstance).children[0] as ComponentInstance).props.style.backgroundColor).toBe(ref(tokenId));
    expect(siteTheme().tokens.map((t) => t.id)).toEqual([tokenId]);
    // Nothing differs from the document the apply produced, so a save after Redo stores the same thing.
    expect(JSON.stringify(getSnapshot(project))).toBe(afterApply);
    // And the history is back where it was: one entry, nothing left to redo, one to undo.
    expect(getHistoryStore()!.history.length).toBe(1);
    expect(getHistoryStore()!.canRedo).toBe(false);
    expect(getHistoryStore()!.canUndo).toBe(true);
  });

  it('does the same for a replace into an existing page', () => {
    const container = tree().children[0] as ComponentInstance;
    const target = captureTarget('replace', page, container);
    const applied = applyResult(project, target, themedResult(PAGE, target));
    if (!applied.ok) throw new Error(applied.reason);
    expect(siteTheme().tokens).toHaveLength(1);
    expect(getHistoryStore()!.history.length).toBe(1);
    getHistoryStore()!.undo();
    expect(siteTheme().tokens).toHaveLength(0);
  });

  it('a page without tokens does not touch the theme, and a project with none keeps its theme key as it was', () => {
    const target = captureTarget('newPage', page, undefined);
    const before = JSON.stringify(project.siteSettings);
    const applied = applyResult(project, target, result(HERO, target));
    expect(applied.ok).toBe(true);
    expect(JSON.stringify(project.siteSettings)).toBe(before);
  });

  it('re-decides against the theme as it is now: a name that now holds other values refuses the apply and changes nothing', () => {
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult(PAGE, target);
    project.updateTheme({ ...siteTheme(), tokens: [{ id: 'mm44nn55', name: 'crust', kind: 'color', light: '#000000' }] });
    getHistoryStore()!.clear();
    const pages = project.pagesArray.length;
    const applied = applyResult(project, target, payload);
    expect(applied).toMatchObject({ ok: false });
    if (!applied.ok) expect(applied.reason).toMatch(/crust/i);
    expect(project.pagesArray.length).toBe(pages);
    expect(siteTheme().tokens.map((t) => (t as { light?: string }).light)).toEqual(['#000000']);
    expect(getHistoryStore()!.history.length).toBe(0);
  });

  it('reuses a token the site grew meanwhile with the same values, and points the page at it', () => {
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult(PAGE, target);
    project.updateTheme({ ...siteTheme(), tokens: [{ id: 'mm44nn55', name: 'Crust', kind: 'color', light: '#f3e9dc', dark: '#2b1b0f' }] });
    const applied = applyResult(project, target, payload);
    if (!applied.ok) throw new Error(applied.reason);
    expect(siteTheme().tokens.map((t) => t.id)).toEqual(['mm44nn55']);
    const created = project.getPage(applied.value.pageId)!;
    expect(((created.appComponentTree as ComponentInstance).children[0] as ComponentInstance).props.style.backgroundColor).toBe(ref('mm44nn55'));
    // Nothing was added, so the undo leaves the owner's token alone.
    if (!('addedTokens' in applied.value.record)) expect(undoGeneration(project, applied.value.record).ok).toBe(true);
    expect(siteTheme().tokens.map((t) => t.id)).toEqual(['mm44nn55']);
  });

  it('refuses when a colour the page uses was removed from the site while the model wrote', () => {
    const accent = { id: 'ab12cd34', name: 'Accent', kind: 'color' as const, light: '#b4532a' };
    project.updateTheme({ ...siteTheme(), tokens: [accent] });
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult({ nodes: [{ type: 'div', label: 'A', props: { style: { color: ref('ab12cd34') }, children: 'x' } }] }, target);
    // The panel only ever tombstones a token; what removes one outright is a generation's own undo,
    // or a stale tab's save. The undo is the one a test can reach.
    expect(project.revertGenerationWithTheme([accent], () => ({ ok: true as const, value: null }))).toMatchObject({ ok: true });
    expect(siteTheme().tokens).toHaveLength(0);
    const applied = applyResult(project, target, payload);
    expect(applied).toMatchObject({ ok: false });
    if (!applied.ok) expect(applied.reason).toMatch(/removed from the site/);
  });

  it('accepts a reference to a token deleted meanwhile: a tombstone is still in the sheet', () => {
    project.updateTheme({ ...siteTheme(), tokens: [{ id: 'ab12cd34', name: 'Accent', kind: 'color', light: '#b4532a' }] });
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult({ nodes: [{ type: 'div', label: 'A', props: { style: { color: ref('ab12cd34') }, children: 'x' } }] }, target);
    project.updateTheme({ ...siteTheme(), tokens: [{ id: 'ab12cd34', name: 'Accent', kind: 'color', light: '#b4532a', deleted: true }] });
    expect(applyResult(project, target, payload).ok).toBe(true);
  });

  it('a replace that echoes a reference the target already held applies even when that token is long gone', () => {
    const container = tree().children[0] as ComponentInstance;
    container.updateResponsiveStyle('color', ref('lost0001'));
    const target = captureTarget('replace', page, container);
    const payload = themedResult({ nodes: [{ type: 'div', label: 'A', props: { style: { color: ref('lost0001') }, children: 'x' } }] }, target, { heldTokenIds: new Set(['lost0001']) });
    expect(applyResult(project, target, payload).ok).toBe(true);
  });

  it('a reference spelled in the target\'s text does not hold a token: a style using it is refused', () => {
    const container = tree().children[0] as ComponentInstance;
    container.setProps({ title: ref('lost0001') });
    const target = captureTarget('replace', page, container);
    // Neither the editor nor the server counts the text as a hold, so the generation is refused up front.
    expect(() => themedResult({ nodes: [{ type: 'div', label: 'A', props: { style: { color: ref('lost0001') }, children: 'x' } }] }, target)).toThrow();
  });

  it('a page whose copy spells a token reference is not refused for it', () => {
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult({ nodes: [{ type: 'div', label: 'A', props: { children: ref('nope1234') } }] }, target);
    expect(applyResult(project, target, payload).ok).toBe(true);
  });

  describe('the dialog\'s Undo', () => {
    it('takes the tokens out with the page, in the same step as the revert', () => {
      const target = captureTarget('newPage', page, undefined);
      const applied = applyResult(project, target, themedResult(PAGE, target));
      if (!applied.ok) throw new Error(applied.reason);
      getHistoryStore()!.clear();
      const out = undoGeneration(project, applied.value.record);
      expect(out).toEqual({ ok: true, value: { kept: [] } });
      expect(siteTheme().tokens).toHaveLength(0);
      expect(getHistoryStore()!.history.length).toBe(1);
      // Cmd+Z on the dialog's Undo brings the page and its token back together.
      getHistoryStore()!.undo();
      expect(project.getPage((applied.value.record as { pageId: string }).pageId)).toBeDefined();
      expect(siteTheme().tokens.map((t) => t.name)).toEqual(['Crust']);
    });

    it('keeps a token the owner has since used elsewhere, and says which', () => {
      const target = captureTarget('newPage', page, undefined);
      const applied = applyResult(project, target, themedResult(PAGE, target));
      if (!applied.ok) throw new Error(applied.reason);
      const id = siteTheme().tokens[0].id;
      (tree().children[0] as ComponentInstance).setProps({ title: ref(id) });
      const out = undoGeneration(project, applied.value.record);
      expect(out).toEqual({ ok: true, value: { kept: ['Crust'] } });
      expect(siteTheme().tokens.map((t) => t.id)).toEqual([id]);
    });

    it('keeps a token the owner has since edited, since that edit is theirs', () => {
      const target = captureTarget('newPage', page, undefined);
      const applied = applyResult(project, target, themedResult(PAGE, target));
      if (!applied.ok) throw new Error(applied.reason);
      const [token] = siteTheme().tokens;
      project.updateTheme({ ...siteTheme(), tokens: [{ ...(token as object), light: '#abcdef' } as never] });
      expect(undoGeneration(project, applied.value.record)).toEqual({ ok: true, value: { kept: ['Crust'] } });
      expect(siteTheme().tokens).toHaveLength(1);
    });

    it('a second undo is refused and the theme stays as it is (re-entry after completion)', () => {
      const target = captureTarget('newPage', page, undefined);
      const applied = applyResult(project, target, themedResult(PAGE, target));
      if (!applied.ok) throw new Error(applied.reason);
      expect(undoGeneration(project, applied.value.record).ok).toBe(true);
      expect(undoGeneration(project, applied.value.record).ok).toBe(false);
      expect(siteTheme().tokens).toHaveLength(0);
    });

    it('a refused page undo changes no token', () => {
      const container = tree().children[0] as ComponentInstance;
      const target = captureTarget('replace', page, container);
      const applied = applyResult(project, target, themedResult(PAGE, target));
      if (!applied.ok) throw new Error(applied.reason);
      // The generated nodes were deleted by hand, so the revert refuses.
      tree().removeChild((tree().children[0] as ComponentInstance).id);
      const out = undoGeneration(project, applied.value.record);
      expect(out.ok).toBe(false);
      expect(siteTheme().tokens).toHaveLength(1);
    });
  });

  it('rerun after a failed apply adds no duplicates: the second apply of the same result lands once', () => {
    const target = captureTarget('newPage', page, undefined);
    const payload = themedResult(PAGE, target);
    project.updateTheme({ ...siteTheme(), tokens: [{ id: 'mm44nn55', name: 'Crust', kind: 'color', light: '#000000' }] });
    expect(applyResult(project, target, payload).ok).toBe(false);
    // The owner deletes the clashing token (a tombstone: its name is free again).
    project.updateTheme({ ...siteTheme(), tokens: siteTheme().tokens.map((t) => ({ ...t, deleted: true as const })) });
    expect(applyResult(project, target, payload).ok).toBe(true);
    expect(siteTheme().tokens.filter((t) => t.name === 'Crust' && !t.deleted)).toHaveLength(1);
  });
});
