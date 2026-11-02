// Typed or pasted CSS as rules: the panel's raw field and the import's one entry.
import { describe, expect, it } from 'vitest';
import { parseCssText, parseRule, ruleCssText, type SelectorRule, type StoredRule } from '../rules';
import { asNamedState, HOVER_GATE, ruleLabel } from '../states';

const one = (text: string) => {
  const { rules, refused } = parseCssText(text);
  expect(refused).toEqual([]);
  expect(rules).toHaveLength(1);
  return rules[0] as SelectorRule;
};

const reason = (text: string) => {
  const { rules, refused } = parseCssText(text);
  expect(rules).toEqual([]);
  expect(refused.length).toBeGreaterThan(0);
  return refused[0].reason;
};

describe('a selector', () => {
  it('puts a pseudo-class or pseudo-element on the node', () => {
    expect(one(':nth-child(2n)')).toEqual({ selector: '&:nth-child(2n)', style: {} });
    expect(one('::before')).toEqual({ selector: '&::before', style: {} });
  });

  it('puts anything else inside the node', () => {
    expect(one('h2')).toEqual({ selector: '& h2', style: {} });
    expect(one('> li')).toEqual({ selector: '& > li', style: {} });
    expect(one('.card')).toEqual({ selector: '& .card', style: {} });
    expect(one('ul li')).toEqual({ selector: '& ul li', style: {} });
  });

  it('keeps what already holds the node', () => {
    expect(one('&:hover')).toEqual({ selector: '&:hover', style: {} });
    expect(one('&')).toEqual({ selector: '&', style: {} });
    expect(one('&.probe')).toEqual({ selector: '&.probe', style: {} });
  });

  it('does each part of a list, and leaves commas inside brackets alone', () => {
    expect(one('h2, h3')).toEqual({ selector: '& h2, & h3', style: {} });
    expect(one(':is(h1, h2), :first-child')).toEqual({ selector: '&:is(h1, h2), &:first-child', style: {} });
  });

  it('gives the parser reason for what it refuses', () => {
    expect(reason('& + p')).toMatch(/.+/);
    expect(reason('&[value^="a"]')).toMatch(/value/);
    expect(reason('&:hover</style><script>')).toMatch(/.+/);
  });
});

describe('a whole rule', () => {
  it('reads declarations into style keys', () => {
    expect(one(':hover { color: red; background-color: #fff; --x: 1 }')).toEqual({
      selector: '&:hover',
      style: { color: 'red', backgroundColor: '#fff', '--x': '1' },
    });
  });

  it('keeps a semicolon or a brace inside a string or a bracket', () => {
    expect(one('::before { content: "a;b"; }').style).toEqual({ content: '"a;b"' });
    expect(one('&:not([data-x="a b"]) { color: red }').selector).toBe('&:not([data-x="a b"])');
  });

  it('drops comments, and leaves one inside a string for the parser to judge', () => {
    expect(one('/* lead */ ::after { /* why */ content: "x"; }')).toEqual({ selector: '&::after', style: { content: '"x"' } });
    expect(reason('::after { content: "/* keep */"; }')).toMatch(/.+/);
  });

  it('reads several rules', () => {
    const { rules } = parseCssText(':first-child { color: red } :last-child { color: blue }');
    expect(rules.map((rule) => ('selector' in rule ? rule.selector : ''))).toEqual(['&:first-child', '&:last-child']);
  });

  it('refuses what is left open, or not a declaration', () => {
    expect(reason(':hover { color: red')).toContain('left open');
    expect(reason(':hover { color: red }}')).toContain('closing brace');
    expect(reason('&:not([data-x="{"])')).toMatch(/.+/);
    expect(reason('::before { content: "x }')).toContain('left open');
    expect(reason(':hover { nonsense }')).toContain('not a declaration');
    expect(reason(':hover { color: }')).toContain('no value');
    expect(reason(':hover { h2 { color: red } }')).toContain('among declarations');
  });

  it('takes a refused value out with its reason', () => {
    expect(reason(':hover { background-image: url(https://example.test/x.jpg) }')).toContain('external address');
    expect(reason(':hover { field-sizing: content }')).toContain('fieldSizing');
  });

  it('keeps what parses beside what does not', () => {
    const { rules, refused } = parseCssText(':first-child { color: red } & + p { color: blue }');
    expect(rules).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });
});

