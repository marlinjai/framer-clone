// src/server/books/__tests__/numbering.test.ts
//
// Books plan P1.9: number formats (company configuration in the counter row)
// and the calendar-day helpers of the issue date rules.

import { describe, expect, it } from 'vitest';

import { addDays, berlinToday, formatDocumentNumber, isIsoDate, resolveIssueDate } from '../numbering';

describe('numbering', () => {
  it('format renders plain, prefixed and padded numbers', () => {
    expect(formatDocumentNumber('{n}', 62)).toBe('62');
    expect(formatDocumentNumber('GS-{n}', 1)).toBe('GS-1');
    expect(formatDocumentNumber('{n:4}', 7)).toBe('0007');
    expect(formatDocumentNumber('ANG-{n:3}/X', 12)).toBe('ANG-012/X');
    expect(() => formatDocumentNumber('no token', 1)).toThrow(/invalid number format/);
    expect(() => formatDocumentNumber('{n}', 0)).toThrow(/invalid counter value/);
  });

  it('calendar days are Europe/Berlin and never in the future', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin.
    expect(berlinToday(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    const now = new Date('2026-10-17T10:00:00Z');
    expect(resolveIssueDate(undefined, now)).toBe('2026-10-17');
    expect(() => resolveIssueDate('2026-10-18', now)).toThrow(/ISSUE_DATE_OUT_OF_ORDER/);
    expect(() => resolveIssueDate('17.10.2026', now)).toThrow(/INVALID_INPUT/);
  });
});
