// What the panel reads and writes of stored behaviour (src/lib/behaviour/authoring.ts):
// edits keep what they do not touch, the parser judges what a person entered, ids are
// fresh across the whole tree, and a trigger reads as a sentence.
import { describe, expect, it } from 'vitest';
import { DOM_EVENTS, type BehaviourNode } from '../format';
import {
  ALL_EVENTS,
  QUICK_EVENTS,
  describeCondition,
  describeTrigger,
  firstAction,
  freshStateId,
  freshStateName,
  freshTriggerId,
  keysFromText,
  optionsFromText,
  pickerLabels,
  putEntry,
  readersOf,
  refusalAt,
  refusalsOn,
  removeEntry,
  retype,
  stateNameRefusal,
  stateRefusal,
  statesInReach,
  storedBehaviourOf,
  withBehaviourAt,
} from '../authoring';

const node = (id: string, type: string, props: Record<string, unknown> = {}, ...children: BehaviourNode[]): BehaviourNode => ({ id, type, props, children });

const page = () => node('root', 'div', { behaviour: { state: [{ id: 'menu', name: 'Menu open', type: 'boolean', initial: false }] } },
  node('row', 'div', { behaviour: { state: [{ id: 'tab', name: 'Tab', type: 'number', initial: 0, min: 0, max: 3 }] } },
    node('button', 'button', { children: 'Go' })),
  node('drawer', 'nav', { children: 'Links' }));

describe('the event lists', () => {
  it('starts with the six a person reaches for, then names every other event the format takes', () => {
    expect(QUICK_EVENTS.map((e) => e.label)).toEqual(['Click', 'Mouse enter', 'Mouse leave', 'Focus', 'Keys', 'Appears']);
    for (const name of DOM_EVENTS) expect(QUICK_EVENTS.some((e) => e.on === name) || ALL_EVENTS.includes(name)).toBe(true);
    expect(ALL_EVENTS).toContain('page-ready');
    expect(ALL_EVENTS).not.toContain('click');
  });
});

describe('states in reach', () => {
  it('lists every value on the path, nearest last, with the node declaring it', () => {
    const reach = statesInReach([page()], 'button');
    expect(reach.map((r) => [r.state.id, r.state.type, r.scopeId, r.own])).toEqual([
      ['menu', 'boolean', 'root', false],
      ['tab', 'number', 'row', false],
    ]);
    expect(statesInReach([page()], 'drawer').map((r) => r.state.id)).toEqual(['menu']);
    expect(statesInReach([page()], 'nowhere')).toEqual([]);
  });

  it('leaves out a value the parser refuses', () => {
    const tree = node('root', 'div', { behaviour: { state: [{ id: 'menu', name: '', type: 'boolean', initial: false }] } });
    expect(statesInReach([tree], 'root')).toEqual([]);
  });
});

describe('fresh ids', () => {
  it('a state id is lower case and used by no node of the tree, not only the path', () => {
    // The first eight draws spell an id a row further down already holds; the next eight are free.
    const tree = node('root', 'div', {}, node('row', 'div', { behaviour: { state: [{ id: 'v-aaaaaaaa', name: 'Taken', type: 'boolean', initial: false }] } }));
    let calls = 0;
    const id = freshStateId([tree], () => (calls++ < 8 ? 0 : 0.5));
    expect(id).toBe('v-ssssssss');
    expect(calls).toBe(16);
  });

  it('a trigger id is new on its node', () => {
    const stored = { on: [{ id: 't-aaaaaaaa', on: 'click', do: [] }] };
    let calls = 0;
    const id = freshTriggerId(stored, () => (calls++ < 8 ? 0 : 0.99));
    expect(id).not.toBe('t-aaaaaaaa');
  });
});

