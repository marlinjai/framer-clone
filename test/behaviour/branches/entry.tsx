// The browser side of the site branch proof (docs/plans/2026-11-10-site-branches.md, slice S4): the real
// EditorApp, with its top bar, keyboard listeners and dialogs, inside the branch provider the editor route puts
// around it. The state is the one the server page would pass, set on `window.__BRANCH_STATE__` before the
// bundle runs; the branch routes are answered by the contract (page.route), exactly as the browser calls them.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import EditorApp from '@/components/EditorApp';
import { SiteBranchProvider } from '@/contexts/SiteBranchContext';
import type { EditorBranchState } from '@/lib/sites/branches';

const state = (window as unknown as { __BRANCH_STATE__?: EditorBranchState | null }).__BRANCH_STATE__ ?? null;
const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no #root');
flushSync(() =>
  createRoot(root).render(
    <SiteBranchProvider initial={state}>
      <EditorApp />
    </SiteBranchProvider>,
  ),
);
