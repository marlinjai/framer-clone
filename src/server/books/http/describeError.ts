// src/server/books/http/describeError.ts
//
// How the Books log an unexpected error without the customer data its message
// can carry. No `server-only` import: the upload's service (driven directly by
// the integration tests) logs through it too.

/**
 * An unexpected error as the log may carry it: its kind, the database's
 * SQLSTATE and the constraint, table and column it names, and the stack frames,
 * never its message. A database error's message and detail can quote the
 * values of the row (an invoice's amounts, a recipient's name), and the Books
 * hold customers' data.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const e = err as Error & Record<string, unknown>;
  const fields = ['code', 'constraint_name', 'table_name', 'column_name', 'routine']
    .filter((k) => typeof e[k] === 'string' && e[k] !== '')
    .map((k) => `${k}=${String(e[k])}`);
  const frames = (e.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).join('\n');
  return [`${e.name}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`, frames].filter(Boolean).join('\n');
}
