// @vitest-environment node
//
// placeComponent and the render gate. A placement is a `#component` node, which no
// renderer draws: expansion replaces it with its definition's tree first
// (src/lib/components/expand.ts). So the gate judges that tree, where the placement
// stands, and the definition must be one this site has and expansion can open.
// The op also refuses every target insertNodes refuses.

import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { contentModelRefusal, type ComponentDefinitions } from '@/lib/components/definition';
import { applyOperations } from '../applyOps';
import { renderGateProblem } from '../gate';

type Stored = Record<string, unknown> & { id: string; children?: Stored[] };

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: Stored[] = []): Stored => ({
  id,
  type,
  componentType: 'host',
  props,
  children: children.map((child) => ({ ...child, parentId: id })),
});
const placed = (id: string, component: string, extra: Record<string, unknown> = {}): Stored => node(id, '#component', { component, ...extra });

const definition = (id: string, tree: Stored) => ({
  id,
  name: `The ${id}`,
  page: { id: `page-${id}`, metadata: { title: id }, appComponentTree: tree, canvasNodes: {} },
  inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'Card title' }],
  states: [],
});

const CARD = definition('card', node('card-root', 'section', { style: { padding: '8px' } }, [node('card-title', 'h3', { children: 'Stored' })]));

function makeProject(components: Record<string, unknown> = {}, extra: Stored[] = []): ProjectModelType {
  const tree = node('root', 'div', {}, [
    node('box', 'section', {}, [node('inner', 'p', { children: 'Inside the box' })]),
    node('copy', 'div', { children: 'Own text' }),
    node('photo', 'img', { src: '/a.jpg', alt: '' }),
    node('drawing', 'svg', {}, [node('line', 'path', { d: 'M0 0' })]),
    ...extra,
  ]);
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
    pages: { home: { id: 'home', slug: '', metadata: { title: 'Home', description: '' }, appComponentTree: tree as never, canvasNodes: defaultViewportSnapshots() } },
    components: { card: CARD, ...components } as never,
  });
}

const home = (p: ProjectModelType) => p.pages.get('home') as PageModelType;
const find = (p: ProjectModelType, id: string) => home(p).findComponent(id) as ComponentInstance | undefined;
const place = (extra: Record<string, unknown> = {}) => ({ op: 'placeComponent', pageId: 'home', definitionId: 'card', ...extra });

async function applied(project: ProjectModelType, ops: unknown[]) {
  const outcome = await applyOperations(project, ops);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  return outcome;
}

/** A batch that must be refused: the project is byte for byte as it was, and the first reason comes back. */
async function refusal(ops: unknown[], project = makeProject()): Promise<string> {
  const before = JSON.stringify(getSnapshot(project));
  const outcome = await applyOperations(project, ops);
  expect(outcome.ok).toBe(false);
  expect(JSON.stringify(getSnapshot(project))).toBe(before);
  return outcome.ok ? '' : outcome.rejected[0].reason;
}

