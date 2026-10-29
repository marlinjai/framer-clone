// src/lib/ai/review/client.ts
//
// Browser transport for POST /api/ai/review-page, the same resumable transport
// as the page generator's (src/lib/ai/resumableRun.ts): a review keeps running
// on the server when the phone switches apps, and this transport collects it
// from GET /api/ai/review-page/[id] when the stream dies or the tab comes
// back. Every failure path ends in exactly one onError call, so the review
// never stalls silently. Injectable for tests.

import { createResumableRun } from '@/lib/ai/resumableRun';
import type {
  ReviewErrorPayload,
  ReviewProgress,
  ReviewRequest,
  ReviewResultPayload,
  ReviewUsagePayload,
} from './protocol';

export interface ReviewHandlers {
  onProgress?: (p: ReviewProgress) => void;
  onResult?: (r: ReviewResultPayload) => void;
  onError?: (e: ReviewErrorPayload) => void;
  onUsage?: (u: ReviewUsagePayload) => void;
}

export type ReviewTransport = (req: ReviewRequest, handlers: ReviewHandlers, signal?: AbortSignal) => Promise<void>;

const run = createResumableRun<ReviewRequest, ReviewProgress, ReviewResultPayload, ReviewErrorPayload, ReviewUsagePayload>({
  url: '/api/ai/review-page',
  events: { started: 'review:started', progress: 'review:progress', result: 'review:result', error: 'review:error' },
  messages: {
    cancelled: 'The review was cancelled.',
    unreachable: 'Could not reach the server for the review.',
    dropped: 'The connection dropped during the review.',
    gone: 'This review is no longer available on the server (it never arrived, the server restarted, or it finished more than 15 minutes ago).',
    cancelledElsewhere: 'This review was cancelled.',
  },
});

export const fetchReviewTransport: ReviewTransport = run.start;
