// src/app/projects/books/composer/__tests__/workingCopy.test.ts
//
// The composer's working copy: kept per template with its base version, a copy
// on the current version is restored, one on an older version is offered (never
// applied), a copy of another format or equal to the saved layout is dropped,
// and storage that throws never breaks the composer.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearWorkingCopy, readWorkingCopy, resumeDecision, writeWorkingCopy } from '../workingCopy';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('the working copy', () => {
  it('keeps a document with its base version, per template', () => {
    writeWorkingCopy('t1', { id: 'v3', version: 3 }, { a: 1 });
    writeWorkingCopy('t2', { id: 'v9', version: 9 }, { b: 2 });
    expect(readWorkingCopy('t1')).toMatchObject({ format: 1, baseVersionId: 'v3', baseVersion: 3, document: { a: 1 } });
    expect(readWorkingCopy('t2')?.document).toEqual({ b: 2 });
    clearWorkingCopy('t1');
    expect(readWorkingCopy('t1')).toBeNull();
    expect(readWorkingCopy('t2')).not.toBeNull();
  });

  it('drops a copy written before base versions existed, or unreadable', () => {
    window.localStorage.setItem('books-composer:t1', JSON.stringify({ document: { a: 1 } }));
    expect(readWorkingCopy('t1')).toBeNull();
    expect(window.localStorage.getItem('books-composer:t1')).toBeNull();
    window.localStorage.setItem('books-composer:t2', '{not json');
    expect(readWorkingCopy('t2')).toBeNull();
  });

  it('restores a copy made on the current version, offers one made on an older version, drops one equal to the saved layout', () => {
    writeWorkingCopy('t1', { id: 'v3', version: 3 }, { a: 2 });
    const copy = readWorkingCopy('t1');
    expect(resumeDecision(copy, 'v3', { a: 1 })).toEqual({ kind: 'restore', copy });
    expect(resumeDecision(copy, 'v4', { a: 1 })).toEqual({ kind: 'stale', copy });
    expect(resumeDecision(copy, 'v3', { a: 2 })).toEqual({ kind: 'none' });
    expect(resumeDecision(null, 'v3', { a: 1 })).toEqual({ kind: 'none' });
  });

  it('storage that throws (private window, blocked site data, full quota) is ignored', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => writeWorkingCopy('t1', { id: 'v1', version: 1 }, {})).not.toThrow();
    expect(readWorkingCopy('t1')).toBeNull();
    expect(() => clearWorkingCopy('t1')).not.toThrow();
  });
});
