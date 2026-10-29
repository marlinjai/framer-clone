// src/lib/ai/pageGen/client.ts
//
// Browser transport for POST /api/ai/generate-page. A generation keeps running
// on the server when the phone switches apps; this transport follows it
// through that (src/lib/ai/resumableRun.ts): it reads the stream, and when the
// stream dies or the tab comes back it collects the run from
// GET /api/ai/generate-page/[id]. `resumePageGen` collects a run started
// before a reload. Every failure path ends in exactly one onError call, so the
// dialog never stalls silently. Injectable into the dialog for tests.

import { createResumableRun } from '@/lib/ai/resumableRun';
import type {
  PageGenErrorPayload,
  PageGenProgress,
  PageGenRequest,
  PageGenResultPayload,
  PageGenUsagePayload,
} from './protocol';

export interface PageGenHandlers {
  /** The run's id, once the server registered it (kept so a reload can collect it). */
  onStarted?: (generationId: string) => void;
  onProgress?: (p: PageGenProgress) => void;
  onResult?: (r: PageGenResultPayload) => void;
  onError?: (e: PageGenErrorPayload) => void;
  onUsage?: (u: PageGenUsagePayload) => void;
}

export type PageGenTransport = (
  req: PageGenRequest,
  handlers: PageGenHandlers,
  signal?: AbortSignal,
) => Promise<void>;

/** Collect a generation by id (started before a reload); aborting the signal cancels it. */
export type PageGenResume = (generationId: string, handlers: PageGenHandlers, signal?: AbortSignal) => Promise<void>;

const run = createResumableRun<PageGenRequest, PageGenProgress, PageGenResultPayload, PageGenErrorPayload, PageGenUsagePayload>({
  url: '/api/ai/generate-page',
  events: { started: 'gen:started', progress: 'gen:progress', result: 'gen:result', error: 'gen:error' },
  messages: {
    cancelled: 'Generation was cancelled.',
    unreachable: 'Could not reach the server. Check your connection and try again.',
    dropped: 'The connection dropped during generation. Try again.',
    closedWithoutResult: 'The server closed the connection without a result. Try again.',
    gone: 'This generation is no longer available (the server restarted, or it finished more than 15 minutes ago). Try again.',
    cancelledElsewhere: 'This generation was cancelled.',
  },
});

export const fetchPageGenTransport: PageGenTransport = run.start;
export const resumePageGen: PageGenResume = run.resume;
