'use client';

// src/components/cms/ContentManagerPanel.tsx
//
// Root of the editor-side content manager. In the left-sidebar "Content" tab it
// renders a COMPACT collection list (create / rename / delete); opening a
// collection mounts the full workspace overlay (CmsWorkspaceOverlay) which shows
// all collections in the rail on the left and the active collection's grid in the
// center.
//
// Two write paths, each for its own concern:
//   - COLLECTION-level CRUD goes through the injected CmsClient -> admin-guarded
//     /api/cms/* routes. This preserves the name-uniqueness + typed-error
//     contract (e.g. `collection_exists`) and keeps the panel reading the SAME
//     /api/cms/collections store the binding picker reads, so a collection made
//     here appears wherever bindings resolve.
//   - IN-collection editing (columns/rows/options/relations/files) happens inside
//     the grid overlay via the data-table server-actions adapter.
//
// This panel does NOT touch MST. Errors surface LOUDLY and inline: every mutation
// runs through `run()`, which renders a CmsClientError's typed `code` + `message`
// in the banner rather than swallowing a failure into a silent no-op.
//
// State: `activeId` is set when the workspace overlay is open. Opening a
// collection from the compact sidebar list (or the workspace rail) sets activeId.
// Switching collections within the rail calls onSetActive which updates activeId
// without closing the workspace.

import React from 'react';
import type { Collection } from '@/lib/bindings/dataSource/types';
import { httpCmsClient, CmsClientError, type CmsClient } from './cmsClient';
import CollectionList from './CollectionList';
import CmsWorkspaceOverlay from './grid/CmsWorkspaceOverlay';

export interface ContentManagerPanelProps {
  /** Injectable for tests; defaults to the live HTTP client. */
  client?: CmsClient;
}

interface PanelError {
  code: string;
  message: string;
}

const ContentManagerPanel: React.FC<ContentManagerPanelProps> = ({
  client = httpCmsClient,
}) => {
  const [collections, setCollections] = React.useState<Collection[] | null>(null);
  // activeId: the collection whose grid is displayed in the workspace. When set
  // the workspace overlay is mounted; null means the overlay is closed.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<PanelError | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refreshCollections = React.useCallback(async (): Promise<Collection[]> => {
    const next = await client.listCollections();
    setCollections(next);
    return next;
  }, [client]);

  // Initial load. A read failure also surfaces in the inline banner.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await client.listCollections();
        if (!cancelled) setCollections(next);
      } catch (err) {
        if (!cancelled) {
          setError(toPanelError(err));
          setCollections([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Run a mutation, clearing any prior error, then refreshing derived state.
  const run = React.useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(toPanelError(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onCreateCollection = (name: string) =>
    void run(async () => {
      const created = await client.createCollection(name);
      await refreshCollections();
      // Open the new collection's workspace right away.
      setActiveId(created.id);
    });

  const onRenameCollection = (id: string, name: string) =>
    void run(async () => {
      await client.renameCollection(id, name);
      await refreshCollections();
    });

  const onUpdateCollection = (id: string, updates: { name?: string; icon?: string }) =>
    void run(async () => {
      await client.updateCollection(id, updates);
      await refreshCollections();
    });

  const onDeleteCollection = (id: string) =>
    void run(async () => {
      await client.deleteCollection(id);
      await refreshCollections();
      if (activeId === id) setActiveId(null);
    });

  // When the workspace closes, refresh so column/row counts edited through the
  // grid's own adapter path are current in the sidebar.
  const onCloseWorkspace = React.useCallback(() => {
    setActiveId(null);
    void refreshCollections().catch((err) => setError(toPanelError(err)));
  }, [refreshCollections]);

  const workspaceVisible = activeId !== null && collections !== null;

  return (
    <aside aria-label="Content manager" data-testid="cms-panel" className="flex flex-col">
      {error && (
        <div
          role="alert"
          data-testid="cms-error"
          data-error-code={error.code}
          className="mx-2 mb-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed text-destructive"
        >
          <span className="font-semibold">{error.code}</span>: {error.message}
        </div>
      )}

      {collections === null ? (
        <div data-testid="cms-loading" className="flex flex-col gap-0.5 px-1 pt-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex h-9 items-center gap-2.5 rounded-md px-2">
              <span className="h-6 w-6 shrink-0 animate-pulse rounded-[7px] bg-muted" />
              <span
                className="h-3 animate-pulse rounded bg-muted"
                style={{ width: `${96 - i * 18}px` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <CollectionList
          collections={collections}
          openId={activeId}
          busy={busy}
          onOpen={setActiveId}
          onCreate={onCreateCollection}
          onRename={onRenameCollection}
          onUpdate={onUpdateCollection}
          onDelete={onDeleteCollection}
        />
      )}

      {workspaceVisible && (
        <CmsWorkspaceOverlay
          collections={collections}
          activeId={activeId}
          busy={busy}
          onSetActive={setActiveId}
          onCreate={onCreateCollection}
          onRename={onRenameCollection}
          onUpdate={onUpdateCollection}
          onDelete={onDeleteCollection}
          onClose={onCloseWorkspace}
        />
      )}
    </aside>
  );
};

// Map a thrown value to the inline banner shape, preserving the TYPED code from
// a CmsClientError and falling back to a generic code only for non-typed throws.
function toPanelError(err: unknown): PanelError {
  if (err instanceof CmsClientError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: 'cms_request_failed',
    message: err instanceof Error ? err.message : 'request failed',
  };
}

export default ContentManagerPanel;
