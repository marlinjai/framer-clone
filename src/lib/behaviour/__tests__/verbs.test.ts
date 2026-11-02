// What the two chunks beside the core decide on their own: what no real browser run in
// test/behaviour/verbs.spec.ts can reach, such as a browser with no userActivation, and
// the branches a stored mistake takes. jsdom has no layout, so `getClientRects` is given.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { isTextEntry, keysAnswer } from '../keys';
import { compileProgram, type BehaviourProgram, type Kit, type ProgramEntry, type Run } from '../program';
import { createRover } from '../rove';
import { startBehaviour } from '../runtime';
import { createVerbs } from '../verbs';

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;
const clickDoing = (...actions: unknown[]) => ({ on: [{ id: 't', on: 'click', do: actions }] });
const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

const program = (nodes: Record<string, object>): BehaviourProgram => ({
  nodes: Object.fromEntries(Object.entries(nodes).map(([key, entry]) => [key, [entry as ProgramEntry]])),
});

let warn: MockInstance;
let stops: (() => void)[];

function start(html: string, nodes: Record<string, object>, surface: 'published' | 'preview' | 'canvas' = 'published'): void {
  document.body.innerHTML = html;
  stops.push(startBehaviour({ container: document, program: program(nodes), surface, verbs: createVerbs, rove: createRover, keys: { keysAnswer, isTextEntry } }));
}

