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

// ---- the security review of B3 and B4 ---------------------------------------------------

/** What the runtime reads off an element, each a name a form's field could shadow. */
export const SHADOWED = ['parentElement', 'closest', 'getAttribute', 'hasAttribute', 'matches'];

/** A real form, a field in it, and a page-wide reason for the runtime to walk. */
const shadowing = (attribute: string, member: string) => (): StoredNode =>
  node('shadowed', 'div', { behaviour: { state: [flag('s')] } },
    node('outside', 'button', { type: 'button', children: 'outside', behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: [{ toggle: 's' }] }] } }),
    node('sheet', 'form', { behaviour: { on: [{ id: 'f', on: 'click', do: [{ toggle: 's' }] }] } },
      node('in-sheet', 'input', { [attribute]: member, 'aria-label': 'Field' }),
      node('press-sheet', 'button', { type: 'button', children: 'go', behaviour: { noScript: 'show', on: [{ id: 'g', on: 'click', do: [{ toggle: 's' }] }] } })));

const pay = (): StoredNode => node('pay', 'button', { type: 'button', children: 'Pay' });

const reachingPresses = (): StoredNode =>
  node('reach', 'div', {
    behaviour: {
      on: [
        { id: 'n', on: 'click', scope: 'document', do: [{ navigate: 'https://example.invalid/phish' }] },
        { id: 'm', on: 'click', scope: 'document', do: [{ dialog: 'held', op: 'showModal' }] },
      ],
    },
  },
    node('catcher', 'div', { children: 'catches', style: { width: '200px', height: '40px' }, behaviour: { on: [{ id: 'p', on: 'pointerdown', scope: 'document', do: [{ capturePointer: true }] }] } }),
    node('held', 'dialog', {}, node('in-held', 'p', { children: 'modal' })),
    pay());

const escapeBack = (on: string, holder: 'node' | 'page') => (): StoredNode => {
  const trigger = { id: 'k', on, ...(holder === 'page' ? { scope: 'document' } : {}), keys: ['Escape'], do: [{ dialog: 'held', op: 'showModal' }] };
  return node('back', 'div', {},
    node('opener', 'button', { type: 'button', children: 'open', behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: [{ dialog: 'held', op: 'showModal' }] }, ...(holder === 'node' ? [trigger] : [])] } }),
    node('held', 'dialog', {}, node('in-held', 'p', { children: 'modal' })),
    ...(holder === 'page' ? [node('wider', 'div', { behaviour: { on: [trigger] } })] : []));
};

const wall = (): StoredNode =>
  node('walled', 'div', { behaviour: { on: [{ id: 'r', on: 'page-ready', do: [{ dialog: 'held', op: 'showModal' }] }] } },
    node('held', 'dialog', { closedby: 'none' }, node('in-held', 'p', { children: 'wall' })),
    pay());

const timers = (): StoredNode =>
  node('timed', 'div', {
    behaviour: {
      on: [
        { id: 'f', on: 'every', ms: 1000, do: [{ fullscreen: 'timed', op: 'enter' }] },
        { id: 'd', on: 'click', do: [{ delay: 16, do: [{ fullscreen: 'timed', op: 'enter' }] }] },
      ],
    },
  }, pay());

/** The state and a real transition chasing each other, slower than any rate can see. */
const slowLoop = (): StoredNode =>
  node('slow', 'div', { behaviour: { state: [flag('a')] } },
    node('fader', 'div', {
      children: 'Fades',
      style: { opacity: '1', transition: 'opacity 16ms linear' },
      rules: [{ id: 'r', selector: '&', when: { state: 'a', eq: true }, style: { opacity: '0.5' } }],
      behaviour: { on: [{ id: 'l', on: 'transitionend', do: [{ toggle: 'a' }] }] },
    }),
    node('start', 'button', { type: 'button', children: 'Start', behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: [{ toggle: 'a' }] }] } }));

const consent = (): StoredNode =>
  node('with-banner', 'div', { behaviour: { state: [flag('s')], on: [{ id: 'k', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ set: 's', value: false }] }] } }, pay());

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
  ...Object.fromEntries(SHADOWED.flatMap((member) => ['id', 'name'].map((attribute) => [`shadow-${attribute}-${member.toLowerCase()}`, shadowing(attribute, member)]))),
  'img-query-selector': () => node('holder', 'div', {}, accordion(), node('image', 'img', { name: 'querySelector', alt: 'x', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })),
  'reaching-presses': reachingPresses,
  'escape-keyup-node': escapeBack('keyup', 'node'),
  'escape-keyup-page': escapeBack('keyup', 'page'),
  wall,
  timers,
  'slow-loop': slowLoop,
  consent,
  ordinary,
};
