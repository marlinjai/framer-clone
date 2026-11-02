// Google Maps and the privacy policy: the publish check notices a map the policy
// does not name, the privacy template gains a Google Maps section only for a site
// that embeds one, and the suggested wording is that same section.

import { describe, expect, it } from 'vitest';
import { EMPTY_BUSINESS } from '@/lib/site/siteSettings';
import { checkBeforePublish, hasPublishIssues, namesGoogleMaps, type PublishCheckPage } from '../publishCheck';
import { GOOGLE_MAPS_PRIVACY, buildLegalTemplate, factsFromTrees, type LegalBlock } from '../templates';
import { MAP_EMBED_ATTR, MAP_EMBED_MARKER } from '@/lib/mapEmbed/mapEmbed';

const noComponents = { definitions: {}, refused: [] };
const map = { id: 'm', type: 'div', props: { [MAP_EMBED_ATTR]: MAP_EMBED_MARKER, mapAddress: 'Berlin' } };

const page = (id: string, slug: string, children: unknown[], legalTemplate?: string): PublishCheckPage => ({
  id,
  slug,
  metadata: { title: id, ...(legalTemplate ? { legalTemplate } : {}) },
  snapshot: { appComponentTree: { id: `${id}-root`, type: 'div', props: {}, children } } as never,
});
const text = (children: string) => ({ id: `t${children.length}`, type: 'p', props: { children } });

describe('the publish check', () => {
  it('says nothing about maps on a site without one', () => {
    const check = checkBeforePublish(EMPTY_BUSINESS, [page('home', '', [text('Hi')])], noComponents);
    expect(check.maps).toBeNull();
    expect(hasPublishIssues(check)).toBe(false);
  });

  it('warns about a map on a site without a privacy policy', () => {
    const check = checkBeforePublish(EMPTY_BUSINESS, [page('home', '', [map])], noComponents);
    expect(check.maps).toEqual({ status: 'no-privacy-page', privacyPageId: null, privacyTitle: null });
    expect(hasPublishIssues(check)).toBe(true);
  });

  it('warns while the privacy policy does not name Google Maps, and is quiet once it does', () => {
    const before = checkBeforePublish(EMPTY_BUSINESS, [page('home', '', [map]), page('privacy', 'datenschutz', [text('Server-Logfiles')], 'privacy')], noComponents);
    expect(before.maps).toEqual({ status: 'not-named', privacyPageId: 'privacy', privacyTitle: 'privacy' });
    expect(hasPublishIssues(before)).toBe(true);
    const after = checkBeforePublish(EMPTY_BUSINESS, [page('home', '', [map]), page('privacy', 'datenschutz', [text('Karten von Google Maps')], 'privacy')], noComponents);
    expect(after.maps?.status).toBe('named');
    expect(hasPublishIssues(after)).toBe(false);
  });

  it('finds a map on any page and the name in any spelling of the words', () => {
    expect(namesGoogleMaps({ props: { children: 'google  maps' } })).toBe(true);
    expect(namesGoogleMaps({ props: { children: 'Google-Maps' } })).toBe(true);
    expect(namesGoogleMaps({ props: { children: 'Google Fonts' }, children: [{ props: { children: 'Maps' } }] })).toBe(false);
  });

  it('reads a check without maps (an older stored one) as having none', () => {
    expect(hasPublishIssues({ missingImpressum: false, placeholders: [], components: [] } as never)).toBe(false);
  });
});

describe('the privacy template', () => {
  const body = (blocks: LegalBlock[]) => blocks.map((b) => (b.kind === 'list' ? b.items.join('\n') : b.text)).join('\n');
  const privacy = (language: string, maps: boolean, analytics = false) =>
    buildLegalTemplate({ kind: 'privacy', language, business: EMPTY_BUSINESS, siteName: 'X', facts: { analytics, unsplash: false, forms: false, maps } });

  it('has a Google Maps section only for a site that embeds a map, in both languages', () => {
    for (const language of ['de', 'en'] as const) {
      const without = body(privacy(language, false).blocks);
      const withMaps = privacy(language, true);
      expect(without).not.toContain('Google Maps');
      const section = GOOGLE_MAPS_PRIVACY[language];
      expect(withMaps.blocks.some((b) => b.kind === 'h2' && b.text.endsWith(section.title))).toBe(true);
      for (const paragraph of section.paragraphs) expect(body(withMaps.blocks)).toContain(paragraph);
      expect(body(withMaps.blocks)).toContain('Google Ireland Limited');
      expect(body(withMaps.blocks)).toContain('lumitra-consent-maps');
      expect(body(withMaps.blocks)).not.toMatch(/[\u2013\u2014]/);
      // The template the owner creates names Google Maps, so the publish check is satisfied by it.
      expect(namesGoogleMaps({ children: withMaps.blocks.map((b) => ({ props: { children: b.kind === 'list' ? '' : b.text } })) })).toBe(true);
    }
  });

  it('no longer says nothing is ever stored when a map can set cookies after consent', () => {
    expect(body(privacy('de', true).blocks)).toContain('Ohne Ihre Einwilligung setzt diese Website keine Cookies');
    expect(body(privacy('en', true).blocks)).toContain('Without your consent this website sets no cookies');
    expect(body(privacy('en', false).blocks)).toContain('This website sets no cookies');
  });

  it('leaves the transfer basis to the owner to check, as a placeholder', () => {
    expect(GOOGLE_MAPS_PRIVACY.de.paragraphs.join(' ')).toMatch(/\[Prüfen, ob die Übermittlung/);
    expect(GOOGLE_MAPS_PRIVACY.en.paragraphs.join(' ')).toMatch(/\[Check whether the transfer/);
  });

  it('notices a map in the page trees', () => {
    expect(factsFromTrees([{ props: {}, children: [{ props: map.props }] }], false).maps).toBe(true);
    expect(factsFromTrees([{ props: { 'data-map-embed': 'other' } }], false).maps).toBe(false);
  });
});
