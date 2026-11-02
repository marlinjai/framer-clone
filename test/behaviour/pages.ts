// The stored pages of the behaviour proofs, saved and published through the real
// repository, so they reach the browser exactly as an author's page does. A node's
// `data-t` is how a test finds it.

import { PRESETS, type PresetNode } from '@/lib/behaviour/presets';
import { addSlide, carousel } from '@/lib/behaviour/presets/carousel';
import { addTab, tabs } from '@/lib/behaviour/presets/tabs';
import { behaviourOf, withProps } from '@/lib/behaviour/presets/nodes';

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
const ordinary = (...more: StoredNode[]): StoredNode =>
  node('ordinary', 'main', {},
    ...Array.from({ length: 60 }, (_, index) => node(`p${index}`, 'p', { children: `Paragraph ${index} of a page with real text on it, as a person would write it. `.repeat(4) })),
    accordion(),
    ...more);

// ---- slice B4: the prototype's presets, stored and through the real parser ------------

const key = (id: string, keys: string[], ...actions: unknown[]) => ({ id, on: 'keydown', keys, prevent: true, do: actions });
const go = (group: string, move: string) => ({ rove: group, move });
const set = (state: string, value: unknown) => ({ set: state, value });

const toolbarKeys = (forward: string, back: string) => [
  key('n', [forward], go('tb', 'next')),
  key('p', [back], go('tb', 'prev')),
  key('h', ['Home'], go('tb', 'first')),
  key('e', ['End'], go('tb', 'last')),
];

const edges = (...children: StoredNode[]): StoredNode =>
  node('edges', 'div', {},
    node('before', 'button', { type: 'button', children: 'before' }),
    ...children,
    node('after', 'button', { type: 'button', children: 'after' }));

const toolbar = (forward = 'ArrowRight', back = 'ArrowLeft', style: Props = {}): StoredNode =>
  edges(node('tb', 'div', {
    role: 'toolbar', 'aria-label': 'Format', style,
    behaviour: { group: { role: 'button', axis: 'line', wrap: true }, on: toolbarKeys(forward, back) },
  },
    node('bold', 'button', { type: 'button', role: 'button', children: 'Bold' }),
    node('italic', 'button', { type: 'button', role: 'button', children: 'Italic' }),
    node('under', 'button', { type: 'button', role: 'button', children: 'Under' })));

const feed = (): StoredNode =>
  node('around', 'div', {},
    node('pre', 'a', { href: '#x', children: 'pre' }),
    node('fd', 'div', {
      role: 'feed', 'aria-label': 'News',
      behaviour: {
        group: { role: 'article', axis: 'line' },
        on: [key('d', ['PageDown'], go('fd', 'next')), key('u', ['PageUp'], go('fd', 'prev')), key('x', ['Ctrl+End'], go('fd', 'exit-after')), key('y', ['Ctrl+Home'], go('fd', 'exit-before'))],
      },
    },
      node('one', 'article', { role: 'article', tabIndex: 0, children: 'One' }),
      node('two', 'article', { role: 'article', tabIndex: 0, children: 'Two' }),
      node('three', 'article', { role: 'article', tabIndex: 0, children: 'Three' })),
    node('post', 'a', { href: '#y', children: 'post' }));

const number = (id: string, initial: number) => ({ id, name: id, type: 'number', initial, min: 0, max: 100 });

const slider = (): StoredNode =>
  node('wrap', 'div', { behaviour: { state: [number('lo', 2), number('hi', 8)] } },
    node('low', 'input', {
      type: 'range', min: 0, max: 10, defaultValue: 2, 'aria-label': 'Low',
      behaviour: { on: [{ id: 'l', on: 'input', do: [set('lo', { clamp: [{ event: 'value' }, 0, { get: 'hi' }] }), { setProp: 'low', prop: 'value', value: { get: 'lo' } }] }] },
    }),
    node('high', 'input', {
      type: 'range', min: 0, max: 10, defaultValue: 8, 'aria-label': 'High',
      behaviour: { on: [{ id: 'h', on: 'input', do: [set('hi', { clamp: [{ event: 'value' }, { get: 'lo' }, 10] }), { setProp: 'high', prop: 'value', value: { get: 'hi' } }] }] },
    }));

