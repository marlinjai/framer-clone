---
name: multiplayer-auth-brain-seam
track: multiplayer
wave: 1
priority: P0
status: draft
depends_on: [multiplayer-hocuspocus-server-scaffold]
estimated_value: 8
estimated_cost: 4
owner: unassigned
---

# Auth-brain SSO seam for the collab server

## Goal

Sketch the auth-brain SSO seam in the Hocuspocus `onAuthenticate` hook so the collab server can accept real session cookies from `*.lumitra.co` once auth-brain v1 ships. This spec does NOT depend on auth-brain v1 being live: it defines an `AuthAdapter` interface, ships a stub implementation that mirrors the auth-brain v1 contract, and wires `onAuthenticate` to call the adapter. When auth-brain v1 SDK lands, we swap the stub for the real `@marlinjai/auth-brain-sdk` calls without touching the collab server's structure.

## Scope

**In:**
- `services/collab-server/src/auth/AuthAdapter.ts`: a TypeScript interface with two methods: `verifySession(cookie: string)` and `can(user, action, resource)`. Shape mirrors `auth-brain-sdk` per research plan section 4a.
- `services/collab-server/src/auth/StubAuthAdapter.ts`: dev-mode adapter that accepts a session cookie of the form `dev-session:<userId>:<workspaceId>` and returns a synthetic user / always-allowed permission. Logs a clear warning at startup.
- `services/collab-server/src/auth/index.ts`: factory that picks the adapter based on `process.env.AUTH_ADAPTER` (`stub` | `auth-brain`). When `auth-brain` is selected and the SDK isn't available, throws at startup with a clear message.
- Updated `onAuthenticate` hook that:
  - reads `cookie` header from `requestHeaders` (or falls back to `token` query param for local dev / unit tests).
  - calls `adapter.verifySession(cookie)`. If null, throws (Hocuspocus closes connection with 401).
  - parses `documentName` (format: `project:<projectId>`).
  - calls `adapter.can(user, 'project.edit', { type: 'project', id: projectId, workspaceId: session.activeWorkspaceId })`. If false, throws (closes connection with 403).
  - returns `{ user, workspaceId }`.
- A `permissions.ts` registry stub at `src/lib/multiplayer/permissions.ts` documenting the `project.edit` action. Per the auth-brain spec section 1.6, every app declares actions in its own registry. This file is the placeholder so the auth-brain integration knows where to land.
- Document-name parser `parseDocumentName(name)` returning `{ kind: 'project', projectId }` with validation (uuid or slug pattern).
- 30-second in-process LRU cache on `verifySession` results (per research plan section 4d), keyed by cookie hash. Disabled in stub mode.
- Vitest coverage for the stub adapter and the `onAuthenticate` flow with happy / unauthorized / forbidden paths.

**Out (explicitly deferred):**
- Real `@marlinjai/auth-brain-sdk` integration. This spec ships the adapter swap point; the actual swap waits for auth-brain v1 to publish a stable SDK (auth-brain spec sequencing, ~4 to 6 weeks out).
- CDC-driven disconnect on membership revocation (research plan section 4e, deferred to v2 / wave 3 if needed).
- OpenFGA permission tuples beyond `project.edit` (more fine-grained roles in Phase 2).
- Workspace-to-project lookup (`lookupWorkspaceForProject`): for v1, the document name encodes the workspace prefix (`project:<workspaceId>:<projectId>`) so we don't need a DB roundtrip. **Confirm with Marlin in open question.**

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `services/collab-server/src/auth/AuthAdapter.ts` | new | Interface only. |
| `services/collab-server/src/auth/StubAuthAdapter.ts` | new | Dev/test adapter. |
| `services/collab-server/src/auth/AuthBrainAdapter.ts` | new | Skeleton importing `@marlinjai/auth-brain-sdk` types but throwing "not yet wired" at runtime. Documents the wiring shape. |
| `services/collab-server/src/auth/index.ts` | new | Factory + cache. |
| `services/collab-server/src/auth/parseDocumentName.ts` | new | Parser + validation. |
| `services/collab-server/src/index.ts` | edit | Replace stub `onAuthenticate` from `multiplayer-hocuspocus-server-scaffold` with adapter-driven version. |
| `services/collab-server/src/auth/auth.test.ts` | new | Vitest. |
| `src/lib/multiplayer/permissions.ts` | new | Action registry stub. |

