// The runtime's own rules, in the order the contract lists them. What only a browser can
// say (hydration, real input, chunks) is in test/behaviour/runtime.spec.ts.

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { applyBehaviour } from '@/lib/renderer/server/applyBehaviour';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { MAX_ACTIONS_PER_SECOND, MAX_ACTIONS_PER_TASK, MAX_PAGE_COST_PER_SECOND, MAX_UNPROMPTED_FIRINGS, startBehaviour } from '../runtime';
import { isTextEntry, keysAnswer } from '../keys';
import { GATE_GLOBAL } from '../names';
import { createVerbs } from '../verbs';
import type { BehaviourProgram, Kit, ProgramEntry } from '../program';

const settle = () => Promise.resolve().then(() => Promise.resolve());

const flag = (id: string, initial = false) => ({ id, type: 'boolean' as const, initial });
const count = (id: string, extra: object = {}) => ({ id, type: 'number' as const, initial: 0, ...extra });
const clickDoing = (...actions: unknown[]) => ({ id: 't', on: 'click', do: actions }) as NonNullable<ProgramEntry['on']>[number];

/** Written by hand here, with the parser's narrow types out of the way. */
type Nodes = Record<string, object>;

const program = (nodes: Nodes): BehaviourProgram => ({
  nodes: Object.fromEntries(Object.entries(nodes).map(([key, entry]) => [key, (Array.isArray(entry) ? entry : [entry]) as ProgramEntry[]])),
});

/** A tree stored as an author could, through the real parser, with what it let through started. */
function fromStored(root: object): void {
  const compiled = applyBehaviour(root as ComponentNode);
  document.body.innerHTML = renderToStaticMarkup(renderComponentNode(compiled.root));
  if (compiled.program) stops.push(startBehaviour({ container: document, program: compiled.program, surface: 'preview', verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
}

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;
const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

let warn: MockInstance;
let error: MockInstance;
let stops: (() => void)[];

/** Starts the runtime on `html` as the published page would. */
function start(html: string, nodes: Nodes, surface: 'published' | 'preview' | 'canvas' = 'preview'): void {
  document.body.innerHTML = html;
  stops.push(startBehaviour({ container: document, program: program(nodes), surface, verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
}

function setGate(ready = true) {
  const gate = { queue: [] as Event[], ready: vi.fn(() => ready), fail: vi.fn() };
  (window as unknown as Record<string, unknown>)[GATE_GLOBAL] = gate;
  return gate;
}

beforeEach(() => {
  stops = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stops.forEach((stop) => stop());
  delete (window as unknown as Record<string, unknown>)[GATE_GLOBAL];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('state', () => {
  it('writes a state to its scope at once and bindings at the end of the task', async () => {
    start('<div data-fc-n="s" data-fc-scope data-fcs-a="false"><button data-fc-n="b" aria-expanded="false"></button></div>', {
      s: { state: [flag('a')] },
      b: { on: [clickDoing({ toggle: 'a' })], bind: [{ attr: 'aria-expanded', from: { get: 'a' } }] },
    });
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
    await settle();
    expect($('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('writes no attribute for text, so what a person typed reaches no selector', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [{ id: 't', type: 'text', initial: '' }] },
      b: { on: [clickDoing({ set: 't', value: 'secret' })] },
    });
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-t')).toBeNull();
  });

  it('steps a number by its step inside its bounds, and wraps when asked', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="up"></button><button data-fc-n="round"></button></div>', {
      s: { state: [count('n', { step: 2, min: 0, max: 4 })] },
      up: { on: [clickDoing({ step: 'n' })] },
      round: { on: [clickDoing({ step: 'n', wrap: true })] },
    });
    const value = () => $('[data-fc-scope]').getAttribute('data-fcs-n');
    for (let i = 0; i < 3; i += 1) $('[data-fc-n="up"]').click();
    expect(value()).toBe('4');
    $('[data-fc-n="round"]').click();
    expect(value()).toBe('0');
  });

  it('keeps a step free of floating point noise, which would miss a condition', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [count('n', { step: 0.1 })] },
      b: { on: [clickDoing({ step: 'n' }, { step: 'n' }, { step: 'n' })] },
    });
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('0.3');
  });

  it('cycles a choice through its options, and stops at the end without wrap', () => {
    const options = ['a', 'b', 'c'];
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="on"></button><button data-fc-n="round"></button></div>', {
      s: { state: [{ id: 'c', type: 'choice', initial: 'a', options }] },
      on: { on: [clickDoing({ step: 'c' })] },
      round: { on: [clickDoing({ step: 'c', wrap: true })] },
    });
    const value = () => $('[data-fc-scope]').getAttribute('data-fcs-c');
    $('[data-fc-n="on"]').click();
    $('[data-fc-n="on"]').click();
    $('[data-fc-n="on"]').click();
    expect(value()).toBe('c');
    $('[data-fc-n="round"]').click();
    expect(value()).toBe('a');
  });

  it('gives a text value no more than its maxLength', async () => {
    start('<div data-fc-n="s" data-fc-scope><input data-fc-n="i" value="abcdef"><p data-fc-n="o">x</p></div>', {
      s: { state: [{ id: 't', type: 'text', initial: '', maxLength: 3 }] },
      i: { on: [{ id: 't', on: 'input', do: [{ set: 't', value: { event: 'value' } }] }] },
      o: { bind: [{ text: { get: 't' } }] },
    });
    $('input').dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect($('p').textContent).toBe('abc');
  });
});

