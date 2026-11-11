'use client';

// src/contexts/SiteBranchContext.tsx
//
// Which branch of a site the editor has open (docs/plans/2026-11-10-site-branches.md, slice S4): main, or a
// branch with its record. Seeded by the editor route from the server; refreshed when the tab comes back into
// view and once a minute, so "Main has changed" appears without a reload (main's writes are announced on main's
// live stream, not the branch's). Null outside a provider and while branches are off for the company: then the
// editor shows nothing of branches at all.

import React from 'react';
import type { EditorBranchState } from '@/lib/sites/branches';
import { branchClient } from '@/lib/sites/branchClient';

export const BRANCH_REFRESH_MS = 60_000;

interface SiteBranchValue {
  state: EditorBranchState | null;
  /** Read the branch's record again (after an update, a rename, the ready state). */
  refresh: () => Promise<void>;
  setState: (next: EditorBranchState) => void;
}

const SiteBranchContext = React.createContext<SiteBranchValue>({ state: null, refresh: async () => {}, setState: () => {} });

export function SiteBranchProvider({ initial, children }: { initial: EditorBranchState | null; children: React.ReactNode }) {
  const [state, setState] = React.useState<EditorBranchState | null>(initial);
  const current = React.useRef(state);
  current.current = state;

  const refresh = React.useCallback(async () => {
    const now = current.current;
    if (!now || now.kind !== 'branch') return;
    try {
      const { branch } = await branchClient.get(now.mainSiteId, now.siteId);
      if (current.current?.kind === 'branch' && current.current.siteId === now.siteId) setState({ ...now, branch });
    } catch {
      // A failed refresh changes nothing shown; a closed branch is told by its next save (410) and its page.
    }
  }, []);

  React.useEffect(() => {
    if (initial?.kind !== 'branch') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, BRANCH_REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [initial?.kind, refresh]);

  const value = React.useMemo(() => ({ state, refresh, setState }), [state, refresh]);
  return <SiteBranchContext.Provider value={value}>{children}</SiteBranchContext.Provider>;
}

export function useSiteBranch(): SiteBranchValue {
  return React.useContext(SiteBranchContext);
}
