---
name: cms-auth-middleware-dual-principal
track: cms
wave: 1
priority: P0
status: draft
depends_on: [cms-service-scaffold, cms-tenant-schema-bootstrap]
estimated_value: 9
estimated_cost: 5
owner: unassigned
---

# Auth middleware (dual principal: site-owner + end-user stub)

## Goal

Build the request authentication layer for the CMS service designed for two principal types from Day 1, with only one wired up. Site-owner principal (auth-brain cookie SSO) is the v1 implementation. End-user principal (Phase 2 `app_users` session token) is a stub that returns 401 with a structured "not yet implemented" error code, but its routes, types, and middleware shape are fully present. This is plan Revision F.2: design now, build later, avoid the API redesign cost. Routes are tagged with their accepted principal types; the middleware enforces.

## Scope

**In:**
- `Principal` discriminated union (`SiteOwner | EndUser`)
- `requireAuth(...accepts: PrincipalType[])` middleware factory
- Site-owner verifier: parses auth-brain session cookie, calls auth-brain's `verifySession` (or local-dev mock), returns `(userId, workspaceId, role)`
- Workspace resolution: from session OR from `X-Workspace-Id` header (when a user has multiple workspaces). Resolved workspace becomes part of the request context
- Tenant schema resolution: middleware calls `resolveTenantSchema(workspaceId)` from the bootstrap spec and attaches `tenantSchema` to context
- End-user verifier stub: any request presenting `Authorization: Bearer eu_*` returns `{ ok: false, code: 'END_USER_AUTH_NOT_IMPLEMENTED' }`. The route shape is wired so Phase 2 only fills in the verifier body
- Hono context types: `c.var.principal`, `c.var.workspaceId`, `c.var.tenantSchema`
- Local-dev shortcut: `X-Dev-Workspace-Id` header bypasses auth when `NODE_ENV !== 'production'`. Logged loudly

**Out (explicitly deferred):**
- Real end-user session verification (Phase 2)
- `app_users` table (Phase 2; design-only spec landing in `cms-app-users-schema-design`)
- Per-customer-app token (the request-scoped service token from plan Revision H, Phase 2)
- MFA, device sessions, OIDC federation (Phase 2 / Phase 3.5)
- Permission registry consumption (separate spec: `cms-permission-registry`)
- Rate limiting (deferred to `cms-ops-runbook-and-observability`)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/principal.ts` | new | `Principal` types |
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/site-owner.ts` | new | Cookie verifier (auth-brain) |
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/end-user-stub.ts` | new | Phase 2 stub returning 401 |
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/middleware.ts` | new | `requireAuth(...types)` factory |
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/dev-bypass.ts` | new | Local-dev `X-Dev-Workspace-Id` |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/auth-brain-client.ts` | new | Thin HTTP client to auth-brain `verifySession`, with mock for tests |

## API surface

```ts
// auth/principal.ts
export type SiteOwnerPrincipal = {
  type: 'site_owner';
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member' | 'viewer';
};

export type EndUserPrincipal = {
  type: 'end_user';
  endUserId: string;
  workspaceId: string;       // the customer-built app's workspace
};

export type Principal = SiteOwnerPrincipal | EndUserPrincipal;
export type PrincipalType = Principal['type'];

// auth/middleware.ts
import type { MiddlewareHandler } from 'hono';

export function requireAuth(
  ...accepts: PrincipalType[]
): MiddlewareHandler<{
  Variables: {
    principal: Principal;
    workspaceId: string;
    tenantSchema: string;
  };
}>;

// Usage:
//   app.get('/v1/collections', requireAuth('site_owner'), handler)
//   app.get('/v1/rows/:id',    requireAuth('site_owner', 'end_user'), handler)
```

```ts
// auth/end-user-stub.ts (Phase 2 will replace the body)
export async function verifyEndUserToken(
  token: string,
): Promise<{ ok: false; code: 'END_USER_AUTH_NOT_IMPLEMENTED' }> {
  return { ok: false, code: 'END_USER_AUTH_NOT_IMPLEMENTED' };
}
```

## Data shapes

```ts
// Error response shape (consistent across all auth failures)
type AuthErrorBody = {
  error: 'unauthorized' | 'forbidden' | 'not_implemented';
  code: string;     // machine-readable: 'NO_SESSION_COOKIE', 'END_USER_AUTH_NOT_IMPLEMENTED', etc.
  message: string;
};

// 401 unauthorized: no valid principal
// 403 forbidden: valid principal but disallowed for this route
// 501 not implemented: end-user route hit with end-user token in v1
```

## Test plan

- [ ] Unit: `site-owner.test.ts` parses a valid auth-brain cookie, returns SiteOwnerPrincipal
- [ ] Unit: `site-owner.test.ts` rejects expired cookie with 401 `EXPIRED_SESSION`
- [ ] Unit: `end-user-stub.test.ts` returns 501 `END_USER_AUTH_NOT_IMPLEMENTED` for any `eu_*` token
- [ ] Unit: `middleware.test.ts` blocks site-owner-only route from end-user token (501)
- [ ] Unit: `middleware.test.ts` accepts site-owner on dual-principal route, accepts end-user stub call path (returns 501)
- [ ] Unit: `middleware.test.ts` attaches `tenantSchema` to context after auth
- [ ] Integration: full request through scaffold + bootstrap + middleware, verify `c.var.tenantSchema` matches the workspace's tenant
- [ ] Manual: hit `/v1/test-protected` from a logged-in framer-clone editor in staging, confirm 200; hit without cookie, confirm 401

## Definition of done

- [ ] Code lands and typechecks
- [ ] Tests pass (`pnpm test`)
- [ ] All four error response codes (401, 403, 501, plus 500-on-bug) are documented in code comments and produce the structured shape above
- [ ] `requireAuth` covers site-owner end-to-end including tenant schema resolution
- [ ] End-user stub returns 501 with the agreed code, NOT 401 (signals "wrong phase" not "wrong creds")
- [ ] Local-dev bypass logs a warning on every use
- [ ] No regressions in healthcheck or admin-tenants endpoints (those use admin-key auth, separate path)
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Cookie domain for site-owner sessions:** auth-brain v1 issues cookies on `*.lumitra.co`. CMS service is on `cms.lumitra.co`. Standard cookie sharing applies. But what about local dev where the editor runs on `localhost:5173` and the CMS on `localhost:8787`? Recommended: use `X-Dev-Workspace-Id` header in dev only.
- **`X-Workspace-Id` precedence:** if the cookie's session has a default workspace AND the request sets `X-Workspace-Id` to a different one, which wins? Recommended: header wins (multi-workspace users explicitly switch via UI), but the middleware MUST verify the user has membership in that workspace.
- **End-user stub error code: 401 vs 501?** 401 says "auth required". 501 says "this code path doesn't exist yet". Phase 2 implementation will return 401 / 200. Recommended: 501 for v1 to make it crystal-clear that hitting this route is wrong (callers must not rely on it).
- **Is auth-brain `verifySession` an HTTP call or does CMS share a JWT verifier?** Auth-brain v1 spec is not landed. If JWT, CMS verifies locally with the public key (fast). If session-cookie HMAC, CMS calls auth-brain HTTP. Recommended: spec author assumes HTTP for v1, switch to local JWT verification if/when auth-brain v1 ships JWTs.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revision F.2, Recommendation paragraph 2)
- Spec: `cms-tenant-schema-bootstrap.md`
- Auth-brain v1 spec: `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` (sections 1.6, 7)
- Code touchpoints: existing storage-brain auth middleware (`projects/lumitra-infra/storage-brain/packages/api/src/middleware/`)