const splitter = (): StoredNode =>
  node('wrap', 'div', {
    style: { display: 'flex', width: '600px', height: '80px' },
    behaviour: { state: [number('pos', 50), flag('drag')], bind: [{ cssVar: '--u-split', from: { get: 'pos' }, unit: '%' }] },
  },
    node('left', 'div', { style: { width: 'var(--u-split, 50%)', background: '#ccc' } }),
    node('sep', 'div', {
      role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Resize', 'aria-valuemin': 0, 'aria-valuemax': 100,
      style: { width: '10px', background: '#333', touchAction: 'none' },
      behaviour: {
        bind: [{ attr: 'aria-valuenow', from: { get: 'pos' } }],
        on: [
          key('l', ['ArrowLeft'], { step: 'pos', by: -5 }),
          key('r', ['ArrowRight'], { step: 'pos', by: 5 }),
          key('h', ['Home'], set('pos', 0)),
          key('e', ['End'], set('pos', 100)),
          { id: 'd', on: 'pointerdown', do: [{ capturePointer: true }, set('drag', true)] },
          { id: 'm', on: 'pointermove', if: { get: 'drag' }, do: [set('pos', { clamp: [{ pointer: 'x', of: 'wrap', as: 'percent' }, 0, 100] })] },
          { id: 'u', on: 'pointerup', do: [set('drag', false)] },
        ],
      },
    }));

const later = (id: string, on: string, ms: number, value: boolean) => ({ id, on, do: [{ delay: ms, key: 'tip', do: [set('tip', value)] }] });

const tooltip = (): StoredNode =>
  node('wrap', 'div', {
    style: { padding: '40px' },
    behaviour: { state: [flag('tip')], on: [{ id: 'esc', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ cancel: 'tip' }, set('tip', false)] }] },
  },
    node('btn', 'button', {
      type: 'button', 'aria-describedby': 'tip', children: 'Save',
      behaviour: { noScript: 'show', on: [later('en', 'mouseenter', 40, true), later('le', 'mouseleave', 150, false), { id: 'fi', on: 'focus', do: [set('tip', true)] }, { id: 'fo', on: 'blur', do: [set('tip', false)] }] },
    }),
    node('tip', 'div', {
      id: 'tip', role: 'tooltip', children: 'Saves the page', style: { width: '160px', height: '30px', background: '#eee' },
      behaviour: { showWhen: { state: 'tip', eq: true }, on: [{ id: 'te', on: 'mouseenter', do: [{ cancel: 'tip' }] }, later('tl', 'mouseleave', 150, false)] },
    }));

const menuButton = (): StoredNode =>
  node('around', 'div', {},
    node('wrap', 'div', { behaviour: { state: [flag('open')] } },
      node('btn', 'button', {
        type: 'button', popoverTarget: 'menu', 'aria-haspopup': 'menu', children: 'Actions',
        behaviour: {
          bind: [{ attr: 'aria-expanded', from: { get: 'open' } }],
          on: [
            key('d', ['ArrowDown'], { popover: 'menu', op: 'show' }, go('menu', 'first')),
            key('u', ['ArrowUp'], { popover: 'menu', op: 'show' }, go('menu', 'last')),
            { id: 'o', on: 'click', do: [{ delay: 16, do: [go('menu', 'first')] }] },
          ],
        },
      }),
      node('menu', 'div', {
        id: 'menu', popover: 'auto', role: 'menu',
        behaviour: {
          group: { role: 'menuitem', axis: 'line', wrap: true },
          on: [
            { id: 's', on: 'toggle', do: [set('open', { eq: [{ event: 'newState' }, 'open'] })] },
            key('n', ['ArrowDown'], go('menu', 'next')),
            key('p', ['ArrowUp'], go('menu', 'prev')),
            key('h', ['Home'], go('menu', 'first')),
            key('e', ['End'], go('menu', 'last')),
            { id: 't', on: 'keydown', keys: ['Printable'], do: [go('menu', 'type')] },
          ],
        },
      },
        node('copy', 'button', { type: 'button', role: 'menuitem', children: 'Copy' }),
        node('paste', 'button', { type: 'button', role: 'menuitem', children: 'Paste' }),
        node('delete', 'button', { type: 'button', role: 'menuitem', children: 'Delete' }))),
    node('out', 'p', { children: 'outside' }));

const natives = (): StoredNode =>
  node('wrap', 'div', { behaviour: { state: [flag('dopen'), flag('mopen')] } },
    node('more', 'details', { behaviour: { on: [{ id: 't', on: 'toggle', do: [set('dopen', { eq: [{ event: 'newState' }, 'open'] })] }] } },
      node('sum', 'summary', { children: 'More' }),
      node('inside', 'p', { children: 'x' })),
    node('dlg', 'dialog', { id: 'dlg', behaviour: { on: [{ id: 'to', on: 'toggle', do: [set('mopen', { eq: [{ event: 'newState' }, 'open'] })] }] } },
      node('hi', 'p', { children: 'hi' })),
    node('open-dlg', 'button', { type: 'button', children: 'Open', behaviour: { noScript: 'show', on: [{ id: 'o', on: 'click', do: [{ dialog: 'dlg', op: 'showModal' }] }] } }),
    node('open-more', 'button', { type: 'button', children: 'Details', behaviour: { noScript: 'show', on: [{ id: 'o', on: 'click', do: [{ details: 'more', op: 'toggle' }] }] } }));