describe('what a value may become', () => {
  const ranged = (extra: object = {}) => ({
    s: { state: [count('n', extra)] },
    r: { on: [{ id: 't', on: 'input', do: [{ set: 'n', value: { event: 'value' } }] }] },
  });

  it('reads a range as a number through Number', () => {
    start('<div data-fc-n="s" data-fc-scope><input data-fc-n="r" type="range" min="0" max="10" value="7"></div>', ranged());
    $('input').dispatchEvent(new Event('input', { bubbles: true }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('7');
  });

  it('clamps a number to its min and max, whatever wrote it', () => {
    start('<div data-fc-n="s" data-fc-scope><input data-fc-n="r" type="range" min="0" max="10" value="7"></div>', ranged({ max: 5 }));
    $('input').dispatchEvent(new Event('input', { bubbles: true }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('5');
  });

  it.each([['text', 'abc'], ['empty', ''], ['spaces', '  ']])('drops a value that is no finite number: %s', (_, value) => {
    start(`<div data-fc-n="s" data-fc-scope data-fcs-n="0"><input data-fc-n="r" value="${value}"></div>`, ranged());
    $('input').dispatchEvent(new Event('input', { bubbles: true }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('0');
  });

  it('drops a sum that is not finite, and writes no custom property from it', async () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b" style="--u-x:1px"></button></div>', {
      s: { state: [{ id: 'c', type: 'choice', initial: 'a', options: ['a', 'b'] }] },
      b: { bind: [{ cssVar: '--u-x', from: { add: [{ map: 'c', cases: { b: 1 } }, 1] }, unit: 'px' }] },
    });
    await settle();
    expect($('button').style.getPropertyValue('--u-x')).toBe('1px');
  });

  it('keeps a choice to its options, and an event value cannot leave them', () => {
    start('<div data-fc-n="s" data-fc-scope data-fcs-c="a"><select data-fc-n="p"><option>a</option><option>b</option><option>evil</option></select></div>', {
      s: { state: [{ id: 'c', type: 'choice', initial: 'a', options: ['a', 'b'] }] },
      p: { on: [{ id: 't', on: 'change', do: [{ set: 'c', value: { event: 'value' } }] }] },
    });
    const select = $('select') as HTMLSelectElement;
    select.value = 'b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-c')).toBe('b');
    select.value = 'evil';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-c')).toBe('b');
  });

  it('reads the value of the node holding the trigger, never of what fired inside it', async () => {
    start('<div data-fc-n="s" data-fc-scope><div data-fc-n="w"><input value="typed"></div><p data-fc-n="o">first</p></div>', {
      s: { state: [{ id: 't', type: 'text', initial: 'first' }] },
      w: { on: [{ id: 't', on: 'input', do: [{ set: 't', value: { event: 'value' } }] }] },
      o: { bind: [{ text: { get: 't' } }] },
    });
    $('input').dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect($('p').textContent).toBe('first');
  });

  it('reads map cases as own keys, so a value naming what every object has finds the default', async () => {
    start('<div data-fc-n="s" data-fc-scope><p data-fc-n="o">x</p></div>', {
      s: { state: [{ id: 't', type: 'text', initial: 'constructor' }] },
      o: { bind: [{ text: { map: 't', cases: { a: 'hit' }, default: 'fallback' } }] },
    });
    await settle();
    expect($('p').textContent).toBe('fallback');
  });
});

describe('bindings', () => {
  it('sets and removes a boolean attribute, and writes text only where it is the one child', async () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button><p data-fc-n="o">x</p><p data-fc-n="held"><b>kept</b></p></div>', {
      s: { state: [flag('a', true)] },
      b: { on: [clickDoing({ toggle: 'a' })], bind: [{ attr: 'disabled', from: { get: 'a' } }, { attr: 'data-u-a', from: { get: 'a' } }] },
      o: { bind: [{ text: { get: 'a' } }] },
      held: { bind: [{ text: { get: 'a' } }] },
    });
    await settle();
    expect($('button').hasAttribute('disabled')).toBe(true);
    expect($('[data-fc-n="o"]').textContent).toBe('true');
    expect($('[data-fc-n="held"]').innerHTML).toBe('<b>kept</b>');
    $('button').removeAttribute('disabled');
    $('button').click();
    await settle();
    expect($('button').hasAttribute('disabled')).toBe(false);
    expect($('button').getAttribute('data-u-a')).toBe('false');
  });

  it('puts a value on a field a person has already changed', async () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button><input data-fc-n="i" value="0"></div>', {
      s: { state: [count('n')] },
      b: { on: [clickDoing({ set: 'n', value: 5 })] },
      i: { bind: [{ attr: 'value', from: { get: 'n' } }] },
    });
    ($('input') as HTMLInputElement).value = '9';
    $('button').click();
    await settle();
    expect(($('input') as HTMLInputElement).value).toBe('5');
  });

  it('writes a custom property with its unit', async () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [count('n')] },
      b: { on: [clickDoing({ set: 'n', value: 30 })], bind: [{ cssVar: '--u-split', from: { get: 'n' }, unit: '%' }] },
    });
    $('button').click();
    await settle();
    expect($('button').style.getPropertyValue('--u-split')).toBe('30%');
  });
});

describe('targets and scopes', () => {
  it('keeps each row to its own state', () => {
    const row = (i: number) => `<li data-fc-n="r" data-fc-scope data-fc-i="${i}"><button data-fc-n="b"></button></li>`;
    start(`<ul>${[0, 1, 2].map(row).join('')}</ul>`, { r: { state: [flag('a')] }, b: { on: [clickDoing({ toggle: 'a' })] } });
    document.querySelectorAll('button')[1].click();
    expect([...document.querySelectorAll('li')].map((li) => li.getAttribute('data-fcs-a'))).toEqual([null, 'true', null]);
  });

  it('keeps two placements of one definition apart, though they share a key and have no row', () => {
    const placement = '<article data-fc-n="card" data-fc-scope><button data-fc-n="b"></button></article>';
    start(placement + placement, { card: { state: [flag('a')] }, b: { on: [clickDoing({ toggle: 'a' })] } });
    document.querySelectorAll('button')[1].click();
    expect([...document.querySelectorAll('article')].map((el) => el.getAttribute('data-fcs-a'))).toEqual([null, 'true']);
  });

  it('runs the entry data-fc-v names, on a key shared by nodes that differ', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button><button data-fc-n="b" data-fc-v="1"></button></div>', {
      s: { state: [count('n')] },
      b: [{ on: [clickDoing({ set: 'n', value: 1 })] }, { on: [clickDoing({ set: 'n', value: 2 })] }],
    });
    document.querySelectorAll('button')[1].click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('2');
  });

  it('reads the row in a condition and in an expression', () => {
    const row = (i: number) => `<li data-fc-scope data-fc-i="${i}"><button data-fc-n="b"></button></li>`;
    start(`<ul data-fc-n="s" data-fc-scope>${[0, 1, 2].map(row).join('')}</ul>`, {
      s: { state: [count('n')] },
      b: { on: [{ ...clickDoing({ set: 'n', value: { add: [{ row: 'index' }, 10] } }), if: { not: { state: 'n', eq: { row: 'index' } } } }] },
    });
    document.querySelectorAll('button')[2].click();
    expect($('ul').getAttribute('data-fcs-n')).toBe('12');
  });

  it('gives a scope an island remounted its values back, and its bindings', async () => {
    const scope = '<div data-fc-n="s" data-fc-scope data-fcs-a="false"><button data-fc-n="b" aria-pressed="false"></button></div>';
    start(`<section>${scope}</section>`, {
      s: { state: [flag('a')] },
      b: { on: [clickDoing({ toggle: 'a' })], bind: [{ attr: 'aria-pressed', from: { get: 'a' } }] },
    });
    $('button').click();
    await settle();
    $('section').innerHTML = scope;
    await new Promise((resolve) => setTimeout(resolve));
    await settle();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
    expect($('button').getAttribute('aria-pressed')).toBe('true');
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('false');
  });
});

