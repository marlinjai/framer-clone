// PrismaDataSourceProvider: the live DataSourceProvider. It satisfies the same
// read-only seam the renderer consumes through useDataSource(), but instead of
// holding data in process it reaches the server over the thin /api/cms/* READ
// routes (which delegate to the server-only src/server/cms repository, backed by
// adapter-prisma + Postgres). The renderer never imports this concrete class; it
// is mounted once at the root (EditorApp / PreviewShell), so the implementation
// is swappable.
//
// subscribe() is POLLING for Slice 2: it re-invokes onChange on a fixed cadence
// (default 5s). Real-time push (SSE / socket) is deferred to E6.
//
// Errors SURFACE: any non-OK response other than a 404 on a single-resource
// read throws, rather than resolving to an empty/`null` value that would read as
// success. A 404 on getCollection / getRow is the documented "not found" signal
// and maps to `null`.

import type { DataSourceProvider } from './provider';
import type { Collection, Query, Row, RowsPage } from './types';

interface ApiErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function describeFailure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorEnvelope;
    if (body?.error?.message) {
      return body.error.message;
    }
  } catch {
    // Non-JSON or empty body: fall through to the status text.
  }
  return `${res.status} ${res.statusText}`.trim();
}

export class PrismaDataSourceProvider implements DataSourceProvider {
  private readonly baseUrl: string;
  private readonly pollMs: number;

  constructor(opts?: { baseUrl?: string; pollMs?: number }) {
    // Default baseUrl is '' so requests are relative (same-origin) in the
    // browser. Tests inject an absolute baseUrl against a mocked fetch.
    this.baseUrl = opts?.baseUrl ?? '';
    this.pollMs = opts?.pollMs ?? 5000;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async listCollections(): Promise<Collection[]> {
    const res = await fetch(this.url('/api/cms/collections'));
    if (!res.ok) {
      throw new Error(
        `listCollections failed: ${await describeFailure(res)}`,
      );
    }
    return (await res.json()) as Collection[];
  }

  async getCollection(collectionId: string): Promise<Collection | null> {
    const res = await fetch(
      this.url(`/api/cms/collections/${encodeURIComponent(collectionId)}`),
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`getCollection failed: ${await describeFailure(res)}`);
    }
    return (await res.json()) as Collection;
  }

  async listRows(collectionId: string, query?: Query): Promise<RowsPage> {
    const path = `/api/cms/collections/${encodeURIComponent(collectionId)}/rows`;
    const search = query
      ? `?query=${encodeURIComponent(JSON.stringify(query))}`
      : '';
    const res = await fetch(this.url(`${path}${search}`));
    if (!res.ok) {
      throw new Error(`listRows failed: ${await describeFailure(res)}`);
    }
    return (await res.json()) as RowsPage;
  }

  async getRow(collectionId: string, rowId: string): Promise<Row | null> {
    const res = await fetch(
      this.url(
        `/api/cms/collections/${encodeURIComponent(collectionId)}/rows/${encodeURIComponent(rowId)}`,
      ),
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`getRow failed: ${await describeFailure(res)}`);
    }
    return (await res.json()) as Row;
  }

  /**
   * Polling subscription. Re-invokes `onChange` every `pollMs` to signal that
   * data the query depends on may have changed; the consumer re-reads through
   * the read methods. There is no server push in Slice 2. Returns an
   * unsubscribe function that clears the interval.
   */
  subscribe(
    _collectionId: string,
    _query: Query | undefined,
    onChange: () => void,
  ): () => void {
    const handle = setInterval(() => {
      onChange();
    }, this.pollMs);
    return () => {
      clearInterval(handle);
    };
  }
}

/**
 * Lazy singleton for app-wide use. The editor and preview shell both mount the
 * same instance so subscription cadence and config stay consistent and the
 * provider identity is stable across re-renders (mounting `new
 * PrismaDataSourceProvider()` inline would churn subscriptions every render).
 * Tests construct their own instance to stay isolated.
 */
let sharedInstance: PrismaDataSourceProvider | null = null;

export function getSharedPrismaDataSourceProvider(): PrismaDataSourceProvider {
  if (!sharedInstance) {
    sharedInstance = new PrismaDataSourceProvider();
  }
  return sharedInstance;
}
