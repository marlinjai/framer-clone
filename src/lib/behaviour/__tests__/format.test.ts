// The behaviour format's trust boundary (docs/plans/2026-11-02-behaviour-model.md).
// Stored behaviour is untrusted: a page is opaque JSON to save and publish, so each
// refusal here is a security check, tested with the input that would exploit it.
import { describe, it, expect } from 'vitest';
import {
  DOM_EVENTS,
  MAX_ACTIONS_PER_TRIGGER,
  MAX_EXPRESSION_DEPTH,
  MAX_PROGRAM_BYTES,
  MAX_TRIGGERS_PER_NODE,
  MAX_TRIGGERS_PER_PAGE,
  compactBehaviour,
  isPrintableChord,
  keyOfChord,
  leavesSite,
  nodeFacts,
  parseBehaviour,
  parseCondition,
  readBehaviourTree,
  remapBehaviourRefs,
  staticValue,
  type BehaviourNode,
  type NodeFacts,
  type StateValue,
  type StoredBehaviour,
  type Trigger,
} from '../format';
import { STICKY_CTA_ATTR, STICKY_CTA_MARKER } from '@/lib/stickyCta/stickyCta';
import { htmlEventHandlers } from '../../../../test/score/lib/universe';

const bool = (id: string, initial = false): StateValue => ({ id, name: id, type: 'boolean', initial });
const num = (id: string, initial = 0, extra: object = {}): StateValue => ({ id, name: id, type: 'number', initial, ...extra });
const choice = (id: string, options = ['a', 'b']): StateValue => ({ id, name: id, type: 'choice', initial: options[0], options });
const text = (id: string, initial = ''): StateValue => ({ id, name: id, type: 'text', initial });

const STATES = new Map<string, StateValue>([
  ['b', bool('b')], ['on', bool('on', true)], ['n', num('n', 2, { min: 0, max: 10 })], ['c', choice('c')], ['t', text('t')],
]);

/** A page of the kinds of node an action can name. */
const div = (key: string): BehaviourNode => ({ id: key, type: 'div' });
const TARGETS: BehaviourNode[] = [
  div('box'),
  { id: 'dlg', type: 'dialog' },
  { id: 'det', type: 'details' },
  { id: 'vid', type: 'video' },
  { id: 'aud', type: 'audio' },
  { id: 'frm', type: 'form' },
  { id: 'field', type: 'input' },
  { id: 'grp', type: 'div', props: { behaviour: { group: { role: 'tab', axis: 'line' } } } },
  { id: 'isl-form', type: 'form', props: { 'data-form-kind': 'form' } },
  { id: 'isl-field', type: 'div', props: { 'data-form-kind': 'form-field', fieldType: 'email' } },
  { id: 'isl-cart', type: 'div', props: { 'data-component-kind': 'add-to-cart' } },
  { id: 'tx', type: '#text', props: { children: 'x' } },
  { id: 'scr', type: 'script' },
];
const NODES = new Map<string, NodeFacts>(TARGETS.map((node) => [node.id as string, nodeFacts(node)]));

/** The reasons a node's single trigger was refused, empty when it was accepted. */
function trigger(entry: unknown, node: BehaviourNode = { id: 'self', type: 'button' }): string[] {
  const read = parseBehaviour({ ...node, props: { ...(node.props as object), behaviour: { on: [entry] } } }, { states: STATES, nodes: NODES });
  return read.refused.map((r) => r.reason);
}
const click = (...actions: unknown[]) => ({ id: 't', on: 'click', do: actions });
const on = (event: string, ...actions: unknown[]) => ({ id: 't', on: event, do: actions });
const key = (keys: string[], ...actions: unknown[]) => ({ id: 't', on: 'keydown', keys, do: actions });
const accepted = (entry: unknown, node?: BehaviourNode) => expect(trigger(entry, node)).toEqual([]);
const refused = (entry: unknown, reason: RegExp, node?: BehaviourNode) => expect(trigger(entry, node).join(' | ')).toMatch(reason);

/** What a binding parses to on a node. */
function binding(entry: unknown, node: BehaviourNode = { id: 'self', type: 'div' }): string[] {
  const read = parseBehaviour({ ...node, props: { ...(node.props as object), behaviour: { bind: [entry] } } }, { states: STATES, nodes: NODES });
  return read.refused.map((r) => r.reason);
}

const textInput: BehaviourNode = { id: 'self', type: 'input' };
const passwordInput: BehaviourNode = { id: 'self', type: 'input', props: { type: 'password' } };
const range: BehaviourNode = { id: 'self', type: 'input', props: { type: 'range' } };

describe('the shape', () => {
  it('leaves a node without behaviour alone', () => {
    expect(parseBehaviour({ id: 'a', type: 'div', props: {} })).toEqual({ behaviour: null, refused: [] });
    expect(parseBehaviour({ id: 'a', type: 'div' })).toEqual({ behaviour: null, refused: [] });
  });

  it('reads the contract\'s accordion item, state on the parent, references in the children', () => {
    const tree = {
      id: 'item', type: 'div',
      props: { behaviour: { state: [{ id: 's1', name: 'open', type: 'boolean', initial: false }] } },
      children: [
        { id: 'btn', type: 'button', props: { children: 'Open', behaviour: {
          noScript: 'hide',
          on: [{ id: 't1', on: 'click', do: [{ toggle: 's1' }] }],
          bind: [{ attr: 'aria-expanded', from: { get: 's1' } }],
        } } },
        { id: 'panel', type: 'div', props: { behaviour: { showWhen: { state: 's1', eq: true } } } },
      ],
    };
    const read = readBehaviourTree(tree);
    expect(read.refused).toEqual([]);
    expect(read.behaviours.size).toBe(3);
    expect(read.behaviours.get(tree.children[0])).toEqual(tree.children[0].props.behaviour);
    expect(read.behaviours.get(tree.children[1])).toEqual({ showWhen: { state: 's1', eq: true } });
  });

  it.each([null, 1, 'x', [], true])('refuses %j whole', (stored) => {
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: stored } });
    expect(read.behaviour).toBeNull();
    expect(read.refused).toHaveLength(1);
  });

  it('refuses behaviour on what has no element', () => {
    for (const type of ['#text', 'script', 'SCRIPT', 'iframe', '', undefined]) {
      const read = parseBehaviour({ id: 'a', type, props: { behaviour: { state: [bool('x')] } } });
      expect(read.behaviour, String(type)).toBeNull();
      expect(read.refused[0].reason).toMatch(/no element/);
    }
  });

  it('never lets an unknown key through, at any level', () => {
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: {
      state: [bool('x')],
      onclick: 'alert(1)',
      on: [{ id: 't', on: 'click', do: [{ toggle: 'x' }], handler: 'alert(1)' }],
    } } });
    expect(read.behaviour).toEqual({ state: [bool('x')] });
    expect(read.refused.map((r) => r.entry).sort()).toEqual(['behaviour', 'on']);
  });

  it('is unmoved by a __proto__ or constructor key from JSON', () => {
    const stored = JSON.parse('{"__proto__":{"polluted":1},"state":[{"id":"x","name":"x","type":"boolean","initial":false,"__proto__":{"a":1}}]}');
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: stored } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(read.behaviour).toBeNull();
    expect(read.refused.map((r) => r.reason).join()).toMatch(/__proto__/);

    const map = JSON.parse('{"map":"c","cases":{"__proto__":1,"a":2},"default":3}');
    const parsed = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { bind: [{ cssVar: '--u-x', from: map }] } } }, { states: STATES });
    expect(parsed.refused).toEqual([]);
    const from = (parsed.behaviour?.bind?.[0] as { from: { cases: object } }).from;
    expect(Object.getPrototypeOf(from.cases)).toBe(Object.prototype);
    expect(Object.keys(from.cases)).toEqual(['__proto__', 'a']);
  });

  it('survives what has no JSON form', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(parseBehaviour({ id: 'a', type: 'div', props: { behaviour: cycle } }).refused[0].reason).toMatch(/JSON/);
    expect(parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { state: [BigInt(1)] } } }).refused[0].reason).toMatch(/JSON/);
  });

  it('fails an entry alone and keeps the rest', () => {
    const read = parseBehaviour({ id: 'a', type: 'button', props: { behaviour: {
      state: [bool('x')],
      on: [
        { id: 'ok', on: 'click', do: [{ toggle: 'x' }] },
        { id: 'gone', on: 'click', do: [{ toggle: 'deleted' }] },
      ],
      bind: [{ attr: 'onclick', from: true }, { attr: 'aria-pressed', from: { get: 'x' } }],
      showWhen: { state: 'deleted', eq: true },
    } } });
    expect(read.behaviour?.on?.map((t) => t.id)).toEqual(['ok']);
    expect(read.behaviour?.bind).toEqual([{ attr: 'aria-pressed', from: { get: 'x' } }]);
    expect(read.behaviour?.showWhen).toBeUndefined();
    expect(read.refused.map((r) => [r.entry, r.index])).toEqual([['on', 1], ['bind', 0], ['showWhen', undefined]]);
  });

  it('refuses a whole trigger when one of its actions fails, never leaving a hole', () => {
    refused(click({ toggle: 'b' }, { fetch: '/x' }, { toggle: 'b' }), /fetch is not an action/);
  });

  it('keeps preset marks and the preset root', () => {
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: {
      preset: { kind: 'tabs', version: 1 },
      state: [{ ...bool('x'), preset: true }],
      on: [{ id: 't', on: 'click', preset: true, do: [{ toggle: 'x' }] }],
      bind: [{ attr: 'aria-pressed', from: { get: 'x' }, preset: true }],
    } } });
    expect(read.refused).toEqual([]);
    expect(read.behaviour?.preset).toEqual({ kind: 'tabs', version: 1 });
    expect(read.behaviour?.state?.[0].preset).toBe(true);
    expect(read.behaviour?.on?.[0].preset).toBe(true);
    expect(read.behaviour?.bind?.[0].preset).toBe(true);
    for (const preset of [{ kind: 'x' }, { kind: 'x', version: 0 }, { kind: 'A B', version: 1 }, { kind: 'x', version: 1, code: 1 }, 'tabs']) {
      expect(parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { preset } } }).refused[0].entry).toBe('preset');
    }
    expect(parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { state: [{ ...bool('x'), preset: 'yes' }] } } }).refused).toHaveLength(1);
  });

  it('refuses noScript and group shapes it does not know', () => {
    const fail = (behaviour: unknown) => parseBehaviour({ id: 'a', type: 'div', props: { behaviour } }, { nodes: NODES }).refused.map((r) => r.entry);
    expect(fail({ noScript: 'maybe' })).toEqual(['noScript']);
    expect(fail({ group: { role: 'tab', axis: 'circle' } })).toEqual(['group']);
    expect(fail({ group: { role: 'x"]', axis: 'line' } })).toEqual(['group']);
    expect(fail({ group: { role: 'tab', axis: 'line', onkey: 'x' } })).toEqual(['group']);
    expect(fail({ group: { role: 'tab', axis: 'line', wrap: 'yes' } })).toEqual(['group']);
    expect(fail({ group: { role: 'option', axis: 'line', virtual: { owner: 'nobody' } } })).toEqual(['group']);
    expect(fail({ group: { role: 'option', axis: 'line', wrap: true, virtual: { owner: 'box' } } })).toEqual([]);
    expect(fail({ state: 'x', on: {}, bind: 1 })).toEqual(['state', 'on', 'bind']);
  });
});

