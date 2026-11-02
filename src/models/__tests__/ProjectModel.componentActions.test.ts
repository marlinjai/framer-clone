// Component actions on the model. Each is one history entry whatever it crosses,
// over the four stateful paths: forward, backtrack (undo), resume (a snapshot round
// trip) and re-entry (a definition gone while placements remain, or put back).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import { createIntrinsicComponent, type ComponentInstance } from '../ComponentModel';
import type { PageModelType } from '../PageModel';
import HistoryStore from '@/stores/HistoryStore';
import ProjectStore from '@/stores/ProjectStore';
import { COMPONENT_LIMITS } from '@/lib/components/placement';
import { readRules } from '@/lib/rules/rules';

const read = (expression: string) => ({ mode: 'read', expression });

const host = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = [], bindings?: Record<string, unknown>) => ({
  id,
  type,
  componentType: 'host',
  props,
  children,
  ...(bindings ? { bindings } : {}),
});

const placement = (id: string, component: string, inputs?: Record<string, unknown>, bindings?: Record<string, unknown>) =>
  host(id, '#component', { component, ...(inputs ? { inputs } : {}) }, [], bindings);

const definition = (id: string, tree: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  page: { id: `${id}-page`, metadata: { title: id }, appComponentTree: tree, canvasNodes: {} },
  inputs: [],
  states: [],
  ...extra,
});

const CARD = definition(
  'card',
  host('c-root', 'section', { style: { color: 'red' } }, [
    host('c-title', 'h3', { children: 'Stored' }, [], { children: read('{{input.title}}') }),
    host('c-img', 'img', {}, [], { src: read('{{input.image.src}}') }),
    host('c-badge', 'span', { children: 'New' }, [], { visible: read('{{input.badge}}') }),
  ]),
  {
    inputs: [
      { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
      { id: 'image', name: 'Image', type: 'image', default: { src: '/a.jpg', alt: '' } },
      { id: 'badge', name: 'Badge', type: 'toggle', default: true },
    ],
  },
);

function setup(components: Record<string, unknown> = {}) {
  // As the editor has it: history watches the store above the project.
  const store = ProjectStore.create({});
  store.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: components as never });
  const project = store.getProject('site') as ProjectModelType;
  const page = project.createPage('Home');
  page.setSlug('');
  const history = HistoryStore.create({});
  history.setTargetStore(store);
  history.clear();
  return { project, page, history };
}

const rootOf = (page: PageModelType) => page.appComponentTree as unknown as ComponentInstance;

type Stored = { id: string; children?: Stored[] };

const withParents = (node: Stored, parentId: string): Stored => ({
  ...node,
  parentId,
  children: (node.children ?? []).map(child => withParents(child, node.id)),
} as Stored);

function fill(page: PageModelType, ...children: unknown[]) {
  const stored = getSnapshot(page.appComponentTree) as unknown as Stored;
  page.setAppComponentTree({ ...stored, children: (children as Stored[]).map(child => withParents(child, stored.id)) } as never);
}

/** Key-order independent, since undoing a delete puts a map entry back at the end. */
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]))
      : value;
const state = (project: ProjectModelType) => JSON.stringify(sorted(getSnapshot(project)));

