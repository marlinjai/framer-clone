// The generator's rules: everything goes through validateGeneration, the real
// parser behind it, and the page stylesheet where it matters. Model output is
// untrusted, so most of this file is what must not get through.
import { describe, expect, it } from 'vitest';
import ComponentModel from '@/models/ComponentModel';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { HOVER_GATE, NAMED_STATES, namedStateOf } from '@/lib/rules/states';
import { readRules } from '@/lib/rules/rules';
import { breakpointKeyMap, toEditorSnapshot } from '../apply';
import { deriveBreakpointKeys } from '../schema';
import { MAX_GENERATED_ANIMATION_RUNS, MAX_GENERATED_RULES, REDUCED_MOTION_GATE } from '../promptSections/rules';
import { validateGeneration } from '../validate';

const inputs = [
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
];
const breakpoints = deriveBreakpointKeys(inputs);

function run(nodes: unknown[]) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

/** The rules left on a div that was given these, and the warnings they cost. */
function rulesFrom(...rules: unknown[]) {
  const { nodes, warnings } = run([{ type: 'div', props: { rules } }]);
  return { rules: (nodes[0].props.rules ?? []) as Record<string, unknown>[], warnings };
}

const refused = (rule: unknown) => {
  const { rules, warnings } = rulesFrom(rule);
  expect(rules).toEqual([]);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings.join(' ')).toContain('rule dropped');
};

const LONG_DASH = String.fromCodePoint(0x2014);

const hover = (style: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'r', selector: '&:hover', style, ...extra });

/** Does anything of this text reach the page stylesheet, from nodes the validator kept? */
function sheetOf(nodes: unknown[]): string {
  const root = { id: 'root', type: 'div', props: {}, children: nodes } as unknown as ComponentNode;
  return applyResponsiveStyles(root, [
    { id: 'desktop', minWidth: 1280 },
    { id: 'mobile', minWidth: 320 },
  ]).css;
}

