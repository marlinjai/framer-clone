// Authored rules on the published path: `props.rules` through the parser, into the
// sheet on a class of their own, with Normal moved so a rule can beat it. See
// docs/plans/2026-11-02-selector-styling.md, "Emission on the published page".
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { buildResponsiveCss, MAX_RULE_BYTES_PER_PAGE, MAX_RULES_PER_PAGE, withoutMarkup } from '@/lib/responsive/responsiveCss';
import { collectPageFonts } from '@/lib/fonts/registry';
import { readRules, type ParsedSelectorRule } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';
import { applyResponsiveStyles } from '../applyResponsiveStyles';
import { nodeDomProps, renderComponentNode } from '../renderComponentNode';
import { renderPublishedPage } from '../renderPublishedPage';
import { componentSnapshotToNode } from '../snapshotToComponentNode';

afterEach(() => {
  vi.restoreAllMocks();
});

const BPS: BreakpointRef[] = [
  { id: 'desktop', minWidth: 1280 },
  { id: 'tablet', minWidth: 768 },
  { id: 'mobile', minWidth: 320 },
];

/** Valid CSS a browser applies inline, which the sheet refuses for looking like a comment. */
const REFUSED_BY_THE_SHEET = 'url("/a/*/b.png")';

const hover = (style: Record<string, unknown>) => ({ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style });
const pressed = (style: Record<string, unknown>) => ({ id: 'pressed', selector: '&:active', style });
const node = (id: string, props: Record<string, unknown>, children?: ComponentNode[]): ComponentNode =>
  ({ id, type: 'div', props, ...(children ? { children } : {}) }) as ComponentNode;
const propsOf = (n: ComponentNode | undefined) => n?.props as Record<string, unknown>;
const silence = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const parse = (rules: unknown[]) => readRules({ rules }).rules as ParsedSelectorRule[];
/** A rule that never met the parser, as a slip in a later caller would make one. */
const handBuilt = (over: Partial<ParsedSelectorRule> = {}): ParsedSelectorRule => ({
  kind: 'selector',
  id: 'r',
  parts: ['&'],
  at: [],
  style: { color: 'red' },
  ...over,
});

describe('a rule in the sheet', () => {
  it('writes the example of the contract exactly', () => {
    const root = node('a1', {
      style: { color: { base: '#111', tablet: '#222' } },
      rules: [hover({ color: { base: '#00f', tablet: '#0a0' } })],
    });
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    expect(css).toBe(
      '.fc-a1.fc-a1{color:#111}\n' +
        '@media (max-width:1279.98px){\n.fc-a1.fc-a1{color:#222}\n}\n' +
        '@media (hover:hover) and (pointer:fine){\n.fc_r-a1.fc_r-a1:hover{color:#00f}\n}\n' +
        '@media (max-width:1279.98px){\n@media (hover:hover) and (pointer:fine){\n.fc_r-a1.fc_r-a1:hover{color:#0a0}\n}\n}',
    );
    expect(out.props).toEqual({ className: 'fc-a1 fc_r-a1' });
  });

  it('keeps Pressed above a Tablet Hover, by grouping on the rule rather than the breakpoint', () => {
    const { css } = applyResponsiveStyles(
      node('a', { rules: [hover({ color: { base: 'blue', tablet: 'green' } }), pressed({ color: 'red' })] }),
      BPS,
    );
    expect(css.indexOf('fc_r-a:active')).toBeGreaterThan(css.lastIndexOf('fc_r-a:hover'));
  });

  it('writes one rule per part of a list, so one unknown part cannot lose the rest', () => {
    const { css } = applyResponsiveStyles(node('a', { rules: [{ id: 'r', selector: '&::picker(select), &:hover', style: { color: 'red' } }] }), BPS);
    expect(css).toBe('.fc_r-a.fc_r-a::picker(select){color:red}\n.fc_r-a.fc_r-a:hover{color:red}');
  });

  it('merges adjacent blocks with identical wrappers and nests wrappers in stored order', () => {
    const at = ['@supports (display:grid)', '@media print'];
    const { css } = applyResponsiveStyles(
      node('a', { rules: [{ id: 'r', selector: '&', at, style: { color: 'red' } }, { id: 's', selector: '&::after', at, style: { color: 'blue' } }] }),
      BPS,
    );
    expect(css).toBe('@supports (display:grid){\n@media print{\n.fc_r-a.fc_r-a{color:red}\n.fc_r-a.fc_r-a::after{color:blue}\n}\n}');
  });

  it('writes rules after every Normal block, in walk order and stored order', () => {
    const root = node('p', { rules: [{ id: 'r', selector: '&', style: { color: 'red' } }] }, [
      node('c', { style: { margin: { base: 1, mobile: 2 } }, rules: [{ id: 's', selector: '&', style: { color: 'blue' } }] }),
    ]);
    const { css } = applyResponsiveStyles(root, BPS);
    expect(css).toBe(
      '.fc-c.fc-c{margin:1px}\n@media (max-width:767.98px){\n.fc-c.fc-c{margin:2px}\n}\n' +
        '.fc_r-p.fc_r-p{color:red}\n.fc_r-c.fc_r-c{color:blue}',
    );
  });

  it('still applies with no breakpoints at all', () => {
    expect(applyResponsiveStyles(node('a', { rules: [pressed({ color: { base: 'red' } })] }), []).css).toBe('.fc_r-a.fc_r-a:active{color:red}');
  });

  it('issues no Normal class for a node with only rules', () => {
    const { root } = applyResponsiveStyles(node('a', { className: 'mine', rules: [pressed({ color: 'red' })] }), BPS);
    expect(root.props).toEqual({ className: 'mine fc_r-a' });
  });

  it('drops a rule whole when the sheet refuses one of its values', () => {
    const onDropRule = vi.fn();
    // Built by hand: the parser refuses this value too, and all or nothing must hold without it.
    const rules = [handBuilt({ style: { color: 'red', backgroundImage: 'url(/a<b.png)' } })];
    const css = buildResponsiveCss([], BPS, { authored: [{ className: 'fc_r-a', rules }], onDropRule });
    expect(css).toBe('');
    expect(onDropRule).toHaveBeenCalledWith(expect.objectContaining({ className: 'fc_r-a', ruleId: 'r' }));
  });

  it('skips a rule class that is not a safe one', () => {
    const rules = parse([pressed({ color: 'red' })]);
    expect(buildResponsiveCss([], BPS, { authored: [{ className: 'x{}', rules }] })).toBe('');
  });
});

