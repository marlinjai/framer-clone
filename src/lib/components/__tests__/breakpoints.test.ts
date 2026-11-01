import { describe, expect, it } from 'vitest';
import { resolveCascade, type BreakpointRef } from '@/lib/responsive/cascade';
import { definitionBreakpointFor, mapNodeProps, mapResponsiveValue } from '../breakpoints';

const definition: BreakpointRef[] = [
  { id: 'd-desktop', minWidth: 1280 },
  { id: 'd-tablet', minWidth: 768 },
  { id: 'd-mobile', minWidth: 320 },
];
const samePage: BreakpointRef[] = [
  { id: 'p-desktop', minWidth: 1280 },
  { id: 'p-tablet', minWidth: 768 },
  { id: 'p-mobile', minWidth: 320 },
];

describe('definitionBreakpointFor, D(P)', () => {
  it('takes the largest breakpoint no wider than the frame', () => {
    expect(definitionBreakpointFor(1280, definition)?.id).toBe('d-desktop');
    expect(definitionBreakpointFor(1000, definition)?.id).toBe('d-tablet');
    expect(definitionBreakpointFor(2000, definition)?.id).toBe('d-desktop');
  });

  it('takes the smallest when none is that narrow', () => {
    expect(definitionBreakpointFor(200, definition)?.id).toBe('d-mobile');
  });

  it('does not depend on the stored order', () => {
    expect(definitionBreakpointFor(800, [...definition].reverse())?.id).toBe('d-tablet');
  });

  it('has nothing to give without frames', () => {
    expect(definitionBreakpointFor(800, [])).toBeUndefined();
  });
});

describe('mapResponsiveValue', () => {
  it('renames exactly when the frames match', () => {
    expect(mapResponsiveValue({ base: 'a', 'd-tablet': 'b', 'd-mobile': 'c' }, definition, samePage)).toEqual({
      base: 'a',
      'p-tablet': 'b',
      'p-mobile': 'c',
    });
  });

  it('leaves a plain value alone', () => {
    expect(mapResponsiveValue('16px', definition, samePage)).toBe('16px');
    expect(mapResponsiveValue(4, definition, samePage)).toBe(4);
    expect(mapResponsiveValue(['a'], definition, samePage)).toEqual(['a']);
  });

  it('gives a key only where a width differs from the next larger', () => {
    expect(mapResponsiveValue({ base: 'a', 'd-tablet': 'a' }, definition, samePage)).toEqual({ base: 'a' });
  });

  it('agrees with the cascade at every page frame on mismatched frames', () => {
    const page: BreakpointRef[] = [
      { id: 'wide', minWidth: 1600 },
      { id: 'medium', minWidth: 1000 },
      { id: 'narrow', minWidth: 500 },
      { id: 'tiny', minWidth: 200 },
    ];
    const stored = { base: 'a', 'd-tablet': 'b', 'd-mobile': 'c' };
    const mapped = mapResponsiveValue(stored, definition, page);
    expect(mapped).toEqual({ base: 'a', medium: 'b', narrow: 'c' });
    for (const frame of page) {
      const direct = resolveCascade(stored, definitionBreakpointFor(frame.minWidth, definition)?.id, definition).value;
      expect(resolveCascade(mapped, frame.id, page).value).toBe(direct);
    }
  });

  it('states the one real loss: a width the page has no frame for', () => {
    const page = [samePage[0], samePage[2]];
    expect(mapResponsiveValue({ base: 'a', 'd-tablet': 'b', 'd-mobile': 'c' }, definition, page)).toEqual({
      base: 'a',
      'p-mobile': 'c',
    });
  });

  it('keeps the base on a page with no frames', () => {
    expect(mapResponsiveValue({ base: 'a', 'd-mobile': 'c' }, definition, [])).toEqual({ base: 'a' });
    expect(mapResponsiveValue({ 'd-mobile': 'c' }, definition, [])).toEqual({});
  });

  it('reads a definition with no frames by its base', () => {
    expect(mapResponsiveValue({ base: 'a' }, [], samePage)).toEqual({ base: 'a' });
  });

  it('keeps a map with no base free of one', () => {
    expect(mapResponsiveValue({ 'd-mobile': 'c' }, definition, samePage)).toEqual({ 'p-mobile': 'c' });
  });

  it('reads a value stored under the primary id as the largest', () => {
    expect(mapResponsiveValue({ 'd-desktop': 'a', 'd-mobile': 'c' }, definition, samePage)).toEqual({
      base: 'a',
      'p-mobile': 'c',
    });
  });

  it('runs the other way for Create component', () => {
    expect(mapResponsiveValue({ base: 'a', 'p-tablet': 'b' }, samePage, definition)).toEqual({ base: 'a', 'd-tablet': 'b' });
  });
});

describe('mapNodeProps', () => {
  it('maps every place a responsive map lives', () => {
    const mapped = mapNodeProps(
      {
        width: { base: 1, 'd-mobile': 2 },
        style: { color: { base: 'red', 'd-tablet': 'blue' }, margin: 0 },
        rules: [{ id: 'r', selector: '&:hover', style: { color: { base: 'red', 'd-mobile': 'blue' } } }, 'not a rule'],
        effects: { appear: { base: { kind: 'fade' }, 'd-mobile': { kind: 'none' } }, hover: 'lift' },
        inputs: { accent: { base: 'red', 'd-mobile': 'blue' }, title: 'Hello' },
      },
      definition,
      samePage,
    );
    expect(mapped).toEqual({
      width: { base: 1, 'p-mobile': 2 },
      style: { color: { base: 'red', 'p-tablet': 'blue' }, margin: 0 },
      rules: [{ id: 'r', selector: '&:hover', style: { color: { base: 'red', 'p-mobile': 'blue' } } }, 'not a rule'],
      effects: { appear: { base: { kind: 'fade' }, 'p-mobile': { kind: 'none' } }, hover: 'lift' },
      inputs: { accent: { base: 'red', 'p-mobile': 'blue' }, title: 'Hello' },
    });
  });

  it('leaves content alone', () => {
    const query = { base: 'a column named base' };
    expect(mapNodeProps({ children: 'text', query }, definition, samePage)).toEqual({ children: 'text', query });
  });
});
