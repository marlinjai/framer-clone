// src/lib/ai/resumableRun.ts
//
// Browser transport for an AI run that survives the tab going to the
// background (the server side is src/lib/ai/jobRegistry.ts). It chooses the
// run's id (`runId`, announced through onStarted before anything is sent),
// POSTs and reads the SSE stream like before. When the stream dies (iOS drops the connection of a backgrounded tab) or the tab
// comes back to the foreground, it stops trusting the stream and collects the
// run from GET <url>/<id> instead, polling until the run is done; the same
// when the phone went to the background before the response arrived. `resume`
// does only that, for a run started before a reload.
//
// Three different stops: the caller's signal means the user cancelled, which
// also stops the run on the server (DELETE <url>/<id>, keepalive so it is sent
// even while the dialog unmounts); aborting it with DETACH only stops following
// the run here (the editor unmounted, the run stays collectable); dropping a
// dead stream internally never stops anything. Every path ends in exactly one
// onResult or onError.

import { parseSseFrames } from '@/lib/ai/parseSse';

export interface RunErrorPayload {
  code: string;
  message: string;
  retryAfterSec?: number;
}

export interface ResumableHandlers<P, R, E extends RunErrorPayload, U> {
  /** The run's id, as soon as the server registered it (persist it to resume after a reload). */
  onStarted?: (id: string) => void;
  onProgress?: (p: P) => void;
  onResult?: (r: R) => void;
  onError?: (e: E | RunErrorPayload) => void;
  onUsage?: (u: U) => void;
}

