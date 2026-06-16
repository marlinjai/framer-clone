// src/components/cms/cmsClient.ts
//
// The browser-side client the content-manager panel talks to. It wraps the
// /api/cms/* routes (read + admin-guarded write) and, crucially, preserves the
// TYPED error contract end to end: a non-OK response is parsed into a
// CmsClientError carrying the envelope's `code`/`message`/`status`, so the panel
// can render the SPECIFIC error inline (for example `collection_exists`) instead
// of a generic "something went wrong". A failure is never swallowed into a
// resolved value that would read as success.
//
// Admin auth: writes are same-origin requests; the interim admin secret rides
// the `admin_secret` cookie (see src/server/auth/guard.ts), which the browser
// attaches automatically. The client therefore sends no secret itself.

import type {
  Collection,
  Column,
  ColumnType,
  Row,
  RowsPage,
} from '@/lib/bindings/dataSource/types';

/** A typed CMS API failure parsed from the `{ error: { code, message } }` envelope. */
export class CmsClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CmsClientError';
    this.code = code;
    this.status = status;
  }
}

/** A new field definition the panel sends to the add-column route. */
export interface NewField {
  name: string;
  type: ColumnType;
}

/** Row cell values keyed by column id. */
export type RowValues = Record<string, Row['values'][string]>;

/**
 * The read + write surface the panel depends on. Declaring it as an interface
 * lets tests inject a fake implementation without mocking global fetch.
 */
export interface CmsClient {
  listCollections(): Promise<Collection[]>;
  listRows(id: string): Promise<RowsPage>;
  createCollection(name: string): Promise<Collection>;
  renameCollection(id: string, name: string): Promise<void>;
  deleteCollection(id: string): Promise<void>;
  addColumn(id: string, field: NewField): Promise<Column>;
  renameColumn(id: string, colId: string, name: string): Promise<void>;
  retypeColumn(id: string, colId: string, type: ColumnType): Promise<void>;
  deleteColumn(id: string, colId: string): Promise<void>;
  createRow(id: string, values: RowValues): Promise<Row>;
  updateRow(id: string, rowId: string, values: RowValues): Promise<Row>;
  deleteRow(id: string, rowId: string): Promise<void>;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function toClientError(res: Response): Promise<CmsClientError> {
  let code = 'cms_request_failed';
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Non-JSON body: keep the status-derived message.
  }
  return new CmsClientError(code, message, res.status);
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw await toClientError(res);
  }
  return (await res.json()) as T;
}

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) {
    throw await toClientError(res);
  }
}

function col(id: string): string {
  return `/api/cms/collections/${encodeURIComponent(id)}`;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** The live HTTP-backed client, used by the app. */
export const httpCmsClient: CmsClient = {
  async listCollections() {
    return readJson<Collection[]>(await fetch('/api/cms/collections'));
  },

  async listRows(id) {
    return readJson<RowsPage>(await fetch(`${col(id)}/rows`));
  },

  async createCollection(name) {
    return readJson<Collection>(
      await fetch('/api/cms/collections', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      }),
    );
  },

  async renameCollection(id, name) {
    await expectOk(
      await fetch(col(id), {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      }),
    );
  },

  async deleteCollection(id) {
    await expectOk(await fetch(col(id), { method: 'DELETE' }));
  },

  async addColumn(id, field) {
    return readJson<Column>(
      await fetch(`${col(id)}/columns`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(field),
      }),
    );
  },

  async renameColumn(id, colId, name) {
    await expectOk(
      await fetch(`${col(id)}/columns/${encodeURIComponent(colId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      }),
    );
  },

  async retypeColumn(id, colId, type) {
    await expectOk(
      await fetch(`${col(id)}/columns/${encodeURIComponent(colId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ type }),
      }),
    );
  },

  async deleteColumn(id, colId) {
    await expectOk(
      await fetch(`${col(id)}/columns/${encodeURIComponent(colId)}`, {
        method: 'DELETE',
      }),
    );
  },

  async createRow(id, values) {
    return readJson<Row>(
      await fetch(`${col(id)}/rows`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ values }),
      }),
    );
  },

  async updateRow(id, rowId, values) {
    return readJson<Row>(
      await fetch(`${col(id)}/rows/${encodeURIComponent(rowId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ values }),
      }),
    );
  },

  async deleteRow(id, rowId) {
    await expectOk(
      await fetch(`${col(id)}/rows/${encodeURIComponent(rowId)}`, {
        method: 'DELETE',
      }),
    );
  },
};
