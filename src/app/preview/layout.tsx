// src/app/preview/layout.tsx
//
// The stylesheets the previewed page's data components need, the same set the
// /projects routes load (src/app/projects/layout.tsx).
import React from 'react';
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
