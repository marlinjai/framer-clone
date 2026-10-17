import 'server-only';

// src/server/db.ts
//
// The single server-only PrismaClient for framer-clone. It serves the CMS
// engine (the dt_* models), the site persistence models and the agent run log,
// all in the `public` schema. Commerce does NOT go through Prisma: it has its
// own per-company Kysely handle in src/server/commerce/db.ts. The
// `import 'server-only'` guard on line 1 makes `next build` fail if this module
// is ever pulled into a client component bundle.
//
// The instance is cached on globalThis so Next.js dev HMR (which re-evaluates
// modules on every edit) reuses one client instead of opening a new pool on
// each reload (a connection storm that exhausts Postgres). The client is
// constructed lazily on first call, so importing this module costs nothing
// and `next build` needs no live DATABASE_URL.

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  __framerClonePrisma?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.__framerClonePrisma) {
    globalForPrisma.__framerClonePrisma = new PrismaClient();
  }
  return globalForPrisma.__framerClonePrisma;
}
