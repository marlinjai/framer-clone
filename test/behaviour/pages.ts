// The stored pages of the behaviour proofs, saved and published through the real
// repository, so they reach the browser exactly as an author's page does. A node's
// `data-t` is how a test finds it.

type Props = Record<string, unknown>;

export interface StoredNode {
  id: string;
  type: string;
  componentType: 'host';
  props: Props;
  children: StoredNode[];
}

export const node = (id: string, type: string, props: Props = {}, ...children: StoredNode[]): StoredNode => ({
  id,
  type,
  componentType: 'host',
  props: { 'data-t': id, ...props },
  children,
});

const flag = (id: string, initial = false) => ({ id, name: id, type: 'boolean', initial });

/** The contract's accordion, with a bound text and a sibling that must survive hydration. */
const accordion = (): StoredNode =>
  node('item', 'div', { behaviour: { state: [flag('s1')] } },
    node('btn', 'button', {
      children: 'Open',
      behaviour: { on: [{ id: 'click', on: 'click', do: [{ toggle: 's1' }] }], bind: [{ attr: 'aria-expanded', from: { get: 's1' } }] },
    }),
    node('panel', 'div', { children: 'Body', behaviour: { showWhen: { state: 's1', eq: true } } }),
    node('label', 'span', {
      children: 'closed',
      behaviour: { bind: [{ text: { map: 's1', cases: { true: 'open', false: 'closed' } } }] },
    }),
    node('other', 'p', { children: 'Other' }));

/** A press, a key on a wrapper around a real field, and a count of what fired. */
const fields = (): StoredNode =>
  node('form-area', 'div', {
    behaviour: {
      state: [{ id: 'n', name: 'n', type: 'number', initial: 0 }, flag('named')],
      on: [
        { id: 'any', on: 'keydown', do: [{ step: 'n' }] },
        { id: 'letter', on: 'keydown', keys: ['a', 'Printable', 'Space'], do: [{ step: 'n' }] },
        { id: 'enter', on: 'keydown', keys: ['Enter'], do: [{ set: 'named', value: true }] },
      ],
    },
  },
    node('field', 'input', { type: 'text', 'aria-label': 'Field' }),
    node('area', 'textarea', { 'aria-label': 'Area' }),
    node('note', 'div', { contentEditable: true, suppressContentEditableWarning: true, children: 'Note' }),
    node('plain', 'button', { type: 'button', children: 'Plain' }),
    node('count', 'output', { children: '0', behaviour: { bind: [{ text: { get: 'n' } }] } }));

/** A range's text value reaching number state, and a select held to a choice's options. */
const values = (): StoredNode =>
  node('values', 'div', {
    behaviour: { state: [{ id: 'n', name: 'n', type: 'number', initial: 2, min: 0, max: 8 }, { id: 'c', name: 'c', type: 'choice', initial: 'a', options: ['a', 'b'] }] },
  },
    node('range', 'input', {
      type: 'range', min: 0, max: 10, defaultValue: 2, 'aria-label': 'Range',
      behaviour: { on: [{ id: 'r', on: 'input', do: [{ set: 'n', value: { event: 'value' } }] }] },
    }),
    node('pick', 'select', {
      'aria-label': 'Pick',
      behaviour: { on: [{ id: 'p', on: 'change', do: [{ set: 'c', value: { event: 'value' } }] }] },
    },
      node('o-a', 'option', { value: 'a', children: 'A' }),
      node('o-b', 'option', { value: 'b', children: 'B' }),
      node('o-z', 'option', { value: 'z', children: 'Z' })),
    node('number', 'output', { children: '2', behaviour: { bind: [{ text: { get: 'n' } }] } }),
    node('choice', 'output', { children: 'a', behaviour: { bind: [{ text: { get: 'c' } }] } }));

/**
 * Finding 8 of the review: `close` sets a flag that shows a sentinel, whose `view-enter`
 * runs `showModal` again. With `closedby="none"` Escape would do nothing either.
 */
