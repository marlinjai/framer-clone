// Definitions on the published path: `@keyframes`, `@font-face` and the rest of the
// list, global to the page, from any node. See
// docs/plans/2026-11-02-selector-styling.md, "At-rules" and "Emission on the
// published page". What a browser does with them is in test/score/definitions.score.ts.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import {
  buildResponsiveCss,
  FIELD_SIZING_GUARD,
  MAX_DEFINITION_BLOCKS,
  MAX_RULE_BYTES_PER_PAGE,
  MAX_RULES_PER_PAGE,
  setsFieldSizing,
  type DroppedRule,
} from '@/lib/responsive/responsiveCss';
import { collectPageFonts, FONT_LIBRARY } from '@/lib/fonts/registry';
import { parseRule, PROPERTY_SYNTAXES, readRules, type ParsedDefinitionRule } from '@/lib/rules/rules';
import { applyResponsiveStyles } from '../applyResponsiveStyles';
import { renderPublishedPage } from '../renderPublishedPage';
import { componentSnapshotToNode } from '../snapshotToComponentNode';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A sheet on a page holding a stored rule or definition, which always ends with the guard. */
const withGuard = (text: string): string => `${text}\n${FIELD_SIZING_GUARD}`;

const BPS: BreakpointRef[] = [
  { id: 'desktop', minWidth: 1280 },
  { id: 'tablet', minWidth: 768 },
  { id: 'mobile', minWidth: 320 },
];

const node = (id: string, props: Record<string, unknown>, children?: ComponentNode[]): ComponentNode =>
  ({ id, type: 'div', props, ...(children ? { children } : {}) }) as ComponentNode;
const propsOf = (n: ComponentNode | undefined) => n?.props as Record<string, unknown>;
const silence = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

