// src/components/ai/GeneratePageDialog.tsx
//
// The editor's "Generate" action: a brief, a target (a new page, replace the
// selected component, or insert into it), and a model choice. Streams progress
// from POST /api/ai/generate-page, applies the validated result as ONE undoable
// MST action, and offers a one-click "Undo generation" (the CMS agent's
// pattern). Every failure is shown with an actionable message; nothing is ever
// applied from an invalid result.
//
// The flow is the pure reducer in src/lib/ai/pageGen/flow.ts (keyed to the
// inputs and the captured target), so a cancelled or stale run can never land.
// The transport is injectable for tests.
//
// After a generation is applied, one visual review round runs by default
// (./VisualReview.tsx, plan docs/plans/2026-10-23-ai-design-quality-round-2.md
// decision 4): the editor measures and captures the rendered page and an AI
// fixes clipped text, overflow, collisions and weak contrast as one more undo
// step. A failed review leaves the page as generated and says why.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Sparkles, Loader2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '@/hooks/useStore';
import { useControllableOpen, type ControllableOpenProps } from '@/hooks/useControllableOpen';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { fetchPageGenTransport, type PageGenTransport } from '@/lib/ai/pageGen/client';
import {
  applyResult,
  buildRequest,
  captureTarget,
  describeTargetAvailability,
  undoGeneration,
  type TargetKind,
} from '@/lib/ai/pageGen/editorBridge';
import { ModelSlider } from '@/components/ai/ModelSlider';
import { saveModelChoice } from '@/lib/ai/modelChoice';
import {
  clearDraft,
  describeError,
  describeImageFallbacks,
  flowReducer,
  initialFlow,
  loadDraft,
  makeRequestKey,
  saveDraft,
  type FlowInputs,
} from '@/lib/ai/pageGen/flow';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';
import type { PageGenProgress, StockImageSummary } from '@/lib/ai/pageGen/protocol';
import {
  DEFAULT_REVIEW_SETTINGS,
  ReviewModelToggle,
  ReviewReport,
  loadReviewSettings,
  saveReviewSettings,
  useVisualReview,
  type ReviewRunnerOptions,
  type ReviewSettings,
} from '@/components/ai/VisualReview';

const TARGETS: Array<{ kind: TargetKind; label: string }> = [
  { kind: 'newPage', label: 'New page' },
  { kind: 'replace', label: 'Replace selection' },
  { kind: 'insert', label: 'Add to selection' },
];

function progressText(p: PageGenProgress): string {
  const kb = (p.receivedChars / 1024).toFixed(1);
  if (p.phase === 'validating') return 'Checking the result against the editor...';
  if (p.phase === 'images') return 'Finding photos...';
  if (p.phase === 'repairing') {
    return p.receivedChars > 0 ? `Fixing problems in the first draft (${kb} KB)...` : 'Fixing problems in the first draft...';
  }
  return p.receivedChars > 0 ? `Designing (${kb} KB written)...` : 'Designing...';
}

function findComponent(page: PageModelType, id: string): ComponentInstance | undefined {
  const walk = (n: ComponentInstance): ComponentInstance | undefined => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const hit = walk(c as ComponentInstance);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(page.appComponentTree as ComponentInstance);
}

export interface GeneratePageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transport?: PageGenTransport;
  /** The visual review run (injectable for tests). */
  review?: ReviewRunnerOptions;
}

