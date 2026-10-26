// src/app/projects/books/__tests__/tabs.test.ts
//
// The tab a link asks for: only a known tab opens, anything else is the documents.
// The products tab stays (it points to the Catalog), so an old ?tab=products link still lands.

import { describe, expect, it } from 'vitest';

import { BOOKS_TABS, tabFrom } from '../tabs';

describe('tabFrom', () => {
  it('opens a known tab and falls back to the documents', () => {
    expect(tabFrom('templates')).toBe('templates');
    expect(tabFrom('customers')).toBe('customers');
    expect(tabFrom('products')).toBe('products');
    expect(tabFrom('documents')).toBe('documents');
    expect(tabFrom(undefined)).toBe('documents');
    expect(tabFrom(['templates'])).toBe('documents');
    expect(tabFrom('<script>')).toBe('documents');
  });

  it('lists every tab once, documents first', () => {
    expect(BOOKS_TABS.map((t) => t.tab)).toEqual(['documents', 'customers', 'products', 'templates']);
  });
});
