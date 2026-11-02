// @vitest-environment node
// The breakpoint table of the contract, one row each.

import { describe, expect, it } from 'vitest';
import { DEFAULT_BREAKPOINT_IDS, mapBreakpoints, type NormalDeclaration } from '../breakpoints';

const MD = '@media (width >= 48rem)';
const XL = '@media (width >= 80rem)';
const MAX_MD = '@media (width < 48rem)';
const MAX_XL = '@media (width < 80rem)';
const SM = '@media (width >= 40rem)';

const padding = (value: string, at: string[] = []): NormalDeclaration => ({ key: 'padding', value, at });
const map = (declarations: NormalDeclaration[]) => mapBreakpoints(declarations, DEFAULT_BREAKPOINT_IDS);

describe('mapBreakpoints', () => {
  it.each([
    ['p-2 md:p-4', [padding('2'), padding('4', [MD])], { base: '4', mobile: '2' }],
    ['p-2 xl:p-4', [padding('2'), padding('4', [XL])], { base: '4', tablet: '2' }],
    ['p-2 md:p-4 xl:p-8', [padding('2'), padding('4', [MD]), padding('8', [XL])], { base: '8', tablet: '4', mobile: '2' }],
    ['max-md:p-4 beside p-2', [padding('2'), padding('4', [MAX_MD])], { base: '2', mobile: '4' }],
    ['max-xl:p-4 beside p-2', [padding('2'), padding('4', [MAX_XL])], { base: '2', tablet: '4' }],
  ])('%s is a map', (_, declarations, expected) => {
    const { style, mappedKeys } = map(declarations);
    expect(style).toEqual({ padding: expected });
    expect([...mappedKeys]).toEqual(['padding']);
  });

  it('keeps md: with no unprefixed value literal, so a phone does not take it', () => {
    const { style, mappedKeys } = map([padding('4', [MD])]);
    expect(style).toEqual({});
    expect(mappedKeys.size).toBe(0);
  });

  it('keeps every value of a property with a breakpoint no frame has literal', () => {
    const { style, mappedKeys } = map([padding('2'), padding('4', [MD]), padding('6', [SM])]);
    expect(style).toEqual({ padding: '2' });
    expect(mappedKeys.size).toBe(0);
  });

  it('keeps a shorthand literal beside its longhand, where moving it would change which wins', () => {
    const { style, mappedKeys } = map([
      { key: 'paddingInline', value: '2', at: [] },
      { key: 'paddingLeft', value: '1', at: [] },
      { key: 'paddingInline', value: '4', at: [MD] },
    ]);
    expect(style).toEqual({ paddingInline: '2', paddingLeft: '1' });
    expect(mappedKeys.size).toBe(0);
  });

  it('keeps custom properties literal, as they are read through var()', () => {
    expect(map([{ key: '--u-tw-ring-shadow', value: 'a', at: [] }, { key: '--u-tw-ring-shadow', value: 'b', at: [MD] }]).mappedKeys.size).toBe(0);
  });

  it('lets a later value in a band win, as the cascade does, and leaves out a band that inherits', () => {
    expect(map([padding('2'), padding('4', [MD]), padding('3', [MAX_XL])]).style).toEqual({ padding: { base: '4', tablet: '3' } });
  });

  it('writes the ids it is given', () => {
    expect(mapBreakpoints([padding('2'), padding('4', [MD])], { tablet: 't', mobile: 'm' }).style).toEqual({ padding: { base: '4', m: '2' } });
  });
});
