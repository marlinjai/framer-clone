// Test support for the shop mail: re-exports of the pure helpers (their modules are server-only, mocked in the
// tests), and a fake Lumitra Mail that records every call and can be told to fail.
import { nextAttemptDelayMs } from '../outbox';
import { MailRefused, MailRetryLater, type Letter, type LumitraMail, type MailSender, type MailWorkspace } from '../lumitraMail';
import type { ShopMailKind } from '../templates';

export { callKey } from '../lumitraMail';
export const nextAttemptDelayMsForTest = nextAttemptDelayMs;

export interface FakeMail extends LumitraMail {
  calls: { op: string; args: unknown[] }[];
  sent: Letter[];
  revoked: string[];
  /** Make the next call of `op` fail with this error (once). */
  failNext: (op: keyof LumitraMail, error: MailRetryLater | MailRefused) => void;
  /** Addresses Lumitra Mail reports as blocked. */
  blocked: Set<string>;
}

export function fakeMail(opts: { workspaces: MailWorkspace[]; senders?: Record<string, MailSender[]>; sendDelayMs?: number }): FakeMail {
  const calls: FakeMail['calls'] = [];
  const failures = new Map<string, MailRetryLater | MailRefused>();
  const sent: Letter[] = [];
  const revoked: string[] = [];
  const blocked = new Set<string>();
  const keys = new Map<string, { id: string; key: string }>();
  const inFlight = new Set<string>();
  const sendDelayMs = opts.sendDelayMs ?? 0;
  let n = 0;
  const step = (op: string, args: unknown[]) => {
    calls.push({ op, args });
    const failure = failures.get(op);
    if (failure) {
      failures.delete(op);
      throw failure;
    }
  };
  return {
    calls,
    sent,
    revoked,
    blocked,
    failNext: (op, error) => failures.set(op, error),
    async workspaces(subject) {
      step('workspaces', [subject]);
      return opts.workspaces;
    },
    async senders(subject, workspaceId) {
      step('senders', [subject, workspaceId]);
      return opts.senders?.[workspaceId] ?? [];
    },
    async ensureLanguages(subject, workspace) {
      step('ensureLanguages', [subject, workspace.id]);
    },
    async createKey(subject, workspaceId, attempt) {
      step('createKey', [subject, workspaceId, attempt]);
      // One key per attempt, as Lumitra Mail's idempotency gives.
      if (!keys.has(attempt)) {
        n += 1;
        keys.set(attempt, { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `fake-send-key-${n}` });
      }
      return keys.get(attempt)!;
    },
    async revokeKey(subject, workspaceId, keyId) {
      step('revokeKey', [subject, workspaceId, keyId]);
      revoked.push(keyId);
    },
    async installTemplates(apiKey) {
      step('installTemplates', [apiKey]);
      return { order_confirmation: 'tpl-confirmation', late_refund: 'tpl-refund' } as Record<ShopMailKind, string>;
    },
    async send(apiKey, letter) {
      step('send', [apiKey, letter]);
      // As Lumitra Mail does with an idempotency key: a second call while the first is still running is
      // refused with `conflict` (the shop retries later); once the first finished, a repeat gets its answer and
      // nothing is sent again.
      if (inFlight.has(letter.key)) throw new MailRetryLater(`Lumitra Mail refused sending: conflict (409).`);
      inFlight.add(letter.key);
      try {
        await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
        const earlier = sent.findIndex((l) => l.key === letter.key);
        if (earlier < 0) sent.push(letter);
        const index = earlier < 0 ? sent.length : earlier + 1;
        return { mailingId: `mailing-${index}`, delivery: blocked.has(letter.to) ? 'blocked' : 'sent' };
      } finally {
        inFlight.delete(letter.key);
      }
    },
  };
}
