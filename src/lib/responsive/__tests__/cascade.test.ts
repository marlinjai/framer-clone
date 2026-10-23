// The desktop-first cascade: own value, then each larger breakpoint, then base.
import { describe, it, expect } from 'vitest';
import { resolveCascade, resetCascade, writeCascade, largestFirst } from '../cascade';

const BPS = [
  { id: 'phone', minWidth: 0 },
  { id: 'desktop', minWidth: 1280 },
  { id: 'tablet', minWidth: 768 },
];

describe('resolveCascade', () => {
  it('orders breakpoints largest first', () => {
    expect(largestFirst(BPS).map(b => b.id)).toEqual(['desktop', 'tablet', 'phone']);
  });

  it('a plain value applies everywhere', () => {
    expect(resolveCascade('red', 'phone', BPS)).toEqual({ value: 'red', source: { kind: 'base' } });
    expect(resolveCascade(undefined, 'phone', BPS)).toEqual({ value: undefined, source: { kind: 'none' } });
  });

  it('the base is the largest breakpoint own value and inherited below it', () => {
    const map = { base: 'red' };
    expect(resolveCascade(map, 'desktop', BPS).source).toEqual({ kind: 'own' });
    expect(resolveCascade(map, 'phone', BPS)).toEqual({ value: 'red', source: { kind: 'inherited', breakpointId: 'desktop' } });
  });

  it('a Tablet override cascades down to Phone and never up to Desktop', () => {
    const map = { base: '16px', tablet: '20px' };
    expect(resolveCascade(map, 'desktop', BPS).value).toBe('16px');
    expect(resolveCascade(map, 'tablet', BPS)).toEqual({ value: '20px', source: { kind: 'own' } });
    expect(resolveCascade(map, 'phone', BPS)).toEqual({ value: '20px', source: { kind: 'inherited', breakpointId: 'tablet' } });
  });

  it('a Phone override wins on Phone only', () => {
    const map = { base: '16px', tablet: '20px', phone: '14px' };
    expect(resolveCascade(map, 'phone', BPS).value).toBe('14px');
    expect(resolveCascade(map, 'tablet', BPS).value).toBe('20px');
  });

  it('a legacy value under the primary id counts as Desktop own value and cascades down', () => {
    const map = { base: 'black', desktop: 'red' };
    expect(resolveCascade(map, 'desktop', BPS)).toEqual({ value: 'red', source: { kind: 'own' } });
    expect(resolveCascade(map, 'phone', BPS)).toEqual({ value: 'red', source: { kind: 'inherited', breakpointId: 'desktop' } });
  });

  it('an empty override inherits, and an unknown breakpoint reads as the largest', () => {
    expect(resolveCascade({ base: 'red', phone: '' }, 'phone', BPS).value).toBe('red');
    expect(resolveCascade({ base: 'red', tablet: 'blue' }, 'gone', BPS).value).toBe('red');
  });
});

describe('writeCascade and resetCascade', () => {
  it('Desktop writes the base and drops a legacy primary key', () => {
    expect(writeCascade(undefined, 'red', 'desktop', BPS)).toBe('red');
    expect(writeCascade({ base: 'black', desktop: 'red', tablet: 'blue' }, 'green', 'desktop', BPS)).toEqual({ base: 'green', tablet: 'blue' });
  });

  it('a smaller breakpoint writes its own override and keeps the base', () => {
    expect(writeCascade('16px', '20px', 'tablet', BPS)).toEqual({ base: '16px', tablet: '20px' });
  });

  it('clearing an override makes it inherit again and collapses a base-only map', () => {
    const map = { base: '16px', tablet: '20px' };
    expect(writeCascade(map, '', 'tablet', BPS)).toBe('16px');
    expect(resetCascade(map, 'tablet', BPS)).toBe('16px');
  });

  it('reset is a no-op on the largest breakpoint', () => {
    const map = { base: '16px', tablet: '20px' };
    expect(resetCascade(map, 'desktop', BPS)).toBe(map);
  });

  it('no breakpoint context writes the base', () => {
    expect(writeCascade({ base: 'a', phone: 'b' }, 'c', undefined, BPS)).toEqual({ base: 'c', phone: 'b' });
  });
});
