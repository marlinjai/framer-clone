// demoTenant.ts
//
// The demo tenant-group's identity, in a DEPENDENCY-FREE module. The id is the
// commerce isolation boundary for the demo: the `tg_<id>` schema every demo
// commerce row lives in is DERIVED from it (via the tenant-db chokepoint, which
// validates it as a strict UUID).
//
// It lives here (not in seedDemoSite.ts, which re-exports it) because THREE
// kinds of consumers need the SAME id and only one of them may carry server
// deps:
//   - seedDemoSite.ts (server-only repos) stamps it on the demo Site rows and
//     derives the scoped commerce write handle from it;
//   - scripts/db-backfill-demo.ts targets its `tg_<demo>` schema;
//   - vitest.integration.setup.ts (globalSetup, plain Node — NO `@`/server-only
//     aliases) provisions its `tg_<demo>` schema on the shared test container.
//
// Env-overridable so a prod seed/backfill can target a specific provisioned
// tenant-group.
export const DEMO_TENANT_GROUP_ID =
  process.env.DEMO_TENANT_GROUP_ID ?? '018f9c10-0000-7000-8000-0000000000de';