describe('generated rules: what is kept', () => {
  it('keeps the taught forms byte for byte, and they read as the named states', () => {
    const list = NAMED_STATES.map((state) => ({
      id: state.id,
      selector: state.selector,
      ...(state.at ? { at: [...state.at] } : {}),
      style: { color: '#00f' },
    }));
    const { rules, warnings } = rulesFrom(...list);
    expect(rules).toEqual(list);
    expect(warnings).toEqual([]);
    expect(rules.map((rule) => namedStateOf(rule as never)?.id)).toEqual(['hover', 'focused', 'pressed']);
  });

  it('keeps a pseudo-element, a structural rule and a dark look', () => {
    const list = [
      { id: 'a', selector: '&::before', style: { content: "''", display: 'block' } },
      { id: 'b', selector: '& > :nth-child(2n)', style: { backgroundColor: '#eee' } },
      { id: 'c', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { color: '#fff' } },
    ];
    expect(rulesFrom(...list)).toEqual({ rules: list, warnings: [] });
  });

  it('keeps what the prompt does not teach, because everything parseable is accepted', () => {
    const list = [
      { id: 'a', selector: '&:has(img)', style: { color: 'red' } },
      { id: 'b', selector: '&:is(.dark *)', style: { color: 'red' } },
      { id: 'c', selector: '&', at: ['@container (min-width: 400px)'], style: { color: 'red' } },
      { id: 'd', define: '@keyframes u-rise', blocks: [{ selector: 'from', style: { opacity: '0' } }, { selector: 'to', style: { opacity: 1 } }] },
      { id: 'e', define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/brand.woff2)' } },
      { id: 'f', define: '@property --u-tint', style: { syntax: '"<color>"', inherits: 'false', initialValue: 'red' } },
    ];
    expect(rulesFrom(...list)).toEqual({ rules: list, warnings: [] });
  });

  it('writes a range query without its <, as the parser does', () => {
    const { rules } = rulesFrom(hover({ color: 'red' }, { at: ['@media (width < 600px)'] }));
    expect(rules[0].at).toEqual(['@media (600px > width)']);
  });

  it('converts kebab-case keys and fills, or repairs, an id', () => {
    const { rules, warnings } = rulesFrom(
      { selector: '&:hover', style: { 'background-color': 'red' } },
      { id: 'x', selector: '&:focus-visible', style: { color: 'red' } },
      { id: 'x', selector: '&:active', style: { color: 'blue' } },
      { id: '<bad id>', selector: '&::after', style: { content: "''" } },
    );
    expect(warnings).toEqual([]);
    expect(rules[0]).toEqual({ id: 'r1', selector: '&:hover', style: { backgroundColor: 'red' } });
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(4);
    expect(rules.every((rule) => /^[A-Za-z0-9_-]+$/.test(rule.id as string))).toBe(true);
  });

  it('keeps nothing but the known keys of a rule', () => {
    const { rules } = rulesFrom({ ...hover({ color: 'red' }), extra: 'x', onClick: 'alert(1)' });
    expect(Object.keys(rules[0])).toEqual(['id', 'selector', 'style']);
  });

  it('leaves no empty list behind, and reads text as the legacy attribute it is', () => {
    const { nodes, warnings } = run([
      { type: 'div', props: { rules: [] } },
      { type: 'table', props: { rules: 'all' } },
    ]);
    expect('rules' in nodes[0].props).toBe(false);
    expect('rules' in nodes[1].props).toBe(false);
    expect(warnings).toEqual(['nodes[1]: prop "rules" is not allowed on <table>, dropped']);
  });

  it('warns about anything that is neither a list nor the attribute', () => {
    const { nodes, warnings } = run([{ type: 'div', props: { rules: { selector: '&:hover' } } }]);
    expect('rules' in nodes[0].props).toBe(false);
    expect(warnings.join(' ')).toContain('props.rules must be a list');
  });

  it('never stores a rule on a text node', () => {
    const { nodes, warnings } = run([
      { type: 'p', children: [{ type: '#text', props: { children: 'a', rules: [hover({ color: 'red' })] } }] },
    ]);
    expect(nodes[0].children[0].props).toEqual({ children: 'a' });
    expect(warnings.join(' ')).toContain('prop "rules" is not allowed on a #text node');
  });

  it('passes the editor model and reaches the page sheet', () => {
    const { nodes } = run([{ type: 'a', props: { href: '#x', children: 'Go', rules: [hover({ color: 'rgb(1, 2, 3)' })] } }]);
    expect(() => ComponentModel.create(nodes[0])).not.toThrow();
    expect(sheetOf(nodes)).toContain('color:rgb(1, 2, 3)');
  });

  it('carries a responsive map through to real breakpoint ids', () => {
    const { nodes, warnings } = run([
      { type: 'a', props: { rules: [hover({ color: { base: 'red', MOBILE: 'blue', nowhere: 'green' } })] } },
    ]);
    expect(warnings.join(' ')).toContain('unknown breakpoint key "nowhere"');
    expect((nodes[0].props.rules as { style: unknown }[])[0].style).toEqual({ color: { base: 'red', mobile: 'blue' } });
    const keyMap = breakpointKeyMap(inputs.map((input, index) => ({ ...input, id: `bp-${index}` })));
    const snapshot = toEditorSnapshot(nodes[0], keyMap);
    expect((snapshot.props as { rules: { style: unknown }[] }).rules[0].style).toEqual({ color: { base: 'red', 'bp-1': 'blue' } });
  });

  it('runs to the same result a second time', () => {
    const list = [hover({ color: 'red', animation: 'u-rise 1s' })];
    const first = rulesFrom(...list);
    expect(rulesFrom(...first.rules).rules).toEqual(first.rules);
  });
});

