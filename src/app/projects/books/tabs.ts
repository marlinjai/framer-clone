// src/app/projects/books/tabs.ts
//
// The tabs of the Books area. A plain module (no 'use client'), because the
// server page reads the requested tab from the address and the client
// component shows it: a function from a client module cannot be called on
// the server.

export type BooksTab = 'documents' | 'customers' | 'templates';

/** The tab a link asks for (the template composer's way back: ?tab=templates), else the documents. */
export function tabFrom(value: string | string[] | undefined): BooksTab {
  return value === 'customers' || value === 'templates' ? value : 'documents';
}
