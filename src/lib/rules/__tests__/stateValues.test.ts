// What a row reads in a state: the formula of the plan, and the shorthands it looks through.
import { describe, expect, it } from 'vitest';
import { readInState, type StateReadInput } from '../stateValues';
import type { StoredRule } from '../rules';
import { HOVER_GATE } from '../states';

const DESKTOP = 'd';
const TABLET = 't';
const breakpoints = [{ id: DESKTOP, minWidth: 1280 }, { id: TABLET, minWidth: 768 }];

const hover = (style: Record<string, unknown>): StoredRule => ({ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style });
const pressed = (style: Record<string, unknown>): StoredRule => ({ id: 'pressed', selector: '&:active', style });

const read = (input: Partial<StateReadInput> & Pick<StateReadInput, 'property'>) =>
  readInState({ rules: [], normal: {}, ruleId: 'hover', breakpointId: DESKTOP, breakpoints, ...input });

describe('state first, then breakpoint', () => {
  it('reads a Desktop Hover on Tablet even where Normal has a Tablet override', () => {
    const result = read({
      rules: [hover({ color: '#00f' })],
      normal: { color: { base: '#111', [TABLET]: '#222' } },
      property: 'color',
      breakpointId: TABLET,
    });
    expect(result).toEqual({ layer: 'state', value: '#00f', key: 'color', setHere: false, fromBreakpoint: DESKTOP });
  });

  it('says a value is set here on its own breakpoint', () => {
    const rules = [hover({ color: { base: '#00f', [TABLET]: '#0a0' } })];
    expect(read({ rules, property: 'color', breakpointId: TABLET })).toEqual({ layer: 'state', value: '#0a0', key: 'color', setHere: true });
    expect(read({ rules, property: 'color' })).toEqual({ layer: 'state', value: '#00f', key: 'color', setHere: true });
  });

  it('treats a plain value as set on the largest breakpoint, also without a breakpoint', () => {
    expect(read({ rules: [hover({ color: '#00f' })], property: 'color', breakpointId: undefined })).toMatchObject({ setHere: true });
  });

  it('shows Normal for a property the state does not hold', () => {
    expect(read({ rules: [hover({ color: '#00f' })], normal: { opacity: 0.5 }, property: 'opacity' })).toEqual({ layer: 'normal', value: 0.5 });
  });

  it('reads through what Pressed implies, and Pressed itself wins', () => {
    const rules = [hover({ color: '#00f', opacity: 0.8 }), pressed({ opacity: 0.6 })];
    expect(read({ rules, ruleId: 'pressed', property: 'color' })).toEqual({ layer: 'implied', value: '#00f', fromLabel: 'Hover' });
    expect(read({ rules, ruleId: 'pressed', property: 'opacity' })).toMatchObject({ layer: 'state', value: 0.6 });
  });

  it('does not read Pressed from Hover or Focused', () => {
    const rules = [hover({ color: '#00f' }), pressed({ color: '#f00' })];
    expect(read({ rules, ruleId: 'focused', normal: { color: '#111' }, property: 'color' })).toEqual({ layer: 'normal', value: '#111' });
    expect(read({ rules, ruleId: 'hover', property: 'opacity' })).toEqual({ layer: 'none', value: undefined });
  });

  it('finds a state stored under another id, as an import has it', () => {
    const rules: StoredRule[] = [{ id: 'r1', selector: '&:hover', at: [HOVER_GATE], style: { color: '#00f' } }];
    expect(read({ rules, property: 'color' })).toMatchObject({ layer: 'state', value: '#00f' });
  });

  it('reads nothing out of a definition', () => {
    const rules: StoredRule[] = [{ id: 'hover', define: '@keyframes u-x', blocks: [] }];
    expect(read({ rules, property: 'color' })).toEqual({ layer: 'none', value: undefined });
  });
});

describe('looking through a shorthand', () => {
  const normalRead = (style: Record<string, unknown>, property: string) => read({ normal: style, property }).value;

  it('reads box sides', () => {
    expect(normalRead({ padding: '8px' }, 'paddingLeft')).toBe('8px');
    expect(normalRead({ padding: '1px 2px' }, 'paddingLeft')).toBe('2px');
    expect(normalRead({ padding: '1px 2px 3px' }, 'paddingBottom')).toBe('3px');
    expect(normalRead({ margin: '1px 2px 3px 4px' }, 'marginLeft')).toBe('4px');
    expect(normalRead({ inset: '0 auto' }, 'right')).toBe('auto');
  });

  it('reads gap and corners', () => {
    expect(normalRead({ gap: '4px 8px' }, 'rowGap')).toBe('4px');
    expect(normalRead({ gap: '4px 8px' }, 'columnGap')).toBe('8px');
    expect(normalRead({ gap: '4px' }, 'columnGap')).toBe('4px');
    expect(normalRead({ borderRadius: '1px 2px 3px 4px' }, 'borderBottomLeftRadius')).toBe('4px');
    expect(normalRead({ borderRadius: '8px / 4px' }, 'borderTopLeftRadius')).toBe('8px');
  });

  it('reads border in any order, with a function as one token', () => {
    const border = { border: 'solid rgb(0 0 0) 2px' };
    expect(normalRead(border, 'borderWidth')).toBe('2px');
    expect(normalRead(border, 'borderStyle')).toBe('solid');
    expect(normalRead(border, 'borderColor')).toBe('rgb(0 0 0)');
  });

  it('reads background only when it is one thing', () => {
    expect(normalRead({ background: '#123456' }, 'backgroundColor')).toBe('#123456');
    expect(normalRead({ background: 'url(/a.jpg)' }, 'backgroundImage')).toBe('url(/a.jpg)');
    expect(normalRead({ background: 'url(/a.jpg)' }, 'backgroundColor')).toBeUndefined();
    expect(normalRead({ background: 'url(/a.jpg) center / cover' }, 'backgroundImage')).toBeUndefined();
  });

  it('reads font', () => {
    const font = { font: 'italic 700 16px/1.5 "Inter", serif' };
    expect(normalRead(font, 'fontSize')).toBe('16px');
    expect(normalRead(font, 'lineHeight')).toBe('1.5');
    expect(normalRead(font, 'fontWeight')).toBe('700');
    expect(normalRead(font, 'fontFamily')).toBe('"Inter", serif');
    expect(normalRead({ font: 'caption' }, 'fontSize')).toBeUndefined();
  });

  it('names the shorthand as what a reset removes', () => {
    expect(read({ rules: [hover({ padding: '8px' })], property: 'paddingTop' })).toMatchObject({ layer: 'state', key: 'padding', value: '8px', setHere: true });
  });

  it('follows a shorthand down the cascade', () => {
    const rules = [hover({ padding: { base: '8px', [TABLET]: '4px' } })];
    expect(read({ rules, property: 'paddingTop', breakpointId: TABLET })).toMatchObject({ value: '4px', setHere: true });
  });

  it('prefers the longhand a layer holds', () => {
    expect(read({ normal: { padding: '8px', paddingTop: '2px' }, property: 'paddingTop' }).value).toBe('2px');
  });
});