describe('state values', () => {
  const states = (list: unknown[]) => parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { state: list } } });
  const reason = (entry: unknown) => states([entry]).refused.map((r) => r.reason).join();

  it('accepts each type', () => {
    const list = [bool('a'), num('b', 1, { min: 0, max: 2, step: 0.5 }), choice('c'), { ...text('d', 'hi'), maxLength: 5 }];
    expect(states(list)).toEqual({ behaviour: { state: list }, refused: [] });
  });

  it.each([
    ['uppercase id, which would collide in an attribute name', { ...bool('x'), id: 'Open' }],
    ['an id that ends an attribute', { ...bool('x'), id: 'a"b' }],
    ['a proto id', { ...bool('x'), id: '__proto__' }],
    ['no name', { id: 'x', type: 'boolean', initial: false }],
    ['a name with a control character', { ...bool('x'), name: 'a\nb' }],
    ['an unknown type', { id: 'x', name: 'x', type: 'date', initial: '' }],
    ['a boolean from a string', { ...bool('x'), initial: 'false' }],
    ['a boolean with options', { ...bool('x'), options: [] }],
    ['a numeric string', { ...num('x'), initial: '1' }],
    ['NaN', { ...num('x'), initial: NaN }],
    ['Infinity', { ...num('x'), initial: Infinity }],
    ['min above max', num('x', 1, { min: 5, max: 1 })],
    ['initial out of range', num('x', 9, { min: 0, max: 5 })],
    ['a zero step', num('x', 0, { step: 0 })],
    ['a negative step', num('x', 0, { step: -1 })],
    ['a string bound', num('x', 0, { max: '5' })],
    ['initial not an option', { ...choice('x'), initial: 'z' }],
    ['no options', { ...choice('x'), options: [] }],
    ['repeated options', { ...choice('x'), options: ['a', 'a'] }],
    ['options not strings', { ...choice('x'), options: ['a', 1] }],
    ['an option ending the selector', { ...choice('x', ['a"] {color:red}']) }],
    ['an option ending the style element', { ...choice('x', ['</style>']) }],
    ['an option with url(', { ...choice('x', ['url(//e.example)']) }],
    ['text over maxLength', { ...text('x', 'toolong'), maxLength: 3 }],
    ['a fractional maxLength', { ...text('x'), maxLength: 1.5 }],
    ['a text number', { ...text('x'), initial: 1 }],
  ])('refuses %s', (_label, entry) => {
    expect(reason(entry)).not.toBe('');
  });

  it('refuses a {{binding}} anywhere in an entry', () => {
    expect(reason({ ...text('x'), initial: '{{row.title}}' })).toMatch(/binding/);
    expect(reason({ ...bool('x'), name: '{{a}}' })).toMatch(/binding/);
    expect(trigger(click({ navigate: '/{{row.slug}}' })).join()).toMatch(/binding/);
    expect(binding({ text: '{{row.title}}' }, { id: 'self', type: 'p', props: { children: 'x' } }).join()).toMatch(/binding/);
  });

  it('refuses a repeat on the node and on the path', () => {
    expect(states([bool('x'), bool('x')]).refused[0].reason).toMatch(/twice/);
    const tree = {
      id: 'outer', type: 'div', props: { behaviour: { state: [bool('x')] } },
      children: [{ id: 'inner', type: 'div', props: { behaviour: { state: [num('x')] } } }],
    };
    const read = readBehaviourTree(tree);
    expect(read.refused[0]).toMatchObject({ nodeId: 'inner', entry: 'state' });
    expect(read.behaviours.has(tree.children[0])).toBe(false);
  });
});

describe('expressions', () => {
  const nested = (depth: number): unknown => (depth === 0 ? true : { not: nested(depth - 1) });
  const set = (value: unknown) => click({ set: 'b', value });
  const setNum = (value: unknown) => click({ set: 'n', value });

  it('takes the closed forms', () => {
    accepted(set({ eq: [{ get: 'c' }, 'a'] }));
    accepted(set({ and: [{ get: 'b' }, { or: [{ gt: [{ get: 'n' }, 1] }, { lt: [{ get: 'n' }, 1] }] }] }));
    accepted(setNum({ add: [{ get: 'n' }, 1] }));
    accepted(setNum({ clamp: [{ get: 'n' }, 0, 10] }));
    accepted(setNum({ map: 'c', cases: { a: 1, b: { get: 'n' } }, default: 0 }));
    accepted(setNum({ row: 'index' }));
    accepted(setNum({ pointer: 'x', of: 'box', as: 'percent' }));
    accepted(click({ set: 'c', value: { active: 'grp' } }));
  });

  it('holds the depth limit exactly', () => {
    accepted(set(nested(MAX_EXPRESSION_DEPTH)));
    refused(set(nested(MAX_EXPRESSION_DEPTH + 1)), /nests at most/);
  });

  it('refuses a chain deep enough to exhaust a stack, without overflowing', () => {
    let deep: unknown = true;
    for (let i = 0; i < 2000; i++) deep = { not: deep };
    refused(set(deep), /nests at most|too/);
  });

  it.each([
    ['a null', null],
    ['an array', [1]],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a string of code', { get: 'b', eval: '1' }],
    ['two operators', { eq: [1, 1], gt: [1, 0] }],
    ['an unknown operator', { call: 'alert' }],
    ['eq with one value', { eq: [1] }],
    ['eq with three', { eq: [1, 2, 3] }],
    ['an empty and', { and: [] }],
    ['and over a non list', { and: 'x' }],
    ['a read of nothing', { get: 'nope' }],
    ['an id that is not a string', { get: 1 }],
    ['an unknown event field', { event: 'target' }],
    ['a row field', { row: 'id' }],
    ['a pointer without a node', { pointer: 'x', of: 'nobody', as: 'px' }],
    ['a pointer axis', { pointer: 'z', of: 'box', as: 'px' }],
    ['active on a node with no group', { active: 'box' }],
    ['a map with no cases', { map: 'c', cases: {} }],
    ['a map of nothing', { map: 'nope', cases: { a: 1 } }],
    ['too long a literal', 'x'.repeat(1025)],
  ])('refuses %s', (_label, value) => {
    expect(trigger(click({ set: 'c', value })).length, _label).toBeGreaterThan(0);
  });

  it('refuses a number operator over text', () => {
    refused(setNum({ add: ['a', 'b'] }), /numbers/);
    refused(set({ gt: ['a', 1] }), /numbers/);
    refused(setNum({ clamp: [{ get: 'c' }, 0, 1] }), /numbers/);
  });

  it('checks every value a set can write into a choice against its options', () => {
    const states = new Map([...STATES, ['sub', choice('sub', ['a'])], ['wide', choice('wide', ['a', 'z'])]]);
    const reasons = (value: unknown) =>
      parseBehaviour(
        { id: 'self', type: 'button', props: { behaviour: { on: [click({ set: 'c', value })] } } },
        { states, nodes: NODES },
      ).refused.map((r) => r.reason);
    expect(reasons({ map: 'b', cases: { true: 'a', false: 'b' }, default: 'a' })).toEqual([]);
    expect(reasons({ get: 'sub' })).toEqual([]);
    expect(reasons({ map: 'b', cases: { true: 'zzz' } }).join()).toMatch(/not an option/);
    expect(reasons({ map: 'b', cases: { true: 'a' }, default: 'zzz' }).join()).toMatch(/not an option/);
    expect(reasons({ map: 'b', cases: { true: { map: 'b', cases: { true: 'zzz' } } } }).join()).toMatch(/not an option/);
    expect(reasons({ get: 'wide' }).join()).toMatch(/not an option/);
    expect(reasons({ map: 'b', cases: { true: 1 } }).join()).toMatch(/does not hold/);
  });

  it('checks a set against the state it writes', () => {
    refused(click({ set: 'b', value: 1 }), /does not hold a number/);
    refused(click({ set: 'n', value: 'x' }), /does not hold a string/);
    refused(click({ set: 'c', value: 'z' }), /not an option/);
    accepted(click({ set: 't', value: 'x' }));
    refused(click({ set: 't', value: 1 }), /does not hold a number/);
  });

  it('reads an event field only from the event that has it', () => {
    accepted(on('toggle', { set: 'b', value: { eq: [{ event: 'newState' }, 'open'] } }));
    accepted(on('beforetoggle', { set: 'b', value: { eq: [{ event: 'newState' }, 'open'] } }));
    refused(click({ set: 'b', value: { eq: [{ event: 'newState' }, 'open'] } }), /no newState/);
    refused(click({ set: 't', value: { event: 'key' } }), /no key/);
    refused({ ...on('every', { set: 't', value: { event: 'value' } }), ms: 1000 }, /no value/);
    refused(on('page-ready', { set: 'n', value: { pointer: 'x', of: 'box', as: 'px' } }), /no pointer/);
  });
});

