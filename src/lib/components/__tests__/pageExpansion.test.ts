import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentDefinitions } from '../definition';
import { expandPage, literalPageRoots } from '../pageExpansion';

const BREAKPOINTS = [{ id: 'desk', minWidth: 1280 }];
const read = (expression: string) => ({ mode: 'read', expression });

const definition = (id: string, tree: unknown, inputs: unknown[] = []) => ({
  id,
  name: id,
  page: { appComponentTree: tree, canvasNodes: {} },
  inputs,
  states: [],
});
const definitions = (...stored: ReturnType<typeof definition>[]) =>
  Object.fromEntries(stored.map(d => [d.id, d])) as unknown as ComponentDefinitions;
const placement = (id: string, component: string, props: Record<string, unknown> = {}) => ({ id, type: '#component', props: { component, ...props } });
const CARD = definition('card', { id: 'c', type: 'article', children: [{ id: 't', type: 'h3' }] });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('expandPage', () => {
  it('finds every placement by its expanded id, the floating ones and the nested ones too', () => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [placement('in', 'card')] });
    const { placements, missing, floating } = expandPage(
      { id: 'page', type: 'main', children: [placement('p1', 'outer')] } as never,
      [placement('f1', 'card')] as never,
      definitions(outer, CARD),
      BREAKPOINTS,
    );
    expect([...placements.keys()].sort()).toEqual(['f1', 'p1', 'p1__in']);
    expect(missing.size).toBe(0);
    expect(floating[0].type).toBe('article');
  });

  it('names what renders nothing, under the id the canvas works out', () => {
    const { missing, placements } = expandPage(
      { id: 'page', type: 'main', children: [placement('p1', 'gone')] } as never,
      [],
      definitions(),
      BREAKPOINTS,
    );
    expect([...missing]).toEqual(['p1']);
    expect(placements.get('p1')?.type).toBe('#missing');
  });

  it('spends one budget across the page and what floats beside it', () => {
    const big = definition('big', { id: 'b', type: 'div', children: Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, type: 'i' })) });
    const { missing } = expandPage(
      { id: 'page', type: 'main', children: [placement('p1', 'big')] } as never,
      [placement('f1', 'big')] as never,
      definitions(big),
      BREAKPOINTS,
    );
    expect([...missing]).toEqual(['f1']);
  });

  it('leaves a page with no placement as the published path has it', () => {
    const { root, placements } = expandPage({ id: 'page', type: 'main', props: { title: 'x' } } as never, [], definitions(), BREAKPOINTS);
    expect(root).toEqual({ id: 'page', type: 'main', props: { title: 'x' } });
    expect(placements.size).toBe(0);
  });
});

describe('literalPageRoots', () => {
  it('writes a literal input into its slot and drops a node hidden by one', () => {
    const typed = definition(
      'typed',
      { id: 'r', type: 'div', children: [
        { id: 'a', type: 'p', bindings: { 'style.fontFamily': read('{{input.font}}') } },
        { id: 'b', type: 'p', bindings: { visible: read('{{input.show}}') } },
      ] },
      [{ id: 'font', name: 'Font', type: 'text' }, { id: 'show', name: 'Show', type: 'toggle' }],
    );
    const [root] = literalPageRoots(
      [{ id: 'page', type: 'main', children: [placement('p1', 'typed', { inputs: { font: 'Fraunces', show: false } })] }] as never,
      definitions(typed),
      BREAKPOINTS,
    );
    const inner = root.children?.[0].children ?? [];
    expect(inner).toHaveLength(1);
    expect(inner[0].props?.style).toEqual({ fontFamily: 'Fraunces' });
  });
});
