// src/components/cms/grid/cmsServerActionsAdapter.ts
//
// A `DatabaseAdapter` whose every method delegates to a CMS server action. Safe
// to import from a client component: it contains NO Prisma import (the action
// bodies are stripped from the client bundle and replaced with RPC stubs). This
// is the client-side half of the receipt-OCR server-actions-adapter pattern.
//
// The guarded (mutating) actions return a CmsActionResult instead of throwing
// an expected auth failure (production Next.js would reduce a thrown message to
// a digest). This adapter unwraps the result: a failure is rethrown HERE, on the
// client, as a CmsActionError whose readable message and code survive, so the
// grid can show it. Read actions are wired straight through.
//
// `transaction` is the one method with no server action: the adapter runs it
// locally as `fn(this)` (the CMS PrismaAdapter's transaction is itself a no-op
// that just invokes `fn`, so single statements stay atomic on their own).

import type { DatabaseAdapter } from '@marlinjai/data-table-core';
import * as actions from '@/server/cms/actions';
import { unwrapCmsActionResult as unwrap } from '@/lib/cms/actionResult';

export function createCmsServerActionsAdapter(): DatabaseAdapter {
  return {
    // Tables
    createTable: async (input) => unwrap(await actions.createTable(input)),
    getTable: actions.getTable,
    updateTable: async (id, updates) => unwrap(await actions.updateTable(id, updates)),
    deleteTable: async (id) => unwrap(await actions.deleteTable(id)),
    listTables: actions.listTables,

    // Columns
    createColumn: async (input) => unwrap(await actions.createColumn(input)),
    getColumns: actions.getColumns,
    getColumn: actions.getColumn,
    updateColumn: async (id, updates) => unwrap(await actions.updateColumn(id, updates)),
    deleteColumn: async (id) => unwrap(await actions.deleteColumn(id)),
    reorderColumns: async (tableId, ids) => unwrap(await actions.reorderColumns(tableId, ids)),

    // Select options
    createSelectOption: async (input) => unwrap(await actions.createSelectOption(input)),
    getSelectOptions: actions.getSelectOptions,
    updateSelectOption: async (id, updates) =>
      unwrap(await actions.updateSelectOption(id, updates)),
    deleteSelectOption: async (id) => unwrap(await actions.deleteSelectOption(id)),
    reorderSelectOptions: async (columnId, ids) =>
      unwrap(await actions.reorderSelectOptions(columnId, ids)),

    // Rows
    createRow: async (input) => unwrap(await actions.createRow(input)),
    getRow: actions.getRow,
    getRows: actions.getRows,
    updateRow: async (id, cells) => unwrap(await actions.updateRow(id, cells)),
    deleteRow: async (id) => unwrap(await actions.deleteRow(id)),
    archiveRow: async (id) => unwrap(await actions.archiveRow(id)),
    unarchiveRow: async (id) => unwrap(await actions.unarchiveRow(id)),
    bulkCreateRows: async (inputs) => unwrap(await actions.bulkCreateRows(inputs)),
    bulkDeleteRows: async (ids) => unwrap(await actions.bulkDeleteRows(ids)),
    bulkArchiveRows: async (ids) => unwrap(await actions.bulkArchiveRows(ids)),

    // Relations
    createRelation: async (input) => unwrap(await actions.createRelation(input)),
    deleteRelation: async (sourceRowId, columnId, targetRowId) =>
      unwrap(await actions.deleteRelation(sourceRowId, columnId, targetRowId)),
    getRelatedRows: actions.getRelatedRows,
    getRelationsForRow: actions.getRelationsForRow,

    // File references
    addFileReference: async (input) => unwrap(await actions.addFileReference(input)),
    removeFileReference: async (id) => unwrap(await actions.removeFileReference(id)),
    getFileReferences: actions.getFileReferences,
    reorderFileReferences: async (rowId, columnId, ids) =>
      unwrap(await actions.reorderFileReferences(rowId, columnId, ids)),

    // Views
    createView: async (input) => unwrap(await actions.createView(input)),
    getViews: actions.getViews,
    getView: actions.getView,
    updateView: async (id, updates) => unwrap(await actions.updateView(id, updates)),
    deleteView: async (id) => unwrap(await actions.deleteView(id)),
    reorderViews: async (tableId, ids) => unwrap(await actions.reorderViews(tableId, ids)),

    // Transaction: server actions are stateless, so run sequentially against
    // `this`. Each call still hits its own server action.
    async transaction(fn) {
      return fn(this as DatabaseAdapter);
    },
  };
}
