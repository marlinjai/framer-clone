---
name: multiplayer-hocuspocus-server-scaffold
track: multiplayer
wave: 1
priority: P0
status: draft
depends_on: [multiplayer-yjs-doc-shape]
estimated_value: 8
estimated_cost: 5
owner: unassigned
---

# Hocuspocus sync server scaffold

## Goal

Stand up a minimal Hocuspocus websocket server that the editor can connect to over `ws://` (local) and `wss://` (deployed) and exchange Yjs updates between two browser tabs. Persistence via `@hocuspocus/extension-database` against Postgres. Auth is stubbed in this spec (a noop `onAuthenticate` that accepts any connection): real auth-brain integration lives in `multiplayer-auth-brain-seam`. Goal of this spec is "you can deploy it, point two browsers at it, and they sync". Not production-hardened: no rate-limiting, no Redis, no observability beyond logs.

## Scope

**In:**
- New package directory `services/collab-server/` (a Node.js service in the framer-clone repo, not in `src/`).
- `services/collab-server/src/index.ts`: entry point, configures Hocuspocus with the Database extension.
- `@hocuspocus/extension-database` wired against Postgres via `pg`: `documents(id text primary key, data bytea, updated_at timestamptz)`.
- A migration SQL file `services/collab-server/migrations/001_documents.sql`.
- `onAuthenticate` stub that returns `{ user: { id: 'dev-user' }, workspaceId: 'dev' }` and logs a warning ("AUTH IS STUBBED, do not deploy without multiplayer-auth-brain-seam"). Throws if `process.env.MULTIPLAYER_AUTH_REQUIRED === 'true'`.
- Connection logging: `onConnect`, `onDisconnect`, `onLoadDocument`, `onStoreDocument` log basic metadata.
- Health endpoint at `GET /health` returning `{ ok: true, version }`.
- Coolify deployment config: `Dockerfile`, `services/collab-server/coolify.json` (env var manifest only, no infra side effects).
- Env vars: `DATABASE_URL`, `PORT` (default 1234), `MULTIPLAYER_AUTH_REQUIRED` (default `false`).
- A `pnpm dev:collab` script at repo root that runs the server with `infisical run --env=dev` (per global Infisical convention).
- README at `services/collab-server/README.md` covering local run and the auth stub warning.

**Out (explicitly deferred):**
- Real auth-brain `verifySession` + `can` integration (see `multiplayer-auth-brain-seam`).
- Redis horizontal-scale extension (v1.5).
- Per-doc snapshot / version-history extension.
- Webhook extension for AI pipeline (Phase 2).
- Rate limiting, abuse protection, Origin header allowlist (wave 3 hardening).
- Production observability beyond stdout (wave 3).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `services/collab-server/package.json` | new | Standalone package, `@hocuspocus/server`, `@hocuspocus/extension-database`, `pg`, `yjs`. |
| `services/collab-server/src/index.ts` | new | Server entry, Database extension wiring, stub auth, health route. |
| `services/collab-server/src/db.ts` | new | Postgres pool + fetch/store callbacks for the Database extension. |
| `services/collab-server/migrations/001_documents.sql` | new | One-table migration. |
| `services/collab-server/Dockerfile` | new | Node 20+ image, builds and runs. |
| `services/collab-server/coolify.json` | new | Env var manifest for Coolify deploy. |
| `services/collab-server/README.md` | new | Local run + deploy notes + auth-stub warning. |
| `package.json` (root) | edit | Add `dev:collab` script. |
| `pnpm-workspace.yaml` | edit if exists, else new | Add `services/*` glob so the collab server is part of the workspace. |

## API surface

```ts
// services/collab-server/src/index.ts
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';

const server = Server.configure({
  port: parseInt(process.env.PORT ?? '1234', 10),
  extensions: [
    new Database({ fetch: fetchYDoc, store: storeYDoc }),
  ],
  async onAuthenticate(ctx) {
    if (process.env.MULTIPLAYER_AUTH_REQUIRED === 'true') {
      throw new Error('Auth required but multiplayer-auth-brain-seam not implemented');
    }
    console.warn('[collab] AUTH STUBBED. dev only.');
    return { user: { id: 'dev-user' }, workspaceId: 'dev' };
  },
  // health route handled via Server.configure({ getHealth: ... }) or a thin HTTP wrapper
});

server.listen();
```

```ts
// services/collab-server/src/db.ts
export async function fetchYDoc({ documentName }: { documentName: string }): Promise<Uint8Array | null>;
export async function storeYDoc(args: { documentName: string; state: Uint8Array }): Promise<void>;
```

## Data shapes

```sql
-- migrations/001_documents.sql
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,            -- documentName from Hocuspocus, e.g. "project:<projectId>"
  data        BYTEA NOT NULL,              -- Y.encodeStateAsUpdate output
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_updated_at_idx ON documents (updated_at);
```

Document name convention: `project:<projectId>`. Pages live inside the same Y.Doc per `multiplayer-yjs-doc-shape`, so one document per project. This is the canonical naming to reference everywhere.

## Test plan

- [ ] Unit (`services/collab-server/src/db.test.ts`): `storeYDoc` then `fetchYDoc` for the same `documentName` returns identical bytes. Run against a Postgres test instance via `pg-mem` or a docker-compose sidecar.
- [ ] Integration (manual + scripted): boot the server locally, open two browser tabs running a tiny test page that connects via `HocuspocusProvider`, mutate a `Y.Map` in tab A, observe the change in tab B within 200ms. Script lives in `services/collab-server/scripts/two-tab-smoke.ts`.
- [ ] Manual: `curl http://localhost:1234/health` returns `{ ok: true }`.
- [ ] Manual: kill the server, reconnect a tab, verify the doc state is restored from Postgres.
- [ ] Manual: set `MULTIPLAYER_AUTH_REQUIRED=true`, confirm connections are rejected.

## Definition of done

- [ ] Server starts locally with `pnpm dev:collab` under `infisical run --env=dev`.
- [ ] Two-tab smoke script passes.
- [ ] Postgres migration runs cleanly on a fresh DB.
- [ ] Coolify deploy manifest reviewed (no actual deploy required in this spec).
- [ ] README covers the auth-stub warning and the path to `multiplayer-auth-brain-seam`.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Postgres instance: shared with auth-brain or dedicated? **Default: shared instance, dedicated schema (`collab`).** Confirm with Marlin since this is suite-level ops.
- Document naming: `project:<projectId>` or just `<projectId>`? Prefix avoids collision if we ever add other doc types (e.g. workspace-level docs). **Default: prefix.** Worth flagging because changing later is a data migration.
- Health endpoint port: same as websocket port (1234) or separate? Hocuspocus exposes an HTTP server on the same port, so same. Confirm.
- Snapshot debounce interval: Hocuspocus default is 2s. The plan calls 2s adequate. Keep default for v1.

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (sections 1d, 5a, 6a)
- External: https://tiptap.dev/docs/hocuspocus/getting-started/overview
- External: https://www.npmjs.com/package/@hocuspocus/extension-database
- Memory (Infisical convention): `~/.claude/CLAUDE.md` (Secrets section)
