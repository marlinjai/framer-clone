import 'server-only';

// src/server/mcp/elicitation.ts
//
// Asking the person through the client's dialog (MCP elicitation) on an endpoint
// that keeps no session. The tool call that needs a yes is answered as a stream
// (text/event-stream): the endpoint sends an `elicitation/create` request on it,
// and the client posts its answer (a JSON-RPC response with the same id) as a new
// HTTP request. That answer is matched here to the call still waiting on its
// stream, by the request id (random, never guessable) and the fingerprint of the
// key both requests carry, so one key can never answer another key's question.
//
// Process-local, like the confirmation tokens (./confirmations.ts): framer-clone
// runs as one container. Without an answer within ELICITATION_TIMEOUT_MS, or when
// the client answers with an error (it cannot show the dialog after all), the
// question counts as unanswered and the tool falls back to the one-time token.

import { randomUUID } from 'node:crypto';
import type { ConfirmOutcome } from './confirmations';

/** How long a confirmation dialog may stay open before the tool falls back to a token. */
export const ELICITATION_TIMEOUT_MS = 120_000;
/** Most questions open at once; beyond it a new one is not asked (the token path is used). */
export const ELICITATION_MAX_PENDING = 200;

interface Pending {
  fingerprint: string;
  resolve: (outcome: ConfirmOutcome) => void;
}

const pending = new Map<string, Pending>();

/** An elicitation answer as the client posts it. */
export interface ClientResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export function isClientResponse(value: unknown): value is ClientResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && v.method === undefined && 'id' in v && ('result' in v || 'error' in v);
}

/** What the client's answer means for the confirmation. Only an explicit accept with confirm true is a yes. */
function outcomeOf(response: ClientResponse): ConfirmOutcome {
  if (response.error) return 'unavailable';
  const result = (response.result ?? {}) as { action?: unknown; content?: { confirm?: unknown } };
  if (result.action === 'accept') return result.content?.confirm === true ? 'confirmed' : 'declined';
  return 'declined';
}

/**
 * Open one question. `send` writes the request to the waiting stream; the returned
 * promise settles with the person's answer, `unavailable` after the timeout or
 * when `signal` aborts (the client went away).
 */
export function ask(
  fingerprint: string,
  message: string,
  send: (request: Record<string, unknown>) => void,
  signal?: AbortSignal,
  timeoutMs: number = ELICITATION_TIMEOUT_MS,
): Promise<ConfirmOutcome> {
  if (pending.size >= ELICITATION_MAX_PENDING || signal?.aborted) return Promise.resolve('unavailable');
  const id = `elicit_${randomUUID()}`;
  return new Promise<ConfirmOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ConfirmOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      resolve(outcome);
    };
    const onAbort = () => settle('unavailable');
    const timer = setTimeout(() => settle('unavailable'), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    pending.set(id, { fingerprint, resolve: settle });
    send({
      jsonrpc: '2.0',
      id,
      method: 'elicitation/create',
      params: {
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Confirm', description: 'Yes, do it.' },
          },
          required: ['confirm'],
        },
      },
    });
  });
}

/**
 * Deliver a client's answer to the question it belongs to. False when no open
 * question has that id for this key (unknown, already answered, timed out, or
 * asked of another key).
 */
export function deliver(fingerprint: string, response: ClientResponse): boolean {
  if (typeof response.id !== 'string') return false;
  const entry = pending.get(response.id);
  if (!entry || entry.fingerprint !== fingerprint) return false;
  entry.resolve(outcomeOf(response));
  return true;
}

/** Open questions (tests). */
export function pendingCount(): number {
  return pending.size;
}
