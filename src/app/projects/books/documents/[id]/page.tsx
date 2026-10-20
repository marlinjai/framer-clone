// src/app/projects/books/documents/[id]/page.tsx
//
// /projects/books/documents/<id>: the document editor (Books plan phase 2).
// Everything it shows is loaded from /api/books/documents/<id>, so a reload is
// the resume path: the editor keeps no state of its own that could disagree
// with the server.

import React from 'react';

import DocumentEditor from '../../DocumentEditor';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentEditor id={id} />;
}
