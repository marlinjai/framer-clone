// src/instrumentation.node.ts
//
// The Node-server half of register(). Kept in its own module because Next
// compiles instrumentation.ts for the edge runtime too, and only a positive
// `NEXT_RUNTIME === 'nodejs'` block around the import lets webpack drop this
// file (and the Postgres driver behind the mail sweep) from that build.

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
  // The shop's receipt email: retry what could not be sent, every minute (only when Lumitra Mail is configured).
  // A failure to start is logged, never a failed start: the shop sells without its mail.
  try {
    const { startShopMailSweep } = await import('./server/commerce/mail/runtime');
    startShopMailSweep();
  } catch (err) {
    console.error('[startup] the shop mail sweep did not start:', err);
  }
}
