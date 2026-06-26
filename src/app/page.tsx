'use client'
// Server component: loads editor purely on client (no SSR for editor UI)
//
// CMS-grid stylesheets (MT-15): relocated here from the ROOT layout so the
// data-table-react CSS ships ONLY on editor surfaces (the `/` editor and
// `/projects/*`, see `projects/layout.tsx`) — NOT to every published storefront
// under `(site)`. Classes/vars are `dt-*`-namespaced. Order matters: the engine
// stylesheets first, then `cms-grid-theme.css` pins the --dt-* tokens to the
// light Studio-iris theme (the `.light` class on <html> opts out of the engine's
// dark-glass auto-switch; the theme file re-pins as belt-and-suspenders).
import '@marlinjai/data-table-react/dist/styles/variables.css';
import '@marlinjai/data-table-react/dist/styles/base.css';
import './cms-grid-theme.css';
import dynamic from 'next/dynamic';

const EditorApp = dynamic(() => import('../components/EditorApp'), { ssr: false });

export default function Page() {
  return <EditorApp />;
}