describe('placeComponent applies', () => {
  it('at the page root, holding only the definition id', async () => {
    const project = makeProject();
    const outcome = await applied(project, [place({ ref: 'c' })]);
    const placement = find(project, outcome.created.c)!;
    expect(placement.type).toBe('#component');
    expect(placement.props).toEqual({ component: 'card' });
    expect((home(project).appComponentTree as ComponentInstance).children.at(-1)!.id).toBe(placement.id);
  });

  it('inside a container and beside a node', async () => {
    const project = makeProject();
    const outcome = await applied(project, [place({ ref: 'a', to: { parentId: 'box', index: 0 } }), place({ ref: 'b', to: { siblingId: 'inner', position: 'after' } })]);
    expect(find(project, 'box')!.children.map((c: ComponentInstance) => c.id)).toEqual([outcome.created.a, 'inner', outcome.created.b]);
  });

  it('and what holds a placement can then be restyled and moved, and the placement removed', async () => {
    // The same refusal hit every later write that touched a subtree with a placement in it.
    const project = makeProject({}, [node('holder', 'div', {}, [placed('old', 'card', { style: { margin: '4px' } })])]);
    await applied(project, [{ op: 'updateStyle', nodeId: 'holder', property: 'padding', value: '12px' }]);
    await applied(project, [{ op: 'moveNode', nodeId: 'old', to: { parentId: 'box' } }]);
    await applied(project, [{ op: 'moveNode', nodeId: 'box', to: { parentId: 'root', index: 0 } }]);
    await applied(project, [{ op: 'removeNode', nodeId: 'old' }]);
    expect(find(project, 'old')).toBeUndefined();
  });

  it('a placement the editor filled passes, with every field a placement stores', async () => {
    const full = placed('full', 'card', { inputs: { title: 'Own' }, state: 'primary', style: { margin: '4px' }, effects: {}, behaviour: {}, 'data-repeat': 'items' });
    expect(renderGateProblem(full as never, false, makeProject().definitions)).toBeNull();
  });

  it('a definition that repeats an element and places another definition', async () => {
    const list = definition('list', node('list-root', 'ul', {}, [node('row', 'li', { 'data-repeat': 'items' }, [placed('nested', 'card')])]));
    await applied(makeProject({ list }), [{ op: 'placeComponent', pageId: 'home', definitionId: 'list' }]);
  });

  it('into another definition', async () => {
    const shell = definition('shell', node('shell-root', 'div'));
    const project = makeProject({ shell });
    await applied(project, [place({ pageId: 'page-shell' })]);
    expect(project.definitions.shell.page.appComponentTree).toMatchObject({ children: [{ type: '#component', props: { component: 'card' } }] });
  });
});