const keyframes = (name: string, to: Record<string, unknown> = { opacity: 0 }, id = 'k') => ({
  id,
  define: `@keyframes ${name}`,
  blocks: [{ selector: 'to', style: to }],
});
const face = (style: Record<string, unknown>, id = 'f') => ({ id, define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/a.woff2)', ...style } });

const cssOf = (rules: unknown[]): string => applyResponsiveStyles(node('n', { rules }), BPS).css;

describe('what the sheet holds', () => {
  it.each<[string, unknown, string]>([
    ['@keyframes', { id: 'r', define: '@keyframes u-spin', blocks: [{ selector: 'from', style: { opacity: 0 } }, { selector: '50%, 75.5%', style: { opacity: 0.5 } }, { selector: 'to', style: { opacity: 1, translate: '0 10px' } }] }, '@keyframes u-spin{\nfrom{opacity:0}\n50%, 75.5%{opacity:0.5}\nto{opacity:1;translate:0 10px}\n}'],
    ['@font-face', { id: 'r', define: '@font-face', style: { fontFamily: '"u-brand"', src: 'url(/a.woff2) format("woff2"), url(data:font/woff2;base64,AAAA)', fontWeight: 700, fontDisplay: 'swap' } }, '@font-face{font-family:"u-brand";src:url(/a.woff2) format("woff2"), url(data:font/woff2;base64,AAAA);font-weight:700;font-display:swap}'],
    ['@font-feature-values', { id: 'r', define: '@font-feature-values u-brand', blocks: [{ selector: '@styleset', style: { nice: 1, fancy: '2 3' } }] }, '@font-feature-values u-brand{\n@styleset{nice:1;fancy:2 3}\n}'],
    ['@font-palette-values', { id: 'r', define: '@font-palette-values --u-warm', style: { fontFamily: 'u-brand', basePalette: 2 } }, '@font-palette-values --u-warm{font-family:u-brand;base-palette:2}'],
    ['@counter-style', { id: 'r', define: '@counter-style u-stars', style: { system: 'cyclic', symbols: '"*"', pad: '2 "0"' } }, '@counter-style u-stars{system:cyclic;symbols:"*";pad:2 "0"}'],
    ['@position-try', { id: 'r', define: '@position-try --u-under', style: { top: 'anchor(bottom)', marginTop: 8 } }, '@position-try --u-under{top:anchor(bottom);margin-top:8px}'],
    ['@property', { id: 'r', define: '@property --u-accent', style: { syntax: '"<color>"', inherits: 'false', initialValue: 'red' } }, '@property --u-accent{syntax:"\\3c color>";inherits:false;initial-value:red}'],
  ])('writes %s from the parsed name, never the stored text', (_, rule, expected) => {
    expect(cssOf([rule])).toBe(withGuard(expected));
  });

  it('writes the name it parsed, so an odd spelling of the at-rule does not reach the page', () => {
    expect(cssOf([{ id: 'r', define: '  @KEYFRAMES   u-spin ', blocks: [{ selector: 'to', style: { opacity: 0 } }] }])).toBe(withGuard('@keyframes u-spin{\nto{opacity:0}\n}'));
  });

  it('puts definitions before every Normal block and every rule, whichever node holds them', () => {
    const tree = node('a', { style: { color: { base: 'red', tablet: 'blue' } }, rules: [{ id: 'h', selector: '&:hover', style: { color: 'green' } }] }, [
      node('b', { rules: [keyframes('u-late')] }),
    ]);
    const { css } = applyResponsiveStyles(tree, BPS);
    expect(css.indexOf('@keyframes u-late')).toBe(0);
    expect(css.indexOf('.fc-a.fc-a')).toBeGreaterThan(0);
    expect(css.indexOf('.fc_r-a.fc_r-a:hover')).toBeGreaterThan(css.indexOf('.fc-a.fc-a'));
  });

  it('keeps a number a number in a descriptor, and pixels where a body holds real properties', () => {
    expect(cssOf([{ id: 'r', define: '@keyframes u-x', blocks: [{ selector: 'to', style: { top: 5, opacity: 1 } }] }])).toContain('top:5px;opacity:1');
    expect(cssOf([{ id: 'r', define: '@property --u-x', style: { syntax: '"<number>"', inherits: 'false', initialValue: 5 } }])).toContain('initial-value:5');
    expect(cssOf([{ id: 'r', define: '@property --u-x', style: { syntax: '"<number>"', inherits: 'false', initialValue: 5 } }])).not.toContain('5px');
  });

  it('never puts a < in the sheet for any syntax, so the guard behind it never blanks a page', () => {
    for (const syntax of PROPERTY_SYNTAXES) {
      const css = cssOf([{ id: 'r', define: '@property --u-x', style: { syntax, inherits: 'true' } }]);
      expect(css).toContain('@property --u-x{syntax:"');
      expect(css).not.toContain('<');
    }
  });
});

describe('a definition on a node', () => {
  it('moves nothing, and leaves no trace on the element', () => {
    const { root } = applyResponsiveStyles(node('n', { style: { color: 'red', animation: 'u-spin 1s' }, rules: [keyframes('u-spin')] }), BPS);
    expect(propsOf(root).style).toEqual({ color: 'red', animation: 'u-spin 1s' });
    expect(propsOf(root).className).toBeUndefined();
    expect(propsOf(root).rules).toBeUndefined();
  });

  it('adds a class only for the selector rules beside it', () => {
    const { root, css } = applyResponsiveStyles(node('n', { style: { color: 'red' }, rules: [keyframes('u-spin'), { id: 'h', selector: '&:hover', style: { color: 'blue' } }] }), BPS);
    expect(propsOf(root).className).toBe('fc-n fc_r-n');
    expect(css).toContain('@keyframes u-spin');
    expect(css).toContain('.fc_r-n.fc_r-n:hover{color:blue}');
  });

  it('is global: the sheet holds it once however deep it sits', () => {
    const tree = node('a', {}, [node('b', {}, [node('c', { rules: [keyframes('u-deep')] })])]);
    expect(applyResponsiveStyles(tree, BPS).css).toBe(withGuard('@keyframes u-deep{\nto{opacity:0}\n}'));
  });

  it('is refused on a text node, which has no element, with a report', () => {
    const warn = silence();
    const tree = node('a', {}, [{ id: 't', type: '#text', props: { rules: [keyframes('u-x')] } } as ComponentNode]);
    expect(applyResponsiveStyles(tree, BPS).css).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('turns on the custom property filter, because a keyframe can reach a value through var()', () => {
    const warn = silence();
    const external = 'url(https://evil.test/x)';
    const tree = node('a', { style: { '--x': external }, rules: [keyframes('u-x', { backgroundImage: 'var(--x)' })] });
    const { root } = applyResponsiveStyles(tree, BPS);
    expect(propsOf(root).style).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a binding whole, as every rule does', () => {
    const warn = silence();
    expect(cssOf([keyframes('u-x', { color: '{{row.colour}}' })])).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('loads a library family a keyframe uses, as it does for one used only on Hover', () => {
    const family = FONT_LIBRARY[0];
    const tree = node('n', { rules: [keyframes('u-x', { fontFamily: family.cssFamily })] });
    expect(collectPageFonts([tree]).ids).toEqual([family.id]);
  });
});

describe('identity', () => {
  it('keeps Regular and Bold of one family, and each style, stretch and range of it', () => {
    const faces = [
      face({ fontWeight: 400 }, 'regular'),
      face({ fontWeight: 700 }, 'bold'),
      face({ fontWeight: 400, fontStyle: 'italic' }, 'italic'),
      face({ fontWeight: 400, fontStretch: '75%' }, 'condensed'),
      face({ fontWeight: 400, unicodeRange: 'U+0400-04FF' }, 'cyrillic'),
    ];
    const warn = silence();
    expect(cssOf(faces).match(/@font-face/g)).toHaveLength(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('dedupes identical definitions across nodes, whatever their ids, with no warning', () => {
    const warn = silence();
    const tree = node('a', { rules: [keyframes('u-x', { opacity: 0 }, 'one')] }, [node('b', { rules: [keyframes('u-x', { opacity: 0 }, 'two')] })]);
    expect(applyResponsiveStyles(tree, BPS).css).toBe(withGuard('@keyframes u-x{\nto{opacity:0}\n}'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits one definition for 500 rows of one template', () => {
    const warn = silence();
    const rows = Array.from({ length: 500 }, () => node('row', { rules: [face({ fontWeight: 700 })] }));
    expect(applyResponsiveStyles(node('list', {}, rows), BPS).css.match(/@font-face/g)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets the first in walk order win a clash, reports it, and reports a cloned clash once', () => {
    const warn = silence();
    const loser = () => node('b', { rules: [keyframes('u-x', { opacity: 1 })] });
    const { css } = applyResponsiveStyles(node('a', { rules: [keyframes('u-x', { opacity: 0 })] }, [loser(), loser()]), BPS);
    expect(css).toBe(withGuard('@keyframes u-x{\nto{opacity:0}\n}'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('left out 1 rule(s)');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['no weight and 400', {}, { fontWeight: 400, fontDisplay: 'swap' }],
    ['normal and 400', { fontWeight: 'normal' }, { fontWeight: '400', fontDisplay: 'swap' }],
    ['bold and 700', { fontWeight: 'bold' }, { fontWeight: 700, fontDisplay: 'swap' }],
    ['Bold and bold', { fontWeight: 'Bold' }, { fontWeight: 'bold', fontDisplay: 'swap' }],
    ['no style and normal', {}, { fontStyle: 'normal', fontDisplay: 'swap' }],
    ['no stretch and 100%', {}, { fontStretch: '100%', fontDisplay: 'swap' }],
    ['one range in two spellings', { unicodeRange: 'U+26, U+30' }, { unicodeRange: 'u+26,u+30', fontDisplay: 'swap' }],
    ['a quoted and a bare family', { fontFamily: '"u-brand"' }, { fontFamily: 'u-brand', fontDisplay: 'swap' }],
  ])('reads %s as one face', (_, first, second) => {
    const warn = silence();
    expect(cssOf([face(first, 'a'), face(second, 'b')]).match(/@font-face/g)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps names in their own namespace: a keyframe and a counter style may share one', () => {
    const css = cssOf([keyframes('u-x'), { id: 'c', define: '@counter-style u-x', style: { system: 'cyclic', symbols: '"*"' } }]);
    expect(css).toContain('@keyframes u-x');
    expect(css).toContain('@counter-style u-x');
  });
});

describe('what stays out of the sheet', () => {
  it.each<[string, unknown]>([
    ['a keyframe the editor uses', keyframes('spin')],
    ['a platform keyframe', keyframes('fc-form-spin')],
    ['a library family', { id: 'f', define: '@font-face', style: { fontFamily: FONT_LIBRARY[0].cssFamily, src: 'url(/a.woff2)' } }],
    ['a built-in counter style', { id: 'c', define: '@counter-style decimal', style: { system: 'cyclic', symbols: '"*"' } }],
    ['a platform variable', { id: 'p', define: '@property --tw-rotate-x', style: { syntax: '"*"', inherits: 'false' } }],
    ['an external font', { id: 'f', define: '@font-face', style: { fontFamily: 'u-x', src: 'url(https://fonts.example/a.woff2)' } }],
    ['an @import in a name', { id: 'k', define: '@import url(/x)', blocks: [{ selector: 'to', style: { opacity: 0 } }] }],
  ])('refuses %s, with a report', (_, rule) => {
    const warn = silence();
    expect(cssOf([rule])).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a definition whole when the sheet refuses one value the parser took', () => {
    const dropped: DroppedRule[] = [];
    const rule: ParsedDefinitionRule = { kind: 'definition', id: 'k', atRule: 'keyframes', name: 'u-x', blocks: [{ selector: 'from', style: { opacity: 0 } }, { selector: 'to', style: { color: 'red;x:y' } }] };
    expect(buildResponsiveCss([], BPS, { definitions: [{ node: 'n', rule }], onDropRule: (d) => dropped.push(d) })).toBe('');
    expect(dropped).toEqual([{ className: 'n', ruleId: 'k', reason: 'the stylesheet refuses its color' }]);
  });
});

describe('the guard behind the parser, for a definition that never met it', () => {
  const handBuilt = (over: Partial<ParsedDefinitionRule>): ParsedDefinitionRule => ({ kind: 'definition', id: 'r', atRule: 'keyframes', name: 'u-x', blocks: [{ selector: 'to', style: { opacity: 0 } }], ...over });
  const script = '</style><script>alert(1)</script><style>';

  const cases: [string, Partial<ParsedDefinitionRule>][] = [
    ['an at-rule out of the list', { atRule: 'import' }],
    ['script in the at-rule', { atRule: `keyframes${script}` }],
    ['an inherited object key', { atRule: 'constructor' }],
    ['a name with no prefix', { name: 'spin' }],
    ['a name that breaks out', { name: `u-x{}${script}` }],
    ['a name with a space', { name: 'u-x y' }],
    ['no name', { name: undefined }],
    ['a block that breaks out', { blocks: [{ selector: `to{}${script}`, style: { opacity: 0 } }] }],
    ['a block with a brace', { blocks: [{ selector: 'to{}*', style: { opacity: 0 } }] }],
    ['a block with no style', { blocks: [{ selector: 'to', style: undefined as never }] }],
    ['a block list that is no list', { blocks: 'to' as never }],
    ['both bodies', { style: { opacity: 0 } }],
    ['a syntax not on the list', { atRule: 'property', name: '--u-x', blocks: undefined, style: { syntax: `"${script}"` } }],
    ['a syntax that is not text', { atRule: 'property', name: '--u-x', blocks: undefined, style: { syntax: 7 } }],
    ['a responsive map', { atRule: 'counter-style', blocks: undefined, style: { system: { base: 'cyclic' } } }],
    ['a value that breaks out', { atRule: 'counter-style', blocks: undefined, style: { suffix: '"a"}*{color:red' } }],
    ['a font-face with a name', { atRule: 'font-face', blocks: undefined, style: { fontFamily: 'u-x' } }],
    ['a font-face with a foreign family', { atRule: 'font-face', name: undefined, blocks: undefined, style: { fontFamily: 'Inter' } }],
    ['a font-face with a family that breaks out', { atRule: 'font-face', name: undefined, blocks: undefined, style: { fontFamily: `u-x;}${script}` } }],
  ];

  it.each(cases)('drops %s and reports it', (_, over) => {
    const dropped: DroppedRule[] = [];
    const css = buildResponsiveCss([{ className: 'fc-a', style: { color: 'red' } }], BPS, { definitions: [{ node: 'n', rule: handBuilt(over) }], onDropRule: (d) => dropped.push(d) });
    expect(css).toBe('.fc-a.fc-a{color:red}');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ className: 'n', ruleId: 'r' });
  });
});

describe('the page caps', () => {
  const parsed = (rule: unknown) => readRules({ rules: [rule] }).rules[0] as ParsedDefinitionRule;

  it('counts a definition against the rule cap, and stops at a whole definition', () => {
    const dropped: DroppedRule[] = [];
    const definitions = Array.from({ length: MAX_RULES_PER_PAGE + 3 }, (_, index) => ({ node: 'n', rule: parsed(keyframes(`u-${index}`)) }));
    const css = buildResponsiveCss([], BPS, { definitions, onDropRule: (d) => dropped.push(d) });
    expect(css.match(/@keyframes/g)).toHaveLength(MAX_RULES_PER_PAGE);
    expect(dropped).toHaveLength(3);
  });

  it('counts definitions against what selector rules may then use', () => {
    const dropped: DroppedRule[] = [];
    const definitions = Array.from({ length: MAX_RULES_PER_PAGE }, (_, index) => ({ node: 'n', rule: parsed(keyframes(`u-${index}`)) }));
    const authored = [{ className: 'fc_r-a', rules: [{ kind: 'selector' as const, id: 'h', parts: ['&:hover'], at: [], style: { color: 'red' } }] }];
    const css = buildResponsiveCss([], BPS, { definitions, authored, onDropRule: (d) => dropped.push(d) });
    expect(css).not.toContain('fc_r-a');
    expect(dropped).toEqual([{ className: 'fc_r-a', ruleId: 'h', reason: 'the page is over its rule limit' }]);
  });

  it('leaves a hover preset out of both caps: a full page keeps it', () => {
    const definitions = Array.from({ length: MAX_RULES_PER_PAGE + 3 }, (_, index) => ({ node: 'n', rule: parsed(keyframes(`u-${index}`)) }));
    expect(buildResponsiveCss([], BPS, { definitions, hoverPresets: ['dim'] })).toContain('.fc_fx-dim:hover{opacity:0.8}');
    const authored = [{ className: 'fc_r-a', rules: [{ kind: 'selector' as const, id: 'h', parts: ['&:hover'], at: [], style: { color: 'red' } }] }];
    expect(buildResponsiveCss([], BPS, { hoverPresets: ['dim'], authored })).toContain('.fc_r-a.fc_r-a:hover{color:red}');
  });

  it('counts bytes, because one data: font can outweigh any rule count', () => {
    const dropped: DroppedRule[] = [];
    const font = (size: number, id: string) => ({ node: 'n', rule: parsed(face({ src: `url(data:font/woff2;base64,${'A'.repeat(size)})`, fontWeight: id }, id)) });
    const css = buildResponsiveCss([], BPS, { definitions: [font(MAX_RULE_BYTES_PER_PAGE, '100'), font(10, '200')], onDropRule: (d) => dropped.push(d) });
    expect(css).toBe('');
    expect(dropped.map((d) => d.ruleId)).toEqual(['100', '200']);
  });

  it('keeps the hover states of a page whose font was too big, since a dropped font spends nothing', () => {
    const warn = silence();
    const huge = face({ src: `url(data:font/woff2;base64,${'A'.repeat(MAX_RULE_BYTES_PER_PAGE)})` });
    const { css } = applyResponsiveStyles(node('n', { rules: [huge, { id: 'h', selector: '&:hover', style: { color: 'red' } }] }), BPS);
    expect(css).toBe(withGuard('.fc_r-n.fc_r-n:hover{color:red}'));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the field sizing guard', () => {
  const hover = { id: 'h', selector: '&:hover', style: { color: 'blue' } };

  it('ends the sheet of a page with a selector rule, and of a page with only a definition', () => {
    expect(cssOf([hover]).endsWith(`\n${FIELD_SIZING_GUARD}`)).toBe(true);
    expect(cssOf([keyframes('u-x')]).endsWith(`\n${FIELD_SIZING_GUARD}`)).toBe(true);
    expect(cssOf([face({})]).endsWith(`\n${FIELD_SIZING_GUARD}`)).toBe(true);
    expect(FIELD_SIZING_GUARD).toBe('input,textarea,select{field-sizing:fixed!important}');
  });

  it('stays off a page with no rule, and a page whose rules were all refused', () => {
    const warn = silence();
    expect(applyResponsiveStyles(node('a', { style: { color: { base: 'red', tablet: 'blue' } } }), BPS).css).not.toContain('field-sizing');
    expect(cssOf([keyframes('spin')])).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a plain field-sizing alone on a page with no rule, which nothing can read', () => {
    const { root } = applyResponsiveStyles(node('a', { style: { fieldSizing: 'content' } }), BPS);
    expect(propsOf(root).style).toEqual({ fieldSizing: 'content' });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown> | undefined]>([
    ['its own key', { fieldSizing: 'content' }, undefined],
    ['an important value, which would beat the guard inline', { fieldSizing: 'content!important' }, undefined],
    ['a breakpoint map', { fieldSizing: { base: 'fixed', tablet: 'content' } }, undefined],
    ['a value smuggled after a ;', { color: 'red;field-sizing:content!important' }, undefined],
    ['an escaped smuggle', { color: 'red;fi\\65ld-sizing:content!important' }, undefined],
    ['a smuggle in a map', { color: { base: 'red;field-sizing:content' } }, undefined],
    ['one entry among others', { margin: '0', fieldSizing: 'content' }, { margin: '0' }],
  ])('drops an inline field-sizing on a page with a rule: %s', (_, style, kept) => {
    const warn = silence();
    const tree = node('a', {}, [node('b', { rules: [keyframes('u-x')] }), { id: 'i', type: 'input', props: { style } } as ComponentNode]);
    const { root } = applyResponsiveStyles(tree, BPS);
    expect(propsOf(root.children?.[1]).style).toEqual(kept);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown, boolean]>([
    ['fieldSizing', 'fixed', true],
    ['transition', 'field-sizing 1s', false],
    ['content', '"field-sizing:content"', false],
    ['content', '"a;field-sizing:content"', false],
    ['color', 'red', false],
    ['width', 7, false],
  ])('reads %s: %s', (key, value, sets) => {
    expect(setsFieldSizing(key, value)).toBe(sets);
  });

  it.each<[string, unknown]>([
    ['on the node', { id: 'r', selector: '&', style: { fieldSizing: 'content' } }],
    ['on a control inside it, which outranks the guard', { id: 'r', selector: '& input', style: { fieldSizing: 'content!important' } }],
    ['in a breakpoint map', { id: 'r', selector: '& input', style: { fieldSizing: { base: 'content' } } }],
    ['in a keyframe', keyframes('u-x', { fieldSizing: 'content' })],
  ])('refuses fieldSizing in a rule: %s', (_, rule) => {
    expect(parseRule(rule)).toMatchObject({ ok: false, reason: expect.stringContaining('fieldSizing') });
  });
});

describe('local() in src', () => {
  it('refuses the exact payload of the review', () => {
    const rule = { id: 'r', define: '@font-face', style: { fontFamily: 'u-ka', src: 'local("Menlo-Regular")', unicodeRange: 'U+61', sizeAdjust: '3000%' } };
    expect(parseRule(rule)).toMatchObject({ ok: false, reason: expect.stringContaining('local()') });
  });

  it.each(['local(Menlo)', 'LOCAL("Menlo")', 'Local( "Menlo" )', 'local ("Menlo")', 'url(/a.woff2), local("Menlo")', 'local("A"), url(data:font/woff2;base64,AAAA)'])('refuses %s', (src) => {
    expect(parseRule(face({ src }))).toMatchObject({ ok: false });
  });

  it.each(['url(/a.woff2)', 'url("/a.woff2") format("woff2")', 'url(data:font/woff2;base64,AAAA)', 'url("/local(1).woff2")'])('keeps %s', (src) => {
    expect(parseRule(face({ src }))).toMatchObject({ ok: true });
  });
});

describe('the size of a definition', () => {
  const frames = (count: number) => Array.from({ length: count }, () => ({ selector: 'to', style: { opacity: 0 } }));

  it('holds the most blocks the cap allows, and refuses one more', () => {
    expect(parseRule({ id: 'k', define: '@keyframes u-x', blocks: frames(MAX_DEFINITION_BLOCKS) })).toMatchObject({ ok: true });
    expect(parseRule({ id: 'k', define: '@keyframes u-x', blocks: frames(MAX_DEFINITION_BLOCKS + 1) })).toMatchObject({ ok: false, reason: expect.stringContaining('blocks') });
  });

  it('refuses the payload of the review by count: 64 definitions of 100,000 blocks', () => {
    const warn = silence();
    const blocks = frames(100_000);
    const rules = Array.from({ length: 64 }, (_, index) => ({ id: `k${index}`, define: `@keyframes u-${index}`, blocks }));
    expect(readRules({ rules }).refused.map(({ reason }) => reason)).toEqual(rules.map(() => `@keyframes holds at most ${MAX_DEFINITION_BLOCKS} blocks`));
    expect(cssOf(rules)).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a hand-built definition over the block cap', () => {
    const dropped: DroppedRule[] = [];
    const rule: ParsedDefinitionRule = { kind: 'definition', id: 'k', atRule: 'keyframes', name: 'u-x', blocks: frames(MAX_DEFINITION_BLOCKS + 1) };
    expect(buildResponsiveCss([], BPS, { definitions: [{ node: 'n', rule }], onDropRule: (d) => dropped.push(d) })).toBe('');
    expect(dropped).toHaveLength(1);
  });

  it('checks the size before it builds any text', () => {
    const dropped: DroppedRule[] = [];
    // Refused by the sheet if it were ever written, so the reason shows which check came first.
    const rule: ParsedDefinitionRule = { kind: 'definition', id: 'k', atRule: 'counter-style', name: 'u-x', style: { suffix: `"${'x'.repeat(MAX_RULE_BYTES_PER_PAGE)}"}` } };
    expect(buildResponsiveCss([], BPS, { definitions: [{ node: 'n', rule }], onDropRule: (d) => dropped.push(d) })).toBe('');
    expect(dropped).toEqual([{ className: 'n', ruleId: 'k', reason: 'the page is over its rule limit' }]);
  });
});

describe('the guard behind the parser, on addresses', () => {
  const faceWith = (src: string): ParsedDefinitionRule => ({ kind: 'definition', id: 'r', atRule: 'font-face', style: { fontFamily: 'u-x', src } });
  const frameWith = (style: Record<string, unknown>): ParsedDefinitionRule => ({ kind: 'definition', id: 'r', atRule: 'keyframes', name: 'u-x', blocks: [{ selector: 'to', style }] });

  it.each<[string, ParsedDefinitionRule]>([
    ['the payload of the review', faceWith('url(https://evil.test/a)')],
    ['a quoted address', faceWith('url("https://evil.test/a")')],
    ['a protocol-relative address', faceWith('url(//evil.test/a)')],
    ['an escape in a string', faceWith('url("\\68ttps://evil.test/a")')],
    ['a slash hidden by an escape', faceWith('url("/\\/evil.test/a")')],
    ['src()', faceWith('src("https://evil.test/a")')],
    ['a bare string in image-set()', frameWith({ backgroundImage: 'image-set("https://evil.test/a" 1x)' })],
    ['cross-fade()', frameWith({ backgroundImage: 'cross-fade(url(https://evil.test/a), url(/b.png))' })],
    ['a custom property in a block', frameWith({ '--z': 'url(https://evil.test/a)' })],
  ])('drops %s, which never met the parser', (_, rule) => {
    const dropped: DroppedRule[] = [];
    expect(buildResponsiveCss([], BPS, { definitions: [{ node: 'n', rule }], onDropRule: (d) => dropped.push(d) })).toBe('');
    expect(dropped).toHaveLength(1);
  });

  it('keeps a site path, data: and plain text', () => {
    const css = buildResponsiveCss([], BPS, { definitions: [{ node: 'n', rule: faceWith('url(/a.woff2) format("woff2"), url(data:font/woff2;base64,AAAA)') }, { node: 'n', rule: frameWith({ content: '"https://example.com"' }) }] });
    expect(css).toContain('@font-face');
    expect(css).toContain('@keyframes u-x');
  });
});

describe('the real page', () => {
  const cmsRepo = {} as unknown as CmsReadRepository;
  const commerceRepo = {} as unknown as CommerceServerRepository;

  it('keeps a definition through a saved snapshot, in the sheet and off the element', async () => {
    const saved = componentSnapshotToNode({ id: 'a', type: 'div', props: { style: { animation: 'u-x 1s' }, rules: [keyframes('u-x')] }, children: [] });
    const { body } = await renderPublishedPage({ root: saved, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).toContain('@keyframes u-x{');
    expect(html).toMatch(/<div style="animation:u-x 1s"><\/div>/);
  });

  it('emits one definition for real collection rows, and none for a collection with no rows', async () => {
    const page = (rows: { id: string; values: Record<string, unknown> }[]) => {
      const repo = { listRows: async () => ({ rows, total: rows.length }) } as unknown as CmsReadRepository;
      const root = {
        id: 'list',
        type: 'div',
        props: { 'data-component-kind': 'collection' },
        bindings: { collection: { mode: 'read', expression: 'col1' } },
        children: [{ id: 'tpl', type: 'p', props: { children: 'x', rules: [keyframes('u-row')] } }],
      } as unknown as ComponentNode;
      return renderPublishedPage({ root, pageParams: {}, cmsRepo: repo, commerceRepo, breakpoints: BPS });
    };
    const three = [0, 1, 2].map((index) => ({ id: `r${index}`, values: {} }));
    const filled = renderToStaticMarkup(<>{(await page(three)).body}</>);
    expect(filled.match(/@keyframes u-row/g)).toHaveLength(1);
    expect(filled.match(/<p>x<\/p>/g)).toHaveLength(3);
    const empty = renderToStaticMarkup(<>{(await page([])).body}</>);
    expect(empty).not.toContain('@keyframes u-row');
  });
});

describe('a page with no definition', () => {
  it('holds exactly what it held before definitions existed', () => {
    const rules = [{ className: 'fc-a', style: { color: { base: 'red', tablet: 'blue' } } }];
    expect(buildResponsiveCss(rules, BPS, { definitions: [] })).toBe(buildResponsiveCss(rules, BPS));
    expect(buildResponsiveCss(rules, BPS)).toBe('.fc-a.fc-a{color:red}\n@media (max-width:1279.98px){\n.fc-a.fc-a{color:blue}\n}');
  });
});
