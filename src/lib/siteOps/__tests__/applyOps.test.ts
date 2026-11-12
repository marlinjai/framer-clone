// @vitest-environment node
//
// The site operations engine against a real ProjectModel (no database): every
// operation applies, refuses with a reason, and a batch is all or nothing (a
// refusal anywhere leaves the project byte for byte as it was). Blocked content is
// rejected, never dropped; refs created earlier in a batch are usable later in it.

import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { applyOperations } from '../applyOps';
import { keyedBreakpoints } from '../breakpoints';
import { pageWithShopParts, shopPartRoleOf } from '@/lib/commerce/parts';

function makeProject(): ProjectModelType {
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home', description: '' },
        appComponentTree: {
          id: 'root',
          type: 'div',
          componentType: 'host',
          props: {},
          children: [
            { id: 'hero', type: 'section', componentType: 'host', parentId: 'root', props: { style: { padding: '24px' } }, children: [
              { id: 'title', type: 'h1', componentType: 'host', parentId: 'hero', props: { children: 'Fresh bread' }, children: [] },
            ] },
            { id: 'link', type: 'a', componentType: 'host', parentId: 'root', props: { href: '/about', children: 'About' }, children: [] },
          ],
        },
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });
}

let counter = 0;
const newId = () => `id${++counter}`;
const home = (p: ProjectModelType) => p.pages.get('home') as PageModelType;
const find = (p: ProjectModelType, id: string) => home(p).findComponent(id) as ComponentInstance | undefined;

async function run(project: ProjectModelType, ops: unknown[]) {
  return applyOperations(project, ops, { newId });
}

/** Run a batch that must be refused, and prove the project did not change. */
async function refused(ops: unknown[]) {
  const project = makeProject();
  const before = JSON.stringify(getSnapshot(project));
  const outcome = await run(project, ops);
  expect(outcome.ok).toBe(false);
  expect(JSON.stringify(getSnapshot(project))).toBe(before);
  return outcome.ok ? [] : outcome.rejected;
}

