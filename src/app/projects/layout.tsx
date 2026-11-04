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
// The editor's own sheet first, as when the root layout carried it: the grid
// sheets below override some of its rules by order.
import '../globals.css';
import '@marlinjai/data-table-react/dist/styles/variables.css';
import '@marlinjai/data-table-react/dist/styles/base.css';
import '../cms-grid-theme.css';
// Unsaved work of any project in this tab warns before the page unloads, and a
// project left behind unsaved is named with a way back (plan 2026-11-04-editor-autosave).
import UnsavedWorkGuard from '@/components/UnsavedWorkGuard';

export default function ProjectsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {children}
      {/* Also Cmd/Ctrl+S on the overview: no browser dialog, left-behind projects save at once. */}
      <UnsavedWorkGuard saveShortcut />
    </>
  );
}
