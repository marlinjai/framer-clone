import 'server-only';

/**
 * auth-machine.ts -- the machine door: a request carrying a company API key
 * from auth-brain (`Authorization: Bearer <key>`), for the MCP endpoint at
 * `/api/mcp` (docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, step 2).
 * Modelled on Lumitra Booking (`apps/web/src/lib/session.ts`) and Lumitra
 * Studio (`src/lib/auth/verifyRequest.ts`).
 *
 * THE ROUTE IS THE GATE. The middleware only decides which credential a path
 * accepts; it never verifies a key. Every handler behind `/api/mcp` must call
 * verifyCompanyKey itself and refuse anything but `kind: 'key'`.
 *
 * WHAT A KEY MUST BE (verifyCompanyKey), checked in this order:
 *
 *   0. Not from a client that keeps presenting bad keys: refused or malformed
 *      keys are counted per client address (an IPv6 address by its /64) and
 *      globally, and over the limit the answer is `throttled` (429 with
 *      retry-after) without asking auth-brain. The global limit never locks
 *      out a key that verified successfully within the last hour (it is still
 *      verified again every time), so a flood only slows keys never seen good.
 *      Accepted trade-off: neighbours on one shared IPv6 /64 share a refused-key
 *      bucket, so one of them presenting bad keys can throttle the others' new
 *      keys for up to a minute (REFUSAL_WINDOW_MS).
 *   1. A bearer at all, of a plausible shape. A request with a Bearer header is
 *      judged by it alone: the browser session that came along is never read
 *      (src/lib/bearer.ts; the middleware also strips the cookie).
 *   2. Known to auth-brain (`verifyApiKey`). Unknown, revoked, expired or
 *      malformed is `refused` (401). auth-brain unreachable, a 5xx, a 408 or a
 *      429 is
 *      `unavailable` (503 with retry-after): the key may be fine, the caller
 *      retries and must not conclude it was revoked.
 *   3. A service account's key scoped to ONE company
 *      (`principal.type === 'service_account'`, `principal.scope.type ===
 *      'tenant'`). Anything else is `refused`: a scope is never widened or
 *      narrowed.
 *   4. Carrying the `sites` app grant on that company. Without it `forbidden`
 *      (403, `sites_not_enabled`). A scope with no `app_grants` field at all is
 *      an older auth-brain build: failed closed the same way, logged distinctly.
 *   5. Mapped to the company's sites workspace by the SERVER, from the company
 *      id of the verified key (resolveScopeForKey, src/server/sites/scope.ts,
 *      over OpenFGA's structural edges, src/lib/openfgaRead.ts): no workspace,
 *      several, or a broken structure is `forbidden`; OpenFGA not answering is
 *      `unavailable`. Nothing the request names is ever read.
 *   6. Cross-checked against the site rows already in that workspace: every
 *      site there must carry the key's tenant group, and every site stamped
 *      with a company must name the key's company. A mismatch (a workspace
 *      moved between companies while auth-brain's sync to OpenFGA lags) is
 *      `forbidden` (`workspace_mismatch`) and logged. The residual risk (an
 *      empty workspace, or a move within one tenant group) is written down in
 *      the plan as accepted.
 *
 * WHAT A KEY MAY DO (authorizeKeyAction). Default deny. A key acts as at most a
 * workspace admin of its own company's sites workspace, and only for the
 * actions an agent needs:
 *
 *   | action                           | allowed for a key when                          |
 *   | -------------------------------- | ----------------------------------------------- |
 *   | viewSite                         | its workspace role satisfies `workspace.viewer` |
 *   | editSite, publishSite            | its workspace role satisfies `workspace.admin`  |
 *   | mergeBranch                      | its workspace role satisfies `workspace.admin`; |
 *   |                                  | the merge_branch tool also needs a person's     |
 *   |                                  | approval (src/server/mcp/tools.ts)              |
 *   | manageDomain                     | never (custom domains stay a person's job)      |
 *   | eraseSiteData                    | never (needs the company owner's session)       |
 *   | viewBooks                        | the company holds the `books` app grant AND the |
 *   |                                  | role satisfies `workspace.admin` (the read-only |
 *   |                                  | Books endpoint, /api/machine/books/documents)   |
 *   | editBooks                        | never (writing invoices stays a person's job)   |
 *   | any action added later           | never, until it is added to MACHINE_ACTIONS     |
 *
 * The required role comes from FRAMER_PERMISSIONS (src/lib/permissions.ts), the
 * same map the cookie path checks through OpenFGA, so a key can never need less
 * than a person. Its workspace role is read from the verify answer, which
 * auth-brain computes from the same OpenFGA model:
 *
 *   - the key's entry in `effective_roles.workspaces` for that workspace, and
 *   - the cascade the model defines from its company role: a company `owner`
 *     or `admin` is an effective workspace `admin` of the company's
 *     workspaces. `billing_admin`, `member` and `viewer` reach no workspace
 *     (plain membership never cascades in auth-brain's model), so such a key
 *     may not even read a site. The company role is `effective_roles.tenants`
 *     for the key's company, else `principal.role`, which is what auth-brain
 *     reports when its own OpenFGA read degraded. An unknown role string
 *     grants nothing.
 *
 *   The higher of the two counts. The workspace ladder tops out at `admin`, so
 *   no key reaches more than a workspace admin has.
 *
 * Which SITE a key may touch is not decided here: tenant isolation for site
 * operations comes from the site repository, whose every query is filtered by
 * the key's `scope` (workspace and tenant group). A site of another company is
 * simply not found. authorizeKeyAction therefore takes no site id.
 *
 * DEADLINE. The whole fresh verification (auth-brain, the OpenFGA reads, the
 * site-row query) must finish within KEY_VERIFY_TIMEOUT_MS, else the answer is
 * `unavailable`. Underneath, the auth-brain request itself is aborted by its
 * own fetch deadline (src/lib/auth-brain-machine.ts), each OpenFGA read has
 * one (src/lib/openfgaRead.ts), and the site-row query runs under a Postgres
 * statement timeout, so nothing stays hung behind the answer.
 *
 * CACHING AND REVOCATION. A successful verification (key, company, scope and
 * role) is kept in this process, frozen, for KEY_CACHE_TTL_MS (10 seconds) or
 * until the key's own `expires_at`, whichever comes first; keyed by a SHA-256 of
 * the key, never the key; at most KEY_CACHE_MAX entries, the oldest evicted
 * first. Refusals and outages are never cached. So a key revoked, a role
 * lowered or the `sites` grant withdrawn in auth-brain stops working in this
 * process within 10 seconds, and immediately after a restart. Concurrent
 * verifications of the same key share one round trip.
 *
 * AUDIT. framer-clone has no audit table for machine authentication, so every
 * machine decision is one structured log line `[machine-audit] {...}` with the
 * key id, service account, company, workspace, action and outcome
 * (auditMachineAction). Site writes get their own audit rows from the site
 * operations (step 3 of the plan). The key itself is never logged, echoed, or
 * put in an error; redactSecrets masks anything key-shaped in a message before
 * it is logged.
 */

