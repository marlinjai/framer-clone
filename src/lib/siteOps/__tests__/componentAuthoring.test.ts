// @vitest-environment node
//
// Gaps A3 and A4 of docs/plans/2026-11-02-reusable-components.md: an agent makes and
// changes components (createComponent, renameComponent, addComponentInput with and
// without a connection, renameComponentInput, removeComponentInput,
// setComponentInputDefault), each through the editor's own ProjectModel action, and
// the editor's Make input connects an input nothing reads any more again instead of
// making a second one. Every refusal leaves the project byte for byte as it was.

import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { inputDraftFor } from '@/lib/components/makeInput';
import { applyOperations } from '../applyOps';
import { keyedBreakpoints } from '../breakpoints';
import { pageOutline, siteOverview } from '../read';

type Stored = Record<string, unknown> & { id: string; children?: Stored[] };

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: Stored[] = [], extra: Record<string, unknown> = {}): Stored => ({
  id,
  type,
  componentType: 'host',
  props,
  ...extra,
  children: children.map((child) => ({ ...child, parentId: id })),
});
const read = (expression: string) => ({ mode: 'read', expression });

// The Glockenkarte of the proofs of 2026-11-27: three text inputs, two placements with values of their own.
const BELL = {
  id: 'bell',
  name: 'Glockenkarte',
  page: {
    id: 'page-bell',
    metadata: { title: 'Glockenkarte' },
    appComponentTree: node('bell-root', 'article', {}, [
      node('bell-title', 'h3', { children: 'Glocke' }, [], { bindings: { children: read('{{input.text}}') } }),
      node('bell-place', 'p', { children: 'Ort' }, [], { bindings: { children: read('{{input.text-2}}') } }),
      node('bell-year', 'p', { children: 'Jahr' }, [], { bindings: { children: read('{{input.text-3}}') } }),
      node('bell-link', 'a', { href: '/glocken', children: 'Mehr' }),
      node('bell-photo', 'img', { src: '/glocke.jpg', alt: 'Glocke' }),
    ]),
    canvasNodes: defaultViewportSnapshots(),
  },
  inputs: [
    { id: 'text', name: 'Text', type: 'text', default: 'Glocke' },
    { id: 'text-2', name: 'Text 2', type: 'text', default: 'Ort' },
    { id: 'text-3', name: 'Text 3', type: 'text', default: 'Jahr' },
  ],
  states: [],
};
const SHELF = {
  id: 'shelf',
  name: 'Regal',
  page: { id: 'page-shelf', metadata: { title: 'Regal' }, appComponentTree: node('shelf-root', 'div', {}, [node('shelf-bell', '#component', { component: 'bell', inputs: { text: 'Im Regal' } })]), canvasNodes: {} },
  inputs: [],
  states: [],
};

function makeProject(): ProjectModelType {
  const home = node('root', 'div', {}, [
    node('hero', 'section', {}, [node('hero-title', 'h1', { children: 'Glocken' }), node('hero-copy', 'p', { children: 'Seit 1850' })]),
    node('first', '#component', { component: 'bell', inputs: { text: 'Erste', 'text-2': 'Turm' } }),
    node('second', '#component', { component: 'bell', inputs: { text: 'Zweite', 'text-3': '1901' } }),
  ]);
  const about = node('about-root', 'div', {}, [node('third', '#component', { component: 'bell', inputs: { 'text-2': 'Kapelle' } })]);
  const page = (id: string, slug: string, tree: Stored) => ({ id, slug, metadata: { title: id, description: '' }, appComponentTree: tree as never, canvasNodes: defaultViewportSnapshots() });
  return ProjectModel.create({
    id: 'site-1',
    metadata: { title: 'Glocken', description: '', createdAt: 1, updatedAt: 1 },
    pages: { home: page('home', '', home), about: page('about', 'about', about) },
    components: { bell: BELL, shelf: SHELF } as never,
  });
}

