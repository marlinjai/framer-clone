// src/app/projects/catalog/__tests__/state.test.ts
//
// The catalogue table's remembered state (state.ts): filters to and from the
// address, the columns per person in a storage that may refuse, and the price
// range text.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLUMNS,
  EMPTY_FILTERS,
  filtersFrom,
  isFiltered,
  loadColumns,
  moveColumn,
  priceRange,
  queryWith,
  saveColumns,
  toggleColumn,
} from '../state';

describe('filters in the address', () => {
  it('round-trips, keeps other parameters and drops defaults and unknown values', () => {
    const f = { ...EMPTY_FILTERS, q: 'ring', status: 'published' as const, stock: 'in_stock' as const, sort: 'price' as const, dir: 'desc' as const };
    const q = queryWith(new URLSearchParams('tab=products&product=p1'), f);
    expect(q).toBe('?tab=products&product=p1&q=ring&status=published&stock=in_stock&sort=price&dir=desc');
    expect(filtersFrom(new URLSearchParams(q.slice(1)))).toEqual(f);
    expect(queryWith(new URLSearchParams(), EMPTY_FILTERS)).toBe('');
    expect(filtersFrom(new URLSearchParams('status=deleted&sort=random&dir=up'))).toEqual(EMPTY_FILTERS);
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, collection: 'c1' })).toBe(true);
  });
});

describe('columns per person', () => {
  function memory(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      get length() {
        return m.size;
      },
    };
  }

  it('saves and loads the shown columns in order, ignoring unknown ones', () => {
    const s = memory();
    saveColumns('k', ['price', 'photo'], () => s);
    expect(loadColumns('k', () => s)).toEqual(['price', 'photo']);
    s.setItem('k', JSON.stringify(['stock', 'nonsense', 'stock']));
    expect(loadColumns('k', () => s)).toEqual(['stock']);
    s.setItem('k', '{broken');
    expect(loadColumns('k', () => s)).toEqual(DEFAULT_COLUMNS);
  });

  it('works when the storage refuses every access', () => {
    const refusing = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(loadColumns('k', refusing)).toEqual(DEFAULT_COLUMNS);
    expect(() => saveColumns('k', ['price'], refusing)).not.toThrow();
  });

  it('moves and toggles columns', () => {
    expect(moveColumn(['photo', 'status', 'price'], 'price', -1)).toEqual(['photo', 'price', 'status']);
    expect(moveColumn(['photo', 'status'], 'photo', -1)).toEqual(['photo', 'status']);
    expect(toggleColumn(['photo', 'status'], 'status')).toEqual(['photo']);
    expect(toggleColumn(['photo'], 'updated')).toEqual(['photo', 'updated']);
  });
});

it('writes a price range', () => {
  expect(priceRange(null, null)).toBe('No price');
  expect(priceRange(4900, 4900)).toBe('49,00 €');
  expect(priceRange(4900, 8900)).toBe('49,00 € to 89,00 €');
});
