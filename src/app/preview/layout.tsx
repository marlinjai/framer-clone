// src/app/preview/layout.tsx
//
// The stylesheets of the editor's preview: the editor's own sheet, which the preview
// has always rendered under, and the ones the previewed page's data components need,
// the same set the /projects routes load (src/app/projects/layout.tsx).
import React from 'react';
import '../globals.css';
import '@marlinjai/data-table-react/dist/styles/variables.css';
import '@marlinjai/data-table-react/dist/styles/base.css';
import '../cms-grid-theme.css';

export default function PreviewLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