describe('keys and fields', () => {
  const wrapper = (extra = '') => `<div data-fc-n="s" data-fc-scope data-fcs-n="0">${extra}<input id="f"><textarea id="a"></textarea><div id="e" contenteditable="true"></div><input id="r" type="checkbox"><button id="b"></button></div>`;
  const stepOn = (trigger: object) => ({ s: { state: [count('n')], on: [{ id: 't', on: 'keydown', do: [{ step: 'n' }], ...trigger }] } });
  const value = () => $('[data-fc-scope]').getAttribute('data-fcs-n');

  it.each(['#f', '#a', '#e'])('fires no keydown with no keys from a real field in a wrapper: %s', (selector) => {
    start(wrapper(), stepOn({}));
    // jsdom has no isContentEditable, so it is given as the browser would.
    Object.defineProperty($('#e'), 'isContentEditable', { value: true });
    press($(selector), 'h');
    press($(selector), ' ');
    expect(value()).toBe('0');
  });

  it.each([['Printable'], ['a'], ['Space'], ['Shift+a']])('fires no printable chord %s from a field', (chord) => {
    start(wrapper(), stepOn({ keys: [chord] }));
    press($('#f'), 'a');
    press($('#f'), ' ');
    press($('#f'), 'A', { shiftKey: true });
    expect(value()).toBe('0');
  });

  it('counts an unnamed key as typing, as an input method or a virtual keyboard sends', () => {
    start(wrapper(), stepOn({}));
    for (const key of ['Dead', 'Process', 'Unidentified']) press($('#f'), key);
    expect(value()).toBe('0');
  });

  it('fires nothing during a composition, even on a named key', () => {
    start(wrapper(), stepOn({ keys: ['Enter'] }));
    press($('#f'), 'Enter', { isComposing: true });
    expect(value()).toBe('0');
    press($('#f'), 'Enter');
    expect(value()).toBe('1');
  });

  it('lets a named key through from a field, and any key from what is no field', () => {
    start(wrapper(), stepOn({}));
    press($('#f'), 'ArrowDown');
    expect(value()).toBe('1');
    press($('#b'), 'h');
    expect(value()).toBe('2');
    press($('#r'), 'h');
    expect(value()).toBe('3');
  });

  it('matches modifiers exactly', () => {
    start(wrapper(), stepOn({ keys: ['Ctrl+End'] }));
    press($('#b'), 'End');
    expect(value()).toBe('0');
    press($('#b'), 'End', { ctrlKey: true, shiftKey: true });
    expect(value()).toBe('0');
    press($('#b'), 'End', { ctrlKey: true });
    expect(value()).toBe('1');
  });

  it('resolves InlineEnd against the writing direction', () => {
    start(`<div dir="rtl" style="direction:rtl">${wrapper()}</div>`, stepOn({ keys: ['InlineEnd'] }));
    press($('#b'), 'ArrowRight');
    expect(value()).toBe('0');
    press($('#b'), 'ArrowLeft');
    expect(value()).toBe('1');
  });

  it('prevents only what matched', () => {
    start(wrapper(), stepOn({ keys: ['ArrowDown'], prevent: true }));
    expect(press($('#b'), 'ArrowUp')).toBe(true);
    expect(press($('#b'), 'ArrowDown')).toBe(false);
  });
});

describe('the run-time budget', () => {
  it('stops a task at 256 actions, turns the trigger off and warns once', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [count('n')] },
      b: {
        on: [
          clickDoing({ emit: 'a' }),
          { id: 'fan', on: 'custom:a', do: Array.from({ length: 16 }, () => ({ emit: 'b' })) },
          { id: 'fan2', on: 'custom:b', do: Array.from({ length: 16 }, () => ({ emit: 'c' })) },
          { id: 'end', on: 'custom:c', do: Array.from({ length: 16 }, () => ({ step: 'n' })) },
        ],
      },
    });
    $('button').click();
    expect(Number($('[data-fc-scope]').getAttribute('data-fcs-n'))).toBeLessThanOrEqual(MAX_ACTIONS_PER_TASK);
    const warnings = warn.mock.calls.filter(([message]) => String(message).includes('ran too often'));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(new Set(warnings.map(([, id]) => id)).size).toBe(warnings.length);
  });

  it('turns off a trigger that runs 2,000 actions in a second across tasks', async () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [count('n')] },
      b: { on: [clickDoing(...Array.from({ length: 16 }, () => ({ step: 'n' })))] },
    });
    for (let i = 0; i < 200; i += 1) {
      $('button').click();
      await settle();
    }
    expect(Number($('[data-fc-scope]').getAttribute('data-fcs-n'))).toBeLessThanOrEqual(MAX_ACTIONS_PER_SECOND);
    expect(warn.mock.calls.some(([message]) => String(message).includes('ran too often'))).toBe(true);
  });

  it('charges nothing for what changes nothing, so Escape can reach 500 closed rows', () => {
    const rows = Array.from({ length: 500 }, (_, i) => `<li data-fc-n="r" data-fc-scope data-fc-i="${i}"></li>`).join('');
    start(`<ul>${rows}</ul><button id="other"></button>`, {
      r: {
        state: [flag('open')],
        on: [{ id: 'esc', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ cancel: 'tip' }, { set: 'open', value: false }] }],
      },
    });
    press($('#other'), 'Escape');
    press($('#other'), 'Escape');
    expect(warn.mock.calls.some(([message]) => String(message).includes('ran too often'))).toBe(false);
  });

  it('carries emit depth across a delay, and stops at 4', () => {
    vi.useFakeTimers();
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [count('n')] },
      b: {
        on: [
          clickDoing({ emit: 'go' }),
          { id: 'go', on: 'custom:go', do: [{ step: 'n' }, { delay: 16, do: [{ emit: 'go' }] }] },
        ],
      },
    });
    $('button').click();
    vi.advanceTimersByTime(1000);
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('4');
    expect(warn.mock.calls.some(([message]) => String(message).includes('too deep'))).toBe(true);
  });
});

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const tip = {
    s: { state: [flag('tip')] },
    b: {
      on: [
        { id: 'in', on: 'click', do: [{ delay: 100, key: 'k', do: [{ set: 'tip', value: true }] }] },
        { id: 'stop', on: 'keydown', keys: ['Escape'], do: [{ cancel: 'k' }] },
      ],
    },
  };
  const held = () => $('[data-fc-scope]').getAttribute('data-fcs-tip');

  it('replaces a pending delay of the same key', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', tip);
    $('button').click();
    vi.advanceTimersByTime(90);
    $('button').click();
    vi.advanceTimersByTime(90);
    expect(held()).toBeNull();
    vi.advanceTimersByTime(10);
    expect(held()).toBe('true');
  });

  it('cancels', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', tip);
    $('button').click();
    press($('button'), 'Escape');
    vi.advanceTimersByTime(200);
    expect(held()).toBeNull();
  });

  it('keeps a key to its own row', () => {
    const row = (i: number) => `<li data-fc-n="r" data-fc-scope data-fc-i="${i}"><button data-fc-n="b"></button></li>`;
    start(`<ul>${[0, 1].map(row).join('')}</ul>`, { r: tip.s, b: tip.b });
    document.querySelectorAll('button').forEach((button) => button.click());
    vi.advanceTimersByTime(100);
    expect([...document.querySelectorAll('li')].map((li) => li.getAttribute('data-fcs-tip'))).toEqual(['true', 'true']);
  });

  it('runs nothing after the cleanup', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', tip);
    $('button').click();
    stops.splice(0).forEach((stop) => stop());
    vi.advanceTimersByTime(200);
    expect(held()).toBeNull();
    $('button').click();
    vi.advanceTimersByTime(200);
    expect(held()).toBeNull();
  });
});