import { createHash } from 'node:crypto';
import type { ApiKeyVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { sanitizeLiveLabel } from '@/lib/projects/liveEvents';
import { machineAuthBrainClient } from './auth-brain-machine';
import { isAuthServiceFailure } from './authBrainAvailability';
import { presentedBearer } from './bearer';
import { readCompanyStructure } from './openfgaRead';
import { FRAMER_PERMISSIONS, type FramerAction } from './permissions';
import { getPrismaClient } from '@/server/db';
import {
  APP_GRANT_SKEW_MESSAGE,
  SITES_APP,
  resolveScopeForKey,
  type KeyScopeError,
} from '@/server/sites/scope';
import type { TenantScope } from '@/server/sites/repository';

export { carriesBearer } from './bearer';

/** A workspace role on auth-brain's ladder, highest first. */
export type WorkspaceRole = 'admin' | 'member' | 'viewer';
const WORKSPACE_LADDER: readonly WorkspaceRole[] = ['admin', 'member', 'viewer'];

/** Company roles whose holder auth-brain's model makes an effective workspace admin. */
const CASCADING_COMPANY_ROLES = new Set(['owner', 'admin']);

/** The actions a key may ever perform. Everything else is denied, whatever the key's role. */
export const MACHINE_ACTIONS: ReadonlySet<FramerAction> = new Set<FramerAction>([
  'viewSite',
  'editSite',
  'publishSite',
  'mergeBranch',
  'viewBooks',
]);

/** The auth-brain app grant a company needs before a key may read its Books (same slug as src/server/books/access.ts). */
export const BOOKS_APP_GRANT = 'books';

export const KEY_CACHE_TTL_MS = 10_000;
export const KEY_CACHE_MAX = 256;
/** How long a whole fresh verification may take before the answer is `unavailable`. */
export const KEY_VERIFY_TIMEOUT_MS = 8_000;
/** The Postgres statement timeout of the site-row check. */
export const SITE_ROW_STATEMENT_TIMEOUT_MS = 2_000;
/** How long a key that verified successfully bypasses the global refusal limit. */
export const KNOWN_GOOD_TTL_MS = 60 * 60_000;
/** Key hashes remembered as recently good; the oldest is dropped beyond it. */
export const KNOWN_GOOD_MAX = 4096;
/** The window refused keys are counted in. */
export const REFUSAL_WINDOW_MS = 60_000;
/** Refused or malformed keys one client address may present per window. */
export const REFUSALS_PER_CLIENT = 20;
/** Refused or malformed keys all clients together may present per window. */
export const REFUSALS_GLOBAL = 600;
/** Client addresses tracked at once; the oldest window is dropped beyond it. */
export const MAX_TRACKED_CLIENTS = 1024;

/** A verified company key: who it is, which company, and where it acts. Frozen. */
export interface VerifiedKey {
  readonly kind: 'key';
  readonly tenantId: string;
  /** The company's auth-brain slug (its shop schema is named after it when a first site is created). */
  readonly companySlug: string;
  readonly keyId: string;
  /**
   * The key's name as auth-brain holds it, sanitised for display (an open
   * editor names the agent by it), or undefined when the key has none.
   */
  readonly keyName?: string;
  readonly serviceAccountId: string;
  /** The company's sites workspace and tenant group, resolved by the server. */
  readonly scope: Readonly<TenantScope>;
  /** The key's effective role on `scope.workspaceId`, or null for none. */
  readonly workspaceRole: WorkspaceRole | null;
  /** The auth-brain app grants of the key's company, as its verify answer stated them (frozen). */
  readonly appGrants: readonly string[];
}

export type ForbiddenReason = 'sites_not_enabled' | 'workspace_mismatch' | KeyScopeError;

/** What a bearer turned out to be. */
export type CompanyKey =
  | VerifiedKey
  /** No usable credential: absent, malformed, unknown, revoked, expired, or not a company key. A 401. */
  | { kind: 'refused' }
  /** A valid company key that may not use Lumitra Sites here. A 403. */
  | { kind: 'forbidden'; reason: ForbiddenReason; keyId: string; tenantId: string }
  /** auth-brain, OpenFGA or the database could not answer now. A 503; the key may be fine. */
  | { kind: 'unavailable' }
  /** Too many refused keys from this client, or from everyone. A 429. */
  | { kind: 'throttled'; retryAfterSeconds: number };

// Redaction and audit

/** Mask anything key-shaped (and the exact presented key, when given) in a message before it is logged. */
export function redactSecrets(text: string, presented?: string | null): string {
  let out = text;
  if (presented) out = out.split(presented).join('[REDACTED]');
  return out.replace(/\bsk_[A-Za-z0-9_-]{6,}/g, 'sk_[REDACTED]');
}

export type AuditOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed';

/**
 * Record one machine action. A structured log line, because framer-clone has
 * no audit table for machine authentication (see the file header). Never the key.
 */
export function auditMachineAction(
  key: Pick<VerifiedKey, 'keyId' | 'serviceAccountId' | 'tenantId'> & { scope?: Readonly<TenantScope> },
  entry: { action: string; outcome: AuditOutcome; target?: Record<string, string>; reason?: string },
): void {
  console.info(
    '[machine-audit]',
    JSON.stringify({
      at: new Date().toISOString(),
      keyId: key.keyId,
      serviceAccountId: key.serviceAccountId,
      tenantId: key.tenantId,
      workspaceId: key.scope?.workspaceId,
      tenantGroupId: key.scope?.tenantGroupId,
      action: entry.action,
      outcome: entry.outcome,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.target ? { target: entry.target } : {}),
    }),
  );
}

