'use client';

// src/components/cms/CollectionList.tsx
//
// Collection CRUD column of the content manager. Presentational: it renders the
// list, the create affordance (including the empty-state "Create your first
// collection" prompt), and per-collection rename/delete, delegating every
// mutation to the panel via callbacks. It holds only transient form state.

import React from 'react';
import type { Collection } from '@/lib/bindings/dataSource/types';

export interface CollectionListProps {
  collections: Collection[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

const CollectionList: React.FC<CollectionListProps> = ({
  collections,
  selectedId,
  busy,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) => {
  const [newName, setNewName] = React.useState('');
  const empty = collections.length === 0;

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (name.length === 0) return;
    onCreate(name);
    setNewName('');
  };

  return (
    <section aria-label="Collections" data-testid="cms-collection-list">
      <h3>Collections</h3>

      {empty ? (
        <p data-testid="cms-empty-state">Create your first collection</p>
      ) : (
        <ul>
          {collections.map((c) => (
            <li key={c.id} data-testid={`cms-collection-${c.id}`}>
              <button
                type="button"
                aria-pressed={c.id === selectedId}
                onClick={() => onSelect(c.id)}
              >
                {c.name}
              </button>
              <button
                type="button"
                aria-label={`Rename ${c.name}`}
                disabled={busy}
                onClick={() => {
                  const next = window.prompt('Rename collection', c.name);
                  if (next && next.trim().length > 0) onRename(c.id, next.trim());
                }}
              >
                Rename
              </button>
              <button
                type="button"
                aria-label={`Delete ${c.name}`}
                disabled={busy}
                onClick={() => onDelete(c.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submitCreate}>
        <label htmlFor="cms-new-collection">New collection name</label>
        <input
          id="cms-new-collection"
          value={newName}
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Events"
        />
        <button type="submit" disabled={busy || newName.trim().length === 0}>
          Create collection
        </button>
      </form>
    </section>
  );
};

export default CollectionList;
