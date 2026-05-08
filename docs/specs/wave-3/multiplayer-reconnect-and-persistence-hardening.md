---
name: multiplayer-reconnect-and-persistence-hardening
track: multiplayer
wave: 3
priority: P1
status: draft
depends_on: [multiplayer-yjs-mst-binding-full, multiplayer-auth-brain-seam]
estimated_value: 6
estimated_cost: 6
owner: unassigned
---

# Reconnect, offline edits, and persistence hardening

## Goal

Take the wave-1 server scaffold and the wave-2 binding from "works on a happy path" to "survives the messy real world": websocket reconnects, offline edits queueing, Postgres snapshot tuning, weekly backups, basic observability, and a 50-concurrent-user load test. Closes out the operational items in research plan section 6c phase 5 ("Hardening") so the system is ready for Phase 1 customer pilots.

## Scope

**In:**
- Reconnection UX:
  - Connection status indicator in the top bar: `Connected` / `Reconnecting...` / `Offline (changes will sync when reconnected)`.
  - When `HocuspocusProvider` reports disconnect, capture timestamp; when reconnected, log the gap.
  - Toast on reconnect after >5s offline: "Reconnected. Your changes are syncing."
- Offline edits queue: `HocuspocusProvider` already buffers updates while disconnected and flushes on reconnect. Verify with a test (kill server, mutate, restart, observe flush). Document the behavior in `docs/MULTIPLAYER.md`.
- IndexedDB local persistence via `y-indexeddb`: every editor session also persists its Y.Doc to IndexedDB so a hard reload while offline still finds the latest local state. Keyed by `documentName`.
- Postgres snapshot tuning:
  - Hocuspocus `Database` extension `storeImmediately: false`, `storeDocumentDebounce: 2000` (2s default per plan).
  - Verify under load (50 concurrent users in one room) Postgres write throughput stays comfortable.
- Weekly snapshot backup:
  - Cron job in `services/collab-server/src/backup.ts` that, once per week, dumps every `documents` row to gzipped files in Hetzner storage. Retention: 90 days.
  - Manual restore script `services/collab-server/scripts/restore-snapshot.ts`.
- Observability:
  - Structured logs (JSON) on `onConnect`, `onDisconnect`, `onLoadDocument`, `onStoreDocument`, errors. Include `documentName`, `userId`, `connectionDurationMs`.
  - Metrics endpoint at `GET /metrics` (Prometheus text format) with: active connections, docs loaded, store calls per minute, DB latency p50/p99.
  - Hook into Coolify's existing alerting (no new infra).
- Origin header allowlist on the WS server: only accept connections from `https://*.lumitra.co` and dev origins. Prevents random sites from opening WS connections with stolen cookies.
- 50-concurrent-user load test script using `puppeteer` or `playwright` headless tabs: open 50 connections to one document, mutate at 1 op/sec each, measure server CPU, memory, latency. Document results.
- Postgres connection pool tuning: `pg.Pool` with `max: 20`, idle timeout 30s. Validated under load.
- Set `MULTIPLAYER_AUTH_REQUIRED=true` for production deploys (requires `multiplayer-auth-brain-seam` to be wired with the real adapter, not stub).