// The verification cache and the in-flight verifications

interface CacheEntry {
  expiresAt: number;
  key: VerifiedKey;
}

const keyCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<FreshResult>>();

/**
 * Hashes of keys that verified successfully, with when. Never a credential on
 * its own: a known-good key is verified against auth-brain like any other. It
 * only lets that key past the GLOBAL refusal limit, so a flood of bad keys
 * cannot lock out the agents that were working before it.
 */
const knownGood = new Map<string, number>();

function isKnownGood(id: string, now: number): boolean {
  const at = knownGood.get(id);
  if (at === undefined) return false;
  if (now - at >= KNOWN_GOOD_TTL_MS) {
    knownGood.delete(id);
    return false;
  }
  return true;
}

function rememberGood(id: string, now: number): void {
  knownGood.delete(id);
  while (knownGood.size >= KNOWN_GOOD_MAX) {
    const oldest = knownGood.keys().next().value;
    if (oldest === undefined) break;
    knownGood.delete(oldest);
  }
  knownGood.set(id, now);
}

function cacheId(presented: string): string {
  return createHash('sha256').update(presented).digest('hex');
}

function cached(id: string, now: number): VerifiedKey | null {
  const entry = keyCache.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    keyCache.delete(id);
    return null;
  }
  return entry.key;
}

