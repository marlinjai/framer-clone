// Unit tests for the pure resolveDataState directive helper.
//
// Covers all four directives (loading / empty / error / content) in BOTH
// modes, plus the two contract-critical cases the spec calls out:
//  - editor ERROR carries the real message (never swallowed),
//  - preview ERROR renders nothing (no message) and the call never throws.
import { describe, it, expect } from 'vitest';
import { resolveDataState } from '../resolveDataState';
import type { Row } from '@/lib/bindings/dataSource/types';

const ROWS: Row[] = [
  { id: 'r1', values: { title: 'One' } },
  { id: 'r2', values: { title: 'Two' } },
];

describe('resolveDataState', () => {
  describe('LOADING', () => {
    it('returns loading in editor mode', () => {
      expect(
        resolveDataState({ isLoading: true, rows: null, error: null, mode: 'editor' }),
      ).toEqual({ kind: 'loading' });
    });
    it('returns loading in preview mode', () => {
      expect(
        resolveDataState({ isLoading: true, rows: null, error: null, mode: 'preview' }),
      ).toEqual({ kind: 'loading' });
    });
  });

  describe('EMPTY', () => {
    it('returns empty for null rows in editor mode', () => {
      expect(
        resolveDataState({ isLoading: false, rows: null, error: null, mode: 'editor' }),
      ).toEqual({ kind: 'empty' });
    });
    it('returns empty for an empty array in preview mode', () => {
      expect(
        resolveDataState({ isLoading: false, rows: [], error: null, mode: 'preview' }),
      ).toEqual({ kind: 'empty' });
    });
  });

  describe('CONTENT', () => {
    it('returns content for non-empty rows in editor mode', () => {
      expect(
        resolveDataState({ isLoading: false, rows: ROWS, error: null, mode: 'editor' }),
      ).toEqual({ kind: 'content' });
    });
    it('returns content for non-empty rows in preview mode', () => {
      expect(
        resolveDataState({ isLoading: false, rows: ROWS, error: null, mode: 'preview' }),
      ).toEqual({ kind: 'content' });
    });
  });

  describe('ERROR', () => {
    it('carries the real message in editor mode (never swallowed)', () => {
      const result = resolveDataState({
        isLoading: false,
        rows: null,
        error: new Error('collection col_events not found'),
        mode: 'editor',
      });
      expect(result.kind).toBe('error');
      expect(result.message).toBe('collection col_events not found');
    });

    it('carries NO message in preview mode (renderer renders nothing)', () => {
      const result = resolveDataState({
        isLoading: false,
        rows: null,
        error: new Error('network down'),
        mode: 'preview',
      });
      expect(result.kind).toBe('error');
      expect(result.message).toBeUndefined();
    });

    it('never throws for a preview error (safe during SSR / static emit)', () => {
      expect(() =>
        resolveDataState({
          isLoading: false,
          rows: null,
          error: new Error('boom'),
          mode: 'preview',
        }),
      ).not.toThrow();
    });

    it('surfaces an error even while still loading (error is not swallowed by loading)', () => {
      const result = resolveDataState({
        isLoading: true,
        rows: null,
        error: new Error('mid-flight failure'),
        mode: 'editor',
      });
      expect(result.kind).toBe('error');
      expect(result.message).toBe('mid-flight failure');
    });

    it('surfaces an error even when stale rows are present (error wins over content)', () => {
      const result = resolveDataState({
        isLoading: false,
        rows: ROWS,
        error: new Error('refetch failed'),
        mode: 'editor',
      });
      expect(result.kind).toBe('error');
      expect(result.message).toBe('refetch failed');
    });
  });

  it('is pure: the same input yields an equal directive and mutates nothing', () => {
    const input = {
      isLoading: false,
      rows: ROWS,
      error: null,
      mode: 'editor' as const,
    };
    const a = resolveDataState(input);
    const b = resolveDataState(input);
    expect(a).toEqual(b);
    expect(input.rows).toBe(ROWS);
    expect(input.rows.length).toBe(2);
  });
});
