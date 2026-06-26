// src/app/api/ai/cms-agent/executor.ts
//
// The CMS content agent's tool dispatcher. Each tool call from the route's
// Anthropic tool-use loop lands here: the input is Zod-validated, then executed
// DIRECTLY against the CMS data layer (`getCmsAdapter()`, passed in via context)
// rather than through `actions.ts`. Auth (the real auth-brain session + workspace
// permission) was already verified ONCE at the route boundary, so the executor
// never reads cookies.
//
// Every mutating tool records its EXACT inverse via `ctx.recordChange` so the
// run is reversible: update/archive/status ops read the previous state BEFORE
// writing and store it in the inverse payload. Removal is archive-based
// (reversible); there is no hard-delete tool. Errors are returned as structured
// results (never thrown silently); the route surfaces them over SSE.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  CellValue,
  Column,
  ColumnConfig,
  ColumnType,
  CreateRowInput,
  Row,
  SelectOption,
  Table,
} from '@marlinjai/data-table-core';
import { AI_MODELS } from '@/lib/ai/anthropicClient';
import type { AgentChangeSummary } from '@/lib/ai/cmsAgentProtocol';
import { isAgentToolName, toolInputSchemas, type AgentToolName } from './tools';

export type { AgentChangeSummary } from '@/lib/ai/cmsAgentProtocol';