describe('generated rules: the cap', () => {
  it(`stores ${MAX_GENERATED_RULES} rules across a generation and says what it dropped`, () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, selector: '&:hover', style: { color: 'red' } }));
    const { nodes, warnings } = run([
      { type: 'section', props: { rules: many(20) }, children: [{ type: 'a', props: { rules: many(10) } }] },
      { type: 'a', props: { rules: many(1) } },
    ]);
    expect(nodes[0].props.rules).toHaveLength(20);
    expect(nodes[0].children[0].props.rules).toHaveLength(MAX_GENERATED_RULES - 20);
    expect('rules' in nodes[1].props).toBe(false);
    expect(warnings.filter((warning) => warning.includes(`more than ${MAX_GENERATED_RULES} rules`))).toHaveLength(2);
    expect(warnings.join(' ')).toContain('6 dropped');
  });

  it('counts a rule split at the gate as the two it stores', () => {
    const fill = Array.from({ length: MAX_GENERATED_RULES - 1 }, (_, i) => ({ id: `r${i}`, selector: '&:hover', style: { color: 'red' } }));
    const { rules, warnings } = rulesFrom(...fill, hover({ color: 'red', animationName: 'u-rise' }));
    expect(rules).toHaveLength(MAX_GENERATED_RULES - 1);
    expect(warnings.join(' ')).toContain('rule dropped');
  });

  it('does not count a refused rule', () => {
    const list = [hover({ color: 'url(https://evil.example/x)' }), ...Array.from({ length: MAX_GENERATED_RULES }, (_, i) => ({ id: `r${i}`, selector: '&:hover', style: { color: 'red' } }))];
    expect(rulesFrom(...list).rules).toHaveLength(MAX_GENERATED_RULES);
  });
});

describe('generated rules: external addresses stay refused', () => {
  it.each([
    ['backgroundImage', 'url(https://evil.example/x.png)'],
    ['backgroundImage', 'url(//evil.example/x.png)'],
    ['background', 'no-repeat url("https://evil.example/x.png")'],
    ['backgroundImage', 'image-set("https://evil.example/x.png" 1x)'],
    ['backgroundImage', 'cross-fade(url(https://evil.example/x.png), red)'],
    ['listStyleImage', 'url(https://evil.example/x.png)'],
    ['maskImage', 'url(https://evil.example/x.svg)'],
    ['cursor', 'url(https://evil.example/x.cur), auto'],
    ['borderImage', 'url(https://evil.example/x.png) 1'],
    ['content', 'url(https://evil.example/x.png)'],
    ['filter', 'url(https://evil.example/f.svg#x)'],
    ['backgroundImage', 'src("https://evil.example/x.png")'],
    ['backgroundImage', 'url(data:image/svg+xml,<svg></svg>)'],
    ['backgroundImage', 'url(https://images.unsplash.com/photo-1)'],
    ['--tracker', '"https://evil.example/x.png"'],
    ['--tracker', 'url(https://evil.example/x.png)'],
    // The parser holds a rule to no url() but a site path, which leaves an id's scope out of it.
    ['clipPath', 'url(#cut)'],
  ])('%s: %s', (property, value) => {
    refused(hover({ [property]: value }));
    refused(hover({ [property]: { base: 'none', mobile: value } }));
  });

  it('refuses one in a definition', () => {
    refused({ id: 'a', define: '@font-face', style: { fontFamily: 'u-x', src: 'url(https://evil.example/x.woff2)' } });
    refused({ id: 'a', define: '@font-face', style: { fontFamily: 'u-x', src: 'url(data:font/woff2;base64,AAAA)' } });
    refused({ id: 'a', define: '@font-face', style: { fontFamily: 'u-x', src: 'local(Arial)' } });
    refused({ id: 'a', define: '@keyframes u-x', blocks: [{ selector: 'to', style: { backgroundImage: 'url(https://evil.example/x.png)' } }] });
    refused({ id: 'a', define: '@property --u-x', style: { syntax: '"*"', inherits: 'false', initialValue: '"https://evil.example/x.png"' } });
  });

  it('refuses a whole rule for it, and nothing of the rule reaches the sheet', () => {
    const { nodes, warnings } = run([
      { type: 'a', props: { rules: [hover({ color: 'rgb(7, 7, 7)', backgroundImage: 'url(https://evil.example/x.png)' })] } },
    ]);
    expect(warnings.join(' ')).toContain('rule dropped');
    expect('rules' in nodes[0].props).toBe(false);
    const sheet = sheetOf(nodes);
    expect(sheet).not.toContain('evil.example');
    expect(sheet).not.toContain('rgb(7, 7, 7)');
  });
});

