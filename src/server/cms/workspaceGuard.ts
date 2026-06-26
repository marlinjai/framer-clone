import 'server-only';

// src/server/cms/workspaceGuard.ts
//
// The data-layer workspace-isolation guard for the CMS editor grid's server
// actions (src/server/cms/actions.ts). The auth gate (requireWorkspaceScope)
// proves the caller is an admin of SOME workspace; this proves the ENTITY being
// mutated belongs to THAT workspace. Without it, a workspace-A admin who knows a
// workspace-B row/column/table id could mutate it — the data-table adapter is
// keyed purely by entity id and performs no workspace check of its own.
//
// Why an app-layer ownership check and not a scoped adapter / SET LOCAL: the CMS
// engine is single-schema in Phase 2 (CMS_SCHEMA = 'public'); every workspace's
// rows live in the SAME tables, distinguished only by the `DtTable.workspace_id`
// column. So there is no search_path to set and the adapter exposes no
// workspace-scoped mutation; the only correct isolation today is to resolve each
// entity up to its owning table's workspace_id and reject a mismatch. Physical
// per-tenant schema isolation is MT-18.
//
// Resolution uses the ADAPTER's reads (the storage source of truth) for
// table/column/row/view — notably for rows, so this never has to guess between
// the legacy `dt_rows` model and the migrated representation. The two entities
// the adapter cannot look up by id (a select option, a file reference) are
// resolved by a single scalar-FK read of their stable owning id, then handed
// back to the adapter-based table resolver.
//
// Fail-closed: a missing entity OR a workspace mismatch both throw AuthError 403.
// An entity that does not exist is indistinguishable from one in another
// workspace, and both are a deny — we never leak existence across the boundary.

import { getPrismaClient } from '@/server/db';
import { getCmsAdapter } from './adapterClient';
import { AuthError } from '@/server/auth/requireWorkspaceScope';

function denyCrossWorkspace(): never {
  // Same 403 shape the auth gate uses; the message never names the foreign
  // workspace or whether the entity exists.
  throw new AuthError(403, 'entity is not in the active workspace');
}

/** The owning workspace of a table, or null when the table does not exist. */
async function tableWorkspaceId(tableId: string): Promise<string | null> {
  const table = await getCmsAdapter().getTable(tableId);
  return table?.workspaceId ?? null;
}

export async function assertTableInWorkspace(
  tableId: string,
  workspaceId: string,
): Promise<void> {
  if ((await tableWorkspaceId(tableId)) !== workspaceId) denyCrossWorkspace();
}

export async function assertColumnInWorkspace(
  columnId: string,
  workspaceId: string,
): Promise<void> {
  const column = await getCmsAdapter().getColumn(columnId);
  if (!column) denyCrossWorkspace();
  await assertTableInWorkspace(column.tableId, workspaceId);
}

export async function assertRowInWorkspace(
  rowId: string,
  workspaceId: string,
): Promise<void> {
  const row = await getCmsAdapter().getRow(rowId);
  if (!row) denyCrossWorkspace();
  await assertTableInWorkspace(row.tableId, workspaceId);
}

/** Assert every row id belongs to the workspace (bulk row mutations). */
export async function assertRowsInWorkspace(
  rowIds: string[],
  workspaceId: string,
): Promise<void> {
  await Promise.all(rowIds.map((id) => assertRowInWorkspace(id, workspaceId)));
}

export async function assertViewInWorkspace(
  viewId: string,
  workspaceId: string,
): Promise<void> {
  const view = await getCmsAdapter().getView(viewId);
  if (!view) denyCrossWorkspace();
  await assertTableInWorkspace(view.tableId, workspaceId);
}

export async function assertSelectOptionInWorkspace(
  optionId: string,
  workspaceId: string,
): Promise<void> {
  // The adapter has no getSelectOption(id); resolve the owning column via a
  // single scalar-FK read of the stable select_options row.
  const option = await getPrismaClient().selectOption.findUnique({
    where: { id: optionId },
    select: { columnId: true },
  });
  if (!option) denyCrossWorkspace();
  await assertColumnInWorkspace(option.columnId, workspaceId);
}

export async function assertFileReferenceInWorkspace(
  fileRefId: string,
  workspaceId: string,
): Promise<void> {
  // The adapter has no getFileReference(id); resolve the owning row via a single
  // scalar-FK read of the stable dt_files row.
  const file = await getPrismaClient().dtFile.findUnique({
    where: { id: fileRefId },
    select: { rowId: true },
  });
  if (!file) denyCrossWorkspace();
  await assertRowInWorkspace(file.rowId, workspaceId);
}
