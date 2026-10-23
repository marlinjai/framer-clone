// src/lib/ai/review/runReview.ts
//
// One round of the visual review pass, in the editor:
//   1. wait for the page to be on the canvas (frames mounted, fonts and images
//      loaded, bounded by a timeout),
//   2. measure every breakpoint frame and classify the layout findings
//      (./measureDom.ts, ./layoutAudit.ts),
//   3. capture the largest and the smallest frame as JPEGs (./capture.ts),
//   4. send the tree, findings, images and brief to the review endpoint,
//   5. apply the returned operations as one undo step (./editorReview.ts).
//
// Fails soft at every step: a failed measurement or capture becomes a note
// and the review continues with what it has; a failed request or apply leaves
// the page exactly as it was and returns the reason. Nothing is applied after
// the signal aborted. Every browser dependency is injectable for tests.

import type { PageModelType } from '@/models/PageModel';
import { auditRenderedFrames, frameContentElement, type DomAuditResult } from './measureDom';
import { captureFrame, type CaptureOutcome } from './capture';
import { applyReviewOps, reviewBreakpoints, serializeForReview, type ReviewBreakpoint } from './editorReview';
import { fetchReviewTransport, type ReviewTransport } from './client';
import {
  REVIEW_LIMITS,
  type RejectedOp,
  type ReviewErrorPayload,
  type ReviewImage,
  type ReviewModel,
  type ReviewOp,
  type ReviewProgress,
  type ReviewResultPayload,
  type ReviewUsagePayload,
} from './protocol';
import type { LayoutFinding } from './layoutAudit';

export type ReviewStage = 'rendering' | 'measuring' | 'capturing' | ReviewProgress['phase'] | 'applying';

export interface ReviewRunDeps {
  transport: ReviewTransport;
  /** Resolves when the page's frames are rendered (or the timeout passed). */
  waitForRender: (frames: ReviewBreakpoint[], signal: AbortSignal) => Promise<void>;
  audit: (frames: ReviewBreakpoint[]) => DomAuditResult;
  capture: (frame: ReviewBreakpoint) => Promise<CaptureOutcome>;
  apply: typeof applyReviewOps;
}

export interface ReviewRunInput {
  page: PageModelType;
  model: ReviewModel;
  brief?: string;
  signal: AbortSignal;
  onStage?: (stage: ReviewStage, detail?: { receivedChars?: number }) => void;
  deps?: Partial<ReviewRunDeps>;
}

export interface ReviewRunSuccess {
  ok: true;
  summary: string;
  findings: LayoutFinding[];
  applied: ReviewOp[];
  rejected: RejectedOp[];
  historyEntryId: string | null;
  notes: string[];
  model: string;
  usage?: ReviewUsagePayload;
}

export interface ReviewRunFailure {
  ok: false;
  code: string;
  message: string;
  findings: LayoutFinding[];
  notes: string[];
  usage?: ReviewUsagePayload;
}

export type ReviewRunResult = ReviewRunSuccess | ReviewRunFailure;

const RENDER_TIMEOUT_MS = 6_000;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wait until every frame's content box exists, fonts are ready and its images loaded (bounded). */
export async function waitForFramesRendered(frames: ReviewBreakpoint[], signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  const timeLeft = () => Math.max(0, deadline - Date.now());
  // Two frames after the store change so React has committed and painted.
  await nextFrame();
  await nextFrame();
  while (!signal.aborted && timeLeft() > 0 && frames.some((f) => !frameContentElement(document, f.viewportId))) {
    await nextFrame();
  }
  const withTimeout = (p: Promise<unknown>) =>
    Promise.race([p, new Promise((resolve) => setTimeout(resolve, timeLeft()))]);
  if (typeof document !== 'undefined' && document.fonts?.ready) await withTimeout(document.fonts.ready);
  const images: HTMLImageElement[] = [];
  for (const f of frames) {
    const content = frameContentElement(document, f.viewportId);
    if (content) images.push(...Array.from(content.querySelectorAll('img')));
  }
  await withTimeout(
    Promise.all(
      images
        .filter((img) => !img.complete)
        .map((img) => new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        })),
    ),
  );
  await nextFrame();
}

const defaultDeps = (): ReviewRunDeps => ({
  transport: fetchReviewTransport,
  waitForRender: waitForFramesRendered,
  audit: (frames) =>
    auditRenderedFrames(
      frames.map((f, i) => ({ viewportId: f.viewportId, breakpoint: f.key, isSmallest: i === frames.length - 1 })),
      { maxFindings: REVIEW_LIMITS.maxFindings },
    ),
  capture: async (frame) => {
    const element = frameContentElement(document, frame.viewportId);
    if (!element) return { ok: false, breakpoint: frame.key, reason: 'the frame is not on the canvas' };
    return captureFrame({ element, breakpoint: frame.key });
  },
  apply: applyReviewOps,
});

