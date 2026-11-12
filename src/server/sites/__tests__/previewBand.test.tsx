// The band every page of a branch's public preview carries (site branches, slice S8).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('server-only', () => ({}));

import { PREVIEW_UNAVAILABLE, PreviewBand, previewUnavailableText } from '../renderSitePage';

describe('PreviewBand', () => {
  const preview = { branchId: 'b1', branchName: '<b>Summer</b> sale', expiresAt: '2026-11-19T10:00:00.000Z' };

  it('says this is not the live site, names the branch and the day the link ends, and escapes the name', () => {
    const html = renderToStaticMarkup(<PreviewBand preview={preview} />);
    expect(html).toContain('role="note"');
    expect(html).toContain('data-fc-preview-band=""');
    expect(html).toContain('This is not the live site');
    expect(html).toContain('forms and checkout are switched off');
    expect(html).toContain('19 November 2026 at 10:00 UTC');
    expect(html).toContain('&lt;b&gt;Summer&lt;/b&gt; sale');
    expect(html).not.toContain('<b>Summer');
  });

  it('sits at the bottom edge, clear of a header the site fixes to the top, and keeps the end of the page free', () => {
    const html = renderToStaticMarkup(<PreviewBand preview={preview} />);
    const band = html.match(/<div role="note"[^>]*>/)![0];
    expect(band).toContain('position:fixed');
    expect(band).toContain('bottom:0');
    expect(band).not.toContain('top:');
    // The same text once more in the flow, unseen and unread, so the band's height is kept free after the page.
    const space = html.match(/<div aria-hidden="true" data-fc-preview-band-space=""[^>]*>([^<]*)<\/div>/)!;
    expect(space[0]).toContain('visibility:hidden');
    expect(space[0]).not.toContain('position:');
    expect(html.match(/<div role="note"[^>]*>([^<]*)<\/div>/)![1]).toBe(space[1]);
    expect(html.indexOf('data-fc-preview-band-space')).toBeLessThan(html.indexOf('role="note"'));
  });

  it('speaks German on a German site, as the consent banner does, and English on every other', () => {
    const de = renderToStaticMarkup(<PreviewBand preview={preview} language="de-AT" />);
    expect(de).toContain('Dies ist nicht die veröffentlichte Website');
    expect(de).toContain('Formulare und Kasse sind abgeschaltet');
    expect(de).toContain('19. November 2026 um 10:00 UTC');
    expect(renderToStaticMarkup(<PreviewBand preview={preview} language="fr" />)).toContain('This is not the live site');
    expect(previewUnavailableText('de')).toMatch(/Vorschau/);
    expect(previewUnavailableText('en')).toBe(PREVIEW_UNAVAILABLE);
    expect(previewUnavailableText('it')).toBe(PREVIEW_UNAVAILABLE);
  });

  it('has one sentence for forms and the checkout', () => {
    expect(PREVIEW_UNAVAILABLE).toMatch(/preview/);
  });
});
