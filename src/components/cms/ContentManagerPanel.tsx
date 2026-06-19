'use client';

// src/components/cms/ContentManagerPanel.tsx
//
// Root of the editor-side content manager. In the left-sidebar "Content" tab it
// renders a COMPACT collection list (create / rename / delete); opening a
// collection mounts the full Notion-style editing grid in a full-screen overlay
// (CmsGridOverlay) over the canvas.
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

import React from 'react';
import type { Collection } from '@/lib/bindings/dataSource/types';
import { httpCmsClient, CmsClientError, type CmsClient } from './cmsClient';
import CollectionList from './CollectionList';
import CmsGridOverlay from './grid/CmsGridOverlay';

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
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<PanelError | null>(null);
  const [busy, setBusy] = React.useState(false);

  const openCollection = collections?.find((c) => c.id === openId) ?? null;

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
      // Open the new collection's grid right away so the builder lands in the
      // editing surface instead of an empty list row.
      setOpenId(created.id);
    });

  const onRenameCollection = (id: string, name: string) =>
    void run(async () => {
      await client.renameCollection(id, name);
      await refreshCollections();
    });

  const onDeleteCollection = (id: string) =>
    void run(async () => {
      await client.deleteCollection(id);
      await refreshCollections();
      if (openId === id) setOpenId(null);
    });

  // When the overlay closes, refresh the list so column/row counts edited through
  // the grid's own adapter path are current in the sidebar.
  const onCloseOverlay = React.useCallback(() => {
    setOpenId(null);
    void refreshCollections().catch((err) => setError(toPanelError(err)));
  }, [refreshCollections]);

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
          openId={openId}
          busy={busy}
          onOpen={setOpenId}
          onCreate={onCreateCollection}
          onRename={onRenameCollection}
          onDelete={onDeleteCollection}
        />
      )}

      {openCollection && (
        <CmsGridOverlay
          tableId={openCollection.id}
          collectionName={openCollection.name}
          onClose={onCloseOverlay}
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
