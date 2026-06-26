// Storefront 404 for the published `(site)` route group (MT-15).
//
// Next resolves `notFound()` thrown from `(site)/[...slug]/page.tsx` (an
// unknown host or an unmatched slug) to the NEAREST `not-found.tsx`. Before this
// file existed, that was the app-root `not-found` rendered inside the editor's
// root layout — shipping editor metadata/chrome to a public storefront miss.
// This is a clean, self-contained storefront 404 with no editor chrome and no
// data-table CSS (styles are inline so it never depends on editor stylesheets).

import React from 'react';
import Link from 'next/link';

export default function SiteNotFound() {
  return (
    <main
      data-testid="storefront-404"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
        fontFamily:
          'var(--font-geist-sans), system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        color: '#111827',
        background: '#ffffff',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: '0.875rem',
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#6b7280',
        }}
      >
        404
      </p>
      <h1 style={{ margin: 0, fontSize: '1.875rem', fontWeight: 700 }}>
        Page not found
      </h1>
      <p style={{ margin: 0, maxWidth: '32rem', color: '#6b7280' }}>
        The page you&rsquo;re looking for doesn&rsquo;t exist or may have been
        moved.
      </p>
      <Link
        href="/"
        style={{
          marginTop: '0.5rem',
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: '8px',
          background: '#5b5bd6',
          padding: '0.625rem 1.25rem',
          fontSize: '0.875rem',
          fontWeight: 600,
          color: '#ffffff',
          textDecoration: 'none',
        }}
      >
        Go to homepage
      </Link>
    </main>
  );
}