**Out (explicitly deferred):**
- Multi-instance horizontal scaling via `@hocuspocus/extension-redis`. Single instance is sized for hundreds of concurrent rooms per the research plan (section 6a). Add Redis when monitoring shows actual saturation. Tracked as v1.5.
- CDC-driven force-disconnect on auth-brain membership revocation. Phase 2 / wave 3+.
- Document version history with `Y.snapshot`. Phase 2.
- Migration tooling from Hocuspocus to Liveblocks-Yjs (the plan B if ops bite us). Tracked separately when/if needed.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `services/collab-server/src/index.ts` | edit | Add Origin allowlist, structured logging, metrics endpoint. |
| `services/collab-server/src/backup.ts` | new | Weekly snapshot dump to Hetzner storage. |
| `services/collab-server/src/metrics.ts` | new | Prometheus formatter. |
| `services/collab-server/scripts/restore-snapshot.ts` | new | Manual restore tool. |
| `services/collab-server/scripts/load-test.ts` | new | 50-concurrent-user simulation. |
| `services/collab-server/coolify.json` | edit | Add `MULTIPLAYER_AUTH_REQUIRED=true` for prod env. |
| `src/lib/multiplayer/connectionStatus.ts` | new | Hook + store for top-bar indicator. |
| `src/components/multiplayer/ConnectionStatusIndicator.tsx` | new | Top bar UI. |
| `src/components/TopBar.tsx` | edit | Mount status indicator. |
| `src/lib/multiplayer/bindEditor.ts` | edit | Wire `y-indexeddb` provider alongside `HocuspocusProvider`. |
| `package.json` | edit | Add `y-indexeddb`. |
| `docs/MULTIPLAYER.md` | edit | Document offline behavior, reconnect UX, restore procedure. |

## API surface

```ts
// connectionStatus.ts
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export interface ConnectionStatusStoreInstance {
  status: ConnectionStatus;
  lastConnectedAt: number | null;
  setStatus(s: ConnectionStatus): void;
}
```

## Data shapes

No new persistent shapes. IndexedDB persistence uses `y-indexeddb`'s default DB schema, scoped to `documentName`.

Backup file format: `<bucket>/snapshots/<YYYY-MM-DD>/<documentName>.bin.gz` (raw `Y.encodeStateAsUpdate` output, gzipped).

## Test plan

- [ ] Unit: connection status transitions correctly given simulated provider events (`connect`, `disconnect`, `reconnect`).
- [ ] Integration: kill the server, mutate in the editor, restart server, observe queued ops flush within 2s.
- [ ] Integration: hard-reload the page while offline, observe IndexedDB-restored state matches the last edit.
- [ ] Manual: top-bar indicator visually transitions on disconnect/reconnect.
- [ ] Load test (`scripts/load-test.ts`): 50 concurrent connections, 1 op/sec each, sustained for 5 minutes. Server CPU < 50%, mem < 1GB, p99 update latency < 500ms. Document results in `services/collab-server/load-test-results.md`.
- [ ] Manual: backup script produces a valid gzipped dump for one document. Restore script reads it back into a fresh Postgres and the editor loads it correctly.
- [ ] Manual: WS connection from `https://example.com` (non-allowed origin) is rejected.

## Definition of done

- [ ] All hardening tasks land and typecheck.
- [ ] Load test results documented and meet the target thresholds.
- [ ] Connection status UX verified in two-tab smoke (disconnect, reconnect, offline edit, return).
- [ ] Backup / restore procedure documented in `docs/MULTIPLAYER.md` and tested end-to-end.
- [ ] Production deploy gate: `MULTIPLAYER_AUTH_REQUIRED=true` enforced (requires `multiplayer-auth-brain-seam` real adapter to be live).
- [ ] No regressions in single-player mode (a project that's never connected a peer should behave identically to today).
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- IndexedDB layer: also gate behind a flag, or always-on? **Default: always-on.** It's free durability against page crashes.
- Backup destination: Hetzner Storage Box or S3-compatible bucket? **Default: Hetzner Storage Box** (existing infra). Confirm with Marlin.
- Load test target: 50 concurrent in one room is the plan's stated benchmark. Should we also test 50 rooms with 2 users each (more realistic distribution)? **Default: both,** add as a second scenario. Document outcomes.
- Origin allowlist for dev: include `http://localhost:3000` explicitly? Yes. What about Vercel preview URLs if the editor is ever deployed on Vercel? **Open question** for the broader deploy strategy.
- Metrics: do we want Prometheus or push-based? Coolify's existing monitoring story should drive this. **Default: Prometheus pull** (standard, easy).

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (sections 5a, 6a, 6c phase 5)
- External: https://github.com/yjs/y-indexeddb
- External: https://tiptap.dev/docs/hocuspocus/server/configuration (storeDocumentDebounce options)
- Memory (Infisical for prod env vars): `~/.claude/CLAUDE.md`