describe('what a person entered goes through the parser', () => {
  it('refuses a value of a type that does not hold it, with the parser reason', () => {
    expect(stateRefusal({ id: 'v-1', name: 'Size', type: 'number', initial: 'big' })).toBe('a number starts at a number');
    expect(stateRefusal({ id: 'v-1', name: 'Size', type: 'choice', initial: 'xl', options: ['s', 'm'] })).toBe('initial is not one of the options');
    expect(stateRefusal({ id: 'v-1', name: '', type: 'boolean', initial: false })).toBe('a state needs a name');
    expect(stateRefusal({ id: 'v-1', name: 'Size', type: 'colour', initial: 'red' })).toBe('colour is not a state type');
    expect(stateRefusal({ id: 'v-1', name: 'Open', type: 'boolean', initial: true })).toBeNull();
  });

  it('refuses a trigger against the whole page: an action out of reach, a verb on the wrong event', () => {
    const roots = [page()];
    const toggleTab = { on: [{ id: 't1', on: 'click', do: [{ toggle: 'tab' }] }] };
    expect(refusalAt(roots, 'drawer', toggleTab)).toMatch(/tab/);
    const focusOnHover = { on: [{ id: 't1', on: 'mouseenter', do: [{ focus: 'button' }] }] };
    expect(refusalAt(roots, 'drawer', focusOnHover)).toMatch(/focus|press|click/i);
    const fine = { on: [{ id: 't1', on: 'click', do: [{ toggle: 'menu' }] }] };
    expect(refusalAt(roots, 'button', fine)).toBeNull();
    expect(refusalAt(roots, 'gone', fine)).toMatch(/no longer on the page/);
  });

  it('refuses a write that makes the parser refuse anything it took before, anywhere on the page', () => {
    // The page's 64 KB cap refuses whole behaviours, later nodes first. Text values of 4,096 characters fill it: 14 of them are under it.
    const text = (n: number) => ({ id: `v-${String(n).padStart(8, '0')}`, name: `T${n}`, type: 'text', initial: 'x'.repeat(4096) });
    const near = () =>
      node('root', 'div', {},
        node('a', 'div', {}),
        ...Array.from({ length: 7 }, (_, i) => node(`n${i}`, 'div', { behaviour: { state: [text(i * 10), text(i * 10 + 1)] } })),
        node('n7', 'button', { type: 'button' }));
    const roots = [near()];
    const twenty = { state: [text(90), text(91), text(92), text(93)] };
    // On the node itself: the whole behaviour of n7 would be refused.
    expect(refusalAt(roots, 'n7', twenty, twenty.state[3])).toMatch(/at most 65536 bytes/);
    // On an earlier node: n7 is fine, but a later node loses its behaviour, so it is refused and named.
    const reason = refusalAt(roots, 'a', twenty, twenty.state[3], (id) => `the element ${id}`);
    expect(reason).toMatch(/^it would stop the element n\d working: a page holds at most 65536 bytes/);
    // A small write that changes nothing else passes.
    expect(refusalAt(roots, 'n7', { on: [{ id: 't-ok', on: 'click', do: [{ emit: 'go' }] }] })).toBeNull();
  });

  it('refuses a value whose size takes the page root over the cap, which would cut its readers off', () => {
    const value = (n: number) => ({ id: `v-${String(n).padStart(8, '0')}`, name: `Text ${n}`, type: 'text', initial: 'y'.repeat(4096) });
    const tree = node('root', 'div', { behaviour: { state: [{ id: 'menu', name: 'Menu', type: 'boolean', initial: false }, ...Array.from({ length: 14 }, (_, i) => value(i))] } },
      node('button', 'button', { type: 'button', behaviour: { on: [{ id: 't1', on: 'click', do: [{ toggle: 'menu' }] }] } }),
      node('drawer', 'nav', { behaviour: { showWhen: { state: 'menu', eq: true } } }));
    const stored = (tree.props as { behaviour: { state: unknown[] } }).behaviour;
    // Each value alone is fine: the per-value check never saw the page.
    expect(stateRefusal(value(20))).toBeNull();
    const more = { ...stored, state: [...stored.state, value(20), value(21)] };
    expect(refusalAt([tree], 'root', more, value(21))).toMatch(/65536 bytes/);
  });

  it('refuses a value edit that breaks what reads it on another element, and names that element', () => {
    const read = withBehaviourAt(page(), 'drawer', { showWhen: { state: 'menu', eq: true } })!;
    const roots = [withBehaviourAt(read, 'button', { on: [{ id: 't1', on: 'click', do: [{ toggle: 'menu' }] }] })!];
    const menu = { id: 'menu', name: 'Menu open', type: 'number', initial: 0 };
    const root = roots[0].props as { behaviour: Record<string, unknown> };
    const retyped = { ...root.behaviour, state: [menu] };
    expect(refusalAt(roots, 'root', retyped, menu, (id) => `the element ${id}`)).toMatch(/^it would stop the element (button|drawer) working: /);
    // A rename changes nothing a reader needs.
    const renamed = { ...root.behaviour, state: [{ id: 'menu', name: 'Menu', type: 'boolean', initial: false }] };
    expect(refusalAt(roots, 'root', renamed, renamed.state[0])).toBeNull();
  });

  it('matches by what is refused, not by id: a duplicate id does not lend its refusal, and an unchanged refused entry is not saved again', () => {
    const roots = [page()];
    const good = { id: 't1', on: 'click', do: [{ toggle: 'menu' }] };
    const bad = { id: 't1', on: 'click', do: [{ toggle: 'tab' }] };
    const tree = withBehaviourAt(page(), 'drawer', { on: [good, bad] })!;
    // Saving the first again, unchanged: the second's refusal (same id) is old and not the first's.
    expect(refusalAt([tree], 'drawer', { on: [good, bad] }, good)).toBeNull();
    // Saving the refused one unchanged is still refused.
    expect(refusalAt([tree], 'drawer', { on: [good, bad] }, bad)).toMatch(/tab/);
    expect(roots).toHaveLength(1);
  });

  it('counts a refusal twice when it is there twice: a second copy of one already refused is new', () => {
    // Two identical triggers: the second is refused as a repeated id. A retype that breaks the
    // first refuses it too, with the same stored text, and that refusal is new.
    const trigger = { id: 't1', on: 'click', do: [{ toggle: 'menu' }] };
    const tree = withBehaviourAt(page(), 'button', { on: [trigger, trigger] })!;
    const menu = { id: 'menu', name: 'Menu open', type: 'number', initial: 0 };
    expect(refusalAt([tree], 'root', { state: [menu] }, menu, () => '"Go"')).toMatch(/^it would stop "Go" working: /);
  });

  it('names the elements whose behaviour reads a value, not the one declaring it', () => {
    const shown = withBehaviourAt(page(), 'drawer', { showWhen: { state: 'menu', eq: true } })!;
    const tree = withBehaviourAt(shown, 'button', { on: [{ id: 't1', on: 'click', do: [{ toggle: 'menu' }] }] })!;
    expect(readersOf([tree], 'menu')).toEqual(['button', 'drawer']);
    expect(readersOf([tree], 'tab')).toEqual([]);
  });

  it('counts a style rule whose when reads the value as a reader, on a node with no behaviour of its own', () => {
    const tree = node('root', 'div', { behaviour: { state: [{ id: 'menu', name: 'Menu open', type: 'boolean', initial: false }] } },
      node('panel', 'div', { rules: [{ id: 'r1', selector: '&', style: { color: 'red' }, when: { state: 'menu', eq: true } }] }));
    expect(readersOf([tree], 'menu')).toEqual(['panel']);
    expect(readersOf([tree], 'other')).toEqual([]);
  });

  it('reads a refusal already stored, by node', () => {
    const tree = withBehaviourAt(page(), 'drawer', { showWhen: { state: 'nothing', eq: true } })!;
    expect(refusalsOn([tree], 'drawer').map((r) => r.entry)).toEqual(['showWhen']);
  });
});