const bell = (p: ProjectModelType) => p.components.get('bell')!;
const bellPage = (p: ProjectModelType) => bell(p).page as PageModelType;
const findAnywhere = (p: ProjectModelType, id: string): ComponentInstance | undefined => {
  for (const page of [...p.pages.values(), ...Array.from(p.components.values(), (d) => d.page)] as PageModelType[]) {
    const found = page.findComponent(id) as ComponentInstance | undefined;
    if (found) return found;
  }
  return undefined;
};
const ownValues = (p: ProjectModelType, id: string) => (getSnapshot(findAnywhere(p, id)!) as { props: { inputs?: Record<string, unknown> } }).props.inputs;
const bindingOf = (p: ProjectModelType, id: string, slot: string) => (getSnapshot(findAnywhere(p, id)!) as { bindings?: Record<string, { expression: string }> }).bindings?.[slot]?.expression;

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

const valueOn = (project: ProjectModelType, placementId: string, inputId: string, pageId = 'home') => {
  const page = (project.pages.get(pageId) ?? Array.from(project.components.values()).find((d) => d.page.id === pageId)!.page) as PageModelType;
  return pageOutline(page, { components: project.components, maxChars: 80_000 })
    .nodes.find((n) => n.id === placementId)!.component!.inputs!.find((i) => i.id === inputId)!;
};

describe('createComponent and renameComponent (A3)', () => {
  it('makes a component from nodes, the placement takes their place, and later operations name both by ref', async () => {
    const project = makeProject();
    const outcome = await applied(project, [
      { op: 'createComponent', pageId: 'home', nodeIds: ['hero'], name: 'Hero', ref: 'hero', placementRef: 'heroPlaced' },
      { op: 'addComponentInput', definitionId: 'ref:hero', input: { name: 'Headline', type: 'text' }, connect: { nodeId: 'hero-title', slot: 'children' } },
      { op: 'setComponentInputs', nodeId: 'ref:heroPlaced', values: { headline: 'Neue Glocken' } },
      { op: 'renameComponent', definitionId: 'ref:hero', name: 'Startbereich' },
    ]);
    const definitionId = outcome.created.hero;
    const definition = project.components.get(definitionId)!;
    expect(definition.name).toBe('Startbereich');
    // The node kept its id inside the component, and the field's text is the default.
    expect(definition.inputs).toEqual([{ id: 'headline', name: 'Headline', type: 'text', default: 'Glocken' }]);
    expect(bindingOf(project, 'hero-title', 'children')).toBe('{{input.headline}}');
    expect((project.pages.get('home') as PageModelType).findComponent('hero')).toBeUndefined();
    expect(ownValues(project, outcome.created.heroPlaced)).toEqual({ headline: 'Neue Glocken' });
    expect(outcome.summary[0]).toMatch(/made component "Hero"/);
    expect(siteOverview(project, 1).components.find((c) => c.id === definitionId)).toMatchObject({ name: 'Startbereich', placements: 1 });
  });

  it('several nodes become one under a div', async () => {
    const project = makeProject();
    const outcome = await applied(project, [{ op: 'createComponent', pageId: 'home', nodeIds: ['hero-title', 'hero-copy'], name: 'Kopf', ref: 'k' }]);
    const tree = getSnapshot(project.components.get(outcome.created.k)!.page.appComponentTree) as { type: string; children: Array<{ id: string }> };
    expect(tree.type).toBe('div');
    expect(tree.children.map((c) => c.id)).toEqual(['hero-title', 'hero-copy']);
  });

  it('refuses, writing nothing: an unknown node, a taken name, nodes of two parents, a rename to a taken name', async () => {
    expect(await refusal([{ op: 'createComponent', pageId: 'home', nodeIds: ['nope'], name: 'X' }])).toMatch(/unknown node id "nope"/);
    expect(await refusal([{ op: 'createComponent', pageId: 'home', nodeIds: ['hero'], name: 'Glockenkarte' }])).toMatch(/already a component called Glockenkarte/);
    expect(await refusal([{ op: 'createComponent', pageId: 'home', nodeIds: ['hero', 'hero-title'], name: 'X' }])).toMatch(/next to each other/);
    expect(await refusal([{ op: 'renameComponent', definitionId: 'shelf', name: 'Glockenkarte' }])).toMatch(/already a component called/);
    expect(await refusal([{ op: 'renameComponent', definitionId: 'nope', name: 'X' }])).toMatch(/unknown component id/);
  });
});

