'use client';
// BindingPicker: the popover that lets a builder pick what a bindable slot
// resolves to. It shows a scope tree (Page params, plus the LIVE columns of the
// collection bound by a Collection / RecordView / TableView ancestor) and a
// free-form `{{...}}` input that red-borders when the expression fails to parse.
//
// The set of scope sections shown is driven by the slot's `scopeHint`. The
// switch DEFAULTS (the `any` / `default` branch) on UNKNOWN hints so Track C's
// additive commerce scopeHints (`product` / `variant` / `availability`) widen
// the tree instead of breaking the picker.
//
// Committing reuses the EXISTING `node.setBinding(slot, binding)` action; the
// caller passes an `onCommit` that performs that MST write (tagged MST-WRITE at
// the call site, in BindingControl).
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Database, FileText, Globe } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindableSlotMeta, ReadBinding } from '@/lib/bindings/types';
import type { Collection, Column } from '@/lib/bindings/dataSource/types';
import { useDataSource } from '@/lib/bindings/dataSource/context';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { getAvailableScopeFrames } from '@/lib/bindings/scopeIntrospection';

export interface BindingPickerProps {
  node: ComponentInstance;
  slot: string;
  meta: BindableSlotMeta;
  /** Commit a read binding for the slot. The caller performs the MST write. */
  onCommit: (binding: ReadBinding) => void;
  onClose: () => void;
}

interface VisibleSections {
  row: boolean;
  page: boolean;
  collections: boolean;
}

/**
 * Decide which scope sections to show for a slot's scopeHint. UNKNOWN hints
 * fall through to the `default` branch (same as `any`) and get the full tree:
 * this is the contract that keeps Track C commerce scopeHints from breaking the
 * picker.
 */
export function visibleSectionsForHint(hint?: string): VisibleSections {
  switch (hint) {
    case 'row':
      return { row: true, page: false, collections: false };
    case 'collection':
      return { row: false, page: false, collections: true };
    case 'page':
      return { row: false, page: true, collections: false };
    case 'any':
    default:
      return { row: true, page: true, collections: true };
  }
}

const ITEM_CLASS =
  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-gray-700 hover:bg-brand/10';