describe('a condition', () => {
  it('reads one with no body, applying to the node', () => {
    expect(one('@media print')).toEqual({ selector: '&', at: ['@media print'], style: {} });
    expect(one('@container (min-width: 400px)')).toEqual({ selector: '&', at: ['@container (min-width: 400px)'], style: {} });
  });

  it('reads declarations right inside it', () => {
    expect(one('@media print { color: red }')).toEqual({ selector: '&', at: ['@media print'], style: { color: 'red' } });
  });

  it('reads rules inside it, outermost first', () => {
    expect(one('@supports (display: grid) { @media print { :first-child { color: red } } }')).toEqual({
      selector: '&:first-child',
      at: ['@supports (display: grid)', '@media print'],
      style: { color: 'red' },
    });
  });

  it('keeps what was typed in a range comparison', () => {
    expect(one('@media (width < 600px) { color: red }').at).toEqual(['@media (width < 600px)']);
  });

  it('refuses what cannot be stored on a node', () => {
    expect(reason('@layer base { color: red }')).toMatch(/.+/);
    expect(reason('@import "x.css"')).toMatch(/.+/);
    expect(reason('@page { margin: 0 }')).toMatch(/.+/);
    expect(reason('@media print { @keyframes u-x { from { opacity: 0 } } }')).toContain('global');
  });
});

describe('a definition', () => {
  it('reads keyframes into blocks', () => {
    expect(one('@keyframes u-spin { from { opacity: 0 } 50% { opacity: .5; } to { opacity: 1 } }')).toEqual({
      define: '@keyframes u-spin',
      blocks: [
        { selector: 'from', style: { opacity: '0' } },
        { selector: '50%', style: { opacity: '.5' } },
        { selector: 'to', style: { opacity: '1' } },
      ],
    });
  });

  it('reads descriptors into a style', () => {
    expect(one('@font-face { font-family: u-brand; src: url(/brand.woff2) }')).toEqual({
      define: '@font-face',
      style: { fontFamily: 'u-brand', src: 'url(/brand.woff2)' },
    });
  });

  it('reads feature blocks', () => {
    expect(one('@font-feature-values u-brand { @styleset { nice: 1 } }')).toEqual({
      define: '@font-feature-values u-brand',
      blocks: [{ selector: '@styleset', style: { nice: '1' } }],
    });
  });

  it('refuses a name outside the reserved prefix, and an external font', () => {
    expect(reason('@keyframes spin { from { opacity: 0 } }')).toMatch(/.+/);
    expect(reason('@font-face { font-family: u-brand; src: url(https://example.test/x.woff2) }')).toMatch(/.+/);
    expect(reason('@keyframes u-x')).toContain('needs a body');
  });
});

describe('text for a stored rule', () => {
  it.each<StoredRule>([
    { id: 'a', define: '@keyframes u-spin', blocks: [{ selector: 'from', style: { opacity: '0' } }] },
    { id: 'b', define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/brand.woff2)' } },
    { id: 'c', selector: '&:first-child', style: { color: 'red' } },
    { id: 'd', selector: '&:first-child', at: ['@supports (display: grid)', '@media print'], style: { color: 'red' } },
  ])('reads back as the same rule: $id', (rule) => {
    const { id, ...draft } = rule;
    expect(id).toBeTruthy();
    expect(one(ruleCssText(rule))).toEqual(draft);
    expect(parseRule(rule).ok).toBe(true);
  });

  it('shows the base of a breakpoint map', () => {
    expect(ruleCssText({ id: 'a', selector: '&', style: { color: { base: 'red', tablet: 'blue' } } })).toContain('color: red');
  });
});

describe('the name of a rule, and what typing a state means', () => {
  it('asks for the state behind its gate', () => {
    expect(asNamedState({ selector: '&:hover', style: {} })).toEqual({ selector: '&:hover', at: [HOVER_GATE], style: {} });
  });

  it('leaves Pressed, a condition and a definition as they are', () => {
    expect(asNamedState({ selector: '&:active', style: {} })).toEqual({ selector: '&:active', style: {} });
    expect(asNamedState({ selector: '&:hover', at: ['@media print'], style: {} })).toMatchObject({ at: ['@media print'] });
    expect(asNamedState({ define: '@keyframes u-x', blocks: [] })).toEqual({ define: '@keyframes u-x', blocks: [] });
  });

  it('names a rule by its state, selector or condition', () => {
    expect(ruleLabel({ id: 'a', selector: '&:hover', at: [HOVER_GATE], style: {} })).toBe('Hover');
    expect(ruleLabel({ id: 'a', selector: '&:first-child', style: {} })).toBe('&:first-child');
    expect(ruleLabel({ id: 'a', selector: '&', at: ['@media print'], style: {} })).toBe('@media print');
    expect(ruleLabel({ id: 'a', selector: '& h2', at: ['@media print'], style: {} })).toBe('@media print & h2');
    expect(ruleLabel({ id: 'a', define: '@keyframes u-x', blocks: [] })).toBe('@keyframes u-x');
  });
});
