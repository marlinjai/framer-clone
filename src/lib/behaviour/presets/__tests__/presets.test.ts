import { describe, expect, it } from 'vitest';
import { readBehaviourTree, type StoredBehaviour, type Trigger } from '@/lib/behaviour/format';
import { PRESETS, type PresetKind, type PresetNode } from '@/lib/behaviour/presets';
import { addSlide, carousel } from '@/lib/behaviour/presets/carousel';
import { addTab, collectionTabs, deriveTabs, removeTab, tabs } from '@/lib/behaviour/presets/tabs';
import { deriveToolbar } from '@/lib/behaviour/presets/toolbar';
import { deriveTooltip } from '@/lib/behaviour/presets/tooltip';
import { deriveCombobox } from '@/lib/behaviour/presets/combobox';
import { deriveMenuButton } from '@/lib/behaviour/presets/menu';
import { deriveMenubar, menubar } from '@/lib/behaviour/presets/menubar';
import { deriveMultithumb } from '@/lib/behaviour/presets/slider';
import { deriveSplitter } from '@/lib/behaviour/presets/splitter';
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
    ['menu-button', deriveMenuButton],
    ['menubar', deriveMenubar],
    ['combobox', deriveCombobox],
    ['slider-multithumb', deriveMultithumb],
    ['windowsplitter', deriveSplitter],
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

  it('refuses a rotation faster than the page would run', () => {
    expect(() => carousel({ seed: 'a1', rotateMs: 500 })).toThrow(/1000 ms/);
    expect(() => carousel({ seed: 'a1', rotateMs: Number.NaN })).toThrow();
  });

  it('finds its controls when a person put something else in the root', () => {
    const base = carousel({ seed: 'a1', rotateMs: 5000 });
    const heading = { id: 'a1-heading', type: 'h2', props: { children: 'Offers' } };
    const edited = addSlide({ ...base, children: [heading, ...(base.children ?? [])] }, 'Fourth');
    const buttons = nodes(edited).filter((node) => node.type === 'button');
    expect(buttons.map((button) => behaviourOf(button).on?.map((trigger) => trigger.id))).toEqual([['keep-focus', 'press'], ['press'], ['press']]);
    expect(behaviourOf(edited.children?.[0] as PresetNode)).toEqual({});
    expect(refusals(edited)).toEqual([]);
  });

  it('adding a slide keeps rotation and numbers every slide', () => {
    const after = addSlide(carousel({ seed: 'a1', rotateMs: 5000 }), 'Fourth');
    const slides = nodes(after).filter((node) => propsOf(node)['aria-roledescription'] === 'slide');
    expect(slides.map((slide) => propsOf(slide)['aria-label'])).toEqual(['1 of 4', '2 of 4', '3 of 4', '4 of 4']);
    expect(behaviourOf(after).on?.find((trigger) => trigger.on === 'every')?.ms).toBe(5000);
    expect(behaviourOf(after).state?.[0]).toMatchObject({ max: 3 });
    expect(refusals(after)).toEqual([]);
  });

  it('counts only slides, and leaves anything else in the slides container alone', () => {
    const base = carousel({ seed: 'a1' });
    const heading = { id: 'a1-note', type: 'h3', props: { children: 'Note' } };
    const slidesNode = base.children?.[1] as PresetNode;
    const edited = { ...base, children: [base.children?.[0] as PresetNode, { ...slidesNode, children: [...(slidesNode.children ?? []), heading] }] };
    const after = addSlide(edited, 'Fourth');
    const container = after.children?.[1] as PresetNode;
    const note = container.children?.find((child) => child.id === 'a1-note') as PresetNode;
    expect(behaviourOf(note)).toEqual({});
    expect(propsOf(note)['aria-label']).toBeUndefined();
    expect(behaviourOf(after).state?.[0]).toMatchObject({ max: 3 });
    const slides = container.children?.filter((child) => propsOf(child)['aria-roledescription'] === 'slide') ?? [];
    expect(slides.map((slide) => propsOf(slide)['aria-label'])).toEqual(['1 of 4', '2 of 4', '3 of 4', '4 of 4']);
  });

  it('does not take a timer a person added for the preset rotation', () => {
    const base = carousel({ seed: 'a1' });
    const own: Trigger = { id: 'own-timer', on: 'every', ms: 4000, do: [{ emit: 'tick' }] };
    const after = addSlide(withProps(base, { behaviour: { ...behaviourOf(base), on: [own] } }), 'Fourth');
    expect(behaviourOf(after).on?.map((trigger) => trigger.id)).toEqual(['own-timer']);
    expect(behaviourOf(after).state?.some((state) => state.id.endsWith('-playing'))).toBe(false);
  });

  it('gives a copied slide fresh DOM ids with its own references following', () => {
    const base = carousel({ seed: 'a1' });
    const slidesNode = base.children?.[1] as PresetNode;
    const [first, ...rest] = slidesNode.children ?? [];
    const title = { id: 'a1-slide-title', type: 'h3', props: { id: 'slide-title', children: 'Title' } };
    const slide = withProps({ ...(rest.at(-1) as PresetNode), children: [title] }, { 'aria-labelledby': 'slide-title' });
    const edited = { ...base, children: [base.children?.[0] as PresetNode, { ...slidesNode, children: [first, ...rest.slice(0, -1), slide] }] } as PresetNode;
    const after = addSlide(edited, 'Fourth');
    const copy = (after.children?.[1] as PresetNode).children?.at(-1) as PresetNode;
    const copiedTitle = copy.children?.[0] as PresetNode;
    expect(propsOf(copiedTitle).id).not.toBe('slide-title');
    expect(propsOf(copy)['aria-labelledby']).toBe(propsOf(copiedTitle).id);
  });
});

describe('menubar', () => {
  it('opens one menu at a time, as one number on the bar', () => {
    const root = menubar({ seed: 'a1' });
    expect(behaviourOf(root).state).toEqual([expect.objectContaining({ id: 'a1-open', type: 'number', initial: -1, min: -1, max: 1 })]);
    const menus = byRole(root, 'menu');
    expect(menus.map((menu) => behaviourOf(menu).showWhen)).toEqual([{ state: 'a1-open', eq: 0 }, { state: 'a1-open', eq: 1 }]);
  });

  it('keeps the bar\'s keys off the bar, so a key in a menu never reaches them', () => {
    const root = menubar({ seed: 'a1' });
    expect(behaviourOf(root).on).toBeUndefined();
    const [top] = byRole(root, 'menuitem');
    expect(behaviourOf(top).on?.map((trigger) => trigger.id)).toContain('next');
  });

  it('without a script leaves each menu a list of links in the flow', () => {
    for (const menu of byRole(menubar({ seed: 'a1' }), 'menu')) {
      expect(propsOf(menu).rules).toEqual([expect.objectContaining({ gate: 'off', style: expect.objectContaining({ position: 'static' }) })]);
    }
  });
});