## API surface

```ts
// AuthAdapter.ts
export interface VerifiedSession {
  user: { id: string; email: string; name?: string };
  activeWorkspaceId: string;
  workspaceIds: string[];
}

export interface PermissionCheck {
  type: 'project' | 'workspace';
  id: string;
  workspaceId: string;
}

export interface AuthAdapter {
  verifySession(cookieOrToken: string): Promise<VerifiedSession | null>;
  can(
    user: VerifiedSession['user'],
    action: 'project.edit' | 'project.view',
    resource: PermissionCheck,
  ): Promise<boolean>;
}
```

```ts
// permissions.ts (in editor app)
export const FRAMER_CLONE_PERMISSIONS = {
  'project.edit': { requires: 'workspace.member' },
  'project.view': { requires: 'workspace.guest' },
} as const;
```

## Data shapes

```
Document name format:    project:<workspaceId>:<projectId>
Cookie name (auth-brain): lumitra_session  (Domain=.lumitra.co)
Dev cookie format:        dev-session:<userId>:<workspaceId>
```

The document name encodes the workspace ID so we don't need a DB roundtrip in `onAuthenticate` to figure out which workspace owns the project. The browser is responsible for constructing this name when opening the websocket. The auth check then validates that the authenticated user has membership in that workspace.

## Test plan

- [ ] Unit: `parseDocumentName('project:ws_123:proj_abc')` returns `{ kind: 'project', workspaceId: 'ws_123', projectId: 'proj_abc' }`.
- [ ] Unit: `parseDocumentName('garbage')` throws.
- [ ] Unit: `StubAuthAdapter.verifySession('dev-session:u1:ws1')` returns a synthetic session. Anything else returns null.
- [ ] Unit: `onAuthenticate` happy path: valid cookie + permission allowed -> resolves with `{ user, workspaceId }`.
- [ ] Unit: `onAuthenticate` unauthorized: null session -> throws.
- [ ] Unit: `onAuthenticate` forbidden: valid session but `can()` returns false -> throws.
- [ ] Unit: 30s session cache hit on second call with the same cookie (only enabled when adapter is `auth-brain`).
- [ ] Manual: with `AUTH_ADAPTER=stub`, the editor connects when given the dev cookie. Without, it's rejected.

## Definition of done

- [ ] Adapter interface lands and typechecks.
- [ ] Stub adapter passes unit suite.
- [ ] `AuthBrainAdapter` skeleton compiles (imports may be stubbed if SDK isn't published yet) but throws clearly at startup.
- [ ] `services/collab-server` runs in stub mode.
- [ ] Documented in `services/collab-server/README.md`: how to switch adapters, what to do when auth-brain v1 ships.
- [ ] Coordination note added to STATUS.md indicating the swap-in moment.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Document name format: include `workspaceId` to avoid a DB lookup, or look it up per connection? **Default: include in name** (decision affects browser code that constructs the WS URL). Marlin to confirm.
- Cookie scope in dev: localhost cookies aren't on `.lumitra.co`. The fallback "session token via query param" is in scope (research plan section 4c). Confirm we also support a localhost dev cookie for full-stack local dev.
- 30s session cache: necessary for v1? The plan says "we don't need a session cache in v1" (section 4d). **Default: leave the cache structure in but disable it in stub mode.** Easier than retrofitting later.
- Where does the editor browser code get the cookie? On `*.lumitra.co` it's auto-attached. In dev with localhost, we need a way to inject the dev cookie. Define this in the slice page (`multiplayer-yjs-mst-binding-slice`) or here?

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (section 4)
- External (auth-brain spec): `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` (sections 1.6, 3.4, 3.5)
- External: https://tiptap.dev/docs/hocuspocus/server/hooks#onauthenticate
