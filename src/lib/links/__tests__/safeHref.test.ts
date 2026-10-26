// The one link rule of a published page (src/lib/links/safeHref.ts).
import { describe, expect, it } from 'vitest';
import { isSafeHref } from '@/lib/links/safeHref';

describe('isSafeHref', () => {
  it('accepts site paths, anchors, https, mailto and tel only', () => {
    for (const ok of ['/contact', '/products/pearl-necklace', '#booking', 'https://example.com/book', 'mailto:hi@example.com', 'tel:+49301234']) {
      expect(isSafeHref(ok)).toBe(true);
    }
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'vbscript:x', '//evil.example', 'data:text/html,x', '', 'https://a b', 'ftp://x', 'java\tscript:x']) {
      expect(isSafeHref(bad)).toBe(false);
    }
  });

  it('refuses a target longer than 500 characters', () => {
    expect(isSafeHref(`/${'a'.repeat(499)}`)).toBe(true);
    expect(isSafeHref(`/${'a'.repeat(500)}`)).toBe(false);
  });
});