/** The structural subset of the CMS adapter the executor depends on. */
export interface CmsAdapter {
  listTables(workspaceId: string): Promise<Table[]>;
  getTable(tableId: string): Promise<Table | null>;
  getColumns(tableId: string): Promise<Column[]>;
  getSelectOptions(columnId: string): Promise<SelectOption[]>;
  getRow(rowId: string): Promise<Row | null>;
  getRows(
    tableId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<{ items: Row[]; total: number; hasMore: boolean; cursor?: string }>;
  createRow(input: CreateRowInput): Promise<Row>;
  bulkCreateRows(inputs: CreateRowInput[]): Promise<Row[]>;
  updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row>;
  archiveRow(rowId: string): Promise<void>;
  unarchiveRow(rowId: string): Promise<void>;
  bulkArchiveRows(rowIds: string[]): Promise<void>;
  deleteRow(rowId: string): Promise<void>;
  bulkDeleteRows(rowIds: string[]): Promise<void>;
  createColumn(input: {
    tableId: string;
    name: string;
    type: ColumnType;
    config?: ColumnConfig;
  }): Promise<Column>;
  deleteColumn(columnId: string): Promise<void>;
  createSelectOption(input: {
    columnId: string;
    name: string;
    color?: string;
  }): Promise<SelectOption>;
  deleteSelectOption(optionId: string): Promise<void>;
}

/** The inverse adapter calls undo can replay. */
export type InverseTool =
  | 'deleteRow'
  | 'bulkDeleteRows'
  | 'updateRow'
  | 'unarchiveRow'
  | 'bulkUnarchiveRows'
  | 'deleteColumn'
  | 'deleteSelectOption';

/** A mutation's recorded inverse, persisted as an `AgentChange`. */
export interface RecordedChange {
  tool: string;
  entityType: string; // 'row' | 'column' | 'option'
  entityId: string | null;
  inverseTool: InverseTool;
  inversePayload: Record<string, unknown>;
}

export interface ToolExecResult {
  success: boolean;
  /** Human-readable line for the assistant step list / `agent:tool_result`. */
  summary: string;
  /** Present on a successful mutation; aggregated into `agent:done`. */
  changeSummary?: AgentChangeSummary;
  /** Present on failure; surfaced (never swallowed). */
  error?: string;
}

export interface ExecutorContext {
  adapter: CmsAdapter;
  /** Used for the inner (non-streaming) Haiku calls of translate/generate. */
  anthropic: Anthropic;
  recordChange: (change: RecordedChange) => Promise<void>;
  /** The CSV attached to the request body, injected into `csv_import`. */
  csvPayload?: { name: string; content: string };
  /** Active collection display name, used for change-summary entity labels. */
  collectionName?: string;
}

export const UPLOAD_DISABLED_MESSAGE =
  'Image upload requires Storage Brain integration -- not yet configured';

/**
 * Validate + execute a single tool call. Returns a structured result; the
 * caller streams `agent:tool_result` from it. Validation and data-layer errors
 * become `{ success: false, error }` rather than throwing, so one bad tool call
 * does not tear down the whole run before its message reaches the user.
 */
export async function executeAgentTool(
  rawName: string,
  rawInput: unknown,
  ctx: ExecutorContext,
): Promise<ToolExecResult> {
  if (!isAgentToolName(rawName)) {
    return { success: false, summary: `Unknown tool "${rawName}"`, error: `Unknown tool "${rawName}"` };
  }
  const name: AgentToolName = rawName;

  // csv_import: the base64 content lives in the request body, not the model's
  // tool input (the model cannot see it). Merge it in before validation.
  let inputToValidate = rawInput;
  if (name === 'csv_import' && ctx.csvPayload) {
    inputToValidate = { ...(rawInput as object), csvPayload: ctx.csvPayload };
  }

  const parsed = toolInputSchemas[name].safeParse(inputToValidate);
  if (!parsed.success) {
    const msg = `Invalid input for ${name}: ${parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
      .join('; ')}`;
    return { success: false, summary: msg, error: msg };
  }

  // Validation failures and honest-disabled tools (upload_file) return a
  // structured error so the model can surface it and keep going. An adapter /
  // infrastructure THROW is NOT caught here: it propagates to the route loop,
  // which emits `agent:error` and marks the run `failed` (errors never swallowed).
  return dispatch(name, parsed.data, ctx);
}

const entityLabel = (ctx: ExecutorContext): string => ctx.collectionName ?? 'items';

async function dispatch(
  name: AgentToolName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
  ctx: ExecutorContext,
): Promise<ToolExecResult> {
  const { adapter } = ctx;

  switch (name) {
    case 'list_collections': {
      const tables = await adapter.listTables(input.workspaceId);
      return {
        success: true,
        summary:
          tables.length === 0
            ? 'No collections found'
            : `Found ${tables.length} collection${tables.length === 1 ? '' : 's'}: ${tables
                .map((t) => `${t.name} (${t.id})`)
                .join(', ')}`,
      };
    }

    case 'list_columns': {
      const columns = await adapter.getColumns(input.tableId);
      return {
        success: true,
        summary: `Columns: ${columns.map((c) => `${c.name} [${c.type}] (${c.id})`).join(', ')}`,
      };
    }

    case 'list_rows': {
      const result = await adapter.getRows(input.tableId, {
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        success: true,
        summary: `Read ${result.items.length} row${result.items.length === 1 ? '' : 's'} (total ${result.total})`,
      };
    }

    case 'create_row': {
      const row = await adapter.createRow({
        tableId: input.tableId,
        cells: input.cells as Record<string, CellValue>,
      });
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: row.id,
        inverseTool: 'deleteRow',
        inversePayload: { rowId: row.id },
      });
      return {
        success: true,
        summary: `Created 1 item in ${entityLabel(ctx)}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'plus', count: 1, label: '+1 item' },
      };
    }

    case 'bulk_create_rows': {
      const rows: CreateRowInput[] = (input.rows as Record<string, unknown>[]).map((cells) => ({
        tableId: input.tableId,
        cells: cells as Record<string, CellValue>,
      }));
      const created = await adapter.bulkCreateRows(rows);
      const ids = created.map((r) => r.id);
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: ids[0] ?? null,
        inverseTool: 'bulkDeleteRows',
        inversePayload: { rowIds: ids },
      });
      return {
        success: true,
        summary: `Created ${ids.length} items in ${entityLabel(ctx)}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'plus', count: ids.length, label: `+${ids.length} items` },
      };
    }

