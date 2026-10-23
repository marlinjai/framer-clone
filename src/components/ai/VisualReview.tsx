// src/components/ai/VisualReview.tsx
//
// The editor side of the visual review pass (plan
// docs/plans/2026-10-23-ai-design-quality-round-2.md, decision 4):
//   - useVisualReview: runs one review round (src/lib/ai/review/runReview.ts)
//     with cancel, stale-run protection and an "Undo fixes" that only undoes
//     while the review is still the last history entry,
//   - ReviewReport: progress, the list of fixes, what was refused, notes,
//     model and estimated cost, or what failed (the page then stays as it was),
//   - PolishPageButton / PolishPageDialog: "Polish with AI" for the open page.
//     Opening it measures the page right away (free, no network) and lists the
//     findings; "Fix with AI" then runs the same review the generator runs.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Loader2, ScanSearch, Undo2, Wand } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '@/hooks/useStore';
import type { PageModelType } from '@/models/PageModel';
import { MODEL_CHOICE_INFO } from '@/lib/ai/modelChoice';
import {
  DEFAULT_REVIEW_MODEL,
  REVIEW_MODELS,
  estimateCostUsd,
  formatCost,
  type ReviewModel,
  type ReviewOp,
} from '@/lib/ai/review/protocol';
import {
  auditPage,
  runVisualReview,
  type ReviewRunDeps,
  type ReviewRunResult,
  type ReviewStage,
} from '@/lib/ai/review/runReview';
import { undoReview } from '@/lib/ai/review/editorReview';
import type { LayoutFinding } from '@/lib/ai/review/layoutAudit';

// ---------- settings (per browser profile; storage may throw) ----------

export interface ReviewSettings {
  /** Run one review round automatically after a generation. */
  auto: boolean;
  model: ReviewModel;
}

const SETTINGS_KEY = 'framer-clone:visual-review';
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { auto: true, model: DEFAULT_REVIEW_MODEL };

export function loadReviewSettings(): ReviewSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_REVIEW_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ReviewSettings>;
    return {
      auto: typeof parsed.auto === 'boolean' ? parsed.auto : DEFAULT_REVIEW_SETTINGS.auto,
      model: (REVIEW_MODELS as readonly string[]).includes(parsed.model as string)
        ? (parsed.model as ReviewModel)
        : DEFAULT_REVIEW_SETTINGS.model,
    };
  } catch {
    return DEFAULT_REVIEW_SETTINGS;
  }
}

export function saveReviewSettings(settings: ReviewSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // a convenience only
  }
}

// ---------- the run ----------

export type ReviewState =
  | { phase: 'idle' }
  | { phase: 'running'; stage: ReviewStage; receivedChars: number; model: ReviewModel }
  | { phase: 'done'; result: ReviewRunResult; model: ReviewModel; undone: boolean; undoError?: string };

/** Injected in tests: the run itself (defaults to runVisualReview) or only its dependencies. */
export interface ReviewRunnerOptions {
  run?: typeof runVisualReview;
  deps?: Partial<ReviewRunDeps>;
}

export function useVisualReview(opts: ReviewRunnerOptions = {}) {
  const [state, setState] = React.useState<ReviewState>({ phase: 'idle' });
  const controllerRef = React.useRef<AbortController | null>(null);
  const run = opts.run ?? runVisualReview;
  const deps = opts.deps;

  React.useEffect(() => () => controllerRef.current?.abort(), []);

  const start = React.useCallback(
    async (page: PageModelType, model: ReviewModel, brief?: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState({ phase: 'running', stage: 'rendering', receivedChars: 0, model });
      const result = await run({
        page,
        model,
        brief,
        signal: controller.signal,
        deps,
        onStage: (stage, detail) => {
          if (controllerRef.current !== controller) return;
          setState({ phase: 'running', stage, receivedChars: detail?.receivedChars ?? 0, model });
        },
      });
      if (controllerRef.current !== controller) return; // superseded or cancelled
      controllerRef.current = null;
      setState({ phase: 'done', result, model, undone: false });
    },
    [run, deps],
  );

  const cancel = React.useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ phase: 'idle' });
  }, []);

  const undo = React.useCallback(() => {
    setState((s) => {
      if (s.phase !== 'done' || !s.result.ok || !s.result.historyEntryId || s.undone) return s;
      const outcome = undoReview(s.result.historyEntryId);
      return outcome.ok ? { ...s, undone: true, undoError: undefined } : { ...s, undoError: outcome.reason };
    });
  }, []);

  const reset = React.useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ phase: 'idle' });
  }, []);

  return { state, start, cancel, undo, reset };
}

