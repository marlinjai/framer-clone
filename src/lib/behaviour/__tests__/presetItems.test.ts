// The panel's item controls for a preset (src/lib/behaviour/presetItems.ts): a tab added
// and taken out and a slide added through the preset's own functions, every field the
// edit does not touch kept, and each node's parent the node it now sits in.
import { describe, expect, it } from 'vitest';
import { carousel } from '../presets/carousel';
import { collectionTabs, tabs } from '../presets/tabs';
import { editPresetItems, idsInUse, presetItemsOf } from '../presetItems';
import { readBehaviourTree, type BehaviourNode } from '../format';

type Snap = Record<string, unknown> & { id: string; children?: Snap[]; props?: Record<string, unknown> };
const asSnapshot = (node: unknown, parentId?: string): Snap => {
  const n = node as Snap;
  return { ...n, ...(parentId ? { parentId } : {}), children: (n.children ?? []).map((child) => asSnapshot(child, n.id)) };
};
const parentsHold = (node: Snap): boolean => (node.children ?? []).every((child) => child.parentId === node.id && parentsHold(child));
const nothingRefused = (node: Snap) => expect(readBehaviourTree(node as BehaviourNode).refused).toEqual([]);

describe('a preset tab list', () => {
  const start = (): Snap => ({ ...asSnapshot(tabs({ seed: 'tabs-aaaaaaaa' }), 'main'), label: 'My tabs' });

  it('reads its tabs by title', () => {
    expect(presetItemsOf(start())).toEqual({ kind: 'tabs', items: ['First', 'Second', 'Third'], canRemove: true });
  });

  it('mints new ids past every id the page uses or names, and never reuses a removed one', () => {
    const ids = (node: Snap): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];
    // Outside the tabs: a node holding the next panel id, and a reference naming the next tab id.
    const page = { id: 'page', type: 'div', props: {}, children: [
      { id: 'tabs-aaaaaaaa-panel-3', type: 'div', props: {} },
      { id: 'jump', type: 'button', props: { behaviour: { on: [{ id: 't-1', on: 'click', do: [{ focus: 'tabs-aaaaaaaa-tab-3' }] }] } } },
    ] };
    const taken = idsInUse([page]);
    expect(taken.has('tabs-aaaaaaaa-panel-3') && taken.has('tabs-aaaaaaaa-tab-3')).toBe(true);
    const next = editPresetItems(start(), { kind: 'addTab' }, taken) as Snap;
    const added = ids(next).filter((id) => !ids(start()).includes(id));
    expect(added.some((id) => taken.has(id))).toBe(false);
    // Without the page, as before: the next free number under the preset.
    expect(ids(editPresetItems(start(), { kind: 'addTab' }) as Snap)).toContain('tabs-aaaaaaaa-tab-3');
    // A middle tab removed, then one added: one past the highest, not the gap.
    const removed = editPresetItems(start(), { kind: 'removeTab', index: 1 }) as Snap;
    const again = editPresetItems(removed, { kind: 'addTab' }) as Snap;
    expect(ids(again)).not.toContain('tabs-aaaaaaaa-tab-1');
    expect(ids(again)).toContain('tabs-aaaaaaaa-tab-3');
  });

  it('gains a tab and its panel, derived again, keeping the layer name and the parents straight', () => {
    const next = editPresetItems(start(), { kind: 'addTab' }) as Snap;
    expect(presetItemsOf(next)?.items).toEqual(['First', 'Second', 'Third', 'Tab 4']);
    expect(next.label).toBe('My tabs');
    expect(next.parentId).toBe('main');
    expect(parentsHold(next)).toBe(true);
    nothingRefused(next);
  });

  it('loses a tab, and never the last one', () => {
    let tree = start();
    tree = editPresetItems(tree, { kind: 'removeTab', index: 1 }) as Snap;
    expect(presetItemsOf(tree)?.items).toEqual(['First', 'Third']);
    tree = editPresetItems(tree, { kind: 'removeTab', index: 0 }) as Snap;
    expect(presetItemsOf(tree)).toMatchObject({ items: ['Third'], canRemove: false });
    expect(editPresetItems(tree, { kind: 'removeTab', index: 0 })).toBeNull();
    expect(editPresetItems(tree, { kind: 'removeTab', index: 7 })).toBeNull();
    nothingRefused(tree);
  });

  it('from a Collection has its tabs from the rows, so it offers nothing here', () => {
    expect(presetItemsOf(collectionTabs({ seed: 'tabs-bbbbbbbb', collection: '{{posts}}', titleField: 'title', bodyField: 'body' }))).toBeNull();
  });
});

describe('a preset carousel', () => {
  it('gains a slide and offers no removal', () => {
    const tree = asSnapshot(carousel({ seed: 'carousel-cccccccc' }));
    expect(presetItemsOf(tree)).toEqual({ kind: 'carousel', items: ['First slide', 'Second slide', 'Third slide'], canRemove: false });
    const next = editPresetItems(tree, { kind: 'addSlide' }) as Snap;
    expect(presetItemsOf(next)?.items).toHaveLength(4);
    expect(editPresetItems(tree, { kind: 'addTab' })).toBeNull();
    nothingRefused(next);
  });

  it('a node that is no preset has no items', () => {
    expect(presetItemsOf({ id: 'x', type: 'div', props: {} })).toBeNull();
    expect(editPresetItems({ id: 'x', type: 'div', props: {} }, { kind: 'addSlide' })).toBeNull();
  });
});
