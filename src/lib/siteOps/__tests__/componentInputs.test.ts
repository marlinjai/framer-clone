// @vitest-environment node
//
// Gaps A1 and A2 of docs/plans/2026-11-02-reusable-components.md: an agent reads a
// component's inputs (getSite) and a placement's values with where each comes from
// (getPage), and gives a placement values of its own (placeComponent inputs,
// setComponentInputs) through ProjectModel.setPlacementInputs, the panel's write
// path. Every refusal leaves the project byte for byte as it was.

import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { parseInputValue, type InputDefinition } from '@/lib/components/inputs';
import { applyOperations } from '../applyOps';
import { keyedBreakpoints } from '../breakpoints';
import { pageOutline, siteOverview, OPERATIONS_DOCS, type PlacementInputValue } from '../read';

type Stored = Record<string, unknown> & { id: string; children?: Stored[] };

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: Stored[] = [], extra: Record<string, unknown> = {}): Stored => ({
  id,
  type,
  componentType: 'host',
  props,
  ...extra,
  children: children.map((child) => ({ ...child, parentId: id })),
});

const INPUTS = [
  { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
  { id: 'gap', name: 'Gap', type: 'number', unit: 'px', min: 0, max: 100, default: 8 },
  { id: 'tone', name: 'Tone', type: 'color' },
  { id: 'photo', name: 'Photo', type: 'image' },
  { id: 'to', name: 'Link', type: 'link' },
  { id: 'size', name: 'Size', type: 'choice', options: [{ label: 'Small', value: 'sm' }, { label: 'Large', value: 'lg' }], default: 'sm' },
  { id: 'clicked', name: 'Clicked', type: 'event' },
];

const CARD = {
  id: 'card',
  name: 'Glockenkarte',
  page: {
    id: 'page-card',
    metadata: { title: 'Glockenkarte' },
    appComponentTree: node('card-root', 'section', {}, [
      node('card-title', 'h3', { children: 'Stored' }, [], { bindings: { children: { mode: 'read', expression: '{{input.title}}' } } }),
    ], { bindings: { 'style.gap': { mode: 'read', expression: '{{input.gap}}' } } }),
    canvasNodes: defaultViewportSnapshots(),
  },
  inputs: INPUTS,
  states: [],
};
// A component that places the card inside itself, so placements are counted there too.
const SHELF = {
  id: 'shelf',
  name: 'Shelf',
  page: { id: 'page-shelf', metadata: { title: 'Shelf' }, appComponentTree: node('shelf-root', 'div', {}, [node('shelf-card', '#component', { component: 'card' })]), canvasNodes: {} },
  inputs: [],
  states: [],
};

function makeProject(): ProjectModelType {
  const tree = node('root', 'div', {}, [
    node('box', 'section', {}, [node('inner', 'p', { children: 'Inside' })]),
    node('mine', '#component', { component: 'card', inputs: { title: 'Erste Glocke', gap: 'wide' } }),
    node('fed', '#component', { component: 'card' }, [], { bindings: { 'input.title': { mode: 'read', expression: '{{row.title}}' } } }),
    node('gone', '#component', { component: 'deleted-card' }),
  ]);
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Glocken', description: '', createdAt: 1, updatedAt: 1 },
    pages: {
      home: { id: 'home', slug: '', metadata: { title: 'Home', description: '' }, appComponentTree: tree as never, canvasNodes: defaultViewportSnapshots() },
    },
    components: { card: CARD, shelf: SHELF } as never,
  });
}

const home = (p: ProjectModelType) => p.pages.get('home') as PageModelType;
const find = (p: ProjectModelType, id: string) => home(p).findComponent(id) as ComponentInstance | undefined;
const inputsOf = (p: ProjectModelType, id: string) => (getSnapshot(find(p, id)!) as { props: { inputs?: Record<string, unknown> } }).props.inputs;

async function applied(project: ProjectModelType, ops: unknown[]) {
  const outcome = await applyOperations(project, ops);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  return outcome;
}

async function refusal(ops: unknown[], project = makeProject()): Promise<string> {
  const before = JSON.stringify(getSnapshot(project));
  const outcome = await applyOperations(project, ops);
  expect(outcome.ok).toBe(false);
  expect(JSON.stringify(getSnapshot(project))).toBe(before);
  return outcome.ok ? '' : outcome.rejected.map((r) => r.reason).join(' | ');
}

const valuesOf = (project: ProjectModelType, id: string, pageId = 'home'): Record<string, PlacementInputValue> => {
  const page = (project.pages.get(pageId) ?? project.components.get(pageId.replace(/^page-/, ''))!.page) as PageModelType;
  const entry = pageOutline(page, { components: project.components, maxChars: 80_000 }).nodes.find((n) => n.id === id)!;
  return Object.fromEntries((entry.component?.inputs ?? []).map((input) => [input.id, input]));
};

