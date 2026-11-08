// src/lib/openfgaRead.ts
//
// Read the company STRUCTURE (which tenant group a company hangs off, which
// workspaces belong to it) from OpenFGA, for a caller that has no browser
// session to read it from: a company API key (src/lib/auth-machine.ts).
//
// A browser session carries `tenants[].group_id` and `workspaces[].tenant_id`,
// so the cookie path never needs this. A key's verify answer carries only the
// company id, while the site tables are keyed by workspace AND tenant group
// (TenantScope). auth-brain writes exactly these structural edges into OpenFGA
// whenever a company or workspace is created or moved
// (auth-brain packages/app/src/lib/openfga/tuples.ts):
//
//   tenant_group:<g>  group   tenant:<t>      (a company hangs off its group)
//   tenant:<t>        tenant  workspace:<w>   (a workspace hangs off its company)
//
// so the same store that answers every permission check answers this too,
// with the same URL, store and pre-shared key (src/lib/auth-brain.ts). There
// is no auth-brain route a service account could ask instead.
//
// The edges arrive through auth-brain's ASYNCHRONOUS sync worker, so right
// after a company is created, or while a move is still in the worker's queue,
// they can lag behind auth-brain's database. Reads ask OpenFGA for
// HIGHER_CONSISTENCY (no cached answers); the lag of the sync worker itself
// remains and is written down as an accepted risk in
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md. The proper fix is a
// read-only auth-brain route a service account can ask for its own company's
// tenant group and workspaces.
//
// Failure is never an answer: a missing configuration, a network error, a
// non-OK status or an unreadable body THROWS OpenFgaReadError, which the
// caller turns into "unavailable" (a 503), never into "no such company".

const PAGE_SIZE = 100;
/** A company with more structural edges than this is not a real company; refuse rather than loop. */
const MAX_PAGES = 10;
const TIMEOUT_MS = 5_000;

export class OpenFgaReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenFgaReadError';
  }
}

export interface TupleKey {
  user?: string;
  relation?: string;
  object?: string;
}

export interface ReadOptions {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/**
 * Every tuple matching `tupleKey` (OpenFGA's Read API, paginated). `object` may
 * be a bare type (`workspace:`) when `user` is set, which lists every object of
 * that type the user is related to by `relation`.
 */
export async function readTuples(tupleKey: TupleKey, options: ReadOptions = {}): Promise<TupleKey[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const url = setting(env, 'OPENFGA_API_URL');
  const store = setting(env, 'OPENFGA_STORE_ID');
  if (!url || !store) throw new OpenFgaReadError('OpenFGA is not configured (OPENFGA_API_URL / OPENFGA_STORE_ID)');
  const token = setting(env, 'OPENFGA_API_TOKEN');
  const endpoint = `${url.replace(/\/+$/, '')}/stores/${encodeURIComponent(store)}/read`;

  const tuples: TupleKey[] = [];
  let continuation = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          tuple_key: tupleKey,
          page_size: PAGE_SIZE,
          // Skip OpenFGA's query cache: a company or workspace that was just moved
          // must not be answered from a stale cached read.
          consistency: 'HIGHER_CONSISTENCY',
          ...(continuation ? { continuation_token: continuation } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new OpenFgaReadError(`OpenFGA read failed: ${err instanceof Error ? err.name : 'network error'}`);
    }
    if (!res.ok) throw new OpenFgaReadError(`OpenFGA read answered ${res.status}`);
    let body: { tuples?: Array<{ key?: TupleKey }>; continuation_token?: string };
    try {
      body = await res.json();
    } catch {
      throw new OpenFgaReadError('OpenFGA read answered an unreadable body');
    }
    if (!Array.isArray(body?.tuples)) throw new OpenFgaReadError('OpenFGA read answered without tuples');
    for (const t of body.tuples) if (t?.key) tuples.push(t.key);
    continuation = typeof body.continuation_token === 'string' ? body.continuation_token : '';
    if (!continuation) return tuples;
  }
  throw new OpenFgaReadError(`OpenFGA read returned more than ${MAX_PAGES} pages`);
}

/** The id part of an OpenFGA object or user (`workspace:abc` -> `abc`), or null for another type. */
function idOf(value: string | undefined, type: string): string | null {
  if (typeof value !== 'string' || !value.startsWith(`${type}:`)) return null;
  const id = value.slice(type.length + 1);
  return id === '' ? null : id;
}

export interface CompanyStructure {
  /** Every tenant group the company hangs off (exactly one for a healthy company). */
  groupIds: string[];
  /** Every workspace of the company. */
  workspaceIds: string[];
}

/** The tenant group(s) and workspaces of one company, read from OpenFGA. Throws OpenFgaReadError. */
export async function readCompanyStructure(companyId: string, options: ReadOptions = {}): Promise<CompanyStructure> {
  const [groups, workspaces] = await Promise.all([
    readTuples({ object: `tenant:${companyId}`, relation: 'group' }, options),
    readTuples({ user: `tenant:${companyId}`, relation: 'tenant', object: 'workspace:' }, options),
  ]);
  const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null))];
  return {
    groupIds: unique(groups.filter((t) => t.object === `tenant:${companyId}`).map((t) => idOf(t.user, 'tenant_group'))),
    workspaceIds: unique(workspaces.filter((t) => t.user === `tenant:${companyId}`).map((t) => idOf(t.object, 'workspace'))),
  };
}
