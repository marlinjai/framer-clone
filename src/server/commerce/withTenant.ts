import 'server-only';

// src/server/commerce/withTenant.ts
//
// The load-bearing tenant seam for the owned commerce engine. Every commerce
// mutation and consistency-critical read runs INSIDE a `withTenant` block so
// the work happens on one connection, inside one transaction, with the schema
// search_path pinned BEFORE any domain query touches a table.
//
// Why SET LOCAL, and why FIRST:
//
//   `SET LOCAL search_path TO ...` scopes the change to the CURRENT
//   transaction. The moment the tx commits or rolls back, Postgres restores
//   the session's prior search_path. That is exactly what we need under a
//   PgBouncer transaction pool: the app's pooled connections are handed out
//   per-transaction and recycled, so a plain `SET` (session scope) on a
//   pooled connection would leak one request's search_path into whatever
//   request grabs that connection next. SET LOCAL cannot leak: it dies with
//   the transaction. Issuing it FIRST (before `fn` runs) guarantees every
//   query `fn` makes already sees the correct schema.
//
// Single-tenant v1 (constant schema):
//
//   v1 ships ONE workspace, so `schema` defaults to the exported
//   `COMMERCE_SCHEMA` constant. The seam is still real: the SET LOCAL is
//   issued on every call, the signature already threads a per-call `schema`,
//   and the transport-agnostic repositories already take the tx client. When
//   E7 introduces the tenant registry + per-tenant schemas, the ONLY change
//   here is that callers pass a resolved tenant schema instead of the
//   constant. The registry, the outbox provisioning consumer, and the
//   N-schema migration runner are explicitly NOT built here (E7 owns them).
//
// Errors surface: a failed SET LOCAL or a throwing `fn` rejects the
// transaction (Prisma rolls it back) and the rejection propagates to the
// caller. Nothing is swallowed.

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The single commerce schema for single-tenant v1. E7 replaces the constant
 * with a per-tenant resolved schema; the `withTenant` signature does not change.
 */
export const COMMERCE_SCHEMA = 'commerce';

// A Postgres identifier we are willing to interpolate into `SET LOCAL
// search_path`. Identifiers cannot be passed as bind parameters, so the schema
// name is validated against this allowlist and then double-quoted. Anything
// outside the allowlist throws rather than risking injection. (For v1 the only
// value is the constant above; the guard is the E7-forward safety net.)
const SAFE_SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENTIFIER_LENGTH = 63; // Postgres NAMEDATALEN - 1

function assertSafeSchema(schema: string): void {
  if (schema.length === 0 || schema.length > MAX_IDENTIFIER_LENGTH || !SAFE_SCHEMA_IDENTIFIER.test(schema)) {
    throw new Error(
      `withTenant: refusing to set an unsafe schema identifier ${JSON.stringify(schema)}`,
    );
  }
}

/**
 * Run `fn` inside a transaction whose search_path is pinned to `COMMERCE_SCHEMA`.
 */
export function withTenant<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
/**
 * Run `fn` inside a transaction whose search_path is pinned to `schema`.
 * The SET LOCAL is issued on the tx connection BEFORE `fn` runs.
 */
export function withTenant<T>(
  prisma: PrismaClient,
  schema: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
export function withTenant<T>(
  prisma: PrismaClient,
  schemaOrFn: string | ((tx: Prisma.TransactionClient) => Promise<T>),
  maybeFn?: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const schema = typeof schemaOrFn === 'string' ? schemaOrFn : COMMERCE_SCHEMA;
  const fn = typeof schemaOrFn === 'string' ? maybeFn : schemaOrFn;

  if (typeof fn !== 'function') {
    throw new Error('withTenant: a callback (tx) => Promise<T> is required');
  }

  assertSafeSchema(schema);

  return prisma.$transaction(async (tx) => {
    // FIRST, on the same connection as `fn`: pin the search_path for the life
    // of this transaction only. `$executeRawUnsafe` is used because a search_path
    // target is an identifier, not a bindable value; the schema is allowlisted
    // and double-quoted above/below so this is safe.
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    return fn(tx);
  });
}
