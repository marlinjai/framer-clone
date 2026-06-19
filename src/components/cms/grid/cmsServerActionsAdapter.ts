// src/components/cms/grid/cmsServerActionsAdapter.ts
//
// A `DatabaseAdapter` whose every method delegates to a CMS server action. Safe
// to import from a client component: it contains NO Prisma import (the action
// bodies are stripped from the client bundle and replaced with RPC stubs). This
// is the client-side half of the receipt-OCR server-actions-adapter pattern.
//
// `transaction` is the one method with no server action: the adapter runs it
// locally as `fn(this)` (the CMS PrismaAdapter's transaction is itself a no-op
// that just invokes `fn`, so single statements stay atomic on their own).

import type { DatabaseAdapter } from '@marlinjai/data-table-core';
import * as actions from '@/server/cms/actions';

export function createCmsServerActionsAdapter(): DatabaseAdapter {
  return {
    // Tables
    createTable: actions.createTable,
    getTable: actions.getTable,
    updateTable: actions.updateTable,
    deleteTable: actions.deleteTable,
    listTables: actions.listTables,

    // Columns
    createColumn: actions.createColumn,
    getColumns: actions.getColumns,
    getColumn: actions.getColumn,
    updateColumn: actions.updateColumn,
    deleteColumn: actions.deleteColumn,
    reorderColumns: actions.reorderColumns,

    // Select options
    createSelectOption: actions.createSelectOption,
    getSelectOptions: actions.getSelectOptions,
    updateSelectOption: actions.updateSelectOption,
    deleteSelectOption: actions.deleteSelectOption,
    reorderSelectOptions: actions.reorderSelectOptions,

    // Rows
    createRow: actions.createRow,
    getRow: actions.getRow,
    getRows: actions.getRows,
    updateRow: actions.updateRow,
    deleteRow: actions.deleteRow,
    archiveRow: actions.archiveRow,
    unarchiveRow: actions.unarchiveRow,
    bulkCreateRows: actions.bulkCreateRows,
    bulkDeleteRows: actions.bulkDeleteRows,
    bulkArchiveRows: actions.bulkArchiveRows,

    // Relations
    createRelation: actions.createRelation,
    deleteRelation: actions.deleteRelation,
    getRelatedRows: actions.getRelatedRows,
    getRelationsForRow: actions.getRelationsForRow,

    // File references
    addFileReference: actions.addFileReference,
    removeFileReference: actions.removeFileReference,
    getFileReferences: actions.getFileReferences,
    reorderFileReferences: actions.reorderFileReferences,

    // Views
    createView: actions.createView,
    getViews: actions.getViews,
    getView: actions.getView,
    updateView: actions.updateView,
    deleteView: actions.deleteView,
    reorderViews: actions.reorderViews,

    // Transaction: server actions are stateless, so run sequentially against
    // `this`. Each call still hits its own server action.
    async transaction(fn) {
      return fn(this as DatabaseAdapter);
    },
  };
}