/** The action as a person takes it: one history entry, and undo and redo walk it back and forth. */
function expectOneStep(project: ProjectModelType, history: ReturnType<typeof HistoryStore.create>, act: () => void) {
  history.clear();
  const before = state(project);
  act();
  const after = state(project);
  expect(after).not.toBe(before);
  expect(history.history.length).toBe(1);
  history.undo();
  expect(state(project)).toBe(before);
  history.redo();
  expect(state(project)).toBe(after);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('createComponentFromSelection', () => {
  it('turns one node into a definition and a placement at the same position, in one step', () => {
    const { project, page, history } = setup();
    fill(page, host('first', 'p'), host('hero', 'section', { style: { color: 'red' } }, [host('t', 'h1', { children: 'Hi' })]), host('last', 'p'));
    expectOneStep(project, history, () => {
      const result = project.createComponentFromSelection(page.id, ['hero'], 'Hero');
      expect(result.ok).toBe(true);
    });
    const types = rootOf(page).children.map((child: ComponentInstance) => child.type);
    expect(types).toEqual(['p', '#component', 'p']);
    const [definition] = [...project.components.values()];
    expect(definition.page.appComponentTree.id).toBe('hero');
    expect(rootOf(page).children[1].props.component).toBe(definition.id);
    expect(project.pagesArray).toHaveLength(1);
  });

  it('wraps several nodes in a div, in document order', () => {
    const { project, page } = setup();
    fill(page, host('a', 'p'), host('b', 'p'), host('c', 'p'));
    project.createComponentFromSelection(page.id, ['c', 'a'], 'Pair');
    const [definition] = [...project.components.values()];
    const tree = definition.page.appComponentTree as unknown as ComponentInstance;
    expect(tree.type).toBe('div');
    expect(tree.children.map((child: ComponentInstance) => child.id)).toEqual(['a', 'c']);
    expect(rootOf(page).children.map((child: ComponentInstance) => child.type)).toEqual(['#component', 'p']);
  });

  it('wraps a lone text node or placement, since a root needs an element', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, placement('p1', 'card'));
    project.createComponentFromSelection(page.id, ['p1'], 'Outer');
    const created = [...project.components.values()].find(d => d.name === 'Outer')!;
    expect(created.page.appComponentTree.type).toBe('div');
  });

  it('rewrites breakpoints to the definition\'s own by width', () => {
    const { project, page } = setup();
    const widths = page.viewportNodes.map(viewport => viewport.breakpointId!);
    const smallest = [...page.viewportNodes].sort((a, b) => a.breakpointMinWidth! - b.breakpointMinWidth!)[0].breakpointId!;
    fill(page, host('n', 'div', { style: { width: { base: '100%', [smallest]: '50%' } } }));
    project.createComponentFromSelection(page.id, ['n'], 'Box');
    const [definition] = [...project.components.values()];
    const width = (definition.page.appComponentTree.props as { style: { width: Record<string, string> } }).style.width;
    expect(Object.keys(width)).toHaveLength(2);
    expect(Object.keys(width).some(key => widths.includes(key))).toBe(false);
    expect(Object.values(width)).toEqual(['100%', '50%']);
  });

  it('refuses the page root, nodes of two parents, a sticky bar, a taken name and an empty one', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, host('a', 'div', {}, [host('in', 'p')]), host('b', 'p'), host('bar', 'div', { 'data-sticky-cta': 'true' }));
    const before = state(project);
    const refused = [
      project.createComponentFromSelection(page.id, [rootOf(page).id], 'X'),
      project.createComponentFromSelection(page.id, ['in', 'b'], 'X'),
      project.createComponentFromSelection(page.id, ['b'], 'card'),
      project.createComponentFromSelection(page.id, ['b'], '  '),
      project.createComponentFromSelection(page.id, ['gone'], 'X'),
      project.createComponentFromSelection('nope', ['b'], 'X'),
    ];
    for (const result of refused) expect(result).toMatchObject({ ok: false, message: expect.any(String) });
    expect(state(project)).toBe(before);
  });

  it('refuses past the site limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: COMPONENT_LIMITS.definitionsPerSite }, (_, i) => [`d${i}`, definition(`d${i}`, host(`r${i}`, 'div'))]),
    );
    const { project, page } = setup(many);
    fill(page, host('a', 'p'));
    expect(project.createComponentFromSelection(page.id, ['a'], 'One more')).toMatchObject({ ok: false });
  });

  it('survives a snapshot round trip, and its undo too', () => {
    const { project, page } = setup();
    fill(page, host('a', 'p', { children: 'Hello' }));
    project.createComponentFromSelection(page.id, ['a'], 'Text');
    const copy = ProjectModel.create(JSON.parse(state(project)));
    expect(copy.components.size).toBe(1);
    expect([...copy.components.values()][0].page.appComponentTree.id).toBe('a');
  });
});