const combobox = (): StoredNode =>
  node('wrap', 'div', { behaviour: { state: [flag('open')] } },
    node('in', 'input', {
      role: 'combobox', 'aria-label': 'City', 'aria-controls': 'cities', type: 'text',
      behaviour: {
        bind: [{ attr: 'aria-expanded', from: { get: 'open' } }],
        on: [
          { id: 'i', on: 'input', do: [go('list', 'clear'), { filter: 'list', role: 'option', text: { event: 'value' } }, set('open', true)] },
          key('d', ['ArrowDown'], set('open', true), go('list', 'next')),
          key('u', ['ArrowUp'], set('open', true), go('list', 'prev')),
          { ...key('e', ['Enter'], { setProp: 'in', prop: 'value', value: { active: 'list' } }, set('open', false)), if: { get: 'open' } },
          { id: 'x', on: 'keydown', keys: ['Escape'], do: [set('open', false)] },
        ],
      },
    }),
    node('list', 'ul', {
      id: 'cities', role: 'listbox',
      behaviour: { showWhen: { state: 'open', eq: true }, group: { role: 'option', axis: 'line', wrap: true, virtual: { owner: 'in' } } },
    },
      node('o1', 'li', { id: 'o1', role: 'option', children: 'Bern' }),
      node('o2', 'li', { id: 'o2', role: 'option', children: 'Zurich' }),
      node('o3', 'li', { id: 'o3', role: 'option', children: 'Basel' })));

const grid = (): StoredNode => {
  const cell = (row: number, column: number) => node(`c${row}${column}`, 'td', { role: 'gridcell', children: `${row}${column}` });
  return edges(node('gr', 'table', {
    role: 'grid', 'aria-label': 'Numbers',
    behaviour: {
      group: { role: 'gridcell', axis: 'grid' },
      on: [
        key('r', ['ArrowRight'], go('gr', 'next')), key('l', ['ArrowLeft'], go('gr', 'prev')),
        key('d', ['ArrowDown'], go('gr', 'down')), key('u', ['ArrowUp'], go('gr', 'up')),
        key('h', ['Home', 'Ctrl+Home'], go('gr', 'first')), key('e', ['End', 'Ctrl+End'], go('gr', 'last')),
        key('pd', ['PageDown'], go('gr', 'page-down')), key('pu', ['PageUp'], go('gr', 'page-up')),
      ],
    },
  }, node('body', 'tbody', {}, ...[0, 1, 2].map((row) => node(`r${row}`, 'tr', { role: 'row' }, ...[0, 1, 2].map((column) => cell(row, column)))))));
};

const tree = (): StoredNode =>
  node('around', 'div', { behaviour: { state: [flag('b1', true)] } },
    node('shut', 'button', { type: 'button', children: 'Branch', behaviour: { noScript: 'show', on: [{ id: 't', on: 'click', do: [{ toggle: 'b1' }] }] } }),
    node('tr', 'ul', {
      role: 'tree', 'aria-label': 'Files',
      behaviour: {
        group: { role: 'treeitem', axis: 'tree' },
        on: [
          key('d', ['ArrowDown'], go('tr', 'next')), key('u', ['ArrowUp'], go('tr', 'prev')),
          key('r', ['ArrowRight'], go('tr', 'down')), key('l', ['ArrowLeft'], go('tr', 'up')),
          key('h', ['Home'], go('tr', 'first')), key('e', ['End'], go('tr', 'last')),
        ],
      },
    },
      node('fruit', 'li', { role: 'treeitem' },
        node('fruit-name', 'span', { children: 'Fruit' }),
        node('fruits', 'ul', { role: 'group', behaviour: { showWhen: { state: 'b1', eq: true } } },
          node('apple', 'li', { role: 'treeitem', children: 'Apple' }),
          node('pear', 'li', { role: 'treeitem', children: 'Pear' }))),
      node('veg', 'li', { role: 'treeitem', children: 'Veg' })));

/** A short silent sound, so media verbs have something real to act on. */
const silence = (): string => {
  const samples = 8000;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(128, 44);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
};

const press = (id: string, ...actions: unknown[]): StoredNode =>
  node(id, 'button', { type: 'button', children: id, behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: actions }] } });