describe('the taint rule', () => {
  const clean = /typed text/;

  it('lets typed text into its three sinks', () => {
    accepted(on('input', { set: 't', value: { event: 'value' } }), textInput);
    accepted(on('input', { filter: 'box', role: 'option', text: { event: 'value' } }), textInput);
    accepted(on('input', { filter: 'box', role: 'option', text: { get: 't' } }));
    accepted({ id: 't', on: 'keydown', keys: ['Printable'], do: [{ set: 't', value: { event: 'key' } }] });
    expect(binding({ text: { get: 't' } }, { id: 'self', type: 'p', props: { children: 'x' } })).toEqual([]);
  });

  it.each([
    ['`if` reading text state', { ...on('click', { toggle: 'b' }), if: { get: 't' } }],
    ['`if` as a condition on text state', { ...on('click', { toggle: 'b' }), if: { state: 't', eq: 'hunter2' } }],
    ['`if` reading the key', { ...on('keydown', { toggle: 'b' }), keys: ['Enter'], if: { eq: [{ event: 'key' }, 'Enter'] } }],
    ['`if` under a not', { ...on('click', { toggle: 'b' }), if: { not: { eq: [{ get: 't' }, 'x'] } } }],
    ['`if` as a condition under not', { ...on('click', { toggle: 'b' }), if: { not: { state: 't', eq: 'x' } } }],
    ['set boolean from a comparison', click({ set: 'b', value: { eq: [{ get: 't' }, 'hunter2'] } })],
    ['set boolean, deep in `and`', click({ set: 'b', value: { and: [true, { or: [false, { eq: [{ get: 't' }, 'x'] }] }] } })],
    ['set choice from a map of text', click({ set: 'c', value: { map: 't', cases: { hunter2: 'a' }, default: 'b' } })],
    ['a tainted case in a clean map', click({ set: 'c', value: { map: 'c', cases: { a: { get: 't' } } } })],
    ['a tainted default in a clean map', click({ set: 'c', value: { map: 'c', cases: { a: 'a' }, default: { get: 't' } } })],
    ['setProp from text', click({ setProp: 'field', prop: 'value', value: { get: 't' } })],
    ['media value from text', click({ media: 'vid', op: 'seek', value: { get: 't' } })],
  ])('refuses %s', (_label, entry) => {
    refused(entry, clean);
  });

  it('refuses the value of a text field in every derived form', () => {
    const value = { event: 'value' };
    refused(on('input', { set: 'b', value: { eq: [value, 'hunter2'] } }), clean, textInput);
    refused(on('input', { set: 'n', value: { clamp: [value, 0, 1] } }), clean, textInput);
    refused(on('input', { setProp: 'field', prop: 'value', value }), clean, passwordInput);
    refused({ ...on('input', { toggle: 'b' }), if: value }, clean, passwordInput);
  });

  it('treats the value of any other element as typed, failing closed', () => {
    for (const node of [{ id: 'self', type: 'div' }, { id: 'self', type: 'textarea' }, { id: 'self', type: 'input', props: { type: 'search' } }]) {
      refused(on('change', { set: 'c', value: { event: 'value' } }), clean, node);
    }
  });

  it('exempts a value that is a choice among fixed values', () => {
    const value = { clamp: [{ event: 'value' }, 0, { get: 'n' }] };
    accepted(on('input', { set: 'n', value }), range);
    accepted(on('change', { set: 'c', value: { event: 'value' } }), { id: 'self', type: 'select' });
    accepted(on('change', { set: 'b', value: { eq: [{ event: 'value' }, 'x'] } }), { id: 'self', type: 'input', props: { type: 'checkbox' } });
    accepted(on('change', { set: 'c', value: { event: 'value' } }), { id: 'self', type: 'input', props: { type: 'RADIO' } });
    accepted(on('input', { setProp: 'field', prop: 'value', value: { get: 'n' } }), range);
  });

  it('is not fooled about what the element really is', () => {
    const asBrowser = on('input', { set: 'n', value: { event: 'value' } });
    // The Kelvin sign lowers to k in JavaScript, and a browser reads this as a text input.
    refused(asBrowser, clean, { id: 'self', type: 'input', props: { type: 'checKbox' } });
    // A browser keeps the first of two spellings, which the parser cannot see through a renderer.
    refused(asBrowser, clean, { id: 'self', type: 'input', props: { TYPE: 'text', type: 'range' } });
    refused(asBrowser, clean, { id: 'self', type: 'input', props: { type: 'range', TYPE: 'text' } });
    refused(asBrowser, clean, { id: 'self', type: 'input', props: { type: ['range'] } });
    refused(asBrowser, clean, { id: 'self', type: 'input', props: { type: { base: 'range', 'bp-p': 'text' } } });
    refused(asBrowser, clean, { id: 'self', type: 'input', props: { type: ' range' } });
  });

  it('never gets text state into a number, tainted or not', () => {
    refused(click({ set: 'n', value: { clamp: [{ get: 't' }, 0, 1] } }), /numbers/);
    refused(click({ set: 'n', value: { map: 't', cases: { hunter2: 1 }, default: 0 } }), clean);
  });

  it('applies to bindings and showWhen', () => {
    for (const entry of [
      { attr: 'aria-label', from: { get: 't' } },
      { attr: 'data-u-x', from: { eq: [{ get: 't' }, 'x'] } },
      { cssVar: '--u-x', from: { map: 't', cases: { hunter2: 1 }, default: 0 } },
    ]) expect(binding(entry).join()).toMatch(clean);
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { showWhen: { state: 't', eq: 'x' } } } }, { states: STATES });
    expect(read.refused[0].reason).toMatch(clean);
  });

  it('closes the route out of a text binding through an active item', () => {
    const tree = {
      id: 'root', type: 'div', props: { behaviour: { state: [text('typed')] } },
      children: [{
        id: 'list', type: 'ul', props: { behaviour: { group: { role: 'option', axis: 'line' } } },
        children: [{ id: 'opt', type: 'li', props: { children: '', behaviour: { bind: [{ text: { get: 'typed' } }] } } }],
      }],
    };
    expect(readBehaviourTree(tree).refused[0].reason).toMatch(/active item/);
  });

  it('holds a `when` to the same rule, with no row', () => {
    expect(parseCondition({ state: 't', eq: 'x' }, { states: STATES })).toMatchObject({ ok: false });
    expect(parseCondition({ state: 'n', eq: { row: 'index' } }, { states: STATES })).toMatchObject({ ok: false });
    expect(parseCondition({ all: [{ state: 'b', eq: true }, { not: { state: 'c', eq: 'a' } }] }, { states: STATES })).toMatchObject({ ok: true });
  });
});

describe('keys', () => {
  it('reads the chord grammar', () => {
    for (const chord of ['ArrowRight', 'InlineEnd', 'Ctrl+End', 'Shift+Tab', 'Printable', 'a', '+', 'Ctrl++', 'ß', '\u{1F600}']) {
      expect(keyOfChord(chord), chord).not.toBeNull();
    }
    for (const chord of ['', 'arrowright', 'ctrl+a', 'Ctrl+Printable', 'Enter ', '\t', ' ', 'ab', 'Super+a', 1, null]) {
      expect(keyOfChord(chord), String(chord)).toBeNull();
    }
    for (const chord of ['a', 'Space', 'Printable', 'Ctrl+a', 'Shift+Space', '\u{1F600}']) expect(isPrintableChord(chord), chord).toBe(true);
    for (const chord of ['Enter', 'Escape', 'Ctrl+End', 'Tab', 'ArrowDown']) expect(isPrintableChord(chord), chord).toBe(false);
  });

  it('never lets a printable key match on a text entry control', () => {
    const entries = [textInput, passwordInput, { id: 'self', type: 'textarea' }, { id: 'self', type: 'INPUT' }, { id: 'self', type: 'div', props: { contentEditable: true } }, { id: 'self', type: 'div', props: { contenteditable: 'plaintext-only' } }];
    for (const node of entries) {
      for (const keys of [['a'], ['Printable'], ['Space'], ['Shift+a'], ['ArrowDown', 'a']]) {
        refused(key(keys, { set: 'c', value: 'a' }), /printable/, node);
      }
      refused(on('keydown', { toggle: 'b' }), /printable/, node);
      refused(on('keyup', { toggle: 'b' }), /printable/, node);
    }
  });

  it('keeps named keys on a text entry, which combobox needs', () => {
    accepted(key(['ArrowDown'], { set: 'b', value: true }), textInput);
    accepted({ ...key(['Enter'], { setProp: 'field', prop: 'value', value: { active: 'grp' } }), if: { get: 'b' }, prevent: true }, textInput);
    accepted(key(['Escape'], { set: 'b', value: false }), textInput);
  });

  it('refuses every printable key and every unfiltered listener at document scope', () => {
    const document = (keys?: string[]) => ({ id: 't', on: 'keydown', scope: 'document', ...(keys ? { keys } : {}), do: [{ toggle: 'b' }] });
    accepted(document(['Escape']));
    refused(document(['a']), /non-printable/);
    refused(document(['Printable']), /non-printable/);
    refused(document(['Space']), /non-printable/);
    refused(document(['Escape', 'a']), /non-printable/);
    refused(document(), /non-printable/);
  });

  it('refuses bad keys', () => {
    refused(key([], { toggle: 'b' }), /list of/);
    refused({ ...on('keydown', { toggle: 'b' }), keys: 'Enter' }, /list of/);
    refused(key(['NotAKey'], { toggle: 'b' }), /not a key/);
    refused({ ...on('click', { toggle: 'b' }), keys: ['Enter'] }, /keydown/);
    refused(key(Array.from({ length: 33 }, () => 'Enter'), { toggle: 'b' }), /list of/);
  });
});

