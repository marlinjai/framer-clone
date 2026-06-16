'use client';

// src/components/cms/ContentManagerPanel.tsx
//
// Root of the editor-side content manager: a "Content" panel (NOT a canvas
// component) where a builder defines content types (collections), their custom
// fields, and basic rows. It is the single owner of write state and the inline
// error surface; the child editors (CollectionList / FieldEditor / RowEditor)
// are presentational and emit intents back here.
//
// This panel does NOT touch MST: it talks only to the admin-guarded /api/cms/*
// write routes through the injected CmsClient. Collections are read from the
// SAME /api/cms/collections store the binding picker reads, so a collection
// created here (for example Events) appears wherever bindings are resolved.
//
// Errors surface LOUDLY and inline: every mutation runs through `run()`, which
// catches a CmsClientError and renders its TYPED `code` + `message` in the error
// banner. A failure is never swallowed into a silent no-op that looks like
// success.

import React from 'react';
import type { Collection, ColumnType, Row, RowValue } from '@/lib/bindings/dataSource/types';
import {
  httpCmsClient,
  CmsClientError,
  type CmsClient,
} from './cmsClient';
import CollectionList from './CollectionList';
import FieldEditor from './FieldEditor';
import RowEditor from './RowEditor';

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
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [error, setError] = React.useState<PanelError | null>(null);
  const [busy, setBusy] = React.useState(false);

  const selected =
    collections?.find((c) => c.id === selectedId) ?? null;

  const refreshCollections = React.useCallback(async (): Promise<Collection[]> => {
    const next = await client.listCollections();
    setCollections(next);
    return next;
  }, [client]);

  const refreshRows = React.useCallback(
    async (id: string): Promise<void> => {
      const page = await client.listRows(id);
      setRows(page.rows);
    },
    [client],
  );

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
  // A CmsClientError surfaces its typed code/message in the banner.
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

  const onSelect = React.useCallback(
    (id: string) => {
      setSelectedId(id);
      void run(async () => {
        await refreshRows(id);
      });
    },
    [run, refreshRows],
  );

  const onCreateCollection = (name: string) =>
    void run(async () => {
      const created = await client.createCollection(name);
      await refreshCollections();
      setSelectedId(created.id);
      setRows([]);
    });

  const onRenameCollection = (id: string, name: string) =>
    void run(async () => {
      await client.renameCollection(id, name);
      await refreshCollections();
    });

  const onDeleteCollection = (id: string) =>
    void run(async () => {
      await client.deleteCollection(id);
      const next = await refreshCollections();
      if (selectedId === id) {
        setSelectedId(null);
        setRows([]);
      }
      void next;
    });

  const onAddColumn = (name: string, type: ColumnType) =>
    void run(async () => {
      if (!selectedId) return;
      await client.addColumn(selectedId, { name, type });
      await refreshCollections();
    });

  const onRenameColumn = (colId: string, name: string) =>
    void run(async () => {
      if (!selectedId) return;
      await client.renameColumn(selectedId, colId, name);
      await refreshCollections();
    });

  const onRetypeColumn = (colId: string, type: ColumnType) =>
    void run(async () => {
      if (!selectedId) return;
      await client.retypeColumn(selectedId, colId, type);
      await refreshCollections();
    });

  const onDeleteColumn = (colId: string) =>
    void run(async () => {
      if (!selectedId) return;
      await client.deleteColumn(selectedId, colId);
      await refreshCollections();
    });

  const onCreateRow = (values: Record<string, RowValue>) =>
    void run(async () => {
      if (!selectedId) return;
      await client.createRow(selectedId, values);
      await refreshRows(selectedId);
    });

  const onUpdateRow = (rowId: string, values: Record<string, RowValue>) =>
    void run(async () => {
      if (!selectedId) return;
      await client.updateRow(selectedId, rowId, values);
      await refreshRows(selectedId);
    });

  const onDeleteRow = (rowId: string) =>
    void run(async () => {
      if (!selectedId) return;
      await client.deleteRow(selectedId, rowId);
      await refreshRows(selectedId);
    });

  return (
    <aside aria-label="Content manager" data-testid="cms-panel">
      <header>
        <h2>Content</h2>
      </header>

      {error && (
        <div role="alert" data-testid="cms-error" data-error-code={error.code}>
          <strong>{error.code}</strong>: {error.message}
        </div>
      )}

      {collections === null ? (
        <p data-testid="cms-loading">Loading collections...</p>
      ) : (
        <div>
          <CollectionList
            collections={collections}
            selectedId={selectedId}
            busy={busy}
            onSelect={onSelect}
            onCreate={onCreateCollection}
            onRename={onRenameCollection}
            onDelete={onDeleteCollection}
          />

          {selected && (
            <>
              <FieldEditor
                collection={selected}
                busy={busy}
                onAdd={onAddColumn}
                onRename={onRenameColumn}
                onRetype={onRetypeColumn}
                onDelete={onDeleteColumn}
              />
              <RowEditor
                collection={selected}
                rows={rows}
                busy={busy}
                onCreate={onCreateRow}
                onUpdate={onUpdateRow}
                onDelete={onDeleteRow}
              />
            </>
          )}
        </div>
      )}
    </aside>
  );
};

// Map a thrown value to the inline banner shape, preserving the TYPED code from
// a CmsClientError (the specific-error contract) and falling back to a generic
// code only for non-typed throws.
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
