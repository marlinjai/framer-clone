// @vitest-environment node
// applyFx: stored FX scenes become the page's FX program and a mark on each box;
// `fx` and the marks only this step may write leave every node.

import { describe, expect, it } from 'vitest';

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { FX_ATTR, FX_MARKER, FX_PROP } from '@/lib/fxScene/marker';
import { applyFx } from '../applyFx';

const scene = (id: string) => serializeScene(PRESETS.find((p) => p.id === id)!.load());
const stored = (id = 'noise-gradient', extra: Record<string, unknown> = {}) => ({ version: 1, scene: scene(id), start: 'visible', calm: 'frame', ...extra });

const fxBox = (id: string, fx: unknown, extra: Record<string, unknown> = {}, type = 'div'): ComponentNode =>
  ({ id, type, props: { [FX_ATTR]: FX_MARKER, [FX_PROP]: fx, style: { minHeight: '50vh' }, ...extra }, children: [{ id: `${id}-t`, type: 'h1', props: { children: 'Title' } }] }) as ComponentNode;

const page = (...children: ComponentNode[]): ComponentNode => ({ id: 'root', type: 'div', props: {}, children }) as ComponentNode;

const propsOf = (root: ComponentNode, id: string): Record<string, unknown> => {
  const find = (node: ComponentNode): ComponentNode | undefined => (node.id === id ? node : node.children?.map(find).find(Boolean));
  return (find(root)!.props ?? {}) as Record<string, unknown>;
};

describe('applyFx', () => {
  it('gives a page without a scene an empty program and the same tree', () => {
    const root = page({ id: 'a', type: 'p', props: { children: 'Text' } } as ComponentNode);
    const result = applyFx(root);
    expect(result.program).toEqual([]);
    expect(result.root).toEqual(root);
  });

  it('turns each scene into a program entry, in document order, and marks its box with the index', () => {
    const root = page(fxBox('one', stored('noise-gradient')), { id: 'mid', type: 'section', props: {}, children: [fxBox('two', stored('godrays-hero', { start: 'immediate' }))] } as ComponentNode);
    const { root: out, program } = applyFx(root);
    expect(program).toHaveLength(2);
    expect(program[0]).toEqual(stored('noise-gradient'));
    expect(program[1]).toMatchObject({ version: 1, start: 'immediate', calm: 'frame' });
    expect(program[1].scene.id).toBe('lumitra-preset-godrays-hero');
    expect(propsOf(out, 'one')['data-fc-fx']).toBe('0');
    expect(propsOf(out, 'two')['data-fc-fx']).toBe('1');
    expect(propsOf(out, 'one')[FX_ATTR]).toBe(FX_MARKER);
    expect(propsOf(out, 'one').style).toEqual({ minHeight: '50vh' });
  });

  it('takes `fx` off every node: scenes, refused scenes, and nodes that are no FX box', () => {
    const root = page(
      fxBox('good', stored()),
      fxBox('refused', stored('noise-gradient', { version: 9 })),
      fxBox('missing', undefined),
      fxBox('wrong-tag', stored(), {}, 'section'),
      { id: 'loose', type: 'div', props: { [FX_PROP]: stored() } } as ComponentNode,
    );
    const { root: out, program } = applyFx(root);
    expect(program).toHaveLength(1);
    for (const id of ['good', 'refused', 'missing', 'wrong-tag', 'loose']) expect(FX_PROP in propsOf(out, id), id).toBe(false);
    expect(JSON.stringify(out)).not.toContain('noiseFill');
    for (const id of ['refused', 'missing', 'wrong-tag', 'loose']) expect('data-fc-fx' in propsOf(out, id), id).toBe(false);
    // A refused box stays the plain box: marker, style and children as stored.
    expect(propsOf(out, 'refused')).toEqual({ [FX_ATTR]: FX_MARKER, style: { minHeight: '50vh' } });
  });

  it('leaves the `fx` of an SVG radialGradient alone: there it is the gradient\'s focal point', () => {
    const gradient = { id: 'glow', type: 'radialGradient', props: { id: 'glow', fx: '0.25', fy: '0.75' } } as ComponentNode;
    const { root: out, program } = applyFx(page({ id: 'art', type: 'svg', props: {}, children: [gradient] } as ComponentNode, fxBox('good', stored())));
    expect(propsOf(out, 'glow')).toEqual({ id: 'glow', fx: '0.25', fy: '0.75' });
    expect(program).toHaveLength(1);
  });

  it('drops a stored mark that only this step may write, on any node, in any case', () => {
    const root = page(
      { id: 'poser', type: 'div', props: { 'data-fc-fx': '0', 'data-fc-fx-state': 'live', 'data-fc-fx-layer': '', 'DATA-FC-FX': '1', 'data-fc-fxtra': 'kept' } } as ComponentNode,
      fxBox('real', stored(), { 'data-fc-fx': '7', 'data-fc-fx-state': 'live' }),
    );
    const { root: out, program } = applyFx(root);
    expect(propsOf(out, 'poser')).toEqual({ 'data-fc-fxtra': 'kept' });
    expect(propsOf(out, 'real')['data-fc-fx']).toBe('0');
    expect('data-fc-fx-state' in propsOf(out, 'real')).toBe(false);
    expect(program).toHaveLength(1);
  });

  it('stores the checked scene, never the stored prop: a repaired value is the one in the program', () => {
    const messy = stored();
    (messy.scene as unknown as { background: string }).background = 'url(https://evil.example/x.png)';
    (messy as Record<string, unknown>).extra = 'x';
    const { program } = applyFx(page(fxBox('a', messy)));
    expect(program[0].scene.background).toBe('#000000');
    expect(JSON.stringify(program)).not.toContain('evil.example');
    expect(Object.keys(program[0]).sort()).toEqual(['calm', 'scene', 'start', 'version']);
  });

  it('does not change its input', () => {
    const root = page(fxBox('a', stored()));
    const before = JSON.stringify(root);
    applyFx(root);
    expect(JSON.stringify(root)).toBe(before);
  });

  it('counts a scene inside repeated rows once per row', () => {
    const { program, root: out } = applyFx(page(fxBox('row-1', stored()), fxBox('row-2', stored())));
    expect(program).toHaveLength(2);
    expect([propsOf(out, 'row-1')['data-fc-fx'], propsOf(out, 'row-2')['data-fc-fx']]).toEqual(['0', '1']);
  });
});
