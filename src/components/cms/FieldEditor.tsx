'use client';

// src/components/cms/FieldEditor.tsx
//
// Custom-field (column) CRUD for the selected collection. Presentational: it
// renders each field with a type <select> over the binding-layer ColumnType
// union (add/rename/retype/delete), delegating every mutation to the panel. The
// type options are exactly the eight binding types, so retype stays within the
// union the binding picker understands.

import React from 'react';
import type { Collection, ColumnType } from '@/lib/bindings/dataSource/types';

/** The eight binding-layer column types, in picker order. */
export const COLUMN_TYPES: ColumnType[] = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi-select',
  'relation',
  'file',
];

export interface FieldEditorProps {
  collection: Collection;
  busy: boolean;
  onAdd: (name: string, type: ColumnType) => void;
  onRename: (colId: string, name: string) => void;
  onRetype: (colId: string, type: ColumnType) => void;
  onDelete: (colId: string) => void;
}

const FieldEditor: React.FC<FieldEditorProps> = ({
  collection,
  busy,
  onAdd,
  onRename,
  onRetype,
  onDelete,
}) => {
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<ColumnType>('text');

  const submitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onAdd(trimmed, type);
    setName('');
    setType('text');
  };

  return (
    <section aria-label="Fields" data-testid="cms-field-editor">
      <h3>Fields: {collection.name}</h3>

      {collection.columns.length === 0 ? (
        <p data-testid="cms-no-fields">No fields yet</p>
      ) : (
        <ul>
          {collection.columns.map((column) => (
            <li key={column.id} data-testid={`cms-field-${column.id}`}>
              <span>{column.name}</span>
              <select
                aria-label={`Type of ${column.name}`}
                value={column.type}
                disabled={busy}
                onChange={(e) => onRetype(column.id, e.target.value as ColumnType)}
              >
                {COLUMN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Rename ${column.name}`}
                disabled={busy}
                onClick={() => {
                  const next = window.prompt('Rename field', column.name);
                  if (next && next.trim().length > 0) onRename(column.id, next.trim());
                }}
              >
                Rename
              </button>
              <button
                type="button"
                aria-label={`Delete ${column.name}`}
                disabled={busy}
                onClick={() => onDelete(column.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submitAdd}>
        <label htmlFor="cms-new-field-name">New field name</label>
        <input
          id="cms-new-field-name"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          placeholder="title"
        />
        <label htmlFor="cms-new-field-type">New field type</label>
        <select
          id="cms-new-field-type"
          value={type}
          disabled={busy}
          onChange={(e) => setType(e.target.value as ColumnType)}
        >
          {COLUMN_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || name.trim().length === 0}>
          Add field
        </button>
      </form>
    </section>
  );
};

export default FieldEditor;