function remember(id: string, key: VerifiedKey, expiresAt: number): void {
  keyCache.delete(id);
  while (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest === undefined) break;
    keyCache.delete(oldest);
  }
  keyCache.set(id, { expiresAt, key });
}

/** Empty the verification cache and the refusal counters (tests, and nothing else). */
export function clearKeyCache(): void {
  keyCache.clear();
  inFlight.clear();
  knownGood.clear();
  clientRefusals.clear();
  globalRefusals.windowStart = 0;
  globalRefusals.count = 0;
}

/** How many verifications are cached (tests). */
export function keyCacheSize(): number {
  return keyCache.size;
}

// Throttling refused keys

interface RefusalWindow {
  windowStart: number;
  count: number;
}

const clientRefusals = new Map<string, RefusalWindow>();
const globalRefusals: RefusalWindow = { windowStart: 0, count: 0 };

/**
 * The bucket an address is counted in: an IPv4 address whole, an IPv6 address
 * by its /64 (one host usually holds a whole /64, so counting single IPv6
 * addresses would let it rotate freely). An IPv4-mapped IPv6 address counts as
 * its IPv4 address. Exported for tests.
 */
export function addressBucket(address: string): string {
  const raw = address.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!raw.includes(':')) return raw;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1];
  // The same mapping written in hex (`::ffff:c000:280` is 192.0.2.128).
  const mappedHex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(raw);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  const halves = raw.split('::');
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return raw;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The client address of a request, as its throttle bucket. The rightmost
 * `x-forwarded-for` entry is the one the proxy in front of the app (Traefik)
 * appended, so a client cannot pick it; entries to its left are whatever the
 * client sent. Rotating forged addresses therefore buys nothing, and the
 * global limit caps the rest.
 *
 * If app.lumitra.co is ever proxied through Cloudflare, the rightmost entry
 * becomes a Cloudflare edge address and this must read `cf-connecting-ip`
 * first, as src/server/forms/rateLimit.ts (clientIpOf) does.
 */
