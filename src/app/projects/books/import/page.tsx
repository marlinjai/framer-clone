// src/app/projects/books/import/page.tsx
//
// /projects/books/import: importing past invoices by uploading their PDFs
// (docs/plans/2026-10-20-books-upload-import.md). Authorization is enforced by
// every /api/books/imports call the client makes (the Books guard chain); the
// client renders a refusal as a page.

import React from 'react';

import ImportPanel from '../ImportPanel';

export const dynamic = 'force-dynamic';

export default function BooksImportPage() {
  return <ImportPanel />;
}
