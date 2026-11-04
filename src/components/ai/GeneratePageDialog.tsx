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
// A generation survives the phone switching apps: the server keeps running it,
// the transport collects it when the tab comes back, and a run in progress is
// remembered per project (savePendingRun) so that, if iOS reloaded the tab, the
// editor reopens this dialog and applies the result to the target captured at
// the start. Cancel and closing the dialog stop the run on the server;
// unmounting the editor only stops following it.
//
// While it runs the page builds itself on the canvas: each section of the
// first attempt is drawn as soon as it is written (a draft that never enters
// the project, src/lib/ai/pageGen/draft.ts), and the dialog gives way to a
// slim floating panel (./PageGenProgressPanel.tsx) so the canvas stays visible
// and usable. Cancel there is the one stop. The result is applied exactly as
// before, one undo step, and the draft is dropped in the same handler.
//
// After a generation is applied, one visual review round runs by default
// (./VisualReview.tsx, plan docs/plans/2026-10-23-ai-design-quality-round-2.md
// decision 4): the editor measures and captures the rendered page and an AI
// fixes clipped text, overflow, collisions and weak contrast as one more undo
// step. A failed review leaves the page as generated and says why.
'use client';

import React from 'react';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { Sparkles, Undo2 } from 'lucide-react';
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
import {
  fetchPageGenTransport,
  resumePageGen,
  type PageGenHandlers,
  type PageGenResume,
  type PageGenTransport,
} from '@/lib/ai/pageGen/client';
import { DETACH } from '@/lib/ai/resumableRun';
import {
  applyResult,
  buildRequest,
  captureTarget,
  describeTargetAvailability,
  undoGeneration,
  type CapturedTarget,
  type TargetKind,
} from '@/lib/ai/pageGen/editorBridge';
import { ModelSlider } from '@/components/ai/ModelSlider';
import { saveModelChoice } from '@/lib/ai/modelChoice';
import {
  clearDraft,
  clearPendingRun,
  describeError,
  describeImageFallbacks,
  flowReducer,
  initialFlow,
  loadDraft,
  loadPendingRun,
  makeRequestKey,
  saveDraft,
  savePendingRun,
  type FlowInputs,
} from '@/lib/ai/pageGen/flow';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';
import type { PageGenProgress, StockImageSummary } from '@/lib/ai/pageGen/protocol';
import { draftTargetFor, type DraftPhase, type PageGenDraftTarget } from '@/lib/ai/pageGen/draft';
import { PageGenProgressPanel } from '@/components/ai/PageGenProgressPanel';
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
import { IdeaBar, usePageIdeas } from '@/components/ai/IdeaBar';
import { BriefNotice, EnhanceButton } from '@/components/ai/EnhanceButton';
import { useBriefAssist } from '@/components/ai/useBriefAssist';
import { fetchBriefApi, type BriefApi } from '@/lib/ai/brief/client';
import { buildBriefSiteInput } from '@/lib/ai/brief/siteInput';

const TARGETS: Array<{ kind: TargetKind; label: string }> = [
  { kind: 'newPage', label: 'New page' },
  { kind: 'replace', label: 'Replace selection' },
  { kind: 'insert', label: 'Add to selection' },
];

/** What the canvas says about the section still being written, from the run's progress. */
function draftPhaseOf(p: PageGenProgress): DraftPhase {
  if (p.attempt >= 2 || p.phase === 'repairing') return 'polishing';
  return p.phase === 'generating' ? 'writing' : 'checking';
}

function progressText(p: PageGenProgress): string {
  const kb = (p.receivedChars / 1024).toFixed(1);
  if (p.phase === 'validating') return 'Checking the result against the editor...';
  if (p.phase === 'images') return 'Finding photos...';
  if (p.phase === 'repairing') {
    return p.receivedChars > 0 ? `Polishing the first draft (${kb} KB)...` : 'Polishing the first draft...';
  }
  return p.receivedChars > 0 ? `Designing (${kb} KB written)...` : 'Designing...';
}

