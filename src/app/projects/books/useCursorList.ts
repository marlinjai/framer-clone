'use client';

// src/app/projects/books/useCursorList.ts
//
// A cursor-paged Books list on the page: the first page on load (and again
// whenever `key`, the filters, changes), then one more page per "Load more",
// appended. A first page that fails says so where the list would be, with a
// retry; a later page that fails keeps every row already shown and says so,
// the next "Load more" trying again. Answers that arrive after the filters
// changed or the list was reloaded are dropped, so an old page never mixes
// into a new list. A reload after a change (an archived customer) can keep as
// many rows as were shown, page by page, so the user keeps their place.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ListPage } from '@/lib/books/api';

export interface CursorList<T> {
  /** null until the first page arrived (or while it is being loaded again). */
  items: T[] | null;
  /** How many rows the filters match in all. */
  total: number;
  /** Whether a further page exists. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the first page failed (no rows yet); `reload` tries again. */
  firstError: string | null;
  /** Why the last "Load more" failed (the rows shown stay). */
  moreError: string | null;
  loadMore: () => Promise<void>;
  /** Load the list again; `keepShown` reloads as many rows as were shown. */
  reload: (opts?: { keepShown?: boolean }) => Promise<void>;
}

/** Bound on the pages one reload fetches to keep the rows shown. */
const MAX_RELOAD_PAGES = 20;

export function useCursorList<T>(
  key: string,
  fetchPage: (cursor: string | null) => Promise<ListPage<T>>,
  opts: { onFirstPageError: (err: unknown) => void; errorText: (err: unknown) => string },
): CursorList<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [firstError, setFirstError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Every load is numbered; an answer for an older number is dropped.
  const generation = useRef(0);
  // One "Load more" at a time, whatever the render: two quick clicks never fetch the same cursor twice.
  const inFlight = useRef(false);
  const shown = useRef(0);
  shown.current = items?.length ?? 0;
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const reload = useCallback(async (reloadOpts: { keepShown?: boolean } = {}) => {
    const mine = ++generation.current;
    const want = reloadOpts.keepShown ? shown.current : 0;
    // The old cursor belongs to the old list: no "Load more" on it from now on.
    setNextCursor(null);
    setMoreError(null);
    setFirstError(null);
    setLoadingMore(false);
    inFlight.current = false;
    try {
      let page = await fetchRef.current(null);
      const rows = [...page.items];
      for (let i = 1; rows.length < want && page.nextCursor && i < MAX_RELOAD_PAGES; i += 1) {
        page = await fetchRef.current(page.nextCursor);
        if (mine !== generation.current) return;
        rows.push(...page.items);
      }
      if (mine !== generation.current) return;
      setItems(rows);
      setTotal(page.total ?? rows.length);
      setNextCursor(page.nextCursor ?? null);
    } catch (err) {
      if (mine !== generation.current) return;
      setFirstError(optsRef.current.errorText(err));
      optsRef.current.onFirstPageError(err);
    }
  }, []);

  useEffect(() => {
    setItems(null);
    void reload();
  }, [key, reload]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || inFlight.current) return;
    inFlight.current = true;
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
      if (mine === generation.current) {
        inFlight.current = false;
        setLoadingMore(false);
      }
    }
  }, [nextCursor]);

  return { items, total, hasMore: nextCursor !== null, loadingMore, firstError, moreError, loadMore, reload };
}
