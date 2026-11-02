import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { surfaceSheet, type SurfaceNode } from '@/lib/rules/surfaceSheet';
import { fitsState, revealFor, surfaceBehaviour } from '../surfaceBehaviour';
import { withSurfaceDom } from '../surfaceDom';

const node = (id: string, type: string, props: Record<string, unknown>, ...children: ComponentNode[]): ComponentNode => ({ id, type, props, children });

/** An accordion item: a state, a button flipping it, a panel shown while it is true. */
function accordion(): ComponentNode {
  return node(
    'item',
    'div',
    { behaviour: { state: [{ id: 's1', name: 'Open', type: 'boolean', initial: false }] } },
    node('btn', 'button', {
      type: 'button',
      children: 'Toggle',
      behaviour: { on: [{ id: 't1', on: 'click', do: [{ toggle: 's1' }] }], bind: [{ attr: 'aria-expanded', from: { get: 's1' } }] },
    }),
    node('panel', 'div', {
      children: 'Panel',
      rules: [{ id: 'r1', selector: '&', when: { state: 's1', eq: true }, style: { color: 'green' } }],
      behaviour: { showWhen: { state: 's1', eq: true } },
    }),
  );
}

const FRAMES = [
  { breakpointId: 'desk', width: 1280, height: 800 },
  { breakpointId: 'mob', width: 390, height: 800 },
];
const BREAKPOINTS = [
  { id: 'desk', minWidth: 1280 },
  { id: 'mob', minWidth: 320 },
];

describe('surfaceBehaviour', () => {
  it('hands a page with no behaviour its own tree and nothing else', () => {
    const root = node('root', 'div', { children: 'plain' });
    const result = surfaceBehaviour(root);
    expect(result.root).toBe(root);
    expect(result.program).toBeNull();
    expect(result.dom.size).toBe(0);
  });

  it('writes the first values, the bindings and the marks, per node id', () => {
    const { dom, program } = surfaceBehaviour(accordion());
    expect(dom.get('item')?.attributes).toMatchObject({ 'data-fcs-s1': 'false', 'data-fc-scope': '' });
    expect(dom.get('btn')?.attributes).toMatchObject({ 'aria-expanded': 'false', 'data-fc-n': 'btn' });
    expect(program?.nodes.btn).toBeDefined();
    // What is stored stays stored: the pass's own keys never reach a renderer.
    // The panel's rules moved into the sheet's conditions, and nothing else was written there.
    expect(dom.get('panel')).toBeUndefined();
    expect(dom.get('btn')?.attributes).not.toHaveProperty('behaviour');
  });

  it('starts a previewed state at its preview value, bindings included', () => {
    const { dom } = surfaceBehaviour(accordion(), { s1: true });
    expect(dom.get('item')?.attributes['data-fcs-s1']).toBe('true');
    expect(dom.get('btn')?.attributes['aria-expanded']).toBe('true');
  });

  it('ignores a preview value the state cannot hold, rather than lose the state', () => {
    const { dom } = surfaceBehaviour(accordion(), { s1: 'yes' });
    expect(dom.get('item')?.attributes['data-fcs-s1']).toBe('false');
  });

  it('keys a placement node on its expanded id, and the program on its definition id', () => {
    const inner = { ...node('pl__btn', 'button', { type: 'button', children: 'Go', behaviour: { on: [{ id: 't1', on: 'click', do: [{ toggle: 's1' }] }] } }), classKey: 'btn' };
    const root = node('root', 'div', {}, { ...node('pl', 'div', { behaviour: { state: [{ id: 's1', name: 'On', type: 'boolean', initial: false }] } }, inner), classKey: 'def-root', placementRoot: true });
    const { dom, program } = surfaceBehaviour(root);
    expect(dom.get('pl__btn')?.attributes['data-fc-n']).toBe('btn');
    expect(dom.get('pl')?.attributes['data-fcs-s1']).toBe('false');
    expect(Object.keys(program?.nodes ?? {})).toContain('btn');
  });

  it('remembers the result per tree and preview', () => {
    const root = accordion();
    expect(surfaceBehaviour(root, { s1: true })).toBe(surfaceBehaviour(root, { s1: true }));
    expect(surfaceBehaviour(root, { s1: false })).not.toBe(surfaceBehaviour(root, { s1: true }));
  });

  it('keeps the canvas preview and the first values apart, so neither surface restarts the other', () => {
    const root = accordion();
    const atFirst = surfaceBehaviour(root);
    const previewed = surfaceBehaviour(root, { s1: true });
    expect(surfaceBehaviour(root)).toBe(atFirst);
    expect(surfaceBehaviour(root, { s1: true })).toBe(previewed);
    expect(surfaceBehaviour(root).program).toBe(atFirst.program);
  });
});

