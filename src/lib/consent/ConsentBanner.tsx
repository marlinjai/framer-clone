// src/lib/consent/ConsentBanner.tsx
//
// The published site's consent banner (src/lib/consent/consent.ts): server
// rendered, hidden until the inline runtime that follows it decides, so a
// visitor who already chose never sees it flash, and a visitor without
// JavaScript sees nothing (nothing loads without JavaScript either, so there
// is nothing to ask). No 'use client': there is no island, the runtime is the
// inline script.
//
// Accessibility: a non-modal dialog (role="dialog", aria-modal="false")
// labelled by its heading and described by its text, so it never blocks the
// page; it is rendered first in the body, so keyboard and screen reader users
// reach it before the content; it takes focus only when the visitor opens it
// (footer link), and Escape then closes it. Accept and Decline are two
// buttons of exactly the same style (no dark pattern), at least 44 px tall.
//
// Styled from the site's look (font, text and background colour, the accent
// of its first filled button: src/lib/site/notFoundDefault.ts), neutral when
// the site sets none, or when a colour pair or a font it sets cannot be shown to
// read (legibleLook).
//
// A rule on `:root` reaches everything the banner inherits, so BANNER_PINNED sets
// each of those on its root. An element's own value beats an inherited one, even
// an `!important` one. src/lib/rules/rootProperties.ts holds the list.

import React from 'react';
import { legibleLook, type SiteLook } from '@/lib/site/notFoundDefault';
import { DEFAULT_PAGE_BASE, type PageBase } from '@/lib/site/pageBase';
import type { TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { CONSENT_BANNER_ID, consentCopy, consentCss, consentRuntimeScript } from './consent';

/**
 * What the banner would otherwise inherit from the document, at the values a page
 * with no rule on `:root` gives it. Those depend on the site's page base: the reset
 * smooths fonts and sets a tab size of 4, the browser base takes both back out.
 */
export function bannerPinned(base: PageBase): React.CSSProperties {
  return base === 'browser' ? { ...BANNER_PINNED, ...BROWSER_BASE } : BANNER_PINNED;
}

const BROWSER_BASE: React.CSSProperties = {
  MozOsxFontSmoothing: 'auto',
  tabSize: 8,
  textSizeAdjust: 'auto',
  WebkitFontSmoothing: 'auto',
  WebkitTextSizeAdjust: 'auto',
};

/** The pins on the default base. */
export const BANNER_PINNED: React.CSSProperties = {
  accentColor: 'auto',
  colorScheme: 'normal',
  fontFeatureSettings: 'normal',
  fontVariationSettings: 'normal',
  fontWeight: 400,
  letterSpacing: 'normal',
  MozOsxFontSmoothing: 'grayscale',
  tabSize: 4,
  textRendering: 'auto',
  textSizeAdjust: '100%',
  WebkitFontSmoothing: 'antialiased',
  WebkitTextSizeAdjust: '100%',
};

export interface ConsentBannerProps {
  /** The tracker to load after consent (validated by buildTrackerPayload). */
  tracker: TrackerPayload;
  /** The site language (Site settings), BCP 47. */
  language: string;
  look: SiteLook;
  /** Path of the site's privacy policy page, when it has one. */
  privacyHref?: string | null;
  /** The site's page base, which decides what the banner's pins match. */
  pageBase?: PageBase;
}

export function ConsentBanner({ tracker, language, look: siteLook, privacyHref, pageBase = DEFAULT_PAGE_BASE }: ConsentBannerProps) {
  const look = legibleLook(siteLook);
  const copy = consentCopy(language);
  const titleId = `${CONSENT_BANNER_ID}-title`;
  const textId = `${CONSENT_BANNER_ID}-text`;
  const button: React.CSSProperties = {
    flex: '1 1 140px',
    minHeight: 44,
    padding: '10px 18px',
    borderRadius: 8,
    border: `1px solid ${look.accent}`,
    background: look.accent,
    color: look.accentText,
    font: 'inherit',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  };
  return (
    <>
      <style data-fc-consent-style="" dangerouslySetInnerHTML={{ __html: consentCss() }} />
      <div
        id={CONSENT_BANNER_ID}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        hidden
        // The runtime below shows or keeps it hidden before hydration.
        suppressHydrationWarning
        data-fc-consent=""
        style={{
          position: 'fixed',
          left: 16,
          right: 16,
          bottom: 16,
          zIndex: 2147483000,
          boxSizing: 'border-box',
          maxWidth: 560,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '18px 20px',
          borderRadius: 12,
          border: '1px solid rgba(127, 127, 127, 0.35)',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.18)',
          background: look.background,
          color: look.color,
          fontFamily: look.fontFamily,
          fontSize: 15,
          lineHeight: 1.5,
          textAlign: 'left',
          ...bannerPinned(pageBase),
        }}
      >
        <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 700, lineHeight: 1.3, color: 'inherit', fontFamily: 'inherit' }}>
          {copy.title}
        </h2>
        <p id={textId} style={{ margin: 0, color: 'inherit', fontFamily: 'inherit' }}>
          {copy.body}
          {privacyHref ? (
            <>
              {' '}
              <a href={privacyHref} style={{ color: 'inherit', textDecoration: 'underline' }}>
                {copy.privacyLink}
              </a>
            </>
          ) : null}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button type="button" data-fc-consent-decline="" style={button}>
            {copy.decline}
          </button>
          <button type="button" data-fc-consent-accept="" style={button}>
            {copy.accept}
          </button>
        </div>
      </div>
      <script data-fc-consent-runtime="" dangerouslySetInnerHTML={{ __html: consentRuntimeScript({ tracker }) }} />
    </>
  );
}
