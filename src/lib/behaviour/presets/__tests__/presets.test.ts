import { describe, expect, it } from 'vitest';
import { readBehaviourTree, type StoredBehaviour, type Trigger } from '@/lib/behaviour/format';
import { PRESETS, type PresetKind, type PresetNode } from '@/lib/behaviour/presets';
import { addSlide, carousel } from '@/lib/behaviour/presets/carousel';
import { addTab, collectionTabs, deriveTabs, removeTab, tabs } from '@/lib/behaviour/presets/tabs';
import { deriveToolbar } from '@/lib/behaviour/presets/toolbar';
import { deriveTooltip } from '@/lib/behaviour/presets/tooltip';
import { withProps, propsOf, behaviourOf } from '@/lib/behaviour/presets/nodes';

const kinds = Object.keys(PRESETS) as PresetKind[];

function nodes(root: PresetNode): PresetNode[] {
  return [root, ...(root.children ?? []).flatMap(nodes)];
}

const byRole = (root: PresetNode, role: string) => nodes(root).filter((node) => propsOf(node).role === role);
const refusals = (root: PresetNode) => readBehaviourTree(root as never).refused;

const mine: Trigger = { id: 'mine', on: 'click', do: [{ emit: 'chosen' }] };
const withMine = (node: PresetNode): PresetNode =>
  withProps(node, { behaviour: { ...behaviourOf(node), on: [...(behaviourOf(node).on ?? []), mine] } });

describe('presets', () => {
  it.each(kinds)('%s parses with nothing refused', (kind) => {
    expect(refusals(PRESETS[kind]('a1'))).toEqual([]);
  });

  it.each(kinds)('%s marks its root and everything it generated', (kind) => {
    const root = PRESETS[kind]('a1');
    expect(behaviourOf(root).preset).toMatchObject({ kind, version: 1 });
    for (const node of nodes(root)) {
      const { state, on, bind } = behaviourOf(node);
      for (const entry of [...(state ?? []), ...(on ?? []), ...(bind ?? [])]) expect(entry.preset).toBe(true);
    }
  });

  it.each(kinds)('%s keeps two uses of itself apart', (kind) => {
    const stateOf = (root: PresetNode) => nodes(root).flatMap((node) => (behaviourOf(node).state ?? []).map((state) => state.id));
    const idsOf = (root: PresetNode) => nodes(root).map((node) => node.id);
    const one = PRESETS[kind]('a1');
    const two = PRESETS[kind]('b2');
    expect(stateOf(one).filter((id) => stateOf(two).includes(id))).toEqual([]);
    expect(idsOf(one).filter((id) => idsOf(two).includes(id))).toEqual([]);
  });

  it('refuses a seed that could not start a state id', () => {
    expect(() => tabs({ seed: 'Not Lower' })).toThrow(/seed/);
  });

  it.each([
    ['tabs', deriveTabs],
    ['toolbar', deriveToolbar],
    ['tooltip', deriveTooltip],
  ] as const)('%s derives to the same thing twice', (kind, derive) => {
    const root = PRESETS[kind]('a1');
    expect(derive(root)).toEqual(root);
  });

  it('survives frozen props, which is how the model holds them', () => {
    const freeze = (node: PresetNode): PresetNode => Object.freeze({ ...node, props: Object.freeze(node.props), children: node.children?.map(freeze) }) as PresetNode;
    expect(addTab(freeze(tabs({ seed: 'a1' })), { title: 'Four', body: 'Four says' }).children).toHaveLength(5);
  });
});

