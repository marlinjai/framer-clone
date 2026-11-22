'use client'
// Server component: loads editor purely on client (no SSR for editor UI)
//
// CMS-grid stylesheets (MT-15): relocated here from the ROOT layout so the
// data-table-react CSS ships ONLY on editor surfaces (the `/` editor and
// `/projects/*`, see `projects/layout.tsx`) — NOT to every published storefront
// under `(site)`. Classes/vars are `dt-*`-namespaced. Order matters: the engine
// stylesheets first, then `cms-grid-theme.css` pins the --dt-* tokens to the
// dark suite palette (the `.light` class on <html> opts out of the engine's
// own OS-theme switch; the theme file pins its values unconditionally).
// The editor's own sheet comes first, as when the root layout carried it (a
// published site's `/` is rewritten into `(site)` by src/middleware.ts, so this
// route is only ever the editor).
import './globals.css';
import '@marlinjai/data-table-react/dist/styles/variables.css';
import '@marlinjai/data-table-react/dist/styles/base.css';
import './cms-grid-theme.css';
import dynamic from 'next/dynamic';

const EditorApp = dynamic(() => import('../components/EditorApp'), { ssr: false });
// The demo itself never autosaves; projects of this tab opened before still warn.
const UnsavedWorkGuard = dynamic(() => import('../components/UnsavedWorkGuard'), { ssr: false });

export default function Page() {
  return (
    <>
      <EditorApp />
      <UnsavedWorkGuard />
    </>
  );
}