const modalCycle = (): StoredNode =>
  node('cycle', 'div', {
    behaviour: {
      state: [flag('again')],
      on: [{ id: 'first', on: 'page-ready', do: [{ dialog: 'modal', op: 'showModal' }] }],
    },
  },
    node('modal', 'dialog', { behaviour: { on: [{ id: 'closed', on: 'close', do: [{ toggle: 'again' }] }] } },
      node('shut', 'button', { type: 'button', children: 'Close', behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: [{ dialog: 'modal', op: 'close' }] }] } })),
    node('sentinel', 'div', {
      children: 'Sentinel',
      behaviour: { showWhen: { state: 'again', eq: true }, on: [{ id: 'seen', on: 'view-enter', do: [{ dialog: 'modal', op: 'showModal' }] }] },
    }),
    node('opener', 'button', { type: 'button', children: 'Open', behaviour: { noScript: 'show', on: [{ id: 'o', on: 'click', do: [{ dialog: 'modal', op: 'showModal' }] }] } }));

/**
 * Two ways round the parser's caps, and a sibling that has to keep working. A `toggle`
 * that closes what its own state opened goes round through real browser events, and a
 * fan of delays multiplies through `emit` up to its depth limit.
 */
const loop = (): StoredNode =>
  node('looping', 'div', { behaviour: { state: [flag('s'), flag('open'), { id: 'n', name: 'n', type: 'number', initial: 0 }] } },
    node('storm', 'button', {
      type: 'button',
      children: 'Storm',
      behaviour: {
        noScript: 'show',
        on: [
          { id: 'go', on: 'click', do: [{ emit: 'tick' }] },
          { id: 'tick', on: 'custom:tick', do: Array.from({ length: 8 }, () => ({ delay: 16, do: [{ emit: 'tick' }] })) },
        ],
      },
    }),
    node('round', 'details', {
      behaviour: { bind: [{ attr: 'open', from: { get: 'open' } }], on: [{ id: 'flip', on: 'toggle', do: [{ toggle: 'open' }] }] },
    }),
    node('starter', 'button', { type: 'button', children: 'Start', behaviour: { noScript: 'show', on: [{ id: 'g', on: 'click', do: [{ set: 'open', value: true }] }] } }),
    node('still-works', 'button', { type: 'button', children: 'Toggle', behaviour: { noScript: 'show', on: [{ id: 't', on: 'click', do: [{ toggle: 's' }] }] } }),
    node('shows', 'output', { children: 'false', behaviour: { bind: [{ text: { get: 's' } }] } }));

/** What would end a script, in every place the program carries authored text. */
export const HOSTILE_TEXT = '</script><script>window.__hostile=1</script><img src=x onerror=window.__hostile=2>';
export const STATE_NAME = 'a-name-nothing-reads';

const hostile = (): StoredNode =>
  node('hostile', 'div', {
    behaviour: { state: [{ id: 's1', name: `${STATE_NAME}${HOSTILE_TEXT}`, type: 'boolean', initial: false, preset: true }, { id: 't', name: 't', type: 'text', initial: HOSTILE_TEXT }] },
  },
    node('btn', 'button', { children: 'Open', behaviour: { on: [{ id: 'c', on: 'click', do: [{ toggle: 's1' }] }], bind: [{ attr: 'aria-expanded', from: { get: 's1' }, preset: true }] } }),
    node('said', 'p', { children: 'x', behaviour: { bind: [{ text: { map: 's1', cases: { true: HOSTILE_TEXT, false: `${HOSTILE_TEXT}!` } } }] } }),
    node('kept', 'p', { children: 'x', behaviour: { bind: [{ text: { get: 't' } }] } }));

const still = (): StoredNode =>
  node('item', 'div', { behaviour: { state: [flag('s1', true)] } }, node('panel', 'div', { children: 'Body', behaviour: { showWhen: { state: 's1', eq: true } } }));

const effects = (): StoredNode =>
  node('moved', 'div', { children: 'Revealed', effects: { appear: { kind: 'fade' } } });

/** A page with some weight, for the time to ready. */
const ordinary = (): StoredNode =>
  node('ordinary', 'main', {},
    ...Array.from({ length: 60 }, (_, index) => node(`p${index}`, 'p', { children: `Paragraph ${index} of a page with real text on it, as a person would write it. `.repeat(4) })),
    accordion());

export const PAGES: Readonly<Record<string, () => StoredNode>> = {
  plain: () => node('plain-page', 'p', { children: 'No behaviour here' }),
  still,
  effects,
  accordion,
  fields,
  values,
  'modal-cycle': modalCycle,
  loop,
  hostile,
  ordinary,
};
