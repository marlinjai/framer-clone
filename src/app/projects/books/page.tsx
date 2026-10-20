// src/app/projects/books/page.tsx
//
// /projects/books: the Books area of the editor (invoicing for the active
// company). The edge middleware already requires a session cookie for every
// /projects path; the authorization (active company, the `books` grant, the
// admin role) is enforced by every /api/books call the client makes, and the
// client renders the server's refusal as a page (BooksHome).

import React from 'react';

import BooksHome from './BooksHome';

export const dynamic = 'force-dynamic';

export default function BooksPage() {
  return <BooksHome />;
}