describe('getSite lists each component whole (A1)', () => {
  it('inputs with id, name, type, default and options, its page, states, and every placement counted', () => {
    const { components } = siteOverview(makeProject(), 3);
    const card = components.find((c) => c.id === 'card')!;
    expect(card).toMatchObject({ name: 'Glockenkarte', pageId: 'page-card', states: [] });
    expect(card.inputs).toEqual(INPUTS);
    // Two on the home page and one inside the shelf component.
    expect(card.placements).toBe(3);
    expect(components.find((c) => c.id === 'shelf')!.placements).toBe(0);
  });

  it('a default per breakpoint is keyed by breakpoint key, not by the stored id', () => {
    const project = makeProject();
    const keyed = keyedBreakpoints(project.components.get('card')!.page as PageModelType);
    const card = project.components.get('card')!;
    card.setInputs(card.inputs.map((input) => (input.id === 'tone' ? { ...input, default: { [keyed[0].id]: 'red', [keyed[1].id]: 'blue' } } : input)));
    const tone = siteOverview(project, 1).components.find((c) => c.id === 'card')!.inputs.find((i) => i.id === 'tone')!;
    expect(tone.default).toEqual({ [keyed[0].key]: 'red', [keyed[1].key]: 'blue' });
  });
});

describe('getPage shows a placement\'s values and where each comes from (A1)', () => {
  it('own, default, bound with its expression, and a stored value the input refuses', () => {
    const values = valuesOf(makeProject(), 'mine');
    expect(values.title).toMatchObject({ source: 'own', value: 'Erste Glocke' });
    expect(values.gap).toMatchObject({ source: 'refused', value: 8 });
    expect(values.gap.reason).toMatch(/number/);
    expect(values.size).toMatchObject({ source: 'default', value: 'sm' });
    expect(values.tone).toEqual({ id: 'tone', name: 'Tone', type: 'color', source: 'default' });
    const fed = valuesOf(makeProject(), 'fed');
    expect(fed.title).toEqual({ id: 'title', name: 'Title', type: 'text', source: 'bound', expression: '{{row.title}}' });
  });

  it('names the component, keeps its id under props but not the raw values, and marks a missing definition', () => {
    const outline = pageOutline(home(makeProject()), { components: makeProject().components, maxChars: 80_000 });
    const mine = outline.nodes.find((n) => n.id === 'mine')!;
    expect(mine.component).toMatchObject({ definitionId: 'card', name: 'Glockenkarte' });
    // The definition id stays under props, as before; the values are only under component.
    expect(mine.props).toEqual({ component: 'card' });
    expect(outline.nodes.find((n) => n.id === 'gone')!.component).toEqual({ definitionId: 'deleted-card', missing: true });
  });

  it('without the site\'s components nothing is claimed about a placement', () => {
    const outline = pageOutline(home(makeProject()), { maxChars: 80_000 });
    expect(outline.nodes.find((n) => n.id === 'mine')!.component).toBeUndefined();
  });

  it('a long value comes back whole, never cut to an excerpt', async () => {
    const project = makeProject();
    const long = 'Glocke '.repeat(60);
    await applied(project, [{ op: 'setComponentInputs', nodeId: 'mine', values: { title: long } }]);
    expect(valuesOf(project, 'mine').title.value).toBe(long);
  });

  it('a component\'s own page reads like a page, its placements with their values', () => {
    expect(valuesOf(makeProject(), 'shelf-card', 'page-shelf').title).toMatchObject({ source: 'default', value: 'Card title' });
  });
});

describe('placeComponent with values (A2)', () => {
  it('stores each value as written, and a number with a unit renders with it', async () => {
    const project = makeProject();
    const outcome = await applied(project, [
      { op: 'placeComponent', pageId: 'home', definitionId: 'card', ref: 'c', inputs: { title: 'Zweite Glocke', gap: 24, size: 'lg', to: '/kontakt' } },
    ]);
    const id = outcome.created.c;
    // Stored as given: the render step parses it again, and "24px" would not parse a second time.
    expect(inputsOf(project, id)).toEqual({ title: 'Zweite Glocke', gap: 24, size: 'lg', to: '/kontakt' });
    expect(outcome.summary[0]).toMatch(/4 value\(s\) of its own/);
    const values = valuesOf(project, id);
    expect(values.gap).toMatchObject({ source: 'own', value: 24 });
    expect(values.title).toMatchObject({ source: 'own', value: 'Zweite Glocke' });
    // What hydration reads: the stored value parses to the rendered one, the unit added.
    const gap = INPUTS.find((input) => input.id === 'gap')!;
    expect(parseInputValue(gap as InputDefinition, inputsOf(project, id)?.gap)).toEqual({ ok: true, value: '24px' });
    expect(parseInputValue(gap as InputDefinition, '24px').ok).toBe(false);
  });

  it('refuses, writing nothing: an unknown input, a wrong type, an event, null, an unsafe link, an Unsplash photo', async () => {
    const place = (inputs: Record<string, unknown>) => [{ op: 'placeComponent', pageId: 'home', definitionId: 'card', inputs }];
    expect(await refusal(place({ subtitle: 'x' }))).toMatch(/no input "subtitle".*title \(Title\)/);
    expect(await refusal(place({ gap: 'wide' }))).toMatch(/Gap: a number must be finite/);
    expect(await refusal(place({ gap: 500 }))).toMatch(/at most 100/);
    expect(await refusal(place({ size: 'huge' }))).toMatch(/not one of the options/);
    expect(await refusal(place({ clicked: true }))).toMatch(/event input/);
    expect(await refusal(place({ title: null }))).toMatch(/leave it out for the default/);
    expect(await refusal(place({ to: 'javascript:alert(1)' }))).toMatch(/not a safe address/);
    expect(await refusal(place({ photo: { src: 'https://images.unsplash.com/photo-1', alt: '' } }))).toMatch(/Unsplash/);
  });

  it('a later refused operation takes the placement and its values back', async () => {
    expect(await refusal([
      { op: 'placeComponent', pageId: 'home', definitionId: 'card', inputs: { title: 'Kept?' } },
      { op: 'updateText', nodeId: 'no-such-node', text: 'x' },
    ])).toMatch(/unknown node id/);
  });
});

