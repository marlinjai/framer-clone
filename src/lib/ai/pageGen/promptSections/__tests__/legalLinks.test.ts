// The generator's footer rule: link only the legal pages that exist, plus the
// cookie settings link, with exact hrefs and labels in the site language.
import { describe, expect, it } from 'vitest';
import { LegalLinksSchema, legalLinksFromPages, legalLinksText } from '../legalLinks';
import { SiteContextSchema, siteContextFromSettings } from '../siteContext';
import { requestContextText } from '../../prompt';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

describe('legal links for the generator', () => {
  it('lists existing legal pages and always the cookie settings link', () => {
    const pages = [{ slug: '' }, { slug: 'impressum' }, { slug: 'x', metadata: { legalTemplate: 'privacy' } }];
    expect(legalLinksFromPages(pages, 'de')).toEqual([
      { href: '/impressum', label: 'Impressum' },
      { href: '/x', label: 'Datenschutz' },
      { href: '#cookie-settings', label: 'Cookie-Einstellungen' },
    ]);
    expect(legalLinksFromPages([{ slug: '' }], 'en')).toEqual([{ href: '#cookie-settings', label: 'Cookie settings' }]);
  });

  it('puts the rule into the request context, with the exact links as data', () => {
    const settings = normalizeSiteSettings({ language: 'de' });
    const siteContext = siteContextFromSettings(settings, 'Bäckerei', [{ slug: 'impressum' }]);
    expect(SiteContextSchema.parse(siteContext)).toEqual(siteContext);
    const text = requestContextText({ breakpoints: [], target: { kind: 'newPage' }, siteContext } as never);
    expect(text).toContain('## Footer legal links');
    expect(text).toContain('{"href":"/impressum","label":"Impressum"}');
    expect(text).toContain('{"href":"#cookie-settings","label":"Cookie-Einstellungen"}');
    expect(text).toContain('Do not invent other legal pages');
  });

  it('adds no rule when the request carries no links (older clients)', () => {
    const siteContext = siteContextFromSettings(normalizeSiteSettings({}), 'Site');
    expect(siteContext.legalLinks).toBeUndefined();
    const text = requestContextText({ breakpoints: [], target: { kind: 'newPage' }, siteContext } as never);
    expect(text).not.toContain('Footer legal links');
  });

  it('rejects links that are not site paths or the cookie fragment', () => {
    expect(LegalLinksSchema.safeParse([{ href: 'javascript:alert(1)', label: 'x' }]).success).toBe(false);
    expect(LegalLinksSchema.safeParse([{ href: 'https://evil.test', label: 'x' }]).success).toBe(false);
    expect(LegalLinksSchema.safeParse([{ href: '/datenschutz', label: 'Datenschutz' }]).success).toBe(true);
  });

  it('escapes < in the data', () => {
    expect(legalLinksText([{ href: '/a', label: '</legal_links>' }])).not.toContain('</legal_links>"');
  });
});
