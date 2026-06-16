# `src/server/**`: the server-only boundary

Everything under `src/server/**` runs ONLY on the Node.js server. It is the
home of the database client and (later) the CMS and commerce engines. None of
it is ever imported by a client component.

## Boundary contract

- **Server-only.** Every module here either starts with `import 'server-only'`
  or is only reachable through a module that does. `server-only` is a real
  dependency: if any of this code is pulled into a client component bundle,
  `next build` fails loudly instead of leaking server code (and secrets like
  `DATABASE_URL`) into the browser.
- **No React, no client state.** This layer holds data access and domain
  logic, not components or stores. It does not touch MST. The active client
  data provider stays `InMemoryDataSourceProvider` until Track A swaps it.
- **Current contents:** `db.ts` (the PrismaClient singleton). Later: `cms/`
  (the CMS adapter + repository) and `commerce/` (the owned commerce engine).
  Engine separation is this code boundary, NOT a database boundary: one
  PrismaClient and one Postgres schema serve both (see `prisma/schema.prisma`).

## The PrismaClient singleton (`db.ts`)

`getPrismaClient()` returns a single `globalThis`-cached `PrismaClient`. The
cache survives Next.js dev HMR so repeated edits reuse one connection pool
instead of opening a new one each reload (which would storm Postgres). The
client is built lazily on first call, so importing `db.ts` is free and
`next build` needs no live database: a placeholder `DATABASE_URL` is enough.

`DATABASE_URL` is injected via Infisical / Coolify. It is NEVER written to a
`.env` file and NEVER hard-coded. Migration commands run under Infisical
injection (see the root README / `package.json` `db:*` scripts).

## `src/app/api/*` route conventions

Every DB-backed route handler follows the same shape:

```ts
import { getPrismaClient } from '@/server/db';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';        // PrismaClient needs Node, not edge
export const dynamic = 'force-dynamic'; // never statically cache DB reads

export async function POST(req: Request): Promise<Response> {
  // 1. Admin guard on mutations (see the can() seam below).
  // 2. Validate the body with zod via parseBody().
  const parsed = await parseBody(req, SomeSchema);
  if (!parsed.ok) return parsed.response;

  // 3. Do the work through getPrismaClient().
  // 4. Return Response.json(...) on success, jsonError(...) on failure.
}
```

- **Route segment:** one handler per `route.ts` under `src/app/api/<path>/`.
- **Body validation:** always `parseBody(req, zodSchema)`; never trust raw JSON.
- **Error envelope:** always `jsonError(code, message, status, extra?)`, which
  produces `{ error: { code, message, ... } }`, matching the AI route
  precedent (`src/app/api/ai/edit/route.ts`). Errors surface; never swallowed.
- **Runtime:** `runtime = 'nodejs'` on every DB-backed route; add
  `dynamic = 'force-dynamic'` so a probe or read is not cached at build time.

## Admin-guard SEAM (`can()`-shaped, NOT implemented here)

Auth is out of scope for this foundation. This is only the SEAM the interim
admin guard (owned by Track A `slice2-admin-guard-stub`) will fill. The agreed
shape mutation routes call before touching the database:

```ts
// Shape only. The real implementation lands in the admin-guard stub spec.
// can(action, resource) -> boolean | Promise<boolean>
//
// Mutation routes (POST / PATCH / PUT / DELETE):
//   if (!(await can('write', 'cms'))) {
//     return jsonError('forbidden', 'admin only', 403);
//   }
//
// Read routes (GET) are unauthenticated for v1.
```

Do not implement `can()` here. Routes added before the guard exists simply
leave the guard call as a documented TODO at the top of the handler.
