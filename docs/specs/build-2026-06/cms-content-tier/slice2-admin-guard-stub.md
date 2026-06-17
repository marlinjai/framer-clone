---
name: slice2-admin-guard-stub
track: cms-content-tier
wave: 1
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [track0-backend-foundation]
touchesSharedState: false
sharedState: []
estimateDays: 1
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Interim admin guard stub for CMS mutation routes (auth.can-shaped, swappable)

> framer-clone has NO auth today. Resolves the re-scope open decision: ship a single hard-coded admin guard on `/api/cms` (and later `/api/commerce`) MUTATION routes for v1, written against a `can(user, action, resource)` signature so the auth-brain swap later is an adapter change, not a rewrite. Reads (storefront, binding preview) stay UNAUTHENTICATED for v1. Mirrors the parked offers slice's interim-login approach. This guard is ALSO consumed by Track B commerce mutation routes and Track C's checkout route.

## Goal

A tiny `can(principal, action, resource)`-shaped authorization seam guarding CMS (and commerce) write routes: one hard-coded admin principal + one constant workspace/tenant for v1, the interim shared secret read from env (Infisical), never a literal in source. Mutation routes call `requireAdmin(req)`; read routes do NOT import the guard.

## Scope

**In:**
- `src/server/auth/guard.ts`: `Principal { userId, workspaceId, isAdmin }`, `can(principal, action, resource): boolean` (auth-brain-shaped), `getPrincipal(req): Principal | null` (reads the interim secret from a header/cookie, compares against an env-injected value), `requireAdmin(req): {ok:true,principal}|{ok:false,response}` returning a Track-0 envelope. `INTERIM_WORKSPACE_ID` constant.
- The interim secret is read from `process.env` (Infisical-injected); NEVER a literal in source.
- `import 'server-only'`.

**Out (explicitly deferred):**
- Real auth-brain integration (P2 / E7). The `can()` signature matches future `auth.can` so the swap is an adapter change.
- End-user auth / app_users (P6).
- Multi-workspace resolution (E7; one constant workspace for v1).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/auth/guard.ts` | new | `can`, `getPrincipal`, `requireAdmin`, `INTERIM_WORKSPACE_ID`; server-only |
| `src/server/auth/__tests__/guard.test.ts` | new (node project) | correct/missing/wrong secret cases |

## API surface

```ts
export interface Principal { userId: string; workspaceId: string; isAdmin: boolean }
export function can(principal: Principal, action: string, resource: string): boolean; // auth-brain-shaped
export function getPrincipal(req: Request): Principal | null;
export function requireAdmin(req: Request): { ok: true; principal: Principal } | { ok: false; response: Response };
export const INTERIM_WORKSPACE_ID: string;
```

## Test plan

- [ ] Correct interim secret -> `{ok:true,principal}` with `isAdmin:true` + the constant workspace.
- [ ] Missing secret -> 401 envelope; wrong secret -> 403 envelope (errors surface, never swallowed).
- [ ] `can(principal, action, resource)` is the auth-brain-shaped signature.
- [ ] Read routes do NOT import the guard (grep check on the read-route files once they exist; documented as a contract here).

## Definition of done

- [ ] `requireAdmin` guards on an env-injected interim secret (NO literal in source).
- [ ] Correct/missing/wrong cases return `{ok}` / 401 / 403 as specified.
- [ ] `can()` signature is auth-brain-shaped; one constant workspace.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- Confirm the framer-clone Infisical secret NAME for the interim admin secret before the manual route-guard test. The Worker writes the env READ; Marlin sets the value in Infisical (split-responsibility pattern).

## References

- Re-scope brief (2026-06-16): single hard-coded admin guard, `can()`-shaped, reads unauthenticated for v1.
- Standard: `~/.claude/CLAUDE.md` secrets section (no literals; Infisical-injected env).
- Depends on: `track0-backend-foundation` (envelope helpers, server-only boundary).
