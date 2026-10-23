// src/app/projects/books/templates/[id]/page.tsx
//
// /projects/books/templates/<id>: the visual template composer (visual
// template composer plan, phase 4). Everything it shows is loaded from
// /api/books/templates/<id>, and every write goes through the Books API with
// its guard (`editBooks`); unsaved edits live only in this browser.

import React from 'react';

import TemplateComposer from '../../composer/TemplateComposer';

export const dynamic = 'force-dynamic';

export default async function TemplateComposerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplateComposer id={id} />;
}
