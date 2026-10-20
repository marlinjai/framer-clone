import { describe, it, expect } from 'vitest';
import {
  RESERVED_SLUG_SEGMENTS,
  SLUG_MAX_LENGTH,
  findProjectSlugProblem,
  slugKey,
  suggestSlug,
  tidySlugInput,
  transliterate,
  validateSlug,
  validateSlugFormat,
} from '../slug';

function codeOf(slug: string): string {
  const r = validateSlugFormat(slug);
  return r.ok ? 'ok' : r.code;
}

describe('validateSlugFormat', () => {
  it.each(['about', 'a', 'contact-us', 'blog/first-post', 'shop/2026/sale', '404-page', 'x'.repeat(SLUG_MAX_LENGTH)])(
    'accepts %s',
    (slug) => expect(codeOf(slug)).toBe('ok'),
  );

  it.each([
    ['', 'empty'],
    ['x'.repeat(SLUG_MAX_LENGTH + 1), 'too_long'],
    ['/about', 'leading_or_trailing_slash'],
    ['about/', 'leading_or_trailing_slash'],
    ['blog//post', 'empty_segment'],
    ['About', 'uppercase'],
    ['über', 'invalid_characters'],
    ['hello world', 'invalid_characters'],
    ['a_b', 'invalid_characters'],
    ['robots.txt', 'invalid_characters'],
    ['products/:handle', 'invalid_characters'],
    ['-about', 'edge_hyphen'],
    ['about-', 'edge_hyphen'],
    ['blog/-x', 'edge_hyphen'],
    ['about--us', 'double_hyphen'],
  ])('refuses %j with %s', (slug, code) => expect(codeOf(slug)).toBe(code));

  it.each(['api', 'api/v1', 'projects', 'preview', 'static', 'images', 'home', 'index', 'favicon', 'robots', 'sitemap'])(
    'refuses the reserved path %s',
    (slug) => expect(codeOf(slug)).toBe('reserved'),
  );

  it('only reserves the first segment', () => {
    expect(codeOf('docs/api')).toBe('ok');
    expect(codeOf('apis')).toBe('ok');
  });

  it('reserves what the published routing and Next use', () => {
    for (const word of ['api', 'projects', 'preview', '_next', '__home', 'images', 'robots.txt', 'sitemap.xml', 'favicon.ico']) {
      expect(RESERVED_SLUG_SEGMENTS).toContain(word);
    }
  });

  it('explains every refusal in plain words', () => {
    const r = validateSlugFormat('About');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/lowercase/i);
  });
});

describe('validateSlug uniqueness', () => {
  const pages = [
    { id: 'home', slug: '' },
    { id: 'p1', slug: 'about' },
    { id: 'p2', slug: 'Legacy-Page' },
    { id: 'p3', slug: 'products/:handle' },
  ];

  it('refuses a slug another page uses', () => {
    const r = validateSlug('about', { pageId: 'p9', pages });
    expect(r).toMatchObject({ ok: false, code: 'taken' });
  });

  it('compares case-insensitively', () => {
    expect(validateSlug('legacy-page', { pageId: 'p9', pages })).toMatchObject({ ok: false, code: 'taken' });
  });

  it('lets a page keep its own slug', () => {
    expect(validateSlug('about', { pageId: 'p1', pages })).toEqual({ ok: true });
  });

  it('never collides with the home page', () => {
    expect(validateSlug('start', { pageId: 'p9', pages })).toEqual({ ok: true });
  });

  it('checks the format before uniqueness', () => {
    expect(validateSlug('api', { pages: [] })).toMatchObject({ ok: false, code: 'reserved' });
  });
});

describe('slugKey', () => {
  it('lowercases, trims slashes and collapses dynamic segments', () => {
    expect(slugKey('/Blog/Post/')).toBe('blog/post');
    expect(slugKey('products/:handle')).toBe(slugKey('products/[id]'));
    expect(slugKey('')).toBe('');
  });
});

