// src/lib/stickyCta/stickyCta.ts
//
// The sticky mobile call to action (published site essentials, decision 7,
// docs/plans/2026-10-23-published-site-essentials.md): a bar with one link
// that stays at the bottom of the screen on the smallest breakpoint of a
// published page and in the preview. A dedicated primitive instead of a raw
// `position: fixed` style, so the published renderer owns the parts a style
// cannot express safely: the safe area of a phone with a home indicator, the
// bottom padding that keeps the last content reachable, the stacking with the
// consent banner, and "at most one per page".
//
// The component is one node: a div marked `data-sticky-cta="bar"` (the bar,
// styled through the normal sections: background, padding, font) whose link
// is described by props (label, href, button colours), like the form submit
// button renders its own content. The renderers draw the inner <a>.
//
//   - Editor canvas: a normal block where the node sits, with a label saying
//     what it does (createComponentElement, mode 'editor').
//   - Preview: hoisted to the end of the page root, `position: sticky` at the
//     bottom of the preview frame (the frame is the scroll container, so a
//     fixed element would stick to the browser window instead), on the
//     smallest breakpoint only.
//   - Published page: hoisted to the end of the page root (hoistStickyCta),
//     `position: fixed` at the bottom below the smallest breakpoint's max
//     width (stickyCtaCss), hidden above it.
//
// PURE: no React, no MST. Shared by the registry, the generator's validator,
// the renderers and the properties panel.

import { maxWidthBelow } from '@/lib/responsive/responsiveCss';
import { CONSENT_BANNER_ID } from '@/lib/consent/consent';

/** The marker prop (and DOM attribute) of the sticky call to action bar. */
export const STICKY_CTA_ATTR = 'data-sticky-cta';
export const STICKY_CTA_MARKER = 'bar';

/** The props that describe the link (never DOM attributes). */
export const STICKY_CTA_PROP_KEYS = ['ctaLabel', 'ctaHref', 'buttonBackground', 'buttonTextColor', 'buttonRadius'] as const;
export type StickyCtaPropKey = (typeof STICKY_CTA_PROP_KEYS)[number];

export const DEFAULT_STICKY_CTA = {
  ctaLabel: 'Book now',
  ctaHref: '#contact',
  buttonBackground: '#111827',
  buttonTextColor: '#ffffff',
  buttonRadius: '10px',
} as const;

/** The editor label shown on the canvas (the bar is a normal block there). */
export const STICKY_CTA_CANVAS_LABEL = 'Sticky call to action: pinned to the bottom of the screen on mobile';

/**
 * Below this width the bar is pinned when the page has only one breakpoint
 * (no smaller breakpoint says where "mobile" ends): the editor's default
 * tablet breakpoint starts at 810px.
 */
export const STICKY_CTA_FALLBACK_MAX_WIDTH = 809.98;

/**
 * The page's bottom padding (and the consent banner's lift) before the inline
 * measurement runs, and without JavaScript: a 48px link plus 12px padding
 * above and below.
 */
export const STICKY_CTA_FALLBACK_HEIGHT_PX = 72;

/** Stacking: above page content, below the consent banner (z-index 2147483000). */
export const STICKY_CTA_Z_INDEX = 2147482000;

/** The attribute the published page's pinned bar carries (the CSS target). */
export const STICKY_CTA_PINNED_ATTR = 'data-fc-sticky-cta';