/** Run one review round. Never throws. */
export async function runVisualReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const deps = { ...defaultDeps(), ...input.deps };
  const { page, signal } = input;
  const notes: string[] = [];
  let findings: LayoutFinding[] = [];
  const fail = (e: ReviewErrorPayload, usage?: ReviewUsagePayload): ReviewRunFailure => ({
    ok: false,
    code: e.code,
    message: e.message,
    findings,
    notes,
    ...(usage ? { usage } : {}),
  });

  const frames = reviewBreakpoints(page);
  if (frames.length === 0) return fail({ code: 'no_frames', message: 'This page has no breakpoint frames to review.' });

  // 1. render
  input.onStage?.('rendering');
  try {
    await deps.waitForRender(frames, signal);
  } catch {
    notes.push('The page may not have finished rendering before it was measured.');
  }
  if (signal.aborted) return fail({ code: 'aborted', message: 'The review was cancelled.' });

  // 2. measure
  input.onStage?.('measuring');
  try {
    const audit = deps.audit(frames);
    findings = audit.findings;
    if (audit.missing.length > 0) notes.push(`These frames were not on the canvas and were not measured: ${audit.missing.join(', ')}.`);
  } catch (err) {
    notes.push(`The layout measurement failed (${err instanceof Error ? err.message : 'unknown error'}); review from the images only.`);
  }

  // 3. capture: the largest and the smallest frame
  input.onStage?.('capturing');
  const toCapture = frames.length > 1 ? [frames[0], frames[frames.length - 1]] : [frames[0]];
  const images: ReviewImage[] = [];
  for (const frame of toCapture.slice(0, REVIEW_LIMITS.maxImages)) {
    if (signal.aborted) break;
    let outcome: CaptureOutcome;
    try {
      outcome = await deps.capture(frame);
    } catch (err) {
      outcome = { ok: false, breakpoint: frame.key, reason: err instanceof Error ? err.message : 'unknown error' };
    }
    if (outcome.ok) {
      images.push(outcome.image);
      if (outcome.placeholderImages > 0) {
        notes.push(`${outcome.placeholderImages} image(s) on "${frame.key}" could not be loaded for the capture and show as grey boxes; that is not a page defect.`);
      }
    } else {
      notes.push(`The "${frame.key}" frame could not be captured (${outcome.reason}).`);
    }
  }
  if (signal.aborted) return fail({ code: 'aborted', message: 'The review was cancelled.' });

  // 4. ask
  input.onStage?.('reviewing');
  let tree;
  try {
    tree = serializeForReview(page, frames);
  } catch (err) {
    return fail({ code: 'serialize_failed', message: `The page could not be prepared for review (${err instanceof Error ? err.message : 'unknown error'}).` });
  }
  let result: ReviewResultPayload | undefined;
  let error: ReviewErrorPayload | undefined;
  let usage: ReviewUsagePayload | undefined;
  await deps.transport(
    {
      model: input.model,
      breakpoints: frames.map(({ label, minWidth }) => ({ label, minWidth })),
      tree,
      findings,
      images,
      ...(input.brief?.trim() ? { brief: input.brief.trim().slice(0, REVIEW_LIMITS.maxBriefChars) } : {}),
      ...(notes.length > 0 ? { notes: notes.slice(0, 10).map((n) => n.slice(0, 300)) } : {}),
    },
    {
      onProgress: (p) => input.onStage?.(p.phase, { receivedChars: p.receivedChars }),
      onResult: (r) => {
        result = r;
      },
      onError: (e) => {
        error = e;
      },
      onUsage: (u) => {
        usage = u;
      },
    },
    signal,
  );
  if (signal.aborted) return fail({ code: 'aborted', message: 'The review was cancelled.' }, usage);
  if (error || !result) return fail(error ?? { code: 'no_result', message: 'The review returned no result.' }, usage);

  // 5. apply, as one undo step
  input.onStage?.('applying');
  const applied = deps.apply(page, result.ops);
  if (!applied.ok) return fail({ code: 'apply_failed', message: applied.reason }, usage);
  return {
    ok: true,
    summary: result.summary,
    findings,
    applied: applied.applied,
    rejected: [...result.rejected, ...applied.rejected],
    historyEntryId: applied.historyEntryId,
    notes,
    model: result.model,
    ...(usage ? { usage } : {}),
  };
}

/** The audit alone (free, no network): what "Polish with AI" shows before it asks the model. */
export function auditPage(page: PageModelType, audit?: ReviewRunDeps['audit']): DomAuditResult {
  const frames = reviewBreakpoints(page);
  return (audit ?? defaultDeps().audit)(frames);
}
