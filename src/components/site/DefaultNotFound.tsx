// src/components/site/DefaultNotFound.tsx
//
// The default 404 of a published site (rendered by src/app/(site)/not-found.tsx
// when the site has not designed its own): the site's name, copy in its
// language, and the look of its home page. Inline styles only, so it never
// depends on editor stylesheets.

import React from 'react';
import Link from 'next/link';
import { notFoundCopy, type SiteLook } from '@/lib/site/notFoundDefault';

export interface DefaultNotFoundProps {
  siteName: string;
  language: string;
  look: SiteLook;
}

export function DefaultNotFound({ siteName, language, look }: DefaultNotFoundProps) {
  const copy = notFoundCopy(language);
  return (
    <main
      data-testid="storefront-404"
      lang={language}
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem 1rem',
        textAlign: 'center',
        fontFamily: look.fontFamily,
        color: look.color,
        background: look.background,
      }}
    >
      {siteName ? (
        <p style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }} data-testid="storefront-404-site">
          {siteName}
        </p>
      ) : null}
      <p
        style={{
          margin: 0,
          fontSize: '0.875rem',
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          opacity: 0.65,
        }}
      >
        {copy.eyebrow}
      </p>
      <h1 style={{ margin: 0, fontSize: '1.875rem', fontWeight: 700 }}>{copy.heading}</h1>
      <p style={{ margin: 0, maxWidth: '32rem', opacity: 0.75 }}>{copy.body}</p>
      <Link
        href="/"
        style={{
          marginTop: '0.5rem',
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: '8px',
          background: look.accent,
          padding: '0.625rem 1.25rem',
          fontSize: '0.875rem',
          fontWeight: 600,
          color: look.accentText,
          textDecoration: 'none',
        }}
      >
        {copy.homeLink}
      </Link>
    </main>
  );
}