describe('triggers', () => {
  it('knows the 100 event rows of the contract and refuses the rest', () => {
    const rows = htmlEventHandlers().filter((entry) => !entry.excluded).map((entry) => entry.id.slice(2));
    expect(rows).toHaveLength(100);
    for (const name of rows) expect(DOM_EVENTS.has(name), name).toBe(true);
    expect(DOM_EVENTS.size).toBe(102);
    for (const name of ['onclick', 'Click', 'CLICK', 'keypress', 'beforeunload', 'message', 'hashchange', 'visibilitychange', 'custom:', 'custom:A', 'custom:a b', '__proto__', '']) {
      refused(on(name, { toggle: 'b' }), /not an event/);
    }
    refused(on(1 as never, { toggle: 'b' }), /event name/);
  });

  it('takes the pseudo events', () => {
    for (const name of ['view-enter', 'view-leave', 'page-ready', 'custom:open-menu']) accepted(on(name, { toggle: 'b' }));
    accepted({ ...on('every', { step: 'n', wrap: true }), ms: 1000 });
  });

  it('holds `every` to its floor and a timer to what a browser can count', () => {
    refused({ ...on('every', { toggle: 'b' }), ms: 999 }, /at least 1000/);
    refused(on('every', { toggle: 'b' }), /at least 1000/);
    refused({ ...on('every', { toggle: 'b' }), ms: '1000' }, /at least 1000/);
    refused({ ...on('every', { toggle: 'b' }), ms: 2 ** 31 }, /at least 1000/);
    refused({ ...on('click', { toggle: 'b' }), ms: 1000 }, /ms belongs/);
  });

  it('refuses a bad head', () => {
    refused({ id: 'a b', on: 'click', do: [{ toggle: 'b' }] }, /short id/);
    refused({ on: 'click', do: [{ toggle: 'b' }] }, /holds id/);
    refused({ id: 't', on: 'click' }, /holds id/);
    refused({ id: 't', on: 'click', do: [] }, /list of actions/);
    refused({ id: 't', on: 'click', do: {} }, /list of actions/);
    refused({ ...on('click', { toggle: 'b' }), scope: 'window' }, /scope is document/);
    refused({ ...on('every', { toggle: 'b' }), ms: 1000, scope: 'document' }, /not a document event/);
    refused({ ...on('click', { toggle: 'b' }), preset: 1 }, /preset/);
  });

  it('holds the caps on a node', () => {
    const list = Array.from({ length: MAX_TRIGGERS_PER_NODE + 2 }, (_, i) => ({ id: `t${i}`, on: 'click', do: [{ toggle: 'b' }] }));
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { on: list } } }, { states: STATES });
    expect(read.behaviour?.on).toHaveLength(MAX_TRIGGERS_PER_NODE);
    expect(read.refused.map((r) => r.index)).toEqual([MAX_TRIGGERS_PER_NODE, MAX_TRIGGERS_PER_NODE + 1]);
    const twice = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { on: [list[0], list[0]] } } }, { states: STATES });
    expect(twice.refused[0].reason).toMatch(/same id/);

    const many = Array.from({ length: MAX_ACTIONS_PER_TRIGGER }, () => ({ toggle: 'b' }));
    accepted(click(...many));
    refused(click(...many, { toggle: 'b' }), /at most 16/);
    refused(click(...many.slice(1), { delay: 16, do: [{ toggle: 'b' }] }), /at most 16/);
  });

  it('refuses a program over the size limit whole', () => {
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { state: [{ ...text('x'), name: 'x'.repeat(MAX_PROGRAM_BYTES) }] } } });
    expect(read.refused[0].entry).toBe('behaviour');
  });

  it('holds a chain of delays to the action cap, without recursing past it', () => {
    let deep: unknown = { toggle: 'b' };
    for (let i = 0; i < 300; i++) deep = { delay: 16, do: [deep] };
    refused(click(deep), /at most 16/);
  });

  it('refuses a program nested too deep to serialize whole, without throwing', () => {
    let deep: unknown = { toggle: 'b' };
    for (let i = 0; i < 100_000; i++) deep = { delay: 16, do: [deep] };
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { on: [click(deep)] } } });
    expect(read.behaviour).toBeNull();
    expect(read.refused[0].entry).toBe('behaviour');
  });
});

describe('prevent', () => {
  it('refuses what would hold the keyboard or a dialog', () => {
    refused({ ...on('cancel', { toggle: 'b' }), prevent: true }, /cancel/);
    refused({ ...key(['Tab'], { toggle: 'b' }), prevent: true }, /Tab/);
    refused({ ...key(['Shift+Tab'], { toggle: 'b' }), prevent: true }, /Tab/);
    refused({ ...key(['Ctrl+Alt+Tab'], { toggle: 'b' }), prevent: true }, /Tab/);
    refused({ ...key(['Enter', 'Tab'], { toggle: 'b' }), prevent: true }, /Tab/);
    refused({ ...key(['Escape'], { toggle: 'b' }), prevent: true }, /Escape/);
    refused({ ...on('keydown', { toggle: 'b' }), prevent: true }, /needs keys/);
  });

  it('refuses a false shape, and what has no default', () => {
    refused({ ...click({ toggle: 'b' }), prevent: 'true' }, /true or false/);
    refused({ ...on('page-ready', { toggle: 'b' }), prevent: true }, /no default/);
    refused({ ...on('custom:x', { toggle: 'b' }), prevent: true }, /no default/);
  });

  it('allows it on a filtered key and a press', () => {
    accepted({ ...key(['ArrowDown'], { toggle: 'b' }), prevent: true });
    accepted({ ...click({ toggle: 'b' }), prevent: true });
  });
});

describe('navigate', () => {
  it('takes a press and a safe literal', () => {
    for (const href of ['/about', '#top', 'https://example.com/a', 'mailto:a@example.com', 'tel:+41']) accepted(click({ navigate: href }));
    accepted(on('submit', { navigate: '/x' }));
    accepted(key(['Enter'], { navigate: '/x' }));
    accepted(key(['Enter', 'Space'], { navigate: '/x' }));
  });

  it.each([
    ['javascript:alert(1)'], ['JaVaScRiPt:alert(1)'], ['data:text/html,x'], ['vbscript:x'], ['//evil.example'], ['/\\evil.example'],
    ['\\\\evil.example'], [' javascript:alert(1)'], ['/a\nb'], ['java\tscript:x'], [' /about'], ['ftp://x'], [''], [1], [{ get: 'c' }], [null],
  ])('refuses the address %j', (href) => {
    refused(click({ navigate: href }), /address/);
  });

  it.each(['page-ready', 'every', 'view-enter', 'custom:x', 'mouseenter', 'focus', 'keyup', 'pointerdown', 'blur', 'input'])(
    'refuses it from %s',
    (event) => {
      refused({ ...on(event, { navigate: '/x' }), ...(event === 'every' ? { ms: 1000 } : {}) }, /runs only from/);
    },
  );

  it('refuses a key other than Enter or Space, an unfiltered key, and any waiting', () => {
    refused(key(['a'], { navigate: '/x' }), /runs only from/);
    refused(key(['Enter', 'a'], { navigate: '/x' }), /runs only from/);
    refused(key(['Shift+Enter'], { navigate: '/x' }), /runs only from/);
    refused(on('keydown', { navigate: '/x' }), /runs only from/);
    refused(click({ delay: 16, do: [{ navigate: '/x' }] }), /cannot wait/);
    refused(click({ delay: 16, do: [{ delay: 16, do: [{ navigate: '/x' }] }] }), /cannot wait/);
  });

  it('tells an address that leaves the site', () => {
    expect([leavesSite('/a'), leavesSite('#a'), leavesSite('https://a.example'), leavesSite('mailto:a@b'), leavesSite('//a')]).toEqual([false, false, true, true, true]);
  });
});

