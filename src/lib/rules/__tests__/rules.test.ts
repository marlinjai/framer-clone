import { describe, expect, it } from 'vitest';
import type { StateValue } from '@/lib/behaviour/format';
import {
  MAX_RULES_PER_NODE,
  PROPERTY_SYNTAXES,
  hasExternalAddress,
  parseRule,
  parseSelector,
  parseWrapper,
  readRules,
  storedRulesOf,
  type StoredRule,
} from '@/lib/rules/rules';
import samples from '../../../../test/score/data/samples.json';
import { atRuleProbe, selectorProbe, wrapperProbe } from '../../../../test/score/lib/encodings';

const selectorRefused = (text: unknown): string | undefined => {
  const parsed = parseSelector(text);
  return parsed.ok ? undefined : parsed.reason;
};

/** A rule whose only suspect part is one declaration. */
const withValue = (value: unknown, key = 'backgroundImage') => parseRule({ id: 'r1', selector: '&:hover', style: { [key]: value } });

const definition = (define: string, body: Record<string, unknown>) => parseRule({ id: 'r1', define, ...body });

describe('every sample of the score parses', () => {
  const selectorIds = Object.keys(samples.selectors);
  const pageLevel = new Set(samples.pageLevelRows);

  it.each(selectorIds.filter((id) => !pageLevel.has(id)))('selector %s', (id) => {
    const { rule } = selectorProbe(id, (samples.selectors as Record<string, string>)[id]);
    expect(parseRule(rule)).toMatchObject({ ok: true });
  });

  it.each(samples.webkitOnlySelectors)('WebKit-only selector %s', (id) => {
    expect(parseRule(selectorProbe(id, id).rule)).toMatchObject({ ok: true });
  });

  it.each(Object.keys(samples.atRules).filter((id) => !pageLevel.has(id) && id !== '@document'))('at-rule %s', (id) => {
    const { rule } = atRuleProbe(id, (samples.atRules as Record<string, string>)[id]);
    expect(parseRule(rule)).toMatchObject({ ok: true });
  });

  it.each(Object.entries(samples.mediaFeatures))('media feature %s', (_, query) => {
    expect(parseRule(wrapperProbe(`@media ${query}`).rule)).toMatchObject({ ok: true });
  });

  it('keeps the wrapper a row needs to mean anything', () => {
    expect(parseRule(selectorProbe(':scope', ':scope').rule)).toMatchObject({ ok: true, value: { at: ['@scope (.probe)'] } });
  });
});

describe('parseSelector: what it accepts', () => {
  it.each([
    '&',
    '&:hover',
    '&::before',
    '& > li',
    '&>li',
    '& li',
    '&.probe',
    '&#probe',
    '&[data-probe]',
    '&[data-state="open"]',
    "&[data-state='open' i]",
    '&[lang|=en]',
    '&[value]',
    '&[*|value]',
    '& input[value]',
    '&[data-value^="a"]',
    '&:is(.group:hover *)',
    '&:is(.dark *)',
    '&:is(html:has(select option:nth-child(3):checked) *)',
    '&:has(input:checked)',
    '&:not(p)',
    '&:nth-child(2n+1)',
    '&:nth-child(2n + 1)',
    '&::picker(select)',
    '& h2 + p',
    '& h2 ~ p',
    '& > * + *',
    '& > li + li',
    '& col || td',
    '&:is(h1, h2)',
    '&[class*="c-a1"]',
    '&:hover, &:focus',
    '& a, & b, & c',
  ])('accepts %s', (text) => {
    expect(selectorRefused(text)).toBeUndefined();
  });

  it('splits a list on its top-level commas only', () => {
    expect(parseSelector('&:is(h1, h2), & [data-x="a,b"]')).toEqual({ ok: true, value: ['&:is(h1, h2)', '& [data-x="a,b"]'] });
  });

  it('accepts a part of exactly the maximum length', () => {
    expect(selectorRefused(`&.${'a'.repeat(254)}`)).toBeUndefined();
  });

  it('accepts nesting of exactly eight levels', () => {
    expect(selectorRefused(`&${':is('.repeat(8)}p${')'.repeat(8)}`)).toBeUndefined();
  });
});