beforeEach(() => {
  stops = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return ((this as HTMLElement).style?.display === 'none' ? [] : [{}]) as unknown as DOMRectList;
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  stops.forEach((stop) => stop());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('compileProgram', () => {
  it('asks for no chunk beside the core for a program of state', () => {
    expect(compileProgram({ a: [{ on: [{ id: 't', on: 'click', do: [{ toggle: 's' }, { delay: 16, do: [{ emit: 'x' }] }] }] }] })).toEqual({
      nodes: expect.any(Object),
    });
  });

  it('asks for rove when a node is a group, and verbs for any native action, a delayed one too', () => {
    const group = { role: 'option', axis: 'line' } as const;
    expect(compileProgram({ a: [{ group }] }).rove).toBe(true);
    expect(compileProgram({ a: [{ on: [{ id: 't', on: 'click', do: [{ delay: 16, do: [{ focus: 'b' }] }] }] }] }).verbs).toBe(true);
    expect(compileProgram({ a: [{ on: [{ id: 't', on: 'click', do: [{ rove: 'a', move: 'next' }] }] }] }).verbs).toBeUndefined();
  });
});

describe('navigate', () => {
  const assign = vi.fn();
  const warned = vi.fn();

  /** A document's location cannot be replaced, so the verb gets a kit of its own. */
  const go = (href: string, surface: Kit['surface'] = 'published'): void => {
    const kit = { surface, doc: { location: { assign } }, settle: () => {}, warn: warned } as unknown as Kit;
    createVerbs(kit)({ navigate: href }, { trigger: { id: 't' } } as Run);
  };
  const activation = (value: unknown) => Object.defineProperty(navigator, 'userActivation', { value, configurable: true });

  beforeEach(() => {
    assign.mockReset();
    warned.mockReset();
  });

  it('fails closed on an outside address where the browser cannot say a press happened', () => {
    activation(undefined);
    go('https://example.com/');
    expect(assign).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledOnce();
  });

  it('refuses an outside address once the activation has gone', () => {
    activation({ isActive: false });
    go('//example.com/');
    expect(assign).not.toHaveBeenCalled();
  });

  it('goes with a live activation', () => {
    activation({ isActive: true });
    go('https://example.com/');
    expect(assign).toHaveBeenCalledWith('https://example.com/');
  });

  it('needs none inside the site', () => {
    activation(undefined);
    go('/about');
    expect(assign).toHaveBeenCalledWith('/about');
  });

  it.each(['preview', 'canvas'] as const)('never navigates the %s away', (surface) => {
    activation({ isActive: true });
    go('/about', surface);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('the native verbs', () => {
  it('costs a refused verb that verb alone, and carries on', () => {
    start('<div data-fc-n="s" data-fc-scope><button data-fc-n="b"></button><div data-fc-n="p"></div></div>', {
      s: { state: [{ id: 'a', type: 'boolean', initial: false }] },
      p: {},
      b: clickDoing({ popover: 'p', op: 'show' }, { set: 'a', value: true }),
    });
    $('div[data-fc-n="p"]').matches = () => { throw new DOMException('no', 'NotSupportedError'); };
    $('button').click();
    expect($('[data-fc-scope]').getAttribute('data-fcs-a')).toBe('true');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns once for a target that is not there', () => {
    start('<button data-fc-n="b"></button>', { b: clickDoing({ focus: 'gone' }) });
    $('button').click();
    $('button').click();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('leaves a value that is no number off a media element', async () => {
    start('<div data-fc-n="s" data-fc-scope><audio data-fc-n="m"></audio><button data-fc-n="b"></button></div>', {
      s: { state: [{ id: 't', type: 'text', initial: 'x' }] },
      m: {},
      b: clickDoing({ media: 'm', op: 'volume', value: { add: [{ get: 't' }, 1] } }),
    });
    $('button').click();
    expect(($('audio') as HTMLAudioElement).volume).toBe(1);
  });

  it('writes no missing value through setProp', () => {
    start('<div data-fc-n="s" data-fc-scope><input data-fc-n="i" value="kept"><button data-fc-n="b"></button></div>', {
      s: { state: [{ id: 'c', type: 'choice', initial: 'a', options: ['a'] }] },
      i: {},
      b: clickDoing({ setProp: 'i', prop: 'value', value: { map: 'c', cases: { z: 'x' } } }),
    });
    $('button').click();
    expect(($('input') as HTMLInputElement).value).toBe('kept');
  });

  it('gives a filtered item its own display back', () => {
    start('<div data-fc-n="s" data-fc-scope><input data-fc-n="i" value="be"><ul data-fc-n="l"><li role="option" style="display: flex">Bern</li><li role="option" style="display: flex">Zurich</li></ul></div>', {
      s: { state: [] },
      l: {},
      i: { on: [{ id: 'f', on: 'input', do: [{ filter: 'l', role: 'option', text: { event: 'value' } }] }] },
    });
    const input = $('input') as HTMLInputElement;
    const [bern, zurich] = document.querySelectorAll('li');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect([bern.style.display, zurich.style.display]).toEqual(['flex', 'none']);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(zurich.style.display).toBe('flex');
  });
});

describe('what a full scan costs', () => {
  const list = Array.from({ length: 2000 }, (_, index) => `<li role="option">Item ${index}</li>`).join('');

  it('charges filter per item, so stacked filters stop, with nobody turned off and timers gone', () => {
    vi.useFakeTimers();
    vi.spyOn(window.performance, 'now').mockReturnValue(5000);
    const filters = Array.from({ length: 16 }, () => ({ filter: 'l', role: 'option', text: 'item' }));
    start(`<ul data-fc-n="l">${list}</ul>`, {
      l: { on: Array.from({ length: 8 }, (_, index) => ({ id: `t${index}`, on: 'every', ms: 1000, do: filters })) },
    });
    const read = vi.spyOn(HTMLElement.prototype, 'style', 'get');
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(30_000);
    expect(warn.mock.calls.some(([message]) => String(message).includes('timers off'))).toBe(true);
    const after = read.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(read.mock.calls.length).toBe(after);
    vi.useRealTimers();
  });

  it('runs a filter over a long list from a person typing, and keeps running it', () => {
    start(`<input data-fc-n="i" value="item 1"><ul data-fc-n="l">${list}</ul>`, {
      l: {},
      i: { on: [{ id: 'f', on: 'input', do: [{ filter: 'l', role: 'option', text: { event: 'value' } }] }] },
    });
    for (let key = 0; key < 10; key += 1) $('input').dispatchEvent(new Event('input', { bubbles: true }));
    expect(warn).not.toHaveBeenCalled();
    expect(($('li:nth-child(3)') as HTMLElement).style.display).toBe('none');
  });
});

describe('a group whose item is a form with a field named after what rove reads', () => {
  it.each(['parentElement', 'closest', 'getAttribute', 'hasAttribute', 'setAttribute', 'matches'])('walks past %s', (member) => {
    document.body.innerHTML = '<div data-fc-n="g"><form role="button" id="a"><input id="in"></form><button role="button" id="b">B</button></div>';
    const form = $('form');
    Object.defineProperty(form, member, { value: $('#in') });
    stops.push(startBehaviour({
      container: document,
      program: program({ g: { group: { role: 'button', axis: 'line' }, on: [{ id: 'n', on: 'keydown', keys: ['ArrowRight'], do: [{ rove: 'g', move: 'next' }] }] } }),
      surface: 'preview',
      rove: createRover,
      keys: { keysAnswer, isTextEntry },
    }));
    $('#in').focus();
    press($('#in'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('b');
  });
});

describe('focus groups', () => {
  const line = '<div data-fc-n="g"><button role="button" id="a">Alpha</button><button role="button" id="b">Beta</button><button role="button" id="c">Bravo</button></div>';
  const group = (wrap = false) => ({
    group: { role: 'button', axis: 'line', wrap },
    on: [
      { id: 'n', on: 'keydown', keys: ['ArrowRight'], do: [{ rove: 'g', move: 'next' }] },
      { id: 'p', on: 'keydown', keys: ['ArrowLeft'], do: [{ rove: 'g', move: 'prev' }] },
      { id: 'd', on: 'keydown', keys: ['PageDown'], do: [{ rove: 'g', move: 'page-down' }] },
      { id: 't', on: 'keydown', keys: ['Printable'], do: [{ rove: 'g', move: 'type' }] },
    ],
  });

  it('writes one Tab stop when it starts, on what is selected if anything is', () => {
    start('<div data-fc-n="g"><button role="button">A</button><button role="button" aria-selected="true">B</button></div>', { g: group() });
    expect([...document.querySelectorAll('button')].map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '0']);
  });

  it('stops at the ends without wrap, and goes round with it', () => {
    start(line, { g: group() });
    $('#a').focus();
    press($('#a'), 'ArrowLeft');
    expect(document.activeElement?.id).toBe('a');
    stops.splice(0).forEach((stop) => stop());
    start(line, { g: group(true) });
    $('#a').focus();
    press($('#a'), 'ArrowLeft');
    expect(document.activeElement?.id).toBe('c');
  });

  it('moves a page, stopping at the end', () => {
    start(line, { g: group() });
    $('#a').focus();
    press($('#a'), 'PageDown');
    expect(document.activeElement?.id).toBe('c');
  });

  it('types ahead over several keys, and one key repeated cycles', () => {
    start(line, { g: group() });
    $('#a').focus();
    press($('#a'), 'b');
    expect(document.activeElement?.id).toBe('b');
    press($('#b'), 'b');
    expect(document.activeElement?.id).toBe('c');
  });

  it('counts only its own items, not those of a group inside it', () => {
    start(`<div data-fc-n="g"><button role="button" id="a">A</button><div data-fc-n="inner"><button role="button" id="in">I</button></div><button role="button" id="z">Z</button></div>`, {
      g: group(),
      inner: { group: { role: 'button', axis: 'line' } },
    });
    $('#a').focus();
    press($('#a'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('z');
  });

  it('skips what is not rendered', () => {
    start('<div data-fc-n="g"><button role="button" id="a">A</button><button role="button" id="h" style="display: none">H</button><button role="button" id="z">Z</button></div>', { g: group() });
    $('#a').focus();
    press($('#a'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('z');
  });

  it('gives an active option with no id one, so aria-activedescendant has a target', () => {
    start('<input data-fc-n="o"><ul data-fc-n="l"><li role="option">One</li></ul>', {
      o: { on: [{ id: 'd', on: 'keydown', keys: ['ArrowDown'], do: [{ rove: 'l', move: 'next' }] }] },
      l: { group: { role: 'option', axis: 'line', virtual: { owner: 'o' } } },
    });
    press($('input'), 'ArrowDown');
    expect($('li').id).toBe('fc-l-0');
    expect($('input').getAttribute('aria-activedescendant')).toBe('fc-l-0');
    expect(document.activeElement).not.toBe($('li'));
  });

  it('stops following the focus after the cleanup', () => {
    start(line, { g: group() });
    stops.splice(0).forEach((stop) => stop());
    $('#b').focus();
    expect($('#b').getAttribute('tabindex')).toBe('-1');
  });

  it('warns and moves nothing without its chunk', () => {
    document.body.innerHTML = line;
    stops.push(startBehaviour({ container: document, program: program({ g: group() }), surface: 'published', keys: { keysAnswer, isTextEntry } }));
    $('#a').focus();
    press($('#a'), 'ArrowRight');
    expect(document.activeElement?.id).toBe('a');
    expect(warn).toHaveBeenCalledOnce();
  });
});