describe('focus verbs', () => {
  const moves = [{ focus: 'box' }, { rove: 'grp', move: 'next' }, { dialog: 'dlg', op: 'showModal' }, { dialog: 'dlg', op: 'show' }];

  it('run from a press', () => {
    for (const action of moves) {
      accepted(click(action));
      accepted(key(['ArrowDown'], action));
      accepted({ id: 't', on: 'keyup', keys: ['Enter'], do: [action] });
      accepted(click({ delay: 16, do: [action] }));
    }
  });

  it.each(['every', 'custom:x', 'focus', 'focusin', 'mouseenter', 'pointerdown', 'toggle', 'input', 'scroll', 'load', 'transitionend'])(
    'refuse %s',
    (event) => {
      for (const action of moves.slice(0, 2)) {
        refused({ ...on(event, action), ...(event === 'every' ? { ms: 1000 } : {}) }, /only from a press/);
      }
    },
  );

  it('are refused in blur and focusout, directly and under delay', () => {
    for (const event of ['blur', 'focusout']) {
      for (const action of moves) {
        refused(on(event, action), /could hold focus/);
        refused(on(event, { delay: 16, do: [action] }), /could hold focus/);
        refused(on(event, { delay: 16, do: [{ delay: 16, do: [action] }] }), /could hold focus/);
      }
      refused(on(event, { rove: 'grp', move: 'clear' }), /could hold focus/);
    }
  });

  it('are refused from anything that answers Tab, which `prevent` alone does not catch', () => {
    for (const action of moves) {
      refused({ id: 't', on: 'keyup', keys: ['Tab'], do: [action] }, /answering Tab/);
      refused({ id: 't', on: 'keyup', keys: ['Tab'], scope: 'document', do: [{ delay: 16, do: [action] }] }, /answering Tab/);
      refused(key(['Shift+Tab'], action), /answering Tab/);
      refused(on('keyup', action), /answering Tab/);
      refused(on('keydown', action), /answering Tab/);
    }
  });

  it('let showModal alone run on arrival', () => {
    accepted(on('page-ready', { dialog: 'dlg', op: 'showModal' }));
    accepted(on('view-enter', { dialog: 'dlg', op: 'showModal' }));
    refused(on('page-ready', { dialog: 'dlg', op: 'show' }), /only from a press/);
    refused(on('page-ready', { focus: 'box' }), /only from a press/);
    refused({ ...on('every', { dialog: 'dlg', op: 'showModal' }), ms: 1000 }, /only from a press/);
    refused(on('view-leave', { dialog: 'dlg', op: 'showModal' }), /only from a press/);
  });

  it('let `rove: clear` run as a person types, since it moves no focus', () => {
    accepted(on('input', { rove: 'grp', move: 'clear' }), textInput);
  });

  it('need keys for typeahead', () => {
    accepted(key(['Printable'], { rove: 'grp', move: 'type' }));
    refused(click({ rove: 'grp', move: 'type' }), /typeahead/);
  });
});

describe('the family rule', () => {
  const cases: [string, unknown, string[]][] = [
    ['popover', { popover: 'box', op: 'toggle' }, ['toggle', 'beforetoggle', 'close', 'cancel']],
    ['details', { details: 'det', op: 'toggle' }, ['toggle', 'beforetoggle', 'close', 'cancel']],
    ['dialog', { dialog: 'dlg', op: 'close' }, ['toggle', 'beforetoggle', 'close', 'cancel']],
    ['media', { media: 'vid', op: 'play' }, ['play', 'pause', 'ended', 'timeupdate', 'volumechange', 'seeked', 'ratechange']],
    ['fullscreen', { fullscreen: 'box', op: 'enter' }, ['fullscreenchange']],
    ['pictureInPicture', { pictureInPicture: 'vid', op: 'enter' }, ['enterpictureinpicture', 'leavepictureinpicture']],
    ['scroll', { scroll: 'box' }, ['scroll', 'scrollend']],
    ['form', { form: 'frm', op: 'reset' }, ['reset']],
  ];

  it.each(cases)('refuses %s in the events it causes, directly and under delay', (_verb, action, events) => {
    for (const event of events) {
      refused(on(event, action), /cause its own event/);
      refused(on(event, { delay: 16, do: [action] }), /cause its own event/);
    }
    accepted(click(action));
  });

  it('leaves a state write in those events, which is how native state follows', () => {
    accepted(on('toggle', { set: 'b', value: { eq: [{ event: 'newState' }, 'open'] } }));
    accepted(on('close', { set: 'b', value: false }));
  });
});

describe('actions', () => {
  it('reads every verb of the list with its fixed keys', () => {
    const list: unknown[] = [
      { set: 'b', value: true }, { toggle: 'b' }, { step: 'n', by: -5 }, { step: 'c', wrap: true },
      { dialog: 'dlg', op: 'close' }, { popover: 'box', op: 'hide' }, { details: 'det', op: 'open' },
      { media: 'vid', op: 'play' }, { media: 'aud', op: 'volume', value: 0.5 }, { fullscreen: 'box', op: 'leave' },
      { pictureInPicture: 'vid', op: 'leave' }, { scroll: 'box', block: 'center' }, { form: 'frm', op: 'reset' },
      { setProp: 'field', prop: 'value', value: 'x' }, { filter: 'box', role: 'option', text: 'x' },
    ];
    for (const action of list) expect(trigger(click(action)), JSON.stringify(action)).toEqual([]);
    const read = parseBehaviour(
      { id: 'self', type: 'button', props: { behaviour: { on: [click({ delay: 40, key: 'tip', do: [{ cancel: 'tip' }, { emit: 'x' }, { effect: 'box' }] })] } } },
      { states: STATES, nodes: NODES },
    );
    expect(read.refused).toEqual([]);
    expect(read.behaviour?.on?.[0].do).toEqual([{ delay: 40, key: 'tip', do: [{ cancel: 'tip' }, { emit: 'x' }, { effect: 'box' }] }]);
    accepted(on('pointerdown', { capturePointer: true }));
  });

  it.each([
    ['submit by any name', { form: 'frm', op: 'requestSubmit' }],
    ['submit', { form: 'frm', op: 'submit' }],
    ['no op on form', { form: 'frm' }],
    ['click', { click: 'box' }],
    ['fetch', { fetch: 'https://e.example' }],
    ['innerHTML', { innerHTML: 'box', value: '<img>' }],
    ['setAttribute', { setAttribute: 'box', name: 'onclick', value: 'x' }],
    ['eval', { eval: '1' }],
    ['the prototype\'s prevent verb', { prevent: true }],
    ['the prototype\'s mark verb', { mark: 1 }],
    ['no verb', {}],
    ['a list', []],
    ['a string', 'toggle'],
    ['two verbs', { toggle: 'b', navigate: '/x' }],
    ['a verb with a smuggled key', { toggle: 'b', then: { fetch: '/x' } }],
    ['toggle on a number', { toggle: 'n' }],
    ['toggle on nothing', { toggle: 'nope' }],
    ['step on a boolean', { step: 'b' }],
    ['step on text', { step: 't' }],
    ['step by 0', { step: 'n', by: 0 }],
    ['step by a string', { step: 'n', by: '1' }],
    ['a set with no value', { set: 'b' }],
    ['a dialog op of popover', { dialog: 'dlg', op: 'hide' }],
    ['a dialog on a div', { dialog: 'box', op: 'close' }],
    ['details on a div', { details: 'box', op: 'open' }],
    ['media on a div', { media: 'box', op: 'play' }],
    ['picture in picture on audio', { pictureInPicture: 'aud', op: 'enter' }],
    ['a media op that is not one', { media: 'vid', op: 'src' }],
    ['a media value it does not take', { media: 'vid', op: 'play', value: 1 }],
    ['a media seek to text', { media: 'vid', op: 'seek', value: 'x' }],
    ['a media seek with no value', { media: 'vid', op: 'seek' }],
    ['capturePointer off pointerdown', { capturePointer: true }],
    ['a scroll block', { scroll: 'box', block: 'top' }],
    ['a form that is not one', { form: 'box', op: 'reset' }],
    ['href by setProp', { setProp: 'field', prop: 'href', value: '/x' }],
    ['a prop with a case trick', { setProp: 'field', prop: 'Value', value: 'x' }],
    ['a filter role that ends its selector', { filter: 'box', role: 'x"]', text: 'x' }],
    ['a delay under the floor', { delay: 15, do: [{ toggle: 'b' }] }],
    ['a delay over the ceiling', { delay: 10_001, do: [{ toggle: 'b' }] }],
    ['a delay in a string', { delay: '16', do: [{ toggle: 'b' }] }],
    ['a delay of NaN', { delay: NaN, do: [{ toggle: 'b' }] }],
    ['a delay with nothing', { delay: 16, do: [] }],
    ['a bad delay key', { delay: 16, key: 'A B', do: [{ toggle: 'b' }] }],
    ['a bad emit name', { emit: 'custom:x' }],
    ['a bad cancel', { cancel: 1 }],
    ['a rove move that is not one', { rove: 'grp', move: 'sideways' }],
    ['a rove on a node with no group', { rove: 'box', move: 'next' }],
    ['a reference to nothing', { focus: 'deleted' }],
    ['a reference that ends its selector', { focus: 'x"]' }],
    ['a reference to a text node', { focus: 'tx' }],
    ['a reference to a blocked tag', { focus: 'scr' }],
    ['a reference by object', { focus: { get: 'c' } }],
  ])('refuses %s', (_label, action) => {
    expect(trigger(click(action)).length, _label).toBeGreaterThan(0);
  });
});