describe('edits keep what they do not touch', () => {
  it('replacing a trigger keeps the other entries and fields as stored, refused ones included', () => {
    const stored = { on: [{ id: 'a', on: 'click', do: [] }, 'not a trigger'], noScript: 'hide', unknown: 1 };
    const next = putEntry(stored, 'on', { id: 'a', on: 'keydown', keys: ['Enter'], do: [] }, 0);
    expect(next).toEqual({ on: [{ id: 'a', on: 'keydown', keys: ['Enter'], do: [] }, 'not a trigger'], noScript: 'hide', unknown: 1 });
    expect(removeEntry(next, 'on', 1).on).toHaveLength(1);
  });

  it('reads stored behaviour of any shape without throwing', () => {
    expect(storedBehaviourOf({})).toEqual({});
    expect(storedBehaviourOf({ behaviour: 'x' })).toBeNull();
    expect(storedBehaviourOf({ behaviour: { state: 'not a list' } })).toEqual({ state: 'not a list' });
  });

  it('a type change keeps id, name and the first value where the new type can hold it', () => {
    expect(retype({ id: 'v', name: 'Open', type: 'boolean', initial: true }, 'text')).toEqual({ id: 'v', name: 'Open', type: 'text', initial: 'true' });
    expect(retype({ id: 'v', name: 'Count', type: 'text', initial: '4' }, 'number')).toEqual({ id: 'v', name: 'Count', type: 'number', initial: 4 });
    expect(retype({ id: 'v', name: 'Size', type: 'number', initial: 2, min: 0 }, 'choice')).toEqual({ id: 'v', name: 'Size', type: 'choice', initial: '2', options: ['2', 'second'] });
    expect(retype({ id: 'v', name: 'X', type: 'text', initial: 'yes' }, 'boolean')).toEqual({ id: 'v', name: 'X', type: 'boolean', initial: false });
    for (const type of ['boolean', 'number', 'choice', 'text'] as const) {
      expect(stateRefusal(retype({ id: 'v', name: 'X', type: 'choice', initial: 'a', options: ['a'] }, type))).toBeNull();
    }
  });

  it('a text holding "second" becomes a choice the parser takes, its second option another name', () => {
    const choice = retype({ id: 'v', name: 'Step', type: 'text', initial: 'second' }, 'choice');
    expect(choice).toEqual({ id: 'v', name: 'Step', type: 'choice', initial: 'second', options: ['second', 'first'] });
    expect(stateRefusal(choice)).toBeNull();
  });

  it('a new value takes a name no value of the page holds, and a rename to one another holds is refused', () => {
    const tree = node('root', 'div', { behaviour: { state: [{ id: 'a', name: 'Value 1', type: 'boolean', initial: false }] } },
      node('card', 'div', { behaviour: { state: [{ id: 'b', name: 'value 2', type: 'boolean', initial: false }] } }));
    expect(freshStateName([tree])).toBe('Value 3');
    expect(stateNameRefusal([tree], 'b', ' VALUE 1 ')).toBe('another value on this page is called Value 1');
    expect(stateNameRefusal([tree], 'b', 'Value 2')).toBeNull();
    expect(stateNameRefusal([tree], 'b', 'Liked')).toBeNull();
  });

  it('a picker shows the id after a name two values share, and the name alone otherwise', () => {
    const labels = pickerLabels([{ id: 'a', name: 'Active tab' }, { id: 'b', name: 'Active tab' }, { id: 'c', name: 'Open' }]);
    expect([...labels.values()]).toEqual(['Active tab (a)', 'Active tab (b)', 'Open']);
  });

  it('reads options and keys as a person types them', () => {
    expect(optionsFromText(' small, medium ,, large ')).toEqual(['small', 'medium', 'large']);
    expect(keysFromText('Enter, Escape')).toEqual({ keys: ['Enter', 'Escape'] });
    expect(keysFromText('Enter, Return')).toEqual({ error: expect.stringContaining('Return is not a key') });
  });
});

