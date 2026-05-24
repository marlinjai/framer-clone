// src/lib/ai/aiUsageStub.ts
//
// In-memory usage counter, keyed by sessionId. Placeholder for the real
// per-user cost cap that arrives with auth-brain v1. Records calls but
// does NOT enforce a limit — calling `recordUsage` always succeeds, and
// `getUsage` is read-only.
//
// Process-local: data does not survive a restart and is not shared
// across workers. That's fine for a stub; the real implementation will
// live in Postgres + Redis.

export type AiUsageEntry = {
  sessionId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  lastUpdatedMs: number;
};

const _usage = new Map<string, AiUsageEntry>();

export function recordUsage(input: {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}): AiUsageEntry {
  const prev = _usage.get(input.sessionId) ?? {
    sessionId: input.sessionId,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    lastUpdatedMs: 0,
  };
  const next: AiUsageEntry = {
    sessionId: input.sessionId,
    calls: prev.calls + 1,
    inputTokens: prev.inputTokens + input.inputTokens,
    outputTokens: prev.outputTokens + input.outputTokens,
    cachedReadTokens: prev.cachedReadTokens + (input.cachedReadTokens ?? 0),
    cachedWriteTokens: prev.cachedWriteTokens + (input.cachedWriteTokens ?? 0),
    lastUpdatedMs: Date.now(),
  };
  _usage.set(input.sessionId, next);
  return next;
}

export function getUsage(sessionId: string): AiUsageEntry | undefined {
  return _usage.get(sessionId);
}

/** Test-only escape hatch. */
export function __resetAiUsageForTests(): void {
  _usage.clear();
}