describe('addComponentInput (A3)', () => {
  it('without a connection: added with its default, its id from the name', async () => {
    const project = makeProject();
    const outcome = await applied(project, [{ op: 'addComponentInput', definitionId: 'bell', input: { name: 'Größe', type: 'choice', options: [{ label: 'Klein', value: 'sm' }, { label: 'Groß', value: 'lg' }], default: 'sm' } }]);
    expect(bell(project).inputs.at(-1)).toEqual({ id: 'gr-e', name: 'Größe', type: 'choice', options: [{ label: 'Klein', value: 'sm' }, { label: 'Groß', value: 'lg' }], default: 'sm' });
    expect(outcome.summary[0]).toMatch(/connected to no field yet/);
  });

  it('connected to a link, a picture and a style: the field\'s current value is the default unless one is given', async () => {
    const project = makeProject();
    await applied(project, [
      { op: 'addComponentInput', definitionId: 'bell', input: { id: 'to', name: 'Ziel', type: 'link' }, connect: { nodeId: 'bell-link', slot: 'href' } },
      { op: 'addComponentInput', definitionId: 'bell', input: { id: 'photo', name: 'Bild', type: 'image' }, connect: { nodeId: 'bell-photo', slot: 'src' } },
      { op: 'addComponentInput', definitionId: 'bell', input: { id: 'tone', name: 'Farbe', type: 'color', default: '#333333' }, connect: { nodeId: 'bell-root', slot: 'style.color' } },
    ]);
    const inputs = Object.fromEntries(bell(project).inputs.map((i) => [i.id, i]));
    expect(inputs.to.default).toBe('/glocken');
    expect(inputs.photo.default).toEqual({ src: '/glocke.jpg', alt: 'Glocke' });
    expect(inputs.tone.default).toBe('#333333');
    expect(bindingOf(project, 'bell-photo', 'src')).toBe('{{input.photo.src}}');
    expect(bindingOf(project, 'bell-root', 'style.color')).toBe('{{input.tone}}');
  });

  it('refuses, writing nothing', async () => {
    const add = (input: Record<string, unknown>, connect?: Record<string, unknown>) => [{ op: 'addComponentInput', definitionId: 'bell', input, ...(connect ? { connect } : {}) }];
    expect(await refusal(add({ id: 'text', name: 'Noch ein Text', type: 'text' }))).toMatch(/already has that input/);
    expect(await refusal(add({ name: 'Zahl', type: 'number', default: 'viele' }))).toMatch(/default it refuses/);
    expect(await refusal(add({ name: 'Wahl', type: 'choice' }))).toMatch(/needs options/);
    expect(await refusal(add({ name: 'Foto', type: 'image', default: 'https://images.unsplash.com/photo-1' }))).toMatch(/Unsplash/);
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'bell-title', slot: 'children' }))).toMatch(/already connected/);
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'bell-link', slot: 'href' }))).toMatch(/cannot set href/);
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'bell-link', slot: 'onclick' }))).toMatch(/not a field an input can set/);
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'bell-root', slot: 'children' }))).toMatch(/holds no text/);
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'bell-root', slot: 'style.notAThing' }))).toMatch(/not a style property/);
    expect(await refusal(add({ name: 'X', type: 'image' }, { nodeId: 'bell-link', slot: 'src' }))).toMatch(/no img/);
    expect(await refusal(add({ name: 'X', type: 'toggle' }, { nodeId: 'bell-root', slot: 'style.color' }))).toMatch(/style.color takes a text, number, color/);
    expect(await refusal(add({ name: 'X', type: 'list', fields: [{ id: 'a', name: 'A', type: 'text' }] }, { nodeId: 'bell-link', slot: 'children' }))).toMatch(/children takes a text/);
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'bell-link', slot: 'visible' }))).toMatch(/visible takes a toggle/);
    // A node of a page, not of the component.
    expect(await refusal(add({ name: 'X', type: 'text' }, { nodeId: 'hero-title', slot: 'children' }))).toMatch(/unknown node "hero-title" inside "Glockenkarte"/);
  });

  it('an input of a component placed inside: the outer input takes the inner one\'s type and value', async () => {
    const project = makeProject();
    await applied(project, [{ op: 'addComponentInput', definitionId: 'shelf', input: { id: 'label', name: 'Beschriftung', type: 'text' }, connect: { nodeId: 'shelf-bell', slot: 'input.text' } }]);
    expect(project.components.get('shelf')!.inputs).toEqual([{ id: 'label', name: 'Beschriftung', type: 'text', default: 'Im Regal' }]);
    expect(await refusal([{ op: 'addComponentInput', definitionId: 'shelf', input: { name: 'N', type: 'number' }, connect: { nodeId: 'shelf-bell', slot: 'input.text-2' } }])).toMatch(/text input, so the new input must be one too/);
    expect(await refusal([{ op: 'addComponentInput', definitionId: 'shelf', input: { name: 'N', type: 'text' }, connect: { nodeId: 'shelf-bell', slot: 'input.nope' } }])).toMatch(/no such input/);
  });
});

