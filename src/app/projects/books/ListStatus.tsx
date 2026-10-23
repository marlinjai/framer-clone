'use client';

// src/app/projects/books/ListStatus.tsx
//
// What stands around a cursor-paged Books list (documents, customers, the
// product and service list): the first page's loading or failure with a retry,
// and below the rows the count, "Load more" and the failure of a later page or
// of a refresh. Moved out of BooksHome so every tab shows its list the same way.

import React from 'react';

import { Button } from '@/components/ui/button';

import type { CursorList } from './useCursorList';

/** Where a list's first page goes: loading, or why it failed with a retry. */
export function FirstPage<T>({ list, noun }: { list: CursorList<T>; noun: string }) {
  if (list.firstError === null) return <p className="text-sm text-muted-foreground">Loading {noun}…</p>;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive px-4 py-3 text-sm">
      <span>
        The {noun} could not be loaded: {list.firstError}
      </span>
      <Button size="sm" variant="outline" onClick={() => void list.reload()}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Below a paged list: one status line that is always there (so screen readers
 * announce its changes): how many rows are shown of how many, or why none
 * are; "Load more" while there are more. A page that failed says so; the rows
 * shown stay, and "Load more" tries again. A refresh that failed says so with a
 * retry. The button never loses the focus while it waits (aria-disabled, not
 * disabled); when the last page arrives and the button goes, the focus moves
 * to the status line.
 */
export function MoreRows<T>({ list, noun, emptyText }: { list: CursorList<T>; noun: [string, string]; emptyText: string }) {
  const count = list.items?.length ?? 0;
  const text =
    list.items === null ? '' : count === 0 ? emptyText : `Showing ${count} of ${list.total} ${list.total === 1 ? noun[0] : noun[1]}`;
  const status = React.useRef<HTMLParagraphElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const hadFocus = React.useRef(false);
  React.useEffect(() => {
    // The button was focused and is gone (the last page arrived): keep the user's place.
    if (!list.hasMore && hadFocus.current) {
      hadFocus.current = false;
      status.current?.focus();
    }
  }, [list.hasMore]);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p ref={status} role="status" tabIndex={-1} className="text-muted-foreground outline-none">
        {text}
      </p>
      {list.hasMore && count > 0 ? (
        <Button
          ref={button}
          variant="outline"
          size="sm"
          aria-disabled={list.loadingMore}
          onFocus={() => (hadFocus.current = true)}
          onBlur={() => (hadFocus.current = false)}
          onClick={() => {
            if (!list.loadingMore) void list.loadMore();
          }}
        >
          {list.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
      {list.moreError ? (
        <p role="alert" className="w-full text-destructive">
          The next {noun[1]} could not be loaded: {list.moreError} Your list is kept; use Load more to try again.
        </p>
      ) : null}
      {list.refreshError ? (
        <div role="alert" className="flex w-full flex-wrap items-center gap-3 text-destructive">
          <span>
            The {noun[1]} could not be refreshed: {list.refreshError} The list may be out of date.
          </span>
          <Button size="sm" variant="outline" onClick={() => void list.reload({ keepShown: true })}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