describe('a modal no press asked for', () => {
  const dialogs: HTMLDialogElement[] = [];

  beforeEach(() => {
    dialogs.length = 0;
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      dialogs.push(this);
      this.open = true;
    });
  });

  // One document lives through this file, and the rule is per page load, so each test
  // opens its own: an iframe's document is what the flag is keyed on.
  const inFrame = (html: string, nodes: Nodes, surface: 'published' | 'canvas' = 'published') => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const inner = frame.contentDocument as Document;
    (frame.contentWindow as unknown as { HTMLDialogElement: typeof HTMLDialogElement }).HTMLDialogElement.prototype.showModal = HTMLDialogElement.prototype.showModal;
    inner.body.innerHTML = html;
    stops.push(startBehaviour({ container: inner, program: program(nodes), surface, verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
    return inner;
  };
  const once = {
    d: {},
    p: { on: [{ id: 'r', on: 'page-ready', do: [{ dialog: 'd', op: 'showModal' as const }] }] },
    b: { on: [clickDoing({ dialog: 'd', op: 'showModal' })] },
  };
  const page = '<dialog data-fc-n="d"></dialog><p data-fc-n="p"></p><button data-fc-n="b"></button>';

  it('runs once per page load from page-ready', () => {
    inFrame(page, once);
    expect(dialogs).toHaveLength(1);
  });

  it('does not run a second time, whatever brings it back round', () => {
    let report: (records: { target: Element; isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof report) {
        report = callback;
      }

      observe() {}

      disconnect() {}
    });
    const inner = inFrame('<dialog data-fc-n="d"></dialog><p data-fc-n="p"></p>', {
      d: {},
      p: { on: [{ id: 'view', on: 'view-enter', do: [{ dialog: 'd', op: 'showModal' }] }] },
    });
    const dialog = inner.querySelector('dialog') as HTMLDialogElement;
    const sentinel = inner.querySelector('p') as Element;
    for (let i = 0; i < 3; i += 1) {
      dialog.open = false;
      report([{ target: sentinel, isIntersecting: true }]);
      report([{ target: sentinel, isIntersecting: false }]);
    }
    expect(dialogs).toHaveLength(1);
  });

  it('never holds back a press', () => {
    const inner = inFrame(page, once);
    const dialog = inner.querySelector('dialog') as HTMLDialogElement;
    for (let i = 0; i < 3; i += 1) {
      dialog.open = false;
      (inner.querySelector('button') as HTMLButtonElement).click();
    }
    expect(dialogs).toHaveLength(4);
  });

  it('does not run on the canvas at all', () => {
    inFrame(page, once, 'canvas');
    expect(dialogs).toHaveLength(0);
  });

  it('costs its verb alone when the browser refuses', () => {
    HTMLDialogElement.prototype.showModal = () => { throw new DOMException('no', 'InvalidStateError'); };
    start(`<div data-fc-n="s" data-fc-scope>${page}</div>`, {
      s: { state: [flag('a')] },
      d: {},
      b: { on: [clickDoing({ dialog: 'd', op: 'showModal' }, { set: 'a', value: true })] },
    });
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('the boot script', () => {
  const page = '<div data-fc-n="s" data-fc-scope data-fcs-a="false"><button data-fc-n="b"></button><button id="none"></button><input data-fc-n="i"></div>';
  const nodes = {
    s: { state: [flag('a'), count('n')] },
    b: { on: [clickDoing({ toggle: 'a' }, { dialog: 'd', op: 'showModal' }, { emit: 'x' }, { delay: 16, do: [{ step: 'n' }] }, { step: 'n' }), { id: 'k', on: 'keydown', do: [{ step: 'n' }] }] },
    i: {},
  };

  it('reports ready, and replays a held press for state verbs only', () => {
    const gate = setGate();
    document.body.innerHTML = page;
    gate.queue.push(Object.defineProperty(new MouseEvent('click', { bubbles: true }), 'target', { value: $('[data-fc-n="b"]') }));
    HTMLDialogElement.prototype.showModal = vi.fn();
    stops.push(startBehaviour({ container: document, program: program(nodes), surface: 'published', verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
    expect(gate.ready).toHaveBeenCalledOnce();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('1');
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    expect(gate.queue).toEqual([]);
  });

  it('reads a press that triggered nothing as nothing', () => {
    const gate = setGate();
    document.body.innerHTML = page;
    gate.queue.push(Object.defineProperty(new MouseEvent('click', { bubbles: true }), 'target', { value: $('#none') }));
    stops.push(startBehaviour({ container: document, program: program(nodes), surface: 'published', verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('false');
  });

  it('replays no key from a text entry control', () => {
    const gate = setGate();
    document.body.innerHTML = '<div data-fc-n="s" data-fc-scope><input id="f"></div>';
    gate.queue.push(Object.defineProperty(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), 'target', { value: $('#f') }));
    stops.push(startBehaviour({
      container: document,
      program: program({ s: { state: [count('n')], on: [{ id: 'k', on: 'keydown', keys: ['Enter'], do: [{ step: 'n' }] }] } }),
      surface: 'published',
    }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBeNull();
  });

  it('skips a press on what is gone', () => {
    const gate = setGate();
    document.body.innerHTML = page;
    const gone = $('[data-fc-n="b"]');
    gate.queue.push(Object.defineProperty(new MouseEvent('click', { bubbles: true }), 'target', { value: gone }));
    gone.remove();
    stops.push(startBehaviour({ container: document, program: program(nodes), surface: 'published', verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('false');
  });

  it('stands down when the gate may not go up again, listening to nothing', () => {
    setGate(false);
    start(page, nodes, 'published');
    $('[data-fc-n="b"]').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('false');
  });

  it('catches up with what was opened before it started, which fired a toggle nobody heard', () => {
    setGate();
    start('<div data-fc-n="s" data-fc-scope><details data-fc-n="d" open></details></div>', {
      s: { state: [flag('o')] },
      d: { on: [{ id: 't', on: 'toggle', do: [{ set: 'o', value: { eq: [{ event: 'newState' }, 'open'] } }] }] },
    }, 'published');
    expect($('[data-fc-scope]').getAttribute('data-fcs-o')).toBe('true');
  });
});

describe('it never throws at the page', () => {
  it('warns once for what it cannot find, and goes on', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [flag('a')] },
      b: { on: [clickDoing({ set: 'gone', value: 1 }, { nonsense: true }, { dialog: 'gone', op: 'close' }, { set: 'a', value: true })] },
    });
    $('button').click();
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('stops, lowers the gate and reports an error it did not expect', () => {
    const gate = setGate();
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', {
      s: { state: [flag('a')] },
      b: { on: [clickDoing({ toggle: 'a' })] },
    }, 'published');
    vi.spyOn(window.performance, 'now').mockImplementation(() => { throw new Error('broken'); });
    expect(() => $('button').click()).not.toThrow();
    expect(gate.fail).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    $('button').click();
    expect(gate.fail).toHaveBeenCalledOnce();
  });

  it('reports a failure on the way up the same way', () => {
    const gate = setGate();
    document.body.innerHTML = '<div data-fc-n="s" data-fc-scope></div>';
    const broken = { nodes: { s: [{ get on(): never { throw new Error('broken'); } }] } } as unknown as BehaviourProgram;
    expect(() => stops.push(startBehaviour({ container: document, program: broken, surface: 'published' }))).not.toThrow();
    expect(gate.fail).toHaveBeenCalledOnce();
  });
});

describe('events', () => {
  it('walks up as far as an event bubbles, and stays on its target when it does not', () => {
    start('<div data-fc-n="s" data-fc-scope><div data-fc-n="w"><input data-fc-n="i"></div></div>', {
      s: { state: [count('bubbled'), count('stayed')] },
      w: { on: [{ id: 'a', on: 'click', do: [{ step: 'bubbled' }] }, { id: 'b', on: 'focus', do: [{ step: 'stayed' }] }] },
      i: {},
    });
    $('input').click();
    $('input').dispatchEvent(new FocusEvent('focus'));
    expect($('[data-fc-scope]').getAttribute('data-fcs-bubbled')).toBe('1');
    expect($('[data-fc-scope]').getAttribute('data-fcs-stayed')).toBeNull();
  });

  it('hears a non-bubbling event on the node it fired on, by capture', () => {
    start('<div data-fc-n="s" data-fc-scope><img data-fc-n="i" alt=""></div>', {
      s: { state: [flag('a')] },
      i: { on: [{ id: 'l', on: 'load', do: [{ set: 'a', value: true }] }] },
    });
    $('img').dispatchEvent(new Event('load'));
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
  });

  it('runs a trigger on the document for every element holding it, and from anywhere', () => {
    start('<li data-fc-n="r" data-fc-scope data-fc-i="0"></li><li data-fc-n="r" data-fc-scope data-fc-i="1"></li><button id="x"></button>', {
      r: { state: [flag('a')], on: [{ id: 'e', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ set: 'a', value: true }] }] },
    });
    press($('#x'), 'Escape');
    expect([...document.querySelectorAll('li')].map((li) => li.getAttribute('data-fcs-a'))).toEqual(['true', 'true']);
  });

  it('reads a selection from where it stands', () => {
    start('<div data-fc-n="s" data-fc-scope><p data-fc-n="p">text</p></div>', {
      s: { state: [flag('a')], on: [{ id: 's', on: 'selectionchange', do: [{ set: 'a', value: true }] }] },
      p: {},
    });
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 1; });
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    const selection = document.getSelection() as Selection;
    selection.selectAllChildren($('p'));
    document.dispatchEvent(new Event('selectionchange'));
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
  });

  describe('of high frequency', () => {
    let frames: FrameRequestCallback[];

    beforeEach(() => {
      frames = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) => {
        frames.push(run);
        return frames.length;
      });
    });

    const moves = {
      s: { state: [count('n'), flag('down')] },
      b: {
        on: [
          { id: 'm', on: 'pointermove', do: [{ step: 'n' }] },
          { id: 'u', on: 'pointerup', do: [{ set: 'down', value: { gt: [{ get: 'n' }, 0] } }] },
        ],
      },
    };
    const move = (el: Element, type = 'pointermove') => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));

    it('runs once a frame, with the last event', () => {
      start('<div data-fc-n="s" data-fc-scope><div data-fc-n="b"></div></div>', moves);
      for (let i = 0; i < 5; i += 1) move($('[data-fc-n="b"]'));
      expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBeNull();
      expect(frames).toHaveLength(1);
      frames[0](0);
      expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('1');
    });

    it('runs what waits for a frame before a release, so the last move counts', () => {
      start('<div data-fc-n="s" data-fc-scope><div data-fc-n="b"></div></div>', moves);
      move($('[data-fc-n="b"]'));
      move($('[data-fc-n="b"]'), 'pointerup');
      expect($('[data-fc-scope]').getAttribute('data-fcs-down')).toBe('true');
    });

    it('does not batch a trigger that prevents, which has to answer before the event ends', () => {
      const add = vi.spyOn(document, 'addEventListener');
      start('<div data-fc-n="b"></div>', { b: { on: [{ id: 'd', on: 'dragover', prevent: true, do: [{ emit: 'x' }] }] } });
      expect(move($('[data-fc-n="b"]'), 'dragover')).toBe(false);
      expect(add.mock.calls.find(([type]) => type === 'dragover')?.[2]).toMatchObject({ capture: true, passive: false });
    });

    it('listens passively otherwise', () => {
      const add = vi.spyOn(document, 'addEventListener');
      start('<div data-fc-n="b"></div>', { b: { on: [{ id: 'w', on: 'wheel', do: [{ emit: 'x' }] }] } });
      expect(add.mock.calls.find(([type]) => type === 'wheel')?.[2]).toMatchObject({ capture: true, passive: true });
    });
  });
});

describe('pseudo events', () => {
  let observed: Element[];
  let report: (records: { target: Element; isIntersecting: boolean }[]) => void;

  beforeEach(() => {
    observed = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof report) {
        report = callback;
      }

      observe(el: Element) {
        observed.push(el);
      }

      disconnect() {
        observed = [];
      }
    });
  });

  it('fires page-ready once', () => {
    start('<div data-fc-n="s" data-fc-scope></div>', { s: { state: [count('n')], on: [{ id: 'p', on: 'page-ready', do: [{ step: 'n' }] }] } });
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBe('1');
  });

  it('fires view-enter and view-leave, and no leave for what was never in view', () => {
    start('<div data-fc-n="s" data-fc-scope></div>', {
      s: { state: [count('n')], on: [{ id: 'i', on: 'view-enter', do: [{ step: 'n', by: 1 }] }, { id: 'o', on: 'view-leave', do: [{ step: 'n', by: 10 }] }] },
    });
    const el = $('[data-fc-scope]');
    expect(observed).toEqual([el]);
    report([{ target: el, isIntersecting: false }]);
    expect(el.getAttribute('data-fcs-n')).toBeNull();
    report([{ target: el, isIntersecting: true }]);
    expect(el.getAttribute('data-fcs-n')).toBe('1');
    report([{ target: el, isIntersecting: false }]);
    expect(el.getAttribute('data-fcs-n')).toBe('11');
  });

  describe('every', () => {
    const ticking = { s: { state: [count('n')], on: [{ id: 'e', on: 'every', ms: 1000, do: [{ step: 'n' }] }] } };
    const value = () => $('[data-fc-scope]').getAttribute('data-fcs-n');

    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('runs at its interval', () => {
      start('<div data-fc-n="s" data-fc-scope></div>', ticking);
      vi.advanceTimersByTime(3000);
      expect(value()).toBe('3');
    });

    it('pauses while the page is hidden', () => {
      start('<div data-fc-n="s" data-fc-scope></div>', ticking);
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      vi.advanceTimersByTime(3000);
      expect(value()).toBeNull();
    });

    it('does not run under reduced motion', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      window.matchMedia = globalThis.matchMedia;
      start('<div data-fc-n="s" data-fc-scope></div>', ticking);
      vi.advanceTimersByTime(3000);
      expect(value()).toBeNull();
      delete (window as Partial<Window>).matchMedia;
    });

    it('stops with its element', () => {
      start('<section><div data-fc-n="s" data-fc-scope></div></section>', ticking);
      const el = $('[data-fc-scope]');
      el.remove();
      vi.advanceTimersByTime(3000);
      expect(el.getAttribute('data-fcs-n')).toBeNull();
    });
  });
});

