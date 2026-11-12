// The band every page of a branch's public preview carries (site branches, slice S8).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('server-only', () => ({}));

import { PREVIEW_UNAVAILABLE, PreviewBand } from '../renderSitePage';

describe('PreviewBand', () => {
  it('says this is not the live site, names the branch and the day the link ends, and escapes the name', () => {
    const html = renderToStaticMarkup(<PreviewBand preview={{ branchId: 'b1', branchName: '<b>Summer</b> sale', expiresAt: '2026-11-19T10:00:00.000Z' }} />);
    expect(html).toContain('role="note"');
    expect(html).toContain('data-fc-preview-band');
    expect(html).toContain('This is not the live site');
    expect(html).toContain('forms and checkout are switched off');
    expect(html).toContain('19 November 2026 at 10:00 UTC');
    expect(html).toContain('&lt;b&gt;Summer&lt;/b&gt; sale');
    expect(html).not.toContain('<b>Summer');
  });

  it('has one sentence for forms and the checkout', () => {
    expect(PREVIEW_UNAVAILABLE).toMatch(/preview/);
  });
});