function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const last = forwarded?.split(',').map((p) => p.trim()).filter(Boolean).pop();
  return addressBucket(last || request.headers.get('x-real-ip')?.trim() || 'unknown');
}

function liveWindow(w: RefusalWindow | undefined, now: number): RefusalWindow | null {
  return w && now - w.windowStart < REFUSAL_WINDOW_MS ? w : null;
}

function retryAfter(w: RefusalWindow, now: number): number {
  return Math.max(1, Math.ceil((w.windowStart + REFUSAL_WINDOW_MS - now) / 1000));
}

function clientThrottle(client: string, now: number): CompanyKey | null {
  const w = liveWindow(clientRefusals.get(client), now);
  return w && w.count >= REFUSALS_PER_CLIENT ? { kind: 'throttled', retryAfterSeconds: retryAfter(w, now) } : null;
}

function globalThrottle(now: number): CompanyKey | null {
  const w = liveWindow(globalRefusals, now);
  return w && w.count >= REFUSALS_GLOBAL ? { kind: 'throttled', retryAfterSeconds: retryAfter(w, now) } : null;
}

function recordRefusal(client: string, now: number): void {
  if (!liveWindow(globalRefusals, now)) {
    globalRefusals.windowStart = now;
    globalRefusals.count = 0;
  }
  globalRefusals.count++;

  const live = liveWindow(clientRefusals.get(client), now);
  if (live) {
    live.count++;
    return;
  }
  clientRefusals.delete(client);
  if (clientRefusals.size >= MAX_TRACKED_CLIENTS) {
    for (const [addr, w] of clientRefusals) if (!liveWindow(w, now)) clientRefusals.delete(addr);
    while (clientRefusals.size >= MAX_TRACKED_CLIENTS) {
      const oldest = clientRefusals.keys().next().value;
      if (oldest === undefined) break;
      clientRefusals.delete(oldest);
    }
  }
  clientRefusals.set(client, { windowStart: now, count: 1 });
}

// Roles