describe('in a frame of its own', () => {
  const frames = '<section id="one"><div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div></section><section id="two"><div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div></section>';
  const nodes = {
    s: { state: [flag('a'), count('n')], on: [{ id: 'e', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ step: 'n' }] }] },
    b: { on: [clickDoing({ toggle: 'a' })] },
  };
  const scope = (frame: string) => $(`#${frame} [data-fc-scope]`);

  beforeEach(() => {
    document.body.innerHTML = frames;
    for (const id of ['one', 'two']) stops.push(startBehaviour({ container: $(`#${id}`), program: program(nodes), surface: 'canvas', keys: { keysAnswer, isTextEntry } }));
  });

  it('keeps each frame to its own state', () => {
    $('#two button').click();
    expect(scope('one').getAttribute('data-fcs-a')).toBeNull();
    expect(scope('two').getAttribute('data-fcs-a')).toBe('true');
  });

  it('runs a page-wide trigger once, and only for the frame the event is in', () => {
    press($('#two button'), 'Escape');
    expect(scope('one').getAttribute('data-fcs-n')).toBeNull();
    expect(scope('two').getAttribute('data-fcs-n')).toBe('1');
  });
});

describe('a form holding a field named after what the runtime reads', () => {
  const MEMBERS = ['parentElement', 'closest', 'getAttribute', 'hasAttribute', 'matches', 'setAttribute', 'children', 'nodeType', 'isConnected', 'querySelector'];
  const inForm = (member: string, attribute: string) => `<div data-fc-n="s" data-fc-scope data-fcs-n="0"><form data-fc-n="f" data-fc-scope data-fcs-m="0"><input ${attribute}="${member}"><button type="button" data-fc-n="b"></button></form></div>`;
  const nodes = {
    s: { state: [count('n')] },
    f: { state: [count('m')], on: [{ id: 'f', on: 'click', do: [{ step: 'm' }, { delay: 16, key: 'k', do: [] }] }] },
    b: { on: [clickDoing({ step: 'n' }, { emit: 'x' }), { id: 'x', on: 'custom:x', do: [{ cancel: 'k' }] }] },
  };

  it.each(MEMBERS.flatMap((member) => [[member, 'id'], [member, 'name']]))('walks past a form field called %s, by its %s', (member, attribute) => {
    document.body.innerHTML = inForm(member, attribute);
    const form = document.querySelector('form') as HTMLFormElement;
    // A browser answers `form[member]` with the field. jsdom does not, so it is given, and
    // with the plain read of `parentElement` this test never ends, as the tab did not.
    Object.defineProperty(form, member, { value: form.querySelector('input') });
    stops.push(startBehaviour({ container: document, program: program(nodes), surface: 'preview', verbs: createVerbs, keys: { keysAnswer, isTextEntry } }));
    $('button').click();
    $('input').click();
    expect(Element.prototype.getAttribute.call($('[data-fc-n="s"]'), 'data-fcs-n')).toBe('1');
    expect(Element.prototype.getAttribute.call(form, 'data-fcs-m')).toBe('2');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('what the parser refuses never runs', () => {
  const root = (props: object, ...children: object[]) => ({ id: 'root', type: 'div', props, children });
  const ran = () => warn.mock.calls.filter(([message]) => String(message).includes('left out')).length;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLElement.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  });

  it.each([
    ['capturePointer', { id: 'p', on: 'pointerdown', scope: 'document', do: [{ capturePointer: true }] }],
    ['navigate', { id: 'n', on: 'click', scope: 'document', do: [{ navigate: 'https://example.com/' }] }],
    ['a modal from any press', { id: 'm', on: 'click', scope: 'document', do: [{ dialog: 'd', op: 'showModal' }] }],
    ['a modal from a page-wide Escape', { id: 'm', on: 'keyup', scope: 'document', keys: ['Escape'], do: [{ dialog: 'd', op: 'showModal' }] }],
    ['focus', { id: 'f', on: 'keydown', scope: 'document', keys: ['Enter'], do: [{ focus: 'd' }] }],
    ['emit', { id: 'e', on: 'keydown', scope: 'document', keys: ['Enter'], do: [{ emit: 'x' }] }],
    ['delay', { id: 'e', on: 'keydown', scope: 'document', keys: ['Enter'], do: [{ delay: 16, do: [{ cancel: 'x' }] }] }],
  ])('keeps a page-wide trigger off %s', (_, trigger) => {
    fromStored(root({ behaviour: { on: [trigger] } }, { id: 'd', type: 'dialog', props: {} }));
    document.body.click();
    press(document.body, 'Escape');
    press(document.body, 'Enter');
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    expect(ran()).toBe(1);
  });

  it.each([['keydown'], ['keyup']])('never reopens a modal from Escape on %s, on the node either', (on) => {
    fromStored(root({ behaviour: { on: [{ id: 'm', on, keys: ['Escape'], do: [{ dialog: 'd', op: 'showModal' }] }] } }, { id: 'd', type: 'dialog', props: {} }));
    press($('[data-fc-n]') ?? document.body, 'Escape');
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
  });

  it.each([
    ['fullscreen from a timer', 'div', { fullscreen: 'x', op: 'enter' }, 'every'],
    ['fullscreen under a delay', 'div', { delay: 16, do: [{ fullscreen: 'x', op: 'enter' }] }, 'click'],
    ['picture in picture from a timer', 'video', { pictureInPicture: 'x', op: 'enter' }, 'every'],
    ['play from a timer', 'video', { media: 'x', op: 'play' }, 'every'],
    ['play under a delay', 'video', { delay: 16, do: [{ media: 'x', op: 'play' }] }, 'click'],
  ])('refuses %s', (_, type, action, on) => {
    fromStored({ id: 'x', type, props: { behaviour: { on: [{ id: 't', on, ...(on === 'every' ? { ms: 1000 } : {}), do: [action] }] } } });
    expect(ran()).toBe(1);
  });

  it.each([
    ['load from a timer, which restarts a stored autoplay', { on: 'every', ms: 1000 }, { media: 'x', op: 'load' }],
    ['load under a delay', { on: 'click' }, { delay: 16, do: [{ media: 'x', op: 'load' }] }],
    ['load when the page appears', { on: 'page-ready' }, { media: 'x', op: 'load' }],
    ['load from an emit', { on: 'custom:go' }, { media: 'x', op: 'load' }],
    ['volume from a timer, which undoes a visitor turning it down', { on: 'every', ms: 1000 }, { media: 'x', op: 'volume', value: 1 }],
    ['seek from a timer', { on: 'every', ms: 1000 }, { media: 'x', op: 'seek', value: 0 }],
    ['rate from a timer', { on: 'every', ms: 1000 }, { media: 'x', op: 'rate', value: 2 }],
    ['volume under a delay', { on: 'click' }, { delay: 16, do: [{ media: 'x', op: 'volume', value: 1 }] }],
    ['seek on an element coming into view', { on: 'view-enter' }, { media: 'x', op: 'seek', value: 0 }],
  ])('refuses %s', (_, head, action) => {
    fromStored({ id: 'x', type: 'video', props: { behaviour: { on: [{ id: 't', ...head, do: [action] }] } } });
    expect(ran()).toBe(1);
  });

  it.each([
    ['load from a press', 'click', { media: 'x', op: 'load' }],
    ['seek from a drag', 'pointermove', { media: 'x', op: 'seek', value: 1 }],
    ['pause from anything', 'view-leave', { media: 'x', op: 'pause' }],
  ])('still takes %s', (_, on, action) => {
    fromStored({ id: 'x', type: 'video', props: { behaviour: { on: [{ id: 't', on, do: [action] }] } } });
    expect(ran()).toBe(0);
  });

  it('still takes volume from a slider, which is a person too', () => {
    fromStored(root({},
      { id: 'clip', type: 'video', props: {} },
      { id: 'level', type: 'input', props: { type: 'range', behaviour: { on: [{ id: 't', on: 'input', do: [{ media: 'clip', op: 'volume', value: { event: 'value' } }] }] } } }));
    expect(ran()).toBe(0);
  });

  it('refuses capturePointer on the page root, and leaves it on a node inside', () => {
    const capture = { behaviour: { on: [{ id: 'p', on: 'pointerdown', do: [{ capturePointer: true }] }] } };
    fromStored(root(capture));
    expect(ran()).toBe(1);
    warn.mockClear();
    fromStored(root({}, { id: 'grip', type: 'div', props: capture }));
    expect(ran()).toBe(0);
  });

  it('still lets a press take the screen', () => {
    fromStored({ id: 'x', type: 'video', props: { behaviour: { on: [{ id: 't', on: 'click', do: [{ media: 'x', op: 'play' }] }] } } });
    expect(ran()).toBe(0);
  });

  it.each(['transitionend', 'animationiteration'])('keeps a native toggle out of %s, which comes back below any rate', (on) => {
    fromStored({ id: 'x', type: 'details', props: { behaviour: { on: [{ id: 't', on, do: [{ details: 'x', op: 'toggle' }] }] } } });
    expect(ran()).toBe(1);
  });
});

describe('a modal no press asked for, closed by Escape whatever was stored', () => {
  it('overrides closedby="none"', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const inner = frame.contentDocument as Document;
    const opened = vi.fn();
    (frame.contentWindow as unknown as { HTMLDialogElement: typeof HTMLDialogElement }).HTMLDialogElement.prototype.showModal = opened;
    inner.body.innerHTML = '<dialog data-fc-n="d" closedby="none"></dialog><p data-fc-n="p"></p>';
    stops.push(startBehaviour({
      container: inner,
      program: program({ d: {}, p: { on: [{ id: 'r', on: 'page-ready', do: [{ dialog: 'd', op: 'showModal' }] }] } }),
      surface: 'published',
      verbs: createVerbs,
    }));
    expect(opened).toHaveBeenCalledOnce();
    expect((inner.querySelector('dialog') as HTMLDialogElement).getAttribute('closedby')).toBe('closerequest');
  });
});

describe('the page-wide cap', () => {
  it('stops timers for the visit once many small triggers add up, each under its own limit', () => {
    vi.useFakeTimers();
    vi.spyOn(window.performance, 'now').mockReturnValue(5000);
    const scans = vi.fn();
    document.body.innerHTML = '<div data-fc-n="s"></div>';
    const triggers = Array.from({ length: 16 }, (_, index) => ({ id: `t${index}`, on: 'every', ms: 1000, do: [{ dialog: 'x', op: 'close' }] }));
    stops.push(startBehaviour({
      container: document,
      program: program({ s: { on: triggers } }),
      surface: 'preview',
      verbs: (kit) => () => {
        if (kit.charge(MAX_PAGE_COST_PER_SECOND / 4)) scans();
      },
    }));
    vi.advanceTimersByTime(10_000);
    expect(scans).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.some(([message]) => String(message).includes('timers off'))).toBe(true);
  });

  it('drops what would run past it, and a press comes back in the next second', () => {
    const now = vi.spyOn(window.performance, 'now');
    let clock = 5000;
    now.mockImplementation(() => clock);
    let kit: Kit | undefined;
    document.body.innerHTML = '<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>';
    stops.push(startBehaviour({
      container: document,
      program: program({ s: { state: [flag('a')] }, b: { on: [clickDoing({ toggle: 'a' })] } }),
      surface: 'preview',
      verbs: (given) => {
        kit = given;
        return () => {};
      },
    }));
    expect(kit?.charge(MAX_PAGE_COST_PER_SECOND)).toBe(true);
    expect(kit?.charge(1)).toBe(false);
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBeNull();
    clock += 1001;
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
  });

  it('starts no timer once it has tripped', () => {
    vi.useFakeTimers();
    const now = vi.spyOn(window.performance, 'now').mockReturnValue(5000);
    let kit: Kit | undefined;
    document.body.innerHTML = '<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>';
    stops.push(startBehaviour({
      container: document,
      program: program({ s: { state: [count('n')], on: [{ id: 'e', on: 'every', ms: 1000, do: [{ step: 'n' }] }] }, b: { on: [clickDoing({ delay: 16, do: [{ step: 'n' }] })] } }),
      surface: 'preview',
      verbs: (given) => {
        kit = given;
        return () => {};
      },
    }));
    kit?.charge(MAX_PAGE_COST_PER_SECOND + 1);
    now.mockReturnValue(9000);
    $('button').click();
    vi.advanceTimersByTime(5000);
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBeNull();
  });
});

