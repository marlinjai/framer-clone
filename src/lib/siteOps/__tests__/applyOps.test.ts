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