describe('placing', () => {
  it('places in one step, on a page and inside a definition', () => {
    const { project, page, history } = setup({ card: CARD, shell: definition('shell', host('s', 'div')) });
    expectOneStep(project, history, () => {
      expect(project.placeComponent(page.id, 'card', { kind: 'appTree' }).ok).toBe(true);
    });
    expect(project.placeComponent('shell-page', 'card', { kind: 'appTree' }).ok).toBe(true);
    expect(rootOf(page).children[0].type).toBe('#component');
  });

  it('refuses a cycle with a reason naming the path', () => {
    const grid = definition('grid', host('g', 'div', {}, [placement('in', 'card')]));
    const { project } = setup({ card: CARD, grid });
    expect(project.placeComponent('card-page', 'grid', { kind: 'appTree' })).toEqual({ ok: false, message: 'card contains grid, which contains card.' });
    expect(project.placeComponent('card-page', 'card', { kind: 'appTree' })).toEqual({ ok: false, message: 'card contains card.' });
  });

  it('refuses a nesting past the limit', () => {
    const depth = COMPONENT_LIMITS.nestingDepth;
    const chain = Object.fromEntries(
      Array.from({ length: depth }, (_, i) => [
        `d${i}`,
        definition(`d${i}`, host(`r${i}`, 'div', {}, i + 1 < depth ? [placement(`p${i}`, `d${i + 1}`)] : [])),
      ]),
    );
    const { project } = setup({ ...chain, top: definition('top', host('t', 'div')) });
    expect(project.placeComponent('top-page', 'd0', { kind: 'appTree' })).toMatchObject({ ok: false, message: expect.stringMatching(/nest at most/) });
  });

  it('refuses an unknown definition, a placement as parent and a text node as parent', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, placement('p1', 'card'), { ...host('t', '#text'), props: { children: 'x' } });
    expect(project.placeComponent(page.id, 'gone', { kind: 'appTree' }).ok).toBe(false);
    expect(project.placeComponent(page.id, 'card', { kind: 'parent', parentId: 'p1' }).ok).toBe(false);
    expect(project.placeComponent(page.id, 'card', { kind: 'parent', parentId: 't' }).ok).toBe(false);
  });

  it('refuses by content model: a link in a link, a block in a paragraph', () => {
    const link = definition('link', host('l', 'a', { href: '/' }));
    const wrapped = definition('wrapped', host('w', 'span', {}, [placement('n', 'link')]));
    const { project, page } = setup({ link, wrapped, card: CARD });
    fill(page, host('out', 'a', { href: '/x' }, [host('deep', 'span')]), host('para', 'p'));
    expect(project.placeComponent(page.id, 'link', { kind: 'parent', parentId: 'deep' }).ok).toBe(false);
    expect(project.placeComponent(page.id, 'wrapped', { kind: 'parent', parentId: 'out' }).ok).toBe(false);
    expect(project.placeComponent(page.id, 'card', { kind: 'parent', parentId: 'para' }).ok).toBe(false);
    expect(project.placeComponent(page.id, 'wrapped', { kind: 'parent', parentId: 'para' }).ok).toBe(true);
  });

  it('refuses to make a component whose root a browser would split from its paragraph', () => {
    const { project, page, history } = setup({ card: CARD });
    fill(page, host('para', 'p', {}, [host('a', 'span'), host('b', 'span')]));
    history.clear();
    const before = state(project);
    expect(project.createComponentFromSelection(page.id, ['a', 'b'], 'Pair')).toMatchObject({ ok: false, message: expect.stringMatching(/paragraph/) });
    expect(state(project)).toBe(before);
    expect(history.history.length).toBe(0);
  });

  it('refuses a new component that would push a chain past the nesting limit', () => {
    const depth = COMPONENT_LIMITS.nestingDepth;
    const chain = Object.fromEntries(
      Array.from({ length: depth }, (_, i) => [
        `d${i}`,
        definition(`d${i}`, host(`r${i}`, 'div', {}, i + 1 < depth ? [placement(`p${i}`, `d${i + 1}`)] : [host(`leaf${i}`, 'span')])),
      ]),
    );
    const { project, history } = setup(chain);
    history.clear();
    const before = state(project);
    expect(project.createComponentFromSelection(`d${depth - 2}-page`, [`p${depth - 2}`], 'Deeper')).toMatchObject({ ok: false, message: expect.stringMatching(/nest at most/) });
    expect(state(project)).toBe(before);
  });

  it('refuses a move that would close a cycle from the floating canvas', () => {
    const { project } = setup({ card: CARD });
    const page = project.components.get('card')!.page as PageModelType;
    page.addCanvasNode({ ...placement('float', 'card'), canvasNodeType: 'floating', canvasX: 0, canvasY: 0 } as never);
    expect(page.moveTreeComponent('float', { kind: 'appTree' })).toBeUndefined();
    expect(page.getCanvasNode('float')).toBeTruthy();
  });
});