describe('renameComponentInput and removeComponentInput (A3)', () => {
  it('a rename keeps the id, every value and every connection', async () => {
    const project = makeProject();
    await applied(project, [{ op: 'renameComponentInput', definitionId: 'bell', inputId: 'text-2', name: 'Ort' }]);
    expect(bell(project).inputs[1]).toEqual({ id: 'text-2', name: 'Ort', type: 'text', default: 'Ort' });
    expect(ownValues(project, 'first')).toEqual({ text: 'Erste', 'text-2': 'Turm' });
    expect(await refusal([{ op: 'renameComponentInput', definitionId: 'bell', inputId: 'text', name: 'text 3' }])).toMatch(/already has an input called/);
    expect(await refusal([{ op: 'renameComponentInput', definitionId: 'bell', inputId: 'nope', name: 'X' }])).toMatch(/no longer exists/);
  });

  it('removing an input a definition used on many pages takes every value and connection, and counts them', async () => {
    const project = makeProject();
    const outcome = await applied(project, [{ op: 'removeComponentInput', definitionId: 'bell', inputId: 'text' }]);
    expect(outcome.summary[0]).toBe('removed input text of "Glockenkarte" with 1 connection(s) inside it and the values of 3 placement(s) on 2 page(s)');
    expect(bell(project).inputs.map((i) => i.id)).toEqual(['text-2', 'text-3']);
    expect(ownValues(project, 'first')).toEqual({ 'text-2': 'Turm' });
    expect(ownValues(project, 'second')).toEqual({ 'text-3': '1901' });
    expect(ownValues(project, 'shelf-bell')).toBeUndefined();
    expect(bindingOf(project, 'bell-title', 'children')).toBeUndefined();
    expect(await refusal([{ op: 'removeComponentInput', definitionId: 'bell', inputId: 'text' }], project)).toMatch(/has no input "text"/);
  });
});

