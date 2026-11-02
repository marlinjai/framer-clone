import 'server-only';

// src/server/mcp/confirmations.ts
//
// The person's yes before an agent publishes or rolls back a site (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, decision 6). Two ways:
//
//   1. Elicitation: the client can show a dialog (it declared `elicitation` at
//      initialize, see ./session.ts). The tool asks there, and the action runs
//      only on an explicit accept with `confirm: true`.
//   2. A one-time token, for a client without a dialog: the first call does every
//      check, writes nothing, and answers `confirmationRequired` with a summary
//      and a token. The agent shows the summary to the person and calls again
//      with the token only after they said yes.
//
// A token names one exact subject (./tools.ts builds it): the action, the key,
// its company, the site, and for publish the version the person was shown (any
// write bumps the version, so the version pins the content that goes live; no
// separate content hash is needed). For rollback it names the revision and the
// site's version and live revision at the time. It expires after
// CONFIRMATION_TTL_MS and is spent on its first use, matching or not, so a token
// can never authorize anything other than what the person was shown.
//
// Process-local, like the other per-request state of this app (the key cache,
// the generation rate limit): framer-clone runs as one container (deploy/README.md,
// "the app must run as a single container"). A restart forgets the tokens, and the
// agent then gets a fresh summary and token to show the person again.

import { randomBytes } from 'node:crypto';

/** How long a confirmation token stays valid. */
export const CONFIRMATION_TTL_MS = 5 * 60_000;
/** Most tokens held at once; the oldest is dropped beyond it. */
export const CONFIRMATION_MAX = 1_000;

export class ConfirmationStore {
  readonly #tokens = new Map<string, { subject: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(subject: string): string {
    this.#sweep();
    while (this.#tokens.size >= CONFIRMATION_MAX) {
      const oldest = this.#tokens.keys().next().value;
      if (oldest === undefined) break;
      this.#tokens.delete(oldest);
    }
    const token = `conf_${randomBytes(18).toString('base64url')}`;
    this.#tokens.set(token, { subject, expiresAt: this.#now() + CONFIRMATION_TTL_MS });
    return token;
  }

  /** True once, for a live token issued for exactly this subject. The token is spent either way. */
  redeem(token: string, subject: string): boolean {
    this.#sweep();
    const entry = this.#tokens.get(token);
    if (!entry) return false;
    this.#tokens.delete(token);
    return entry.subject === subject;
  }

  get size(): number {
    return this.#tokens.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, entry] of this.#tokens) if (entry.expiresAt <= now) this.#tokens.delete(token);
  }
}

/** What asking the person through the client's dialog ended in. `unavailable`: no dialog could be shown. */
export type ConfirmOutcome = 'confirmed' | 'declined' | 'unavailable';
export type ConfirmFn = (message: string) => Promise<ConfirmOutcome>;