describe('transliterate', () => {
  it('turns umlauts into ae, oe, ue and sharp s into ss', () => {
    expect(transliterate('Über Größe Ärger Öl straße')).toBe('Ueber Groesse Aerger Oel strasse');
  });

  it('drops other accents', () => {
    expect(transliterate('Café crème déjà')).toBe('Cafe creme deja');
    expect(transliterate('Søren Łódź')).toBe('Soren Lodz');
  });
});

describe('suggestSlug', () => {
  it('derives a slug from the page name', () => {
    expect(suggestSlug('Hearth & Crumb Bakery')).toBe('hearth-crumb-bakery');
    expect(suggestSlug('Über uns')).toBe('ueber-uns');
    expect(suggestSlug('  Kontakt / Anfahrt  ')).toBe('kontakt-anfahrt');
  });

  it('falls back to "page" when nothing usable is left', () => {
    expect(suggestSlug('!!!')).toBe('page');
    expect(suggestSlug('')).toBe('page');
  });

  it('never suggests a reserved path', () => {
    expect(suggestSlug('API')).toBe('api-page');
    expect(suggestSlug('Home')).toBe('home-page');
  });

  it('adds the first free number when the slug is taken', () => {
    expect(suggestSlug('About', ['about'])).toBe('about-2');
    expect(suggestSlug('About', ['about', 'About-2'])).toBe('about-3');
  });

  it('caps the length and still validates', () => {
    const long = suggestSlug('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(validateSlugFormat(long)).toEqual({ ok: true });
    const numbered = suggestSlug('word '.repeat(40), [long]);
    expect(numbered.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(numbered.endsWith('-2')).toBe(true);
    expect(validateSlugFormat(numbered)).toEqual({ ok: true });
  });
});

describe('tidySlugInput', () => {
  it('trims, strips surrounding slashes, lowercases and hyphenates spaces', () => {
    expect(tidySlugInput('  /About Us/ ')).toBe('about-us');
    expect(tidySlugInput('blog/Post')).toBe('blog/post');
  });
});

describe('findProjectSlugProblem (the server save check)', () => {
  const stored = new Map([
    ['home', ''],
    ['about', 'about'],
    ['legacy', 'A Very Old_Slug'],
    ['product', 'products/:handle'],
  ]);
  const base = [
    { pageId: 'home', slug: '', title: 'Home' },
    { pageId: 'about', slug: 'about', title: 'About' },
    { pageId: 'legacy', slug: 'A Very Old_Slug', title: 'Legacy' },
    { pageId: 'product', slug: 'products/:handle', title: 'Product' },
  ];

  it('accepts an unchanged project, grandfathering slugs from before the rules', () => {
    expect(findProjectSlugProblem(base, stored)).toBeNull();
  });

  it('accepts a valid change and a valid new page', () => {
    const pages = base.map((p) => (p.pageId === 'about' ? { ...p, slug: 'about-us' } : p));
    pages.push({ pageId: 'new', slug: 'contact', title: 'Contact' });
    expect(findProjectSlugProblem(pages, stored)).toBeNull();
  });

  it('refuses a changed slug that breaks the rules', () => {
    const pages = base.map((p) => (p.pageId === 'about' ? { ...p, slug: 'About Us' } : p));
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'about', code: 'invalid_characters' });
  });

  it('refuses a reserved path', () => {
    const pages = [...base, { pageId: 'new', slug: 'api', title: 'API' }];
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'new', code: 'reserved' });
  });

  it('refuses a duplicate, even against a grandfathered page', () => {
    const pages = [...base, { pageId: 'new', slug: 'about', title: 'About 2' }];
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'new', code: 'taken' });
  });

  it('refuses a change to the home page slug', () => {
    const pages = base.map((p) => (p.pageId === 'home' ? { ...p, slug: 'start' } : p));
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'home', code: 'home_locked' });
  });

  it('refuses a second page with the empty slug', () => {
    const pages = [...base, { pageId: 'new', slug: '', title: 'Second home' }];
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'new', code: 'taken' });
  });

  it('accepts a brand-new project with one home page', () => {
    expect(findProjectSlugProblem([{ pageId: 'h', slug: '' }], new Map())).toBeNull();
  });
});