describe('setComponentInputs (A2)', () => {
  it('sets and resets values of one placement in one operation', async () => {
    const project = makeProject();
    const outcome = await applied(project, [{ op: 'setComponentInputs', nodeId: 'mine', values: { title: 'Neu', gap: null, size: 'lg' } }]);
    expect(inputsOf(project, 'mine')).toEqual({ title: 'Neu', size: 'lg' });
    expect(outcome.summary[0]).toBe('set 2 and reset 1 value(s) of mine');
    await applied(project, [{ op: 'setComponentInputs', nodeId: 'mine', values: { title: null, size: null } }]);
    expect(inputsOf(project, 'mine')).toBeUndefined();
  });

  it('a colour per breakpoint key is stored per breakpoint id of the page, and read back by key', async () => {
    const project = makeProject();
    const keyed = keyedBreakpoints(home(project));
    await applied(project, [{ op: 'setComponentInputs', nodeId: 'mine', values: { tone: { [keyed[0].key]: '#ff0000', [keyed[2].key]: '#0000ff' } } }]);
    expect(inputsOf(project, 'mine')?.tone).toEqual({ [keyed[0].id]: '#ff0000', [keyed[2].id]: '#0000ff' });
    expect(valuesOf(project, 'mine').tone.value).toEqual({ [keyed[0].key]: '#ff0000', [keyed[2].key]: '#0000ff' });
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'mine', values: { tone: { watch: '#000' } } }])).toMatch(/unknown breakpoint "watch"/);
  });

  it('works on a placement inside another component', async () => {
    const project = makeProject();
    await applied(project, [{ op: 'setComponentInputs', nodeId: 'shelf-card', values: { title: 'Im Regal' } }]);
    expect(valuesOf(project, 'shelf-card', 'page-shelf').title).toMatchObject({ source: 'own', value: 'Im Regal' });
  });

  it('refuses, writing nothing: not a placement, a missing definition, an input bound to data, an unknown input, a bad value', async () => {
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'box', values: { title: 'x' } }])).toMatch(/not a component placement/);
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'gone', values: { title: 'x' } }])).toMatch(/no longer exists/);
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'fed', values: { title: 'x' } }])).toMatch(/bound to data/);
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'mine', values: { title: 'ok', nope: 1 } }])).toMatch(/no input "nope"/);
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'mine', values: { title: 42.5, gap: -1 } }])).toMatch(/at least 0/);
    expect(await refusal([{ op: 'setComponentInputs', nodeId: 'mine', values: {} }])).toMatch(/at least one input/);
  });

  it('setProps and updateStyle still send a placement here', async () => {
    expect(await refusal([{ op: 'setProps', nodeId: 'mine', props: { inputs: 'x' } }])).toMatch(/through the component definition/);
  });
});

describe('ProjectModel.setPlacementInputs, the shared write path', () => {
  it('is all or nothing: one refused value keeps the others out too', () => {
    const project = makeProject();
    const result = project.setPlacementInputs('mine', { title: 'Neu', size: 'huge' });
    expect(result).toEqual({ ok: false, message: 'Size: not one of the options.' });
    expect(inputsOf(project, 'mine')).toEqual({ title: 'Erste Glocke', gap: 'wide' });
  });

  it('refuses a node that is no placement, and resets with undefined', () => {
    const project = makeProject();
    expect(project.setPlacementInputs('box', { title: 'x' }).ok).toBe(false);
    expect(project.setPlacementInputs('mine', { gap: undefined }).ok).toBe(true);
    expect(inputsOf(project, 'mine')).toEqual({ title: 'Erste Glocke' });
  });
});

describe('the vocabulary', () => {
  it('teaches inputs, the value sources and the new operation, and no longer says no operation sets values', () => {
    expect(OPERATIONS_DOCS).toMatch(/setComponentInputs/);
    expect(OPERATIONS_DOCS).toMatch(/"bound"/);
    expect(OPERATIONS_DOCS).not.toMatch(/no operation sets its values/);
  });
});
