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
