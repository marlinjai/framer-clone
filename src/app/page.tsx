// src/app/page.tsx: the home of the editor host (app.lumitra.co/).
//
// docs/plans/2026-11-23-sites-home-and-light-mode.md, section 2:
//   - the demo editor when the address asks for it (`?demo=1`, or the demo's
//     own `?page=` and `?preview=1`, src/lib/projects/demoAddress.ts),
//   - a signed-in visitor goes on to the projects (`/projects`, which keeps the
//     company chooser and every other state of the dashboard),
//   - everyone else gets the welcome page, never the login: the demo is one
//     click away and needs no account. An auth-brain outage counts as signed
//     out, with a note.
// A published site's `/` is rewritten into `(site)` by src/middleware.ts, so
// this route is only ever the editor host.
//
// CMS-grid stylesheets (MT-15) ship only on editor surfaces (here and
// `/projects/*`); the editor's own sheet comes first, then the engine sheets,
// then `cms-grid-theme.css`, which pins the --dt-* tokens.
import './globals.css';
import '@marlinjai/data-table-react/dist/styles/variables.css';
import '@marlinjai/data-table-react/dist/styles/base.css';
import './cms-grid-theme.css';
import React from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { wantsDemo } from '@/lib/projects/demoAddress';
import { loadHomeEntry } from './projects/loader';
import DemoEditor from './DemoEditor';
import Welcome from './Welcome';

export const dynamic = 'force-dynamic';

type Query = Record<string, string | string[] | undefined>;

export async function generateMetadata({ searchParams }: { searchParams: Promise<Query> }): Promise<Metadata> {
  return { title: wantsDemo(await searchParams) ? 'Demo editor | Lumitra Sites' : 'Lumitra Sites' };
}

export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  if (wantsDemo(await searchParams)) return <DemoEditor />;
  const entry = await loadHomeEntry();
  if (entry.status === 'signed_in') redirect('/projects');
  return <Welcome signInHref={entry.loginUrl} authUnavailable={entry.status === 'auth_unavailable'} />;
}
// ci-replay touch