const BindingPicker = observer(({ node, meta, onCommit, onClose }: BindingPickerProps) => {
  const dataSource = useDataSource();
  const sections = visibleSectionsForHint(meta.scopeHint);

  // Row frame (and its source collectionId) available to this node, derived
  // from the static ancestry. Columns are then resolved LIVE below.
  const frames = getAvailableScopeFrames(node);
  const rowFrame = frames.find((f) => f.kind === 'row');
  const rowCollectionId = rowFrame?.collectionId ?? null;

  // LIVE columns for the row frame's source collection.
  const [rowColumns, setRowColumns] = React.useState<Column[] | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!sections.row || !rowCollectionId) {
      setRowColumns(null);
      setRowError(null);
      return;
    }
    let active = true;
    setRowColumns(null);
    setRowError(null);
    dataSource
      .getCollection(rowCollectionId)
      .then((collection: Collection | null) => {
        if (!active) return;
        if (!collection) {
          setRowError(`collection ${rowCollectionId} not found`);
          setRowColumns([]);
          return;
        }
        setRowColumns(collection.columns);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setRowError(err instanceof Error ? err.message : String(err));
        setRowColumns([]);
      });
    return () => {
      active = false;
    };
  }, [dataSource, rowCollectionId, sections.row]);

  // LIVE collection list for slots that bind a SOURCE collection (e.g. the
  // Collection / TableView `collection` slot, scopeHint `collection`).
  const [collections, setCollections] = React.useState<Collection[] | null>(null);

  React.useEffect(() => {
    if (!sections.collections) {
      setCollections(null);
      return;
    }
    let active = true;
    dataSource
      .listCollections()
      .then((list: Collection[]) => {
        if (active) setCollections(list);
      })
      .catch(() => {
        if (active) setCollections([]);
      });
    return () => {
      active = false;
    };
  }, [dataSource, sections.collections]);

  // Free-form `{{...}}` input. Empty draft is neutral; a non-empty draft that
  // fails parseExpression red-borders and cannot be applied.
  const [draft, setDraft] = React.useState('');
  const trimmed = draft.trim();
  const parsed = trimmed.length > 0 ? parseExpression(trimmed) : null;
  const freeFormInvalid = trimmed.length > 0 && parsed === null;

  const commitRead = (expression: string, scope?: ReadBinding['scope']) => {
    const binding: ReadBinding = scope
      ? { mode: 'read', expression, scope }
      : { mode: 'read', expression };
    onCommit(binding);
    onClose();
  };

  const applyFreeForm = () => {
    if (freeFormInvalid || trimmed.length === 0) return;
    commitRead(trimmed);
  };

  return (
    <div
      className="z-50 w-60 rounded-md border border-gray-200 bg-white p-2 shadow-lg"
      role="dialog"
      aria-label={`Bind ${meta.label}`}
    >
      <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">
        Bind {meta.label}
      </div>

      {/* Page scope */}
      {sections.page && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-medium text-gray-500">
            <Globe size={11} />
            <span>Page</span>
          </div>
          <button
            type="button"
            className={ITEM_CLASS}
            onClick={() => setDraft('{{page.params.}}')}
          >
            params
          </button>
        </div>
      )}

      {/* Row scope (columns of the ancestor collection) */}
      {sections.row && rowCollectionId && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-medium text-gray-500">
            <FileText size={11} />
            <span>Row ({rowCollectionId})</span>
          </div>
          {rowColumns === null && !rowError && (
            <div className="px-2 py-1 text-[11px] text-gray-400">Loading columns...</div>
          )}
          {rowError && (
            <div className="px-2 py-1 text-[11px] text-red-500">{rowError}</div>
          )}
          {rowColumns &&
            rowColumns.map((col) => {
              const expression = `{{row.${col.id}}}`;
              return (
                <button
                  key={col.id}
                  type="button"
                  className={ITEM_CLASS}
                  onClick={() => commitRead(expression)}
                >
                  <span className="flex-1">{col.name}</span>
                  <span className="font-mono text-[10px] text-gray-400">{expression}</span>
                </button>
              );
            })}
          {rowColumns && rowColumns.length === 0 && !rowError && (
            <div className="px-2 py-1 text-[11px] text-gray-400">No columns</div>
          )}
        </div>
      )}

      {/* Source-collection picker (binds a collectionId literal) */}
      {sections.collections && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-medium text-gray-500">
            <Database size={11} />
            <span>Collections</span>
          </div>
          {collections === null && (
            <div className="px-2 py-1 text-[11px] text-gray-400">Loading...</div>
          )}
          {collections &&
            collections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                className={ITEM_CLASS}
                onClick={() => commitRead(collection.id)}
              >
                <span className="flex-1">{collection.name}</span>
                <span className="font-mono text-[10px] text-gray-400">{collection.id}</span>
              </button>
            ))}
          {collections && collections.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-gray-400">No collections</div>
          )}
        </div>
      )}

      {/* Free-form expression */}
      <div className="mt-2 border-t border-gray-100 pt-2">
        <label className="mb-1 block px-1 text-[11px] text-gray-500">Expression</label>
        <div className="flex items-center gap-1">
          <input
            type="text"
            aria-label="Binding expression"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFreeForm();
            }}
            placeholder="{{row.title}}"
            className={`h-7 flex-1 rounded border px-2 font-mono text-xs outline-none ${
              freeFormInvalid
                ? 'border-red-500 focus:border-red-500'
                : 'border-gray-200 focus:border-brand'
            }`}
          />
          <button
            type="button"
            onClick={applyFreeForm}
            disabled={freeFormInvalid || trimmed.length === 0}
            className="h-7 rounded bg-brand px-2 text-xs text-white disabled:opacity-40"
          >
            Apply
          </button>
        </div>
        {freeFormInvalid && (
          <div className="mt-1 px-1 text-[11px] text-red-500">
            Invalid expression: use a single {'{{path.to.value}}'} template.
          </div>
        )}
      </div>
    </div>
  );
});

BindingPicker.displayName = 'BindingPicker';

export default BindingPicker;