export const GeneratePageDialog = observer(function GeneratePageDialog({
  open,
  onOpenChange,
  transport = fetchPageGenTransport,
  review: reviewRunner,
}: GeneratePageDialogProps) {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const page = editorUI.currentPage;
  const selected = editorUI.selectedComponent as ComponentInstance | undefined;
  const projectId = project?.id ?? '';

  const [state, dispatch] = React.useReducer(flowReducer, undefined, () => initialFlow());
  const abortRef = React.useRef<AbortController | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const review = useVisualReview(reviewRunner);
  const [reviewSettings, setReviewSettings] = React.useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);
  const reviewSettingsRef = React.useRef(reviewSettings);
  reviewSettingsRef.current = reviewSettings;
  const lastBriefRef = React.useRef('');

  const inputs = state.inputs;
  const availability = describeTargetAvailability(inputs.targetKind, page, selected);
  const targetKey = `${page?.id ?? ''}|${inputs.targetKind === 'newPage' ? '' : (selected?.id ?? '')}`;

  // Re-entry / resume: every open starts from the saved draft, never from a
  // previous run or result.
  React.useEffect(() => {
    if (open && projectId) dispatch({ type: 'reset', inputs: loadDraft(projectId) });
    if (open) setReviewSettings(loadReviewSettings());
  }, [open, projectId]);

  const editReviewSettings = (patch: Partial<ReviewSettings>) => {
    const next = { ...reviewSettingsRef.current, ...patch };
    setReviewSettings(next);
    saveReviewSettings(next);
  };

  // Abort a running generation when the dialog unmounts.
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const edit = (patch: Partial<FlowInputs>) => {
    dispatch({ type: 'edit', inputs: patch, targetKey });
    if (projectId) saveDraft(projectId, { ...inputs, ...patch });
    if (patch.model) saveModelChoice('page-gen', patch.model);
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: 'cancel' });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && stateRef.current.phase === 'running') cancel();
    if (!next && review.state.phase === 'running') review.cancel();
    onOpenChange(next);
  };

  const generate = async () => {
    if (!project || !page || !availability.ok) return;
    const brief = inputs.brief.trim();
    if (!brief) return;
    const target = captureTarget(inputs.targetKind, page, selected);
    const requestKey = makeRequestKey(inputs, targetKey);
    const request = buildRequest({ brief, model: inputs.model, pageTitle: inputs.pageTitle, target, project });
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    dispatch({ type: 'start', requestKey });
    review.reset();
    lastBriefRef.current = brief;

    const isCurrent = () =>
      abortRef.current === controller && stateRef.current.phase === 'running' && stateRef.current.requestKey === requestKey;

    await transport(
      request,
      {
        onProgress: (progress) => {
          if (isCurrent()) dispatch({ type: 'progress', requestKey, progress });
        },
        onResult: (result) => {
          if (!isCurrent()) return; // cancelled or superseded: never apply
          const outcome = applyResult(project, target, result, inputs.targetKind === 'newPage' ? inputs.pageTitle : undefined);
          if (!outcome.ok) {
            dispatch({ type: 'failed', requestKey, error: { code: 'apply_failed', message: `Nothing was changed: ${outcome.reason}` } });
            return;
          }
          const shownPage = project.getPage(outcome.value.pageId);
          if (shownPage && editorUI.currentPage?.id !== shownPage.id) editorUI.setCurrentPage(shownPage);
          const toSelect = shownPage && outcome.value.selectId ? findComponent(shownPage, outcome.value.selectId) : undefined;
          if (toSelect) editorUI.selectComponent(toSelect);
          clearDraft(projectId);
          dispatch({
            type: 'applied',
            requestKey,
            record: outcome.value.record,
            nodeCount: result.stats.nodeCount,
            warnings: result.warnings,
            tells: result.tells,
            images: result.images,
          });
          // One review round of what was just applied (fails soft: the page
          // stays as generated and the dialog says what failed).
          if (shownPage && reviewSettingsRef.current.auto) {
            void review.start(shownPage, reviewSettingsRef.current.model, lastBriefRef.current);
          }
        },
        onError: (error) => {
          if (error.code === 'aborted' || !isCurrent()) return;
          dispatch({ type: 'failed', requestKey, error: describeError(error) });
        },
      },
      controller.signal,
    );
    if (abortRef.current === controller) abortRef.current = null;
  };

  const undo = () => {
    if (!project || state.phase !== 'applied') return;
    // The generation's undo takes the review's fixes with it.
    review.reset();
    const outcome = undoGeneration(project, state.record, (fallbackId) => {
      const fallback = fallbackId ? project.getPage(fallbackId) : undefined;
      if (fallback && editorUI.currentPage?.id === (state.record as { pageId: string }).pageId) {
        editorUI.setCurrentPage(fallback);
      }
    });
    dispatch(outcome.ok ? { type: 'undone' } : { type: 'undoFailed', reason: outcome.reason });
  };

  const running = state.phase === 'running';
  const briefTooLong = inputs.brief.length > GENERATION_LIMITS.maxBriefChars;
  const canGenerate = !running && !!project && availability.ok && inputs.brief.trim().length > 0 && !briefTooLong;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[520px]" data-editor-ui="true">
        <DialogHeader>
          <DialogTitle>Generate with AI</DialogTitle>
          <DialogDescription>
            Describe what you need. The result is made of normal components you can edit, and you can undo it in one step.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {state.phase === 'applied' ? (
            <div className="grid gap-3" role="status" aria-live="polite">
              <p className="text-sm">
                {state.undone
                  ? 'The generation was undone.'
                  : `Added ${state.nodeCount} ${state.nodeCount === 1 ? 'component' : 'components'}${
                      state.record.kind === 'newPage' ? ' on a new page' : ''
                    }. Save the project to keep it.`}
              </p>
              {!state.undone && <StockImageNote images={state.images} />}
              {state.warnings.length > 0 && !state.undone && (
                <details className="text-xs text-muted-foreground">
                  <summary>{state.warnings.length} automatic fixes were made to the AI output</summary>
                  <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4">
                    {state.warnings.slice(0, 50).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              {state.tells && state.tells.length > 0 && !state.undone && (
                <details className="text-xs text-muted-foreground">
                  <summary>
                    {state.tells.length} {state.tells.length === 1 ? 'issue remains' : 'issues remain'} (tells of
                    generated design or missing page essentials), worth a manual pass
                  </summary>
                  <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4">
                    {state.tells.slice(0, 50).map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </details>
              )}
              {state.undoError && (
                <p role="alert" className="text-xs text-destructive">
                  Could not undo: {state.undoError}
                </p>
              )}
              {!state.undone && <ReviewReport state={review.state} onUndo={review.undo} />}
            </div>
          ) : (
            <div className="grid gap-4">
              <fieldset className="grid gap-2" disabled={running}>
                <legend className="mb-1 text-xs font-medium text-muted-foreground">Where</legend>
                <div className="flex flex-wrap gap-2">
                  {TARGETS.map((t) => (
                    <Button
                      key={t.kind}
                      type="button"
                      size="sm"
                      variant={inputs.targetKind === t.kind ? 'default' : 'outline'}
                      aria-pressed={inputs.targetKind === t.kind}
                      onClick={() => edit({ targetKind: t.kind })}
                    >
                      {t.label}
                    </Button>
                  ))}
                </div>
                <p className={`text-xs ${availability.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
                  {availability.ok ? availability.label : availability.reason}
                </p>
              </fieldset>

              {inputs.targetKind === 'newPage' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="pagegen-title">Page title (optional)</Label>
                  <Input
                    id="pagegen-title"
                    value={inputs.pageTitle}
                    maxLength={120}
                    disabled={running}
                    onChange={(e) => edit({ pageTitle: e.target.value })}
                    placeholder="The AI picks one if empty"
                  />
                </div>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="pagegen-brief">Brief</Label>
                <textarea
                  id="pagegen-brief"
                  className="min-h-[110px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  value={inputs.brief}
                  disabled={running}
                  onChange={(e) => edit({ brief: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate) void generate();
                  }}
                  placeholder="A landing page for a neighbourhood bakery: hero with opening hours, three signature breads, a short story, and a footer with the address."
                />
                <p className={`text-right text-[11px] ${briefTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {inputs.brief.length} / {GENERATION_LIMITS.maxBriefChars}
                </p>
              </div>

              <ModelSlider
                id="pagegen-model"
                value={inputs.model}
                disabled={running}
                onChange={(model) => edit({ model })}
              />

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <label className="flex items-center gap-2" htmlFor="pagegen-review">
                  <input
                    id="pagegen-review"
                    type="checkbox"
                    className="size-4 accent-brand"
                    checked={reviewSettings.auto}
                    disabled={running}
                    onChange={(e) => editReviewSettings({ auto: e.target.checked })}
                  />
                  <span>Review the layout with AI afterwards (one more round, a few cents)</span>
                </label>
                {reviewSettings.auto && (
                  <ReviewModelToggle
                    value={reviewSettings.model}
                    disabled={running}
                    onChange={(model) => editReviewSettings({ model })}
                  />
                )}
              </div>

              {running && (
                <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {progressText(state.progress)}
                </p>
              )}

              {state.phase === 'editing' && state.error && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  <p>{state.error.message}</p>
                  {state.error.details && (
                    <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-4">
                      {state.error.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {state.phase === 'applied' && review.state.phase === 'running' ? (
            <Button type="button" variant="outline" onClick={review.cancel}>
              Stop review
            </Button>
          ) : state.phase === 'applied' ? (
            <>
              {!state.undone && review.state.phase === 'idle' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const shown = project?.getPage(state.record.pageId);
                    if (shown) void review.start(shown, reviewSettings.model, lastBriefRef.current);
                  }}
                >
                  Review layout
                </Button>
              )}
              {!state.undone && (
                <Button type="button" variant="outline" onClick={undo}>
                  <Undo2 className="size-4" aria-hidden="true" />
                  {state.record.kind === 'newPage' ? 'Undo (remove page)' : 'Undo generation'}
                </Button>
              )}
              <Button
                type="button"
                onClick={() => {
                  review.reset();
                  dispatch({ type: 'reset', inputs: { ...inputs, brief: '' } });
                }}
              >
                Generate another
              </Button>
            </>
          ) : running ? (
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button type="button" onClick={() => void generate()} disabled={!canGenerate}>
              <Sparkles className="size-4" aria-hidden="true" />
              {state.phase === 'editing' && state.error ? 'Try again' : 'Generate'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

/**
 * After a generation: which photos came from Unsplash (credit with links, as
 * the Unsplash guidelines ask) and, when some images kept the placeholder, how
 * many and why. A note, never an error: the page itself was generated.
 */
function StockImageNote({ images }: { images?: StockImageSummary }) {
  if (!images || images.requested === 0) return null;
  const fallbacks = describeImageFallbacks(images);
  return (
    <div className="grid gap-1 text-xs" data-testid="pagegen-image-note">
      {fallbacks && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-foreground">
          {fallbacks.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="text-muted-foreground">Select an image to set your own picture.</p>
        </div>
      )}
      {images.credits.length > 0 && (
        <details className="text-muted-foreground">
          <summary>
            {images.credits.length} {images.credits.length === 1 ? 'photo' : 'photos'} from Unsplash
          </summary>
          <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4">
            {images.credits.map((c) => (
              <li key={c.photoId}>
                Photo by{' '}
                <a href={c.photographerUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  {c.photographerName}
                </a>{' '}
                on{' '}
                <a href={c.unsplashUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  Unsplash
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The top-bar entry point. */
export const GeneratePageButton = observer(function GeneratePageButton({
  transport,
  open: openProp,
  onOpenChange,
  triggerClassName = '',
}: {
  transport?: PageGenTransport;
  /** Extra classes for the trigger (the compact top bar hides it and opens the dialog from its More menu). */
  triggerClassName?: string;
} & ControllableOpenProps) {
  const { editorUI } = useStore();
  const [open, setOpen] = useControllableOpen({ open: openProp, onOpenChange });
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`mr-2 ${triggerClassName}`}
        onClick={() => setOpen(true)}
        disabled={!editorUI.currentProject}
        title="Generate a page or section with AI"
      >
        <Sparkles size={16} />
        Generate
      </Button>
      <GeneratePageDialog open={open} onOpenChange={setOpen} transport={transport} />
    </>
  );
});

export default GeneratePageButton;