describe('parseSelector: its refusals', () => {
  it.each([
    ['closing the style element', '&</style><script>alert(1)</script>'],
    ['a < anywhere', '&[data-x="<"]'],
    ['a {', '&{color:red}'],
    ['a }', '&}body{color:red'],
    ['a ;', '&;color:red'],
    ['an @', '&@media'],
    ['an @ in a string', '&[data-x="@"]'],
    ['a backslash', '&\\3a hover'],
    ['a backslash hiding a quote', '&[data-x="\\"]'],
    ['a comment', '&/* x */:hover'],
    ['a comment in a string', '&[data-x="/*"]'],
    ['NUL', '&\u0000:hover'],
    ['a newline', '&\n:hover'],
    ['a tab', '&\t:hover'],
    ['a carriage return', '&\r:hover'],
    ['a form feed', '&\f:hover'],
    ['DEL', '&\u007f:hover'],
    ['url(', '&:is(url(x))'],
    ['URL( in another case', '&[data-x="URL(x)"]'],
  ])('refuses %s', (_, text) => {
    expect(selectorRefused(text)).toBeDefined();
  });

  it.each([
    ['nothing', ''],
    ['a number', 7],
    ['null', null],
    ['an object', { selector: '&' }],
    ['no &', ':hover'],
    ['a leading space', ' &:hover'],
    ['a bare tag', 'body'],
    ['a global list', '&, body'],
    ['a trailing comma', '&:hover,'],
    ['an empty part', '&, , &:hover'],
    ['a name stuck to &', '&div'],
    ['a dash stuck to &', '&-b'],
    ['a star stuck to &', '&*'],
    ['a digit stuck to &', '&1'],
    ['a parenthesis stuck to &', '&(a)'],
    ['a quote stuck to &', '&"a"'],
    ['a single pipe stuck to &', '&|a'],
    ['a second &', '&:is(&)'],
    ['a second & at the end', '& &'],
    ['& in a string', '&[data-x="a&b"]'],
  ])('refuses %s', (_, text) => {
    expect(selectorRefused(text)).toBeDefined();
  });

  it.each([
    ['next sibling', '& + p'],
    ['next sibling, no spaces', '&+p'],
    ['subsequent sibling', '& ~ p'],
    ['subsequent sibling, no spaces', '&~p'],
    ['after a pseudo-class', '&:hover ~ p'],
    ['after a pseudo-class, no spaces', '&:hover+p'],
    ['after a pseudo-element', '&::before + p'],
    ['after a function holding a comma', '&:is(a, b) + p'],
    ['after an attribute holding a plus', '&[data-x="+"] + p'],
    ['column combinator', '& || td'],
    ['column combinator, no spaces', '&||td'],
    ['after a class with a stray pipe', '&.a|b ~ c'],
    ['in the second part of a list', '&:hover, & ~ p'],
  ])('refuses leaving the node: %s', (_, text) => {
    expect(selectorRefused(text)).toMatch(/sibling|followed/);
  });

  it('refuses a part one character too long, in any part of a list', () => {
    expect(selectorRefused(`&.${'a'.repeat(255)}`)).toMatch(/longer/);
    expect(selectorRefused(`&, &.${'a'.repeat(255)}`)).toMatch(/longer/);
  });

  it('refuses nesting of nine levels', () => {
    expect(selectorRefused(`&${':is('.repeat(9)}p${')'.repeat(9)}`)).toMatch(/nests/);
  });

  it.each([
    ['an open parenthesis', '&:is(a'],
    ['an open bracket', '&[data-x'],
    ['an open quote', '&[data-x="a]'],
    ['an open single quote', "&[data-x='a]"],
    ['a stray closer', '&)'],
    ['a stray bracket', '&]'],
    ['crossed brackets', '&:is([a)]'],
  ])('refuses %s', (_, text) => {
    expect(selectorRefused(text)).toBeDefined();
  });

  it.each([
    ['a class', '&.fc-a1'],
    ['a rule class', '&.fc_r-a1'],
    ['upper case', '&.FC-a1'],
    ['mixed case', '&.Fc_a1'],
    ['inside :is', '&:is(.fc-a1)'],
    ['inside :not', '&:not(.fc-a1)'],
    ['inside :has', '&:has(.fc_r-a1)'],
    ['a descendant', '& .fc-a1'],
    ['a class attribute', '&[class="fc-a1"]'],
    ['a prefix match', '&[class^="fc-"]'],
    ['a prefix match, single quotes', "&[class^='fc_']"],
    ['upper case attribute value', '&[class^="FC-"]'],
    ['an unquoted value', '&[class^=fc-]'],
    ['a leading space in the value', '&[class*=" fc-a1"]'],
    ['any attribute', '&[data-x="fc-a1"]'],
    ['a nested attribute', '&:has([class^="fc-"])'],
  ])('refuses a renderer name: %s', (_, text) => {
    expect(selectorRefused(text)).toMatch(/fc-/);
  });

  it('lets a class through that only starts alike, since the check is for stability', () => {
    expect(selectorRefused('&.fcx')).toBeUndefined();
    expect(selectorRefused('&.afc-b')).toBeUndefined();
  });

  it.each([
    ['the plain form', '&[value="abc"]'],
    ['a prefix match', '&[value^="a"]'],
    ['a suffix match', '&[value$="a"]'],
    ['a substring match', '&[value*="a"]'],
    ['a word match', '&[value~="a"]'],
    ['a dash match', '&[value|="a"]'],
    ['upper case', '&[VALUE^="a"]'],
    ['mixed case', '&[VaLuE^="a"]'],
    ['any namespace', '&[*|value^="a"]'],
    ['no namespace', '&[|value^="a"]'],
    ['a named namespace', '&[svg|value^="a"]'],
    ['a named namespace and a dash match', '&[svg|value|="a"]'],
    ['spaces everywhere', '&[ value ^= a ]'],
    ['no quotes', '&[value=abc]'],
    ['a case flag', '&[value="ABC" i]'],
    ['a sensitive flag', '&[value="ABC" s]'],
    ['single quotes', "&[value^='a']"],
    ['inside :has', '&:has(input[value^="a"])'],
    ['inside :is', '&:is([value="a"] *)'],
    ['inside :not', '&:not([value="a"])'],
    ['a descendant', '& input[value^="a"]'],
    ['deep inside', '&:has(:is(:not(input[value="a"])))'],
    ['the second part of a list', '&:hover, &[value="a"]'],
  ])('refuses reading what a visitor types: %s', (_, text) => {
    expect(selectorRefused(text)).toMatch(/value/);
  });

  it.each(['&[]', '&[=a]', '&["value"^=a]', '&[value ^ = a]', '&[a b]'])('refuses an attribute selector it cannot read: %s', (text) => {
    expect(selectorRefused(text)).toBeDefined();
  });
});