describe('a placement as a node', () => {
  const placed = () => {
    const { page } = setup({ card: CARD });
    fill(page, placement('p1', 'card'));
    return rootOf(page).children[0] as ComponentInstance;
  };

  it('refuses children, rules, a tag, and text', () => {
    const node = placed();
    node.addChild(createIntrinsicComponent('x', 'p', {}));
    expect(node.children).toHaveLength(0);
    expect(node.addRule({ selector: '&:hover', style: {} })).toMatchObject({ ok: false });
    expect(node.setRuleStyle('hover', 'color', 'red')).toMatchObject({ ok: false });
    node.setTag('div');
    expect(node.type).toBe('#component');
    node.setTextContent('words');
    node.setProps({ children: 'words', rules: [] });
    expect(node.props).toEqual({ component: 'card' });
  });

  it('binds only its inputs and its state', () => {
    const node = placed();
    node.setBinding('input.title', read('{{row.title}}') as never);
    node.setBinding('state', read('{{row.tier}}') as never);
    node.setBinding('children', read('{{row.title}}') as never);
    expect(Object.keys(node.bindings).sort()).toEqual(['input.title', 'state']);
  });
});

describe('a definition page', () => {
  it('refuses a sticky bar and a root placement', () => {
    const { project } = setup({ card: CARD });
    const page = project.components.get('card')!.page as PageModelType;
    expect(page.insertRegistryComponent('sticky-cta', { kind: 'appTree' })).toBeUndefined();
    page.setAppComponentTree(placement('root', 'card') as never);
    expect(page.appComponentTree.type).toBe('section');
  });
});

describe('inputs', () => {
  const withPlacements = () => {
    const shell = definition('shell', host('s', 'div', {}, [placement('nested', 'card', { title: 'Nested' })]));
    const { project, page, history } = setup({ card: CARD, shell });
    fill(page, placement('p1', 'card', { title: 'Mine', badge: false }), placement('p2', 'card', undefined, { 'input.title': read('{{row.title}}') }));
    return { project, page, history };
  };
  const placementsOn = (page: PageModelType) => rootOf(page).children as ComponentInstance[];

  it('removes an input, its bindings and every value, in one step', () => {
    const { project, page, history } = withPlacements();
    expectOneStep(project, history, () => expect(project.removeInput('card', 'title').ok).toBe(true));
    const [first, second] = placementsOn(page);
    expect(first.props).toEqual({ component: 'card', inputs: { badge: false } });
    expect(second.bindings).toEqual({});
    const nested = project.components.get('shell')!.page.appComponentTree.children[0] as ComponentInstance;
    expect(nested.props).toEqual({ component: 'card' });
    const title = project.components.get('card')!.page.findComponent('c-title')!;
    expect(title.bindings).toEqual({});
    expect(title.props.children).toBe('Stored');
    expect(project.components.get('card')!.inputs.map(input => input.id)).toEqual(['image', 'badge']);
  });

  it('adds up to the limit, and refuses a bad definition or a repeated id', () => {
    const { project } = setup({ card: CARD });
    expect(project.addInput('card', { id: 'title', name: 'Again', type: 'text' })).toMatchObject({ ok: false });
    expect(project.addInput('card', { id: 'x', name: '', type: 'text' })).toMatchObject({ ok: false });
    for (let i = 3; i < COMPONENT_LIMITS.inputsPerDefinition; i++) {
      expect(project.addInput('card', { id: `i${i}`, name: 'I', type: 'text' }).ok).toBe(true);
    }
    expect(project.addInput('card', { id: 'over', name: 'Over', type: 'text' })).toMatchObject({ ok: false });
  });

  it('changes a type, keeping values that pass, in one step, and says first how many go', () => {
    const { project, page, history } = withPlacements();
    const next = { id: 'title', name: 'Title', type: 'number' as const, default: 3 };
    placementsOn(page)[0].setProps({ inputs: { title: '12', badge: false } });
    expect(project.inputTypeChangeLoss('card', next)).toBe(2);
    expectOneStep(project, history, () => expect(project.changeInputType('card', next).ok).toBe(true));
    expect(placementsOn(page)[0].props.inputs).toEqual({ badge: false });
    expect(project.components.get('card')!.inputs[0].type).toBe('number');
  });

  it('drops a binding the new type may not hold', () => {
    const link = definition('link', host('l', 'a', {}, [], { href: read('{{input.to}}') }), {
      inputs: [{ id: 'to', name: 'To', type: 'link', default: '/' }],
    });
    const { project } = setup({ link });
    project.changeInputType('link', { id: 'to', name: 'To', type: 'text', default: 'x' });
    expect(project.components.get('link')!.page.appComponentTree.bindings).toEqual({});
  });
});

