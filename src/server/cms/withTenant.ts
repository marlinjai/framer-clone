import 'server-only';

// src/server/cms/withTenant.ts
//
// E7 MULTI-TENANT SEAM: DESIGNED, NOT BUILT.
//
// This is the single, intentional hook for the future multi-tenant chassis
// (epic E7). The SIGNATURE is the real one we will ship: a caller hands us a
// PrismaClient, a target schema, and a unit of work, and we run that work with
// the connection's `search_path` pinned to the tenant's schema so every query
// inside `fn` transparently hits the right Postgres schema.
//
// Phase 1 is single-tenant: the passed `schema` argument is ignored and the
// body collapses to the constant CMS_SCHEMA. We keep the `SET LOCAL
// search_path` shape (run inside a transaction, where SET LOCAL is scoped) so
// the multi-tenant build is a one-line change (swap the constant for the
// argument) rather than a re-plumb of every call site.

import type { Prisma, PrismaClient } from '@prisma/client';
import { CMS_SCHEMA } from './adapterClient';

/**
 * Run `fn` with the connection's search_path pinned to the CMS schema.
 *
 * E7 seam: today `schema` is ignored and the body always uses the constant
 * CMS_SCHEMA. The multi-tenant version will use the `schema` argument instead.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  schema: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Single-tenant: the requested `schema` collapses to the constant CMS_SCHEMA.
  // (Referenced so the unused-argument lint stays quiet; the multi-tenant build
  // will use it in the SET LOCAL below.)
  void schema;

  return prisma.$transaction(async (tx) => {
    // SET LOCAL is transaction-scoped, so it reverts when this transaction
    // ends and never leaks the search_path onto a pooled connection. Identifier
    // is a trusted compile-time constant, not user input.
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${CMS_SCHEMA}"`);
    return fn(tx);
  });
}