describe('parseWrapper', () => {
  it.each([
    '@media print',
    '@media (hover:hover) and (pointer:fine)',
    '@media(min-width:640px)',
    '@media (width >= 600px)',
    '@media (600px > width)',
    '@MEDIA print',
    '@supports (display: grid)',
    '@supports not (display: grid)',
    '@supports selector(:has(a))',
    '@container (min-width: 400px)',
    '@container sidebar (min-width: 400px)',
    '@scope (.probe)',
    '@scope (.a) to (.b)',
    '@scope to (.b)',
    '@scope',
    '@starting-style',
  ])('accepts %s', (text) => {
    expect(parseWrapper(text)).toMatchObject({ ok: true });
  });

  it.each([
    '@import url(x)',
    '@import "x"',
    '@namespace svg url(x)',
    '@charset "utf-8"',
    '@layer probe',
    '@LAYER probe',
    '@page',
    '@view-transition',
    '@keyframes u-x',
    '@font-face',
    '@-webkit-media print',
    '@nope',
    '@constructor',
    '@__proto__',
    'media print',
    '@',
    '',
  ])('refuses %s, which is not on the allow list', (text) => {
    expect(parseWrapper(text)).toMatchObject({ ok: false });
  });

  it.each([
    ['closing the element', '@media print</style>'],
    ['a brace', '@media print{body{color:red}}'],
    ['a ;', '@media print;'],
    ['a second at-keyword', '@media @import'],
    ['a backslash', '@media \\70rint'],
    ['a comment', '@media /* x */ print'],
    ['a control character', '@media\u0000print'],
    ['a newline in the prelude', '@media print\nand screen'],
    ['url(', '@supports (background: url(https://evil.test/x))'],
    ['URL(', '@supports (background: URL(/x))'],
    ['an open parenthesis', '@media (min-width: 1px'],
    ['a stray closer', '@media print)'],
    ['an &', '@supports selector(&)'],
    ['no condition on @media', '@media'],
    ['no condition on @supports', '@supports'],
    ['no condition on @container', '@container'],
    ['a condition on @starting-style', '@starting-style (x)'],
    ['a long prelude', `@media (${'a'.repeat(260)})`],
    ['a value selector in @scope', '@scope (input[value^="a"])'],
    ['a value selector in the @scope limit', '@scope (.a) to (input[value="a"])'],
    ['a renderer class in @scope', '@scope (.fc-a1)'],
    ['text after the @scope selectors', '@scope (.a) x'],
    ['text between the @scope selectors', '@scope (.a) (.b)'],
    ['an @scope limit that does not end it', '@scope to (.a) (.b)'],
  ])('refuses %s', (_, text) => {
    expect(parseWrapper(text)).toMatchObject({ ok: false });
  });

  it.each([1, null, {}, []])('refuses %j, which is not text', (value) => {
    expect(parseWrapper(value)).toMatchObject({ ok: false });
  });

  describe('a range comparison', () => {
    it.each([
      ['@media (width < 600px)', '@media (600px > width)'],
      ['@media (width <= 600px)', '@media (600px >= width)'],
      ['@media (width<600px)', '@media (600px > width)'],
      ['@media(width < 48rem)', '@media(48rem > width)'],
      ['@media (600px < width)', '@media (width > 600px)'],
      ['@media (400px <= width < 600px)', '@media (600px > width >= 400px)'],
      ['@media (400px < width <= 600px)', '@media (600px >= width > 400px)'],
      ['@media screen and (width < 600px)', '@media screen and (600px > width)'],
      ['@media not (width < 600px)', '@media not (600px > width)'],
      ['@media (width < 600px) and (height < 400px)', '@media (600px > width) and (400px > height)'],
      ['@media (width < 600px), print', '@media (600px > width), print'],
      ['@media ((width < 600px) or (height <= 400px))', '@media ((600px > width) or (400px >= height))'],
      ['@media (min-width: 100px) and (width < 600px)', '@media (min-width: 100px) and (600px > width)'],
      ['@media (width < calc(100px + 1em))', '@media (calc(100px + 1em) > width)'],
      ['@media (aspect-ratio < 16/9)', '@media (16/9 > aspect-ratio)'],
      ['@MEDIA (WIDTH < 600px)', '@MEDIA (600px > WIDTH)'],
      ['@container (width < 400px)', '@container (400px > width)'],
      ['@container sidebar (width < 400px)', '@container sidebar (400px > width)'],
      ['@container style(--u-size < 3)', '@container style(3 > --u-size)'],
    ])('rewrites %s without its <', (text, written) => {
      expect(parseWrapper(text)).toEqual({ ok: true, value: written });
    });

    it.each([
      '@media print',
      '@media(min-width:640px)',
      '@media  (width >= 600px)',
      '@media (width > 600px)',
      '@MEDIA print',
      '@container sidebar (min-width: 400px)',
    ])('leaves %s as stored, because it needs nothing rewritten', (text) => {
      expect(parseWrapper(text)).toEqual({ ok: true, value: text });
    });

    it('keeps the stored rule as it is and rewrites only what goes to the sheet', () => {
      const rule = { id: 'r', selector: '&', at: ['@media (width < 48rem)'], style: { color: 'red' } };
      expect(parseRule(rule)).toMatchObject({ ok: true, value: { at: ['@media (48rem > width)'] } });
      expect(rule.at).toEqual(['@media (width < 48rem)']);
    });

    it.each([
      ['@supports, which has no comparisons', '@supports (width < 600px)'],
      ['@scope, which has no comparisons', '@scope (a < b)'],
      ['outside a parenthesis', '@media print < screen'],
      ['only a term', '@media (< 600px)'],
      ['no term after it', '@media (width <)'],
      ['a space inside the operator', '@media (width < = 600px)'],
      ['a doubled operator', '@media (width << 600px)'],
      ['operators that do not point the same way', '@media (400px < width > 600px)'],
      ['one operator of each kind', '@media (400px > width < 600px)'],
      ['an = beside it', '@media (400px = width < 600px)'],
      ['a third comparison', '@media (1px < width < 2px < 3px)'],
      ['a name and a value', '@media (min-width: 1px < 2px)'],
      ['inside a math function', '@media (min-width: calc(1px < 2px))'],
      ['in a term', '@media (width < calc(1px < 2px))'],
      ['in an unknown function', '@media (width) and x(a < b)'],
      ['in a string', '@container style(--u-x: "a<b")'],
      ['closing the element from a term', '@media (width < 600px</style>)'],
      ['closing the element after a comparison', '@media (width < 600px)</style>'],
      ['closing the element in a condition', '@media (width < 1px) and (</style>)'],
      ['opening a script', '@media (a <script> b)'],
      ['a comment in a term', '@media (width < /* */ 600px)'],
      ['a brace in a term', '@media (width < 600px}) {'],
      ['a backslash in a term', '@media (width < \\36 00px)'],
      ['a non-ASCII term', '@media (width < \u0661px)'],
      ['an open parenthesis', '@media (width < 600px'],
      ['an open quote', '@media (width < "600px)'],
      ['url(', '@media (width < url(/x))'],
      ['an &', '@media (width < &)'],
    ])('refuses a < %s', (_, text) => {
      expect(parseWrapper(text)).toMatchObject({ ok: false });
    });

    it('never lets a < through, whatever the pieces', () => {
      const pieces = ['(', ')', '<', '<=', '>', '=', 'width', '600px', ' ', ' and ', 'not ', 'calc(', 'style(', '"', '</style>', ':', ',', '/', '*'];
      let state = 20261102;
      const next = (limit: number): number => {
        state = (Math.imul(state ^ (state >>> 15), 2654435761) + 0x6d2b79f5) | 0;
        return (state >>> 8) % limit;
      };
      let accepted = 0;
      for (let attempt = 0; attempt < 20000; attempt++) {
        let text = next(2) === 0 ? '@media ' : '@container ';
        for (let length = 1 + next(9); length > 0; length--) text += pieces[next(pieces.length)];
        const parsed = parseWrapper(text);
        if (!parsed.ok) continue;
        accepted++;
        expect(parsed.value).not.toContain('<');
      }
      expect(accepted).toBeGreaterThan(100);
    });
  });
});