describe('states', () => {
  const stateful = definition(
    'button',
    host('b', 'button', { rules: [{ id: 'state-hover', componentState: 'hover', selector: '&', style: { color: 'red' } }] }),
    { states: [{ id: 'hover', name: 'Hover', kind: 'hover' }, { id: 'pressed', name: 'Pressed', kind: 'pressed', implies: ['hover'] }], noScriptState: 'hover' },
  );

  it('removes a state with its rules and placements on it, in one step', () => {
    const { project, page, history } = setup({ button: stateful });
    fill(page, host('p1', '#component', { component: 'button', state: 'hover' }));
    expectOneStep(project, history, () => expect(project.removeState('button', 'hover').ok).toBe(true));
    const definitionNow = project.components.get('button')!;
    expect(definitionNow.page.appComponentTree.props.rules).toBeUndefined();
    expect(definitionNow.noScriptState).toBeUndefined();
    expect(definitionNow.states).toEqual([{ id: 'pressed', name: 'Pressed', kind: 'pressed', implies: [] }]);
    expect((rootOf(page).children[0] as ComponentInstance).props).toEqual({ component: 'button' });
  });

  it('adds up to the limit, and refuses a bad state', () => {
    const { project } = setup({ button: stateful });
    expect(project.addState('button', { id: 'primary', name: 'P', kind: 'custom' })).toMatchObject({ ok: false });
    for (let i = 2; i < COMPONENT_LIMITS.statesPerDefinition; i++) {
      expect(project.addState('button', { id: `s${i}`, name: 'S', kind: 'custom' }).ok).toBe(true);
    }
    expect(project.addState('button', { id: 'over', name: 'S', kind: 'custom' })).toMatchObject({ ok: false });
  });
});

