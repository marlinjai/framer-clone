// src/lib/ai/aiLogger.ts
//
// Structured JSON logging for AI calls. One line per request, written
// to stdout. Pickable by any log forwarder (Coolify, Loki, Datadog
// agent) without needing a structured-logging library.
//
// We deliberately don't pull in pino/winston here — Next.js server logs
// go to stdout and a one-line JSON payload is already structured.

export type AiCallStatus = 'ok' | 'error' | 'rate_limited' | 'overloaded';

export type AiCallLog = {
  requestId: string;
  sessionId: string;
  userId: string | 'anonymous';
  model: string;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  latencyMs: number;
  status: AiCallStatus;
  errorCode?: string;
};

const LOG_PREFIX = '[ai]';

/**
 * Emit a single JSON line for an AI call. Never throws — logging must
 * not be able to take down a request.
 */
export function logAiCall(entry: AiCallLog): void {
  try {
    console.log(`${LOG_PREFIX} ${JSON.stringify(entry)}`);
  } catch {
    // Swallow — logging failure must never propagate.
  }
}

/**
 * Convenience: time a request and produce a partial log entry pre-filled
 * with `latencyMs`. The caller fills in token counts + status when the
 * call finishes (or fails).
 */
export function startAiCallTimer(): { latencyMs: () => number } {
  const start =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  return {
    latencyMs: () => {
      const now =
        typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      return Math.round(now - start);
    },
  };
}