describe('the address check', () => {
  it.each([
    ['an https address', 'url(https://evil.test/x)'],
    ['an http address', 'url(http://evil.test/x)'],
    ['upper case', 'URL(https://evil.test/x)'],
    ['mixed case with spaces and quotes', "Url( 'https://evil.test/x' )"],
    ['a quoted address', 'url("https://evil.test/x")'],
    ['protocol-relative', 'url(//evil.test/x)'],
    ['protocol-relative in quotes', 'url("//evil.test/x")'],
    ['a relative path', 'url(a.png)'],
    ['a dotted path', 'url(../a.png)'],
    ['nothing', 'url()'],
    ['an empty string', 'url("")'],
    ['a newline hiding two slashes', 'url("/\n/evil.test/x")'],
    ['a tab hiding two slashes', 'url("/\t/evil.test/x")'],
    ['a leading tab', 'url("\t//evil.test/x")'],
    ['a carriage return hiding two slashes', 'url("/\r/evil.test/x")'],
    ['a bare string in image-set', 'image-set("https://evil.test/x" 1x)'],
    ['url in image-set', 'image-set(url(https://evil.test/x) 1x)'],
    ['the second candidate of image-set', 'image-set("/a.png" 1x, "https://evil.test/x" 2x)'],
    ['upper case image-set', 'IMAGE-SET("https://evil.test/x" 1x)'],
    ['-webkit-image-set', '-webkit-image-set("https://evil.test/x" 1x)'],
    ['-webkit-image-set in upper case', '-WEBKIT-IMAGE-SET(url(https://evil.test/x) 1x)'],
    ['image()', 'image("https://evil.test/x")'],
    ['src()', 'src("https://evil.test/x")'],
    ['SRC()', 'SRC("https://evil.test/x")'],
    ['cross-fade', 'cross-fade(url(https://evil.test/x), url(/a.png), 50%)'],
    ['cross-fade with a bare string', 'cross-fade("https://evil.test/x", "/a.png", 50%)'],
    ['-webkit-cross-fade', '-webkit-cross-fade(url(/a.png), url(https://evil.test/x), 50%)'],
    ['a nested function', 'image-set(linear-gradient(red, blue) 1x, "https://evil.test/x" 2x)'],
    ['a list of backgrounds', 'url(/a.png), url(https://evil.test/x)'],
    ['a shorthand', 'no-repeat center url(https://evil.test/x)'],
    ['a var() fallback', 'var(--none, url(https://evil.test/x))'],
    ['a custom function', '--src("https://evil.test/x")'],
    ['a vendor name', '-moz-image-set("https://evil.test/x" 1x)'],
    ['a non-ASCII name', '\u00e9url(https://evil.test/x)'],
  ])('refuses %s', (_, value) => {
    expect(withValue(value)).toMatchObject({ ok: false });
  });

  it.each([
    ['var() in image-set', 'image-set(var(--x) 1x)'],
    ['var() in src()', 'src(var(--x))'],
    ['var() in image()', 'image(var(--x))'],
    ['var() in cross-fade', 'cross-fade(var(--x), url(/a.png), 50%)'],
    ['attr() in image-set', 'image-set(attr(data-x) 1x)'],
    ['env() in image-set', 'image-set(env(x) 1x)'],
    ['var() deep inside a gradient', 'image-set(linear-gradient(var(--x), red) 1x)'],
    ['a block holding var()', 'image-set((var(--x)) 1x)'],
  ])('refuses an address it cannot see: %s', (_, value) => {
    expect(withValue(value)).toMatchObject({ ok: false });
  });

  it.each([
    ['a site path', 'url(/a.png)'],
    ['a quoted site path', 'url("/a.png")'],
    ['a site path in upper case', 'URL(/a.png)'],
    ['spaces inside', 'url( /a.png )'],
    ['data:', 'url(data:image/png;base64,AAAA)'],
    ['quoted data:', 'url("data:image/png;base64,AAAA")'],
    ['DATA:', 'url("DATA:image/png;base64,AAAA")'],
    ['an SVG in data:', 'url("data:image/svg+xml,<svg xmlns=\'x\'/>")'],
    ['a site path in image-set', 'image-set("/a.png" 1x, url(/b.png) 2x)'],
    ['a type in image-set', 'image-set("/a.png" type("image/png"))'],
    ['a gradient in image-set', 'image-set(linear-gradient(red, blue) 1x)'],
    ['a site path in cross-fade', 'cross-fade(url(/a.png), url(/b.png), 50%)'],
    ['no address at all', 'linear-gradient(red, blue)'],
    ['var() outside a fetching function', 'var(--x)'],
  ])('accepts %s', (_, value) => {
    expect(withValue(value)).toMatchObject({ ok: true });
  });

  it('treats a plain string as text', () => {
    expect(withValue('"https://example.com"', 'content')).toMatchObject({ ok: true });
    expect(withValue('"url(https://example.com)"', 'content')).toMatchObject({ ok: true });
  });

  it('looks at every declaration, in every breakpoint of a map', () => {
    expect(withValue({ base: 'url(/a.png)', tablet: 'url(https://evil.test/x)' })).toMatchObject({ ok: false });
    expect(withValue({ base: 'url(https://evil.test/x)' })).toMatchObject({ ok: false });
    expect(parseRule({ id: 'r1', selector: '&', style: { color: 'red', '--x': 'url(https://evil.test/x)' } })).toMatchObject({ ok: false });
  });
});

