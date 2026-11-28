// A node's `parentId` repeats what the tree already says, and the editor reads it
// to decide whether a node can be moved, deleted or duplicated (`hasParent`). A
// tree written by something other than the editor (a script posting to the save
// route) can leave it out. On the canvas every press then went to the breakpoint
// frame, so a click anywhere selected the whole desktop. The model takes the link
// from the tree, whatever was stored.
import { describe, expect, it } from 'vitest';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import { ProjectModel } from '@/models/ProjectModel';
import { persistedToProjectSnapshot } from '@/server/sites/snapshot';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';

const bare = (id: string, ...children: Record<string, unknown>[]): Record<string, unknown> => ({
  id,
  type: 'div',
  componentType: 'host',
  props: {},
  children,
});

/** `id>parentId` for every node, in tree order. */
const links = (node: ComponentInstance): string[] => [
  `${node.id}>${node.parentId ?? '-'}`,
  ...(node.children as ComponentInstance[]).flatMap(links),
];

const expected = ['root>-', 'section>root', 'title>section', 'text>root'];
const tree = () => bare('root', bare('section', bare('title')), bare('text'));

describe('parent links', () => {
  it('are taken from the tree when the stored nodes have none', () => {
    const root = ComponentModel.create(tree() as never) as ComponentInstance;
    expect(links(root)).toEqual(expected);
    const title = (root.children[0] as ComponentInstance).children[0] as ComponentInstance;
    expect(title.hasParent).toBe(true);
    expect((getSnapshot(root) as { children: { children: { parentId?: string }[] }[] }).children[0].children[0].parentId).toBe('section');
  });

  it('replace a stored link that names another node', () => {
    const wrong = bare('root', { ...bare('section', { ...bare('title'), parentId: 'gone' }), parentId: 'title' }, { ...bare('text'), parentId: 'root' });
    expect(links(ComponentModel.create(wrong as never) as ComponentInstance)).toEqual(expected);
  });

  it('are taken from the tree when a snapshot is applied to a live node', () => {
    const root = ComponentModel.create(bare('root') as never) as ComponentInstance;
    applySnapshot(root, tree() as never);
    expect(links(root)).toEqual(expected);
  });

  it('leave the node that tops a tree as it was given', () => {
    // A node created to be added to a parent names it itself.
    expect((ComponentModel.create({ ...bare('moved'), parentId: 'target' } as never) as ComponentInstance).parentId).toBe('target');
  });

  it('are there on every page, floating element and component of a loaded site', () => {
    const floating = { ...bare('float', bare('float-child')), canvasNodeType: 'floating', canvasX: 0, canvasY: 0 };
    const loaded = ProjectModel.create(
      persistedToProjectSnapshot({
        id: 'site',
        name: 'Site',
        description: '',
        analyticsProjectId: null,
        ingestionEndpoint: null,
        apiKeyRef: null,
        lumitraEnabled: false,
        components: { c1: { id: 'c1', name: 'Card', page: { id: 'page-c1', metadata: { title: 'Card' }, appComponentTree: bare('card', bare('card-child')), canvasNodes: defaultViewportSnapshots() }, inputs: [], states: [] } },
        projectCreatedAt: new Date(0),
        projectUpdatedAt: new Date(0),
        pages: [{ pageId: 'home', snapshot: { id: 'home', slug: '', metadata: { title: 'Home' }, appComponentTree: tree(), canvasNodes: { ...defaultViewportSnapshots(), float: floating } } }],
      }),
    );
    const page = loaded.pages.get('home')!;
    expect(links(page.appComponentTree as ComponentInstance)).toEqual(expected);
    expect(links(page.getCanvasNode('float') as ComponentInstance)).toEqual(['float>-', 'float-child>float']);
    for (const frame of page.sortedViewportNodes as ComponentInstance[]) expect(frame.parentId).toBeUndefined();
    expect(links(loaded.components.get('c1')!.page.appComponentTree as ComponentInstance)).toEqual(['card>-', 'card-child>card']);
  });
});
// ci-replay touch
