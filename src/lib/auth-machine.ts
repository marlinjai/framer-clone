import 'server-only';

/**
 * auth-machine.ts -- the machine door: a request carrying a company API key
 * from auth-brain (`Authorization: Bearer <key>`), for the MCP endpoint at
 * `/api/mcp` (docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, step 2).
 * Modelled on Lumitra Booking (`apps/web/src/lib/session.ts`) and Lumitra
 * Studio (`src/lib/auth/verifyRequest.ts`).
 *
 * WHAT A KEY MUST BE (verifyCompanyKey), checked in this order:
 *
 *   1. A bearer at all, of a plausible shape. A request with a Bearer header is
 *      judged by it alone: the browser session that came along is never read
 *      (src/lib/bearer.ts; the middleware also strips the cookie).
 *   2. Known to auth-brain (`verifyApiKey`). Unknown, revoked, expired or
 *      malformed is `refused` (401). auth-brain unreachable, a 5xx, a 408 or a
 *      429 is `unavailable` (503 with retry-after): the key may be fine, the
 *      caller retries and must not conclude it was revoked.
 *   3. Scoped to ONE company (`principal.scope.type === 'tenant'`). A workspace
 *      or tenant-group key is `refused`: its scope is never widened or narrowed.
 *   4. Carrying the `sites` app grant on that company. Without it `forbidden`
 *      (403, `sites_not_enabled`). A scope with no `app_grants` field at all is
 *      an older auth-brain build: failed closed the same way, logged distinctly.
 *   5. Mapped to the company's sites workspace by the SERVER, from the company
 *      id of the verified key (resolveScopeForKey, src/server/sites/scope.ts):
 *      no workspace, several, or a broken structure is `forbidden`; OpenFGA not
 *      answering is `unavailable`. Nothing the request names is ever read.
 *
 * WHAT A KEY MAY DO (authorizeKeyAction). Default deny. A key acts as at most a
 * workspace admin of its own company's sites workspace, and only for the
 * actions an agent needs:
 *
 *   | action                           | allowed for a key when                          |
 *   | -------------------------------- | ----------------------------------------------- |
 *   | viewSite                         | its workspace role satisfies `workspace.viewer` |
 *   | editSite, publishSite            | its workspace role satisfies `workspace.admin`  |
 *   | manageDomain                     | never (custom domains stay a person's job)      |
 *   | eraseSiteData                    | never (needs the company owner's session)       |
 *   | viewBooks, editBooks             | never (the Books have their own `books` grant)  |
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
 * CACHING AND REVOCATION. A successful verification (key, company, scope and
 * role) is kept in this process for KEY_CACHE_TTL_MS (10 seconds), keyed by a
 * SHA-256 of the key, never the key; at most KEY_CACHE_MAX entries, the oldest
 * evicted first. Refusals and outages are never cached. So a key revoked, a
 * role lowered or the `sites` grant withdrawn in auth-brain stops working in
 * this process within 10 seconds, and immediately after a restart.
 *
 * AUDIT. framer-clone has no audit table for site actions (only the Books
 * events and the erasure rows), so every machine decision is one structured
 * log line `[machine-audit] {...}` with the key id, service account, company,
 * workspace, action and outcome (auditMachineAction). The key itself is never
 * logged, echoed, or put in an error; redactSecrets masks anything key-shaped
 * in a message before it is logged.
 */

import { createHash } from 'node:crypto';
import type { ApiKeyVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { authBrainClient } from './auth-brain';
import { isAuthServiceFailure } from './authBrainAvailability';
import { presentedBearer } from './bearer';
import { readCompanyStructure } from './openfgaRead';
import { FRAMER_PERMISSIONS, type FramerAction } from './permissions';
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
]);

export const KEY_CACHE_TTL_MS = 10_000;
export const KEY_CACHE_MAX = 256;

/** A verified company key: who it is, which company, and where it acts. */
export interface VerifiedKey {
  kind: 'key';
  tenantId: string;
  keyId: string;
  serviceAccountId: string;
  /** The company's sites workspace and tenant group, resolved by the server. */
  scope: TenantScope;
  /** The key's effective role on `scope.workspaceId`, or null for none. */
  workspaceRole: WorkspaceRole | null;
}

export type ForbiddenReason = 'sites_not_enabled' | KeyScopeError;

/** What a bearer turned out to be. */
export type CompanyKey =
  | VerifiedKey
  /** No usable credential: absent, malformed, unknown, revoked, expired, or not a company key. A 401. */
  | { kind: 'refused' }
  /** A valid company key that may not use Lumitra Sites here. A 403. */
  | { kind: 'forbidden'; reason: ForbiddenReason; keyId: string; tenantId: string }
  /** auth-brain or OpenFGA could not answer now. A 503; the key may be fine. */
  | { kind: 'unavailable' };

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
 * no audit table for site actions (see the file header). Never the key.
 */