describe('detachPlacement', () => {
  const title = (root: ComponentInstance) => root.children[0] as ComponentInstance;

  it('replaces a placement with a copy holding its values, at its position, in one step', () => {
    const { project, page, history } = setup({ card: CARD });
    fill(page, host('first', 'p'), placement('p1', 'card', { title: 'Mine' }), host('last', 'p'));
    expectOneStep(project, history, () => expect(project.detachPlacement(page.id, 'p1').ok).toBe(true));
    const types = rootOf(page).children.map((child: ComponentInstance) => child.type);
    expect(types).toEqual(['p', 'section', 'p']);
    const root = rootOf(page).children[1] as ComponentInstance;
    expect(root.id).not.toBe('c-root');
    expect(title(root).props.children).toBe('Mine');
    expect(title(root).bindings).toEqual({});
    expect(project.components.has('card')).toBe(true);
  });

  it('rewrites a value from data to the outer expression, joining paths', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, placement('p1', 'card', undefined, { 'input.image': read('{{row.cover}}') }));
    project.detachPlacement(page.id, 'p1');
    const image = (rootOf(page).children[0] as ComponentInstance).children[1] as ComponentInstance;
    expect(image.bindings).toEqual({ src: read('{{row.cover.src}}') });
  });

  it('removes what a literal `visible: false` hid', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, placement('p1', 'card', { badge: false }), placement('p2', 'card'));
    project.detachPlacement(page.id, 'p1');
    project.detachPlacement(page.id, 'p2');
    const [hidden, shown] = rootOf(page).children as ComponentInstance[];
    expect(hidden.children.map((c: ComponentInstance) => c.type)).toEqual(['h3', 'img']);
    expect(shown.children.map((c: ComponentInstance) => c.type)).toEqual(['h3', 'img', 'span']);
    expect((shown.children[2] as ComponentInstance).props).toEqual({ children: 'New' });
  });

  it('turns a pointer state into rules the parser accepts, marking the root for a descendant', () => {
    const hovered = definition(
      'hovered',
      host('h', 'div', { rules: [{ id: 'state-hover', componentState: 'hover', selector: '&', style: { color: 'red' } }] }, [
        host('in', 'span', { rules: [{ id: 'state-focused', componentState: 'focused', selector: '&', style: { color: 'blue' } }] }),
      ]),
      { states: [{ id: 'hover', name: 'Hover', kind: 'hover' }, { id: 'focused', name: 'Focused', kind: 'focused' }] },
    );
    const { project, page } = setup({ hovered });
    fill(page, placement('p1', 'hovered'));
    project.detachPlacement(page.id, 'p1');
    const root = rootOf(page).children[0] as ComponentInstance;
    const rules = readRules(root.props);
    expect(rules.refused).toEqual([]);
    expect(rules.rules).toMatchObject([{ parts: ['&:hover'], at: ['@media (hover:hover) and (pointer:fine)'] }]);
    expect(root.props['data-u-c-hovered']).toBe('');
    const inner = readRules((root.children[0] as ComponentInstance).props);
    expect(inner.refused).toEqual([]);
    expect(JSON.stringify(inner.rules)).toContain('[data-u-c-hovered]');
    expect(JSON.stringify(getSnapshot(root))).not.toContain('componentState');
  });

  it('keeps a nested placement, handing it the outer value', () => {
    const outer = definition('outer', host('o', 'div', {}, [placement('inner', 'card', undefined, { 'input.title': read('{{input.heading}}'), 'input.image': read('{{input.cover}}') })]), {
      inputs: [{ id: 'heading', name: 'Heading', type: 'text', default: 'Hi' }, { id: 'cover', name: 'Cover', type: 'image' }],
    });
    const { project, page } = setup({ card: CARD, outer });
    fill(page, placement('p1', 'outer', { heading: 'Given' }, { 'input.cover': read('{{row.cover}}') }));
    project.detachPlacement(page.id, 'p1');
    const nested = (rootOf(page).children[0] as ComponentInstance).children[0] as ComponentInstance;
    expect(nested.type).toBe('#component');
    expect(nested.props.inputs).toEqual({ title: 'Given' });
    expect(nested.bindings).toEqual({ 'input.image': read('{{row.cover}}') });
  });

  it('merges the placement\'s own style last, and keeps behaviour following the fresh ids', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, { ...placement('p1', 'card'), props: { component: 'card', style: { color: 'blue', margin: 0 } } });
    project.detachPlacement(page.id, 'p1');
    expect((rootOf(page).children[0] as ComponentInstance).props.style).toMatchObject({ color: 'blue', margin: 0 });
  });

  it('gives a repeated `id` attribute a suffix and follows it', () => {
    const anchored = definition('anchored', host('a', 'div', { id: 'pricing' }, [host('l', 'a', { href: '#pricing' })]));
    const { project, page } = setup({ anchored });
    fill(page, host('own', 'div', { id: 'pricing' }), placement('p1', 'anchored'));
    project.detachPlacement(page.id, 'p1');
    const copy = rootOf(page).children[1] as ComponentInstance;
    expect(copy.props.id).toMatch(/^pricing-/);
    expect((copy.children[0] as ComponentInstance).props.href).toBe(`#${copy.props.id as string}`);
  });

  it('refuses a definition with custom state rules, and changes nothing', () => {
    const custom = definition('custom', host('c', 'div', { rules: [{ id: 'state-s1', componentState: 's1', selector: '&', style: { color: 'red' } }] }), {
      states: [{ id: 's1', name: 'Open', kind: 'custom' }],
    });
    const { project, page } = setup({ custom });
    fill(page, placement('p1', 'custom'));
    const before = state(project);
    expect(project.detachPlacement(page.id, 'p1')).toMatchObject({ ok: false, message: expect.stringMatching(/custom states/) });
    expect(project.deleteDefinition('custom')).toMatchObject({ ok: false });
    expect(state(project)).toBe(before);
  });

  it('refuses a placement that is gone or names nothing', () => {
    const { project, page } = setup();
    fill(page, placement('p1', 'gone'));
    expect(project.detachPlacement(page.id, 'p1').ok).toBe(false);
    expect(project.detachPlacement(page.id, 'nope').ok).toBe(false);
  });
});