describe('bindings', () => {
  it('takes the allow list', () => {
    for (const attr of ['aria-expanded', 'aria-activedescendant', 'data-u-on', 'data-u-a-1', 'open', 'disabled', 'min', 'max', 'value']) {
      expect(binding({ attr, from: { get: 'b' } }), attr).toEqual([]);
    }
    expect(binding({ attr: 'inert', from: { get: 'b' } })).toEqual([]);
    expect(binding({ cssVar: '--u-split', from: { get: 'n' }, unit: '%' })).toEqual([]);
    expect(binding({ text: { get: 'n' } }, { id: 'self', type: 'p', props: { children: 'x' } })).toEqual([]);
  });

  it.each([
    'onclick', 'ONCLICK', 'onClick', 'href', 'HREF', 'src', 'srcdoc', 'action', 'formaction', 'style', 'class', 'className', 'id',
    'tabindex', 'tabIndex', 'hidden', 'name', 'type', 'for', 'aria-', 'ARIA-LABEL', 'aria-label"x', 'aria-a b', 'data-', 'data-x', 'data-fc-n', 'data-fcs-s1', 'data-u-', 'data-u-A', 'data-u-a=b', 'Value', 'xlink:href',
  ])('refuses the attribute %s', (attr) => {
    expect(binding({ attr, from: 'x' }).join()).toMatch(/cannot be bound/);
  });

  it('refuses a binding that is more than one thing, or nothing', () => {
    expect(binding({ attr: 'aria-label', from: 'x', text: 'y' }).length).toBe(1);
    expect(binding({ attr: 'aria-label', cssVar: '--u-x', from: 1 }).length).toBe(1);
    expect(binding({ from: 'x' }).join()).toMatch(/attr, cssVar or text/);
    expect(binding('aria-label').join()).toMatch(/object/);
    expect(binding({ attr: 'aria-label' }).length).toBe(1);
    expect(binding({ attr: 1, from: 'x' }).length).toBe(1);
  });

  it('refuses two bindings writing one target', () => {
    const read = parseBehaviour({ id: 'a', type: 'div', props: { behaviour: { bind: [{ attr: 'open', from: true }, { attr: 'open', from: false }] } } });
    expect(read.refused[0].reason).toMatch(/same thing/);
  });

  it('has no event, pointer or active item to read', () => {
    expect(binding({ attr: 'aria-label', from: { event: 'newState' } }).join()).toMatch(/no event/);
    expect(binding({ text: { event: 'value' } }, { id: 'self', type: 'p', props: { children: 'x' } }).join()).toMatch(/no event/);
    expect(binding({ cssVar: '--u-x', from: { pointer: 'x', of: 'box', as: 'px' } }).join()).toMatch(/no event/);
    expect(binding({ attr: 'data-u-a', from: { active: 'grp' } }).join()).toMatch(/no active/);
  });

  it('holds a custom property to numbers under --u-', () => {
    expect(binding({ cssVar: '--x', from: 1 }).join()).toMatch(/--u-/);
    expect(binding({ cssVar: 'color', from: 1 }).join()).toMatch(/--u-/);
    expect(binding({ cssVar: '--u-X', from: 1 }).join()).toMatch(/--u-/);
    expect(binding({ cssVar: '--u-x', from: 'url(//e.example)' }).join()).toMatch(/numbers only/);
    expect(binding({ cssVar: '--u-x', from: { get: 'c' } }).join()).toMatch(/numbers only/);
    expect(binding({ cssVar: '--u-x', from: { get: 'b' } }).join()).toMatch(/numbers only/);
    expect(binding({ cssVar: '--u-x', from: 1, unit: 'vh' }).join()).toMatch(/unit/);
  });

  it('refuses a first value that removes content with no script', () => {
    expect(binding({ attr: 'inert', from: true }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'inert', from: { get: 'on' } }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'inert', from: { not: { get: 'b' } } }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'inert', from: { eq: [{ get: 'c' }, 'a'] } }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'inert', from: { map: 'c', cases: { a: true }, default: false } }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'inert', from: 'false' }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'inert', from: 0 }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'aria-hidden', from: true }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'aria-hidden', from: 'true' }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'aria-hidden', from: 'TRUE' }).join()).toMatch(/must start false/);
    // A row is not known here, so it cannot be proven false.
    expect(binding({ attr: 'inert', from: { eq: [{ row: 'index' }, 0] } }).join()).toMatch(/must start false/);
    expect(binding({ attr: 'aria-hidden', from: { not: { get: 'on' } } })).toEqual([]);
    expect(binding({ attr: 'aria-hidden', from: 'false' })).toEqual([]);
  });

  describe('a text binding', () => {
    const textNode = { id: 'x', type: '#text', props: { children: 'x' } };
    const element = { id: 'y', type: 'span' };

    it('needs exactly one text child', () => {
      const entry = { text: 'x' };
      expect(binding(entry, { id: 'self', type: 'p', props: { children: 'a' } })).toEqual([]);
      expect(binding(entry, { id: 'self', type: 'p', props: { children: 5 } })).toEqual([]);
      expect(binding(entry, { id: 'self', type: 'p', children: [textNode] })).toEqual([]);
      for (const node of [
        { id: 'self', type: 'p' },
        { id: 'self', type: 'p', children: [] },
        { id: 'self', type: 'p', children: [textNode, textNode] },
        { id: 'self', type: 'p', children: [element] },
        { id: 'self', type: 'p', children: [textNode, element] },
        { id: 'self', type: 'p', props: { children: 'a' }, children: [textNode] },
        { id: 'self', type: 'p', props: { children: 'a' }, children: [element] },
      ]) expect(binding(entry, node).join(), JSON.stringify(node)).toMatch(/exactly one text child/);
    });
  });

  it('never reads a state outside its reach', () => {
    expect(binding({ attr: 'aria-label', from: { get: 'nope' } }).join()).toMatch(/in reach/);
  });
});

describe('initial values at render', () => {
  const read = (id: string) => ({ a: 2, on: true, c: 'x' } as Record<string, unknown>)[id];

  it('evaluates the closed forms', () => {
    expect(staticValue({ eq: [{ get: 'c' }, 'x'] }, read)).toBe(true);
    expect(staticValue({ add: [{ get: 'a' }, 1] }, read)).toBe(3);
    expect(staticValue({ clamp: [{ get: 'a' }, 3, 5] }, read)).toBe(3);
    expect(staticValue({ and: [{ get: 'on' }, { gt: [{ get: 'a' }, 1] }] }, read)).toBe(true);
    expect(staticValue({ or: [false, { lt: [{ get: 'a' }, 1] }] }, read)).toBe(false);
    expect(staticValue({ not: { get: 'on' } }, read)).toBe(false);
    expect(staticValue({ row: 'index' }, read, 3)).toBe(3);
    expect(staticValue({ eq: [{ get: 'a' }, { row: 'index' }] }, read, 2)).toBe(true);
    expect(staticValue({ map: 'c', cases: { x: 1 } }, read)).toBe(1);
    expect(staticValue({ map: 'c', cases: { y: 1 }, default: 2 }, read)).toBe(2);
  });

  it('stays unknown rather than guess', () => {
    expect(staticValue({ row: 'index' }, read)).toBeUndefined();
    expect(staticValue({ not: { row: 'index' } }, read)).toBeUndefined();
    expect(staticValue({ eq: [{ get: 'nope' }, 1] }, read)).toBeUndefined();
    expect(staticValue({ event: 'value' }, read)).toBeUndefined();
    expect(staticValue({ map: 'c', cases: { y: 1 } }, read)).toBeUndefined();
    expect(staticValue({ map: 'nope', cases: { y: 1 } }, read)).toBeUndefined();
    expect(staticValue({ map: 'c', cases: JSON.parse('{"y":1}') }, () => 'constructor')).toBeUndefined();
  });
});

describe('islands', () => {
  const emailField = { id: 'self', type: 'div', props: { 'data-form-kind': 'form-field', fieldType: 'email' } };
  const selectField = { id: 'self', type: 'div', props: { 'data-form-kind': 'form-field', fieldType: 'select' } };
  const consentField = { id: 'self', type: 'div', props: { 'data-form-kind': 'form-field', fieldType: 'consent' } };
  const defaultField = { id: 'self', type: 'div', props: { 'data-form-kind': 'form-field' } };
  const submit = { id: 'self', type: 'button', props: { 'data-form-kind': 'form-submit' } };
  const form = { id: 'self', type: 'form', props: { 'data-form-kind': 'form' } };
  const cart = { id: 'self', type: 'div', props: { 'data-component-kind': 'add-to-cart' } };
  const sticky = { id: 'self', type: 'div', props: { [STICKY_CTA_ATTR]: STICKY_CTA_MARKER } };

  it('allows only `change` on a non-text field', () => {
    accepted(on('change', { toggle: 'b' }), selectField);
    accepted(on('change', { toggle: 'b' }), consentField);
    for (const node of [emailField, defaultField, cart]) {
      refused(on('change', { toggle: 'b' }), /island claims/, node);
    }
    for (const event of ['input', 'click', 'focus', 'blur', 'beforeinput', 'paste']) {
      refused(on(event, { toggle: 'b' }), /island claims/, selectField);
      refused(on(event, { toggle: 'b' }), /island claims/, emailField);
    }
    refused(key(['Enter'], { toggle: 'b' }), /island claims/, emailField);
    for (const name of ['product-list', 'product-detail', 'variant-selector', 'add-to-cart', 'cart-view', 'checkout-button']) {
      refused(click({ toggle: 'b' }), /island claims/, { id: 'self', type: 'div', props: { 'data-component-kind': name } });
    }
  });

  it('claims the inside of a commerce island, not of a form', () => {
    const shop = {
      id: 'shop', type: 'div', props: { 'data-component-kind': 'cart-view' },
      children: [{ id: 'inner', type: 'button', props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ emit: 'x' }] }] } } }],
    };
    expect(readBehaviourTree(shop).refused[0].reason).toMatch(/island claims/);
    const contact = {
      id: 'contact', type: 'form', props: { 'data-form-kind': 'form' },
      children: [{ id: 'inner', type: 'div', props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ emit: 'x' }] }] } } }],
    };
    expect(readBehaviourTree(contact).refused).toEqual([]);
  });

  it('binds only aria-* and data-u-* on an island', () => {
    for (const node of [emailField, submit, form, cart, sticky]) {
      expect(binding({ attr: 'aria-busy', from: { get: 'b' } }, node), JSON.stringify(node)).toEqual([]);
      expect(binding({ attr: 'data-u-a', from: { get: 'b' } }, node)).toEqual([]);
      for (const attr of ['value', 'disabled', 'min', 'max', 'open', 'inert']) {
        expect(binding({ attr, from: 'x' }, node).join()).toMatch(/island/);
      }
      expect(binding({ cssVar: '--u-a', from: 1 }, node).join()).toMatch(/island/);
    }
    expect(binding({ text: 'x' }, { ...submit, props: { ...submit.props, children: 'Send' } }).join()).toMatch(/owns its text/);
  });

  it('refuses every verb that would change what an island owns', () => {
    for (const target of ['isl-form', 'isl-field', 'isl-cart']) {
      refused(click({ setProp: target, prop: 'value', value: 'x' }), /island owns/);
      refused(click({ filter: target, role: 'option', text: 'x' }), /island owns/);
      refused(click({ popover: target, op: 'toggle' }), /island owns/);
    }
    refused(click({ form: 'isl-form', op: 'reset' }), /island owns/);
    refused(click({ setProp: 'isl-form', prop: 'disabled', value: true }), /island owns/);
    accepted(click({ focus: 'isl-field' }));
    accepted(click({ scroll: 'isl-cart' }));
    accepted(click({ effect: 'isl-form' }));
  });

  it('holds no focus group on an island', () => {
    const read = parseBehaviour({ ...cart, props: { ...cart.props, behaviour: { group: { role: 'tab', axis: 'line' } } } });
    expect(read.refused[0].entry).toBe('group');
  });

  it('does not let a shared key hide an island', () => {
    const tree = {
      id: 'root', type: 'div',
      props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ form: 'dup', op: 'reset' }] }] } },
      children: [{ id: 'dup', type: 'form' }, { id: 'dup', type: 'form', props: { 'data-form-kind': 'form' } }],
    };
    expect(readBehaviourTree(tree).refused[0].reason).toMatch(/island owns/);
  });
});

