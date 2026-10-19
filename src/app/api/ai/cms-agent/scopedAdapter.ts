// src/app/api/ai/cms-agent/scopedAdapter.ts
//
// The CMS adapter the content agent (and its undo) is allowed to touch: the raw
// data-table adapter narrowed to ONE workspace, the request's active workspace.
//
// Why: the route authorizes the session once (editSite on the active
// workspace), but every tool input after that comes from the model, and the
// model's ids come from the user's prompt. The raw adapter reads and writes
// purely by id with no workspace check, so without this a workspace-A editor
// could have the agent list, read, edit or delete workspace-B content just by
// naming its ids (and `list_collections` even took the workspace id as a tool
// input). Every method here pins the workspace:
//
//   - listTables ignores its argument and lists the bound workspace,
//   - reads answer an entity of another workspace exactly like a missing one
//     (null, [] or an empty page), so existence never leaks,
//   - writes assert ownership through the shared workspaceGuard first and
//     throw its AuthError 403 for a foreign or missing entity (the agent loop
//     surfaces that as `agent:error`, the undo route as a warning).

import type { Row } from '@marlinjai/data-table-core';
import {
  assertColumnInWorkspace,
  assertRowInWorkspace,
  assertRowsInWorkspace,
  assertSelectOptionInWorkspace,
  assertTableInWorkspace,
} from '@/server/cms/workspaceGuard';
import { AuthError } from '@/server/auth/requireWorkspaceScope';
import type { CmsAdapter } from './executor';

/** The raw adapter narrowed to `workspaceId` (see the file header). */
export function workspaceScopedCmsAdapter(raw: CmsAdapter, workspaceId: string): CmsAdapter {
  async function tableIsOwned(tableId: string): Promise<boolean> {
    const table = await raw.getTable(tableId);
    return table?.workspaceId === workspaceId;
  }

  async function columnIsOwned(columnId: string): Promise<boolean> {
    try {
      await assertColumnInWorkspace(columnId, workspaceId);
      return true;
    } catch (err) {
      if (err instanceof AuthError) return false;
      throw err;
    }
  }

  return {
    // --- reads: foreign == missing ---
    listTables: () => raw.listTables(workspaceId),
    getTable: async (tableId) => {
      const table = await raw.getTable(tableId);
      return table?.workspaceId === workspaceId ? table : null;
    },
    getColumns: async (tableId) => ((await tableIsOwned(tableId)) ? raw.getColumns(tableId) : []),
    getSelectOptions: async (columnId) =>
      (await columnIsOwned(columnId)) ? raw.getSelectOptions(columnId) : [],
    getRow: async (rowId): Promise<Row | null> => {
      const row = await raw.getRow(rowId);
      return row && (await tableIsOwned(row.tableId)) ? row : null;
    },
    getRows: async (tableId, query) =>
      (await tableIsOwned(tableId))
        ? raw.getRows(tableId, query)
        : { items: [], total: 0, hasMore: false },

    // --- writes: assert ownership, then delegate ---
    createRow: async (input) => {
      await assertTableInWorkspace(input.tableId, workspaceId);
      return raw.createRow(input);
    },
    bulkCreateRows: async (inputs) => {
      for (const tableId of new Set(inputs.map((i) => i.tableId))) {
        await assertTableInWorkspace(tableId, workspaceId);
      }
      return raw.bulkCreateRows(inputs);
    },
    updateRow: async (rowId, cells) => {
      await assertRowInWorkspace(rowId, workspaceId);
      return raw.updateRow(rowId, cells);
    },
    archiveRow: async (rowId) => {
      await assertRowInWorkspace(rowId, workspaceId);
      return raw.archiveRow(rowId);
    },
    unarchiveRow: async (rowId) => {
      await assertRowInWorkspace(rowId, workspaceId);
      return raw.unarchiveRow(rowId);
    },
    bulkArchiveRows: async (rowIds) => {
      await assertRowsInWorkspace(rowIds, workspaceId);
      return raw.bulkArchiveRows(rowIds);
    },
    deleteRow: async (rowId) => {
      await assertRowInWorkspace(rowId, workspaceId);
      return raw.deleteRow(rowId);
    },
    bulkDeleteRows: async (rowIds) => {
      await assertRowsInWorkspace(rowIds, workspaceId);
      return raw.bulkDeleteRows(rowIds);
    },
    createColumn: async (input) => {
      await assertTableInWorkspace(input.tableId, workspaceId);
      return raw.createColumn(input);
    },
    deleteColumn: async (columnId) => {
      await assertColumnInWorkspace(columnId, workspaceId);
      return raw.deleteColumn(columnId);
    },
    createSelectOption: async (input) => {
      await assertColumnInWorkspace(input.columnId, workspaceId);
      return raw.createSelectOption(input);
    },
    deleteSelectOption: async (optionId) => {
      await assertSelectOptionInWorkspace(optionId, workspaceId);
      return raw.deleteSelectOption(optionId);
    },
  };
}
