// Components the generator writes for repeated structure: what it keeps, what it
// refuses, and that a generation with them is added and taken back whole.
// docs/plans/2026-11-02-reusable-components.md, "AI generation".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { validateGeneration } from '../validate';
import { deriveBreakpointKeys } from '../schema';
import { breakpointKeyMap, toEditorDefinitions, toEditorSnapshot } from '../apply';
import { checkBinding } from '../validateDefinition';
import { requestContextText, emitPageTool } from '../prompt';
import HistoryStore from '@/stores/HistoryStore';
import ProjectStore from '@/stores/ProjectStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { componentSummaries } from '@/lib/components/summaries';
import { parseComponents } from '@/lib/components/definition';

const KEYS = deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1200 }, { label: 'Mobile', minWidth: 0 }]);

const CARD_DEFINITION = {
  name: 'Pricing card',
  description: 'One plan',
  inputs: [
    { id: 'title', name: 'Title', type: 'text', default: 'Starter' },
    { id: 'featured', name: 'Featured', type: 'toggle', default: false },
    { id: 'photo', name: 'Photo', type: 'image', default: { src: 'https://elsewhere.example/a.jpg', alt: '' } },
  ],
  root: {
    type: 'article',
    props: { style: { padding: { base: '24px', mobile: '16px' } } },
    children: [
      { type: 'h3', bindings: { children: '{{input.title}}' } },
      { type: 'span', props: { children: 'Best' }, bindings: { visible: '{{input.featured}}', href: '{{input.title}}' } },
      { type: 'img', props: { alt: 'x' }, bindings: { src: '{{input.photo.src}}', alt: '{{input.photo.alt}}' } },
    ],
  },
};

const place = (title: string) => ({ type: '#component', name: 'Pricing card', inputs: { title } });

function generate(raw: Record<string, unknown>, summaries = componentSummaries({})) {
  let n = 0;
  return validateGeneration(raw, { breakpoints: KEYS, newId: () => `g${++n}`, components: { summaries } });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a generated definition', () => {
  it('is kept with its inputs, its bindings to them, and its placements', () => {
    const outcome = generate({ nodes: [{ type: 'section', children: [place('Starter'), place('Pro')] }], definitions: [CARD_DEFINITION] });
    if (!outcome.ok) throw new Error(outcome.errors.join('; '));
    const [definition] = outcome.result.definitions!;
    expect(definition).toMatchObject({ name: 'Pricing card', description: 'One plan' });
    expect(definition.inputs.map(input => input.id)).toEqual(['title', 'featured', 'photo']);
    // A default picture from another host is not kept.
    expect(definition.inputs[2]).not.toHaveProperty('default');
    const [heading, badge, image] = definition.root.children;
    expect(heading.bindings).toEqual({ children: { mode: 'read', expression: '{{input.title}}' } });
    expect(badge.bindings).toEqual({ visible: { mode: 'read', expression: '{{input.featured}}' } });
    expect(image.bindings).toEqual({ src: { mode: 'read', expression: '{{input.photo.src}}' }, alt: { mode: 'read', expression: '{{input.photo.alt}}' } });
    expect(outcome.result.warnings.join('\n')).toMatch(/binding href cannot take a text input/);
    const placed = outcome.result.nodes[0].children.map(node => node.props);
    expect(placed).toEqual([{ component: definition.id, inputs: { title: 'Starter' } }, { component: definition.id, inputs: { title: 'Pro' } }]);
  });

  it('is refused when placed once, so the model writes the content in place', () => {
    const outcome = generate({ nodes: [place('Only')], definitions: [CARD_DEFINITION] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors.join('\n')).toMatch(/placed 1 times/);
  });

  it('is refused past the limit, under a name the site has, or with a bad input', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...CARD_DEFINITION, name: `Card ${i}` }));
    expect(generate({ nodes: [place('x')], definitions: many }).ok).toBe(false);
    const site = componentSummaries(parseComponents({ c: { id: 'c', name: 'Pricing Card', page: { appComponentTree: { id: 'r', type: 'div' } }, inputs: [], states: [] } }).definitions);
    const taken = generate({ nodes: [place('a'), place('b')], definitions: [CARD_DEFINITION] }, site);
    expect(taken.ok).toBe(false);
    const bad = generate({ nodes: [place('a'), place('b')], definitions: [{ ...CARD_DEFINITION, inputs: [{ id: 'x', name: 'X', type: 'script' }] }] });
    expect(bad.ok).toBe(false);
    const textRoot = generate({ nodes: [place('a'), place('b')], definitions: [{ ...CARD_DEFINITION, root: { type: '#text', props: { children: 'x' } } }] });
    expect(textRoot.ok).toBe(false);
  });

  it('keeps no binding outside a definition, and no stock photo search inside one', () => {
    const outside = generate({ nodes: [{ type: 'h1', props: { children: 'x' }, bindings: { children: '{{input.title}}' } }] });
    if (!outside.ok) throw new Error(outside.errors.join('; '));
    expect(outside.result.nodes[0].bindings).toBeUndefined();
    expect(outside.result.warnings.join('\n')).toMatch(/bindings connect data/);
    const photo = generate({
      nodes: [place('a'), place('b')],
      definitions: [{ ...CARD_DEFINITION, root: { type: 'article', children: [{ type: 'img', props: { alt: 'A cake', imageQuery: 'chocolate cake on a plate' } }] } }],
    });
    if (!photo.ok) throw new Error(photo.errors.join('; '));
    expect(photo.result.imageRequests).toEqual([]);
    expect(photo.result.warnings.join('\n')).toMatch(/comes from an Image input/);
  });

  it('reads only its own inputs, into a slot that suits them', () => {
    const inputs = CARD_DEFINITION.inputs as never;
    expect(checkBinding('children', '{{ input.title }}', inputs)).toEqual({ ok: true, entry: { mode: 'read', expression: '{{input.title}}' } });
    expect(checkBinding('children', '{{row.title}}', inputs).ok).toBe(false);
    expect(checkBinding('children', '{{input.ghost}}', inputs).ok).toBe(false);
    expect(checkBinding('src', '{{input.photo}}', inputs).ok).toBe(false);
    expect(checkBinding('src', '{{input.photo.alt}}', inputs).ok).toBe(false);
    expect(checkBinding('style.color', '{{input.title}}', inputs).ok).toBe(false);
  });

  it('is taught in every request, and the tool carries it', () => {
    expect(requestContextText({ breakpoints: KEYS, target: { kind: 'newPage' } })).toContain('## Writing a component');
    const schema = emitPageTool().input_schema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('definitions');
  });
});