function rank(role: string | null | undefined): number {
  const i = WORKSPACE_LADDER.indexOf(role as WorkspaceRole);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/**
 * The key's effective workspace role on `workspaceId` of its company
 * `tenantId` (see the file header for the rule). Pure; exported for tests.
 */
export function keyWorkspaceRole(
  verified: Pick<ApiKeyVerifyResponse, 'principal' | 'effective_roles'>,
  tenantId: string,
  workspaceId: string,
): WorkspaceRole | null {
  const candidates: string[] = [];
  const workspaces = verified.effective_roles?.workspaces;
  if (Array.isArray(workspaces)) {
    for (const e of workspaces) if (e?.id === workspaceId && typeof e.role === 'string') candidates.push(e.role);
  }
  const companyRoles: string[] = [];
  const tenants = verified.effective_roles?.tenants;
  if (Array.isArray(tenants)) {
    for (const e of tenants) if (e?.id === tenantId && typeof e.role === 'string') companyRoles.push(e.role);
  }
  if (companyRoles.length === 0 && typeof verified.principal?.role === 'string') companyRoles.push(verified.principal.role);
  if (companyRoles.some((r) => CASCADING_COMPANY_ROLES.has(r))) candidates.push('admin');

  let best: WorkspaceRole | null = null;
  for (const role of candidates) if (rank(role) < rank(best)) best = role as WorkspaceRole;
  return best;
}

/** The workspace role an action needs, or null when the action is not a workspace check. */
function requiredWorkspaceRole(action: FramerAction): WorkspaceRole | null {
  const [scope, role] = FRAMER_PERMISSIONS[action].requires.split('.');
  return scope === 'workspace' && WORKSPACE_LADDER.includes(role as WorkspaceRole) ? (role as WorkspaceRole) : null;
}

/**
 * Whether the key may perform `action`, audited either way. Default deny: an
 * action outside MACHINE_ACTIONS, a key without a workspace role, a role below
 * the one FRAMER_PERMISSIONS requires, or a `target` outside the key's own
 * scope (another workspace or tenant group) is a denial. No site id: which
 * sites a key reaches is decided by the repository queries scoped to
 * `key.scope` (see the file header).
 */
export function authorizeKeyAction(
  key: VerifiedKey,
  action: FramerAction,
  target?: { workspaceId?: string; tenantGroupId?: string },
): boolean {
  const auditTarget = target
    ? Object.fromEntries(Object.entries(target).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : undefined;
  const deny = (reason: string) => {
    auditMachineAction(key, { action, outcome: 'denied', reason, target: auditTarget });
    return false;
  };
  if (!MACHINE_ACTIONS.has(action)) return deny('action_not_allowed_for_keys');
  // The Books are an app of their own: reading them needs the company's `books` grant on top of the role.
  if (action === 'viewBooks' && !key.appGrants.includes(BOOKS_APP_GRANT)) return deny('books_not_enabled');
  if (target?.workspaceId !== undefined && target.workspaceId !== key.scope.workspaceId) return deny('foreign_workspace');
  if (target?.tenantGroupId !== undefined && target.tenantGroupId !== key.scope.tenantGroupId) {
    return deny('foreign_tenant_group');
  }
  const required = requiredWorkspaceRole(action);
  if (!required) return deny('action_not_allowed_for_keys');
  if (key.workspaceRole === null || rank(key.workspaceRole) > rank(required)) return deny('insufficient_role');
  auditMachineAction(key, { action, outcome: 'allowed', target: auditTarget });
  return true;
}

// Verification

/** A plausible key: no whitespace, printable, bounded. Anything else never reaches auth-brain. */
const KEY_SHAPE = /^[A-Za-z0-9_\-.~+/=]{16,512}$/;

/**
 * The fresh verification, bounded by KEY_VERIFY_TIMEOUT_MS as a whole: past the
 * deadline the answer is `unavailable`, whichever step was slow.
 */
function verifyFreshWithDeadline(presented: string): Promise<FreshResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FreshResult>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[machine-auth] key verification took longer than ${KEY_VERIFY_TIMEOUT_MS} ms; answering unavailable`);
      resolve(unavailableResult);
    }, KEY_VERIFY_TIMEOUT_MS);
  });
  return Promise.race([verifyFresh(presented), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Whether the site rows already in `scope.workspaceId` agree with the key's
 * company: every row carries the scope's tenant group, and every row stamped
 * with a company names `tenantId`. Throws when the database cannot answer.
 */
async function siteRowsAgree(scope: TenantScope, tenantId: string): Promise<boolean> {
  const mismatch = await getPrismaClient().$transaction(
    async (tx) => {
      // A constant, never interpolated: SET takes no bind parameters.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${SITE_ROW_STATEMENT_TIMEOUT_MS}`);
      // Ask for one disagreeing row instead of sampling: a sample could miss it.
      return tx.site.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          OR: [
            { tenantGroupId: { not: scope.tenantGroupId } },
            { AND: [{ companyId: { not: null } }, { companyId: { not: tenantId } }] },
          ],
        },
        select: { id: true },
      });
    },
    { timeout: SITE_ROW_STATEMENT_TIMEOUT_MS + 1_000 },
  );
  return mismatch === null;
}

type FreshResult = { result: CompanyKey; keyExpiresAt: number | null };