describe('a rule value', () => {
  it.each(['url(/a<b.png)', 'url(/a</style>.png)', 'url(/a>b.png)', 'url(data:image/svg+xml,<svg>)'])(
    'refuses a < or > in the unquoted url %s, which the sheet would refuse',
    (value) => {
      expect(parseRule({ id: 'r', selector: '&', style: { backgroundImage: value } }).ok).toBe(false);
    },
  );

  it('still takes a < in a quoted url, which the emitter escapes', () => {
    expect(parseRule({ id: 'r', selector: '&', style: { backgroundImage: "url('/a<b.png')" } }).ok).toBe(true);
  });

  it.each([
    ['a binding', '{{row.colour}}'],
    ['a brace', 'red}body{color:red'],
    ['a backslash', 'r\\65 d'],
    ['an escaped url', '\\75rl(https://evil.test/x)'],
    ['a comment', 'ur/**/l(https://evil.test/x)'],
    ['a NUL', 'red\u0000'],
    ['a vertical tab', 'red\u000bblue'],
    ['a ; outside a string', 'red;background:blue'],
    ['< outside a string', 'calc(1px < 2px)'],
    ['> outside a string', 'a > b'],
    ['an open quote', '"abc'],
    ['an open parenthesis', 'calc(1px'],
    ['a stray closer', 'red)'],
    ['crossed brackets', '[a)]'],
    ['an open url', 'url(/a.png'],
    ['an unquoted url holding a quote', 'url(/a"b.png)'],
    ['an unquoted url holding a space', 'url(/a b.png)'],
    ['javascript:', 'url(javascript:alert(1))'],
    ['expression', 'expression(alert(1))'],
    ['an import', '"x" @import'],
    ['an array', ['red']],
    ['an object in a map', { base: { nested: 'red' } }],
    ['a list in a map', { base: ['red'] }],
  ])('refuses %s', (_, value) => {
    expect(withValue(value, 'color')).toMatchObject({ ok: false });
  });

  it.each([
    ['a number', 12],
    ['zero', 0],
    ['nothing', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['< in a string', '"<"'],
    ['; in a string', '"a;b"'],
    ['a tab between tokens', 'a\tb'],
    ['a newline between tokens', '"a"\n"b"'],
    ['a stored !important', 'red !important'],
    ['a calc', 'calc(100% - 2px)'],
    ['a grid line name', '[full-start] 1fr [full-end]'],
  ])('accepts %s', (_, value) => {
    expect(withValue(value, 'color')).toMatchObject({ ok: true });
  });

  it.each([
    ['a property closing the rule', 'color}body{x'],
    ['a kebab name', 'font-size'],
    ['an empty name', ''],
    ['a name with a space', 'font size'],
    ['__proto__', '__proto__'],
  ])('refuses %s as a key', (_, key) => {
    const style = JSON.parse(JSON.stringify({ placeholder: 'red' }).replace('placeholder', key)) as Record<string, unknown>;
    expect(parseRule({ id: 'r1', selector: '&', style })).toMatchObject({ ok: false });
  });

  it('keeps a responsive map whole, because a rule is an ordinary style', () => {
    const style = { color: { base: '#00f', tablet: '#0a0' } };
    expect(parseRule({ id: 'r1', selector: '&:hover', at: ['@media (hover:hover) and (pointer:fine)'], style })).toEqual({
      ok: true,
      value: { kind: 'selector', id: 'r1', parts: ['&:hover'], at: ['@media (hover:hover) and (pointer:fine)'], style },
    });
  });
});

describe('definitions', () => {
  const keyframes = { blocks: [{ selector: 'from', style: { opacity: 0 } }, { selector: '50%, 75.5%', style: { opacity: 0.5 } }, { selector: 'to', style: { opacity: 1 } }] };
  const fontFace = { style: { fontFamily: 'u-probe', src: 'url(/a.woff2) format("woff2"), url(data:font/woff2;base64,AAAA)', fontWeight: 700 } };

  it('accepts each kind with a real body', () => {
    expect(definition('@keyframes u-spin', keyframes)).toMatchObject({ ok: true, value: { kind: 'definition', atRule: 'keyframes', name: 'u-spin' } });
    expect(definition('@font-face', fontFace)).toMatchObject({ ok: true, value: { atRule: 'font-face' } });
    expect(definition('@font-face', { style: { fontFamily: '"u-probe"', src: 'url(data:font/woff2;base64,AAAA)' } })).toMatchObject({ ok: true });
    expect(definition('@font-feature-values u-probe', { blocks: [{ selector: '@styleset', style: { nice: '1' } }] })).toMatchObject({ ok: true });
    expect(definition('@font-palette-values --u-probe', { style: { fontFamily: 'u-probe' } })).toMatchObject({ ok: true });
    expect(definition('@counter-style u-probe', { style: { system: 'cyclic', symbols: '"*"' } })).toMatchObject({ ok: true });
    expect(definition('@property --u-probe', { style: { syntax: '"<color>"', inherits: 'false', initialValue: 'red' } })).toMatchObject({ ok: true });
    expect(definition('@position-try --u-probe', { style: { top: 'anchor(bottom)' } })).toMatchObject({ ok: true });
  });

  it.each(['@import url(x)', '@namespace svg url(x)', '@charset "utf-8"', '@layer probe', '@page', '@view-transition', '@media print', '@nope', 'keyframes u-x', '@constructor', ''])(
    'refuses %s, which is not on the allow list',
    (define) => {
      expect(definition(define, { style: { color: 'red' } })).toMatchObject({ ok: false });
    },
  );

  it.each([
    ['@keyframes spin'],
    ['@keyframes'],
    ['@keyframes U-spin'],
    ['@keyframes u-'],
    ['@keyframes "u-spin"'],
    ['@keyframes u-spin extra'],
    ['@keyframes --u-spin'],
    ['@keyframes u-spin{from{opacity:0}}'],
    ['@keyframes u_spin'],
  ])('refuses the name in %s', (define) => {
    expect(definition(define, keyframes)).toMatchObject({ ok: false });
  });

  it.each([
    ['@counter-style probe', { style: { system: 'cyclic' } }],
    ['@font-feature-values Probe', { blocks: [{ selector: '@styleset', style: { a: '1' } }] }],
    ['@font-palette-values --probe', { style: { fontFamily: 'u-x' } }],
    ['@font-palette-values u-probe', { style: { fontFamily: 'u-x' } }],
    ['@property --probe', { style: { syntax: '"<color>"' } }],
    ['@property --fc-x', { style: { syntax: '"<color>"' } }],
    ['@position-try --probe', { style: { top: '0' } }],
    ['@font-face u-x', { style: { fontFamily: 'u-x' } }],
  ])('refuses the name in %s', (define, body) => {
    expect(definition(define, body)).toMatchObject({ ok: false });
  });

  it('refuses a platform font family', () => {
    expect(definition('@font-face', { style: { fontFamily: 'Inter', src: 'url(/a.woff2)' } })).toMatchObject({ ok: false });
    expect(definition('@font-face', { style: { src: 'url(/a.woff2)' } })).toMatchObject({ ok: false });
  });

  it('runs the address check on every descriptor and block', () => {
    expect(definition('@font-face', { style: { fontFamily: 'u-x', src: 'url(https://fonts.example/a.woff2)' } })).toMatchObject({ ok: false });
    expect(definition('@font-face', { style: { fontFamily: 'u-x', src: 'local("A"), url(//fonts.example/a.woff2)' } })).toMatchObject({ ok: false });
    expect(definition('@keyframes u-x', { blocks: [{ selector: 'from', style: { backgroundImage: 'url(https://evil.test/x)' } }] })).toMatchObject({ ok: false });
    expect(definition('@property --u-x', { style: { syntax: '"<color>"', initialValue: 'url(https://evil.test/x)' } })).toMatchObject({ ok: false });
    expect(definition('@counter-style u-x', { style: { system: 'cyclic', symbols: 'url(https://evil.test/x)' } })).toMatchObject({ ok: false });
  });

  it('takes the syntax of @property from a fixed list, never from stored text', () => {
    for (const syntax of PROPERTY_SYNTAXES) expect(definition('@property --u-x', { style: { syntax } })).toMatchObject({ ok: true });
    for (const syntax of ['"<nope>"', '<color>', '"<color>"</style>', '"<url>"', '"<image>"', 7, undefined]) {
      expect(definition('@property --u-x', { style: { syntax } })).toMatchObject({ ok: false });
    }
    expect(definition('@property --u-x', { style: { syntax: '"<color>"', inherits: 'maybe' } })).toMatchObject({ ok: false });
  });

  it('holds plain values only: a definition has no breakpoint axis and no wrapper', () => {
    expect(definition('@counter-style u-x', { style: { system: { base: 'cyclic', tablet: 'fixed' } } })).toMatchObject({ ok: false });
    expect(definition('@keyframes u-x', { blocks: [{ selector: 'from', style: { opacity: { base: 0 } } }] })).toMatchObject({ ok: false });
    expect(definition('@keyframes u-x', { at: ['@media print'], ...keyframes })).toMatchObject({ ok: false });
  });

  it.each([
    ['a tag in a keyframe', '@keyframes u-x', 'body'],
    ['a percentage over 100', '@keyframes u-x', '101%'],
    ['a list with a bad part', '@keyframes u-x', 'from, body'],
    ['a brace', '@keyframes u-x', 'from{}'],
    ['an unknown feature block', '@font-feature-values u-x', '@import'],
    ['a block that is no selector', '@keyframes u-x', 7],
  ])('refuses a block selector: %s', (_, define, selector) => {
    expect(definition(define, { blocks: [{ selector, style: { opacity: 0 } }] })).toMatchObject({ ok: false });
  });

  it('refuses a body of the wrong shape', () => {
    expect(definition('@keyframes u-x', { style: { opacity: 0 } })).toMatchObject({ ok: false });
    expect(definition('@keyframes u-x', {})).toMatchObject({ ok: false });
    expect(definition('@keyframes u-x', { blocks: [] })).toMatchObject({ ok: false });
    expect(definition('@keyframes u-x', { blocks: ['from'] })).toMatchObject({ ok: false });
    expect(definition('@font-face', {})).toMatchObject({ ok: false });
    expect(definition('@counter-style u-x', { blocks: [{ selector: 'from', style: {} }] })).toMatchObject({ ok: false });
  });
});

describe('parseRule', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', '&:hover'],
    ['a list', []],
    ['no id', { selector: '&', style: {} }],
    ['a numeric id', { id: 1, selector: '&', style: {} }],
    ['an empty id', { id: '', selector: '&', style: {} }],
    ['an id that could break out', { id: 'a"]{', selector: '&', style: {} }],
    ['a long id', { id: 'a'.repeat(65), selector: '&', style: {} }],
    ['neither a selector nor a definition', { id: 'r1', style: {} }],
    ['both a selector and a definition', { id: 'r1', selector: '&', define: '@font-face', style: { fontFamily: 'u-x' } }],
    ['no style', { id: 'r1', selector: '&' }],
    ['a string for a style', { id: 'r1', selector: '&', style: 'color:red' }],
    ['a list for a style', { id: 'r1', selector: '&', style: [] }],
    ['a string for at', { id: 'r1', selector: '&', at: '@media print', style: {} }],
    ['a bad wrapper among good ones', { id: 'r1', selector: '&', at: ['@media print', '@layer x'], style: {} }],
    ['too many wrappers', { id: 'r1', selector: '&', at: Array(9).fill('@media print'), style: {} }],
  ])('refuses %s', (_, rule) => {
    expect(parseRule(rule)).toMatchObject({ ok: false });
  });

  it('says why', () => {
    expect(parseRule({ id: 'r1', selector: '& + p', style: {} })).toEqual({
      ok: false,
      reason: 'a sibling of the node is outside the node, so a selector cannot step to one from it',
    });
  });

  it('allows exactly eight wrappers', () => {
    expect(parseRule({ id: 'r1', selector: '&', at: Array(8).fill('@media print'), style: {} })).toMatchObject({ ok: true });
  });
});

