// src/lib/renderer/stickyCta/stickyCtaElement.tsx
//
// The sticky call to action bar as a React element (src/lib/stickyCta/stickyCta.ts),
// shared by every surface. PURE: no hooks, no MST, no window, no 'use client'
// and no server-only, because the published server renderer
// (renderComponentNode, also reused inside client islands), the preview and
// the editor canvas all call it.
//
//   - 'editor':    the bar where it sits, with a label saying what it does;
//                  the link is a span (a click selects the component, it never
//                  navigates away from the editor).
//   - 'preview' and 'published': the bar with a real link. Where it is pinned
//                  is the caller's business (the preview's sticky wrapper,
//                  the published stylesheet).

import React from 'react';
import { readStickyCta, STICKY_CTA_CANVAS_LABEL, stickyCtaLinkStyle, stripStickyCtaProps } from '@/lib/stickyCta/stickyCta';

export type StickyCtaSurface = 'editor' | 'preview' | 'published';

const CANVAS_LABEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 8,
  transform: 'translateY(-100%)',
  padding: '2px 6px',
  borderRadius: '4px 4px 0 0',
  background: '#16a34a',
  color: '#ffffff',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 10,
  fontWeight: 600,
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
};

/** The bar with its link, for one surface. `props` are the bar's resolved props (marker and link props included). */
export function createStickyCtaElement(
  props: Record<string, unknown>,
  surface: StickyCtaSurface,
  key?: React.Key,
): React.ReactElement {
  const link = readStickyCta(props);
  const domProps = stripStickyCtaProps(props);
  const linkStyle = stickyCtaLinkStyle(link) as React.CSSProperties;
  const label = link.label || 'Call to action';

  if (surface === 'editor') {
    const style = { ...((domProps.style as React.CSSProperties | undefined) ?? {}), position: 'relative' as const };
    return React.createElement(
      'div',
      { ...domProps, key, style, 'aria-label': STICKY_CTA_CANVAS_LABEL },
      <span data-fc-sticky-cta-label="" aria-hidden="true" style={CANVAS_LABEL_STYLE}>
        Sticky call to action · mobile only
      </span>,
      <span data-fc-sticky-cta-link="" style={{ ...linkStyle, cursor: 'default' }}>
        {label}
      </span>,
    );
  }

  return React.createElement(
    'div',
    { ...domProps, key },
    link.href ? (
      <a data-fc-sticky-cta-link="" href={link.href} style={linkStyle}>
        {label}
      </a>
    ) : (
      // No safe link (an owner cleared it): the label without a dead link.
      <span data-fc-sticky-cta-link="" style={linkStyle}>
        {label}
      </span>
    ),
  );
}