// ---------- the model: added and taken back whole ----------

function setup() {
  const store = ProjectStore.create({});
  store.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: {} as never });
  const project = store.getProject('site') as ProjectModelType;
  const page = project.createPage('Home');
  const history = HistoryStore.create({});
  history.setTargetStore(store);
  history.clear();
  return { project, page, history };
}

function applied() {
  const { project, page, history } = setup();
  const outcome = generate({ nodes: [place('Starter'), place('Pro')], definitions: [CARD_DEFINITION] });
  if (!outcome.ok) throw new Error(outcome.errors.join('; '));
  const breakpoints = (page.sortedViewportNodes as ComponentInstance[]).map((v, i) => ({ id: v.breakpointId!, label: i === 0 ? 'Desktop' : 'Mobile', minWidth: v.breakpointMinWidth! }));
  const keyMap = breakpointKeyMap(breakpoints.slice(0, 2).map((b, i) => ({ ...b, minWidth: i === 0 ? 1200 : 0 })));
  const root = page.appComponentTree as ComponentInstance;
  history.clear();
  const result = project.applyGeneration({
    pageId: page.id,
    mode: 'insert',
    targetId: root.id,
    snapshots: outcome.result.nodes.map(node => toEditorSnapshot(node, keyMap)),
    generationId: 'gen-1',
    definitions: toEditorDefinitions(outcome.result.definitions, keyMap),
    pageBreakpoints: breakpoints,
  });
  if (!result.ok) throw new Error(result.reason);
  return { project, page, history, record: result.value, definitionId: outcome.result.definitions![0].id };
}

describe('applying a generation with a component', () => {
  it('adds the component and its placements as one history entry, mapped onto its own frames', () => {
    const { project, history, record, definitionId } = applied();
    expect(history.history.length).toBe(1);
    expect(record.definitionIds).toEqual([definitionId]);
    const definition = project.components.get(definitionId)!;
    expect(definition.name).toBe('Pricing card');
    const padding = (definition.page.appComponentTree.props as { style: { padding: Record<string, string> } }).style.padding;
    const own = new Set((definition.page.sortedViewportNodes as ComponentInstance[]).map(v => v.breakpointId));
    expect(Object.keys(padding).filter(key => key !== 'base').every(key => own.has(key))).toBe(true);
    expect(padding.base).toBe('24px');
    expect(project.placementCount(definitionId)).toBe(2);
    history.undo();
    expect(project.components.has(definitionId)).toBe(false);
  });

  it('takes the component back with the nodes, and refuses while it is placed elsewhere', () => {
    const { project, page, record, definitionId } = applied();
    const other = project.createPage('Other');
    expect(project.placeComponent(other.id, definitionId, { kind: 'appTree' }).ok).toBe(true);
    expect(project.revertGeneration(record)).toMatchObject({ ok: false });
    expect(project.components.has(definitionId)).toBe(true);
    const placed = (other.appComponentTree as ComponentInstance).children.find((c: ComponentInstance) => c.type === '#component')!;
    (other.appComponentTree as ComponentInstance).removeChild(placed.id);
    expect(project.revertGeneration(record)).toEqual({ ok: true, value: null });
    expect(project.components.has(definitionId)).toBe(false);
    expect((page.appComponentTree as ComponentInstance).children.some((c: ComponentInstance) => c.type === '#component')).toBe(false);
  });

  it('refuses a name taken twice, and a target gone meanwhile, changing nothing', () => {
    const { project, page } = setup();
    const outcome = generate({ nodes: [place('a'), place('b')], definitions: [CARD_DEFINITION] });
    if (!outcome.ok) throw new Error(outcome.errors.join('; '));
    const definitions = toEditorDefinitions(outcome.result.definitions, new Map());
    expect(project.generatedDefinitionsRefusal([...definitions, { ...definitions[0], id: 'other' }])).toMatch(/already a component called/);
    const before = JSON.stringify(getSnapshot(project));
    const result = project.applyGeneration({
      pageId: page.id, mode: 'insert', targetId: 'gone', snapshots: [], generationId: 'g', definitions, pageBreakpoints: [],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
  });
});