describe('tabs', () => {
  it('without a script hides the list and leaves every panel to its own rule', () => {
    const root = tabs({ seed: 'a1' });
    expect(behaviourOf(byRole(root, 'tablist')[0]).noScript).toBe('hide');
    for (const panel of byRole(root, 'tabpanel')) expect(propsOf(panel).hidden).toBeUndefined();
  });

  it('points each tab at its panel and back', () => {
    const root = tabs({ seed: 'a1' });
    const [first] = byRole(root, 'tab');
    const [panel] = byRole(root, 'tabpanel');
    expect(propsOf(first)['aria-controls']).toBe(propsOf(panel).id);
    expect(propsOf(panel)['aria-labelledby']).toBe(propsOf(first).id);
  });

  it('uses the vertical keys when vertical', () => {
    const keys = behaviourOf(byRole(tabs({ seed: 'a1', orientation: 'vertical' }), 'tablist')[0]).on?.flatMap((trigger) => trigger.keys);
    expect(keys).toEqual(['ArrowDown', 'ArrowUp', 'Home', 'End']);
    expect(refusals(tabs({ seed: 'a1', orientation: 'vertical' }))).toEqual([]);
  });

  it('adding a tab derives what it generated and keeps what a person added', () => {
    const base = tabs({ seed: 'a1' });
    const [first] = byRole(base, 'tab');
    const edited = {
      ...base,
      children: base.children?.map((child) => (propsOf(child).role === 'tablist'
        ? { ...child, children: child.children?.map((tab) => (tab === first ? withMine(tab) : tab)) }
        : child)),
    };
    const after = addTab(edited, { title: 'Four', body: 'Four says' });
    const tabsAfter = byRole(after, 'tab');
    expect(tabsAfter).toHaveLength(4);
    expect(byRole(after, 'tabpanel')).toHaveLength(4);
    expect(refusals(after)).toEqual([]);
    expect(behaviourOf(tabsAfter[0]).on?.map((trigger) => trigger.id)).toEqual(['focus', 'click', 'mine']);
    expect(behaviourOf(after).state?.[0]).toMatchObject({ max: 3 });
    const fourth = behaviourOf(tabsAfter[3]);
    expect(fourth.bind?.[0]).toMatchObject({ from: { eq: [{ get: 'a1-active' }, 3] } });
    expect(propsOf(tabsAfter[3])['aria-controls']).toBe(propsOf(byRole(after, 'tabpanel')[3]).id);
    expect(new Set(nodes(after).map((node) => node.id)).size).toBe(nodes(after).length);
  });

  it('removing a tab renumbers what is left, moves the selection in range and keeps the last tab', () => {
    const three = tabs({ seed: 'a1' });
    const selected = withProps(three, { behaviour: { ...behaviourOf(three), state: [{ ...behaviourOf(three).state?.[0], initial: 2 }] } });
    const two = removeTab(selected, 0);
    expect(byRole(two, 'tabpanel').map((panel) => (behaviourOf(panel).showWhen as { eq: number }).eq)).toEqual([0, 1]);
    expect(behaviourOf(two).state?.[0]).toMatchObject({ initial: 1, max: 1 });
    expect(refusals(two)).toEqual([]);
    const one = removeTab(two, 1);
    expect(removeTab(one, 0)).toBe(one);
    expect(removeTab(two, 9)).toBe(two);
  });

  it('builds a Collection form that reads its index from the row', () => {
    const root = collectionTabs({ seed: 'a1', collection: 'c1', titleField: 'title', bodyField: 'body' });
    expect(refusals(root)).toEqual([]);
    const [template] = byRole(root, 'tab');
    expect(behaviourOf(template).on?.[0].do[0]).toEqual({ set: 'a1-active', value: { row: 'index' } });
    expect((behaviourOf(byRole(root, 'tabpanel')[0]) as StoredBehaviour).showWhen).toEqual({ state: 'a1-active', eq: { row: 'index' } });
  });
});

describe('carousel', () => {
  it('asks for no timer unless rotation was asked for', () => {
    expect(JSON.stringify(carousel({ seed: 'a1' }))).not.toContain('"every"');
    const rotating = carousel({ seed: 'a1', rotateMs: 5000 });
    expect(behaviourOf(rotating).on?.find((trigger) => trigger.on === 'every')?.ms).toBe(5000);
    expect(refusals(rotating)).toEqual([]);
  });

  it('adding a slide keeps rotation and numbers every slide', () => {
    const after = addSlide(carousel({ seed: 'a1', rotateMs: 5000 }), 'Fourth');
    const slides = nodes(after).filter((node) => propsOf(node)['aria-roledescription'] === 'slide');
    expect(slides.map((slide) => propsOf(slide)['aria-label'])).toEqual(['1 of 4', '2 of 4', '3 of 4', '4 of 4']);
    expect(behaviourOf(after).on?.find((trigger) => trigger.on === 'every')?.ms).toBe(5000);
    expect(behaviourOf(after).state?.[0]).toMatchObject({ max: 3 });
    expect(refusals(after)).toEqual([]);
  });
});