const refusedResult: FreshResult = { result: { kind: 'refused' }, keyExpiresAt: null };
const unavailableResult: FreshResult = { result: { kind: 'unavailable' }, keyExpiresAt: null };

async function verifyFresh(presented: string): Promise<FreshResult> {
  let verified: ApiKeyVerifyResponse | null;
  try {
    verified = await machineAuthBrainClient.verifyApiKey(presented);
  } catch (err) {
    if (!isAuthServiceFailure(err)) return refusedResult;
    console.error(
      '[machine-auth] api key verify unavailable:',
      redactSecrets(err instanceof Error ? err.message : String(err), presented),
    );
    return unavailableResult;
  }
  if (!verified) return refusedResult;

  const principal = verified.principal;
  const scope = principal?.scope;
  const keyId = verified.key?.id;
  const serviceAccountId = principal?.id;
  if (
    principal?.type !== 'service_account' ||
    typeof keyId !== 'string' ||
    !keyId ||
    typeof serviceAccountId !== 'string' ||
    !serviceAccountId
  ) {
    return refusedResult;
  }
  if (!scope || scope.type !== 'tenant' || typeof scope.id !== 'string' || !scope.id) {
    console.warn('[machine-auth] refused a key that is not scoped to one company', JSON.stringify({ keyId, scopeType: scope?.type }));
    return refusedResult;
  }
  const tenantId = scope.id;
  // The slug names the company's shop schema when its first site is created
  // (createSite, like the editor's create route). A key without one is not a
  // well-formed company key.
  const companySlug = (scope as { slug?: unknown }).slug;
  if (typeof companySlug !== 'string' || !companySlug.trim()) {
    console.warn('[machine-auth] refused a company key whose verify answer names no company slug', JSON.stringify({ keyId }));
    return refusedResult;
  }
  const forbidden = (reason: ForbiddenReason): FreshResult => {
    auditMachineAction({ keyId, serviceAccountId, tenantId }, { action: 'authenticate', outcome: 'denied', reason });
    return { result: { kind: 'forbidden', reason, keyId, tenantId }, keyExpiresAt: null };
  };

  const grants = (scope as { app_grants?: unknown }).app_grants;
  if (grants === undefined) console.error(`[app-grants] ${APP_GRANT_SKEW_MESSAGE} (apiKey.principal.scope)`);
  if (!Array.isArray(grants) || !grants.includes(SITES_APP)) return forbidden('sites_not_enabled');

  let structure: Awaited<ReturnType<typeof readCompanyStructure>>;
  try {
    structure = await readCompanyStructure(tenantId);
  } catch (err) {
    console.error('[machine-auth] company structure unavailable:', redactSecrets(err instanceof Error ? err.message : String(err)));
    return unavailableResult;
  }
  const resolved = resolveScopeForKey(structure);
  if (!resolved.ok) return forbidden(resolved.error);

  let agree: boolean;
  try {
    agree = await siteRowsAgree(resolved.scope, tenantId);
  } catch (err) {
    console.error('[machine-auth] site rows unavailable for the workspace check:', redactSecrets(err instanceof Error ? err.message : String(err)));
    return unavailableResult;
  }
  if (!agree) {
    console.error(
      '[machine-auth] the workspace OpenFGA maps this company to holds sites of another company or tenant group',
      JSON.stringify({ keyId, tenantId, workspaceId: resolved.scope.workspaceId }),
    );
    auditMachineAction(
      { keyId, serviceAccountId, tenantId, scope: resolved.scope },
      { action: 'authenticate', outcome: 'failed', reason: 'workspace_mismatch' },
    );
    return { result: { kind: 'forbidden', reason: 'workspace_mismatch', keyId, tenantId }, keyExpiresAt: null };
  }

  const expires = verified.key?.expires_at ? Date.parse(verified.key.expires_at) : Number.NaN;
  const keyName = sanitizeLiveLabel(verified.key?.name);
  const key: VerifiedKey = Object.freeze({
    kind: 'key' as const,
    tenantId,
    companySlug,
    keyId,
    ...(keyName ? { keyName } : {}),
    serviceAccountId,
    scope: Object.freeze({ ...resolved.scope }),
    workspaceRole: keyWorkspaceRole(verified, tenantId, resolved.scope.workspaceId),
    appGrants: Object.freeze(grants.filter((g): g is string => typeof g === 'string')),
  });
  return { result: key, keyExpiresAt: Number.isFinite(expires) ? expires : null };
}