describe('the guard behind the parser', () => {
  const written = (rule: ParsedSelectorRule) => {
    const onDropRule = vi.fn();
    const css = buildResponsiveCss([], BPS, { authored: [{ className: 'fc_r-a', rules: [rule] }], onDropRule });
    return { css, onDropRule };
  };

  it('refuses the payload of the review, a part that ran script in Chromium', () => {
    const { css, onDropRule } = written(handBuilt({ parts: ['&{}</style><script>alert(1)</script><style>'] }));
    expect(css).toBe('');
    expect(onDropRule).toHaveBeenCalledWith(expect.objectContaining({ className: 'fc_r-a', ruleId: 'r' }));
  });

  it.each([
    ['<', '&:hover<'],
    ['{', '&{'],
    ['}', '&}'],
    [';', '&;'],
    ['a backslash', '&\\3c'],
    ['a comment', '&/*x*/'],
    ['a newline', '&\n'],
    ['a null', '&\u0000'],
    ['a delete', '&\u007f'],
  ])('refuses %s in a part', (_label, part) => {
    expect(written(handBuilt({ parts: [part] })).css).toBe('');
  });

  it.each([
    ['<', '@media print</style>'],
    ['{', '@media print{}body'],
    ['}', '@media print}'],
    [';', '@media print;'],
    ['a backslash', '@media \\70rint'],
    ['a comment', '@media /*x*/ print'],
    ['a newline', '@media\nprint'],
  ])('refuses %s in a wrapper', (_label, wrapper) => {
    expect(written(handBuilt({ at: [wrapper] })).css).toBe('');
  });

  it('refuses a part that does not start with &', () => {
    expect(written(handBuilt({ parts: ['body'] })).css).toBe('');
    expect(written(handBuilt({ parts: ['&', 'body'] })).css).toBe('');
  });

  it('refuses what the type would have ruled out, without throwing', () => {
    for (const broken of [{ parts: '&' }, { parts: [1] }, { parts: undefined }, { at: '@media print' }, { at: [1] }, { at: undefined }, { style: undefined }, { style: 'color:red' }]) {
      const { css, onDropRule } = written(handBuilt(broken as never));
      expect(css).toBe('');
      expect(onDropRule).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves the other rules of the node standing', () => {
    const rules = [handBuilt({ parts: ['&<'] }), handBuilt({ id: 's', parts: ['&:hover'] })];
    expect(buildResponsiveCss([], BPS, { authored: [{ className: 'fc_r-a', rules }] })).toBe('.fc_r-a.fc_r-a:hover{color:red}');
  });

  it('passes every part and wrapper the parser accepts', () => {
    const rules = parse([{ id: 'r', selector: '&:is(.dark *), & ul > li, &[data-a="b"]::before', at: ['@media (min-width: 640px)', '@supports (display:grid)', '@scope (.a) to (.b)'], style: { color: 'red' } }]);
    expect(buildResponsiveCss([], BPS, { authored: [{ className: 'fc_r-a', rules }] })).toContain('.fc_r-a.fc_r-a:is(.dark *){color:red}');
  });

  it('never lets a sheet out with a <', () => {
    const onDropRule = vi.fn();
    expect(withoutMarkup('.a{color:red}', onDropRule)).toBe('.a{color:red}');
    expect(onDropRule).not.toHaveBeenCalled();
    expect(withoutMarkup('.a{color:red}</style><script>', onDropRule)).toBe('');
    expect(onDropRule).toHaveBeenCalledTimes(1);
  });
});

describe('what the parser refuses', () => {
  const refused: [string, Record<string, unknown>][] = [
    ['a selector closing the style element', { id: 'r', selector: '&:hover</style><script>', style: { color: 'red' } }],
    ['a selector leaving the node', { id: 'r', selector: '& + p', style: { color: 'red' } }],
    ['a selector reading typed text', { id: 'r', selector: '&:has(input[value^="a"])', style: { color: 'red' } }],
    ['an external address', { id: 'r', selector: '&:hover', style: { backgroundImage: 'url(https://evil.test/x)' } }],
    ['an unknown wrapper', { id: 'r', selector: '&', at: ['@layer x'], style: { color: 'red' } }],
    ['a value leaving the rule', { id: 'r', selector: '&', style: { color: 'red}body{display:none' } }],
    ['a binding', { id: 'r', selector: '&', style: { color: '{{row.colour}}' } }],
    ['a < in an unquoted url', { id: 'r', selector: '&', style: { backgroundImage: 'url(/a<b.png)' } }],
    ['the end of the style element in an unquoted url', { id: 'r', selector: '&', style: { backgroundImage: 'url(/a</style>.png)' } }],
    ['a > in an unquoted url', { id: 'r', selector: '&', style: { backgroundImage: 'url(/a>b.png)' } }],
  ];

  it.each(refused)('drops %s whole and warns once, leaving the node as it was', (_label, rule) => {
    const warn = silence();
    const { root, css } = applyResponsiveStyles(node('a', { style: { color: 'blue' }, rules: [rule] }), BPS);
    expect(css).toBe('');
    expect(root.props).toEqual({ style: { color: 'blue' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][2]).toEqual([expect.objectContaining({ node: 'a', rule: 'r' })]);
  });

  it('keeps the good rules of a list and reports the page once', () => {
    const warn = silence();
    const root = node('a', { rules: [pressed({ color: 'red' }), { id: 'bad', selector: 'nope', style: {} }, null] }, [
      node('b', { rules: [{ id: 'worse', selector: '&<', style: {} }] }),
    ]);
    const { css } = applyResponsiveStyles(root, BPS);
    expect(css).toBe('.fc_r-a.fc_r-a:active{color:red}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][2]).toHaveLength(3);
  });

  it('survives any shape of list and never lets one reach the markup', () => {
    silence();
    const { root } = applyResponsiveStyles(node('a', { rules: [1, 'x', [], {}, null] }), BPS);
    expect(root.props).toEqual({});
  });

  it('escapes a < in a quoted url, which is a string the emitter owns', () => {
    const { css } = applyResponsiveStyles(node('a', { rules: [{ id: 'r', selector: '&', style: { backgroundImage: "url('/a<b.png')" } }] }), BPS);
    expect(css).toBe(".fc_r-a.fc_r-a{background-image:url('/a\\3c b.png')}");
  });

  it.each([
    ['an object', { 0: { id: 'r' } }],
    ['a number', 5],
    ['true', true],
  ])('never renders %s as a rules attribute', (_label, rules) => {
    const table = { id: 't', type: 'table', props: { rules } } as unknown as ComponentNode;
    const { root } = applyResponsiveStyles(table, BPS);
    expect(nodeDomProps(root)).not.toHaveProperty('rules');
    expect(renderToStaticMarkup(<>{renderComponentNode(root)}</>)).toBe('<table></table>');
  });

  it('leaves a stored string alone, the legacy table attribute', () => {
    const warn = silence();
    const table = { id: 't', type: 'table', props: { rules: 'all' } } as ComponentNode;
    expect(applyResponsiveStyles(table, BPS).root.props).toEqual({ rules: 'all' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a text node, which has no element, and says so', () => {
    const warn = silence();
    const text = { id: 't', type: '#text', props: { children: 'x', rules: [pressed({ color: 'red' })] } } as ComponentNode;
    const { root, css } = applyResponsiveStyles(node('a', {}, [text]), BPS);
    expect(css).toBe('');
    expect(propsOf(root.children?.[0])).toEqual({ children: 'x' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not count a definition as a rule that moves Normal', () => {
    const definition = { id: 'k', define: '@keyframes u-a', blocks: [{ selector: 'from', style: { opacity: 0 } }] };
    const { root, css } = applyResponsiveStyles(node('a', { style: { color: 'red' }, rules: [definition] }), BPS);
    expect(root.props).toEqual({ style: { color: 'red' } });
    expect(css).toBe('');
  });
});

describe('moving Normal', () => {
  it('moves a plain style to a class, because inline beats any selector', () => {
    const { root, css } = applyResponsiveStyles(node('a', { style: { color: 'red', margin: 0 }, rules: [pressed({ color: 'blue' })] }), BPS);
    expect(root.props).toEqual({ className: 'fc-a fc_r-a' });
    expect(css).toContain('.fc-a.fc-a{color:red;margin:0}');
  });

  it('leaves a value the sheet refuses inline, alone, and reports it', () => {
    const warn = silence();
    const refused = REFUSED_BY_THE_SHEET;
    const { root, css } = applyResponsiveStyles(
      node('a', { style: { color: 'red', backgroundImage: refused }, rules: [pressed({ color: 'blue' })] }),
      BPS,
    );
    expect(root.props).toEqual({ className: 'fc-a fc_r-a', style: { backgroundImage: refused } });
    expect(css).toContain('.fc-a.fc-a{color:red}');
    expect(css).not.toContain('b.png');
    expect(warn.mock.calls[0][1]).toEqual([{ className: 'fc-a', property: 'backgroundImage', reason: 'unsafe-value' }]);
  });

  it('keeps that value on the rendered page', () => {
    silence();
    const { root } = applyResponsiveStyles(
      node('a', { style: { color: 'red', backgroundImage: REFUSED_BY_THE_SHEET }, rules: [pressed({ color: 'blue' })] }),
      BPS,
    );
    const html = renderToStaticMarkup(<>{renderComponentNode(root)}</>);
    expect(html).toContain('style="background-image:url(&quot;/a/*/b.png&quot;)"');
    expect(html).toContain('class="fc-a fc_r-a"');
  });

  it('keeps the base of a refused map inline and names the breakpoints it loses', () => {
    const warn = silence();
    const { root, css } = applyResponsiveStyles(
      node('a', { style: { backgroundImage: { base: REFUSED_BY_THE_SHEET, mobile: 'none' } }, rules: [pressed({ color: 'blue' })] }),
      BPS,
    );
    expect(root.props).toEqual({ className: 'fc_r-a', style: { backgroundImage: REFUSED_BY_THE_SHEET } });
    expect(css).toBe('.fc_r-a.fc_r-a:active{color:blue}');
    expect(warn.mock.calls[0][1]).toEqual([
      { className: 'fc-a', property: 'backgroundImage', reason: 'unsafe-value', lostBreakpoints: ['mobile'] },
    ]);
  });

  it('keeps a map in the sheet when only an override is refused, and reports that override', () => {
    const warn = silence();
    const { root, css } = applyResponsiveStyles(
      node('a', { style: { color: { base: 'red', tablet: 'blue', mobile: 'x}y' } } }),
      BPS,
    );
    expect(root.props).toEqual({ className: 'fc-a' });
    expect(css).toContain('.fc-a.fc-a{color:blue}');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives no fallback to a node that is only responsive: nobody touched it', () => {
    const warn = silence();
    const { root, css } = applyResponsiveStyles(node('a', { style: { padding: { base: 1, mobile: 2 }, backgroundImage: REFUSED_BY_THE_SHEET } }), BPS);
    expect(root.props).toEqual({ className: 'fc-a' });
    expect(css).toBe('.fc-a.fc-a{padding:1px}\n@media (max-width:767.98px){\n.fc-a.fc-a{padding:2px}\n}');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives the fallback under a reaching rule, which is a move a rule caused', () => {
    const warn = silence();
    const root = node('a', { rules: [{ id: 'r', selector: '& p', style: { color: 'blue' } }] }, [
      { id: 'p', type: 'p', props: { style: { color: 'red', backgroundImage: REFUSED_BY_THE_SHEET } } } as ComponentNode,
    ]);
    expect(propsOf(applyResponsiveStyles(root, BPS).root.children?.[0])).toEqual({ className: 'fc-p', style: { backgroundImage: REFUSED_BY_THE_SHEET } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('holds a value in the sheet once it can be escaped there', () => {
    const warn = silence();
    const svg = `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>")`;
    const { root, css } = applyResponsiveStyles(node('a', { style: { backgroundImage: svg }, rules: [pressed({ color: 'blue' })] }), BPS);
    expect(root.props).toEqual({ className: 'fc-a fc_r-a' });
    expect(css).toContain('\\3c svg');
    expect(css).not.toContain('<');
    expect(warn).not.toHaveBeenCalled();
  });

  describe('under a rule that reaches inside the node', () => {
    const card = (rule: Record<string, unknown>) =>
      node('card', { rules: [rule] }, [
        { id: 'title', type: 'h2', props: { children: 'x', style: { color: 'red' } } } as ComponentNode,
        node('wrap', {}, [node('deep', { style: { color: 'green' } })]),
        { id: 'text', type: '#text', props: { children: 'y', style: { color: 'pink' } } } as ComponentNode,
      ]);

    it('moves every element with a style to a class, at any depth', () => {
      const { root, css } = applyResponsiveStyles(card({ id: 'r', selector: '&:hover h2', style: { color: 'blue' } }), BPS);
      expect(propsOf(root.children?.[0])).toEqual({ children: 'x', className: 'fc-title' });
      expect(propsOf(root.children?.[1]?.children?.[0])).toEqual({ className: 'fc-deep' });
      expect(css).toBe('.fc-title.fc-title{color:red}\n.fc-deep.fc-deep{color:green}\n.fc_r-card.fc_r-card:hover h2{color:blue}');
    });

    it('skips a text node, which would get a class with no element', () => {
      const { root } = applyResponsiveStyles(card({ id: 'r', selector: '& > *', style: { color: 'blue' } }), BPS);
      expect(propsOf(root.children?.[2])).toEqual({ children: 'y', style: { color: 'pink' } });
    });

    it('moves nothing for a rule on the node itself', () => {
      const { root } = applyResponsiveStyles(card({ id: 'r', selector: '&:has(h2):hover', style: { color: 'blue' } }), BPS);
      expect(propsOf(root.children?.[0])).toEqual({ children: 'x', style: { color: 'red' } });
    });

    it('moves nothing for a rule that was refused', () => {
      silence();
      const { root } = applyResponsiveStyles(card({ id: 'r', selector: '& h2', style: { color: 'url(https://evil.test/x)' } }), BPS);
      expect(propsOf(root.children?.[0])).toEqual({ children: 'x', style: { color: 'red' } });
    });
  });
});

describe('a custom property holding an external address', () => {
  const external = 'url(https://evil.test/x)';

  it('is dropped on any node of a page with a rule, inline or moved', () => {
    const warn = silence();
    const root = node('a', { style: { '--x': external, color: 'red' } }, [
      node('b', { style: { '--y': { base: external, mobile: 'none' }, margin: { base: 1, mobile: 2 } } }),
      node('c', { style: { '--z': external } }),
      node('d', { rules: [pressed({ color: 'blue' })] }),
    ]);
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    expect(out.props).toEqual({ style: { color: 'red' } });
    expect(propsOf(out.children?.[1])).toEqual({});
    expect(css).not.toContain('evil.test');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][2]).toHaveLength(3);
  });

  it('keeps a site path and data:', () => {
    const style = { '--x': 'url(/a.png)', '--y': 'url(data:image/png;base64,AAA=)' };
    const { root } = applyResponsiveStyles(node('a', { style }, [node('b', { rules: [pressed({ color: 'blue' })] })]), BPS);
    expect(root.props).toEqual({ style });
  });

  it('stays on a page with no rule, or with only a refused one: nothing regresses', () => {
    silence();
    const style = { '--x': external };
    expect(applyResponsiveStyles(node('a', { style }), BPS).root.props).toEqual({ style });
    const refused = node('a', { style, rules: [{ id: 'r', selector: 'nope', style: {} }] });
    expect(applyResponsiveStyles(refused, BPS).root.props).toEqual({ style });
  });
});

describe('a stored className', () => {
  const classOf = (className: string) => propsOf(applyResponsiveStyles(node('a', { className }), BPS).root).className;

  it('cannot claim another node\'s rules, the payload of the review', () => {
    const victim = node('v', { rules: [pressed({ color: 'red' })] });
    const thief = node('t', { className: 'fc_r-v' });
    const { root, css } = applyResponsiveStyles(node('p', {}, [victim, thief]), BPS);
    expect(css).toBe('.fc_r-v.fc_r-v:active{color:red}');
    expect(propsOf(root.children?.[0]).className).toBe('fc_r-v');
    expect(root.children?.[1]?.props).toEqual({});
  });

  it('cannot claim another node\'s Normal', () => {
    const victim = node('v', { style: { color: { base: 'red', mobile: 'blue' } } });
    const { root } = applyResponsiveStyles(node('p', {}, [victim, node('t', { className: 'mine fc-v' })]), BPS);
    expect(propsOf(root.children?.[1]).className).toBe('mine');
  });

  it('loses only the issued names, in any letter case, and gets its own after them', () => {
    expect(classOf('a fc-x b fc_r-y FC-z Fc_R-w')).toBe('a b');
    const { root } = applyResponsiveStyles(node('a', { className: 'mine fc_r-other', rules: [pressed({ color: 'red' })] }), BPS);
    expect(propsOf(root).className).toBe('mine fc_r-a');
  });

  it('leaves a name that only looks close, and any other className exactly as stored', () => {
    expect(classOf('fcx fc foo-fc-bar')).toBe('fcx fc foo-fc-bar');
    expect(classOf('  two   spaces  ')).toBe('  two   spaces  ');
  });
});

describe('rows and the page caps', () => {
  it('shares one rule block across rows that differ only in a bound value', () => {
    const rules = [hover({ color: 'blue' })];
    const row = (image: string) => node('tpl', { style: { backgroundImage: image }, rules });
    const root = node('list', {}, [row('url(/a.png)'), row('url(/b.png)'), row('url(/c.png)')]);
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    expect(out.children?.map((c) => propsOf(c).className)).toEqual(['fc-tpl fc_r-tpl', 'fc-tpl--2 fc_r-tpl', 'fc-tpl--3 fc_r-tpl']);
    expect(css.match(/\.fc_r-tpl:hover/g)).toHaveLength(1);
  });

  it('numbers a differing rule under one id', () => {
    const row = (color: string) => node('tpl', { rules: [pressed({ color })] });
    const { root } = applyResponsiveStyles(node('list', {}, [row('red'), row('blue')]), BPS);
    expect(root.children?.map((c) => propsOf(c).className)).toEqual(['fc_r-tpl', 'fc_r-tpl--2']);
  });

  it('never gives a rule class the name of a Normal class', () => {
    const { root } = applyResponsiveStyles(node('a', { style: { color: 'red' }, rules: [pressed({ color: 'blue' })] }, [node('r-a', { style: { margin: { base: 1 } } })]), BPS);
    expect(new Set([propsOf(root).className, propsOf(root.children?.[0]).className].join(' ').split(' ')).size).toBe(3);
  });

  it('counts a repeated list once against the cap, and warns once for rows repeating a refused rule', () => {
    const warn = silence();
    const rows = Array.from({ length: 3000 }, () => node('tpl', { rules: [pressed({ color: 'red' }), { id: 'bad', selector: 'nope', style: {} }] }));
    const { css } = applyResponsiveStyles(node('list', {}, rows), BPS);
    expect(css).toBe('.fc_r-tpl.fc_r-tpl:active{color:red}');
    expect(warn.mock.calls[0][2]).toHaveLength(1);
  });

  it('drops later rules whole past the rule count, with the warning', () => {
    const warn = silence();
    const list = Array.from({ length: MAX_RULES_PER_PAGE + 5 }, (_, i) => node(`n${i}`, { rules: [pressed({ color: 'red' })] }));
    const { css } = applyResponsiveStyles(node('root', {}, list), BPS);
    expect(css.match(/:active/g)).toHaveLength(MAX_RULES_PER_PAGE);
    expect(warn.mock.calls[0][0]).toContain('left out 5');
  });

  it('counts a list part as one emitted rule and never cuts a rule in half', () => {
    const silenced = vi.fn();
    const rules = parse([pressed({ color: 'red' }), { id: 'two', selector: '&:hover, &:focus', style: { color: 'blue' } }]);
    const fill = Array.from({ length: MAX_RULES_PER_PAGE - 2 }, (_, i) => ({ className: `fc_r-f${i}`, rules: parse([pressed({ color: 'red' })]) }));
    const css = buildResponsiveCss([], BPS, { authored: [...fill, { className: 'fc_r-a', rules }], onDropRule: silenced });
    expect(css).toContain('fc_r-a:active');
    expect(css).not.toContain('fc_r-a:hover');
    expect(css).not.toContain('fc_r-a:focus');
    expect(silenced).toHaveBeenCalledTimes(1);
  });

  it('drops later rules past the byte ceiling, whatever the count', () => {
    const big = `url("data:font/woff2;base64,${'A'.repeat(MAX_RULE_BYTES_PER_PAGE / 2)}")`;
    const onDropRule = vi.fn();
    const rules = parse([1, 2, 3].map((i) => ({ id: `r${i}`, selector: `&:nth-child(${i})`, style: { backgroundImage: big } })));
    const small = parse([pressed({ color: 'red' })]);
    const css = buildResponsiveCss([], BPS, { authored: [{ className: 'fc_r-a', rules }, { className: 'fc_r-b', rules: small }], onDropRule });
    expect(css.match(/nth-child/g)).toHaveLength(1);
    expect(css).not.toContain('fc_r-b');
    expect(onDropRule).toHaveBeenCalledTimes(3);
  });
});

describe('a page without rules', () => {
  const tablet = '@media (max-width:1279.98px){\n.fc-a.fc-a';

  // Each of these changed in the first version of this slice, on pages nobody touched.
  it.each([
    ['a value holding an address', 'red;background:url(https://x.test/a)'],
    ['a value leaving the rule', 'red}*{x:y'],
    ['an expression', 'expression(alert(1))'],
    ['an escape outside a string', 'Foo\\ Bar'],
  ])('drops %s and keeps its override, delivering nothing inline', (_label, base) => {
    silence();
    const { root, css } = applyResponsiveStyles(node('a', { style: { color: { base, tablet: 'blue' } } }), BPS);
    expect(css).toBe(`${tablet}{color:blue}\n}`);
    expect(root.props).toEqual({ className: 'fc-a' });
  });

  it('drops an unsafe property on a responsive node, delivering nothing inline', () => {
    silence();
    const { root, css } = applyResponsiveStyles(node('a', { style: { 'a;b': 'x', color: { base: 'red', tablet: 'blue' } } }), BPS);
    expect(css).toBe(`.fc-a.fc-a{color:red}\n${tablet}{color:blue}\n}`);
    expect(root.props).toEqual({ className: 'fc-a' });
  });

  it('holds what it can now escape, the one change a page without rules sees', () => {
    silence();
    const { css } = applyResponsiveStyles(node('a', { style: { content: { base: '"a<b"', tablet: '"c"' } } }), BPS);
    expect(css).toBe(`.fc-a.fc-a{content:"a\\3c b"}\n${tablet}{content:"c"}\n}`);
  });

  it('renders exactly as it did before rules existed', () => {
    const warn = silence();
    const root = node('a', { className: 'hero', style: { padding: { base: '8px', tablet: '4px' }, color: 'red' } }, [
      node('b', { style: { margin: 0, backgroundImage: 'url("data:image/png;base64,AAA=")' } }),
      { id: 't', type: 'table', props: { rules: 'all', style: { color: 'red' } } } as ComponentNode,
    ]);
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    expect(css).toBe('.fc-a.fc-a{padding:8px;color:red}\n@media (max-width:1279.98px){\n.fc-a.fc-a{padding:4px}\n}');
    expect(renderToStaticMarkup(<>{renderComponentNode(out)}</>)).toBe(
      '<div class="hero fc-a"><div style="margin:0;background-image:url(&quot;data:image/png;base64,AAA=&quot;)"></div>' +
        '<table rules="all" style="color:red"></table></div>',
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the whole published page', () => {
  const cmsRepo = {} as CmsReadRepository;
  const commerceRepo = {} as CommerceServerRepository;

  it('reaches the markup through every step, with both classes and no rules attribute', async () => {
    const root = node('a', {
      style: { color: 'red' },
      effects: { hover: { kind: 'dim' } },
      rules: [hover({ color: 'blue' })],
    });
    const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).toContain('.fc_r-a.fc_r-a:hover{color:blue}');
    expect(html).toMatch(/<div[^>]*class="fc-a fc_r-a"/);
    expect(html).not.toMatch(/<div[^>]* rules=/);
  });

  it('keeps rules through a saved snapshot, as a live page loads them', async () => {
    const saved = componentSnapshotToNode({ id: 'a', type: 'div', props: { style: { color: 'red' }, rules: [pressed({ color: 'blue' })] }, children: [] });
    const { body } = await renderPublishedPage({ root: saved, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).toContain('.fc_r-a.fc_r-a:active{color:blue}');
    expect(html).toMatch(/<div class="fc-a fc_r-a">/);
  });

  it('gives real collection rows with different bound values one shared rule block', async () => {
    const titles = ['/a.png', '/b.png', '/c.png'];
    const rows = {
      listRows: async () => ({ rows: titles.map((image, i) => ({ id: `r${i}`, values: { image: `url(${image})` } })), total: titles.length }),
    } as unknown as CmsReadRepository;
    const root = {
      type: 'div',
      id: 'col',
      props: { 'data-component-kind': 'collection' },
      bindings: { collection: { mode: 'read', expression: 'col1' } },
      children: [
        {
          type: 'p',
          id: 'tpl',
          props: { children: 'x', style: { backgroundImage: 'none' }, rules: [hover({ color: 'blue' })] },
          bindings: { 'style.backgroundImage': { mode: 'read', expression: '{{row.image}}' } },
        },
      ],
    } as unknown as ComponentNode;
    const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo: rows, commerceRepo, breakpoints: BPS });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html.match(/\.fc_r-tpl:hover/g)).toHaveLength(1);
    expect(html.match(/class="fc-tpl[^"]* fc_r-tpl"/g)).toHaveLength(3);
    for (const title of titles) expect(html).toContain(`background-image:url(${title})`);
  });

  it('leaves a {{binding}} in a rule as text, which the parser refuses', async () => {
    const warn = silence();
    const root = node('a', { rules: [pressed({ color: '{{row.colour}}' })] });
    const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    expect(renderToStaticMarkup(<>{body}</>)).not.toContain('fc_r-a');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('declares a font used only on Hover', async () => {
    const root = node('a', { rules: [hover({ fontFamily: 'Fraunces, serif' })] });
    const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    expect(renderToStaticMarkup(<>{body}</>)).toMatch(/@font-face\{[^}]*font-family:\s*["']?Fraunces/);
  });

  it('cannot close its style element from a stored string', async () => {
    const root = node('a', { rules: [{ id: 'r', selector: '&::after', style: { content: '"</style><img src=x>"' } }] });
    const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).toContain('content:"\\3c /style>\\3c img src=x>"');
    expect(html).not.toContain('<img');
  });
});

describe('fonts', () => {
  const family = 'Fraunces, serif';

  it('loads a family used only in a rule, without treating it as the node\'s own', () => {
    const root = { type: 'h1', props: { rules: [{ id: 'r', selector: '&:hover', style: { fontFamily: { base: family } } }] } };
    const fonts = collectPageFonts([root]);
    expect(fonts.ids).toEqual(['fraunces']);
    expect(fonts.displayId).toBeUndefined();
  });

  it('ignores a legacy attribute and any malformed entry', () => {
    expect(collectPageFonts([{ type: 'table', props: { rules: 'all' } }]).ids).toEqual([]);
    expect(collectPageFonts([{ type: 'div', props: { rules: [null, 1, 'x', {}] } }]).ids).toEqual([]);
  });
});