describe('placeComponent refuses, writing nothing', () => {
  it('a definition this site does not have, by name', async () => {
    expect(await refusal([place({ definitionId: 'gone' })])).toMatch(/unknown component id "gone"/);
  });

  it('a valid placement followed by an invalid operation', async () => {
    expect(await refusal([place(), { op: 'removeNode', nodeId: 'nope' }])).toMatch(/nope/);
    expect(await refusal([place(), place({ definitionId: 'gone' })])).toMatch(/gone/);
  });

  it('values for the inputs, which no operation takes yet', async () => {
    expect(await refusal([place({ inputs: { title: 'x' } })])).toMatch(/inputs/);
  });

  it('a #component written by hand through insertNodes', async () => {
    for (const component of ['card', 'gone']) {
      await refusal([{ op: 'insertNodes', pageId: 'home', nodes: [{ type: '#component', props: { component } }] }]);
    }
  });

  it.each([
    ['an element that cannot have children', { parentId: 'photo' }, /<img> cannot contain/],
    ['an element that holds its own text', { parentId: 'copy' }, /parent holds text/],
    ['a breakpoint frame', 'frame', /breakpoint frame/],
    ['beside the page root', { siblingId: 'root', position: 'after' }, /no parent/],
    ['beside a breakpoint frame', 'beside-frame', /no parent|breakpoint frame/],
  ])('a target: %s', async (_name, to, reason) => {
    const project = makeProject();
    const frame = (home(project).viewportNodes as ComponentInstance[])[0].id;
    const target = to === 'frame' ? { parentId: frame } : to === 'beside-frame' ? { siblingId: frame, position: 'after' } : to;
    expect(await refusal([place({ to: target })], project)).toMatch(reason);
  });

  it.each([
    ['cannot have children', node('leaf-root', 'img', { src: '/a.jpg', alt: '' }), /<img> cannot contain/],
    ['holds its own text', node('leaf-root', 'div', { children: 'Own text' }), /parent holds text/],
  ])('no target, on a page whose root %s', async (_name, tree, reason) => {
    const project = makeProject({ leaf: definition('leaf', tree) });
    expect(await refusal([place({ pageId: 'page-leaf' })], project)).toMatch(reason);
  });

  it('a target inside another placement', async () => {
    const project = makeProject({}, [placed('old', 'card')]);
    expect(await refusal([place({ to: { parentId: 'old' } })], project)).toMatch(/cannot contain/);
  });

  it('a definition that would contain itself', async () => {
    expect(await refusal([place({ pageId: 'page-card' })])).toMatch(/contains/);
  });

  it('a definition whose element would not render inside an svg', async () => {
    expect(await refusal([place({ to: { parentId: 'drawing' } })])).toMatch(/component "The card".*<h3> is not rendered here/);
  });

  it('moving a placement into an svg or into an element that cannot have children', async () => {
    const into = (parentId: string) => refusal([{ op: 'moveNode', nodeId: 'old', to: { parentId } }], makeProject({}, [placed('old', 'card')]));
    expect(await into('drawing')).toMatch(/<h3> is not rendered here/);
    expect(await into('photo')).toMatch(/<img> cannot contain/);
  });

  it.each([
    ['a blocked element', node('bad-root', 'div', {}, [node('bad', 'script')]), /<script> is not rendered here/],
    ['a blocked prop', node('bad-root', 'div', { onclick: 'alert(1)' }), /"onclick" is not rendered/],
    ['a script address', node('bad-root', 'a', { href: 'javascript:alert(1)' }), /"href" is not rendered/],
    ['a nested definition the site lacks', node('bad-root', 'div', {}, [placed('n', 'gone')]), /"gone" is not one of this site's components/],
    // The model does not load a definition like this one, so the site does not have it.
    ['a root that is itself a placement', placed('bad-root', 'card'), /unknown component id "bad"/],
  ])('a definition holding %s', async (_name, tree, reason) => {
    const project = makeProject({ bad: definition('bad', tree) });
    expect(await refusal([{ op: 'placeComponent', pageId: 'home', definitionId: 'bad' }], project)).toMatch(reason);
  });
});

describe('a later edit inside a definition is judged where the component is used', () => {
  const group = definition('group', node('group-root', 'g', {}, [node('group-path', 'path', { d: 'M0 0' })]));
  const insert = (pageId: string, parentId: string, nodes: unknown[]) => ({ op: 'insertNodes', pageId, parentId, nodes });
  const text = { type: 'div', props: { children: 'Dropped in svg' } };

  it('refuses content a use inside an svg would drop, in a later batch', async () => {
    const project = makeProject({ group }, [node('art', 'svg', {}, [placed('use', 'group')])]);
    expect(await refusal([insert('page-group', 'group-root', [text])], project)).toMatch(/placement use on page "Home" \(home\).*component "The group".*<div> is not rendered here/);
  });

  it('through a component that places the edited one', async () => {
    const outer = definition('outer', node('outer-root', 'g', {}, [placed('inner-use', 'group')]));
    const project = makeProject({ group, outer }, [node('art', 'svg', {}, [placed('use', 'outer')])]);
    expect(await refusal([insert('page-group', 'group-root', [text])], project)).toMatch(/<div> is not rendered here/);
  });

  it('refuses a link added to a component that is used inside a link', async () => {
    const project = makeProject({}, [node('anchor', 'a', { href: '/x' }, [placed('use', 'card')])]);
    expect(await refusal([insert('page-card', 'card-root', [{ type: 'a', props: { href: '/y', children: 'Inner' } }])], project)).toMatch(/placement use on page "Home" \(home\).*holds a link or a control/);
  });

  // "holder" already draws a component the site lacks, so its use on the page is broken.
  const holder = () => definition('holder', node('holder-root', 'div', {}, [placed('broken', 'gone'), node('spare', 'p', { children: 'Spare' })]));

  it('judges the uses again after a removal inside a definition', async () => {
    const project = makeProject({ holder: holder() }, [placed('use', 'holder')]);
    expect(await refusal([{ op: 'removeNode', nodeId: 'spare' }], project)).toMatch(/placement use on page "Home".*"gone" is not one of this site's components/);
  });

  it('allows the removal that repairs every use', async () => {
    const project = makeProject({ holder: holder() }, [placed('use', 'holder')]);
    await applied(project, [{ op: 'removeNode', nodeId: 'broken' }]);
  });

  it('does not judge what stays on a page a node was removed from', async () => {
    const project = makeProject({}, [node('legacy', 'div', {}, [node('old-style', 'style'), node('plain', 'p', { children: 'Plain' })])]);
    await applied(project, [{ op: 'removeNode', nodeId: 'plain' }]);
  });

  it('allows the same edit when no use stands in such a place', async () => {
    const project = makeProject({ group }, [placed('use', 'group')]);
    await applied(project, [insert('page-group', 'group-root', [text])]);
    await applied(project, [insert('page-card', 'card-root', [{ type: 'a', props: { href: '/y', children: 'Inner' } }])]);
  });
});

describe('renderGateProblem on a stored placement', () => {
  const definitions = (): ComponentDefinitions => makeProject().definitions;

  it.each([
    ['names no definition', node('p', '#component', {}), /is not one of this site's components/],
    ['names a definition the site lacks', placed('p', 'gone'), /"gone" is not one of this site's components/],
    ['names a key every object has', placed('p', 'constructor'), /is not one of this site's components/],
    ['holds children', { ...placed('p', 'card'), children: [node('x', 'div')] }, /holds no children/],
    ['holds a prop no placement stores', placed('p', 'card', { onclick: 'x' }), /"onclick" is not rendered/],
  ])('refuses one that %s', (_name, stored, reason) => {
    expect(renderGateProblem(stored as never, false, definitions())).toMatch(reason);
  });

  it('refuses a definition expansion cannot open, as stored JSON may hold one', () => {
    const stored = { odd: definition('odd', placed('odd-root', 'card')) } as unknown as ComponentDefinitions;
    expect(renderGateProblem(placed('p', 'odd') as never, false, stored)).toMatch(/"The odd" cannot be rendered/);
  });

  it('refuses a placement when told of no definitions', () => {
    expect(renderGateProblem(placed('p', 'card') as never)).toMatch(/is not one of this site's components/);
  });

  it('refuses definitions that contain each other, or nest too deep', () => {
    const of = (entries: Array<[string, Stored]>) => Object.fromEntries(entries.map(([id, tree]) => [id, definition(id, tree)])) as unknown as ComponentDefinitions;
    const loop = of([['a', node('ra', 'div', {}, [placed('pa', 'b')])], ['b', node('rb', 'div', {}, [placed('pb', 'a')])]]);
    expect(renderGateProblem(placed('p', 'a') as never, false, loop)).toMatch(/contains itself/);
    const chain = (length: number) => of(Array.from({ length }, (_, i) => [`d${i}`, i + 1 < length ? node(`r${i}`, 'div', {}, [placed(`p${i}`, `d${i + 1}`)]) : node(`r${i}`, 'div')]));
    expect(renderGateProblem(placed('p', 'd0') as never, false, chain(8))).toBeNull();
    expect(renderGateProblem(placed('p', 'd0') as never, false, chain(9))).toMatch(/nest more than 8/);
  });

  it.each([
    ['a link', 'a', /holds a link or a control/],
    ['a paragraph', 'p', null],
  ])('asks about wide, deep nesting inside %s once per definition', (_name, ancestor, hit) => {
    // Eight levels of forty placements each; spans, so the paragraph rule has to walk all of it.
    const wide = (leaf: string) => Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `w${i}`,
        definition(`w${i}`, node(`r${i}`, 'span', {}, i < 7 ? Array.from({ length: 40 }, (_, n) => placed(`p${i}-${n}`, `w${i + 1}`)) : [node('leaf', leaf)])),
      ]),
    ) as unknown as ComponentDefinitions;
    const started = performance.now();
    expect(contentModelRefusal(wide('b'), 'w0', [ancestor])).toBeNull();
    if (hit) expect(contentModelRefusal(wide('input'), 'w0', [ancestor])).toMatch(hit);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('judges wide, deep nesting once per definition rather than once per placement', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `w${i}`,
        definition(`w${i}`, node(`r${i}`, 'div', {}, i < 7 ? Array.from({ length: 40 }, (_, n) => placed(`p${i}-${n}`, `w${i + 1}`)) : [])),
      ]),
    ) as unknown as ComponentDefinitions;
    const started = performance.now();
    expect(renderGateProblem(placed('p', 'w0') as never, false, wide)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
// ci-replay touch