    case 'update_row': {
      const existing = await adapter.getRow(input.rowId);
      if (!existing) {
        const msg = `Row ${input.rowId} not found`;
        return { success: false, summary: msg, error: msg };
      }
      const cells = input.cells as Record<string, CellValue>;
      const previousCells = capturePrevious(existing.cells, Object.keys(cells));
      await adapter.updateRow(input.rowId, cells);
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: input.rowId,
        inverseTool: 'updateRow',
        inversePayload: { rowId: input.rowId, previousCells },
      });
      return {
        success: true,
        summary: `Updated 1 item in ${entityLabel(ctx)}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'pencil', count: 1, label: '1 updated' },
      };
    }

    case 'archive_row': {
      const existing = await adapter.getRow(input.rowId);
      if (!existing) {
        const msg = `Row ${input.rowId} not found`;
        return { success: false, summary: msg, error: msg };
      }
      await adapter.archiveRow(input.rowId);
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: input.rowId,
        inverseTool: 'unarchiveRow',
        inversePayload: { rowId: input.rowId },
      });
      return {
        success: true,
        summary: `Archived 1 item in ${entityLabel(ctx)}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'archive', count: 1, label: '1 archived' },
      };
    }

    case 'bulk_archive_rows': {
      const rowIds = input.rowIds as string[];
      await adapter.bulkArchiveRows(rowIds);
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: rowIds[0] ?? null,
        inverseTool: 'bulkUnarchiveRows',
        inversePayload: { rowIds },
      });
      return {
        success: true,
        summary: `Archived ${rowIds.length} items in ${entityLabel(ctx)}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'archive', count: rowIds.length, label: `${rowIds.length} archived` },
      };
    }

    case 'bulk_update_status': {
      const rowIds = input.rowIds as string[];
      const first = await adapter.getRow(rowIds[0]);
      if (!first) {
        const msg = `Row ${rowIds[0]} not found`;
        return { success: false, summary: msg, error: msg };
      }
      const columns = await adapter.getColumns(first.tableId);
      const statusColumn = columns.find(
        (c) => c.type === 'select' && c.name.trim().toLowerCase() === 'status',
      );
      if (!statusColumn) {
        const msg = `No "Status" select column on this collection`;
        return { success: false, summary: msg, error: msg };
      }
      const options = await adapter.getSelectOptions(statusColumn.id);
      const target = options.find((o) => o.name.trim().toLowerCase() === input.status.trim().toLowerCase());
      if (!target) {
        const msg = `No "${input.status}" option on the Status field`;
        return { success: false, summary: msg, error: msg };
      }
      let updated = 0;
      for (const rowId of rowIds) {
        const row = rowId === rowIds[0] ? first : await adapter.getRow(rowId);
        if (!row) continue;
        const previous = row.cells[statusColumn.id] ?? null;
        await adapter.updateRow(rowId, { [statusColumn.id]: target.id });
        await ctx.recordChange({
          tool: name,
          entityType: 'row',
          entityId: rowId,
          inverseTool: 'updateRow',
          inversePayload: { rowId, previousCells: { [statusColumn.id]: previous } },
        });
        updated += 1;
      }
      return {
        success: true,
        summary: `Set status to "${target.name}" on ${updated} item${updated === 1 ? '' : 's'}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'circle-check', count: updated, label: `${updated} updated` },
      };
    }

    case 'create_column': {
      const column = await adapter.createColumn({
        tableId: input.tableId,
        name: input.name,
        type: input.type as ColumnType,
        config: input.config as ColumnConfig | undefined,
      });
      await ctx.recordChange({
        tool: name,
        entityType: 'column',
        entityId: column.id,
        inverseTool: 'deleteColumn',
        inversePayload: { columnId: column.id },
      });
      return {
        success: true,
        summary: `Created column "${column.name}"`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'columns-3', count: 1, label: '+1 column' },
      };
    }

    case 'create_select_option': {
      const option = await adapter.createSelectOption({
        columnId: input.columnId,
        name: input.name,
        color: input.color,
      });
      await ctx.recordChange({
        tool: name,
        entityType: 'option',
        entityId: option.id,
        inverseTool: 'deleteSelectOption',
        inversePayload: { optionId: option.id },
      });
      return {
        success: true,
        summary: `Created option "${option.name}"`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'tag', count: 1, label: '+1 option' },
      };
    }

    case 'csv_import': {
      const text = decodeBase64Utf8(input.csvPayload.content);
      const parsedRows = parseCsv(text);
      if (parsedRows.length === 0) {
        const msg = 'CSV has no data rows';
        return { success: false, summary: msg, error: msg };
      }
      if (parsedRows.length > 1000) {
        const msg = `CSV has ${parsedRows.length} rows (max 1000)`;
        return { success: false, summary: msg, error: msg };
      }
      const columns = await adapter.getColumns(input.tableId);
      const mapping = resolveCsvMapping(parsedRows[0].header, input.columnMapping, columns);
      const inputs: CreateRowInput[] = parsedRows.map((r) => {
        const cells: Record<string, CellValue> = {};
        for (const [header, columnId] of Object.entries(mapping)) {
          const value = r.values[header];
          if (value !== undefined) cells[columnId] = value;
        }
        return { tableId: input.tableId, cells };
      });
      const created = await adapter.bulkCreateRows(inputs);
      const ids = created.map((row) => row.id);
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: ids[0] ?? null,
        inverseTool: 'bulkDeleteRows',
        inversePayload: { rowIds: ids },
      });
      return {
        success: true,
        summary: `Imported ${ids.length} rows from ${input.csvPayload.name}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'file-up', count: ids.length, label: `+${ids.length} items` },
      };
    }

    case 'generate_content': {
      const generated = await generateRows(ctx.anthropic, input.prompt, input.count, input.targetColumns);
      const inputs: CreateRowInput[] = generated.map((cells) => ({
        tableId: input.tableId,
        cells: cells as Record<string, CellValue>,
      }));
      const created = await adapter.bulkCreateRows(inputs);
      const ids = created.map((row) => row.id);
      await ctx.recordChange({
        tool: name,
        entityType: 'row',
        entityId: ids[0] ?? null,
        inverseTool: 'bulkDeleteRows',
        inversePayload: { rowIds: ids },
      });
      return {
        success: true,
        summary: `Generated ${ids.length} items in ${entityLabel(ctx)}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'sparkles', count: ids.length, label: `+${ids.length} items` },
      };
    }

    case 'translate_field': {
      const rowIds = input.rowIds as string[];
      const sources: { rowId: string; value: string; previous: CellValue }[] = [];
      for (const rowId of rowIds) {
        const row = await adapter.getRow(rowId);
        if (!row) continue;
        const previous = row.cells[input.columnId] ?? null;
        sources.push({ rowId, value: previous === null ? '' : String(previous), previous });
      }
      if (sources.length === 0) {
        const msg = 'No rows found to translate';
        return { success: false, summary: msg, error: msg };
      }
      const translations = await translateValues(ctx.anthropic, sources, input.targetLanguage);
      let updated = 0;
      for (const src of sources) {
        const translated = translations[src.rowId];
        if (translated === undefined) continue;
        await adapter.updateRow(src.rowId, { [input.columnId]: translated });
        await ctx.recordChange({
          tool: name,
          entityType: 'row',
          entityId: src.rowId,
          inverseTool: 'updateRow',
          inversePayload: { rowId: src.rowId, previousCells: { [input.columnId]: src.previous } },
        });
        updated += 1;
      }
      return {
        success: true,
        summary: `Translated ${updated} value${updated === 1 ? '' : 's'} to ${input.targetLanguage}`,
        changeSummary: { tool: name, entityType: entityLabel(ctx), icon: 'languages', count: updated, label: `${updated} updated` },
      };
    }

    case 'upload_file': {
      // Honest-disabled: loud structured error, records nothing.
      return { success: false, summary: UPLOAD_DISABLED_MESSAGE, error: UPLOAD_DISABLED_MESSAGE };
    }

    default: {
      // Exhaustiveness guard.
      const _never: never = name;
      return { success: false, summary: `Unhandled tool ${String(_never)}`, error: 'unhandled tool' };
    }
  }
}

