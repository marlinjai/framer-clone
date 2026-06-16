import { describe, it, expect } from 'vitest';

import { mapDataTableColumnType } from '../columnTypeMap';
import type { DataTableColumnType } from '../types';
import type { ColumnType as BindingColumnType } from '@/lib/bindings/dataSource/types';

// All THIRTEEN adapter-prisma input types and their expected binding output.
// Typed as the real unions so a drift in either package breaks compilation.
const CASES: ReadonlyArray<readonly [DataTableColumnType, BindingColumnType]> = [
  // Lossless 1:1
  ['text', 'text'],
  ['number', 'number'],
  ['date', 'date'],
  ['boolean', 'boolean'],
  ['select', 'select'],
  ['relation', 'relation'],
  ['file', 'file'],
  // Underscore -> hyphen
  ['multi_select', 'multi-select'],
  // Lossy -> text
  ['url', 'text'],
  ['formula', 'text'],
  ['rollup', 'text'],
  // Lossy -> date
  ['created_time', 'date'],
  ['last_edited_time', 'date'],
];

describe('mapDataTableColumnType (13 inputs -> 8 outputs)', () => {
  it('covers all 13 adapter-prisma input types', () => {
    expect(CASES).toHaveLength(13);
  });

  for (const [input, expected] of CASES) {
    it(`maps ${input} -> ${expected}`, () => {
      expect(mapDataTableColumnType(input)).toBe(expected);
    });
  }

  it('normalizes the multi_select underscore to a multi-select hyphen', () => {
    expect(mapDataTableColumnType('multi_select')).toBe('multi-select');
  });

  it('falls back url/formula/rollup to text (documented lossy)', () => {
    expect(mapDataTableColumnType('url')).toBe('text');
    expect(mapDataTableColumnType('formula')).toBe('text');
    expect(mapDataTableColumnType('rollup')).toBe('text');
  });

  it('falls back created_time/last_edited_time to date (documented lossy)', () => {
    expect(mapDataTableColumnType('created_time')).toBe('date');
    expect(mapDataTableColumnType('last_edited_time')).toBe('date');
  });

  it('produces only the 8 binding output types', () => {
    const allowed = new Set<BindingColumnType>([
      'text',
      'number',
      'boolean',
      'date',
      'select',
      'multi-select',
      'relation',
      'file',
    ]);
    for (const [input] of CASES) {
      expect(allowed.has(mapDataTableColumnType(input))).toBe(true);
    }
  });
});
