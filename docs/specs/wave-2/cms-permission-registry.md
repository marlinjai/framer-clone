---
name: cms-permission-registry
track: cms
wave: 2
priority: P1
status: draft
depends_on: [cms-auth-middleware-dual-principal, cms-collection-crud-api]
estimated_value: 7
estimated_cost: 4
owner: unassigned
---

# CMS permission registry (per-action role minimums)

## Goal

Wire the CMS service into auth-brain's `auth.can(user, action, resource)` model per spec section 1.6 (apps NEVER query memberships directly; always go through `auth.can`). This spec defines the CMS permission registry mapping action names like `cms.collection.create` to required role minimums on a workspace, exposes the registry to auth-brain via a documented contract, and adds a route-level `requirePermission(actionName)` middleware that runs after `requireAuth` and short-circuits with 403 when the principal lacks the role. End-user permission semantics (row-owner predicates, `OwnerOnly`) are reserved as Phase 2 actions in the registry but not enforced beyond returning 501 for now.

## Scope

**In:**
- `cms-permissions.ts` registry: an exhaustive map of every action name the CMS service performs to a `{ minimumRole, principalTypes }` declaration
- `requirePermission(actionName)` middleware that consults the registry, the request's `principal`, and the resource (workspace) to decide allow/deny
- Action names cover: collection create/read/update/delete, column create/read/update/delete, row read, row read-own (Phase 2 stub), row write, row write-own (Phase 2 stub), row delete, row delete-own (Phase 2 stub)
- Documentation file `cms-brain/docs/permissions.md` exporting the registry as a reference for auth-brain integration
- Local enforcement: in v1, the middleware checks the principal's role directly against the registry's minimum (no auth-brain HTTP round-trip yet). The shape is `auth.can`-compatible so the call can be redirected to auth-brain in a follow-up
- Tests covering each route's permission gate

**Out (explicitly deferred):**
- Real `auth.can` HTTP integration with auth-brain (Phase 2 once auth-brain ships its permission API)
- ReBAC / OpenFGA wiring (Phase 2)
- Custom roles beyond admin/member/viewer (Phase 2)
- End-user row-owner predicate enforcement (Phase 2: `row.owner_id = endUserId` checks)
- Per-collection ACLs (Phase 2: maybe never; collections inherit workspace permissions)
- Audit log emission on permission denials (basic logging only in v1; audit log is Phase 2)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/permissions.ts` | new | The registry + `can()` helper |
| `projects/lumitra-infra/cms-brain/packages/api/src/auth/require-permission.ts` | new | Middleware factory |
| `projects/lumitra-infra/cms-brain/docs/permissions.md` | new | Reference doc for auth-brain |
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/collections.ts` | edit | Add `requirePermission('cms.collection.create')` etc. |
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/rows.ts` | edit | Add `requirePermission('cms.row.read')` etc. |

## API surface

```ts
// auth/permissions.ts
export type Role = 'admin' | 'member' | 'viewer';
export type ActionName =
  | 'cms.collection.create'
  | 'cms.collection.read'
  | 'cms.collection.update'
  | 'cms.collection.delete'
  | 'cms.column.create'
  | 'cms.column.read'
  | 'cms.column.update'
  | 'cms.column.delete'
  | 'cms.row.read'
  | 'cms.row.read_own'        // Phase 2
  | 'cms.row.write'
  | 'cms.row.write_own'       // Phase 2
  | 'cms.row.delete'
  | 'cms.row.delete_own';     // Phase 2

export type ActionPermission = {
  minimumRole: Role;
  principalTypes: ('site_owner' | 'end_user')[];
  phase: 1 | 2;
};

export const CMS_PERMISSIONS: Record<ActionName, ActionPermission>;

export function can(
  principal: Principal,
  action: ActionName,
  resource: { workspaceId: string },
): { ok: true } | { ok: false; reason: string };
```

```ts
// auth/require-permission.ts
import type { MiddlewareHandler } from 'hono';

export function requirePermission(action: ActionName): MiddlewareHandler;
// Runs after requireAuth. Reads c.var.principal, calls can(...).
// On deny: 403 if principal authenticated but lacking role; 501 if action is Phase 2 and end-user principal hits it.
```

## Data shapes

```ts
// Sample registry entries:
export const CMS_PERMISSIONS: Record<ActionName, ActionPermission> = {
  'cms.collection.create': {
    minimumRole: 'admin',
    principalTypes: ['site_owner'],
    phase: 1,
  },
  'cms.collection.read': {
    minimumRole: 'viewer',
    principalTypes: ['site_owner'],
    phase: 1,
  },
  'cms.row.read': {
    minimumRole: 'member',
    principalTypes: ['site_owner'],
    phase: 1,
  },
  'cms.row.read_own': {
    minimumRole: 'member',         // role doesn't apply to end_user; placeholder
    principalTypes: ['end_user'],
    phase: 2,
  },
  // ... full table
};
```

## Test plan

- [ ] Unit: `permissions.test.ts` `can()` allows admin on `cms.collection.create`, denies viewer
- [ ] Unit: `permissions.test.ts` end-user principal on Phase 1 action returns 403
- [ ] Unit: `permissions.test.ts` end-user principal on Phase 2 action (e.g. `cms.row.read_own`) returns 501 (not yet implemented)
- [ ] Unit: `require-permission.test.ts` denial returns structured 403 body with `code: PERMISSION_DENIED`
- [ ] Integration: viewer-role member hits `POST /v1/collections`, gets 403; admin hits, gets 201
- [ ] Integration: site-owner with admin role hits all 8 collection routes successfully
- [ ] Manual: in framer-clone editor, role=viewer user opens a workspace, "create collection" button is disabled (UI work in framer-clone track) and direct API call returns 403

## Definition of done

- [ ] Code lands and typechecks
- [ ] Every route in `cms-collection-crud-api` and `cms-row-crud-api` has a `requirePermission(...)` declaration
- [ ] Registry is exhaustive for v1; Phase 2 actions are flagged
- [ ] Documentation file shipped for auth-brain consumers
- [ ] No regressions in collection or row CRUD
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Local check vs auth-brain HTTP `auth.can`:** plan recommends "always go through `auth.can`". V1 does the role check locally because auth-brain v1's permission API is not yet defined. Recommended: ship the local check, document the integration plan, swap to HTTP `auth.can` in Phase 2 with no caller-side change.
- **`framer-clone/src/permissions.ts` precedent:** auth-brain spec section 7 mentions apps export a permission registry at `framer-clone/src/permissions.ts`. Should the CMS registry live in framer-clone repo (alongside editor permissions) or in cms-brain? Recommended: cms-brain owns CMS actions; framer-clone editor owns editor actions. They federate at the auth-brain layer.
- **Member vs admin on row writes:** plan says member can read/write per app rules. Should `cms.row.write` require `member` or `admin`? Recommended: `member` (creating rows is normal-use, not destructive). Soft-archive is `member`. Hard-delete (Phase 2) requires `admin`.
- **Viewer role:** auth-brain spec defers viewer to v1.5. CMS service should support it from Day 1 (read-only). Recommended: viewer minimum on read actions, admin/member on writes.
- **Permission denial telemetry:** should denied requests count toward customer-visible audit / activity feed? Recommended: yes, but emit only as a structured log line in v1 (audit log is Phase 2).

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Recommendation paragraph 2, Revision F.5)
- Auth-brain spec: `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` (section 1.6 non-negotiable, section 7 role list)
- Spec dependencies: `cms-auth-middleware-dual-principal`, `cms-collection-crud-api`