// ---------- presentation ----------

const STAGE_TEXT: Record<ReviewStage, string> = {
  rendering: 'Waiting for the page to render...',
  measuring: 'Measuring the layout on every breakpoint...',
  capturing: 'Capturing Desktop and Phone...',
  reviewing: 'The AI is looking at the page...',
  validating: 'Checking the fixes...',
  applying: 'Applying the fixes...',
};

export function stageText(stage: ReviewStage, receivedChars = 0): string {
  if (stage === 'reviewing' && receivedChars > 0) return `The AI is writing fixes (${(receivedChars / 1024).toFixed(1)} KB)...`;
  return STAGE_TEXT[stage];
}

function costLine(result: ReviewRunResult, model: ReviewModel): string | null {
  if (!result.usage) return null;
  const tokens = result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens;
  return `${MODEL_CHOICE_INFO[model].modelName}, ${tokens.toLocaleString('en-US')} tokens in, ${result.usage.outputTokens.toLocaleString(
    'en-US',
  )} out, about ${formatCost(estimateCostUsd(model, result.usage))}`;
}

/** The review's progress or outcome. */
export function ReviewReport({ state, onUndo }: { state: ReviewState; onUndo?: () => void }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'running') {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="review-progress">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {stageText(state.stage, state.receivedChars)}
      </p>
    );
  }
  const { result } = state;
  const cost = costLine(result, state.model);
  if (!result.ok) {
    return (
      <div role="alert" className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive" data-testid="review-error">
        <p>
          The layout review failed, the page stays as it was: {result.message}
        </p>
        {result.findings.length > 0 && (
          <p className="text-muted-foreground">
            The editor measured {result.findings.length} layout {result.findings.length === 1 ? 'problem' : 'problems'}; open Polish with AI to see them.
          </p>
        )}
        {cost && <p className="text-muted-foreground">{cost}</p>}
      </div>
    );
  }
  return (
    <div className="grid gap-2 text-xs" role="status" aria-live="polite" data-testid="review-result">
      <p className="text-sm text-foreground">
        {state.undone
          ? 'The review fixes were undone.'
          : result.applied.length === 0
            ? 'The layout review found nothing to change.'
            : `The layout review applied ${result.applied.length} ${result.applied.length === 1 ? 'fix' : 'fixes'} (one undo step).`}
      </p>
      {result.summary && !state.undone && <p className="text-muted-foreground">{result.summary}</p>}
      {result.applied.length > 0 && !state.undone && (
        <details open className="text-muted-foreground">
          <summary>Fixes</summary>
          <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-4" data-testid="review-fixes">
            {result.applied.map((op, i) => (
              <li key={i}>{op.reason || describeOp(op)}</li>
            ))}
          </ul>
        </details>
      )}
      {result.rejected.length > 0 && (
        <details className="text-muted-foreground">
          <summary>{result.rejected.length} suggested {result.rejected.length === 1 ? 'fix was' : 'fixes were'} refused</summary>
          <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-4">
            {result.rejected.slice(0, 40).map((r, i) => (
              <li key={i}>{r.reason}</li>
            ))}
          </ul>
        </details>
      )}
      {result.notes.length > 0 && (
        <ul className="list-disc pl-4 text-amber-700 dark:text-amber-400">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {cost && <p className="text-muted-foreground" data-testid="review-cost">{cost}</p>}
      {state.undoError && (
        <p role="alert" className="text-destructive">
          Could not undo the fixes: {state.undoError}
        </p>
      )}
      {onUndo && !state.undone && result.historyEntryId && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onUndo}>
            <Undo2 className="size-4" aria-hidden="true" />
            Undo fixes
          </Button>
        </div>
      )}
    </div>
  );
}

function describeOp(op: ReviewOp): string {
  if (op.op === 'update_style') return `${op.property} on ${op.breakpoint ?? 'every breakpoint'}`;
  if (op.op === 'update_text') return 'Shortened a text';
  return 'Removed a decorative element';
}

/** The review model choice: Balanced (Sonnet) or Best (Opus). */
export function ReviewModelToggle({
  value,
  onChange,
  disabled,
}: {
  value: ReviewModel;
  onChange: (m: ReviewModel) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Review model">
      {REVIEW_MODELS.map((m) => (
        <Button
          key={m}
          type="button"
          size="sm"
          variant={value === m ? 'default' : 'outline'}
          aria-pressed={value === m}
          disabled={disabled}
          onClick={() => onChange(m)}
          title={MODEL_CHOICE_INFO[m].hint}
        >
          {MODEL_CHOICE_INFO[m].step}
        </Button>
      ))}
    </div>
  );
}