const actions = (): StoredNode =>
  node('page-area', 'div', {},
    node('sound', 'audio', { src: silence(), preload: 'auto', controls: true }),
    press('play', { media: 'sound', op: 'play' }),
    press('pause', { media: 'sound', op: 'pause' }),
    press('seek', { media: 'sound', op: 'seek', value: 0.5 }),
    press('rate', { media: 'sound', op: 'rate', value: 2 }),
    press('volume', { media: 'sound', op: 'volume', value: 5 }),
    node('pane', 'div', { children: 'Pane' }),
    press('full', { fullscreen: 'pane', op: 'enter' }),
    node('field', 'input', { type: 'text', 'aria-label': 'Field' }),
    press('take-focus', { focus: 'field' }),
    node('tick', 'input', { type: 'checkbox', 'aria-label': 'Tick' }),
    press('check', { setProp: 'tick', prop: 'checked', value: true }, { setProp: 'field', prop: 'disabled', value: true }),
    node('sheet', 'form', {},
      node('shadow', 'input', { name: 'reset', type: 'text', defaultValue: 'first', 'aria-label': 'Shadow' })),
    press('clear', { form: 'sheet', op: 'reset' }),
    press('jump', { scroll: 'far', block: 'center' }),
    press('show-far', { effect: 'far' }),
    press('inside', { navigate: '/plain' }),
    press('outside', { navigate: 'https://example.invalid/away' }),
    node('gap', 'div', { style: { height: '3000px' } }),
    node('far', 'p', { children: 'Far', effects: { appear: { kind: 'fade' } } }));

/** A definition holding what `shared-by-many` places, with its own state per placement. */
export const COMPONENTS = {
  folding: {
    id: 'folding',
    name: 'Folding',
    inputs: [],
    states: [],
    page: {
      id: 'folding-page',
      slug: '',
      metadata: { title: 'Folding' },
      canvasNodes: {},
      appComponentTree: node('fold', 'details', {
        behaviour: {
          state: [flag('o')],
          bind: [{ attr: 'open', from: { get: 'all' } }],
          on: [{ id: 'seen', on: 'toggle', do: [{ set: 'o', value: { eq: [{ event: 'newState' }, 'open'] } }] }],
        },
      }, node('fold-name', 'summary', { children: 'More' })),
    },
  },
};

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

/** Placements share one trigger, as rows do, and one press opens all of them. */
export const OPENED = 300;

const sharedByMany = (): StoredNode =>
  node('shared', 'div', { behaviour: { state: [flag('all')] } },
    node('open-all', 'button', { type: 'button', children: 'All', behaviour: { noScript: 'show', on: [{ id: 'c', on: 'click', do: [{ toggle: 'all' }] }] } }),
    ...Array.from({ length: OPENED }, (_, index) => ({ id: `place-${index}`, type: '#component', componentType: 'host' as const, props: { component: 'folding', inputs: {} }, children: [] })));

/** Within the program cap, many small triggers each under their limit, and a long list to read. */
const stacked = (): StoredNode =>
  node('stacked', 'div', {},
    node('long', 'ul', {}, ...Array.from({ length: 2000 }, (_, index) => node(`i${index}`, 'li', { role: 'x', children: `item ${index}` }))),
    ...Array.from({ length: 30 }, (_, holder) => node(`h${holder}`, 'div', {
      behaviour: { on: Array.from({ length: 5 }, (__, trigger) => ({ id: `t${trigger}`, on: 'every', ms: 1000, do: Array.from({ length: 16 }, () => ({ filter: 'long', role: 'x', text: 'item' })) })) },
    })));

const sound = (): StoredNode =>
  node('sounds', 'div', { behaviour: { on: [{ id: 'p', on: 'every', ms: 1000, do: [{ media: 'clip', op: 'play' }] }] } },
    node('clip', 'audio', { src: silence(), preload: 'auto' }),
    pay());

/** Each timer tries to undo what a visitor set. The parser leaves none of them standing. */
const autoplayTimers = (): StoredNode =>
  node('playing', 'div', {
    behaviour: {
      on: [
        { id: 'l', on: 'every', ms: 1000, do: [{ media: 'clip', op: 'load' }] },
        { id: 'v', on: 'every', ms: 1000, do: [{ media: 'clip', op: 'volume', value: 1 }] },
        { id: 's', on: 'every', ms: 1000, do: [{ media: 'clip', op: 'seek', value: 0 }] },
        { id: 'r', on: 'every', ms: 1000, do: [{ media: 'clip', op: 'rate', value: 2 }] },
      ],
    },
  },
    node('clip', 'audio', { src: silence(), autoPlay: true, loop: true, preload: 'auto' }),
    pay());

