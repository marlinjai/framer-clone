// src/instrumentation.ts
//
// Next.js calls register() once when a server instance starts. Used for
// start-time configuration checks. Most only log (the OpenFGA token warning
// must never fail the start); the EDITOR_HOST assertion is the deliberate
// exception: a production server without an editor host would serve the
// editor as a published site, so it refuses to start (boot.sh refuses first,
// this covers any start that bypasses it).

export async function register(): Promise<void> {
  // The Node server only: the edge runtime has its own instance and would log
  // the same warning twice.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEditorHostConfigured } = await import('./lib/editorHost');
  try {
    assertEditorHostConfigured();
  } catch (err) {
    // A thrown register() only logs "Failed to prepare server" and leaves the
    // process up (verified with `next start`), so exit explicitly: the
    // container must fail its start, not linger half-configured.
    console.error(`[startup] ${(err as Error).message}`);
    process.exit(1);
  }
  const { warnIfOpenfgaTokenMissing } = await import('./lib/openfgaConfig');
  warnIfOpenfgaTokenMissing();
}
