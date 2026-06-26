// Editor-segment layout for `/projects/*` (MT-15).
//
// Carries the data-table CMS-grid stylesheets for the editor's `/projects`
// surfaces (dashboard + per-project editor, which mount the CMS grid). These
// used to live in the ROOT layout and shipped to every route — including the
// published storefront under `(site)`. The root layout is now neutral; the grid
// CSS lives only on the editor surfaces that actually render the grid (this
// layout + `src/app/page.tsx` for `/`). Classes/vars are `dt-*`-namespaced; the
// `cms-grid-theme.css` overrides pin the engine tokens to the light Studio-iris
// theme. This segment layout adds NO `<html>`/`<body>` (only the root owns those).
import React from 'react';
import '@marlinjai/data-table-react/dist/styles/variables.css';
import '@marlinjai/data-table-react/dist/styles/base.css';
import '../cms-grid-theme.css';

export default function ProjectsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