describe('readRules', () => {
  const good = (id: string): StoredRule => ({ id, selector: '&:hover', style: { color: 'red' } });

  it('reads only a list: a string stays the legacy table attribute', () => {
    expect(readRules({ rules: 'all' })).toEqual({ rules: [], refused: [] });
    expect(readRules({})).toEqual({ rules: [], refused: [] });
    expect(readRules(null)).toEqual({ rules: [], refused: [] });
    expect(storedRulesOf({ rules: 'all' })).toEqual([]);
    expect(storedRulesOf(undefined)).toEqual([]);
  });

  it('sets a refused rule aside with its reason and keeps the rest, in order', () => {
    const bad = { id: 'r2', selector: 'body', style: {} };
    const { rules, refused } = readRules({ rules: [good('r1'), bad, good('r3')] });
    expect(rules.map((rule) => rule.id)).toEqual(['r1', 'r3']);
    expect(refused).toEqual([{ index: 1, rule: bad, reason: 'every part of a selector starts with &' }]);
  });

  it('refuses a duplicate id, and whatever is not an object', () => {
    const { rules, refused } = readRules({ rules: [good('r1'), good('r1'), 'nope', null] });
    expect(rules).toHaveLength(1);
    expect(refused.map((entry) => entry.index)).toEqual([1, 2, 3]);
  });

  it('refuses rules past the cap of one node', () => {
    const list = Array.from({ length: MAX_RULES_PER_NODE + 2 }, (_, i) => good(`r${i}`));
    const { rules, refused } = readRules({ rules: list });
    expect(rules).toHaveLength(MAX_RULES_PER_NODE);
    expect(refused).toHaveLength(2);
    expect(refused[0].reason).toMatch(/at most 64/);
  });
});

