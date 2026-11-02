// The model actions the Components panel and the right panel add: duplicate a
// definition, make an input from a node's value, and reset a placement. Each is one
// history entry, over forward, backtrack (undo), resume (a snapshot round trip) and
// re-entry (the thing acted on gone).
import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { type ProjectModelType } from '../ProjectModel';
import type { ComponentInstance } from '../ComponentModel';
import HistoryStore from '@/stores/HistoryStore';
import ProjectStore from '@/stores/ProjectStore';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';

const read = (expression: string) => ({ mode: 'read', expression });
const host = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = [], bindings?: Record<string, unknown>) => ({
  id, type, componentType: 'host', props, children, ...(bindings ? { bindings } : {}),
});

function setup() {
  const frames = defaultViewportSnapshots(['d-large', 'd-mid', 'd-small']);
  const store = ProjectStore.create({});
  store.ingestProjectSnapshot({
    id: 'site',
    metadata: { title: 'Site' },
    pages: {},
    components: {
      card: {
        id: 'card',
        name: 'Card',
        page: {
          id: 'card-page',
          metadata: { title: 'Card' },
          appComponentTree: host('c-root', 'article', { style: { width: { base: '100%', 'd-small': '50%' } } }, [
            host('c-title', 'h3', { children: 'Stored title' }, [], { children: read('{{input.title}}') }),
            host('c-link', 'a', { children: 'Go', href: '/about' }),
          ]),
          canvasNodes: frames,
        },
        inputs: [
          { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
          { id: 'tone', name: 'Tone', type: 'color', default: { base: '#111111', 'd-small': '#222222' } },
        ],
        states: [],
      },
    } as never,
  });
  const project = store.getProject('site') as ProjectModelType;
  const page = project.createPage('Home');
  const history = HistoryStore.create({});
  history.setTargetStore(store);
  history.clear();
  return { store, project, page, history };
}

describe('duplicateDefinition', () => {
  it('copies a definition with fresh ids, renamed frames and the same look, as one step', () => {
    const { project, history } = setup();
    const result = project.duplicateDefinition('card');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copy = project.components.get(result.definitionId)!;
    expect(copy.name).toBe('Card copy');
    const root = copy.page.appComponentTree as unknown as ComponentInstance;
    expect(root.id).not.toBe('c-root');
    expect(root.children.map((c: ComponentInstance) => c.type)).toEqual(['h3', 'a']);
    expect(root.children[0].bindings.children).toEqual(read('{{input.title}}'));
    // The small frame's value moved to the copy's own small frame.
    const small = (copy.page.sortedViewportNodes as ComponentInstance[]).at(-1)!;
    expect(small.breakpointId).not.toBe('d-small');
    expect((root.props.style as { width: Record<string, string> }).width).toEqual({ base: '100%', [small.breakpointId!]: '50%' });
    expect(copy.inputs[1].default).toEqual({ base: '#111111', [small.breakpointId!]: '#222222' });
    expect(history.history.length).toBe(1);
    history.undo();
    expect(project.components.size).toBe(1);
  });

  it('picks the next free name and refuses a definition that is gone', () => {
    const { project } = setup();
    project.duplicateDefinition('card');
    const second = project.duplicateDefinition('card');
    expect(second.ok && project.components.get(second.definitionId)?.name).toBe('Card copy 2');
    expect(project.duplicateDefinition('gone')).toEqual({ ok: false, message: 'That component no longer exists.' });
  });

  it('survives a snapshot round trip', () => {
    const { store, project } = setup();
    project.duplicateDefinition('card');
    const again = ProjectStore.create({});
    again.ingestProjectSnapshot(JSON.parse(JSON.stringify(getSnapshot(store.getProject('site')!))));
    expect(again.getProject('site')!.components.size).toBe(2);
  });
});

describe('makeInput', () => {
  it('adds the input and binds the node as one step, and undo takes both back', () => {
    const { project, history } = setup();
    const result = project.makeInput('card', 'c-link', 'href', { id: 'link', name: 'Link', type: 'link', default: '/about' }, '{{input.link}}');
    expect(result).toEqual({ ok: true });
    const card = project.components.get('card')!;
    expect(card.inputs.map(i => i.id)).toEqual(['title', 'tone', 'link']);
    const link = card.page.findComponent('c-link')!;
    expect(link.bindings.href).toEqual(read('{{input.link}}'));
    expect(history.history.length).toBe(1);
    history.undo();
    expect(card.inputs.map(i => i.id)).toEqual(['title', 'tone']);
    expect(card.page.findComponent('c-link')!.bindings.href).toBeUndefined();
  });

  it('refuses a mismatched binding, a taken id, a type an address may not hold and a node that is gone', () => {
    const { project, history } = setup();
    expect(project.makeInput('card', 'c-link', 'href', { id: 'x', name: 'X', type: 'text' }, '{{input.x}}').ok).toBe(false);
    expect(project.makeInput('card', 'c-link', 'children', { id: 'title', name: 'T', type: 'text' }, '{{input.title}}').ok).toBe(false);
    expect(project.makeInput('card', 'c-link', 'children', { id: 'y', name: 'Y', type: 'text' }, '{{input.z}}').ok).toBe(false);
    expect(project.makeInput('card', 'nope', 'children', { id: 'y', name: 'Y', type: 'text' }, '{{input.y}}').ok).toBe(false);
    expect(project.makeInput('gone', 'c-link', 'children', { id: 'y', name: 'Y', type: 'text' }, '{{input.y}}').ok).toBe(false);
    expect(history.history.length).toBe(0);
  });
});

describe('resetPlacementValues', () => {
  it('clears values, state and their bindings in one step and keeps the layout', () => {
    const { project, page, history } = setup();
    const placed = project.placeComponent(page.id, 'card', { kind: 'appTree' });
    if (!placed.ok) throw new Error(placed.message);
    const node = placed.placement;
    node.setProps({ inputs: { title: 'Mine' }, state: 's1' });
    node.updateResponsiveStyle('width', '300px');
    node.setBinding('input.title', read('{{row.title}}'));
    history.clear();
    node.resetPlacementValues();
    expect(node.props.inputs).toBeUndefined();
    expect(node.props.state).toBeUndefined();
    expect(node.bindings).toEqual({});
    expect(node.props.style).toBeDefined();
    expect(history.history.length).toBe(1);
    history.undo();
    expect(node.props.inputs).toEqual({ title: 'Mine' });
    expect(node.bindings['input.title']).toEqual(read('{{row.title}}'));
  });
});