describe('generated rules: hostile text', () => {
  it.each([
    ['a selector that does not start with &', ':hover'],
    ['a selector leaving the node', 'body'],
    ['a sibling of the node', '& + div'],
    ['a second selector', '&:hover, body'],
    ['a closing brace', '&:hover{}body{color:red}'],
    ['the end of the style element', '&</style><script>alert(1)</script>'],
    ['a backslash', '&\\:hover'],
    ['a comment', '&/* x */:hover'],
    ['url() in a selector', '&:is(url(https://evil.example/x))'],
    ['a keystroke reader', '&:has(input[value^="a"])'],
    ['the same in another spelling', '&:has(input[VaLuE*=a])'],
    ['a renderer class', '& .fc-a1'],
    ['a renderer class by attribute', '&[class^="fc-"]'],
    ['an at sign', '&@media'],
    ['no selector at all', ''],
    ['not text', 42],
  ])('refuses %s', (_, selector) => {
    refused({ id: 'r', selector, style: { color: 'red' } });
  });

  it.each([
    ['an import', '@import url(https://evil.example/x.css)'],
    ['a layer', '@layer base'],
    ['a page rule', '@page'],
    ['a closing brace', '@media (hover:hover){}body{color:red}'],
    ['the end of the style element', '@media (min-width:0)</style>'],
    ['url() in a condition', '@supports (background: url(https://evil.example/x))'],
    ['no at-rule', 'hover'],
    ['not text', 42],
  ])('refuses a wrapper holding %s', (_, wrapper) => {
    refused(hover({ color: 'red' }, { at: [wrapper] }));
  });

  it('refuses more wrappers than one rule may hold, and a wrapper that is no list', () => {
    refused(hover({ color: 'red' }, { at: Array.from({ length: 9 }, () => '@media (hover:hover)') }));
    refused(hover({ color: 'red' }, { at: HOVER_GATE }));
  });

  it.each([
    ['a brace', 'red}body{color:blue'],
    ['a declaration', 'red;background:url(https://evil.example/x)'],
    ['a backslash', '\\75 rl(https://evil.example/x)'],
    ['a comment', 'red/* x */'],
    ['a control character', 'red\u0000'],
    ['script', 'javascript:alert(1)'],
    ['an expression', 'expression(alert(1))'],
    ['an import', '@import "https://evil.example/x.css"'],
    ['a behavior', 'behavior: url(x.htc)'],
    ['an object', { deep: { er: 'red' } }],
    ['an array', ['red']],
  ])('refuses a value holding %s', (_, color) => {
    refused(hover({ color }));
  });

  it('keeps the end of a style element out of the sheet', () => {
    const { nodes } = run([{ type: 'a', props: { rules: [{ id: 'r', selector: '&::after', style: { content: '"</style><script>alert(1)</script>"' } }] } }]);
    expect(sheetOf(nodes)).not.toMatch(/<\/style|<script/i);
  });

  it.each([
    ['a condition', { when: { state: 'open', is: true } }],
    ['a gate', { gate: 'off' }],
    ['a component state', { componentState: 'open' }],
  ])('refuses %s, which would be the permanent look without its reader', (_, extra) => {
    refused(hover({ color: 'red' }, extra));
  });

  it('refuses a rule that is both, or neither, a selector and a definition', () => {
    refused({ id: 'a', selector: '&', define: '@keyframes u-x', style: { color: 'red' } });
    refused({ id: 'a', style: { color: 'red' } });
    refused('&:hover { color: red }');
    refused(null);
  });

  it.each([
    ['an unprefixed name', { define: '@keyframes spin', blocks: [{ selector: 'to', style: { opacity: 1 } }] }],
    ['an editor name', { define: '@keyframes fc-fade', blocks: [{ selector: 'to', style: { opacity: 1 } }] }],
    ['a wrapper', { define: '@keyframes u-x', at: ['@media print'], blocks: [{ selector: 'to', style: { opacity: 1 } }] }],
    ['a selector for a keyframe', { define: '@keyframes u-x', blocks: [{ selector: 'body', style: { opacity: 1 } }] }],
    ['no blocks', { define: '@keyframes u-x', blocks: [] }],
    ['a responsive map', { define: '@keyframes u-x', blocks: [{ selector: 'to', style: { opacity: { base: 0 } } }] }],
    ['a page rule', { define: '@page', style: { margin: '0' } }],
    ['a condition', { define: '@keyframes u-x', when: { state: 'open', is: true }, blocks: [{ selector: 'to', style: { opacity: 1 } }] }],
    ['too many blocks', { define: '@keyframes u-x', blocks: Array.from({ length: 300 }, () => ({ selector: 'to', style: { opacity: 1 } })) }],
    ['a syntax of its own', { define: '@property --u-x', style: { syntax: '"<script>"', inherits: 'false' } }],
    ['an object as a descriptor', { define: '@font-face', style: { fontFamily: 'u-x', src: { base: 'url(/a.woff2)' } } }],
    ['an unknown at-rule', { define: '@evil u-x', style: { color: 'red' } }],
  ])('refuses a definition with %s', (_, rule) => {
    refused({ id: 'a', ...rule });
  });

  it('keeps fieldSizing out, and the reviewed vocabulary as it was', () => {
    refused(hover({ fieldSizing: 'content' }));
    refused(hover({ notACssProperty: 'red' }));
    refused(hover({ onClick: 'alert(1)' }));
  });

  it('clamps a z-index in a rule, and in a keyframe, under the banner', () => {
    const { rules } = rulesFrom(
      hover({ zIndex: 999999999 }),
      { id: 'a', define: '@keyframes u-x', blocks: [{ selector: 'to', style: { zIndex: '999999999' } }] },
    );
    expect((rules[0].style as { zIndex: unknown }).zIndex).toBeLessThan(999999999);
    const block = (rules[1].blocks as { style: { zIndex: string } }[])[0];
    expect(Number(block.style.zIndex)).toBeLessThan(999999999);
    refused({ id: 'a', define: '@keyframes u-x', blocks: [{ selector: 'to', style: { zIndex: 'var(--top)' } }] });
  });

  it('holds a rule to the font library, and to the tells the screen cannot see there', () => {
    const { rules, warnings } = rulesFrom(hover({ fontFamily: 'Inter, sans-serif' }));
    expect(warnings.join(' ')).not.toContain('rule dropped');
    expect(JSON.stringify(rules[0].style)).not.toContain('Inter');
    refused(hover({ backdropFilter: 'blur(12px)' }));
    refused(hover({ backgroundImage: 'radial-gradient(circle, #f0f, #00f)' }));
    refused(hover({ font: '16px Inter' }));
    refused({ id: 'a', selector: '&::after', style: { content: `"${LONG_DASH}"` } });
    refused({ id: 'a', selector: '&::after', style: { content: '"\u{1F680}"' } });
    refused({ id: 'a', define: '@counter-style u-x', style: { system: 'cyclic', symbols: `"${LONG_DASH}"` } });
  });

  it('leaves the document, the prototype and the generation alone on a poisoned rule', () => {
    const poisoned = JSON.parse('{"id":"r","selector":"&:hover","style":{"color":"red"},"__proto__":{"polluted":true}}');
    expect(rulesFrom(poisoned).rules[0]).toEqual({ id: 'r', selector: '&:hover', style: { color: 'red' } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('generated rules: motion', () => {
  const list = (value: unknown, key = 'animation') => hover({ [key]: value });

  it.each([
    ['u-x 1s infinite', 'animation'],
    ['u-x 1s INFINITE', 'animation'],
    ['infinite', 'animationIterationCount'],
    ['Infinite', 'animationIterationCount'],
    ['u-x 1s infinite', 'WebkitAnimation'],
    ['u-x 1s var(--n)', 'animation'],
    ['var(--n)', 'animationIterationCount'],
    ['calc(1e9)', 'animationIterationCount'],
    ['999999', 'animationIterationCount'],
    [1e9, 'animationIterationCount'],
    ['u-x 1s ease 0s 999999', 'animation'],
    ['1e9', 'animationIterationCount'],
    ['var(--name)', 'animationName'],
  ])('refuses %s in %s', (value, key) => {
    refused(list(value, key));
  });

  it('refuses it in a responsive map, and in the kebab spelling', () => {
    refused(list({ base: 'u-x 1s', mobile: 'u-x 1s infinite' }));
    refused(hover({ 'animation-iteration-count': 'infinite' }));
    refused(hover({ '-webkit-animation': 'u-x 1s infinite' }));
  });

  it('wraps an animation in the reduced-motion gate, outermost', () => {
    const { rules } = rulesFrom(hover({ animation: 'u-x 1s ease-in' }, { at: [HOVER_GATE] }));
    expect(rules).toEqual([{ id: 'r', selector: '&:hover', at: [REDUCED_MOTION_GATE, HOVER_GATE], style: { animation: 'u-x 1s ease-in' } }]);
    expect(readRules({ rules }).refused).toEqual([]);
  });

  it('wraps it once, and does not take a negated gate for it', () => {
    expect(rulesFrom(hover({ animationName: 'u-x' }, { at: ['@media (prefers-reduced-motion:no-preference)'] })).rules[0].at).toHaveLength(1);
    expect(rulesFrom(hover({ animationName: 'u-x' }, { at: ['@media not (prefers-reduced-motion: no-preference)'] })).rules[0].at).toHaveLength(2);
  });

  it('moves only the animation, so a visitor who asked for less motion keeps the rest of the state', () => {
    const { rules } = rulesFrom(hover({ color: 'red', animation: 'u-x 1s', animationDelay: '1s' }));
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ id: 'r', selector: '&:hover', style: { color: 'red' } });
    expect(rules[1]).toMatchObject({ selector: '&:hover', at: [REDUCED_MOTION_GATE], style: { animation: 'u-x 1s', animationDelay: '1s' } });
    expect(rules[1].id).not.toBe('r');
  });

  it('drops the rule when the gate is one wrapper too many', () => {
    refused(hover({ animation: 'u-x 1s' }, { at: Array.from({ length: 8 }, () => '@media (hover:hover)') }));
  });

  it('accepts a bounded run and the timing functions', () => {
    const { rules } = rulesFrom(
      list(`u-x 1s cubic-bezier(0.2, 0, 0, 1) ${MAX_GENERATED_ANIMATION_RUNS}`),
      { id: 'b', selector: '&:focus-visible', style: { animation: 'u-y 1s steps(4, end) 2' } },
    );
    expect(rules).toHaveLength(2);
    refused(list(`u-x 1s ${MAX_GENERATED_ANIMATION_RUNS + 1}`));
  });

  it('keeps a stored keyframes out of Normal, where no gate can hold it', () => {
    for (const [key, value] of [
      ['animation', 'u-x 1s'],
      ['animationName', 'u-x'],
      ['animationName', '"u-x"'],
      ['animation', 'u-x 1s infinite'],
      ['animationIterationCount', 'infinite'],
    ]) {
      const { nodes, warnings } = run([{ type: 'div', props: { style: { [key]: value } } }]);
      expect(nodes[0].props.style ?? {}).toEqual({});
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  it('leaves Normal its own values', () => {
    const style = { animation: 'initial', transition: 'color 200ms ease', animationDuration: '200ms' };
    const { nodes, warnings } = run([{ type: 'div', props: { style } }]);
    expect(nodes[0].props.style).toEqual(style);
    expect(warnings).toEqual([]);
  });
});
