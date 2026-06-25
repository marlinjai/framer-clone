// src/app/api/ai/cms-agent/tools.ts
//
// The CMS content agent's tool registry: one Zod input schema per tool (the
// server-side validation gate) plus the Anthropic tool-use definitions handed
// to `messages.create`. The executor (executor.ts) validates a tool call's
// `input` against the matching Zod schema BEFORE touching the data layer, so a
// model that invents a shape gets a structured tool error, never a half-applied
// write.
//
// Phase 2a removal is ARCHIVE-based and reversible: the agent gets
// `archive_row` / `bulk_archive_rows`, never the hard `delete_row` /
// `bulk_delete_rows` (those are a later slice with a destructive-tool UX). The
// hard-delete adapter methods still exist; they are simply never exposed here.

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

// A cell map: column id -> value. Values are unknown at the schema boundary;
// the adapter coerces per column type.
const cellsSchema = z.record(z.string(), z.unknown());

export const toolInputSchemas = {
  list_collections: z.object({ workspaceId: z.string() }),

  list_columns: z.object({ tableId: z.string() }),

  list_rows: z.object({
    tableId: z.string(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
    filter: z.string().optional(),
  }),

  create_row: z.object({ tableId: z.string(), cells: cellsSchema }),

  bulk_create_rows: z.object({
    tableId: z.string(),
    rows: z.array(cellsSchema).min(1).max(500),
  }),

  update_row: z.object({ rowId: z.string(), cells: cellsSchema }),

  archive_row: z.object({ rowId: z.string() }),

  bulk_archive_rows: z.object({
    rowIds: z.array(z.string()).min(1).max(500),
  }),

  bulk_update_status: z.object({
    rowIds: z.array(z.string()).min(1).max(500),
    status: z.string(),
  }),

  create_column: z.object({
    tableId: z.string(),
    name: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),

  create_select_option: z.object({
    columnId: z.string(),
    name: z.string(),
    color: z.string().optional(),
  }),

  csv_import: z.object({
    tableId: z.string(),
    csvPayload: z.object({
      name: z.string(),
      content: z.string().max(4_000_000),
    }),
    columnMapping: z.record(z.string(), z.string()).optional(),
  }),

  generate_content: z.object({
    tableId: z.string(),
    prompt: z.string(),
    count: z.number().int().min(1).max(50),
    targetColumns: z.array(z.string()),
  }),

  translate_field: z.object({
    tableId: z.string(),
    rowIds: z.array(z.string()).min(1).max(200),
    columnId: z.string(),
    targetLanguage: z.string(),
  }),

  upload_file: z.object({
    tableId: z.string(),
    rowId: z.string(),
    columnId: z.string(),
    fileName: z.string(),
  }),
} as const;

export type AgentToolName = keyof typeof toolInputSchemas;

export function isAgentToolName(name: string): name is AgentToolName {
  return Object.prototype.hasOwnProperty.call(toolInputSchemas, name);
}

// The Anthropic tool-use definitions. Descriptions encode the read-before-write
// and archive-not-delete contracts so the model uses the tools correctly. The
// `csv_import` content is supplied server-side from the request body (the model
// cannot see the base64), so its schema only asks for the table + optional
// mapping.
export const agentToolDefs: Anthropic.Tool[] = [
  {
    name: 'list_collections',
    description:
      'List every collection (table) in the workspace, returning id + name + row count. Use to discover collection ids before targeting another collection.',
    input_schema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
    },
  },
  {
    name: 'list_columns',
    description:
      'List the columns of a collection with their ids, names, and types. ALWAYS call this before writing rows so you use real column ids; never invent a column id.',
    input_schema: {
      type: 'object',
      properties: { tableId: { type: 'string' } },
      required: ['tableId'],
    },
  },
  {
    name: 'list_rows',
    description:
      'Read rows from a collection (paginated). Returns row ids and cell values. Use before update/archive/translate so you target the right rows.',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        limit: { type: 'number', description: '1-200, default 50' },
        cursor: { type: 'string', description: 'pagination cursor from a prior call' },
        filter: { type: 'string', description: 'free-text hint; narrow further in your reasoning' },
      },
      required: ['tableId'],
    },
  },
  {
    name: 'create_row',
    description:
      'Create one row. `cells` maps column id -> value. Reversible via the run undo (inverse: delete the created row).',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        cells: { type: 'object', description: 'column id -> value' },
      },
      required: ['tableId', 'cells'],
    },
  },
  {
    name: 'bulk_create_rows',
    description:
      'Create many rows in one call (1-500). `rows` is an array of cell maps (column id -> value). Reversible (inverse: delete all created rows).',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        rows: { type: 'array', items: { type: 'object' }, description: 'array of column id -> value maps' },
      },
      required: ['tableId', 'rows'],
    },
  },
  {
    name: 'update_row',
    description:
      'Update a row\'s cells. The previous values are captured first so the change is exactly reversible. `cells` maps column id -> new value.',
    input_schema: {
      type: 'object',
      properties: {
        rowId: { type: 'string' },
        cells: { type: 'object', description: 'column id -> new value' },
      },
      required: ['rowId', 'cells'],
    },
  },
  {
    name: 'archive_row',
    description:
      'Archive (soft-delete) a row. Archived rows vanish from the grid and storefront but are fully restorable. This is the agent\'s removal primitive; there is no hard delete.',
    input_schema: {
      type: 'object',
      properties: { rowId: { type: 'string' } },
      required: ['rowId'],
    },
  },
  {
    name: 'bulk_archive_rows',
    description:
      'Archive many rows at once (1-500). Reversible (inverse: unarchive all). Use instead of any hard delete.',
    input_schema: {
      type: 'object',
      properties: {
        rowIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['rowIds'],
    },
  },
  {
    name: 'bulk_update_status',
    description:
      'Set the reserved "Status" select field (e.g. Draft/Published/Scheduled) on many rows at once. `status` is the option name. Previous status per row is captured for undo. Use for "publish all drafts" style requests.',
    input_schema: {
      type: 'object',
      properties: {
        rowIds: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', description: 'target Status option name, e.g. "Published"' },
      },
      required: ['rowIds', 'status'],
    },
  },
  {
    name: 'create_column',
    description:
      'Add a column to a collection. `type` is one of the data-table column types (text, number, date, boolean, select, multi_select, url, file, ...). Reversible (inverse: delete the column).',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        config: { type: 'object' },
      },
      required: ['tableId', 'name', 'type'],
    },
  },
  {
    name: 'create_select_option',
    description:
      'Add an option to a select/multi_select column. Reversible (inverse: delete the option).',
    input_schema: {
      type: 'object',
      properties: {
        columnId: { type: 'string' },
        name: { type: 'string' },
        color: { type: 'string', description: 'one of the engine tag palette names (orange, green, blue, ...)' },
      },
      required: ['columnId', 'name'],
    },
  },
  {
    name: 'csv_import',
    description:
      'Import the CSV file the user attached to this request into the collection. The file content is supplied server-side; you only provide the target collection and an optional columnMapping (csv header -> column id). Reversible (inverse: delete all imported rows).',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        columnMapping: { type: 'object', description: 'csv header -> column id (optional; defaults to header=name match)' },
      },
      required: ['tableId'],
    },
  },
  {
    name: 'generate_content',
    description:
      'Generate `count` new rows of content from a prompt, filling the `targetColumns`. Content is produced by a secondary model call and inserted in bulk. Reversible (inverse: delete all generated rows).',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        prompt: { type: 'string' },
        count: { type: 'number', description: '1-50' },
        targetColumns: { type: 'array', items: { type: 'string' }, description: 'column ids to fill' },
      },
      required: ['tableId', 'prompt', 'count', 'targetColumns'],
    },
  },
  {
    name: 'translate_field',
    description:
      'Translate one column\'s value for the given rows into `targetLanguage`. Current values are read first (for undo), translated in one batched secondary call, then written back per row. Reversible (inverse: restore the original values).',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        rowIds: { type: 'array', items: { type: 'string' } },
        columnId: { type: 'string' },
        targetLanguage: { type: 'string' },
      },
      required: ['tableId', 'rowIds', 'columnId', 'targetLanguage'],
    },
  },
  {
    name: 'upload_file',
    description:
      'Attempt to upload an image/file to a cell. NOT YET AVAILABLE: this always returns an error because image storage is not configured. If the user asks to upload images, call this and report the error verbatim; do not try to work around it.',
    input_schema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        rowId: { type: 'string' },
        columnId: { type: 'string' },
        fileName: { type: 'string' },
      },
      required: ['tableId', 'rowId', 'columnId', 'fileName'],
    },
  },
];
