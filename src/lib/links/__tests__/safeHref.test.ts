// The one link rule of a published page (src/lib/links/safeHref.ts).
import { describe, expect, it } from 'vitest';
import { isSafeHref, safeHrefFromData } from '@/lib/links/safeHref';

describe('isSafeHref', () => {
  it('accepts site paths, anchors, https, mailto and tel only', () => {
    for (const ok of ['/contact', '/products/pearl-necklace', '#booking', 'https://example.com/book', 'mailto:hi@example.com', 'tel:+49301234']) {
      expect(isSafeHref(ok)).toBe(true);
    }
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'vbscript:x', '//evil.example', '/\\evil.example', '/a\\b', 'data:text/html,x', '', 'https://a b', 'ftp://x', 'java\tscript:x']) {
      expect(isSafeHref(bad)).toBe(false);
    }
  });

  it('makes a data value with spaces usable, and refuses what cannot be a link', () => {
    expect(safeHrefFromData(' mailto:info@shop.example?subject=Frage zum Produkt ')).toBe('mailto:info@shop.example?subject=Frage%20zum%20Produkt');
    expect(safeHrefFromData('https://shop.example/my file.pdf')).toBe('https://shop.example/my%20file.pdf');
    expect(safeHrefFromData('java script:alert(1)')).toBeNull();
    expect(safeHrefFromData('/a\nb')).toBeNull();
    expect(safeHrefFromData(42)).toBeNull();
  });

  it('refuses a target longer than 500 characters', () => {
    expect(isSafeHref(`/${'a'.repeat(499)}`)).toBe(true);
    expect(isSafeHref(`/${'a'.repeat(500)}`)).toBe(false);
  });
});
