'use client';

// src/app/projects/books/useCursorList.ts
//
// A cursor-paged Books list on the page: the first page on load (and again
// whenever `key`, the filters, changes), then one more page per "Load more",
// appended. A page that fails to load keeps every row already shown and says
// so, with the next "Load more" trying again. Answers that arrive after the
// filters changed are dropped, so a slow old page never mixes into a new list.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ListPage } from '@/lib/books/api';

export interface CursorList<T> {
  /** null until the first page arrived. */
  items: T[] | null;
  /** How many rows the filters match in all (0 until the first page arrived). */
  total: number;
  /** Whether a further page exists. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last "Load more" failed (the rows shown stay). */
  moreError: string | null;
  loadMore: () => Promise<void>;
  /** Load the first page again (after a change), replacing the rows. */
  reload: () => Promise<void>;
}

export function useCursorList<T>(
  key: string,
  fetchPage: (cursor: string | null) => Promise<ListPage<T>>,
  opts: { onFirstPageError: (err: unknown) => void; errorText: (err: unknown) => string },
): CursorList<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Every load is numbered; an answer for an older number (other filters) is dropped.
  const generation = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setMoreError(null);
    // A "Load more" of the old list may still be running: it no longer counts.
    setLoadingMore(false);
    try {
      const page = await fetchRef.current(null);
      if (mine !== generation.current) return;
      setItems(page.items);
      setTotal(page.total ?? page.items.length);
      setNextCursor(page.nextCursor ?? null);
    } catch (err) {
      if (mine !== generation.current) return;
      optsRef.current.onFirstPageError(err);
    }
  }, []);

  useEffect(() => {
    setItems(null);
    void reload();
  }, [key, reload]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchRef.current(nextCursor);
      if (mine !== generation.current) return;
      setItems((cur) => [...(cur ?? []), ...page.items]);
      if (page.total !== undefined) setTotal(page.total);
      setNextCursor(page.nextCursor ?? null);
    } catch (err) {
      if (mine === generation.current) setMoreError(optsRef.current.errorText(err));
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  return { items, total, hasMore: nextCursor !== null, loadingMore, moreError, loadMore, reload };
}