describe('applyOperations: each operation applies', () => {
  it('inserts generation-format nodes and returns ids for their refs', async () => {
    const project = makeProject();
    const outcome = await run(project, [
      {
        op: 'insertNodes',
        pageId: 'home',
        nodes: [
          { ref: 'cta', type: 'section', props: { style: { padding: { desktop: '64px', mobile: '24px' } } }, children: [
            { ref: 'cta-heading', type: 'h2', props: { children: 'Order today' } },
          ] },
        ],
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const section = find(project, outcome.created.cta)!;
    expect(section.type).toBe('section');
    const heading = find(project, outcome.created['cta-heading'])!;
    expect(heading.props.children).toBe('Order today');
    expect(heading.parentId).toBe(section.id);
    // Responsive keys became the page's breakpoint ids.
    const [desktop, , mobile] = keyedBreakpoints(home(project));
    const padding = section.props.style.padding as Record<string, string>;
    expect(Object.keys(padding)).toEqual(expect.arrayContaining([mobile.id]));
    expect(Object.values(padding)).toContain('64px');
    expect(desktop.key).toBe('desktop');
  });

  it('inserts at a position and refers back to a node created earlier in the batch', async () => {
    const project = makeProject();
    const outcome = await run(project, [
      { op: 'insertNodes', pageId: 'home', index: 0, nodes: [{ ref: 'box', type: 'div' }] },
      { op: 'insertNodes', pageId: 'home', parentId: 'ref:box', nodes: [{ ref: 'para', type: 'p', props: { children: 'Inside' } }] },
      { op: 'updateStyle', nodeId: 'ref:box', property: 'gap', value: '12px' },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const root = home(project).appComponentTree as ComponentInstance;
    expect(root.children[0].id).toBe(outcome.created.box);
    expect(find(project, outcome.created.para)!.parentId).toBe(outcome.created.box);
    expect(find(project, outcome.created.box)!.props.style.gap).toBe('12px');
    expect(outcome.summary).toHaveLength(3);
  });

  it('updates a style per breakpoint and per state', async () => {
    const project = makeProject();
    const outcome = await run(project, [
      { op: 'updateStyle', nodeId: 'hero', property: 'padding', value: '12px', breakpoint: 'mobile' },
      { op: 'updateStyle', nodeId: 'link', property: 'color', value: '#b00020', state: 'hover' },
      { op: 'updateStyle', nodeId: 'hero', property: 'background-color', value: '#fafafa' },
    ]);
    expect(outcome.ok).toBe(true);
    const mobile = keyedBreakpoints(home(project))[2];
    const padding = find(project, 'hero')!.props.style.padding as Record<string, string>;
    expect(padding[mobile.id]).toBe('12px');
    expect(find(project, 'hero')!.props.style.backgroundColor).toBe('#fafafa');
    const rules = find(project, 'link')!.props.rules as Array<{ selector: string; style: Record<string, unknown> }>;
    expect(rules[0].selector).toBe('&:hover');
    expect(rules[0].style.color).toBe('#b00020');
  });

  it('updates text, sets and removes props, moves and removes nodes', async () => {
    const project = makeProject();
    const outcome = await run(project, [
      { op: 'updateText', nodeId: 'title', text: 'Bread since 1920' },
      { op: 'setProps', nodeId: 'link', props: { href: 'https://example.com', target: '_blank' } },
      { op: 'setProps', nodeId: 'link', props: { target: null } },
      { op: 'moveNode', nodeId: 'link', to: { siblingId: 'hero', position: 'before' } },
      { op: 'removeNode', nodeId: 'title' },
    ]);
    expect(outcome.ok).toBe(true);
    const link = find(project, 'link')!;
    expect(link.props.href).toBe('https://example.com');
    expect(link.props.target).toBeUndefined();
    expect((home(project).appComponentTree as ComponentInstance).children[0].id).toBe('link');
    expect(find(project, 'title')).toBeUndefined();
  });

  it('creates a page, changes its settings, and builds on it by ref', async () => {
    const project = makeProject();
    const outcome = await run(project, [
      { op: 'createPage', ref: 'about', title: 'About us', slug: 'about-us' },
      { op: 'updatePageSettings', pageId: 'ref:about', description: 'Who bakes your bread' },
      { op: 'insertNodes', pageId: 'ref:about', nodes: [{ type: 'h1', props: { children: 'About' } }] },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const page = project.pages.get(outcome.created.about) as PageModelType;
    expect(page.slug).toBe('about-us');
    expect(page.metadata.description).toBe('Who bakes your bread');
    expect((page.appComponentTree as ComponentInstance).children).toHaveLength(1);
  });

  it('adds a selector rule with breakpoint keys and replaces the theme', async () => {
    const project = makeProject();
    const outcome = await run(project, [
      { op: 'addRule', nodeId: 'hero', rule: { selector: '& > h1', style: { letterSpacing: { desktop: '0.02em', mobile: '0' } } } },
      { op: 'setTheme', theme: { tokens: [{ id: 'abcd1234', name: 'Ink', kind: 'color', light: '#111111' }], document: {} } },
    ]);
    expect(outcome.ok).toBe(true);
    const rules = find(project, 'hero')!.props.rules as Array<{ selector: string; style: Record<string, Record<string, string>> }>;
    expect(rules[0].selector).toBe('& > h1');
    const mobile = keyedBreakpoints(home(project))[2];
    expect(rules[0].style.letterSpacing[mobile.id]).toBe('0');
    expect(project.site.theme.tokens).toHaveLength(1);
  });
});

describe('applyOperations: refusals write nothing', () => {
  it('refuses an unknown node id', async () => {
    const rejected = await refused([{ op: 'updateText', nodeId: 'nope', text: 'x' }]);
    expect(rejected[0]).toMatchObject({ index: 0, op: 'updateText' });
    expect(rejected[0].reason).toMatch(/unknown node id/);
  });

  it('refuses an unknown breakpoint', async () => {
    const rejected = await refused([{ op: 'updateStyle', nodeId: 'hero', property: 'padding', value: '1px', breakpoint: 'watch' }]);
    expect(rejected[0].reason).toMatch(/unknown breakpoint "watch".*desktop/);
  });

  it('rejects a blocked tag instead of dropping it', async () => {
    const rejected = await refused([
      { op: 'insertNodes', pageId: 'home', nodes: [{ type: 'div', children: [{ type: 'script', props: { children: 'alert(1)' } }] }] },
    ]);
    expect(rejected[0].reason).toMatch(/script/);
  });

  it('rejects a preset inserted into a button, and places it in a section', async () => {
    const rejected = await refused([
      { op: 'insertNodes', pageId: 'home', parentId: 'hero', nodes: [{ ref: 'btn', type: 'button', props: { type: 'button' } }] },
      { op: 'insertNodes', pageId: 'home', parentId: 'ref:btn', nodes: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] },
    ]);
    expect(rejected[0].reason).toContain('cannot sit inside <button>');
    const project = makeProject();
    const outcome = await run(project, [{ op: 'insertNodes', pageId: 'home', parentId: 'hero', nodes: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }]);
    expect(outcome.ok).toBe(true);
    expect(find(project, 'hero')?.children).toHaveLength(2);
  });

  it('rejects a preset inserted into a floating canvas button', async () => {
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(makeProject())));
    snapshot.pages.home.canvasNodes.float = {
      id: 'float',
      type: 'button',
      componentType: 'host',
      props: { type: 'button' },
      canvasX: 0,
      canvasY: 0,
      children: [{ id: 'float-inner', type: 'span', componentType: 'host', parentId: 'float', props: {}, children: [] }],
    };
    const project = ProjectModel.create(snapshot);
    const outcome = await run(project, [{ op: 'insertNodes', pageId: 'home', parentId: 'float-inner', nodes: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejected[0].reason).toContain('cannot sit inside <button>');
  });

  it('refuses to set a 3D scene or its marker through setProps', async () => {
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { scene: 'x' } }]))[0].reason).toMatch(/scene is not set through setProps/);
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { 'data-scene': 'three' } }]))[0].reason).toMatch(/data-scene is not set through setProps/);
  });

  it('rejects a handler prop and a javascript link', async () => {
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { onclick: 'alert(1)' } }]))[0].reason).toMatch(/onclick/);
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { href: 'javascript:alert(1)' } }]))[0].reason).toMatch(/href/);
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { style: 'color:red' } }]))[0].reason).toMatch(/style is not set/);
  });

  it("refuses setting or removing a shop part's role marker", async () => {
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { 'data-shop-part': 'checkout.pay' } }]))[0].reason).toMatch(/data-shop-part is not set/);
    expect((await refused([{ op: 'setProps', nodeId: 'link', props: { 'data-shop-part': null } }]))[0].reason).toMatch(/data-shop-part is not set/);
  });

  it('rejects an unsafe style value and a style key the editor does not know', async () => {
    expect((await refused([{ op: 'updateStyle', nodeId: 'hero', property: 'color', value: 'red; background:url(x)' }]))[0].reason).toBeTruthy();
    expect((await refused([{ op: 'updateStyle', nodeId: 'hero', property: 'behavior', value: 'x' }]))[0].reason).toMatch(/not supported/);
  });

  it('rejects text with a long dash, markup or on a container', async () => {
    expect((await refused([{ op: 'updateText', nodeId: 'title', text: 'Fresh \u2014 daily' }]))[0].reason).toBeTruthy();
    expect((await refused([{ op: 'updateText', nodeId: 'title', text: '<b>x</b>' }]))[0].reason).toMatch(/markup/);
    expect((await refused([{ op: 'updateText', nodeId: 'hero', text: 'x' }]))[0].reason).toMatch(/plain text/);
  });

  it('refuses removing the page root and moving a node into itself', async () => {
    expect((await refused([{ op: 'removeNode', nodeId: 'root' }]))[0].reason).toMatch(/root/);
    expect((await refused([{ op: 'moveNode', nodeId: 'hero', to: { parentId: 'title' } }]))[0].reason).toBeTruthy();
  });

  it('is all or nothing: a late refusal takes back every earlier operation', async () => {
    const rejected = await refused([
      { op: 'updateText', nodeId: 'title', text: 'Changed' },
      { op: 'insertNodes', pageId: 'home', nodes: [{ ref: 'a', type: 'div' }] },
      { op: 'createPage', title: 'Extra' },
      { op: 'updateStyle', nodeId: 'ref:a', property: 'color', value: 'blue' },
      { op: 'removeNode', nodeId: 'missing' },
      { op: 'updateText', nodeId: 'title', text: 'Never applied' },
    ]);
    expect(rejected[0]).toMatchObject({ index: 4, op: 'removeNode' });
    expect(rejected[1].reason).toMatch(/1 later operation/);
  });

  it('reports every malformed operation before applying any', async () => {
    const rejected = await refused([
      { op: 'updateText', nodeId: 'title' },
      { op: 'teleport', nodeId: 'title' },
      { op: 'removeNode', nodeId: 'title', extra: true },
    ]);
    expect(rejected.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('refuses a ref nobody created and a ref used twice', async () => {
    expect((await refused([{ op: 'removeNode', nodeId: 'ref:ghost' }]))[0].reason).toMatch(/no ref/);
    expect(
      (await refused([
        { op: 'insertNodes', pageId: 'home', nodes: [{ ref: 'x', type: 'div' }] },
        { op: 'createPage', ref: 'x', title: 'Again' },
      ]))[0].reason,
    ).toMatch(/used twice/);
  });

  it('refuses an imageQuery when no resolver is given', async () => {
    const rejected = await refused([
      { op: 'insertNodes', pageId: 'home', nodes: [{ type: 'img', props: { alt: 'Bread', imageQuery: 'sourdough loaf' } }] },
    ]);
    expect(rejected[0].reason).toMatch(/findImages/);
  });

  it('refuses a slug that is taken', async () => {
    const rejected = await refused([
      { op: 'createPage', title: 'One', slug: 'menu' },
      { op: 'createPage', title: 'Two', slug: 'menu' },
    ]);
    expect(rejected[0].index).toBe(1);
  });
});

describe('applyOperations: a shop part moved out of its control', () => {
  it('keeps answering to the id it had, for the rest of the batch', async () => {
    const project = makeProject();
    const page = home(project);
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(page)));
    snapshot.appComponentTree.children.push({
      id: 'shop',
      type: 'div',
      componentType: 'host',
      parentId: 'root',
      props: { 'data-component-kind': 'checkout-button' },
      children: [],
    });
    const repaired = pageWithShopParts(snapshot, 'en');
    const withParts = ProjectModel.create({
      id: 'site-2',
      metadata: { title: 'Shop', description: '', createdAt: 1, updatedAt: 1 },
      pages: { home: repaired },
    });
    const shop = home(withParts).findComponent('shop') as ComponentInstance;
    const decline = flatten(shop).find((node) => shopPartRoleOf(node.props) === 'checkout.decline')!;
    const outcome = await run(withParts, [
      { op: 'moveNode', nodeId: decline.id, to: { parentId: 'root' } },
      { op: 'setProps', nodeId: decline.id, props: { title: 'Moved' } },
    ]);
    expect(outcome.ok).toBe(true);
  });
});

