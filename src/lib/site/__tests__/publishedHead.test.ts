import { describe, expect, it } from 'vitest';
import { normalizeSiteSettings } from '../siteSettings';
import {
  buildBusinessJsonLd,
  jsonLdScriptText,
  ogLocale,
  pageMetadata,
  pagePath,
  siteLayoutMetadata,
} from '../publishedHead';

const settings = (raw: Record<string, unknown> = {}) => normalizeSiteSettings(raw);
const emptyPage = {
  title: '',
  description: '',
  keywords: [],
  ogTitle: '',
  ogDescription: '',
  ogImage: '',
  canonicalUrl: '',
  noIndex: false,
};

describe('pagePath', () => {
  it('maps the home page to / and fills and encodes params', () => {
    expect(pagePath('')).toBe('/');
    expect(pagePath('blog/first-post')).toBe('/blog/first-post');
    expect(pagePath('shop/:handle', { handle: 'tee & cap' })).toBe('/shop/tee%20%26%20cap');
    expect(pagePath('posts/[id]', { id: '42' })).toBe('/posts/42');
    expect(pagePath('shop/:handle')).toBeNull();
  });
});

describe('ogLocale', () => {
  it('uses a region from the tag, else the business country, else none', () => {
    expect(ogLocale(settings({ language: 'en-GB' }))).toBe('en_GB');
    expect(ogLocale(settings({ language: 'de', business: { country: 'AT' } }))).toBe('de_AT');
    expect(ogLocale(settings({ language: 'de' }))).toBeUndefined();
  });
});

describe('siteLayoutMetadata', () => {
  it('leaves out an image or icon address that is not https', () => {
    const m = siteLayoutMetadata({
      settings: settings({ faviconUrl: 'http://x.test/i.png', ogImageUrl: 'javascript:alert(1)' }),
      siteName: 'A',
      primaryHost: null,
    });
    expect(m.icons).toBeUndefined();
    expect(m.metadataBase).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('javascript');
  });

  it('applies a custom title template', () => {
    const m = siteLayoutMetadata({ settings: settings({ titleTemplate: '%s · Müller' }), siteName: 'Müller', primaryHost: 'x.de' });
    expect(m.title).toEqual({ template: '%s · Müller', default: 'Müller' });
  });
});

describe('pageMetadata', () => {
  const base = { settings: settings(), siteName: 'Müller', primaryHost: 'www.mueller.de' };

  it('keeps a canonical set by hand', () => {
    const m = pageMetadata({ ...base, page: { ...emptyPage, title: 'A', canonicalUrl: 'https://other.test/a' }, path: '/a' });
    expect(m.alternates).toEqual({ canonical: 'https://other.test/a' });
  });

  it('has no canonical without a primary host or a path', () => {
    expect(pageMetadata({ ...base, primaryHost: null, page: { ...emptyPage, title: 'A' }, path: '/a' }).alternates).toBeUndefined();
    expect(pageMetadata({ ...base, page: { ...emptyPage, title: 'A' }, path: null }).alternates).toBeUndefined();
  });

  it('uses the page Open Graph title and description when set', () => {
    const m = pageMetadata({
      ...base,
      page: { ...emptyPage, title: 'A', description: 'd', ogTitle: 'OG A', ogDescription: 'OG d' },
      path: '/a',
    });
    expect(m.openGraph).toMatchObject({ title: 'OG A', description: 'OG d' });
    expect(m.description).toBe('d');
  });

  it('is noindex for the 404 page', () => {
    expect(pageMetadata({ ...base, page: { ...emptyPage, title: 'A' }, path: '/a', isNotFoundPage: true }).robots).toEqual({
      index: false,
      follow: true,
    });
  });
});

describe('buildBusinessJsonLd', () => {
  it('is null without business data', () => {
    expect(buildBusinessJsonLd({ settings: settings(), siteName: 'A', primaryHost: 'a.de' })).toBeNull();
  });

  it('is an Organization without a complete address', () => {
    const data = buildBusinessJsonLd({
      settings: settings({ business: { email: 'hi@a.de', managingDirectors: ['Anna'] } }),
      siteName: 'A',
      primaryHost: null,
    })!;
    expect(data['@type']).toBe('Organization');
    expect(data.email).toBe('hi@a.de');
    expect(data.url).toBeUndefined();
    expect(data.address).toBeUndefined();
    expect(data.employee).toEqual([{ '@type': 'Person', name: 'Anna', jobTitle: 'Managing Director' }]);
  });

  it('is a LocalBusiness with address and valid opening hours only', () => {
    const data = buildBusinessJsonLd({
      settings: settings({
        business: {
          street: 'Hauptstr. 1',
          postalCode: '80331',
          city: 'München',
          country: 'DE',
          vatId: 'DE123',
          openingHours: [
            { days: ['Saturday', 'Monday'], opens: '08:00', closes: '12:00' },
            { days: [], opens: '08:00', closes: '12:00' },
            { days: ['Sunday'], opens: '18:00', closes: '08:00' },
          ],
        },
      }),
      siteName: 'Müller',
      primaryHost: 'mueller.de',
    })!;
    expect(data['@type']).toBe('LocalBusiness');
    expect(data.vatID).toBe('DE123');
    expect(data.openingHoursSpecification).toEqual([
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Saturday'], opens: '08:00', closes: '12:00' },
    ]);
  });

  it('serializes so no value can close the script element', () => {
    const text = jsonLdScriptText({ name: '</script><script>alert(1)</script>' });
    expect(text).not.toContain('</script>');
    expect(JSON.parse(text).name).toBe('</script><script>alert(1)</script>');
  });
});