describe('setComponentInputDefault (A3, the model step A4 shares)', () => {
  it('every placement without its own value shows the new default, on every page', async () => {
    const project = makeProject();
    const outcome = await applied(project, [{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'text-2', default: 'Dorfkirche' }]);
    expect(outcome.summary[0]).toBe('set the default of input text-2 of "Glockenkarte"; 2 placement(s) show it');
    expect(valueOn(project, 'second', 'text-2')).toMatchObject({ source: 'default', value: 'Dorfkirche' });
    expect(valueOn(project, 'first', 'text-2')).toMatchObject({ source: 'own', value: 'Turm' });
    expect(valueOn(project, 'shelf-bell', 'text-2', 'page-shelf')).toMatchObject({ source: 'default', value: 'Dorfkirche' });
    await applied(project, [{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'text-2', default: null }]);
    expect(bell(project).inputs[1]).toEqual({ id: 'text-2', name: 'Text 2', type: 'text' });
  });

  it('a colour per breakpoint key is stored per breakpoint id of the component\'s own page', async () => {
    const project = makeProject();
    await applied(project, [{ op: 'addComponentInput', definitionId: 'bell', input: { id: 'tone', name: 'Farbe', type: 'color' } }]);
    const keyed = keyedBreakpoints(bellPage(project));
    await applied(project, [{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'tone', default: { [keyed[0].key]: '#111111', [keyed[1].key]: '#222222' } }]);
    expect(bell(project).inputs.find((i) => i.id === 'tone')!.default).toEqual({ [keyed[0].id]: '#111111', [keyed[1].id]: '#222222' });
    expect(siteOverview(project, 1).components.find((c) => c.id === 'bell')!.inputs.find((i) => i.id === 'tone')!.default).toEqual({ [keyed[0].key]: '#111111', [keyed[1].key]: '#222222' });
  });

  it('refuses, writing nothing: a wrong type, an event, an unknown input, no default given', async () => {
    const project = makeProject();
    await applied(project, [{ op: 'addComponentInput', definitionId: 'bell', input: { id: 'n', name: 'N', type: 'number', max: 10 } }, { op: 'addComponentInput', definitionId: 'bell', input: { id: 'e', name: 'E', type: 'event' } }]);
    expect(await refusal([{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'n', default: 11 }], project)).toMatch(/at most 10/);
    expect(await refusal([{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'e', default: 'x' }], project)).toMatch(/event input/);
    expect(await refusal([{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'nope', default: 'x' }], project)).toMatch(/no input "nope"/);
    expect(await refusal([{ op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'text' }], project)).toMatch(/give a default/);
  });

  it('a later refused operation takes the definition change back', async () => {
    expect(await refusal([
      { op: 'setComponentInputDefault', definitionId: 'bell', inputId: 'text', default: 'Kept?' },
      { op: 'removeComponentInput', definitionId: 'bell', inputId: 'text-3' },
      { op: 'renameComponent', definitionId: 'bell', name: 'Regal' },
    ])).toMatch(/already a component called Regal/);
  });
});