function flatten(node: ComponentInstance): ComponentInstance[] {
  return [node, ...node.children.flatMap((child: ComponentInstance) => flatten(child))];
}

// ---------- the FX scene (src/lib/fxScene), slice F6 of the FX plan ----------

import { fxFromPreset as fxPresetScene } from '@/lib/fxScene/edit';
import { FX_PROP as FX_SCENE_PROP, isFxScene as isFxSceneBox, parseFxProp as readStoredFx } from '@/lib/fxScene/fxScene';
import { pageOutline } from '../read';

/** A stored scene as plain JSON, loose enough to spoil on purpose. */
interface StoredScene {
  version: number;
  scene: { layers: unknown[] };
}

describe('applyOperations: the FX scene', () => {
  const fxPreset = (id?: string) => {
    const made = fxPresetScene(id);
    if (!made.ok) throw new Error(made.message);
    return made;
  };
  const heroNodes = (fx: unknown = { preset: 'noise-gradient' }) => [
    { ref: 'fx', type: 'div', preset: 'fxScene', props: { fx }, children: [{ type: 'h2', props: { children: 'Over the scene', style: { color: '#ffffff' } } }] },
  ];
  const sceneOf = (node: ComponentInstance) => {
    const read = readStoredFx((node.props as Record<string, unknown>)[FX_SCENE_PROP]);
    if (!read.ok) throw new Error(read.message);
    return read.fx;
  };
  /** A project whose home page already holds an FX scene box, and its id. */
  async function withScene(fx?: unknown) {
    const project = makeProject();
    const outcome = await run(project, [{ op: 'insertNodes', pageId: 'home', nodes: heroNodes(fx) }]);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
    return { project, id: outcome.created.fx };
  }

  it('insertNodes places a scene from a preset through the generator\'s own validator, with nothing repaired', async () => {
    const { project, id } = await withScene();
    const box = find(project, id)!;
    expect(isFxSceneBox(box.props, box.type)).toBe(true);
    expect(JSON.stringify(sceneOf(box).scene)).toBe(JSON.stringify(fxPreset('noise-gradient').fx.scene));
    expect(box.children.map((c: ComponentInstance) => c.type)).toEqual(['h2']);
  });

  it('insertNodes places a whole stored scene, so an agent can bring a scene tuned elsewhere', async () => {
    const tuned = JSON.parse(JSON.stringify(fxPreset('gold-noise-gradient').stored));
    tuned.scene.layers[0].params.speed = 0.25;
    const { project, id } = await withScene(tuned);
    expect(sceneOf(find(project, id)!).scene.layers[0].params.speed.value).toBe(0.25);
  });

  it.each([
    ['an unknown preset', { preset: 'sparkles' }, /no FX preset called "sparkles"/],
    ['an invented layer', { preset: 'gold-noise-gradient', layers: [{ id: 'storm', type: 'particleStorm' }] }, /"storm" of the kind "particleStorm" is not a layer of the preset/],
    ['a setting that does not exist', { preset: 'gold-noise-gradient', layers: [{ id: 'bloom', params: { sparkle: 1 } }] }, /no setting called "sparkle"/],
    ['a value out of its range', { preset: 'gold-noise-gradient', layers: [{ id: 'bloom', params: { intensity: 500 } }] }, /500 is outside/],
    ['the wrong kind of value', { preset: 'gold-noise-gradient', layers: [{ id: 'bloom', params: { intensity: 'bright' } }] }, /intensity cannot be "bright"/],
    ['a text layer left with sample text', { preset: 'godrays-hero' }, /draws text.*was hidden/],
  ])('insertNodes refuses %s with the reason, and writes nothing', async (_name, fx, reason) => {
    const rejected = await refused([{ op: 'insertNodes', pageId: 'home', nodes: heroNodes(fx) }]);
    expect(rejected[0].reason).toMatch(reason);
  });

  it('insertNodes refuses a scene with a picture from another address', async () => {
    const foreign = JSON.parse(JSON.stringify(fxPreset().stored));
    foreign.scene.layers.push({ id: 'pic', type: 'image', name: 'Pic', visible: true, blend: 'normal', params: { src: 'https://evil.test/a.png' } });
    const rejected = await refused([{ op: 'insertNodes', pageId: 'home', nodes: heroNodes(foreign) }]);
    expect(rejected[0].reason).toMatch(/image address that is not allowed here/);
  });

  it('insertNodes refuses a second scene on a page that has one: a page draws one', async () => {
    const { project } = await withScene();
    const before = JSON.stringify(getSnapshot(project));
    const outcome = await run(project, [{ op: 'insertNodes', pageId: 'home', nodes: heroNodes() }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejected[0].reason).toMatch(/this page already has an FX scene/);
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
  });

  it('setFxScene replaces the scene with a preset, retuned, and with a whole stored scene', async () => {
    const { project, id } = await withScene();
    const first = await run(project, [{ op: 'setFxScene', nodeId: id, fx: { preset: 'gold-noise-gradient', calm: 'frame', layers: [{ id: 'bloom', params: { intensity: 0.9 } }] } }]);
    expect(first.ok).toBe(true);
    const fx = sceneOf(find(project, id)!);
    expect(fx.calm).toBe('frame');
    expect(fx.scene.layers.find((l) => l.id === 'bloom')!.params.intensity.value).toBe(0.9);

    // What getPage shows of the box is the stored scene, whole: changed and sent back, it is stored.
    const shown = pageOutline(home(project)).nodes.find((node) => node.id === id)!.props![FX_SCENE_PROP] as { scene: { layers: { id: string; params: Record<string, unknown> }[] } };
    const changed = JSON.parse(JSON.stringify(shown));
    changed.scene.layers.find((l: { id: string }) => l.id === 'bloom').params.intensity = 0.4;
    const second = await run(project, [{ op: 'setFxScene', nodeId: id, fx: changed }]);
    expect(second.ok).toBe(true);
    expect(sceneOf(find(project, id)!).scene.layers.find((l) => l.id === 'bloom')!.params.intensity.value).toBe(0.4);
    // The box's own style is not the operation's to change.
    expect(find(project, id)!.props.style).toBeDefined();
  });

  it.each([
    ['a foreign image address', (stored: StoredScene) => stored.scene.layers.push({ id: 'pic', type: 'image', name: 'Pic', visible: true, blend: 'normal', params: { src: 'https://evil.test/a.png' } }), /image address that is not allowed here/],
    ['the editor\'s own image address, which is no site path', (stored: StoredScene) => stored.scene.layers.push({ id: 'pic', type: 'image', name: 'Pic', visible: true, blend: 'normal', params: { src: '/api/projects/site-1/images/abc' } }), /image address that is not allowed here/],
    ['a layer of an unknown kind', (stored: StoredScene) => stored.scene.layers.push({ id: 'storm', type: 'particleStorm', name: 'Storm', visible: true, blend: 'normal', params: {} }), /unknown type "particleStorm"/],
    ['a version it does not know', (stored: StoredScene) => void (stored.version = 99), /./],
  ])('setFxScene refuses a stored scene with %s, and the scene stays as it was', async (_name, spoil, reason) => {
    const { project, id } = await withScene();
    const before = JSON.stringify(getSnapshot(project));
    const stored = JSON.parse(JSON.stringify(fxPreset().stored));
    spoil(stored);
    const outcome = await run(project, [{ op: 'setFxScene', nodeId: id, fx: stored }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejected[0].reason).toMatch(reason);
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
  });

  it('setFxScene refuses a node that is no FX scene box, and says how to get one', async () => {
    const rejected = await refused([{ op: 'setFxScene', nodeId: 'hero', fx: { preset: 'gold-noise-gradient' } }]);
    expect(rejected[0].reason).toMatch(/not an FX scene box; insertNodes places one/);
  });

  it('setProps still refuses the scene and its marker, and points to setFxScene', async () => {
    const { project, id } = await withScene();
    const before = JSON.stringify(getSnapshot(project));
    for (const props of [{ fx: 'x' }, { 'data-fx': 'scene' }]) {
      const outcome = await run(project, [{ op: 'setProps', nodeId: id, props }]);
      expect(outcome.ok).toBe(false);
    }
    const viaProps = await run(project, [{ op: 'setProps', nodeId: id, props: { fx: 'x' } }]);
    if (!viaProps.ok) expect(viaProps.rejected[0].reason).toMatch(/setFxScene/);
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
  });

  it('a batch with one refused scene writes nothing of the batch', async () => {
    const { project, id } = await withScene();
    const before = JSON.stringify(getSnapshot(project));
    const outcome = await run(project, [
      { op: 'updateText', nodeId: 'title', text: 'Changed' },
      { op: 'setFxScene', nodeId: id, fx: { preset: 'sparkles' } },
    ]);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
  });
});

describe('applyOperations: the site theme', () => {
  const ACCENT = 'ab12cd34';
  const withToken = () => {
    const project = makeProject();
    project.updateTheme({ tokens: [{ id: ACCENT, name: 'Accent', kind: 'color', light: '#b4532a' }], document: {} });
    return project;
  };

  it('lets an agent set a style, a state and a rule from a live token, and refuses one the site does not have', async () => {
    const project = withToken();
    const ok = await run(project, [
      { op: 'updateStyle', nodeId: 'hero', property: 'color', value: `var(--fc-t-${ACCENT})` },
      { op: 'updateStyle', nodeId: 'link', property: 'color', value: `var(--fc-t-${ACCENT})`, state: 'hover' },
    ]);
    expect(ok.ok).toBe(true);
    expect(find(project, 'hero')!.props.style.color).toBe(`var(--fc-t-${ACCENT})`);
    await refused([{ op: 'updateStyle', nodeId: 'hero', property: 'color', value: 'var(--fc-t-nope1234)' }]);
  });
});
