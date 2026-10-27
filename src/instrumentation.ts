// src/instrumentation.ts
//
// Next.js calls register() once when a server instance starts. Used for
// start-time configuration checks. Most only log (the OpenFGA token warning
// must never fail the start); the EDITOR_HOST assertion is the deliberate
// exception: a production server without an editor host would serve the
// editor as a published site, so it refuses to start (boot.sh refuses first,
// this covers any start that bypasses it). The work lives in
// instrumentation.node.ts.

export async function register(): Promise<void> {
  // The Node server only: the edge runtime has its own instance and would log
  // the same warning twice. The positive check (not an early return) is what
  // keeps the Node-only modules out of the edge bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation.node');
    await registerNode();
  }
}