// --- Undo replay -----------------------------------------------------------

/**
 * Replay one recorded inverse against the adapter. Used by the undo route.
 * `bulkUnarchiveRows` is fanned out to per-row `unarchiveRow` calls (the adapter
 * has no bulk unarchive). Throws on adapter failure so the undo route can record
 * a partial result.
 */
export async function applyInverse(
  adapter: CmsAdapter,
  inverseTool: string,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (inverseTool) {
    case 'deleteRow':
      await adapter.deleteRow(String(payload.rowId));
      return;
    case 'bulkDeleteRows':
      await adapter.bulkDeleteRows((payload.rowIds as string[]) ?? []);
      return;
    case 'updateRow':
      await adapter.updateRow(
        String(payload.rowId),
        (payload.previousCells as Record<string, CellValue>) ?? {},
      );
      return;
    case 'unarchiveRow':
      await adapter.unarchiveRow(String(payload.rowId));
      return;
    case 'bulkUnarchiveRows': {
      for (const id of (payload.rowIds as string[]) ?? []) {
        await adapter.unarchiveRow(id);
      }
      return;
    }
    case 'deleteColumn':
      await adapter.deleteColumn(String(payload.columnId));
      return;
    case 'deleteSelectOption':
      await adapter.deleteSelectOption(String(payload.optionId));
      return;
    default:
      throw new Error(`Unknown inverse tool "${inverseTool}"`);
  }
}

// --- Helpers ---------------------------------------------------------------

function capturePrevious(
  cells: Record<string, CellValue>,
  keys: string[],
): Record<string, CellValue> {
  const previous: Record<string, CellValue> = {};
  for (const key of keys) {
    previous[key] = key in cells ? cells[key] : null;
  }
  return previous;
}