/**
 * Resolve a request's bearer to a company key, a refusal, a 403, a throttle or
 * an outage. Never throws on a normal failure path, never reads the session
 * cookie, never logs the key. A request without a bearer is `refused`: call
 * this only for a request that carriesBearer, or for a machine-only route.
 */
export async function verifyCompanyKey(request: Request, now: () => number = Date.now): Promise<CompanyKey> {
  const client = clientAddress(request);
  const throttledClient = clientThrottle(client, now());
  if (throttledClient) return throttledClient;

  const presented = presentedBearer(request);
  if (!presented || !KEY_SHAPE.test(presented)) {
    recordRefusal(client, now());
    return { kind: 'refused' };
  }

  const id = cacheId(presented);
  const hit = cached(id, now());
  if (hit) return hit;

  // A flood of bad keys from many addresses: keys never seen good wait; a cached
  // key (above) or one that verified within the last hour still goes through.
  if (!isKnownGood(id, now())) {
    const throttledAll = globalThrottle(now());
    if (throttledAll) return throttledAll;
  }

  let pending = inFlight.get(id);
  const leader = !pending;
  if (!pending) {
    pending = verifyFreshWithDeadline(presented).finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  }
  const { result, keyExpiresAt } = await pending;

  if (result.kind === 'refused') {
    recordRefusal(client, now());
    knownGood.delete(id);
  }
  // A key that may no longer use Sites here is no longer "known good" either.
  if (result.kind === 'forbidden') knownGood.delete(id);
  if (leader && result.kind === 'key') {
    const at = now();
    remember(id, result, Math.min(at + KEY_CACHE_TTL_MS, keyExpiresAt ?? Number.POSITIVE_INFINITY));
    rememberGood(id, at);
    auditMachineAction(result, { action: 'authenticate', outcome: 'allowed' });
  }
  return result;
}

/**
 * The response a route answers for a key that did not verify: 401 with
 * `WWW-Authenticate: Bearer` (so an MCP client knows to send a key), 403 with
 * the reason, 429 and 503 with retry-after. Never echoes the key.
 */
export function machineAuthDenial(result: Exclude<CompanyKey, VerifiedKey>): Response {
  if (result.kind === 'throttled') {
    return Response.json(
      { error: { code: 'too_many_refused_keys', message: 'too many invalid API keys, retry later' } },
      { status: 429, headers: { 'retry-after': String(result.retryAfterSeconds) } },
    );
  }
  if (result.kind === 'unavailable') {
    return Response.json(
      { error: { code: 'auth_unavailable', message: 'the sign-in service is temporarily unavailable, retry shortly' } },
      { status: 503, headers: { 'retry-after': '5' } },
    );
  }
  if (result.kind === 'forbidden') {
    const message =
      result.reason === 'sites_not_enabled'
        ? 'Lumitra Sites is not enabled for this key'
        : result.reason === 'no_sites_workspace'
          ? "this key's company has no sites workspace yet; right after a company is created this can take a moment, retry shortly"
          : "this key's company has no sites workspace the key can act in";
    return Response.json({ error: { code: result.reason, message } }, { status: 403 });
  }
  return Response.json(
    { error: { code: 'unauthorized', message: 'a valid company API key is required' } },
    { status: 401, headers: { 'www-authenticate': 'Bearer realm="lumitra-sites"' } },
  );
}