/** The findings list "Polish with AI" shows before asking the model. */
export function FindingsList({ findings }: { findings: LayoutFinding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="review-findings-empty">The editor measured no layout problems on this page.</p>;
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  return (
    <div className="grid gap-1 text-xs" data-testid="review-findings">
      <p className="text-sm">
        The editor measured {findings.length} layout {findings.length === 1 ? 'problem' : 'problems'}
        {errors > 0 ? ` (${errors} serious)` : ''}.
      </p>
      <ul className="max-h-48 list-disc overflow-y-auto pl-4 text-muted-foreground">
        {findings.slice(0, 30).map((f, i) => (
          <li key={i} data-kind={f.kind} data-node-id={f.nodeId}>
            <span className="font-medium text-foreground">{f.breakpoint}:</span> {f.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Polish with AI ----------

export interface PolishPageDialogProps extends ReviewRunnerOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const PolishPageDialog = observer(function PolishPageDialog({ open, onOpenChange, run, deps }: PolishPageDialogProps) {
  const { editorUI } = useStore();
  const page = editorUI.currentPage as PageModelType | undefined;
  const runner = React.useMemo(() => ({ run, deps }), [run, deps]);
  const review = useVisualReview(runner);
  const [settings, setSettings] = React.useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);
  const [audit, setAudit] = React.useState<{ findings: LayoutFinding[]; missing: string[] } | { error: string } | null>(null);

  const measure = React.useCallback(() => {
    if (!page) return;
    try {
      setAudit(auditPage(page, deps?.audit));
    } catch (err) {
      setAudit({ error: err instanceof Error ? err.message : 'unknown error' });
    }
  }, [page, deps]);

  // Every open starts fresh: settings from storage, a new measurement.
  React.useEffect(() => {
    if (!open) return;
    setSettings(loadReviewSettings());
    review.reset();
    setAudit(null);
    const raf = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page?.id]);

  const running = review.state.phase === 'running';
  const handleOpenChange = (next: boolean) => {
    if (!next && running) review.cancel();
    onOpenChange(next);
  };
  const setModel = (model: ReviewModel) => {
    const next = { ...settings, model };
    setSettings(next);
    saveReviewSettings(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[560px]" data-editor-ui="true">
        <DialogHeader>
          <DialogTitle>Polish with AI</DialogTitle>
          <DialogDescription>
            The editor measures the rendered page on every breakpoint, then an AI looks at Desktop and Phone and fixes clipped text, overflow,
            collisions and weak contrast. Your content and design stay; the fixes are one undo step.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-3">
            {!page ? (
              <p className="text-sm text-destructive">Open a page first.</p>
            ) : audit === null ? (
              <p className="text-sm text-muted-foreground">Measuring...</p>
            ) : 'error' in audit ? (
              <p role="alert" className="text-xs text-destructive">
                The layout could not be measured ({audit.error}). The AI can still review the page from its images.
              </p>
            ) : review.state.phase === 'idle' ? (
              <>
                <FindingsList findings={audit.findings} />
                {audit.missing.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">Not on the canvas, not measured: {audit.missing.join(', ')}.</p>
                )}
              </>
            ) : null}
            {page && review.state.phase === 'idle' && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Review model</span>
                <ReviewModelToggle value={settings.model} onChange={setModel} />
              </div>
            )}
            <ReviewReport state={review.state} onUndo={review.undo} />
          </div>
        </DialogBody>
        <DialogFooter>
          {running ? (
            <Button type="button" variant="outline" onClick={review.cancel}>
              Cancel
            </Button>
          ) : review.state.phase === 'done' ? (
            <>
              <Button type="button" variant="outline" onClick={() => { review.reset(); measure(); }}>
                <ScanSearch className="size-4" aria-hidden="true" />
                Measure again
              </Button>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </>
          ) : (
            <Button type="button" disabled={!page} onClick={() => page && void review.start(page, settings.model)}>
              <Wand className="size-4" aria-hidden="true" />
              Fix with AI
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

/** The top-bar entry point. */
export const PolishPageButton = observer(function PolishPageButton(props: ReviewRunnerOptions) {
  const { editorUI } = useStore();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mr-2"
        onClick={() => setOpen(true)}
        disabled={!editorUI.currentPage}
        title="Measure the page layout and let AI fix clipped text, overflow and contrast"
      >
        <Wand size={16} />
        Polish
      </Button>
      <PolishPageDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
});