describe('one trigger shared by many rows', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => `<details data-fc-n="r" data-fc-scope data-fc-i="${i}"></details>`).join('');
  const toggled = (count: number) => {
    start(`<div>${rows(count)}</div>`, {
      r: { state: [flag('o')], on: [{ id: 'l', on: 'toggle', do: [{ toggle: 'o' }] }] },
    });
    return [...document.querySelectorAll('details')];
  };
  const stopped = () => warn.mock.calls.filter(([message]) => /unprompted|too often/.test(String(message))).length;

  it('is not turned off by one press reaching 500 rows once', () => {
    for (const row of toggled(500)) row.dispatchEvent(new Event('toggle'));
    expect(stopped()).toBe(0);
    expect(document.querySelectorAll('[data-fcs-o="true"]')).toHaveLength(500);
  });

  it('is not turned off by a task that reaches 500 rows, where 256 actions on one would be', () => {
    start(`<ul>${Array.from({ length: 500 }, (_, i) => `<li data-fc-n="r" data-fc-scope data-fc-i="${i}"></li>`).join('')}</ul><button id="x"></button>`, {
      r: { state: [flag('o', true)], on: [{ id: 'e', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ set: 'o', value: false }] }] },
    });
    press($('#x'), 'Escape');
    expect(stopped()).toBe(0);
    expect(document.querySelectorAll('[data-fcs-o="false"]')).toHaveLength(500);
  });

  it('still stops a loop on one of them, for all of them', () => {
    const [row, other] = toggled(2);
    const now = vi.spyOn(window.performance, 'now');
    let clock = 5000;
    now.mockImplementation(() => clock);
    for (let i = 0; i < MAX_UNPROMPTED_FIRINGS + 1; i += 1) {
      clock += 200;
      row.dispatchEvent(new Event('toggle'));
    }
    expect(stopped()).toBe(1);
    other.dispatchEvent(new Event('toggle'));
    expect(other.getAttribute('data-fcs-o')).toBeNull();
  });
});

