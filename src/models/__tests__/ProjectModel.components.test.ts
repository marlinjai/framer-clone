// ProjectModel.components: reusable definitions survive the model, and a stored
// value that cannot be read never stops a project from opening.
import { describe, expect, it, vi } from 'vitest';
import { applyPatch, getSnapshot, onPatch } from 'mobx-state-tree';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { parseModelComponents } from '@/models/ComponentDefinitionModel';

const CARD = {
  id: 'card',
  name: 'Card',
  page: {
    id: 'card-page',
    slug: '',
    metadata: { title: 'Card' },
    appComponentTree: { id: 'c-root', type: 'div', componentType: 'host', props: {}, children: [] },
    canvasNodes: {},
  },
  inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'Card title' }],
  states: [{ id: 'hover', name: 'Hover', kind: 'hover' }],
  noScriptState: 'hover',
};

const project = (components?: unknown) =>
  ProjectModel.create({
    id: 'site_components',
    metadata: { title: 'Site', description: '' },
    pages: {},
    ...(components === undefined ? {} : { components: components as never }),
  });

describe('ProjectModel.components', () => {
  it('a snapshot from before the field loads with no definitions', () => {
    expect(project().components.size).toBe(0);
    expect((getSnapshot(project()) as ProjectSnapshotOut).components).toEqual({});
  });

  it('keeps a definition, gives its page frames, and round-trips through JSON unchanged', () => {
    const first = project({ card: CARD });
    const definition = first.components.get('card')!;
    expect(definition.name).toBe('Card');
    expect(definition.page.appComponentTree.id).toBe('c-root');
    expect(definition.inputs).toEqual(CARD.inputs);
    expect(definition.states).toEqual(CARD.states);
    expect(definition.noScriptState).toBe('hover');

    const stored = JSON.parse(JSON.stringify(getSnapshot(first)));
    const viewports = Object.values(stored.components.card.page.canvasNodes as Record<string, { canvasNodeType: string }>);
    expect(viewports.filter((node) => node.canvasNodeType === 'viewport')).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(getSnapshot(project(stored.components)))).components).toEqual(stored.components);
  });

  it('is never one of the pages, so it has no address', () => {
    const p = project({ card: CARD });
    expect(p.pagesArray).toHaveLength(0);
    expect(p.findPageBySlug('')).toBeUndefined();
  });

  it('skips what it cannot read and opens the project', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = project({
      card: CARD,
      'fc-reserved': { ...CARD, id: 'fc-reserved' },
      broken: { ...CARD, id: 'broken', page: { ...CARD.page, id: 'broken-page', appComponentTree: { type: 'div', props: 7 } } },
    });
    expect([...p.components.keys()]).toEqual(['card']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads anything that is not a record as no definitions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of [null, 7, 'x', []]) expect(project(value).components.size).toBe(0);
    warn.mockRestore();
  });

  it('records an edit inside a definition as a patch that undoes', () => {
    const p = project({ card: CARD });
    const patches: { forward: Parameters<typeof applyPatch>[1]; inverse: Parameters<typeof applyPatch>[1] }[] = [];
    onPatch(p, (forward, inverse) => patches.push({ forward, inverse }));
    p.components.get('card')!.page.setSlug('moved');
    expect(patches[0].forward).toMatchObject({ op: 'replace', path: '/components/card/page/slug' });
    applyPatch(p, patches[0].inverse);
    expect(p.components.get('card')!.page.slug).toBe('');
  });
});

describe('parseModelComponents', () => {
  it('reports a page the model refuses beside what the parser refuses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { definitions, refused } = parseModelComponents({
      card: CARD,
      'fc-reserved': { ...CARD, id: 'fc-reserved' },
      broken: { ...CARD, id: 'broken', page: { ...CARD.page, metadata: 7 } },
    });
    expect(Object.keys(definitions)).toEqual(['card']);
    expect(refused.map((r) => r.id).sort()).toEqual(['broken', 'fc-reserved']);
    expect(refused.find((r) => r.id === 'broken')?.reason).toMatch(/page model/);
    warn.mockRestore();
  });
});