describe('hasExternalAddress: a plain value that a rule could read through var()', () => {
  it.each([
    ['url()', 'url(https://evil.test/x)'],
    ['image-set with a bare string', 'image-set("https://evil.test/x" 1x)'],
    ['protocol-relative', 'url(//evil.test/x)'],
    ['a var() that fills an address in', 'image-set(var(--u) 1x)'],
    ['an escaped url(', '\\75rl(https://evil.test/x)'],
    ['an escaped image-set(', 'im\\61ge-set("https://evil.test/x" 1x)'],
    ['a comment that proves nothing', '/* x */url(https://evil.test/x)'],
    ['one left open, which the end of an inline style closes', 'url(https://evil.test/x'],
    ['image-set left open', 'image-set("https://evil.test/x"'],
  ])('flags %s', (_, value) => {
    expect(hasExternalAddress(value)).toBe(true);
  });

  it.each([
    ['a colour', '#111'],
    ['a number', 12],
    ['a site path', 'url(/a.png)'],
    ['data:', 'url("data:image/png;base64,AAAA")'],
    ['a plain string', '"https://example.com"'],
    ['nothing', undefined],
  ])('leaves %s alone', (_, value) => {
    expect(hasExternalAddress(value)).toBe(false);
  });
});

describe('a condition on a rule', () => {
  const states = new Map<string, StateValue>([
    ['s1', { id: 's1', name: 'Open', type: 'boolean', initial: false }],
    ['t', { id: 't', name: 'Typed', type: 'text', initial: '' }],
  ]);
  const rule = (extra: object) => ({ id: 'r', selector: '&', style: { color: 'red' }, ...extra });

  it('needs the state in reach, which only the behaviour pass has', () => {
    expect(parseRule(rule({ when: { state: 's1', eq: true } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no state/) });
    expect(parseRule(rule({ gate: 'off' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no state/) });
  });

  it('reads a condition to a selector', () => {
    expect(parseRule(rule({ when: { state: 's1', eq: true } }), { states })).toMatchObject({
      ok: true,
      value: { when: ':where([data-fcs-s1="true"] *, [data-fcs-s1="true"])' },
    });
  });

  it('refuses text state, so what a visitor types decides nothing', () => {
    expect(parseRule(rule({ when: { state: 't', eq: 'x' } }), { states }).ok).toBe(false);
  });

  it('refuses the row, which a shared class cannot read', () => {
    const numbered = new Map<string, StateValue>([['n', { id: 'n', name: 'N', type: 'number', initial: 0 }]]);
    expect(parseRule(rule({ when: { state: 'n', eq: { row: 'index' } } }), { states: numbered }).ok).toBe(false);
  });

  it('takes one gate value', () => {
    expect(parseRule(rule({ gate: 'off' }), { states })).toMatchObject({ ok: true, value: { gate: 'off' } });
    expect(parseRule(rule({ gate: 'on' }), { states }).ok).toBe(false);
  });

  it('holds none on a definition', () => {
    const definition = { id: 'd', define: '@keyframes u-a', blocks: [{ selector: 'from', style: { opacity: 0 } }] };
    expect(parseRule({ ...definition, when: { state: 's1', eq: true } }, { states }).ok).toBe(false);
    expect(parseRule({ ...definition, gate: 'off' }, { states }).ok).toBe(false);
  });

  it('refuses a component state that was never compiled, which would be the permanent look', () => {
    expect(parseRule(rule({ componentState: 'open' }), { states }).ok).toBe(false);
    expect(parseRule(rule({ componentState: 'open' })).ok).toBe(false);
  });
});