const captures = { behaviour: { on: [{ id: 'p', on: 'pointerdown', do: [{ capturePointer: true }] }] } };

/** Its id tells site.ts to store this as the page's root, not inside one. */
const captureOnRoot = (): StoredNode => node('page-root', 'div', captures, pay());

const captureAround = (): StoredNode => node('around-pay', 'div', captures, pay());

const consent = (): StoredNode =>
  node('with-banner', 'div', { behaviour: { state: [flag('s')], on: [{ id: 'k', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ set: 's', value: false }] }] } }, pay());

/** A preset exactly as the palette's function returns it, as a page stores it. `data-t` is what a test reads. */
const preset = (at: PresetNode): StoredNode =>
  ({ id: at.id, type: at.type, componentType: 'host', props: { 'data-t': at.id, ...(at.props as Props) }, children: (at.children ?? []).map(preset) });

const presetPage = (...presets: PresetNode[]) => (): StoredNode => edges(...presets.map(preset));

const FOUR_TABS = [
  { title: 'Alpha', body: 'Alpha panel' },
  { title: 'Beta', body: 'Beta panel' },
  { title: 'Gamma', body: 'Gamma panel' },
];

/** A person's own trigger on the first tab, then a tab added: it has to survive the derive. */
function editedTabs(): PresetNode {
  const base = tabs({ seed: 'edited', items: FOUR_TABS });
  const mine = { id: 'mine', on: 'click', do: [{ set: 'edited-mine', value: true }] };
  const [list, ...rest] = base.children ?? [];
  const [first, ...others] = list.children ?? [];
  const withState = withProps(base, { behaviour: { ...behaviourOf(base), state: [...(behaviourOf(base).state ?? []), { id: 'edited-mine', name: 'Mine', type: 'boolean', initial: false }] } });
  const ownTab = withProps(first, { behaviour: { ...behaviourOf(first), on: [...(behaviourOf(first).on ?? []), mine] } });
  return addTab({ ...withState, children: [{ ...list, children: [ownTab, ...others] }, ...rest] }, { title: 'Delta', body: 'Delta panel' });
}

/** A phone gets the same nodes, so what matters there is whether they fit. */
const PRESET_PAGES: Readonly<Record<string, () => StoredNode>> = {
  'preset-tabs': presetPage(tabs({ seed: 'tabs', items: FOUR_TABS })),
  'preset-tabs-vertical': presetPage(tabs({ seed: 'tabs', items: FOUR_TABS, orientation: 'vertical' })),
  'preset-tabs-rtl': () => node('rtl', 'div', { dir: 'rtl', style: { direction: 'rtl' } }, preset(tabs({ seed: 'tabs', items: FOUR_TABS }))),
  'preset-tabs-twice': presetPage(tabs({ seed: 'one', items: FOUR_TABS }), tabs({ seed: 'two', items: FOUR_TABS })),
  'preset-tabs-nested': () => {
    const outer = tabs({ seed: 'outer', items: FOUR_TABS });
    const inner = tabs({ seed: 'inner', items: [{ title: 'Inner one', body: 'Inner panel one' }, { title: 'Inner two', body: 'Inner panel two' }] });
    const [list, first, ...panels] = outer.children ?? [];
    return preset({ ...outer, children: [list, { ...withProps(first, { children: undefined }), children: [inner] }, ...panels] });
  },
  'preset-tabs-edited': presetPage(editedTabs()),
  'preset-toolbar': presetPage(PRESETS.toolbar('tools')),
  'preset-tooltip': presetPage(PRESETS.tooltip('hint')),
  'preset-carousel': presetPage(addSlide(carousel({ seed: 'show' }), 'Fourth slide')),
  'preset-carousel-rotating': presetPage(carousel({ seed: 'show', rotateMs: 1000 })),
};

export const PAGES: Readonly<Record<string, () => StoredNode>> = {
  ...PRESET_PAGES,
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
  'autoplay-timers': autoplayTimers,
  'capture-on-root': captureOnRoot,
  'capture-around': captureAround,
  'shared-by-many': sharedByMany,
  timers,
  'slow-loop': slowLoop,
  consent,
  ordinary: () => ordinary(),
  'ordinary-all-chunks': () => ordinary(menuButton()),
  toolbar: () => toolbar(),
  'toolbar-rtl': () => toolbar('InlineEnd', 'InlineStart', { direction: 'rtl' }),
  feed,
  slider,
  splitter,
  tooltip,
  'menu-button': menuButton,
  natives,
  combobox,
  grid,
  tree,
  actions,
  stacked,
  sound,
};