describe('ProjectModel.setInputDefault and Make input (A4)', () => {
  it('setInputDefault sets and removes, and refuses a value the type refuses without changing anything', () => {
    const project = makeProject();
    expect(project.setInputDefault('bell', 'text', 'Neu').ok).toBe(true);
    expect(bell(project).inputs[0].default).toBe('Neu');
    expect(project.setInputDefault('bell', 'text', 42.5).ok).toBe(true);
    expect(project.setInputDefault('bell', 'text', { not: 'text' })).toEqual({ ok: false, message: 'Text: text is a string.' });
    expect(project.setInputDefault('bell', 'text', undefined).ok).toBe(true);
    expect(bell(project).inputs[0].default).toBeUndefined();
    expect(project.setInputDefault('bell', 'nope', 'x').ok).toBe(false);
  });

  // The proofs' case: unlink the first text, make the input again. Before, a fourth
  // input "Text 4" appeared and the placements' "Erste" and "Zweite" were read by nothing.
  const makeAgain = (project: ProjectModelType, nodeId: string, label = 'Text') => {
    const target = bellPage(project).findComponent(nodeId) as ComponentInstance;
    const { input, expression } = inputDraftFor({ type: target.type, props: (getSnapshot(target) as { props: Record<string, unknown> }).props }, 'children', label, bell(project).inputs);
    return project.makeInput('bell', nodeId, 'children', input, expression, { reuseUnconnected: true });
  };

  it('unlink and Make input again connects the same input, so the placements\' values show again', () => {
    const project = makeProject();
    (bellPage(project).findComponent('bell-title') as ComponentInstance).clearBinding('children');
    expect(makeAgain(project, 'bell-title')).toEqual({ ok: true, inputId: 'text', reused: true });
    expect(bell(project).inputs.map((i) => i.id)).toEqual(['text', 'text-2', 'text-3']);
    expect(bindingOf(project, 'bell-title', 'children')).toBe('{{input.text}}');
    expect(valueOn(project, 'first', 'text')).toMatchObject({ source: 'own', value: 'Erste' });
  });

  it('with several unconnected inputs, the one the row is named after and holding its value is taken', () => {
    const project = makeProject();
    for (const id of ['bell-title', 'bell-place']) (bellPage(project).findComponent(id) as ComponentInstance).clearBinding('children');
    // Both "Text" and "Text 2" are unconnected; the row is "Text 2" and holds "Ort", the default of text-2.
    expect(makeAgain(project, 'bell-place', 'Text 2')).toMatchObject({ inputId: 'text-2', reused: true });
  });

  it('an input renamed since is still found by the field\'s value (the Fritzenkoetter case: "Titel der Karte")', () => {
    const project = makeProject();
    expect(project.renameInput('bell', 'text', 'Titel der Karte').ok).toBe(true);
    (bellPage(project).findComponent('bell-title') as ComponentInstance).clearBinding('children');
    expect(makeAgain(project, 'bell-title')).toMatchObject({ inputId: 'text', reused: true });
    expect(bell(project).inputs).toHaveLength(3);
  });

  it('the only unconnected input, with another name and another value, is not taken: a new input', () => {
    const project = makeProject();
    // The review's case: "Email" unlinked elsewhere, then Make input on an "Address" row.
    bell(project).setInputs([...bell(project).inputs, { id: 'email', name: 'Email', type: 'text', default: 'a@b.de' }]);
    expect(makeAgain(project, 'bell-link', 'Address')).toMatchObject({ reused: false, inputId: 'address' });
  });

  it('two candidates both matching only one way: nothing says which, so a new input', () => {
    const project = makeProject();
    for (const id of ['bell-title', 'bell-place']) (bellPage(project).findComponent(id) as ComponentInstance).clearBinding('children');
    // Make text-2 hold the title's value too: "Text" by name, "Text 2" by value, neither both.
    expect(project.setInputDefault('bell', 'text', 'Anders').ok).toBe(true);
    expect(project.setInputDefault('bell', 'text-2', 'Glocke').ok).toBe(true);
    expect(makeAgain(project, 'bell-title')).toMatchObject({ reused: false });
  });

  it('a single unconnected input of another type is not taken', () => {
    const project = makeProject();
    bell(project).setInputs([...bell(project).inputs, { id: 'n', name: 'N', type: 'number' }]);
    expect(makeAgain(project, 'bell-link', 'Mehr')).toMatchObject({ reused: false });
  });

  it('without reuseUnconnected (the agent operation) it always adds', () => {
    const project = makeProject();
    (bellPage(project).findComponent('bell-title') as ComponentInstance).clearBinding('children');
    const target = bellPage(project).findComponent('bell-title') as ComponentInstance;
    const { input, expression } = inputDraftFor({ type: target.type, props: (getSnapshot(target) as { props: Record<string, unknown> }).props }, 'children', 'Text', bell(project).inputs);
    expect(project.makeInput('bell', 'bell-title', 'children', input, expression)).toMatchObject({ ok: true, reused: false, inputId: 'text-4' });
  });
});
