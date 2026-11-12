import { describe, expect, it } from 'vitest';
import { normalizeSiteSettings } from '../siteSettings';
import {
  buildBusinessJsonLd,
  jsonLdScriptText,
  ogLocale,
  pageMetadata,
  pagePath,
  siteLayoutMetadata,
  previewMetadata,
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

describe('uploaded images (/site-images/<sha256>.<ext>)', () => {
  const sha = 'b'.repeat(64);
  const favicon = `/site-images/${sha}.png`;
  const icoIcon = `/site-images/${sha}.ico`;
  const sharing = `/site-images/${sha}.jpg`;
  const pageImage = `/site-images/${'c'.repeat(64)}.webp`;

  it('keeps an uploaded icon relative with its type, and makes the sharing image absolute on the primary host', () => {
    const m = siteLayoutMetadata({ settings: settings({ faviconUrl: favicon, ogImageUrl: sharing }), siteName: 'A', primaryHost: 'www.baeckerei.de' });
    expect(m.icons).toEqual({ icon: [{ url: favicon, type: 'image/png' }], apple: [{ url: favicon }] });
    expect(m.openGraph).toMatchObject({ images: [{ url: `https://www.baeckerei.de${sharing}` }] });
    expect(m.twitter).toMatchObject({ images: [`https://www.baeckerei.de${sharing}`] });
  });

  it('leaves an uploaded ICO out of the Apple touch icon', () => {
    const m = siteLayoutMetadata({ settings: settings({ faviconUrl: icoIcon }), siteName: 'A', primaryHost: 'a.test' });
    expect(m.icons).toEqual({ icon: [{ url: icoIcon, type: 'image/x-icon' }] });
  });

  it('prefers the page upload over the site default, both absolute', () => {
    const base = { settings: settings({ ogImageUrl: sharing }), siteName: 'A', primaryHost: 'shop.example.com', path: '/t' };
    const m = pageMetadata({ ...base, page: { ...emptyPage, title: 'T', ogImage: pageImage } });
    expect(m.openGraph).toMatchObject({ images: [{ url: `https://shop.example.com${pageImage}` }] });
    expect(m.twitter).toMatchObject({ images: [`https://shop.example.com${pageImage}`] });
    const fallback = pageMetadata({ ...base, page: { ...emptyPage, title: 'T' } });
    expect(fallback.openGraph).toMatchObject({ images: [{ url: `https://shop.example.com${sharing}` }] });
  });

  it('emits no sharing image for an upload when no primary host is known (crawlers need a full address)', () => {
    const m = siteLayoutMetadata({ settings: settings({ faviconUrl: favicon, ogImageUrl: sharing }), siteName: 'A', primaryHost: null });
    expect(m.icons).toBeDefined();
    expect((m.openGraph as { images?: unknown }).images).toBeUndefined();
  });

  it('leaves out a path that only looks like an upload', () => {
    const m = siteLayoutMetadata({
      settings: settings({ faviconUrl: '/site-images/x.png', ogImageUrl: `/site-images/${sha}.svg` }),
      siteName: 'A',
      primaryHost: 'a.test',
    });
    expect(m.icons).toBeUndefined();
    expect((m.openGraph as { images?: unknown }).images).toBeUndefined();
  });

  it('puts absolute upload addresses into the JSON-LD', () => {
    const data = buildBusinessJsonLd({
      settings: settings({ faviconUrl: favicon, ogImageUrl: sharing, business: { phone: '+49 89 1234567' } }),
      siteName: 'A',
      primaryHost: 'a.test',
    });
    expect(data?.logo).toBe(`https://a.test${favicon}`);
    expect(data?.image).toBe(`https://a.test${sharing}`);
  });
});

describe('previewMetadata (a branch\'s public preview link)', () => {
  it('is never indexed or followed and names no canonical, sharing address, base or manifest', () => {
    const settings = normalizeSiteSettings({});
    const layout = previewMetadata(siteLayoutMetadata({ settings, siteName: 'Bakery', primaryHost: 'preview-x.sites.lumitra.co' }));
    expect(layout.robots).toEqual({ index: false, follow: false, noarchive: true });
    expect(layout.manifest).toBeUndefined();
    expect(layout.metadataBase).toBeUndefined();
    expect(layout.title).toBeDefined();

    const page = previewMetadata(
      pageMetadata({
        page: { title: 'About', description: 'About us', keywords: [], canonicalUrl: 'https://bakery.example/about', ogTitle: '', ogDescription: '', ogImage: '', noIndex: false },
        settings,
        siteName: 'Bakery',
        primaryHost: 'preview-x.sites.lumitra.co',
        path: '/about',
      }),
    );
    expect(page.robots).toEqual({ index: false, follow: false, noarchive: true });
    expect(page.alternates).toBeUndefined();
    expect((page.openGraph as { url?: unknown }).url).toBeUndefined();
    expect((page.openGraph as { title?: unknown }).title).toBeDefined();
    expect(JSON.stringify(page)).not.toContain('bakery.example');
  });

  it('turns the neutral metadata of a host with no site into a never-indexed one', () => {
    expect(previewMetadata({ title: 'Site', robots: { index: true, follow: true } }).robots).toEqual({ index: false, follow: false, noarchive: true });
  });
});

describe('the Open Graph content type (head slice H1)', () => {
  const page = { ...emptyPage, title: 'A' };
  const input = { settings: settings(), siteName: 'Bakery', primaryHost: 'bakery.test', path: '/a' };

  it('writes website for a page that names none, exactly as before', () => {
    expect(pageMetadata({ ...input, page }).openGraph).toMatchObject({ type: 'website' });
    expect(pageMetadata({ ...input, page: { ...page, ogType: undefined } }).openGraph).toMatchObject({ type: 'website' });
  });

  it('writes the chosen type', () => {
    for (const ogType of ['article', 'book', 'profile', 'website']) {
      expect(pageMetadata({ ...input, page: { ...page, ogType } }).openGraph).toMatchObject({ type: ogType });
    }
  });

  it('reads a forged or unsupported type as website, so Next never throws on a published page', () => {
    for (const ogType of ['product', 'music.song', '__proto__', 'ARTICLE', '']) {
      expect(pageMetadata({ ...input, page: { ...page, ogType } }).openGraph).toMatchObject({ type: 'website' });
    }
  });

  it('changes nothing else about the page metadata', () => {
    const { openGraph: a, ...restA } = pageMetadata({ ...input, page });
    const { openGraph: b, ...restB } = pageMetadata({ ...input, page: { ...page, ogType: 'article' } });
    expect(restA).toEqual(restB);
    expect({ ...a, type: undefined }).toEqual({ ...b, type: undefined });
  });
});