export interface ResumableRunConfig {
  /** The POST endpoint; the run itself lives at `${url}/${id}`. */
  url: string;
  /** SSE event names (the `usage` event is shared). */
  events: { started: string; progress: string; result: string; error: string };
  /** The user-facing words for each transport failure. */
  messages: {
    cancelled: string;
    unreachable: string;
    dropped: string;
    gone: string;
    cancelledElsewhere: string;
  };
  /** Pause between two collection requests while the run is still going. */
  pollIntervalMs?: number;
  /** Failed collection requests in a row before giving up (the phone may be offline for a moment). */
  maxPollFailures?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

type RunSnapshot<P, R, E> =
  | { status: 'running'; progress?: P }
  | { status: 'done'; result: R }
  | { status: 'failed'; error: E }
  | { status: 'cancelled' };

/** Abort reason that stops following a run without cancelling it on the server. */
export const DETACH = 'detach';

const isDetach = (signal: AbortSignal) => signal.reason === DETACH;

const DEFAULT_POLL_MS = 1_500;
const DEFAULT_MAX_POLL_FAILURES = 20;
/** After this many polls of a run still going, poll half as often (each poll is an authenticated request). */
const POLLS_BEFORE_BACKOFF = 10;

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError';
}

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Resolves once the tab is visible again (timers are frozen in the background anyway). */
function whenVisible(signal: AbortSignal): Promise<void> {
  if (!hasDocument() || document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (document.visibilityState === 'hidden' && !signal.aborted) return;
      document.removeEventListener('visibilitychange', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    document.addEventListener('visibilitychange', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function errorEnvelope(response: Response, fallback: string): Promise<RunErrorPayload> {
  let payload: RunErrorPayload = { code: 'http_error', message: fallback };
  try {
    const body = (await response.json()) as { error?: Partial<RunErrorPayload> };
    if (body.error?.message) {
      payload = {
        code: body.error.code ?? 'http_error',
        message: body.error.message,
        ...(typeof body.error.retryAfterSec === 'number' ? { retryAfterSec: body.error.retryAfterSec } : {}),
      };
    }
  } catch {
    // non-JSON body: keep the status message
  }
  return payload;
}

export function createResumableRun<Req, P, R, E extends RunErrorPayload, U>(config: ResumableRunConfig) {
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
  const maxFailures = config.maxPollFailures ?? DEFAULT_MAX_POLL_FAILURES;
  const doFetch: typeof fetch = (...args) => (config.fetch ?? globalThis.fetch)(...args);
  const runUrl = (id: string) => `${config.url}/${encodeURIComponent(id)}`;
  type Handlers = ResumableHandlers<P, R, E, U>;

  /** Stop the run on the server; fire and forget (the outcome is reported locally). */
  const cancelOnServer = (id: string) => {
    void doFetch(runUrl(id), { method: 'DELETE', keepalive: true }).catch(() => undefined);
  };

  /** Collect the run by id until it is done. Exactly one onResult/onError. */
  const collect = async (id: string, handlers: Handlers, signal: AbortSignal): Promise<void> => {
    let failures = 0;
    let polls = 0;
    for (;;) {
      if (signal.aborted) return handlers.onError?.({ code: 'aborted', message: config.messages.cancelled });
      await whenVisible(signal);
      if (signal.aborted) continue;
      let response: Response | undefined;
      try {
        response = await doFetch(runUrl(id), { method: 'GET', cache: 'no-store', signal });
      } catch (err) {
        if (isAbort(err)) continue;
      }
      if (response?.status === 404) return handlers.onError?.({ code: 'run_gone', message: config.messages.gone });
      if (response && (response.status === 401 || response.status === 403)) {
        return handlers.onError?.(await errorEnvelope(response, config.messages.gone));
      }
      let snapshot: RunSnapshot<P, R, E> | undefined;
      if (response?.ok) {
        try {
          snapshot = (await response.json()) as RunSnapshot<P, R, E>;
        } catch {
          snapshot = undefined;
        }
      }
      if (!snapshot) {
        failures += 1;
        if (failures >= maxFailures) return handlers.onError?.({ code: 'network_error', message: config.messages.dropped });
        await sleep(pollMs, signal);
        continue;
      }
      failures = 0;
      switch (snapshot.status) {
        case 'done':
          return handlers.onResult?.(snapshot.result);
        case 'failed':
          return handlers.onError?.(snapshot.error);
        case 'cancelled':
          return handlers.onError?.({ code: 'cancelled', message: config.messages.cancelledElsewhere });
        default:
          if (snapshot.progress) handlers.onProgress?.(snapshot.progress);
          polls += 1;
          await sleep(polls > POLLS_BEFORE_BACKOFF ? pollMs * 2 : pollMs, signal);
      }
    }
  };

  /** Start a run and follow it to its outcome, through backgrounding. */
  const start = async (req: Req, handlers: Handlers, signal?: AbortSignal): Promise<void> => {
    const userSignal = signal ?? new AbortController().signal;
    // Drops the stream (a dead connection, or the tab came back): never a cancel.
    const stream = new AbortController();
    // Chosen here, so the run can be collected even if no response ever arrives.
    const id = globalThis.crypto.randomUUID();
    let settled = false;
    let switchToCollect = false;
    // The tab was in the background at some point: a failed request may have
    // reached the server anyway, so it is worth collecting.
    let wentHidden = hasDocument() && document.visibilityState === 'hidden';

    const onUserAbort = () => {
      stream.abort();
      if (!settled && !isDetach(userSignal)) cancelOnServer(id);
    };
    userSignal.addEventListener('abort', onUserAbort, { once: true });
    // Back in the foreground: the stream may be dead without having errored
    // yet (iOS), so collect the run instead of waiting on it.
    const onVisible = () => {
      if (hasDocument() && document.visibilityState !== 'visible') {
        wentHidden = true;
        return;
      }
      if (settled) return;
      switchToCollect = true;
      stream.abort();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) onVisible();
    };
    if (hasDocument()) document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.addEventListener('pageshow', onPageShow);
    const cleanup = () => {
      userSignal.removeEventListener('abort', onUserAbort);
      if (hasDocument()) document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.removeEventListener('pageshow', onPageShow);
    };

    try {
      if (userSignal.aborted) {
        handlers.onError?.({ code: 'aborted', message: config.messages.cancelled });
        return;
      }
      handlers.onStarted?.(id);
      let response: Response;
      try {
        response = await doFetch(config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...req, runId: id }),
          signal: stream.signal,
        });
      } catch (err) {
        if (isAbort(err) && userSignal.aborted) {
          handlers.onError?.({ code: 'aborted', message: config.messages.cancelled });
          return;
        }
        // Backgrounded mid-request: the server may well be running it.
        if (wentHidden || switchToCollect) {
          await collect(id, handlers, userSignal);
          settled = true;
          return;
        }
        handlers.onError?.({ code: 'network_error', message: config.messages.unreachable });
        return;
      }

      if (!response.ok || !response.body) {
        handlers.onError?.(await errorEnvelope(response, `Request failed (${response.status}).`));
        return;
      }

      const dispatch = (event: string, data: string): void => {
        let payload: unknown;
        try {
          payload = data ? JSON.parse(data) : {};
        } catch {
          return;
        }
        if (settled) {
          if (event === 'usage') handlers.onUsage?.(payload as U);
          return;
        }
        switch (event) {
          case config.events.started:
            // Confirms the id this transport chose; nothing to do.
            return;
          case config.events.progress:
            handlers.onProgress?.(payload as P);
            return;
          case config.events.result:
            settled = true;
            handlers.onResult?.(payload as R);
            return;
          case config.events.error:
            settled = true;
            // The server aborts when any client sends DELETE. If this one did
            // not cancel, the run was cancelled elsewhere.
            if ((payload as RunErrorPayload | null)?.code === 'aborted' && !userSignal.aborted) {
              handlers.onError?.({ code: 'cancelled', message: config.messages.cancelledElsewhere });
            } else {
              handlers.onError?.(payload as E);
            }
            return;
          case 'usage':
            handlers.onUsage?.(payload as U);
            return;
          default:
            return;
        }
      };

      const reader = response.body.getReader();
      // Dropping the stream ends a pending read at once, whether or not the
      // browser tears the body down with the aborted fetch.
      const stopReading = () => void reader.cancel().catch(() => undefined);
      stream.signal.addEventListener('abort', stopReading, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      let streamError: unknown;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.value) {
            buffer += decoder.decode(chunk.value, { stream: true });
            const parsed = parseSseFrames(buffer);
            buffer = parsed.rest;
            for (const f of parsed.frames) dispatch(f.event, f.data);
          }
          if (chunk.done) break;
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          for (const f of parseSseFrames(`${buffer}\n\n`).frames) dispatch(f.event, f.data);
        }
      } catch (err) {
        streamError = err;
      } finally {
        stream.signal.removeEventListener('abort', stopReading);
      }
      if (settled) return;
      if (userSignal.aborted) {
        settled = true;
        handlers.onError?.({ code: 'aborted', message: config.messages.cancelled });
        return;
      }
      if (switchToCollect || streamError !== undefined) stopReading();
      // The stream ended (or was dropped) without an outcome: the server
      // accepted the run, so collect it.
      await collect(id, handlers, userSignal);
      settled = true;
    } finally {
      cleanup();
    }
  };

  /** Follow a run started earlier (before a reload) to its outcome. */
  const resume = async (id: string, handlers: Handlers, signal?: AbortSignal): Promise<void> => {
    const userSignal = signal ?? new AbortController().signal;
    let settled = false;
    const onUserAbort = () => {
      if (!settled && !isDetach(userSignal)) cancelOnServer(id);
    };
    userSignal.addEventListener('abort', onUserAbort, { once: true });
    try {
      await collect(id, handlers, userSignal);
    } finally {
      settled = true;
      userSignal.removeEventListener('abort', onUserAbort);
    }
  };

  return { start, resume };
}
