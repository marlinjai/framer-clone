// src/server/mcp/confirmations.ts
//
// The person's yes before an agent publishes or rolls back a site (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, decision 6). Two ways,
// in this order:
//
//   1. Elicitation: the client can show a dialog (it declared `elicitation` at
//      initialize, see ./session.ts). The tool asks there (./elicitation.ts), and
//      the action runs only on an explicit accept with `confirm: true`.
//   2. An approval link, for a client without a dialog or when the dialog got no
//      answer (./approvals.ts): a signed-in person with publishSite approves in
//      the editor, and only then does the agent's second call proceed.

/** What asking the person through the client's dialog ended in. `unavailable`: no dialog could be shown. */
export type ConfirmOutcome = 'confirmed' | 'declined' | 'unavailable';
export type ConfirmFn = (message: string) => Promise<ConfirmOutcome>;
