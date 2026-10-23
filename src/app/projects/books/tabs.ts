// src/app/projects/books/tabs.ts
//
// The tabs of the Books area. A plain module (no 'use client'), because the
// server page reads the requested tab from the address and the client
// component shows it: a function from a client module cannot be called on
// the server.

export type BooksTab = 'documents' | 'customers' | 'products' | 'templates';

/** Every tab, in the order the Books area shows them, with its label. */
export const BOOKS_TABS: ReadonlyArray<{ tab: BooksTab; label: string }> = [
  { tab: 'documents', label: 'Documents' },
  { tab: 'customers', label: 'Customers' },
  { tab: 'products', label: 'Products and services' },
  { tab: 'templates', label: 'Templates' },
];

/** The tab a link asks for (the template composer's way back: ?tab=templates), else the documents. */
export function tabFrom(value: string | string[] | undefined): BooksTab {
  return BOOKS_TABS.some((t) => t.tab === value) ? (value as BooksTab) : 'documents';
}
