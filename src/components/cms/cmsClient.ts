// src/components/cms/cmsClient.ts
//
// The browser-side client for COLLECTION-level CMS operations the content
// manager panel performs: list / create / rename / delete. It wraps the
// admin-guarded /api/cms/collections routes and preserves the TYPED error
// contract end to end: a non-OK response is parsed into a CmsClientError carrying
// the envelope's `code`/`message`/`status`, so the panel renders the SPECIFIC
// error inline (for example `collection_exists`) instead of a generic failure. A
// failure is never swallowed into a resolved value that would read as success.
//
// In-collection editing (columns/rows/options/relations/files) is NOT done here:
// the grid overlay drives it through the data-table server-actions adapter. The
// narrow column/row write routes this client used to call were removed with the
// hand-rolled FieldEditor/RowEditor they served.
//
// Admin auth: writes are same-origin requests; the interim admin secret rides the
// `admin_secret` cookie (see src/server/auth/guard.ts), which the browser
// attaches automatically. The client therefore sends no secret itself.

import type { Collection } from '@/lib/bindings/dataSource/types';

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

/**
 * The collection-CRUD surface the panel depends on. Declaring it as an interface
 * lets tests inject a fake implementation without mocking global fetch.
 */
export interface CmsClient {
  listCollections(): Promise<Collection[]>;
  createCollection(name: string): Promise<Collection>;
  renameCollection(id: string, name: string): Promise<void>;
  deleteCollection(id: string): Promise<void>;
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
};