describe('reach', () => {
  it('sees state on its own path, nearest first, and no further', () => {
    const tree = {
      id: 'root', type: 'div', props: { behaviour: { state: [num('x', 1, { min: 0 })] } },
      children: [
        { id: 'a', type: 'div', props: { behaviour: { state: [bool('own')] } } },
        { id: 'b', type: 'button', props: { behaviour: { on: [
          { id: 'up', on: 'click', do: [{ step: 'x' }] },
          { id: 'sideways', on: 'click', do: [{ toggle: 'own' }] },
        ] } } },
      ],
    };
    const read = readBehaviourTree(tree);
    expect(read.behaviours.get(tree.children[1])?.on?.map((t) => t.id)).toEqual(['up']);
    expect(read.refused[0].reason).toMatch(/no state own/);
  });

  it('refuses a document trigger outside the scope holding its state', () => {
    const tree = {
      id: 'root', type: 'div', props: { behaviour: { on: [{ id: 'esc', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ set: 'tip', value: false }] }] } },
      children: [{ id: 'wrap', type: 'div', props: { behaviour: { state: [bool('tip')] } } }],
    };
    expect(readBehaviourTree(tree).refused[0].reason).toMatch(/no state tip/);
  });

  it('resolves a reference forward in the document, and refuses one to nothing', () => {
    const tree = {
      id: 'root', type: 'div',
      props: { behaviour: { on: [{ id: 'a', on: 'click', do: [{ focus: 'later' }] }, { id: 'b', on: 'click', do: [{ focus: 'never' }] }] } },
      children: [{ id: 'later', type: 'button' }],
    };
    const read = readBehaviourTree(tree);
    expect(read.behaviours.get(tree)?.on?.map((t) => t.id)).toEqual(['a']);
    expect(read.refused).toHaveLength(1);
  });

  it('keys nodes on classKey before id', () => {
    const tree = {
      id: 'root', type: 'div',
      props: { behaviour: { on: [{ id: 'a', on: 'click', do: [{ focus: 'shared' }] }] } },
      children: [{ id: 'one-of-many', classKey: 'shared', type: 'button' }],
    };
    expect(readBehaviourTree(tree).refused).toEqual([]);
  });

  it('refuses a key every object inherits, which also keys the program table', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const tree = { id: 'root', type: 'div', props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ focus: id }] }] } }, children: [{ id, type: 'button' }] };
      expect(readBehaviourTree(tree).refused[0].reason).toMatch(/no node/);
    }
  });

  it('reads a shared key on the node itself as what all its sharers are', () => {
    const tree = {
      id: 'root', type: 'div',
      children: [
        { id: 'dup', type: 'form', props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ form: 'dup', op: 'reset' }] }] } } },
        { id: 'dup', type: 'form', props: { 'data-form-kind': 'form' } },
      ],
    };
    expect(readBehaviourTree(tree).refused[0].reason).toMatch(/island owns/);
  });

  it('holds the page caps in document order', () => {
    const trigger60 = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, on: 'click', do: [{ emit: 'x' }] }));
    const children = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: 'div', props: { behaviour: { on: trigger60 } } }));
    const read = readBehaviourTree({ id: 'root', type: 'div', children });
    const kept = [...read.behaviours.values()].reduce((sum, b) => sum + (b.on?.length ?? 0), 0);
    expect(kept).toBeLessThanOrEqual(MAX_TRIGGERS_PER_PAGE);
    expect(kept).toBeGreaterThan(0);
    expect(read.refused.length).toBeGreaterThan(0);

    const heavy = Array.from({ length: 4 }, (_, i) => ({
      id: `h${i}`, type: 'div', props: { behaviour: { state: [{ ...text('x'), name: 'n', initial: 'x'.repeat(4000) }, { ...text('y'), initial: 'y'.repeat(4000) }, { ...text('z'), initial: 'z'.repeat(4000) }, { ...text('w'), initial: 'w'.repeat(4000) }, { ...text('u'), initial: 'u'.repeat(4000) }, { ...text('v'), initial: 'v'.repeat(4000) }, { ...text('r'), initial: 'r'.repeat(4000) }, { ...text('q'), initial: 'q'.repeat(4000) }, { ...text('p'), initial: 'p'.repeat(4000) }, { ...text('o'), initial: 'o'.repeat(4000) }, { ...text('l'), initial: 'l'.repeat(4000) }, { ...text('k'), initial: 'k'.repeat(4000) }, { ...text('j'), initial: 'j'.repeat(4000) }, { ...text('i'), initial: 'i'.repeat(4000) }] } },
    }));
    const sized = readBehaviourTree({ id: 'root', type: 'div', children: heavy });
    expect(sized.behaviours.size).toBe(1);
    expect(sized.refused.map((r) => r.reason).join()).toMatch(/bytes of behaviour/);
  });

  it('does not count on a state dropped by a cap', () => {
    const filler = Array.from({ length: 16 }, (_, i) => ({ ...text(`f${i}`), initial: 'x'.repeat(4000) }));
    const late = {
      id: 'late', type: 'div', props: { behaviour: { state: [bool('gone'), ...filler] } },
      children: [{ id: 'kid', type: 'button', props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ toggle: 'gone' }] }] } } }],
    };
    const read = readBehaviourTree({ id: 'root', type: 'div', children: [{ id: 'first', type: 'div', props: { behaviour: { state: filler.slice(0, 15) } } }, late] });
    expect(read.refused.map((r) => r.reason).join()).toMatch(/no state gone/);
  });
});