describe('the sheets after the pass', () => {
  const sheet = (kind: 'canvas' | 'preview', preview = {}) =>
    surfaceSheet({ kind, tree: surfaceBehaviour(accordion(), preview).root as SurfaceNode, frames: kind === 'canvas' ? FRAMES : [FRAMES[1]], breakpoints: BREAKPOINTS });

  it('writes a when on every frame of the canvas, with no gate', () => {
    const css = sheet('canvas');
    for (const frame of ['desk', 'mob']) {
      expect(css).toContain(`[data-viewport-content-id] [data-component-id="${frame}-panel"]:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]){color:green!important}`);
    }
    expect(css).not.toContain('data-fc-b');
  });

  it('hides a node its showWhen rules out, by the same condition', () => {
    const css = sheet('canvas');
    for (const frame of ['desk', 'mob']) {
      expect(css).toContain(`[data-component-id="${frame}-panel"]:where(:not(:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]))){display:none!important}`);
    }
  });

  it('writes the same in the preview, which reads the runtime\'s writes', () => {
    const css = sheet('preview');
    expect(css).toContain('[data-preview-frame] [data-component-id="mob-panel"]:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]){color:green!important}');
    expect(css).not.toContain('data-fc-b');
  });

  it('leaves out the no-JavaScript look on both surfaces', () => {
    const tree = node('root', 'div', {
      behaviour: { state: [{ id: 's1', name: 'Open', type: 'boolean', initial: false }], on: [{ id: 't', on: 'click', do: [{ toggle: 's1' }] }] },
      rules: [{ id: 'off', selector: '&', gate: 'off', style: { color: 'red' } }],
    });
    for (const kind of ['canvas', 'preview'] as const) {
      const css = surfaceSheet({ kind, tree: surfaceBehaviour(tree).root as SurfaceNode, frames: [FRAMES[1]], breakpoints: BREAKPOINTS });
      expect(css).not.toContain('color:red');
    }
  });

  it('refuses a when on a page with no state in reach, as the published page does', () => {
    const tree = node('root', 'div', { rules: [{ id: 'w', selector: '&', when: { state: 'nope', eq: true }, style: { color: 'red' } }] });
    const problems: string[] = [];
    const result = surfaceBehaviour(tree);
    surfaceSheet({ kind: 'canvas', tree: result.root as SurfaceNode, frames: FRAMES, breakpoints: BREAKPOINTS, onProblem: (p) => problems.push(p.reason) });
    expect(problems.join() + result.problems.map((p) => p.reason).join()).toMatch(/state/);
  });
});

describe('withSurfaceDom', () => {
  const dom = { attributes: { 'aria-expanded': 'true', children: 'Bound', defaultValue: 'x' }, removed: ['value'], style: { '--u-split': '30%' } };

  it('adds what the pass wrote and takes away what it consumed', () => {
    const { attributes, style } = withSurfaceDom({ value: 'old', id: 'a' }, { color: 'red' }, dom, 'preview');
    expect(attributes).toEqual({ id: 'a', 'aria-expanded': 'true', children: 'Bound', defaultValue: 'x' });
    expect(style).toEqual({ color: 'red', '--u-split': '30%' });
  });

  it('keeps the stored text on the canvas, where a person types into it', () => {
    expect(withSurfaceDom({ children: 'Stored' }, {}, dom, 'canvas').attributes.children).toBe('Stored');
  });
});

describe('fitsState', () => {
  it('holds a value to its state\'s kind and bounds', () => {
    expect(fitsState({ type: 'boolean' }, true)).toBe(true);
    expect(fitsState({ type: 'boolean' }, 'true')).toBe(false);
    expect(fitsState({ type: 'number', min: 0, max: 3 }, 2)).toBe(true);
    expect(fitsState({ type: 'number', min: 0, max: 3 }, 4)).toBe(false);
    expect(fitsState({ type: 'number' }, Number.NaN)).toBe(false);
    expect(fitsState({ type: 'choice', options: ['a', 'b'] }, 'b')).toBe(true);
    expect(fitsState({ type: 'choice', options: ['a'] }, 'b')).toBe(false);
    expect(fitsState({ type: 'text', maxLength: 3 }, 'abcd')).toBe(false);
    expect(fitsState(null, true)).toBe(false);
  });
});

describe('revealFor', () => {
  it('finds the preview that shows a hidden node', () => {
    expect(revealFor(accordion(), 'panel')).toEqual({ values: { s1: true }, names: ['Open'] });
  });

  it('asks nothing for a node nothing hides, or one already shown', () => {
    expect(revealFor(accordion(), 'btn')).toEqual({ values: {}, names: [] });
    expect(revealFor(accordion(), 'panel', { s1: true })).toEqual({ values: {}, names: [] });
    expect(revealFor(accordion(), 'missing')).toBeNull();
  });

  it('collects every condition on the way down', () => {
    const tree = node(
      'root',
      'div',
      { behaviour: { state: [{ id: 'a', name: 'Menu', type: 'boolean', initial: false }, { id: 'b', name: 'Tab', type: 'choice', initial: 'one', options: ['one', 'two'] }] } },
      node('outer', 'div', { behaviour: { showWhen: { state: 'a', eq: true } } }, node('inner', 'div', { behaviour: { showWhen: { all: [{ state: 'b', eq: 'two' }, { state: 'a', eq: true }] } } })),
    );
    expect(revealFor(tree, 'inner')).toEqual({ values: { a: true, b: 'two' }, names: ['Menu', 'Tab'] });
  });

  it('says why when no preview can show it', () => {
    const tree = node(
      'root',
      'div',
      { behaviour: { state: [{ id: 'a', name: 'Menu', type: 'boolean', initial: true }] } },
      node('hidden', 'div', { 'aria-label': 'Drawer', behaviour: { showWhen: { not: { state: 'a', eq: true } } } }),
    );
    expect(revealFor(tree, 'hidden')).toMatchObject({ blocked: expect.stringContaining('Drawer') });
  });
});