describe('the words', () => {
  const names = { state: (id: string) => ({ menu: 'Menu open' }[id] ?? id), node: (id: string) => ({ drawer: 'Drawer' }[id] ?? id) };

  it('reads a trigger as a sentence', () => {
    expect(describeTrigger({ id: 't', on: 'click', do: [{ toggle: 'menu' }] }, names)).toBe('On click, toggle Menu open');
    expect(describeTrigger({ id: 't', on: 'keydown', keys: ['Escape'], do: [{ set: 'menu', value: false }, { focus: 'drawer' }] }, names))
      .toBe('On keys (Escape), set Menu open to false, then focus Drawer');
    expect(describeTrigger({ id: 't', on: 'view-enter', do: [{ dialog: 'drawer', op: 'showModal' }] }, names)).toBe('On appears, open as a modal Drawer');
    expect(describeTrigger('nonsense', names)).toBe('An entry that is not an interaction');
  });

  it('reads a condition', () => {
    expect(describeCondition({ all: [{ state: 'menu', eq: true }, { not: { state: 'tab', eq: 2 } }] }, names)).toBe('Menu open is true and not (tab is 2)');
  });

  it('a new interaction toggles an on or off value when there is one', () => {
    const states = statesInReach([page()], 'button').map((r) => r.state);
    expect(firstAction({ states, selfId: 'button' })).toEqual({ toggle: 'menu' });
    expect(firstAction({ states: states.filter((s) => s.type === 'number'), selfId: 'button' })).toEqual({ set: 'tab', value: 0 });
    expect(firstAction({ states: [], selfId: 'button' })).toEqual({ focus: 'button' });
  });
});