describe('remapBehaviourRefs', () => {
  const ids = new Map([['a', 'a2'], ['b', 'b2']]);

  it('moves every kind of reference inside the copy, and leaves one outside', () => {
    const behaviour = {
      group: { role: 'option', axis: 'line', virtual: { owner: 'a' } },
      on: [{
        id: 't', on: 'pointermove', do: [
          { focus: 'a' }, { rove: 'b', move: 'next' }, { dialog: 'a', op: 'close' }, { popover: 'a', op: 'hide' }, { details: 'a', op: 'open' },
          { media: 'a', op: 'play' }, { fullscreen: 'a', op: 'enter' }, { pictureInPicture: 'a', op: 'enter' }, { scroll: 'a' }, { form: 'a', op: 'reset' },
          { setProp: 'a', prop: 'value', value: { active: 'b' } }, { filter: 'a', role: 'option', text: 'x' }, { effect: 'a' },
          { delay: 16, do: [{ focus: 'b' }, { focus: 'outside' }] },
          { set: 'a', value: { pointer: 'x', of: 'b', as: 'px' } },
        ],
      }],
    };
    const copy = remapBehaviourRefs({ id: 'x', props: { behaviour } }, ids);
    const out = JSON.stringify(copy.props);
    expect(out).toContain('"focus":"a2"');
    expect(out).toContain('"focus":"b2"');
    expect(out).toContain('"focus":"outside"');
    expect(out).toContain('"owner":"a2"');
    expect(out).toContain('"of":"b2"');
    expect(out).toContain('"active":"b2"');
    for (const verb of ['rove":"b2', 'dialog":"a2', 'popover":"a2', 'details":"a2', 'media":"a2', 'fullscreen":"a2', 'pictureInPicture":"a2', 'scroll":"a2', 'form":"a2', 'setProp":"a2', 'filter":"a2', 'effect":"a2']) {
      expect(out).toContain(verb);
    }
    // `set` holds a state id, which is not a node id, even when the spelling matches.
    expect(out).toContain('"set":"a"');
    expect(behaviour.on[0].do[0]).toEqual({ focus: 'a' });
  });

  it('walks children, reads map cases as text, and leaves state alone', () => {
    const tree = {
      id: 'r',
      children: [{ id: 'c', props: { behaviour: {
        state: [{ id: 'a', name: 'a', type: 'boolean', initial: false }],
        bind: [{ attr: 'data-u-a', from: { map: 'a', cases: { focus: 'a', other: { active: 'a' } } } }],
      } } }],
    };
    const out = remapBehaviourRefs(tree, ids);
    const props = out.children[0].props.behaviour.bind[0].from as { cases: Record<string, unknown> };
    expect(props.cases).toEqual({ focus: 'a', other: { active: 'a2' } });
    expect(out.children[0].props.behaviour.state[0].id).toBe('a');
  });

  it('hands back the same objects when nothing moved', () => {
    const node = { id: 'r', props: { style: {} }, children: [{ id: 'c', props: { behaviour: { on: [{ do: [{ focus: 'outside' }] }] } } }] };
    expect(remapBehaviourRefs(node, ids)).toBe(node);
  });

  it('adds no key to a parent of a moved child', () => {
    const node = { id: 'r', props: { style: {} }, children: [{ id: 'c', props: { behaviour: { on: [{ do: [{ focus: 'a' }] }] } } }] };
    expect(Object.keys(remapBehaviourRefs(node, ids).props)).toEqual(['style']);
  });

  it('survives invalid and frozen stored data', () => {
    const frozen = Object.freeze({ on: Object.freeze([Object.freeze({ do: Object.freeze([Object.freeze({ focus: 'a' })]) })]) });
    const out = remapBehaviourRefs({ id: 'r', props: { behaviour: frozen } }, ids);
    expect(JSON.stringify(out.props)).toContain('a2');
    for (const value of [null, 1, 'a', [], { focus: 1 }, { on: 'x' }]) {
      expect(() => remapBehaviourRefs({ id: 'r', props: { behaviour: value } }, ids)).not.toThrow();
    }
    let deep: unknown = { focus: 'a' };
    for (let i = 0; i < 5000; i++) deep = { do: [deep] };
    expect(() => remapBehaviourRefs({ id: 'r', props: { behaviour: deep } }, ids)).not.toThrow();
  });
});

describe('compactBehaviour', () => {
  it('removes what is empty and says when nothing is left', () => {
    expect(compactBehaviour({ state: [], on: undefined, bind: [], showWhen: null })).toBeUndefined();
    expect(compactBehaviour({})).toBeUndefined();
    const on: Trigger[] = [{ id: 't', on: 'click', do: [{ emit: 'x' }] }];
    expect(compactBehaviour({ state: [], on })).toEqual({ on });
    // What the parser would refuse is kept, so the panel can show it.
    expect(compactBehaviour({ on: [{ id: 'bad' }] })).toEqual({ on: [{ id: 'bad' }] });
  });
});

describe('presets from the prototype parse as stored', () => {
  const tree = (behaviours: Record<string, StoredBehaviour>, shape: BehaviourNode): BehaviourNode => {
    const fill = (node: BehaviourNode): BehaviourNode => ({
      ...node,
      props: { ...(node.props as object), ...(behaviours[node.id as string] ? { behaviour: behaviours[node.id as string] } : {}) },
      children: Array.isArray(node.children) ? (node.children as BehaviourNode[]).map(fill) : undefined,
    });
    return fill(shape);
  };
  const go = (move: string) => ({ rove: 'menu', move });

  it('menu-button', () => {
    const page = tree({
      wrap: { state: [bool('open')] },
      btn: {
        bind: [{ attr: 'aria-expanded', from: { get: 'open' } }],
        on: [
          { id: 'd', on: 'keydown', keys: ['ArrowDown'], prevent: true, do: [{ popover: 'menu', op: 'show' }, go('first')] },
          { id: 'o', on: 'click', do: [{ delay: 16, do: [go('first')] }] },
        ] as Trigger[],
      },
      menu: {
        group: { role: 'menuitem', axis: 'line', wrap: true },
        on: [
          { id: 's', on: 'toggle', do: [{ set: 'open', value: { eq: [{ event: 'newState' }, 'open'] } }] },
          { id: 't', on: 'keydown', keys: ['Printable'], do: [go('type')] },
        ] as Trigger[],
      },
    }, { id: 'wrap', type: 'div', children: [{ id: 'btn', type: 'button' }, { id: 'menu', type: 'div' }] });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });

  it('combobox', () => {
    const page = tree({
      wrap: { state: [bool('open')] },
      list: { group: { role: 'option', axis: 'line', wrap: true, virtual: { owner: 'in' } } },
      in: {
        bind: [{ attr: 'aria-expanded', from: { get: 'open' } }],
        on: [
          { id: 'i', on: 'input', do: [{ rove: 'list', move: 'clear' }, { filter: 'list', role: 'option', text: { event: 'value' } }, { set: 'open', value: true }] },
          { id: 'd', on: 'keydown', keys: ['ArrowDown'], prevent: true, do: [{ set: 'open', value: true }, { rove: 'list', move: 'next' }] },
          { id: 'e', on: 'keydown', keys: ['Enter'], if: { get: 'open' }, prevent: true, do: [{ setProp: 'in', prop: 'value', value: { active: 'list' } }, { set: 'open', value: false }] },
          { id: 'x', on: 'keydown', keys: ['Escape'], do: [{ set: 'open', value: false }] },
        ] as Trigger[],
      },
    }, { id: 'wrap', type: 'div', children: [{ id: 'in', type: 'input' }, { id: 'list', type: 'ul' }] });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });

  it('windowsplitter', () => {
    const page = tree({
      wrap: {
        state: [num('pos', 50, { min: 0, max: 100 }), num('last', 50, { min: 0, max: 100 }), bool('drag')],
        bind: [{ cssVar: '--u-split', from: { get: 'pos' }, unit: '%' }],
      },
      sep: {
        bind: [{ attr: 'aria-valuenow', from: { get: 'pos' } }],
        on: [
          { id: 'l', on: 'keydown', keys: ['ArrowLeft'], prevent: true, do: [{ step: 'pos', by: -5 }] },
          { id: 'c', on: 'keydown', keys: ['Enter'], if: { gt: [{ get: 'pos' }, 0] }, do: [{ set: 'last', value: { get: 'pos' } }, { set: 'pos', value: 0 }] },
          { id: 'd', on: 'pointerdown', do: [{ capturePointer: true }, { set: 'drag', value: true }] },
          { id: 'm', on: 'pointermove', if: { get: 'drag' }, do: [{ set: 'pos', value: { clamp: [{ pointer: 'x', of: 'wrap', as: 'percent' }, 0, 100] } }] },
          { id: 'u', on: 'pointerup', do: [{ set: 'drag', value: false }] },
        ] as Trigger[],
      },
    }, { id: 'wrap', type: 'div', children: [{ id: 'sep', type: 'div' }] });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });

  it('tooltip', () => {
    const page = tree({
      wrap: {
        state: [bool('tip')],
        on: [{ id: 'esc', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ cancel: 'tip' }, { set: 'tip', value: false }] }] as Trigger[],
      },
      btn: {
        on: [
          { id: 'en', on: 'mouseenter', do: [{ delay: 40, key: 'tip', do: [{ set: 'tip', value: true }] }] },
          { id: 'le', on: 'mouseleave', do: [{ delay: 150, key: 'tip', do: [{ set: 'tip', value: false }] }] },
          { id: 'fi', on: 'focus', do: [{ set: 'tip', value: true }] },
          { id: 'fo', on: 'blur', do: [{ set: 'tip', value: false }] },
        ] as Trigger[],
      },
      tip: { showWhen: { state: 'tip', eq: true } },
    }, { id: 'wrap', type: 'div', children: [{ id: 'btn', type: 'button' }, { id: 'tip', type: 'div' }] });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });

  it('feed and toolbar', () => {
    const page = tree({
      fd: {
        group: { role: 'article', axis: 'line' },
        on: [
          { id: 'd', on: 'keydown', keys: ['PageDown'], prevent: true, do: [{ rove: 'fd', move: 'next' }] },
          { id: 'x', on: 'keydown', keys: ['Ctrl+End'], prevent: true, do: [{ rove: 'fd', move: 'exit-after' }] },
          { id: 'y', on: 'keydown', keys: ['Ctrl+Home'], prevent: true, do: [{ rove: 'fd', move: 'exit-before' }] },
        ] as Trigger[],
      },
    }, { id: 'fd', type: 'div' });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });

  it('slider-multithumb', () => {
    const page = tree({
      wrap: { state: [num('lo', 2, { min: 0, max: 10 }), num('hi', 8, { min: 0, max: 10 })] },
      low: { on: [{ id: 'l', on: 'input', do: [{ set: 'lo', value: { clamp: [{ event: 'value' }, 0, { get: 'hi' }] } }, { setProp: 'low', prop: 'value', value: { get: 'lo' } }] }] as Trigger[] },
    }, { id: 'wrap', type: 'div', children: [{ id: 'low', type: 'input', props: { type: 'range' } }] });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });

  it('tabs from a Collection, comparing a state with the row', () => {
    const page = tree({
      w: { state: [num('active', 0, { min: 0, max: 2 })] },
      tab: { on: [{ id: 'c', on: 'click', do: [{ set: 'active', value: { row: 'index' } }] }] as Trigger[] },
      panel: { showWhen: { state: 'active', eq: { row: 'index' } } },
    }, { id: 'w', type: 'div', children: [{ id: 'tab', type: 'button' }, { id: 'panel', type: 'div' }] });
    expect(readBehaviourTree(page).refused).toEqual([]);
  });
});