describe('a loop through what the page itself causes', () => {
  const loop = {
    s: { state: [flag('a')], on: [{ id: 'l', on: 'transitionend', do: [{ toggle: 'a' }] }] },
  };
  const round = (el: Element) => el.dispatchEvent(new Event('transitionend', { bubbles: true }));
  const flips = () => warn.mock.calls.filter(([message]) => String(message).includes('unprompted')).length;

  it('turns off after 256 firings with nobody there, below any rate', () => {
    const now = vi.spyOn(window.performance, 'now');
    let clock = 5000;
    now.mockImplementation(() => clock);
    start('<div data-fc-n="s" data-fc-scope></div>', loop);
    for (let i = 0; i < MAX_UNPROMPTED_FIRINGS + 5; i += 1) {
      clock += 200;
      round($('[data-fc-scope]'));
    }
    expect(flips()).toBe(1);
    const held = $('[data-fc-scope]').getAttribute('data-fcs-a');
    round($('[data-fc-scope]'));
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe(held);
  });

  it('starts counting again whenever a person does something', () => {
    const now = vi.spyOn(window.performance, 'now');
    let clock = 5000;
    now.mockImplementation(() => clock);
    start('<div data-fc-n="s" data-fc-scope></div>', loop);
    for (let i = 0; i < MAX_UNPROMPTED_FIRINGS * 3; i += 1) {
      clock += 200;
      if (i % 100 === 0) document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      round($('[data-fc-scope]'));
    }
    expect(flips()).toBe(0);
  });
});

describe('without the key rules', () => {
  it('fires no key at all, rather than every key', () => {
    document.body.innerHTML = '<div data-fc-n="s" data-fc-scope><input></div>';
    stops.push(startBehaviour({ container: document, program: program({ s: { state: [count('n')], on: [{ id: 'k', on: 'keydown', do: [{ step: 'n' }] }] } }), surface: 'preview' }));
    press($('input'), 'h');
    expect($('[data-fc-scope]').getAttribute('data-fcs-n')).toBeNull();
  });
});

describe('the cleanup', () => {
  it('stops listening, and the page stays as it was', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button></div>', { s: { state: [flag('a')] }, b: { on: [clickDoing({ toggle: 'a' })] } });
    $('button').click();
    stops.splice(0).forEach((stop) => stop());
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
  });
});
