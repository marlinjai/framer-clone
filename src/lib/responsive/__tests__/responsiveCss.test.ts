// The published page's responsive stylesheet (plan decision 5): base rule for
// the largest breakpoint, then one max-width query per smaller breakpoint with
// only its own overrides, in the cascade's direction.
import { describe, it, expect, vi } from 'vitest';
import {
  buildResponsiveCss,
  cssPropertyName,
  cssValueText,
  maxWidthBelow,
  type DroppedDeclaration,
} from '../responsiveCss';
import { resolveCascade, type BreakpointRef } from '../cascade';

const DESKTOP: BreakpointRef = { id: 'bp-desktop', minWidth: 1200 };
const TABLET: BreakpointRef = { id: 'bp-tablet', minWidth: 810 };
const PHONE: BreakpointRef = { id: 'bp-phone', minWidth: 390 };
// Deliberately not sorted: the generator orders them.
const BPS = [PHONE, DESKTOP, TABLET];

const css = (style: Record<string, unknown>, onDrop?: (d: DroppedDeclaration) => void) =>
  buildResponsiveCss([{ className: 'fc-a', style }], BPS, { onDrop });

describe('buildResponsiveCss', () => {
  it('writes a Desktop edit (base) as the unconditioned rule', () => {
    expect(css({ color: { base: 'red' } })).toBe('.fc-a.fc-a{color:red}');
  });

  it('puts a Tablet override in a max-width query just below Desktop', () => {
    expect(css({ fontSize: { base: '16px', 'bp-tablet': '20px' } })).toBe(
      '.fc-a.fc-a{font-size:16px}\n' +
        '@media (max-width:1199.98px){\n.fc-a.fc-a{font-size:20px}\n}',
    );
  });

  it('puts a Phone override in a narrower query after the Tablet one', () => {
    expect(
      css({ fontSize: { base: '16px', 'bp-tablet': '20px', 'bp-phone': '14px' } }),
    ).toBe(
      '.fc-a.fc-a{font-size:16px}\n' +
        '@media (max-width:1199.98px){\n.fc-a.fc-a{font-size:20px}\n}\n' +
        '@media (max-width:809.98px){\n.fc-a.fc-a{font-size:14px}\n}',
    );
  });

  it('emits no Phone query when Phone inherits from Tablet', () => {
    const out = css({ fontSize: { 'bp-tablet': '20px' } });
    expect(out).toBe('@media (max-width:1199.98px){\n.fc-a.fc-a{font-size:20px}\n}');
    // The cascade agrees: Phone resolves to the Tablet value, Desktop to nothing.
    expect(resolveCascade({ 'bp-tablet': '20px' }, 'bp-phone', BPS).value).toBe('20px');
    expect(resolveCascade({ 'bp-tablet': '20px' }, 'bp-desktop', BPS).value).toBeUndefined();
  });

  it('reproduces the probe: an empty base is unset, the Tablet value still applies', () => {
    const out = css({
      color: { base: 'black', 'bp-desktop': 'red' },
      fontSize: { base: '', 'bp-tablet': '20px' },
    });
    expect(out).toBe(
      '.fc-a.fc-a{color:red}\n' + '@media (max-width:1199.98px){\n.fc-a.fc-a{font-size:20px}\n}',
    );
  });

  it('treats a legacy value under the primary id as the Desktop value, over base', () => {
    expect(css({ color: { base: 'black', 'bp-desktop': 'red' } })).toBe('.fc-a.fc-a{color:red}');
  });

  it('keeps plain values as base declarations in stored order', () => {
    expect(
      css({ padding: '8px', paddingTop: { base: '4px', 'bp-phone': '0' }, margin: 0 }),
    ).toBe(
      '.fc-a.fc-a{padding:8px;padding-top:4px;margin:0}\n' +
        '@media (max-width:809.98px){\n.fc-a.fc-a{padding-top:0}\n}',
    );
  });

  it('drops a map whose only keys are unknown breakpoints (the editor shows nothing for it)', () => {
    expect(css({ color: { 'bp-deleted': 'red' }, opacity: 0.5 })).toBe('.fc-a.fc-a{opacity:0.5}');
  });

  it('serializes numbers like React: px, except unitless properties and zero', () => {
    expect(
      css({
        width: { base: 320 },
        lineHeight: { base: 1.5 },
        opacity: { base: 0.8 },
        zIndex: { base: 3 },
        flexGrow: { base: 1 },
        fontWeight: { base: 700 },
        top: { base: 0 },
        '--gap': { base: 4 },
      }),
    ).toBe(
      '.fc-a.fc-a{width:320px;line-height:1.5;opacity:0.8;z-index:3;flex-grow:1;font-weight:700;top:0;--gap:4}',
    );
  });

  it('converts camelCase to kebab-case, including vendor prefixes', () => {
    expect(cssPropertyName('backgroundColor')).toBe('background-color');
    expect(cssPropertyName('WebkitLineClamp')).toBe('-webkit-line-clamp');
    expect(cssPropertyName('msTransform')).toBe('-ms-transform');
    expect(cssPropertyName('--brand-color')).toBe('--brand-color');
    expect(cssValueText('width', Number.NaN)).toBeUndefined();
    expect(cssValueText('width', true)).toBeUndefined();
    expect(cssValueText('width', '  50%  ')).toBe('50%');
  });

  it('rejects values and property names that could break out of the rule, and reports each', () => {
    const onDrop = vi.fn();
    const out = css(
      {
        color: { base: 'red}body{display:none' },
        background: { base: 'red</style><script>alert(1)</script>' },
        width: { base: '10px;position:fixed' },
        backgroundImage: { base: 'url(javascript:alert(1))' },
        content: { base: '"\\7d"' },
        border: { base: '1px solid red /* x */' },
        'x}y': { base: 'red' },
        height: { base: '10px\n}' },
        margin: { base: '4px' },
      },
      onDrop,
    );
    expect(out).toBe('.fc-a.fc-a{margin:4px}');
    expect(out).not.toMatch(/<|script|\}body/);
    expect(onDrop).toHaveBeenCalledTimes(8);
    expect(onDrop).toHaveBeenCalledWith({ className: 'fc-a', property: 'x}y', reason: 'unsafe-property' });
  });

  describe('a `;` inside a value', () => {
    const value = (text: string) => {
      const onDrop = vi.fn();
      const out = css({ backgroundImage: { base: text }, margin: { base: '4px' } }, onDrop);
      return { out, onDrop };
    };

    it.each([
      ['a double-quoted data url', 'url("data:image/svg+xml;base64,PHN2Zz4=")'],
      ['a single-quoted data url', "url('data:image/svg+xml;base64,PHN2Zz4=')"],
      ['spaces around a quoted url', 'url( "data:image/png;base64,AAA=" )'],
      ['an unquoted data url', 'url(data:image/png;base64,AAA=)'],
      ['spaces around an unquoted url', 'url(  data:image/png;base64,AAA=  )'],
      ['an upper-case url', 'URL(data:image/png;base64,AAA=)'],
      ['a url among other layers', 'url("a;b.png"), linear-gradient(red, blue)'],
      ['a url inside another function', 'image-set(url("a;b.png") 1x, url(c;d.png) 2x)'],
      ['a quoted string', '"a;b"'],
      ['the other quote inside a string', `'say "a;b"'`],
      ['a string next to balanced blocks', '"a;b" calc(1px + (2px * 3)) [full-start]'],
    ])('keeps %s', (_label, text) => {
      const { out, onDrop } = value(text);
      expect(out).toBe(`.fc-a.fc-a{background-image:${text};margin:4px}`);
      expect(onDrop).not.toHaveBeenCalled();
    });

    it.each([
      ['a bare ;', '10px;position:fixed'],
      ['a trailing ;', 'red;'],
      ['a ; after a closed string', '"x";position:fixed'],
      ['a ; after a closed quoted url', 'url("x");position:fixed'],
      ['a ; after a closed unquoted url', 'url(x);position:fixed'],
      ['a ; inside another function', 'calc(1px;position:fixed)'],
      ['a ; inside a function merely named like url', 'not-url(a;b)'],
      ['a ; inside a function ending in url', 'myurl(a;b)'],
      ['a ; inside a non-ASCII function ending in url', 'éurl(a;b)'],
      ['a hash that only looks like a url', '#url([)'],
      ['an at-keyword that only looks like a url', '@url([)'],
      ['a hash with a ; that only looks like a url', '#url(a;[)'],
      ['a dimension that only looks like a url', '1url([)'],
      ['a url whose start browsers read differently', '×url(a")"b)'],
      ['a string that never closes', '"abc;position:fixed'],
      ['a string closed by the wrong quote', `"abc;position:fixed'`],
      ['a url that never closes', 'url(data:x;y'],
      ['a quoted url that never closes', 'url("data:x;y"'],
      ['a function that never closes', 'calc(1px'],
      ['a bracket that never closes', '[full-start'],
      ['a stray closing paren', 'red)'],
      ['crossed brackets', 'calc(1px [2px)]'],
      ['a quote inside an unquoted url', 'url(data:x;"y")'],
      ['a paren inside an unquoted url', 'url(data:x;(y)'],
      ['a space inside an unquoted url', 'url(data:x;y z)'],
      ['a closing brace in a string', '"x}body{display:none"'],
      ['a closing brace in a url', 'url(x;}body{display:none)'],
      ['a backslash that hides a closing quote', '"a\\";position:fixed;content:"b"'],
      ['an escape inside a string', '"\\22;x"'],
      ['an escape inside a url', 'url(a\\29;position:fixed)'],
      ['the end of the style element in a string', '"a;</style><script>alert(1)</script>"'],
      ['the end of the style element in a url', 'url(a;</style>)'],
      ['a newline that ends a string early', '"a;\nb'],
      ['the start of the style element outside a string', 'a<style'],
      ['the end of the style element outside a string', 'a</style>'],
      ['a > outside a string', 'a>b'],
      ['a newline before a brace', '"a"\n}'],
      ['a vertical tab', 'a\u000bb'],
      ['a script url with a ;', 'url("javascript:alert(1);")'],
      ['a comment in a string', '"a;/* b */"'],
    ])('refuses and reports %s', (_label, text) => {
      const { out, onDrop } = value(text);
      expect(out).toBe('.fc-a.fc-a{margin:4px}');
      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(onDrop).toHaveBeenCalledWith({
        className: 'fc-a',
        property: 'backgroundImage',
        reason: 'unsafe-value',
      });
    });

    // Where the emitter owns the output it can hold more than the raw text could.
    it.each([
      ['a newline in a string', '"a;\nb"', '"a;\\a b"'],
      ['a carriage return and newline as one newline', '"a\r\nb"', '"a\\a b"'],
      ['a form feed in a string', '"a\fb"', '"a\\a b"'],
      ['a < in a string', '"a<b"', '"a\\3c b"'],
      ['the end of the style element in a string', '"</style>"', '"\\3c /style>"'],
      ['an svg data url', `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>")`, `url("data:image/svg+xml,\\3c svg xmlns='http://www.w3.org/2000/svg'/>")`],
      ['a value over two lines', '"a b"\n"c d"', '"a b" "c d"'],
      ['a tab between tokens', 'a\tb', 'a b'],
    ])('escapes %s', (_label, text, written) => {
      const { out, onDrop } = value(text);
      expect(out).toBe(`.fc-a.fc-a{background-image:${written};margin:4px}`);
      expect(out).not.toContain('<');
      expect(onDrop).not.toHaveBeenCalled();
    });

    it('keeps a data url in a breakpoint query too', () => {
      const image = 'url("data:image/png;base64,AAA=")';
      expect(css({ backgroundImage: { 'bp-tablet': image } })).toBe(
        `@media (max-width:1199.98px){\n.fc-a.fc-a{background-image:${image}}\n}`,
      );
    });
  });

  it('skips rules whose class name is not a safe fc- class', () => {
    expect(buildResponsiveCss([{ className: 'x{}', style: { color: { base: 'red' } } }], BPS)).toBe('');
  });

  it('orders rules by input and blocks by breakpoint, deterministically', () => {
    const rules = [
      { className: 'fc-b', style: { color: { base: 'blue', 'bp-phone': 'navy' } } },
      { className: 'fc-a', style: { color: { base: 'red', 'bp-tablet': 'pink', 'bp-phone': 'maroon' } } },
    ];
    const first = buildResponsiveCss(rules, BPS);
    expect(first).toBe(
      '.fc-b.fc-b{color:blue}\n.fc-a.fc-a{color:red}\n' +
        '@media (max-width:1199.98px){\n.fc-a.fc-a{color:pink}\n}\n' +
        '@media (max-width:809.98px){\n.fc-b.fc-b{color:navy}\n.fc-a.fc-a{color:maroon}\n}',
    );
    expect(buildResponsiveCss(rules, [...BPS].reverse())).toBe(first);
  });

  it('with no breakpoints, applies base everywhere and emits no queries', () => {
    expect(buildResponsiveCss([{ className: 'fc-a', style: { color: { base: 'red', x: 'blue' } } }], [])).toBe(
      '.fc-a.fc-a{color:red}',
    );
  });

  it('returns an empty sheet when nothing resolves', () => {
    expect(css({ color: { base: '' } })).toBe('');
  });

  it('rounds the query width so float noise never reaches the sheet', () => {
    expect(maxWidthBelow(810)).toBe('809.98');
    expect(maxWidthBelow(1200)).toBe('1199.98');
    expect(maxWidthBelow(810.1)).toBe('810.08');
  });
});