export function auditMachineAction(
  key: Pick<VerifiedKey, 'keyId' | 'serviceAccountId' | 'tenantId'> & { scope?: TenantScope },
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

// The verification cache

interface CacheEntry {
  expiresAt: number;
  key: VerifiedKey;
}

const keyCache = new Map<string, CacheEntry>();

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

function remember(id: string, key: VerifiedKey, now: number): void {
  keyCache.delete(id);
  while (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest === undefined) break;
    keyCache.delete(oldest);
  }
  keyCache.set(id, { expiresAt: now + KEY_CACHE_TTL_MS, key });
}

/** Empty the verification cache (tests, and nothing else). */
export function clearKeyCache(): void {
  keyCache.clear();
}

/** How many verifications are cached (tests). */
export function keyCacheSize(): number {
  return keyCache.size;
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
 * scope (a site of another workspace or tenant group) is a denial.
 */
export function authorizeKeyAction(
  key: VerifiedKey,
  action: FramerAction,
  target?: { workspaceId?: string; tenantGroupId?: string; siteId?: string },
): boolean {
  const auditTarget = target
    ? Object.fromEntries(Object.entries(target).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : undefined;
  const deny = (reason: string) => {
    auditMachineAction(key, { action, outcome: 'denied', reason, target: auditTarget });
    return false;
  };
  if (!MACHINE_ACTIONS.has(action)) return deny('action_not_allowed_for_keys');
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

async function verifyFresh(presented: string): Promise<CompanyKey> {
  let verified: ApiKeyVerifyResponse | null;
  try {
    verified = await authBrainClient.verifyApiKey(presented);
  } catch (err) {
    if (!isAuthServiceFailure(err)) return { kind: 'refused' };
    console.error(
      '[machine-auth] api key verify unavailable:',
      redactSecrets(err instanceof Error ? err.message : String(err), presented),
    );
    return { kind: 'unavailable' };
  }
  if (!verified) return { kind: 'refused' };

  const scope = verified.principal?.scope;
  const keyId = verified.key?.id;
  const serviceAccountId = verified.principal?.id;
  if (typeof keyId !== 'string' || !keyId || typeof serviceAccountId !== 'string' || !serviceAccountId) {
    return { kind: 'refused' };
  }
  if (!scope || scope.type !== 'tenant' || typeof scope.id !== 'string' || !scope.id) {
    console.warn('[machine-auth] refused a key that is not scoped to one company', JSON.stringify({ keyId, scopeType: scope?.type }));
    return { kind: 'refused' };
  }
  const tenantId = scope.id;
  const grants = (scope as { app_grants?: unknown }).app_grants;
  if (grants === undefined) console.error(`[app-grants] ${APP_GRANT_SKEW_MESSAGE} (apiKey.principal.scope)`);
  if (!Array.isArray(grants) || !grants.includes(SITES_APP)) {
    auditMachineAction({ keyId, serviceAccountId, tenantId }, { action: 'authenticate', outcome: 'denied', reason: 'sites_not_enabled' });
    return { kind: 'forbidden', reason: 'sites_not_enabled', keyId, tenantId };
  }

  let structure: Awaited<ReturnType<typeof readCompanyStructure>>;
  try {
    structure = await readCompanyStructure(tenantId);
  } catch (err) {
    console.error('[machine-auth] company structure unavailable:', redactSecrets(err instanceof Error ? err.message : String(err)));
    return { kind: 'unavailable' };
  }
  const resolved = resolveScopeForKey(structure);
  if (!resolved.ok) {
    auditMachineAction({ keyId, serviceAccountId, tenantId }, { action: 'authenticate', outcome: 'denied', reason: resolved.error });
    return { kind: 'forbidden', reason: resolved.error, keyId, tenantId };
  }

  return {
    kind: 'key',
    tenantId,
    keyId,
    serviceAccountId,
    scope: resolved.scope,
    workspaceRole: keyWorkspaceRole(verified, tenantId, resolved.scope.workspaceId),
  };
}

/**
 * Resolve a request's bearer to a company key, a refusal, a 403 or an outage.
 * Never throws on a normal failure path, never reads the session cookie, never
 * logs the key. A request without a bearer is `refused`: call this only for a
 * request that carriesBearer, or for a machine-only route.
 */
export async function verifyCompanyKey(request: Request, now: () => number = Date.now): Promise<CompanyKey> {
  const presented = presentedBearer(request);
  if (!presented || !KEY_SHAPE.test(presented)) return { kind: 'refused' };

  const id = cacheId(presented);
  const hit = cached(id, now());
  if (hit) return hit;

  const result = await verifyFresh(presented);
  if (result.kind === 'key') {
    remember(id, result, now());
    auditMachineAction(result, { action: 'authenticate', outcome: 'allowed' });
  }
  return result;
}

/**
 * The response a route answers for a key that did not verify: 401 with
 * `WWW-Authenticate: Bearer` (so an MCP client knows to send a key), 403 with
 * the reason, 503 with retry-after. Never echoes the key.
 */
export function machineAuthDenial(result: Exclude<CompanyKey, VerifiedKey>): Response {
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
        : "this key's company has no sites workspace the key can act in";
    return Response.json({ error: { code: result.reason, message } }, { status: 403 });
  }
  return Response.json(
    { error: { code: 'unauthorized', message: 'a valid company API key is required' } },
    { status: 401, headers: { 'www-authenticate': 'Bearer realm="lumitra-sites"' } },
  );
}