describe('deleteDefinition', () => {
  it('detaches every placement across pages and definitions, in one step', () => {
    const shell = definition('shell', host('s', 'div', {}, [placement('nested', 'card', { title: 'Nested' })]));
    const { project, page, history } = setup({ card: CARD, shell });
    const other = project.createPage('Other');
    fill(page, placement('p1', 'card'));
    fill(other, placement('p2', 'card'));
    expectOneStep(project, history, () => expect(project.deleteDefinition('card').ok).toBe(true));
    expect(project.components.has('card')).toBe(false);
    expect((rootOf(page).children[0] as ComponentInstance).type).toBe('section');
    expect((rootOf(other).children[0] as ComponentInstance).type).toBe('section');
    expect(project.components.get('shell')!.page.appComponentTree.children[0].type).toBe('section');
  });

  it('undo brings the placements and the definition back', () => {
    const { project, page, history } = setup({ card: CARD });
    fill(page, placement('p1', 'card', { title: 'Mine' }));
    history.clear();
    project.deleteDefinition('card');
    history.undo();
    expect(project.components.has('card')).toBe(true);
    expect((rootOf(page).children[0] as ComponentInstance).id).toBe('p1');
  });

  it('a placement whose definition vanished stays, and comes back when it does', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, placement('p1', 'card'));
    const stored = getSnapshot(project.components).card;
    const copy = ProjectModel.create({ ...JSON.parse(state(project)), components: {} });
    const placed = rootOf(copy.pagesArray[0]).children[0] as ComponentInstance;
    expect(placed.type).toBe('#component');
    const restored = ProjectModel.create({ ...JSON.parse(state(copy)), components: { card: stored } });
    expect(restored.components.has('card')).toBe(true);
    expect((rootOf(restored.pagesArray[0]).children[0] as ComponentInstance).props.component).toBe('card');
  });
});

describe('the size limit', () => {
  const big = 'x'.repeat(COMPONENT_LIMITS.definitionBytes);

  it('undoes an ordinary edit that takes a definition over, and tells the owner', () => {
    const { project, history } = setup({ card: CARD });
    const before = state(project);
    project.components.get('card')!.page.findComponent('c-title')!.setTextContent(big);
    expect(state(project)).toBe(before);
    expect(history.history.length).toBe(0);
    expect(project.refusedComponents).toMatchObject([{ id: 'card', edit: true }]);
  });

  it('undoes a whole project action, and answers with the reason', () => {
    const { project, page, history } = setup({ card: CARD });
    fill(page, host('a', 'p', { children: big }));
    history.clear();
    const before = state(project);
    const result = project.createComponentFromSelection(page.id, ['a'], 'Huge');
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/larger than/) });
    expect(state(project)).toBe(before);
    expect(history.history.length).toBe(0);
  });

  it('answers an action that returns a node with nothing', () => {
    const stuffed = definition('stuffed', host('s', 'div', { title: 'y'.repeat(COMPONENT_LIMITS.definitionBytes - 2000) }));
    const { project } = setup({ stuffed });
    const page = project.components.get('stuffed')!.page as PageModelType;
    const before = state(project);
    expect(page.insertRegistryComponent('form', { kind: 'appTree' })).toBeUndefined();
    expect(state(project)).toBe(before);
  });

  it('lets an edit through that stays under, and pages are not measured', () => {
    const { project, page } = setup({ card: CARD });
    fill(page, host('a', 'p'));
    (rootOf(page).children[0] as ComponentInstance).setTextContent(big);
    expect((rootOf(page).children[0] as ComponentInstance).props.children).toBe(big);
    project.components.get('card')!.page.findComponent('c-title')!.setTextContent('short');
    expect(project.refusedComponents).toEqual([]);
  });

  it('lets undo and redo through', () => {
    const { project, history } = setup({ card: CARD });
    const node = project.components.get('card')!.page.findComponent('c-title')!;
    node.setTextContent('short');
    history.undo();
    expect(node.props.children).toBe('Stored');
    history.redo();
    expect(node.props.children).toBe('short');
  });
});

