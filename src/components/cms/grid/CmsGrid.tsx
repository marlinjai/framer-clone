'use client';

// src/components/cms/grid/CmsGrid.tsx
//
// The full Notion-style CMS editing grid: the same @marlinjai/data-table-react
// `TableView` the receipt-OCR dashboard uses, driven against the CMS store via
// the server-actions adapter. It exposes the FULL 13-type column set (via the
// add-property menu), inline cell editing, select/multi-select option
// management, relations, file columns (loud "storage unconfigured" on upload),
// search, filter, sort, grouping, footer calculations, row selection, keyboard
// navigation, and pagination.
//
// `dbAdapter` is injectable so tests can drive the grid against an in-memory
// adapter; in the app it defaults to the live server-actions adapter. Saved
// views + board/calendar layouts are a follow-on slice (single TableView here),
// so filters/sorts/grouping/footer live in component state for the session.

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  DataTableProvider,
  useTable,
  useDbAdapter,
  TableView,
  RowDetailPanel,
  SearchBar,
  FilterBar,
} from '@marlinjai/data-table-react';
import type {
  CellValue,
  ColumnType,
  DatabaseAdapter,
  FooterConfig,
  GroupConfig,
  Row,
  TextAlignment,
} from '@marlinjai/data-table-core';
import { CMS_WORKSPACE_ID, type CmsStatusField } from '@/lib/cms/constants';
import { ensureStatusField } from '@/server/cms/actions';
import { createCmsServerActionsAdapter } from './cmsServerActionsAdapter';
import { cmsFileAdapter } from './cmsFileAdapter';

const defaultAdapter = createCmsServerActionsAdapter();

export interface CmsGridProps {
  tableId: string;
  /** Injectable for tests; defaults to the live server-actions adapter. */
  dbAdapter?: DatabaseAdapter;
}

