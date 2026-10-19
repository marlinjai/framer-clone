// src/instrumentation.ts
//
// Next.js calls register() once when a server instance starts. Used for
// start-time configuration checks that must be visible in the container log
// but must never fail the start.

export async function register(): Promise<void> {
  // The Node server only: the edge runtime has its own instance and would log
  // the same warning twice.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { warnIfOpenfgaTokenMissing } = await import('./lib/openfgaConfig');
  warnIfOpenfgaTokenMissing();
}