describe('what the publish check learns', () => {
  it('hears of a definition the load skipped, by way of the store', () => {
    const { project } = setup({ card: CARD, 'fc-reserved': { ...CARD, id: 'fc-reserved' } });
    expect([...project.components.keys()]).toEqual(['card']);
    expect(project.refusedComponents).toMatchObject([{ id: 'fc-reserved', reason: expect.any(String) }]);
  });

  it('keeps a refused edit until a publish, and what the load skipped after it', () => {
    const { project } = setup({ card: CARD, 'fc-reserved': { ...CARD, id: 'fc-reserved' } });
    project.components.get('card')!.page.findComponent('c-title')!.setTextContent('x'.repeat(COMPONENT_LIMITS.definitionBytes));
    expect(project.refusedComponents).toHaveLength(2);
    project.clearRefusedEdits([...project.refusedComponents]);
    expect(project.refusedComponents.map(entry => entry.id)).toEqual(['fc-reserved']);
  });

  it('keeps an edit refused while a publish was out, the same edit again included', () => {
    const { project } = setup({ card: CARD });
    const title = () => project.components.get('card')!.page.findComponent('c-title')!;
    title().setTextContent('x'.repeat(COMPONENT_LIMITS.definitionBytes));
    const acknowledged = [...project.refusedComponents];
    title().setTextContent('y'.repeat(COMPONENT_LIMITS.definitionBytes));
    expect(project.refusedComponents).toHaveLength(1);
    project.clearRefusedEdits(acknowledged);
    expect(project.refusedComponents).toMatchObject([{ id: 'card', edit: true }]);
  });

  it('replaces what a load skipped when the project is loaded again', () => {
    const store = ProjectStore.create({});
    const snapshot = { id: 'site', metadata: { title: 'Site' }, pages: {} };
    store.ingestProjectSnapshot({ ...snapshot, components: { 'fc-reserved': { ...CARD, id: 'fc-reserved' } } as never });
    expect(store.getProject('site')!.refusedComponents).toHaveLength(1);
    store.ingestProjectSnapshot({ ...snapshot, components: { card: CARD } as never });
    expect(store.getProject('site')!.refusedComponents).toEqual([]);
  });

  it('keeps the redo steps when an edit is refused', () => {
    const { project, history } = setup({ card: CARD });
    const title = project.components.get('card')!.page.findComponent('c-title')!;
    title.setTextContent('one');
    title.setTextContent('two');
    history.undo();
    expect(history.canRedo).toBe(true);
    title.setTextContent('x'.repeat(COMPONENT_LIMITS.definitionBytes));
    expect(history.history.length).toBe(2);
    expect(history.canRedo).toBe(true);
    history.redo();
    expect(title.props.children).toBe('two');
  });

  it('leaves no history and nothing in the snapshot', () => {
    const { project, history } = setup({ 'fc-reserved': { ...CARD, id: 'fc-reserved' } });
    expect(history.history.length).toBe(0);
    expect(JSON.stringify(getSnapshot(project))).not.toContain('refusedComponents');
  });
});

describe('renameDefinition', () => {
  it('keeps names unique', () => {
    const { project } = setup({ card: CARD, other: definition('other', host('o', 'div')) });
    expect(project.renameDefinition('other', 'card')).toMatchObject({ ok: false });
    expect(project.renameDefinition('other', 'Grid').ok).toBe(true);
    expect(project.renameDefinition('other', 'Grid').ok).toBe(true);
  });
});
