// @vitest-environment node

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { familyOf, flattenRule, isSelectorList, mergeRules } from '../flatten';

function flat(css: string) {
  let index = 0;
  const refused: string[] = [];
  const entries = flattenRule(postcss.parse(css).first as Rule, 'c', () => ++index, (candidate) => refused.push(candidate));
  return { entries, refused };
}

describe('flattenRule', () => {
  it('flushes a declaration before its @supports twin, so the later value wins', () => {
    const { entries } = flat('.c { &:hover { background-color: red; @supports (color: color-mix(in lab, red, red)) { background-color: blue; } } }');
    expect(entries.map(({ selector, at, declarations }) => [selector, at, declarations.map((each) => each.value)])).toEqual([
      ['&:hover', [], ['red']],
      ['&:hover', [], ['blue']],
    ]);
  });

  it('keeps any other at-rule as a wrapper, outermost first', () => {
    const { entries } = flat('.c { @media (width >= 48rem) { &:focus { @supports (display: grid) { padding: 1px; } } } }');
    expect(entries).toMatchObject([{ selector: '&:focus', at: ['@media (width >= 48rem)', '@supports (display: grid)'] }]);
  });

  it('nests a selector without & as a descendant, and substitutes one with it', () => {
    const { entries } = flat('.c { :where(& > :not(:last-child)) { margin: 0; } & svg { width: 1px; } }');
    expect(entries.map((entry) => entry.selector)).toEqual([':where(& > :not(:last-child))', '& svg']);
  });

  it('refuses a list inside a list, which would multiply per level', () => {
    const { entries, refused } = flat('.c { & p, & li { &:hover { color: red; } } }');
    expect(entries).toEqual([]);
    expect(refused).toEqual(['c']);
  });

  it('numbers entries in output order', () => {
    const { entries } = flat('.c { color: red; &:hover { color: blue; } padding: 1px; }');
    expect(entries.map((entry) => [entry.index, entry.selector])).toEqual([[1, '&'], [2, '&:hover'], [3, '&']]);
  });
});

describe('isSelectorList', () => {
  it('counts commas outside brackets and strings only', () => {
    expect(isSelectorList('& p, & li')).toBe(true);
    expect(isSelectorList('&:is(p, li)')).toBe(false);
    expect(isSelectorList('&[title="a,b"]')).toBe(false);
  });
});

describe('familyOf', () => {
  it('groups a shorthand with its longhands', () => {
    expect(familyOf('paddingInline')).toBe(familyOf('paddingLeft'));
    expect(familyOf('top')).toBe('inset');
    expect(familyOf('columnGap')).toBe('gap');
    expect(familyOf('--u-tw-shadow')).toBe('--u-tw-shadow');
    expect(familyOf('placeItems')).toBe(familyOf('alignItems'));
    expect(familyOf('justifySelf')).toBe(familyOf('placeSelf'));
    expect(familyOf('columnCount')).toBe(familyOf('columns'));
    expect(familyOf('lineHeight')).toBe(familyOf('fontSize'));
  });
});

describe('mergeRules', () => {
  it('merges one selector across rules that set nothing it sets', () => {
    const merged = mergeRules([
      { selector: '&:hover', style: { color: 'red' } },
      { selector: '&:focus', style: { padding: '1px' } },
      { selector: '&:hover', style: { margin: '2px' } },
    ]);
    expect(merged).toEqual([
      { selector: '&:hover', style: { color: 'red', margin: '2px' } },
      { selector: '&:focus', style: { padding: '1px' } },
    ]);
  });

  it('does not move a rule past one that sets a property of the same family', () => {
    const rules = [
      { selector: '&:hover', style: { paddingLeft: '1px' } },
      { selector: '&:focus', style: { padding: '2px' } },
      { selector: '&:hover', style: { paddingInline: '3px' } },
    ];
    expect(mergeRules(rules)).toHaveLength(3);
  });

  it.each([
    ['placeItems over alignItems', 'alignItems', 'placeItems'],
    ['placeItems over justifyItems', 'justifyItems', 'placeItems'],
    ['placeContent over alignContent', 'alignContent', 'placeContent'],
    ['columns over columnCount', 'columnCount', 'columns'],
    ['font over lineHeight', 'lineHeight', 'font'],
    ['whiteSpace over textWrapMode', 'textWrapMode', 'whiteSpace'],
    ['all over anything', 'color', 'all'],
    ['-webkit-mask-image beside mask-image', 'maskImage', 'WebkitMaskImage'],
    ['word-wrap beside overflow-wrap', 'overflowWrap', 'wordWrap'],
    ['-webkit-backdrop-filter beside backdrop-filter', 'backdropFilter', 'WebkitBackdropFilter'],
    ['-moz-appearance beside appearance', 'appearance', 'MozAppearance'],
  ])('does not move a rule past a shorthand that sets it: %s', (_, longhand, shorthand) => {
    const rules = [
      { selector: '&:hover', style: { [longhand]: 'a' } },
      { selector: '&:focus', style: { [shorthand]: 'b' } },
      { selector: '&:hover', style: { [longhand]: 'c' } },
    ];
    expect(mergeRules(rules)).toHaveLength(3);
  });

  it('moves a repeated key to the end, as a later declaration wins', () => {
    const merged = mergeRules([{ selector: '&', at: ['@media print'], style: { color: 'red', margin: '1px' } }, { selector: '&', at: ['@media print'], style: { color: 'blue' } }]);
    expect(Object.entries(merged[0].style)).toEqual([['margin', '1px'], ['color', 'blue']]);
  });

  it('keeps different wrappers apart', () => {
    expect(mergeRules([{ selector: '&', at: ['@media print'], style: { color: 'red' } }, { selector: '&', style: { margin: '1px' } }])).toHaveLength(2);
  });
});
