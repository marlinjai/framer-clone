// What the database says when it aborts a transaction against another one, as Prisma reports it.
//
// A Prisma query reports a serialization failure or a deadlock as P2034. A RAW query (the row locks and
// advisory locks of the site writers) reports Postgres' own code, 40001 for a serialization failure and 40P01 for
// a deadlock, as P2010 with the code in `meta.code` (the same reading as the branch merge's own retry).

import { Prisma } from '@prisma/client';

/** A transaction the database aborted against another one: worth running again. */
export function isDatabaseConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2034') return true;
  const raw = err.code === 'P2010' ? (err.meta as { code?: unknown } | undefined)?.code : null;
  return raw === '40001' || raw === '40P01';
}
