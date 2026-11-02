import { describe, expect, it, vi } from 'vitest';
import { cappedZIndex, CONSENT_BANNER_Z_INDEX, STICKY_CTA_Z_INDEX, STORED_Z_INDEX_MAX, withCappedZIndex } from '../stacking';
import { buildResponsiveCss, holdsTopLayerValue, unsafeDeclaration } from '@/lib/responsive/responsiveCss';
import { parseSelector, refusedRuleValue } from '@/lib/rules/rules';
import { styleValueProblem } from '@/lib/ai/pageGen/validate';
import { renderedInlineStyle, safeInlineStyle, withoutBlockedProps } from '@/lib/renderer/blockedNodes';
import { nodeDomProps } from '@/lib/renderer/server/renderComponentNode';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const TOP = 2147483647;

describe('the stacking order', () => {
  it('keeps every stored z-index below the sticky bar, and the bar below the banner', () => {
    expect(STORED_Z_INDEX_MAX).toBeLessThan(STICKY_CTA_Z_INDEX);
    expect(STICKY_CTA_Z_INDEX).toBeLessThan(CONSENT_BANNER_Z_INDEX);
    expect(CONSENT_BANNER_Z_INDEX).toBe(TOP);
  });
});

describe('cappedZIndex', () => {
  it.each([
    [TOP, STORED_Z_INDEX_MAX],
    [STORED_Z_INDEX_MAX + 1, STORED_Z_INDEX_MAX],
    [String(TOP), String(STORED_Z_INDEX_MAX)],
    [`+${TOP}`, String(STORED_Z_INDEX_MAX)],
    [' 9999999999 ', String(STORED_Z_INDEX_MAX)],
    [`${TOP} !important`, `${STORED_Z_INDEX_MAX} !important`],
    [`${TOP}!IMPORTANT`, `${STORED_Z_INDEX_MAX} !important`],
    ['1e12', String(STORED_Z_INDEX_MAX)],
    ['var(--z)', `min(var(--z), ${STORED_Z_INDEX_MAX})`],
    [`calc(${TOP} * 2) !important`, `min(calc(${TOP} * 2), ${STORED_Z_INDEX_MAX}) !important`],
  ])('holds %j below the platform layers', (stored, emitted) => {
    expect(cappedZIndex(stored)).toBe(emitted);
  });

  it.each([0, 1, -5, 999999999, STORED_Z_INDEX_MAX, '10', '-2147483647', 'auto', 'inherit', 'revert-layer', '10 !important', '', 1.5, Number.NaN, null, undefined, { base: 1 }])(
    'leaves %j as it was stored',
    (stored) => {
      expect(cappedZIndex(stored)).toBe(stored);
    },
  );

  it('returns the same style object when nothing changes', () => {
    const style = { zIndex: 10, color: 'red' };
    expect(withCappedZIndex(style)).toBe(style);
    expect(withCappedZIndex({ color: 'red' })).toEqual({ color: 'red' });
    expect(withCappedZIndex({ zIndex: TOP, color: 'red' })).toEqual({ zIndex: STORED_Z_INDEX_MAX, color: 'red' });
  });
});

describe('every path that writes a stored z-index', () => {
  it('caps the inline style on the canvas and the published page, and refuses nothing for it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const style = { position: 'fixed', zIndex: TOP };
    // A high z-index is not unsafe: the import keeps it as stored.
    expect(safeInlineStyle(style)).toBe(style);
    expect(renderedInlineStyle(style)).toEqual({ position: 'fixed', zIndex: STORED_Z_INDEX_MAX });
    expect((withoutBlockedProps({ style }).style as Record<string, unknown>).zIndex).toBe(STORED_Z_INDEX_MAX);
    const node = { id: 'n', type: 'div', props: { style: { zIndex: `${TOP}` } }, children: [] } as unknown as ComponentNode;
    expect((nodeDomProps(node).style as Record<string, unknown>).zIndex).toBe(String(STORED_Z_INDEX_MAX));
  });

  it('caps Normal, a rule and a keyframe in the sheet', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = {
      id: 'n',
      type: 'div',
      props: {
        style: { zIndex: { base: TOP, phone: 'var(--z)' } },
        rules: [
          { id: 'up', selector: '&:not(#n)', style: { zIndex: `${TOP} !important` } },
          { id: 'kf', define: '@keyframes u-top', blocks: [{ selector: 'to', style: { zIndex: String(TOP) } }] },
        ],
      },
      children: [],
    } as unknown as ComponentNode;
    const { css } = applyResponsiveStyles(node, [{ id: 'desktop', minWidth: 1200 }, { id: 'phone', minWidth: 320 }]);
    expect(css).not.toContain(String(TOP));
    expect(css).toContain(`z-index:${STORED_Z_INDEX_MAX}`);
    expect(css).toContain(`z-index:min(var(--z), ${STORED_Z_INDEX_MAX})`);
    expect(css).toContain(`z-index:${STORED_Z_INDEX_MAX} !important`);
    expect(css).toMatch(new RegExp(`@keyframes u-top\\{\\s*to\\{z-index:${STORED_Z_INDEX_MAX}\\}`));
  });

  it('writes a z-index below the ceiling exactly as stored', () => {
    const css = buildResponsiveCss([{ className: 'fc-a', style: { zIndex: 50, position: 'relative' } }], [{ id: 'desktop', minWidth: 1200 }]);
    expect(css).toContain('z-index:50');
  });
});

describe('the top layer a stored page cannot reach', () => {
  it.each(['&::picker(select)', '&::PICKER(select)', '& ::picker(select)', '&:hover::picker(select)', '&::view-transition-old(root)', '&::view-transition'])(
    'refuses the selector %s',
    (selector) => {
      expect(parseSelector(selector).ok).toBe(false);
    },
  );

  it('keeps ::backdrop and the select parts that stay in the page', () => {
    for (const selector of ['&::backdrop', '&::picker-icon', '&::checkmark', '& option']) expect(parseSelector(selector).ok).toBe(true);
  });

  it.each(['base-select', 'BASE-SELECT', 'base\\2d select', 'var(--a, base-select)'])('refuses the value %s on every path', (value) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(holdsTopLayerValue(value)).toBe(true);
    // The rules parser, the sheet and the panel.
    expect(refusedRuleValue('appearance', value)).not.toBeNull();
    expect(unsafeDeclaration('appearance', value)).toBe('unsafe-value');
    expect(unsafeDeclaration('--a', value)).toBe('unsafe-value');
    // The inline style, which the importer also asks.
    expect(safeInlineStyle({ appearance: value, color: 'red' })).toEqual({ color: 'red' });
    // The page generator.
    expect(styleValueProblem('appearance', value)).toBeDefined();
  });

  it('leaves the other appearances', () => {
    for (const value of ['none', 'auto', 'menulist-button', 'textfield']) {
      expect(holdsTopLayerValue(value)).toBe(false);
      expect(unsafeDeclaration('appearance', value)).toBeNull();
    }
  });

  it('drops a picker rule from the published sheet', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = {
      id: 's',
      type: 'select',
      props: {
        rules: [
          { id: 'a', selector: '&', style: { appearance: 'base-select' } },
          { id: 'b', selector: '&::picker(select)', style: { position: 'fixed', inset: '0' } },
        ],
      },
      children: [],
    } as unknown as ComponentNode;
    const { css } = applyResponsiveStyles(node, [{ id: 'desktop', minWidth: 1200 }]);
    expect(css).not.toMatch(/picker|base-select/);
  });
});