/**
 * Where a project's draft and run in progress are stored. The unsaved demo
 * project of the standalone editor (`/`) is seeded again, with a new id, on
 * every load, so it has one fixed key; a saved project keeps its server id.
 */
export function storageKeyFor(projectId: string | undefined, isUnsavedDemo: boolean): string {
  if (!projectId) return '';
  return isUnsavedDemo ? 'unsaved-demo' : projectId;
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
  /** Collects a run started before a reload (injectable for tests). */
  resume?: PageGenResume;
  /** The visual review run (injectable for tests). */
  review?: ReviewRunnerOptions;
  /** The idea row and Enhance calls (injectable for tests). */
  briefApi?: BriefApi;
}

export const GeneratePageDialog = observer(function GeneratePageDialog({
  open,
  onOpenChange,
  transport = fetchPageGenTransport,
  resume = resumePageGen,
  review: reviewRunner,
  briefApi = fetchBriefApi,
}: GeneratePageDialogProps) {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const page = editorUI.currentPage;
  const selected = editorUI.selectedComponent as ComponentInstance | undefined;
  // The key the draft and a run in progress are stored under (storageKeyFor).
  const projectId = storageKeyFor(project?.id, editorUI.isUnsavedDemo);

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

  const editReviewSettings = (patch: Partial<ReviewSettings>) => {
    const next = { ...reviewSettingsRef.current, ...patch };
    setReviewSettings(next);
    saveReviewSettings(next);
  };

  // The canvas draft of the run in progress (src/lib/ai/pageGen/draft.ts).
  const draft = editorUI.pageGenDraft;
  const dropDraft = () => {
    const current = stateRef.current;
    if (current.phase === 'running') draft.clear(current.requestKey);
  };

  // Unmounting (leaving the editor) only stops following a run: it keeps going
  // on the server and is resumed from savePendingRun next time, draft and all.
  React.useEffect(
    () => () => {
      abortRef.current?.abort(DETACH);
      dropDraft();
    },
    // Unmount only; dropDraft reads the latest state through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The brief as it was before an Enhance started streaming, or null when none
  // streams: the draft never holds the partial rewrite.
  const settledBriefRef = React.useRef<string | null>(null);

  const edit = (patch: Partial<FlowInputs>) => {
    dispatch({ type: 'edit', inputs: patch, targetKey });
    if (projectId) saveDraft(projectId, { ...inputs, brief: settledBriefRef.current ?? inputs.brief, ...patch });
    if (patch.model) saveModelChoice('page-gen', patch.model);
  };

  // The idea row and Enhance (./IdeaBar.tsx, ./useBriefAssist.ts). A streaming
  // rewrite is not persisted until it finished (the draft keeps the original).
  const setBrief = (brief: string, opts: { persist: boolean }) => {
    if (opts.persist) settledBriefRef.current = null;
    else if (settledBriefRef.current === null) settledBriefRef.current = stateRef.current.inputs.brief;
    dispatch({ type: 'edit', inputs: { brief }, targetKey });
    if (opts.persist && projectId) saveDraft(projectId, { ...stateRef.current.inputs, brief });
  };
  const briefSelection = inputs.targetKind !== 'newPage' && availability.ok ? selected : undefined;
  const briefSiteInput = () =>
    project ? buildBriefSiteInput(project, inputs.targetKind, briefSelection) : { targetKind: inputs.targetKind };
  const assist = useBriefAssist({
    brief: inputs.brief,
    setBrief,
    api: briefApi,
    siteInput: briefSiteInput,
    active: open && state.phase !== 'running',
  });
  const ideas = usePageIdeas({
    open: open && state.phase === 'editing',
    // The raw project id: every unsaved demo shares the storage key 'unsaved-demo' but not its ideas.
    cacheKey: project ? `${project.id}|${inputs.targetKind}|${briefSelection?.id ?? ''}` : '',
    targetKind: inputs.targetKind,
    request: briefSiteInput,
    api: briefApi,
  });

  const cancel = () => {
    // A plain abort: the transport also stops the run on the server.
    abortRef.current?.abort();
    abortRef.current = null;
    if (projectId) clearPendingRun(projectId);
    dropDraft();
    dispatch({ type: 'cancel' });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && stateRef.current.phase === 'running') cancel();
    if (!next && review.state.phase === 'running') review.cancel();
    onOpenChange(next);
  };

  /**
   * The handlers that follow one run to its outcome and apply it to the target
   * captured when it started. Shared by a fresh generation and a resumed one.
   */
  const follow = (
    run: { requestKey: string; target: CapturedTarget; runInputs: FlowInputs; brief: string },
    controller: AbortController,
  ): PageGenHandlers => {
    const { requestKey, target, runInputs, brief } = run;
    const isCurrent = () =>
      abortRef.current === controller && stateRef.current.phase === 'running' && stateRef.current.requestKey === requestKey;
    return {
      // Fires before the request is sent (the transport chooses the id), so
      // before the 'running' state rendered: the controller alone identifies the run.
      onStarted: (generationId) => {
        if (abortRef.current !== controller || !projectId) return;
        savePendingRun(projectId, { generationId, requestKey, inputs: runInputs, target, startedAt: Date.now() });
      },
      onProgress: (progress) => {
        if (!isCurrent()) return;
        draft.setPhase(requestKey, draftPhaseOf(progress));
        dispatch({ type: 'progress', requestKey, progress });
      },
      // A preview section: drawn on the canvas, never part of the project. A
      // collected run repeats the ones already drawn; the draft keeps one per index.
      onSection: (section) => {
        if (!isCurrent()) return;
        if (draft.add(requestKey, section)) dispatch({ type: 'section', requestKey, count: draft.sections.length });
      },
      onResult: (result) => {
        if (!isCurrent() || !project) return; // cancelled or superseded: never apply
        if (projectId) clearPendingRun(projectId);
        // The result replaces the draft in one go: the tracked apply (today's one
        // undo step) and the draft dropped in the same action, so no frame shows
        // both or neither.
        const outcome = runInAction(() => {
          const applied = applyResult(project, target, result, runInputs.targetKind === 'newPage' ? runInputs.pageTitle : undefined);
          draft.clear(requestKey);
          return applied;
        });
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
          void review.start(shownPage, reviewSettingsRef.current.model, brief);
        }
      },
      onError: (error) => {
        if (error.code === 'aborted' || !isCurrent()) return;
        if (projectId) clearPendingRun(projectId);
        draft.clear(requestKey);
        dispatch({ type: 'failed', requestKey, error: describeError(error) });
      },
    };
  };

  const begin = (requestKey: string, draftTarget: PageGenDraftTarget): AbortController => {
    const controller = new AbortController();
    abortRef.current?.abort(DETACH);
    abortRef.current = controller;
    // A new run starts a new draft; whatever an earlier one left is gone.
    draft.begin(draftTarget);
    dispatch({ type: 'start', requestKey });
    review.reset();
    return controller;
  };

  const generate = async () => {
    if (!project || !page || !availability.ok) return;
    const brief = inputs.brief.trim();
    if (!brief) return;
    const target = captureTarget(inputs.targetKind, page, selected);
    const requestKey = makeRequestKey(inputs, targetKey);
    const request = buildRequest({ brief, model: inputs.model, pageTitle: inputs.pageTitle, target, project });
    const controller = begin(
      requestKey,
      draftTargetFor({
        requestKey,
        target,
        title: inputs.pageTitle,
        rootId: page.appComponentTree.id,
        siteLanguage: project.siteSettings?.language,
      }),
    );
    lastBriefRef.current = brief;
    await transport(request, follow({ requestKey, target, runInputs: inputs, brief }, controller), controller.signal);
    if (abortRef.current === controller) abortRef.current = null;
  };

  // Re-entry / resume: an open starts from the saved draft, never from a
  // previous result; or, when a run was still going as the tab went away (iOS
  // reloaded it), follows that run to its outcome.
  React.useEffect(() => {
    if (open) setReviewSettings(loadReviewSettings());
    if (!open || !projectId) return;
    const pending = loadPendingRun(projectId);
    if (!pending) {
      dispatch({ type: 'reset', inputs: loadDraft(projectId) });
      return;
    }
    dispatch({ type: 'reset', inputs: pending.inputs });
    // The draft is rebuilt from the run: the collection hands back every section sent so far.
    const controller = begin(
      pending.requestKey,
      draftTargetFor({
        requestKey: pending.requestKey,
        target: pending.target,
        title: pending.inputs.pageTitle,
        rootId: project?.getPage(pending.target.pageId)?.appComponentTree.id,
        siteLanguage: project?.siteSettings?.language,
      }),
    );
    const brief = pending.inputs.brief.trim();
    lastBriefRef.current = brief;
    void resume(
      pending.generationId,
      follow({ requestKey: pending.requestKey, target: pending.target, runInputs: pending.inputs, brief }, controller),
      controller.signal,
    ).then(() => {
      if (abortRef.current === controller) abortRef.current = null;
    });
    // Runs on open only: `begin` and `follow` read the latest state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

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
  const canGenerate =
    !running && !assist.enhancing && !!project && availability.ok && inputs.brief.trim().length > 0 && !briefTooLong;
  // While a run builds the page on the canvas, the dialog gives way to the
  // floating progress panel: a modal would cover the canvas and lock it.
  const draftTarget = draft.target;
  const draftElsewhere =
    running && draftTarget && editorUI.currentPage?.id !== draftTarget.pageId
      ? `drawn on ${project?.pageName(draftTarget.pageId) ?? 'another page'}`
      : undefined;

  return (
    <>
    {running && (
      <PageGenProgressPanel text={progressText(state.progress)} sections={state.sections} elsewhere={draftElsewhere} onCancel={cancel} />
    )}
    <Dialog open={open && !running} onOpenChange={handleOpenChange}>
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

              <IdeaBar ideas={ideas} disabled={running || assist.enhancing} onPick={assist.pickIdea} />

              <div className="grid gap-1.5">
                <Label htmlFor="pagegen-brief">Brief</Label>
                <textarea
                  id="pagegen-brief"
                  className="min-h-[110px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 read-only:bg-muted/40"
                  value={inputs.brief}
                  disabled={running}
                  readOnly={assist.enhancing}
                  aria-busy={assist.enhancing}
                  onChange={(e) => edit({ brief: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate) void generate();
                  }}
                  placeholder="A landing page for a neighbourhood bakery: hero with opening hours, three signature breads, a short story, and a footer with the address."
                />
                <div className="flex items-center justify-between gap-2">
                  <EnhanceButton
                    assist={assist}
                    disabled={running || !inputs.brief.trim() || briefTooLong || !project}
                  />
                  <p className={`text-right text-[11px] ${briefTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {inputs.brief.length} / {GENERATION_LIMITS.maxBriefChars}
                  </p>
                </div>
                <BriefNotice assist={assist} />
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
          ) : (
            <Button type="button" onClick={() => void generate()} disabled={!canGenerate}>
              <Sparkles className="size-4" aria-hidden="true" />
              {state.phase === 'editing' && state.error ? 'Try again' : 'Generate'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
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
  resume,
  open: openProp,
  onOpenChange,
  triggerClassName = '',
}: {
  transport?: PageGenTransport;
  resume?: PageGenResume;
  /** Extra classes for the trigger (the compact top bar hides it and opens the dialog from its More menu). */
  triggerClassName?: string;
} & ControllableOpenProps) {
  const { editorUI } = useStore();
  const [open, setOpen] = useControllableOpen({ open: openProp, onOpenChange });
  const projectId = storageKeyFor(editorUI.currentProject?.id, editorUI.isUnsavedDemo);
  // A generation was still running when the tab went away (iOS reloads a tab it
  // discarded in the background): reopen the dialog, which collects and applies it.
  React.useEffect(() => {
    if (projectId && loadPendingRun(projectId)) setOpen(true);
    // Once per project: setOpen's identity does not matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
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
      <GeneratePageDialog open={open} onOpenChange={setOpen} transport={transport} resume={resume} />
    </>
  );
});

export default GeneratePageButton;
