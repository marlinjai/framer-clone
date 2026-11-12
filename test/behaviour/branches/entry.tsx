// The browser side of the site branch proof (docs/plans/2026-11-10-site-branches.md, slice S4): the real
// EditorApp, with its top bar, keyboard listeners and dialogs, inside the branch provider the editor route puts
// around it. The state is the one the server page would pass, set on `window.__BRANCH_STATE__` before the
// bundle runs; the branch routes are answered by the contract (page.route), exactly as the browser calls them.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import EditorApp from '@/components/EditorApp';
import { useStore as editorStore } from '@/hooks/useStore';
import { SiteBranchProvider } from '@/contexts/SiteBranchContext';
import type { EditorBranchState } from '@/lib/sites/branches';

const probe = window as unknown as { __BRANCH_STATE__?: EditorBranchState | null; __STORED_SITE__?: boolean; __AGENT_ACTIVE__?: string; __NAMES__?: { site: string; page: string } };
const state = probe.__BRANCH_STATE__ ?? null;
const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no #root');
flushSync(() =>
  createRoot(root).render(
    <SiteBranchProvider initial={state}>
      <EditorApp />
    </SiteBranchProvider>,
  ),
);
// The editor opens here on its demo, whose status reads "Demo, not saved" with a "Keep as project" button: far
// wider than "Saved", and a state no branch can be in (a branch is a stored site). A proof that measures the
// top bar asks for the status of a stored site instead.
if (probe.__STORED_SITE__) editorStore().editorUI.consumeDemo();
// An agent at work on the site, as the live stream reports it (docs/plans/2026-11-08-live-agent-canvas.md): its
// call has started and not ended, so the top bar shows the agent chip beside the save status
// (docs/plans/2026-11-12-top-bar-fold.md). The value is the agent's label, long on purpose.
if (probe.__AGENT_ACTIVE__) {
  editorStore().editorUI.livePresence.applyActivity({
    callId: 'call-1',
    agentId: 'agent-1',
    label: probe.__AGENT_ACTIVE__,
    tool: 'apply_batch',
    phase: 'start',
    at: new Date().toISOString(),
  });
}
// The site and page names of the bar seen on production on 2026-11-12, long ones, so a proof can see the page name
// narrow before anything else gives way.
if (probe.__NAMES__) {
  const { editorUI } = editorStore();
  editorUI.currentProject?.updateMetadata({ title: probe.__NAMES__.site });
  editorUI.currentPage?.updateMetadata({ title: probe.__NAMES__.page });
}