function CmsGridContent({
  tableId,
  statusField,
}: {
  tableId: string;
  statusField: CmsStatusField | null;
}) {
  const {
    table,
    columns,
    rows,
    selectOptions,
    updateCell,
    addRow,
    deleteRow,
    addColumn,
    updateColumn,
    createSelectOption,
    updateSelectOption,
    deleteSelectOption,
    uploadFile,
    deleteFile,
    filters,
    sorts,
    setFilters,
    setSorts,
    hasMore,
    loadMore,
    isRowsLoading,
    loadSelectOptions,
  } = useTable({ tableId });
  const adapter = useDbAdapter();

  const [searchResults, setSearchResults] = React.useState<Row[] | null>(null);
  const [selectedRows, setSelectedRows] = React.useState<Set<string>>(new Set());
  const [groupConfig, setGroupConfig] = React.useState<GroupConfig | undefined>(undefined);
  const [footerConfig, setFooterConfig] = React.useState<FooterConfig>({ calculations: {} });
  const [detailRowId, setDetailRowId] = React.useState<string | null>(null);
  const displayRows = searchResults ?? rows;
  // Resolve the open row from live data so detail-panel edits reflect immediately
  // and the panel closes if the row is deleted.
  const detailRow = detailRowId ? rows.find((r) => r.id === detailRowId) ?? null : null;

  // New items default to Draft (the reserved Status field), so freshly added
  // content is never accidentally treated as published.
  const newItem = React.useCallback(() => {
    void addRow(
      statusField ? { cells: { [statusField.columnId]: statusField.options.draft } } : undefined,
    );
  }, [addRow, statusField]);

  // Delete the selected rows on Backspace/Delete, but never while the user is
  // typing in a cell editor (input/textarea/contentEditable).
  const handleDeleteSelected = React.useCallback(() => {
    if (selectedRows.size === 0) return;
    selectedRows.forEach((id) => deleteRow(id));
    setSelectedRows(new Set());
  }, [selectedRows, deleteRow]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedRows.size === 0) return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        handleDeleteSelected();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedRows, handleDeleteSelected]);

  // Eager-load options for every select / multi-select column.
  React.useEffect(() => {
    columns
      .filter((c) => c.type === 'select' || c.type === 'multi_select')
      .forEach((c) => loadSelectOptions(c.id));
  }, [columns, loadSelectOptions]);

  // Relation picker: search target-collection rows by their primary (title)
  // column, and resolve a related row's title. Runs through the same adapter
  // the provider holds, so it works against the live store and test fakes alike.
  const searchRelationRows = React.useCallback(
    async (relTableId: string, query: string): Promise<Row[]> => {
      if (!adapter) return [];
      const [cols, page] = await Promise.all([
        adapter.getColumns(relTableId),
        adapter.getRows(relTableId, { limit: 50 }),
      ]);
      const primary = cols.find((c) => c.isPrimary) ?? cols[0];
      const items = page.items;
      if (!primary) return items.slice(0, 20);
      const q = query.trim().toLowerCase();
      const matched = q
        ? items.filter((r) => String(r.cells[primary.id] ?? '').toLowerCase().includes(q))
        : items;
      return matched.slice(0, 20);
    },
    [adapter],
  );

  const getRelationRowTitle = React.useCallback(
    async (relTableId: string, rowId: string): Promise<string> => {
      if (!adapter) return rowId;
      const [cols, row] = await Promise.all([
        adapter.getColumns(relTableId),
        adapter.getRow(rowId),
      ]);
      const primary = cols.find((c) => c.isPrimary) ?? cols[0];
      if (!row || !primary) return rowId;
      return String(row.cells[primary.id] ?? '') || rowId;
    },
    [adapter],
  );

  if (!table) {
    return (
      <div className="p-8 text-center text-sm text-gray-500" data-testid="cms-grid-loading">
        Loading collection...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="cms-grid">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <SearchBar
          rows={rows}
          columns={columns}
          onSearchResults={(results, term) => setSearchResults(term ? results : null)}
        />
        <FilterBar
          columns={columns}
          filters={filters}
          selectOptions={selectOptions}
          onFiltersChange={setFilters}
        />
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </span>
          <button
            type="button"
            onClick={newItem}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-[13px] font-semibold text-brand-foreground shadow-xs transition-colors hover:bg-brand/90"
          >
            <Plus className="size-4" />
            New item
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <TableView
          columns={columns}
          rows={displayRows}
          selectOptions={selectOptions}
          onCellChange={(rowId, columnId, value: CellValue) => updateCell(rowId, columnId, value)}
          onAddRow={newItem}
          onDeleteRow={deleteRow}
          onRowOpen={(row) => setDetailRowId(row.id)}
          onColumnResize={(columnId, width) => updateColumn(columnId, { width })}
          onColumnAlignmentChange={(columnId, alignment: TextAlignment) =>
            updateColumn(columnId, { alignment })
          }
          onAddProperty={(name, type: ColumnType) => addColumn({ name, type })}
          onCreateSelectOption={createSelectOption}
          onUpdateSelectOption={updateSelectOption}
          onDeleteSelectOption={deleteSelectOption}
          onUploadFile={uploadFile}
          onDeleteFile={deleteFile}
          onSearchRelationRows={searchRelationRows}
          onGetRelationRowTitle={getRelationRowTitle}
          selectedRows={selectedRows}
          onSelectionChange={setSelectedRows}
          sorts={sorts}
          onSortChange={setSorts}
          isLoading={isRowsLoading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          enableKeyboardNav
          groupConfig={groupConfig}
          onGroupConfigChange={setGroupConfig}
          showFooter
          footerConfig={footerConfig}
          onFooterConfigChange={setFooterConfig}
        />
      </div>

      {selectedRows.size > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-4 py-2">
          <span className="text-[13px] font-medium tabular-nums text-brand">
            {selectedRows.size} selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/30 px-3 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="size-4" />
            Delete
          </button>
        </div>
      )}

      {detailRow && (
        <RowDetailPanel
          row={detailRow}
          columns={columns}
          selectOptions={selectOptions}
          isOpen
          onClose={() => setDetailRowId(null)}
          onCellChange={(columnId, value) => updateCell(detailRow.id, columnId, value)}
          onDeleteRow={() => {
            void deleteRow(detailRow.id);
            setDetailRowId(null);
          }}
          onCreateSelectOption={createSelectOption}
          onUpdateSelectOption={updateSelectOption}
          onDeleteSelectOption={deleteSelectOption}
          onUploadFile={(columnId, file) => uploadFile(detailRow.id, columnId, file)}
          onDeleteFile={(columnId, fileId) => deleteFile(detailRow.id, columnId, fileId)}
          onSearchRelationRows={searchRelationRows}
          onGetRelationRowTitle={getRelationRowTitle}
        />
      )}
    </div>
  );
}

export default function CmsGrid({ tableId, dbAdapter = defaultAdapter }: CmsGridProps) {
  // Ensure the reserved Status field exists BEFORE the table loads its columns,
  // so it shows on first open. Failure (e.g. unauthenticated) degrades
  // gracefully: the grid still opens, just without status defaulting.
  const [statusField, setStatusField] = React.useState<CmsStatusField | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setReady(false);
    ensureStatusField(tableId)
      .then((sf) => {
        if (!cancelled) {
          setStatusField(sf);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatusField(null);
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tableId]);

  if (!ready) {
    return (
      <div
        className="p-8 text-center text-sm text-muted-foreground"
        data-testid="cms-grid-preparing"
      >
        Preparing collection...
      </div>
    );
  }

  return (
    <DataTableProvider dbAdapter={dbAdapter} fileAdapter={cmsFileAdapter} workspaceId={CMS_WORKSPACE_ID}>
      <CmsGridContent tableId={tableId} statusField={statusField} />
    </DataTableProvider>
  );
}
