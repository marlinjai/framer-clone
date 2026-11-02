// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { parseSelector } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';
import type { FlatEntry } from '../flatten';
import { encodeClass, keptSourceClass, keyframesName, readSelector, readsClass, renameAnimations, renameCustomProperties, rewriteEntry, steppedOut, styleKey } from '../rewrites';

const entry = (selector: string, at: string[] = []): FlatEntry => ({ candidate: 'c', index: 1, selector, at, declarations: [{ property: 'padding', value: '1px', important: false }] });

describe('steppedOut', () => {
  it.each([
    [':where(& > :not(:last-child))', '& > :where(:not(:last-child))', true],
    [':where(&:hover > :not(:last-child))', '&:hover > :where(:not(:last-child))', true],
    [':where(&:is(:where(.group):hover *) > :not(:last-child))', '&:is(:where(.group):hover *) > :where(:not(:last-child))', true],
    [':is(& > *)', '& > *', false],
    [':is(& *)', '& *', false],
    [':is(& > *):hover', '& > *:hover', false],
    ['&:hover', '&:hover', false],
    [':where(*:is(.x)) &', ':where(*:is(.x)) &', false],
  ])('%s becomes %s', (from, to, raisesWeight) => {
    expect(steppedOut(from)).toEqual({ selector: to, raisesWeight });
  });

  it('gives forms the parser takes, where Tailwind forms are refused', () => {
    for (const form of [':where(& > :not(:last-child))', ':is(& > *)']) {
      expect(parseSelector(form).ok).toBe(false);
      expect(parseSelector(steppedOut(form).selector).ok).toBe(true);
    }
  });
});

describe('readSelector', () => {
  it('prefixes named groups, unescaped, so the parser takes them', () => {
    const read = readSelector('&:is(:where(.group\\/item):hover *)');
    expect(read).toMatchObject({ selector: '&:is(:where(.u-c-group_sitem):hover *)', names: ['group/item'] });
    expect(parseSelector('&:is(:where(.group\\/item):hover *)').ok).toBe(false);
    expect(parseSelector(read.selector).ok).toBe(true);
  });

  it('leaves the class dark variant as it is, and a class in a string or attribute alone', () => {
    expect(readSelector('&:is(.dark *)[title=".a"]').selector).toBe('&:is(.dark *)[title=".a"]');
  });

  it('lists substring readers and prefixes operands that need it', () => {
    expect(readSelector("& svg:not([class*='size-'])")).toMatchObject({ selector: '& svg:not([class*="size-"])', readers: [{ operator: '*=', operand: 'size-' }] });
    expect(readSelector("& [class~='x' i]").selector).toBe('& [class~="u-c-x" i]');
    expect(readSelector('& [class|=btn]').selector).toBe('& [class|="u-c-btn"]');
  });

  it('refuses readers of the whole attribute, of the platform classes, and names a class cannot carry', () => {
    expect(readSelector("& [class$='x']").refused).toBeDefined();
    expect(readSelector('& [class]').refused).toBeDefined();
    expect(readSelector("& [CLASS*='fc-']").refused).toBeDefined();
    expect(readSelector("& [class*='u-']").refused).toBeDefined();
    expect(readSelector('& .a\\.b').refused).toBeDefined();
    expect(readSelector(`& .${'a'.repeat(2000)}`).refused).toBeDefined();
  });
});

describe('readsClass', () => {
  it('reads as a browser would', () => {
    expect(readsClass({ operator: '*=', operand: 'size-', caseInsensitive: false }, 'size-6')).toBe(true);
    expect(readsClass({ operator: '^=', operand: 'icon', caseInsensitive: false }, 'x-icon')).toBe(false);
    expect(readsClass({ operator: '|=', operand: 'btn', caseInsensitive: false }, 'btn-lg')).toBe(true);
    expect(readsClass({ operator: '~=', operand: 'A', caseInsensitive: true }, 'a')).toBe(true);
  });

  it('keeps a class whole under the prefix, with nothing a class should not hold', () => {
    expect(keptSourceClass('size-6')).toBe('u-c-size-6');
    expect(keptSourceClass("[&_svg]:size-4\"<x>")).toBe('u-c-_x5b__x26___svg_x5d_:size-4_x22__x3c_x_x3e_');
  });
});

describe('encodeClass', () => {
  it('is one to one, so two source classes never become one', () => {
    const tokens = ['group/item', 'group-item', 'group_item', 'group__item', 'group_sitem', 'a/_b', 'a_/b', 'a"b', 'a_x22_b'];
    expect(new Set(tokens.map(encodeClass)).size).toBe(tokens.length);
  });

  it('keeps a substring a substring', () => {
    expect(encodeClass('xa_b/c').includes(encodeClass('a_b/'))).toBe(true);
  });
});

describe('names', () => {
  it('renames --tw- outside strings', () => {
    expect(renameCustomProperties('var(--tw-ring, "--tw-kept")')).toBe('var(--u-tw-ring, "--tw-kept")');
  });

  it('writes vendor and custom keys the style format takes', () => {
    expect(styleKey('background-color')).toBe('backgroundColor');
    expect(styleKey('-webkit-line-clamp')).toBe('WebkitLineClamp');
    expect(styleKey('-ms-overflow-style')).toBe('msOverflowStyle');
    expect(styleKey('--tw-shadow')).toBe('--u-tw-shadow');
  });

  it('renames only keyframes this compile produced', () => {
    expect(keyframesName('spin')).toBe('u-spin');
    expect(keyframesName('enter')).toBe('u-tw-enter');
    expect(renameAnimations('spin 1s linear, page-own 2s', new Set(['spin']))).toBe('u-spin 1s linear, page-own 2s');
  });
});

describe('rewriteEntry', () => {
  it('puts hover: under the Hover state gate, and leaves other hover queries', () => {
    expect(rewriteEntry(entry('&:hover', ['@media (hover: hover)']), { systemDark: false })).toMatchObject({ hoverGated: true, entry: { at: [HOVER_GATE] } });
    expect(rewriteEntry(entry('&:is(:where(.group):hover *)', ['@media (hover: hover)']), { systemDark: false })).toMatchObject({ hoverGated: false, entry: { at: ['@media (hover: hover)'] } });
  });

  it('turns the dark class into the media query on request', () => {
    expect(rewriteEntry(entry('&:is(.dark *):hover'), { systemDark: true }).entry).toMatchObject({ selector: '&:hover', at: ['@media (prefers-color-scheme: dark)'] });
    expect(rewriteEntry(entry('&:is(.dark *)'), { systemDark: false })).toMatchObject({ dark: true, entry: { selector: '&:is(.dark *)' } });
  });
});
