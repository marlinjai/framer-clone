import 'server-only';

// src/server/cms/tableScopedAdapter.ts
//
// A CMS PrismaAdapter whose table discovery is narrowed to ONE table, for the
// published plane's row-by-id read.
//
// Why: the data-table adapter's `getRow(rowId)` has no table argument. It lists
// EVERY migrated table of every tenant (`prisma.dtTable.findMany({ where: {
// migrated: true } })`) and probes them one by one until the id turns up, so an
// anonymous storefront request could make the server walk the whole fleet's
// tables. The adapter exposes no single-table lookup and its row-mapping
// helpers are private, so instead the adapter is handed a Prisma client whose
// `dtTable.findMany` always ANDs `{ id: tableId }` into the caller's `where`.
// The caller has already verified that `tableId` belongs to the site's
// workspace, so the lookup touches exactly that one table.
//
// Dependency on adapter internals, documented on purpose: if a future adapter
// version discovers tables some other way, the narrowing simply stops applying
// and the read degrades to the old (correct but slower) scan. The proxy can only
// ever NARROW a query, never widen one, and every result is still checked by the
// repository (row.tableId === tableId).

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';

type FindManyArgs = { where?: Record<string, unknown> } & Record<string, unknown>;

/** Wrap `prisma` so every `dtTable.findMany` is restricted to `tableId`. */
export function narrowDtTableDiscovery(prisma: PrismaClient, tableId: string): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'dtTable') {
        const delegate = value as Record<string | symbol, unknown> & {
          findMany: (args?: FindManyArgs) => unknown;
        };
        return new Proxy(delegate, {
          get(dt, key) {
            if (key === 'findMany') {
              return (args: FindManyArgs = {}) =>
                dt.findMany({
                  ...args,
                  where: { AND: [args.where ?? {}, { id: tableId }] },
                });
            }
            const member = Reflect.get(dt, key);
            return typeof member === 'function' ? member.bind(dt) : member;
          },
        });
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A fresh adapter that only ever discovers `tableId` (see the file header). */
export function tableScopedCmsAdapter(
  tableId: string,
  prisma: PrismaClient = getPrismaClient(),
): PrismaAdapter {
  return new PrismaAdapter({ prisma: narrowDtTableDiscovery(prisma, tableId) });
}
