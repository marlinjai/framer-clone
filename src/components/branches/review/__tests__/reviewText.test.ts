// The words of the review screen (src/components/branches/review/reviewText.ts, slice S5).

import { describe, expect, it } from 'vitest';
import { conflictText, escapeId, fieldText, outlineSheet, totalsText, valueText } from '../reviewText';
import type { DocumentReview, UnitReview } from '@/lib/siteMerge/elementChanges';

describe('valueText', () => {
  it('reads text, sizes and hidden values, and never shows raw data', () => {
    expect(valueText('Hello')).toBe('Hello');
    expect(valueText('')).toBe('empty');
    expect(valueText(null)).toBe('nothing');
    expect(valueText(12)).toBe('12');
    expect(valueText({ omitted: true, characters: 12345 })).toBe('12,345 characters, too long to show here');
    expect(valueText({ omitted: true, hidden: true })).toBe('not shown');
    expect(valueText({ color: 'red', fontSize: 12 })).toBe('color, fontSize');
    expect(valueText({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('a, b, c and 2 more');
    expect(valueText({})).toBe('empty');
    expect(valueText(['x'])).toBe('1 item');
    expect(valueText([1, 2, 3])).toBe('3 items');
    expect(valueText({ a: 'x'.repeat(400) })).not.toContain('{');
  });
});

describe('fieldText', () => {
  it('names fields for people', () => {
    expect(fieldText('props.children')).toBe('text');
    expect(fieldText('props.style.color')).toBe('style: color');
    expect(fieldText('props.href')).toBe('href');
    expect(fieldText('slug')).toBe('address');
  });
});

describe('conflictText', () => {
  const review: DocumentReview = {
    site: [], settings: [], pageOrder: false,
    units: [{ unit: 'page', id: 'home', title: 'Home', change: 'changed', fields: [], elements: [{ id: 'h', kind: 'changed', type: 'h1', label: 'Welcome', fields: [] }] }],
  };
  it('names the page, the element and the field', () => {
    expect(conflictText({ id: 'c', kind: 'value', unit: { kind: 'node', id: 'h', container: 'page:home' }, path: ['props', 'children'], fingerprint: 'f', options: ['main', 'branch'] }, review)).toBe('Home: Welcome: text');
    expect(conflictText({ id: 'c', kind: 'removed', unit: { kind: 'page', id: 'home' }, path: [], fingerprint: 'f', options: ['main', 'branch'] }, review)).toBe('Home: removed in one place, changed in the other');
    expect(conflictText({ id: 'c', kind: 'value', unit: { kind: 'site', id: 'site' }, path: ['name'], fingerprint: 'f', options: ['main', 'branch'] }, review)).toBe('Site: name');
  });
});

describe('outlineSheet and escapeId', () => {
  const unit: UnitReview = {
    unit: 'page', id: 'home', title: 'Home', change: 'changed', fields: [],
    elements: [{ id: 'a"b', kind: 'changed', type: 'p', label: 'x', fields: [] }, { id: 'gone', kind: 'removed', type: 'p', label: 'y', fields: [] }],
  };
  it('escapes ids so a quote cannot end the selector', () => {
    const sheet = outlineSheet(unit, 'main', null, escapeId);
    expect(sheet).not.toContain('a"b');
    expect(sheet).toContain('"gone"');
    expect(outlineSheet(unit, 'branch', null, escapeId)).not.toContain('gone');
    expect(outlineSheet({ ...unit, unit: 'component' }, 'branch', null, escapeId)).toContain('outline');
    expect(outlineSheet(undefined, 'branch', null, escapeId)).toBe('');
  });
  it('counts the totals from the list', () => {
    expect(totalsText({ site: [{ field: 'name', before: 'a', after: 'b' }], settings: [], pageOrder: false, units: [unit] })).toBe('1 page, 2 elements, 1 site setting changed');
  });
});
