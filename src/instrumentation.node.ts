// src/instrumentation.node.ts
//
// The Node-server half of register(). Kept in its own module because Next
// compiles instrumentation.ts for the edge runtime too, and only a positive
// `NEXT_RUNTIME === 'nodejs'` block around the import lets webpack drop this
// file (and the Postgres driver behind the mail sweep and the job worker) from that
// build.

export async function registerNode(): Promise<void> {
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
  // The shop's job engine: a pass over every tenant group, every 30 seconds. Also never a failed start, and the host
  // timer's watchdog route gets the same work done if this does not run.
  try {
    const { startCommerceWorker } = await import('./server/commerce/jobs/runtime');
    startCommerceWorker();
  } catch (err) {
    console.error('[startup] the commerce job worker did not start:', err);
  }
}