function decodeBase64Utf8(content: string): string {
  // Tolerate a data-URL prefix and either raw text or base64.
  const stripped = content.includes(',') && content.startsWith('data:')
    ? content.slice(content.indexOf(',') + 1)
    : content;
  try {
    return Buffer.from(stripped, 'base64').toString('utf-8');
  } catch {
    return stripped;
  }
}

interface ParsedCsvRow {
  header: string[];
  values: Record<string, string>;
}

/**
 * Parse CSV text into header-keyed rows. Handles quoted fields containing
 * commas, newlines, and escaped (`""`) quotes. Returns one entry per data row,
 * each carrying the shared header for mapping.
 */
export function parseCsv(text: string): ParsedCsvRow[] {
  const records = splitCsvRecords(text);
  if (records.length === 0) return [];
  const header = records[0].map((h) => h.trim());
  const rows: ParsedCsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record.length === 1 && record[0].trim() === '') continue; // skip blank line
    const values: Record<string, string> = {};
    header.forEach((key, idx) => {
      values[key] = record[idx] ?? '';
    });
    rows.push({ header, values });
  }
  return rows;
}

function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (char === '\r') {
      // swallow; the paired \n closes the record
    } else {
      field += char;
    }
  }
  // Flush trailing field/record (no terminal newline).
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function resolveCsvMapping(
  header: string[],
  explicit: Record<string, string> | undefined,
  columns: Column[],
): Record<string, string> {
  if (explicit && Object.keys(explicit).length > 0) return explicit;
  // Default: match a CSV header to a column whose name equals it (case-insensitive).
  const byName = new Map(columns.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const mapping: Record<string, string> = {};
  for (const h of header) {
    const columnId = byName.get(h.trim().toLowerCase());
    if (columnId) mapping[h] = columnId;
  }
  return mapping;
}

function extractJson(text: string): string {
  let body = text.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  const firstArray = body.indexOf('[');
  const firstObject = body.indexOf('{');
  const start = [firstArray, firstObject].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return body;
  const lastArray = body.lastIndexOf(']');
  const lastObject = body.lastIndexOf('}');
  const end = Math.max(lastArray, lastObject);
  return end > start ? body.slice(start, end + 1) : body;
}

async function innerHaiku(anthropic: Anthropic, system: string, prompt: string): Promise<unknown> {
  const res = await anthropic.messages.create({
    model: AI_MODELS.HAIKU,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return JSON.parse(extractJson(text));
}

async function generateRows(
  anthropic: Anthropic,
  prompt: string,
  count: number,
  targetColumns: string[],
): Promise<Record<string, unknown>[]> {
  const system =
    'You generate CMS content. Reply with ONLY a JSON array of objects. Each ' +
    'object uses EXACTLY these keys (column ids), and no others: ' +
    JSON.stringify(targetColumns) +
    '. Produce realistic, varied values. No commentary, no code fences.';
  const ask = `Generate exactly ${count} items. Instruction: ${prompt}`;
  const result = await innerHaiku(anthropic, system, ask);
  if (!Array.isArray(result)) {
    throw new Error('generate_content: model did not return a JSON array');
  }
  return result.slice(0, count).map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const cells: Record<string, unknown> = {};
    for (const col of targetColumns) {
      if (obj[col] !== undefined) cells[col] = obj[col];
    }
    return cells;
  });
}

async function translateValues(
  anthropic: Anthropic,
  sources: { rowId: string; value: string }[],
  targetLanguage: string,
): Promise<Record<string, string>> {
  const system =
    'You are a translator. Reply with ONLY a JSON array of ' +
    '{ "rowId": string, "translatedValue": string } objects, one per input, ' +
    'preserving rowId exactly. No commentary, no code fences.';
  const ask =
    `Translate each "value" into ${targetLanguage}. Input:\n` +
    JSON.stringify(sources.map((s) => ({ rowId: s.rowId, value: s.value })));
  const result = await innerHaiku(anthropic, system, ask);
  if (!Array.isArray(result)) {
    throw new Error('translate_field: model did not return a JSON array');
  }
  const out: Record<string, string> = {};
  for (const item of result) {
    const obj = (item ?? {}) as { rowId?: unknown; translatedValue?: unknown };
    if (typeof obj.rowId === 'string' && typeof obj.translatedValue === 'string') {
      out[obj.rowId] = obj.translatedValue;
    }
  }
  return out;
}