export interface StickyCtaLink {
  label: string;
  href: string;
  buttonBackground: string;
  buttonTextColor: string;
  buttonRadius: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** True when the props mark a sticky call to action bar. */
export function isStickyCta(props: unknown): boolean {
  return isRecord(props) && props[STICKY_CTA_ATTR] === STICKY_CTA_MARKER;
}

/** Allowed link targets: http(s), mailto, tel, an in-page anchor or a site path (the generator's rule). */
export function isSafeCtaHref(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 500) return false;
  if (/[\u0000-\u001f\u007f\s<>"]/.test(v)) return false;
  if (v.startsWith('#') || (v.startsWith('/') && !v.startsWith('//'))) return true;
  return /^(https?:\/\/|mailto:|tel:)/i.test(v);
}

/**
 * A colour or length for the button: printable, short, and unable to escape
 * a declaration (no ; { } \ < > quotes). Anything else falls back to the
 * default.
 */
export function isSafeCtaStyleValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && !/[;{}\\<>"'\u0000-\u001f\u007f]/.test(value) && !/url\s*\(|expression\s*\(/i.test(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The link the bar shows, with every value checked: an unsafe href is left
 * out (the link renders without one rather than with a javascript: URL), an
 * unsafe colour falls back to the default.
 */
export function readStickyCta(props: unknown): StickyCtaLink {
  const p = isRecord(props) ? props : {};
  const label = (text(p.ctaLabel) ?? '').trim().slice(0, 80);
  const href = typeof p.ctaHref === 'string' && isSafeCtaHref(p.ctaHref) ? p.ctaHref.trim() : '';
  const pick = (key: 'buttonBackground' | 'buttonTextColor' | 'buttonRadius') =>
    isSafeCtaStyleValue(p[key]) ? (p[key] as string).trim() : DEFAULT_STICKY_CTA[key];
  return {
    label,
    href,
    buttonBackground: pick('buttonBackground'),
    buttonTextColor: pick('buttonTextColor'),
    buttonRadius: pick('buttonRadius'),
  };
}

/** The bar's DOM props: the link description removed (it is drawn as the inner <a>). */
export function stripStickyCtaProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  for (const key of STICKY_CTA_PROP_KEYS) delete out[key];
  delete out.children;
  return out;
}

/** The inner link's style: a full-width, 48px tall button (a comfortable touch target). */
export function stickyCtaLinkStyle(link: StickyCtaLink): Record<string, string | number> {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 48,
    padding: '12px 20px',
    backgroundColor: link.buttonBackground,
    color: link.buttonTextColor,
    borderRadius: link.buttonRadius,
    fontFamily: 'inherit',
    fontSize: 16,
    fontWeight: 600,
    lineHeight: 1.2,
    textAlign: 'center',
    textDecoration: 'none',
  };
}

/** The generator's and the panel's check for one link prop value. */
export function cleanStickyCtaProp(key: StickyCtaPropKey, value: unknown): string | undefined {
  if (key === 'ctaLabel') {
    const t = text(value)?.replace(/\s+/g, ' ').trim();
    return t && t.length <= 80 && !/[<>\u0000-\u001f\u007f]/.test(t) ? t : undefined;
  }
  if (key === 'ctaHref') return typeof value === 'string' && isSafeCtaHref(value) ? value.trim() : undefined;
  return isSafeCtaStyleValue(value) ? value.trim() : undefined;
}

// ---------------------------------------------------------------- published page

/** The minimal tree shape the hoist reads (a hydrated ComponentNode). */
export interface StickyCtaTreeNode {
  id?: string;
  type?: string;
  props?: Record<string, unknown> | null;
  children?: StickyCtaTreeNode[];
}

export interface HoistResult<N extends StickyCtaTreeNode> {
  root: N;
  /** The bar, moved to the end of the root's children, when the page has one. */
  bar: N | null;
  /** Sticky bars after the first one, removed (at most one per page). */
  removed: number;
}

/**
 * Move the page's first sticky call to action to the end of the root's
 * children and drop any further ones. A new tree; the input is not mutated.
 * The bar keeps its marker so the renderer can draw it; the pinned attribute
 * tells the published stylesheet which element to fix.
 */
export function hoistStickyCta<N extends StickyCtaTreeNode>(root: N): HoistResult<N> {
  let bar: N | null = null;
  let removed = 0;
  const strip = (node: N): N => {
    if (!node.children || node.children.length === 0) return node;
    const children: N[] = [];
    for (const child of node.children as N[]) {
      if (isStickyCta(child.props)) {
        if (bar === null) bar = child;
        else removed += 1;
        continue;
      }
      children.push(strip(child));
    }
    return { ...node, children };
  };
  if (isStickyCta(root.props)) return { root, bar: null, removed: 0 };
  const stripped = strip(root);
  if (bar === null) return { root: stripped, bar: null, removed };
  const found = bar as N;
  const pinned = { ...found, props: { ...(found.props ?? {}), [STICKY_CTA_PINNED_ATTR]: '' } } as N;
  return { root: { ...stripped, children: [...(stripped.children ?? []), pinned] }, bar: pinned, removed };
}

/**
 * The media query width below which the bar is pinned: just under the second
 * smallest breakpoint's min width (the smallest breakpoint's range), or the
 * fallback when the page has a single breakpoint.
 */
export function stickyCtaMaxWidth(breakpoints: readonly { minWidth: number }[]): number {
  const ascending = [...new Set(breakpoints.map((b) => b.minWidth).filter((w) => Number.isFinite(w)))].sort((a, b) => a - b);
  if (ascending.length < 2) return STICKY_CTA_FALLBACK_MAX_WIDTH;
  return Number(maxWidthBelow(ascending[1]));
}

/**
 * The published stylesheet for the bar. Hidden above the smallest breakpoint;
 * below it fixed to the bottom, the body padded by the bar's height (so the
 * last content scrolls clear of it), and the consent banner lifted above the
 * bar so both stay usable. `!important` because the bar's own inline style and
 * its responsive class must not undo the pinning, and the banner's offset is
 * an inline style. The bar's height comes from the inline measurement
 * (stickyCtaMeasureScript) as `--fc-sticky-cta-h`, with a fallback.
 * Constant text apart from numbers.
 */
export function stickyCtaCss(breakpoints: readonly { minWidth: number }[]): string {
  const max = stickyCtaMaxWidth(breakpoints);
  const h = `var(--fc-sticky-cta-h,${STICKY_CTA_FALLBACK_HEIGHT_PX}px)`;
  const sel = `[${STICKY_CTA_PINNED_ATTR}]`;
  return (
    `${sel}{display:none!important}` +
    `@media (max-width:${max}px){` +
    `${sel}{display:block!important;position:fixed!important;left:0!important;right:0!important;bottom:0!important;top:auto!important;` +
    `width:auto!important;margin:0!important;z-index:${STICKY_CTA_Z_INDEX}!important;box-sizing:border-box!important;` +
    `padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))!important}` +
    `body{padding-bottom:${h}!important}` +
    `#${CONSENT_BANNER_ID}{bottom:calc(${h} + 12px)!important}` +
    `}`
  );
}

/**
 * Measures the pinned bar and publishes its height as `--fc-sticky-cta-h` on
 * the root element, kept current with a ResizeObserver (text wrapping, font
 * loading, rotation). Hand-written ES5, constant text. A hidden bar (above the
 * smallest breakpoint) measures 0 and leaves the variable alone.
 */
export function stickyCtaMeasureScript(): string {
  return (
    '(function(){var d=document,el=d.querySelector("[' + STICKY_CTA_PINNED_ATTR + ']");if(!el)return;' +
    'var r=d.documentElement;function m(){var h=el.offsetHeight;if(h>0)r.style.setProperty("--fc-sticky-cta-h",h+"px");}' +
    'm();if(window.ResizeObserver){new ResizeObserver(m).observe(el);}else{window.addEventListener("resize",m);}})();'
  );
}

/** True when the page tree holds a sticky call to action anywhere. */
export function treeHasStickyCta(node: StickyCtaTreeNode | null | undefined): boolean {
  if (!node) return false;
  if (isStickyCta(node.props)) return true;
  return (node.children ?? []).some(treeHasStickyCta);
}
