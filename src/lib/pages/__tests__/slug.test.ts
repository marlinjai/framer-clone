import { describe, it, expect } from 'vitest';
import {
  RESERVED_SLUG_SEGMENTS,
  SLUG_MAX_LENGTH,
  findProjectSlugProblem,
  productHref,
  productPagePath,
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
    ['-about', 'edge_hyphen'],
    ['about-', 'edge_hyphen'],
    ['blog/-x', 'edge_hyphen'],
    ['about--us', 'double_hyphen'],
  ])('refuses %j with %s', (slug, code) => expect(codeOf(slug)).toBe(code));

  it.each(['products/:handle', 'shop/rings/:handle'])('accepts the product page %s', (slug) =>
    expect(codeOf(slug)).toBe('ok'),
  );

  it.each([':handle', 'products/:id', 'products/[handle]', 'products/:handle/reviews', ':handle/products'])(
    'refuses the placeholder in %j (only a final :handle after a fixed part)',
    (slug) => expect(codeOf(slug)).toBe('invalid_characters'),
  );

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

describe('productPagePath and productHref', () => {
  it('finds the product page of a site and links a product under it', () => {
    expect(productPagePath(['', 'about', 'products/:handle'])).toBe('/products');
    expect(productPagePath(['shop/rings/:handle'])).toBe('/shop/rings');
    expect(productHref('/products', 'pearl-necklace')).toBe('/products/pearl-necklace');
  });

  it('is null without a valid product page', () => {
    expect(productPagePath(['', 'about'])).toBeNull();
    expect(productPagePath([':handle'])).toBeNull();
    expect(productPagePath(['events/:id'])).toBeNull();
  });

  it('picks the same page every time when a site has two', () => {
    expect(productPagePath(['shop/:handle', 'products/:handle'])).toBe('/products');
    expect(productPagePath(['products/:handle', 'shop/:handle'])).toBe('/products');
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

  it('accepts a new product page', () => {
    const pages = [...base.filter((p) => p.pageId !== 'product'), { pageId: 'shop', slug: 'shop/:handle', title: 'Shop item' }];
    expect(findProjectSlugProblem(pages, stored)).toBeNull();
  });

  it('refuses a second product page at the same path', () => {
    const pages = [...base, { pageId: 'new', slug: 'products/:handle', title: 'Product 2' }];
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'new', code: 'taken' });
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

  it('refuses a non-home page taking the empty slug while a home page exists', () => {
    const pages = base.map((p) => (p.pageId === 'about' ? { ...p, slug: '' } : p));
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'about', code: 'taken' });
  });

  it('refuses a save that drops the home page', () => {
    const pages = base.filter((p) => p.pageId !== 'home');
    expect(findProjectSlugProblem(pages, stored)).toMatchObject({ pageId: 'home', code: 'home_locked' });
  });

  describe('changing the home page', () => {
    const swapped = base.map((p) =>
      p.pageId === 'home' ? { ...p, slug: 'home-page' } : p.pageId === 'about' ? { ...p, slug: '' } : p,
    );

    it('accepts another page taking the root while the former home page moves to a free slug', () => {
      expect(findProjectSlugProblem(swapped, stored)).toBeNull();
    });

    it('accepts the former home page being deleted in the same save', () => {
      expect(findProjectSlugProblem(swapped.filter((p) => p.pageId !== 'home'), stored)).toBeNull();
    });

    it('validates the slug the former home page moves to', () => {
      const reserved = swapped.map((p) => (p.pageId === 'home' ? { ...p, slug: 'api' } : p));
      expect(findProjectSlugProblem(reserved, stored)).toMatchObject({ pageId: 'home', code: 'reserved' });
      const withContact = [...swapped, { pageId: 'contact', slug: 'contact', title: 'Contact' }];
      const taken = withContact.map((p) => (p.pageId === 'home' ? { ...p, slug: 'contact' } : p));
      expect(findProjectSlugProblem(taken, stored)).toMatchObject({ code: 'taken' });
    });

    it('refuses two pages taking the root at once', () => {
      const two = swapped.map((p) => (p.pageId === 'legacy' ? { ...p, slug: '' } : p));
      expect(findProjectSlugProblem(two, stored)).toMatchObject({ code: 'taken' });
    });

    it('still refuses a save that leaves nothing at the root, with the way out in the message', () => {
      const moved = base.map((p) => (p.pageId === 'home' ? { ...p, slug: 'start' } : p));
      const problem = findProjectSlugProblem(moved, stored);
      expect(problem).toMatchObject({ pageId: 'home', code: 'home_locked' });
      expect(problem?.message).toContain('Make another page the home page first.');
    });

    it('accepts changing back (the previous home page takes the root again)', () => {
      const storedSwapped = new Map(swapped.map((p) => [p.pageId, p.slug]));
      expect(findProjectSlugProblem(base, storedSwapped)).toBeNull();
    });
  });

  describe('older projects', () => {
    const twoHomes = new Map([['h1', ''], ['h2', ''], ['about', 'about']]);
    const twoHomePages = [
      { pageId: 'h1', slug: '' },
      { pageId: 'h2', slug: '' },
      { pageId: 'about', slug: 'about' },
    ];

    it('keep saving with two empty-slug pages they already had', () => {
      expect(findProjectSlugProblem(twoHomePages, twoHomes)).toBeNull();
    });

    it('may move or delete the extra one, as long as one home stays', () => {
      const moved = twoHomePages.map((p) => (p.pageId === 'h2' ? { ...p, slug: 'old-home' } : p));
      expect(findProjectSlugProblem(moved, twoHomes)).toBeNull();
      expect(findProjectSlugProblem(twoHomePages.filter((p) => p.pageId !== 'h2'), twoHomes)).toBeNull();
    });

    it('validate the slug the extra one moves to', () => {
      const moved = twoHomePages.map((p) => (p.pageId === 'h2' ? { ...p, slug: 'api' } : p));
      expect(findProjectSlugProblem(moved, twoHomes)).toMatchObject({ pageId: 'h2', code: 'reserved' });
    });

    it('cannot move both away', () => {
      const moved = twoHomePages.map((p) =>
        p.pageId === 'about' ? p : { ...p, slug: `x-${p.pageId}` },
      );
      expect(findProjectSlugProblem(moved, twoHomes)).toMatchObject({ code: 'home_locked' });
    });

    it('without a home page may give exactly one page the empty slug', () => {
      const noHome = new Map([['a', 'about'], ['b', 'blog']]);
      expect(findProjectSlugProblem([{ pageId: 'a', slug: '' }, { pageId: 'b', slug: 'blog' }], noHome)).toBeNull();
      expect(
        findProjectSlugProblem([{ pageId: 'a', slug: '' }, { pageId: 'b', slug: '' }], noHome),
      ).toMatchObject({ code: 'taken' });
    });
  });
});
