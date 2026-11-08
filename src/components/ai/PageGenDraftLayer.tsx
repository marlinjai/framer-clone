// src/components/ai/PageGenDraftLayer.tsx
//
// The canvas side of the page that builds itself (src/lib/ai/pageGen/draft.ts):
// the preview sections of a running generation, drawn where the result will
// land, and never part of the project.
//
//   - Replace: the target's place shows the draft sections instead (the page
//     root keeps itself and shows them as its children, as the apply does).
//   - Insert: the sections show after the target's existing children.
//   - New page: a set of draft frames beside the page's own frames, titled
//     after the requested page, which is not a real page yet.
//
// The draft is visual only: drawn by HeadlessComponentRenderer (no selection,
// no drag, no text editing), with pointer events off and hidden from assistive
// technology (the progress panel speaks for it), and absent from the Layers
// panel, which reads the project. It is drawn only while the page the run
// started on is on screen.
//
// Motion (Emil Kowalski's rules): each section enters node by node, the
// per-component reveal of the live agent canvas (src/lib/live/reveal.ts): a
// 180ms ease-out fade with a 4px rise per node, in document order, the whole
// section within 600ms; nothing moves with reduced motion. The apply keeps the
// sections drawn here as they are and reveals only the ones never drawn. The band for the
// section still being written has a static tint, no shimmer. The camera follows
// a new section only while the user has not moved it since the run started.
//
// Skeletons: once the run's outline arrives (gen:outline), every section still
// coming has a skeleton in its place (the live agent canvas's static shapes,
// SkeletonBlock in src/components/live/SkeletonLayer.tsx, marked as the
// draft's own so the presence frame never takes one for an agent's), and the
// section of slot i takes the place of skeleton i. While skeletons show, the
// band is not drawn: they already say what is coming. Before the first section,
// the camera brings the first skeleton into view.
'use client';

import React from 'react';
import { computed } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { GENERATED_PAGE_ROOT_STYLE } from '@/lib/ai/pageGen/apply';
import type { PageGenDraftStore, PageGenDraftTarget } from '@/lib/ai/pageGen/draft';
import { viewportFrameContentStyle } from '@/lib/canvas/viewportFrame';
import { surfaceFrameAttributes } from '@/lib/site/surfaceTheme';
import { PageBaseStyles } from '@/lib/site/PageBaseStyles';
import { revealOffset, useCameraControls, type CameraTransform } from '@/lib/canvas/cameraControls';
import GroundWrapper from '@/components/GroundWrapper';
import { revealAnimation, revealPlanOfTrees, type RevealTreeNode } from '@/lib/live/reveal';
import { SkeletonBlock, isNarrowBreakpoint } from '@/components/live/SkeletonLayer';

/** Marks a drawn draft section (its index); the wrapper has no box of its own. */
export const DRAFT_SECTION_ATTR = 'data-pagegen-draft-section';
/** Marks a draft frame of a new page. */
export const DRAFT_FRAME_ATTR = 'data-pagegen-draft-frame';
/** Marks the band of the section still being written. */
export const DRAFT_BAND_ATTR = 'data-pagegen-draft-band';
/** Marks a skeleton of the run's outline (its slot). */
export const DRAFT_SKELETON_ATTR = 'data-pagegen-draft-skeleton';

/** Space between the page's own frames and the draft frames of a new page. */
const DRAFT_FRAME_GAP = 160;

// The draft is never clickable. Each section's reveal is its own stylesheet
// beside it (draftRevealCss, written by DraftStyles).
const DRAFT_CSS = `
[${DRAFT_SECTION_ATTR}], [${DRAFT_SECTION_ATTR}] *, [${DRAFT_FRAME_ATTR}], [${DRAFT_FRAME_ATTR}] *, [${DRAFT_SKELETON_ATTR}], [${DRAFT_SKELETON_ATTR}] * { pointer-events: none !important; }
`;

