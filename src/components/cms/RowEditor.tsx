'use client';

// src/components/cms/RowEditor.tsx
//
// Basic row create/edit/delete for the selected collection. Presentational: one
// input per field for the add-row form, plus an inline edit/save and delete per
// existing row. Cell values are typed per column: number columns parse to a
// number, boolean to a checkbox, multi-select to a comma-split string[], the
// rest to plain strings. Every mutation delegates to the panel.

import React from 'react';
import type { Collection, Row, RowValue } from '@/lib/bindings/dataSource/types';

export interface RowEditorProps {
  collection: Collection;
  rows: Row[];
  busy: boolean;
  onCreate: (values: Record<string, RowValue>) => void;
  onUpdate: (rowId: string, values: Record<string, RowValue>) => void;
  onDelete: (rowId: string) => void;
}

type ColumnType = Collection['columns'][number]['type'];

// Parse a raw input string into a binding RowValue for the given column type.
function parseCell(type: ColumnType, raw: string): RowValue {
  if (raw === '') return null;
  if (type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'boolean') {
    return raw === 'true';
  }
  if (type === 'multi-select') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return raw;
}

// Render a RowValue back into an editable string.
function displayCell(value: RowValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function buildValues(
  collection: Collection,
  draft: Record<string, string>,
): Record<string, RowValue> {
  const values: Record<string, RowValue> = {};
  for (const column of collection.columns) {
    values[column.id] = parseCell(column.type, draft[column.id] ?? '');
  }
  return values;
}

const RowEditor: React.FC<RowEditorProps> = ({
  collection,
  rows,
  busy,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState<Record<string, string>>({});

  const setDraftCell = (colId: string, raw: string) =>
    setDraft((d) => ({ ...d, [colId]: raw }));
  const setEditCell = (colId: string, raw: string) =>
    setEditDraft((d) => ({ ...d, [colId]: raw }));

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate(buildValues(collection, draft));
    setDraft({});
  };

  const startEdit = (row: Row) => {
    const next: Record<string, string> = {};
    for (const column of collection.columns) {
      next[column.id] = displayCell(row.values[column.id]);
    }
    setEditDraft(next);
    setEditingId(row.id);
  };

  const saveEdit = (rowId: string) => {
    onUpdate(rowId, buildValues(collection, editDraft));
    setEditingId(null);
  };

  return (
    <section aria-label="Rows" data-testid="cms-row-editor">
      <h3>Rows: {collection.name}</h3>

      {rows.length === 0 ? (
        <p data-testid="cms-no-rows">No rows yet</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} data-testid={`cms-row-${row.id}`}>
              {editingId === row.id ? (
                <>
                  {collection.columns.map((column) => (
                    <input
                      key={column.id}
                      aria-label={`Edit ${column.name} of ${row.id}`}
                      value={editDraft[column.id] ?? ''}
                      disabled={busy}
                      onChange={(e) => setEditCell(column.id, e.target.value)}
                    />
                  ))}
                  <button type="button" disabled={busy} onClick={() => saveEdit(row.id)}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span>
                    {collection.columns
                      .map((column) => displayCell(row.values[column.id]))
                      .join(' | ')}
                  </span>
                  <button
                    type="button"
                    aria-label={`Edit ${row.id}`}
                    disabled={busy}
                    onClick={() => startEdit(row)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${row.id}`}
                    disabled={busy}
                    onClick={() => onDelete(row.id)}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {collection.columns.length === 0 ? (
        <p>Add a field before creating rows.</p>
      ) : (
        <form onSubmit={submitCreate} aria-label="Add row">
          {collection.columns.map((column) => (
            <span key={column.id}>
              <label htmlFor={`cms-new-cell-${column.id}`}>{column.name}</label>
              <input
                id={`cms-new-cell-${column.id}`}
                value={draft[column.id] ?? ''}
                disabled={busy}
                onChange={(e) => setDraftCell(column.id, e.target.value)}
              />
            </span>
          ))}
          <button type="submit" disabled={busy}>
            Add row
          </button>
        </form>
      )}
    </section>
  );
};

export default RowEditor;