/** An id that is safe inside an attribute selector of a style element as it is (generated ids are). */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The reveal of one draft section, as a stylesheet: each node of its tree (by
 * `data-inner-component-id`, inside the section's wrapper) fades in after its
 * delay (src/lib/live/reveal.ts). `backwards` holds the start values only until
 * the animation runs, and `translate` leaves a node's own transform alone.
 * Nothing moves under reduced motion. An id that is not plain is left out (its
 * node appears at once) rather than escaped into a selector.
 */
export function draftRevealCss(index: number, tree: RevealTreeNode): string {
  const scope = `[${DRAFT_SECTION_ATTR}="${Math.trunc(index)}"]`;
  const rules: string[] = [];
  for (const [id, delay] of revealPlanOfTrees([tree])) {
    if (!PLAIN_ID.test(id)) continue;
    // A repeated copy (a second cart line) carries no inner id, only the style
    // hook `<breakpoint>-<id>`, so it matches on that and reveals with the first.
    rules.push(`${scope} [data-inner-component-id="${id}"], ${scope} [data-component-id$="-${id}"] { animation: ${revealAnimation(delay)}; }`);
  }
  if (rules.length === 0) return '';
  return `${rules.join('\n')}\n@media (prefers-reduced-motion: reduce) { ${scope} [data-inner-component-id], ${scope} [data-component-id] { animation: none !important; } }`;
}

/** A draft section's reveal stylesheet, written once per section tree. */
function DraftSectionReveal({ index, tree }: { index: number; tree: RevealTreeNode }) {
  const css = React.useMemo(() => draftRevealCss(index, tree), [index, tree]);
  return css ? <style data-pagegen-draft-reveal={String(index)}>{css}</style> : null;
}

/** How the draft meets a canvas node: nothing, in its place, as its children, or after its children. */
export type DraftHook = 'replace' | 'replaceChildren' | 'insert' | null;

/** What the draft does at the node `componentId` of the page `pageId`. Pure. */
export function draftHookFor(target: PageGenDraftTarget | undefined, pageId: string | undefined, componentId: string): DraftHook {
  if (!target || !pageId || target.pageId !== pageId || target.componentId !== componentId) return null;
  if (target.kind === 'insert') return 'insert';
  if (target.kind === 'replace') return target.targetIsRoot ? 'replaceChildren' : 'replace';
  return null;
}

/**
 * The draft hook of one canvas node, as a computed per node: the draft's target
 * changes only when a run starts or ends, and only the node it names redraws.
 * `skip` for nodes the draft never meets (inside a placement's definition).
 */
export function useDraftHook(componentId: string, skip: boolean): DraftHook {
  const { editorUI } = useStore();
  const draft = editorUI.pageGenDraft as PageGenDraftStore | undefined;
  const hook = React.useMemo(
    () => computed(() => (skip || !draft ? null : draftHookFor(draft.target, editorUI.currentPage?.id, componentId))),
    [draft, editorUI, componentId, skip],
  );
  return hook.get();
}

/** The band where the next section will appear. Static, no shimmer. */
function DraftBand({ text }: { text: string }) {
  return (
    <div
      {...{ [DRAFT_BAND_ATTR]: '' }}
      aria-hidden="true"
      style={{
        minHeight: 120,
        margin: 16,
        borderRadius: 12,
        border: '1px dashed rgba(120, 120, 120, 0.35)',
        background: 'rgba(120, 120, 120, 0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '500 13px/1.4 system-ui, sans-serif',
        color: 'rgba(90, 90, 90, 0.9)',
        pointerEvents: 'none',
      }}
    >
      {text}
    </div>
  );
}

/**
 * The band's words, or null when no band shows: skeletons stand for what is
 * coming, or the result is on its way and sections are drawn.
 */
export function draftBandText(phase: PageGenDraftStore['phase'], drawn: number, skeletons = 0): string | null {
  if (skeletons > 0) return null;
  if (phase === 'writing') return `Writing section ${drawn + 1}...`;
  if (drawn > 0) return null;
  return phase === 'polishing' ? 'Polishing the page...' : 'Checking the page...';
}

/**
 * The draft's pointer rule and each drawn section's reveal. Mounted once beside
 * the canvas frames, never inside the page tree (a style element there would
 * count as a child for the page's own selectors). A section's reveal is written
 * once, when it arrives, and stays until the draft is dropped. A section drawn
 * anew (the person comes back to the run's page, which the draft is drawn on
 * only while it is on screen) plays its reveal again, on purpose: those nodes
 * were not on screen before.
 */
export const DraftStyles = observer(function DraftStyles() {
  const { editorUI } = useStore();
  const draft = editorUI.pageGenDraft as PageGenDraftStore | undefined;
  return (
    <>
      <style data-pagegen-draft-styles="">{DRAFT_CSS}</style>
      {draft?.sections.map((s) => <DraftSectionReveal key={s.index} index={s.index} tree={s.tree} />)}
    </>
  );
});

export interface DraftSectionsProps {
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  scope?: BindingScope;
}

/** The draft's sections and the skeletons of those still coming, in page order, then the band of the one being written. */
export const DraftSections = observer(function DraftSections({ breakpointId, allBreakpoints, scope }: DraftSectionsProps) {
  const { editorUI } = useStore();
  const draft = editorUI.pageGenDraft as PageGenDraftStore | undefined;
  const indexes = draft?.target ? draft.sections.map((s) => s.index) : [];
  const drawn = indexes.join(',');
  // What the canvas really drew (a section stored while another page was on
  // screen is not drawn): the apply reveals the rest.
  React.useEffect(() => {
    for (const index of indexes) draft?.markShown(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, drawn]);
  if (!draft?.target) return null;
  const skeletons = draft.skeletons.length;
  const band = draftBandText(draft.phase, draft.sections.length, skeletons);
  const narrow = skeletons > 0 && isNarrowBreakpoint(breakpointId, allBreakpoints);
  return (
    <>
      {draft.items.map((item) =>
        item.kind === 'section' ? (
          <div key={`section-${item.section.index}`} {...{ [DRAFT_SECTION_ATTR]: String(item.section.index) }} aria-hidden="true" style={{ display: 'contents' }}>
            <HeadlessComponentRenderer component={item.section.tree} breakpointId={breakpointId} allBreakpoints={allBreakpoints} scope={scope} />
          </div>
        ) : (
          <SkeletonBlock
            key={`skeleton-${item.slot}`}
            title={item.skeleton.title || `Section ${item.slot + 1}`}
            kind={item.skeleton.kind}
            narrow={narrow}
            attributes={{ [DRAFT_SKELETON_ATTR]: String(item.slot) }}
          />
        ),
      )}
      {band && <DraftBand text={band} />}
    </>
  );
});

export interface DraftPageFramesProps {
  /** Where the page's own frames end on the canvas (the largest canvasX + width). */
  framesRight: number;
  scope?: BindingScope;
}

/** A new page's draft: its frames beside the page's own, titled after the requested page. */
export const DraftPageFrames = observer(function DraftPageFrames({ framesRight, scope }: DraftPageFramesProps) {
  const { editorUI } = useStore();
  const draft = editorUI.pageGenDraft as PageGenDraftStore | undefined;
  const project = editorUI.currentProject;
  const target = draft?.targetOn(editorUI.currentPage?.id);
  if (!target || target.kind !== 'newPage' || !project) return null;
  const left = Math.min(...target.viewports.map((v) => v.x));
  const dx = (Number.isFinite(framesRight) ? framesRight : 0) + DRAFT_FRAME_GAP - (Number.isFinite(left) ? left : 0);
  const breakpoints = target.breakpoints;
  return (
    <>
      <PageBaseStyles base={project.site.pageBase} roots={[`[${DRAFT_FRAME_ATTR}] > [data-fc-theme]`]} />
      {target.viewports.map((v) => (
        <GroundWrapper key={v.breakpointId} id={`pagegen-draft-${v.breakpointId}`} x={v.x + dx} y={v.y} width={v.width} height="auto">
          <div
            {...{ [DRAFT_FRAME_ATTR]: v.breakpointId }}
            aria-hidden="true"
            className="relative rounded-lg bg-white shadow-lg ring-2 ring-brand/40"
            style={{ width: `${v.width}px` }}
          >
            <div className="absolute -top-8 left-0 flex items-center gap-2 whitespace-nowrap text-sm font-medium text-gray-600">
              <span>{target.title}</span>
              <span className="rounded bg-brand/15 px-2 py-0.5 text-xs text-brand">Draft</span>
              <span className="rounded bg-gray-200 px-2 py-0.5 text-xs">{v.label}</span>
            </div>
            <div
              className={editorUI.frameDarkClass ? 'rounded-lg dark' : 'rounded-lg'}
              style={viewportFrameContentStyle(v.height)}
              {...surfaceFrameAttributes('frame', editorUI.frameColorScheme)}
            >
              <div style={GENERATED_PAGE_ROOT_STYLE}>
                <DraftSections breakpointId={v.breakpointId} allBreakpoints={breakpoints} scope={scope} />
              </div>
            </div>
          </div>
        </GroundWrapper>
      ))}
    </>
  );
});

/** Whether two camera positions are the same (a user pan or zoom changes one of them). */
function sameCamera(a: CameraTransform, b: CameraTransform): boolean {
  return Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(a.panX - b.panX) < 0.5 && Math.abs(a.panY - b.panY) < 0.5;
}

/**
 * Brings each new draft section into view (before the first one, the first
 * skeleton of the outline), until the user moves the camera themselves: from
 * then on this run leaves the camera alone. Mounted inside the canvas (it needs
 * the camera's context); renders nothing.
 */
export const DraftCameraFollow = observer(function DraftCameraFollow() {
  const { editorUI } = useStore();
  const draft = editorUI.pageGenDraft as PageGenDraftStore | undefined;
  const { read, panBy } = useCameraControls();
  const requestKey = draft?.targetOn(editorUI.currentPage?.id)?.requestKey;
  const newest = draft?.sections.at(-1)?.index;
  const firstSkeleton = draft?.skeletons[0]?.slot;
  // What to bring into view: the newest section, or before any the first skeleton.
  const focus =
    newest !== undefined ? `[${DRAFT_SECTION_ATTR}="${newest}"]` : firstSkeleton !== undefined ? `[${DRAFT_SKELETON_ATTR}="${firstSkeleton}"]` : undefined;
  // Per run: where this follower last left the camera, and whether the user took over.
  const follow = React.useRef<{ requestKey?: string; last?: CameraTransform; userMoved: boolean }>({ userMoved: false });

  React.useEffect(() => {
    if (!requestKey) {
      follow.current = { userMoved: false };
      return;
    }
    if (follow.current.requestKey !== requestKey) follow.current = { requestKey, last: read(), userMoved: false };
  }, [requestKey, read]);

  React.useEffect(() => {
    if (!requestKey || focus === undefined) return;
    const state = follow.current;
    if (state.requestKey !== requestKey || state.userMoved) return;
    const now = read();
    if (state.last && !sameCamera(state.last, now)) {
      state.userMoved = true;
      return;
    }
    // The newest section in the first frame it is drawn in (its wrapper has no
    // box, its element has), or the skeleton itself.
    const found = document.querySelector(focus);
    const element = (found?.hasAttribute(DRAFT_SKELETON_ATTR) ? found : found?.firstElementChild) as HTMLElement | null | undefined;
    const ground = document.querySelector<HTMLElement>('[data-ground]');
    if (!element || !ground || typeof element.getBoundingClientRect !== 'function') return;
    const box = element.getBoundingClientRect();
    const visible = ground.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return;
    const { dx, dy } = revealOffset(box, visible, 48);
    if (dx !== 0 || dy !== 0) panBy(dx, dy);
    state.last = read();
  }, [requestKey, focus, read, panBy]);

  return null;
});
