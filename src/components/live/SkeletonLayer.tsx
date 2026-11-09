// src/components/live/SkeletonLayer.tsx
//
// The skeletons of the live agent canvas (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 3): every section an agent announced (announce_sections) and has not
// written yet, drawn where it will go, from the plans store
// (src/lib/live/plansStore.ts).
//
//   - On an existing page: a detached block among the page root's children,
//     after the plan's `after` section or at the end of the page. Only the page
//     root ever hosts skeletons, and the anchor is resolved against the open
//     copy on every draw: a section the person deleted (or moved under another)
//     carries none at once, and an undo brings them back until the deletion is
//     saved (the save tells the server, which ends the plan for good).
//   - On a new page (newPage): a ghost page frame per breakpoint beside the
//     page's own frames, titled after the planned page, as the Generate draft
//     does for a new page (src/components/ai/PageGenDraftLayer.tsx).
//
// Detached and visual only: never in the project, never saved, never in the
// history, absent from the Layers panel (which reads the project), pointer
// events off and hidden from assistive technology (the activity feed speaks
// for the agent). A section's title is the only text an agent wrote here; it is
// sanitised and capped (sanitizePlanTitle) and rendered as a React text node,
// never into an attribute, a selector or a style.
//
// The Generate draft draws its outline's skeletons with the same block
// (SkeletonBlock), under its own marker, so the presence frame never takes one
// of them for an agent's.
//
// Static shapes per kind (hero, features, gallery, ...), sized to the
// breakpoint, in a neutral tint that reads on a light and a dark frame. No
// shimmer and no pulse: the motion rules forbid perpetual animation, and the
// presence frame on the skeleton being filled is the motion cue. A plan whose
// agent stopped fades out over 200ms (ease-out), nothing moves under reduced
// motion. A replaced plan keeps the skeletons of the refs it keeps: their React
// keys are the agent and the ref, never the plan id.
'use client';

import React from 'react';
import { computed } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import GroundWrapper from '@/components/GroundWrapper';
import { viewportFrameContentStyle } from '@/lib/canvas/viewportFrame';
import { surfaceFrameAttributes } from '@/lib/site/surfaceTheme';
import type { LivePlansStore } from '@/lib/live/plansStore';
import type { LivePlan, LivePlanSection, PlanSectionKind } from '@/lib/projects/liveEvents';

/** Marks a skeleton: its value is `<agentId>:<ref>` (the presence frame finds it by that). */
export const SKELETON_ATTR = 'data-live-skeleton';
/** Marks a skeleton of a plan whose agent stopped (fading out). */
export const SKELETON_LEAVING_ATTR = 'data-live-skeleton-leaving';
/** Marks a ghost page frame of a planned new page. */
export const SKELETON_FRAME_ATTR = 'data-live-skeleton-frame';

/** The key of a skeleton: one agent's ref, stable across a replace. */
export function skeletonKey(agentId: string, ref: string): string {
  return `${agentId}:${ref}`;
}

/** Below this frame width a skeleton stacks its columns (the editor's tablet breakpoint). */
export const SKELETON_NARROW_PX = 768;
/** Space between the page's frames and a ghost page's frames (as the Generate draft's). */
const GHOST_FRAME_GAP = 160;

const TINT = 'rgba(128, 128, 128, 0.10)';
const BAR = 'rgba(128, 128, 128, 0.22)';
const EDGE = 'rgba(128, 128, 128, 0.35)';

const SKELETON_CSS = `
[${SKELETON_ATTR}], [${SKELETON_ATTR}] *, [${SKELETON_FRAME_ATTR}], [${SKELETON_FRAME_ATTR}] * { pointer-events: none !important; }
[${SKELETON_ATTR}] { transition: opacity 200ms ease-out; }
[${SKELETON_ATTR}][${SKELETON_LEAVING_ATTR}] { opacity: 0; }
@media (prefers-reduced-motion: reduce) { [${SKELETON_ATTR}] { transition: none; } }
`;

/** The skeleton layer's own rules (no pointer, the fade). Mounted once beside the canvas frames, never inside the page tree. */
export function SkeletonStyles() {
  return <style data-live-skeleton-styles="">{SKELETON_CSS}</style>;
}

function Bar({ width, height = 14, round = 4, style }: { width: string | number; height?: number; round?: number; style?: React.CSSProperties }) {
  return <div style={{ width, height, borderRadius: round, background: BAR, flexShrink: 0, ...style }} />;
}

function Block({ height, style }: { height: number; style?: React.CSSProperties }) {
  return <div style={{ width: '100%', height, borderRadius: 10, background: BAR, ...style }} />;
}

function Grid({ columns, gap = 20, children }: { columns: number; gap?: number; children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}>{children}</div>;
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 18, borderRadius: 12, border: `1px solid ${EDGE}`, ...style }}>{children}</div>;
}

/** The static shape of one kind, laid out for a narrow or a wide frame. Pure markup. */
export function SkeletonShape({ kind, narrow }: { kind: PlanSectionKind; narrow: boolean }) {
  const cols = (wide: number, small = 1) => (narrow ? small : wide);
  switch (kind) {
    case 'hero':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.1fr 1fr', gap: 32, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Bar width="85%" height={narrow ? 28 : 40} round={6} />
            <Bar width="70%" />
            <Bar width="60%" />
            <Bar width={140} height={40} round={20} style={{ marginTop: 10 }} />
          </div>
          <Block height={narrow ? 180 : 260} />
        </div>
      );
    case 'features':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Bar width="40%" height={26} round={6} style={{ alignSelf: 'center' }} />
          <Grid columns={cols(3)}>
            {[0, 1, 2].map((i) => (
              <Card key={i}>
                <Bar width={40} height={40} round={10} />
                <Bar width="60%" height={18} />
                <Bar width="90%" />
                <Bar width="75%" />
              </Card>
            ))}
          </Grid>
        </div>
      );
    case 'gallery':
      return (
        <Grid columns={cols(3, 2)} gap={12}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Block key={i} height={narrow ? 110 : 170} />
          ))}
        </Grid>
      );
    case 'pricing':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Bar width="35%" height={26} round={6} style={{ alignSelf: 'center' }} />
          <Grid columns={cols(3)}>
            {[0, 1, 2].map((i) => (
              <Card key={i} style={{ gap: 12 }}>
                <Bar width="45%" height={16} />
                <Bar width="55%" height={32} round={6} />
                {[0, 1, 2, 3].map((j) => (
                  <Bar key={j} width={`${80 - j * 8}%`} height={12} />
                ))}
                <Bar width="100%" height={40} round={20} style={{ marginTop: 8 }} />
              </Card>
            ))}
          </Grid>
        </div>
      );
    case 'testimonials':
      return (
        <Grid columns={cols(3)}>
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <Bar width="95%" />
              <Bar width="85%" />
              <Bar width="70%" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <Bar width={36} height={36} round={18} />
                <Bar width="40%" height={12} />
              </div>
            </Card>
          ))}
        </Grid>
      );
    case 'faq':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>
          <Bar width="45%" height={26} round={6} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 14, borderBottom: `1px solid ${EDGE}` }}>
              <Bar width={`${70 - i * 6}%`} height={16} />
              <Bar width={16} height={16} round={8} />
            </div>
          ))}
        </div>
      );
    case 'cta':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <Bar width="55%" height={narrow ? 26 : 34} round={6} />
          <Bar width="40%" />
          <Bar width={160} height={44} round={22} style={{ marginTop: 10 }} />
        </div>
      );
    case 'form':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560, margin: '0 auto', width: '100%' }}>
          <Bar width="50%" height={26} round={6} />
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Bar width={90} height={12} />
              <div style={{ height: i === 2 ? 96 : 42, borderRadius: 8, border: `1px solid ${EDGE}` }} />
            </div>
          ))}
          <Bar width={140} height={42} round={21} style={{ marginTop: 6 }} />
        </div>
      );
    case 'footer':
      return (
        <Grid columns={cols(4, 2)} gap={24}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Bar width="50%" height={14} />
              <Bar width="70%" height={10} />
              <Bar width="60%" height={10} />
              <Bar width="65%" height={10} />
            </div>
          ))}
        </Grid>
      );
    default:
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Bar width="45%" height={26} round={6} />
          <Bar width="75%" />
          <Block height={narrow ? 120 : 180} style={{ marginTop: 8 }} />
        </div>
      );
  }
}

/** The skeleton title's chip: dark grey on near white, whatever the page's background is. */
export const SKELETON_TITLE_STYLE: React.CSSProperties = {
  alignSelf: 'flex-start',
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '2px 8px',
  borderRadius: 4,
  background: 'rgba(255, 255, 255, 0.92)',
  color: '#404040',
  font: '500 12px/1.4 system-ui, sans-serif',
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * The block every skeleton is drawn as: the section's title (plain text) above
 * its static shape. `attributes` mark what it belongs to (an agent's plan, or
 * the Generate draft, src/components/ai/PageGenDraftLayer.tsx), so each layer
 * finds only its own; the block itself carries no marker.
 */
export function SkeletonBlock({ title, kind, narrow, attributes }: { title: string; kind: PlanSectionKind; narrow: boolean; attributes: Record<string, string> }) {
  return (
    <div
      {...attributes}
      aria-hidden="true"
      style={{
        boxSizing: 'border-box',
        width: '100%',
        padding: narrow ? '32px 16px' : '56px 48px',
        background: TINT,
        borderTop: `1px dashed ${EDGE}`,
        borderBottom: `1px dashed ${EDGE}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {/* On its own light chip: the page behind may be any colour, a dark frame too, and the title stays readable (about 9:1). */}
      <div style={SKELETON_TITLE_STYLE}>{title}</div>
      <SkeletonShape kind={kind} narrow={narrow} />
    </div>
  );
}

/** One skeleton of an agent's plan. */
export function SkeletonSection({ agentId, section, narrow, leaving }: { agentId: string; section: LivePlanSection; narrow: boolean; leaving: boolean }) {
  return (
    <SkeletonBlock
      title={section.title}
      kind={section.kind}
      narrow={narrow}
      attributes={{ [SKELETON_ATTR]: skeletonKey(agentId, section.ref), ...(leaving ? { [SKELETON_LEAVING_ATTR]: '' } : {}) }}
    />
  );
}

/** Whether a breakpoint's frame is narrow (columns stack). */
export function isNarrowBreakpoint(breakpointId: string, allBreakpoints: ReadonlyArray<{ id: string; minWidth: number }>): boolean {
  const sorted = [...allBreakpoints].sort((a, b) => b.minWidth - a.minWidth);
  const index = sorted.findIndex((b) => b.id === breakpointId);
  if (index < 0) return false;
  // A breakpoint covers widths from its own minimum up to the next larger one's.
  const upTo = index === 0 ? Infinity : sorted[index - 1].minWidth;
  return upTo <= SKELETON_NARROW_PX;
}

/** The skeletons of one place on the page: the sections of every plan standing there, in plan order. */
export interface SkeletonGroup {
  /** The top-level section they follow, or undefined for the end of the page. */
  after?: string;
  items: Array<{ agentId: string; section: LivePlanSection; leaving: boolean }>;
}

/**
 * Where skeletons stand on a page root with these children: grouped by anchor,
 * an `after` that is not a child of the root (deleted, or moved under another
 * section) draws nothing. Pure.
 */
export function skeletonGroups(
  plans: ReadonlyArray<{ plan: LivePlan; leaving: boolean; sections: readonly LivePlanSection[] }>,
  rootChildIds: readonly string[],
): SkeletonGroup[] {
  const children = new Set(rootChildIds);
  const groups = new Map<string, SkeletonGroup>();
  for (const { plan, leaving, sections } of plans) {
    if (plan.after !== undefined && !children.has(plan.after)) continue;
    const key = plan.after ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { ...(plan.after !== undefined ? { after: plan.after } : {}), items: [] };
      groups.set(key, group);
    }
    for (const section of sections) group.items.push({ agentId: plan.agentId, section, leaving });
  }
  return [...groups.values()];
}

/** The base id of a rendered child (a repeated child's copies are keyed `<id>__<index>`). */
function childIdOfKey(key: React.Key | null): string | undefined {
  if (key === null) return undefined;
  const text = String(key);
  const cut = text.indexOf('__');
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * The page root's rendered children with the skeleton groups spliced in:
 * a group after the last copy of its `after` child, the end group last. Pure.
 */
export function withSkeletons(children: React.ReactNode[], groups: readonly SkeletonGroup[], render: (group: SkeletonGroup) => React.ReactNode): React.ReactNode[] {
  if (groups.length === 0) return children;
  const after = new Map(groups.filter((g) => g.after !== undefined).map((g) => [g.after!, g]));
  const out: React.ReactNode[] = [];
  children.forEach((child, index) => {
    out.push(child);
    const id = React.isValidElement(child) ? childIdOfKey(child.key) : undefined;
    const next = children[index + 1];
    const nextId = React.isValidElement(next) ? childIdOfKey(next.key) : undefined;
    if (id && id !== nextId && after.has(id)) out.push(render(after.get(id)!));
  });
  const end = groups.find((g) => g.after === undefined);
  if (end) out.push(render(end));
  return out;
}

/**
 * The skeleton groups the page root `componentId` hosts, as a computed per
 * node: only the current page's root ever gets any, and only the root redraws
 * when a plan changes. Null for every other node. `skip` for nodes skeletons
 * never meet (inside a placement's definition).
 */
export function useSkeletonGroups(componentId: string, childIds: () => readonly string[], skip: boolean): SkeletonGroup[] | null {
  const { editorUI } = useStore();
  const plans = editorUI.livePlans as LivePlansStore | undefined;
  const value = React.useMemo(
    () =>
      computed(() => {
        if (skip || !plans) return null;
        const page = editorUI.currentPage;
        if (!page || page.appComponentTree?.id !== componentId) return null;
        const groups = skeletonGroups(plans.onPage(page.id), childIds());
        return groups.length > 0 ? groups : null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plans, editorUI, componentId, skip],
  );
  return value.get();
}

/** One group drawn in a frame. */
export function SkeletonGroupView({ group, breakpointId, allBreakpoints }: { group: SkeletonGroup; breakpointId: string; allBreakpoints: ReadonlyArray<{ id: string; minWidth: number }> }) {
  const narrow = isNarrowBreakpoint(breakpointId, allBreakpoints);
  return (
    <>
      {group.items.map(({ agentId, section, leaving }) => (
        <SkeletonSection key={skeletonKey(agentId, section.ref)} agentId={agentId} section={section} narrow={narrow} leaving={leaving} />
      ))}
    </>
  );
}

export interface GhostFrame {
  breakpointId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  minWidth: number;
}

/**
 * The ghost page frames of planned new pages, beside the page's own frames
 * (`frames`), one row per plan, after the Generate draft's frames of a new page
 * when that draft is on screen too (`occupiedRight`).
 */
export const SkeletonPageFrames = observer(function SkeletonPageFrames({ frames, occupiedRight }: { frames: readonly GhostFrame[]; occupiedRight: number }) {
  const { editorUI } = useStore();
  const plans = editorUI.livePlans as LivePlansStore | undefined;
  const ghosts = plans?.ghostPlans ?? [];
  if (ghosts.length === 0 || frames.length === 0) return null;
  const left = Math.min(...frames.map((f) => f.x));
  const right = Math.max(...frames.map((f) => f.x + f.width));
  const span = right - left;
  const breakpoints = frames.map((f) => ({ id: f.breakpointId, minWidth: f.minWidth }));
  return (
    <>
      {ghosts.map(({ plan, leaving, sections }, row) => {
        const dx = (Number.isFinite(occupiedRight) ? occupiedRight : right) + GHOST_FRAME_GAP - left + row * (span + GHOST_FRAME_GAP);
        return frames.map((f) => (
          <GroundWrapper key={`${plan.agentId}:${plan.newPage?.ref}:${f.breakpointId}`} id={`live-skeleton-${plan.planId}-${f.breakpointId}`} x={f.x + dx} y={f.y} width={f.width} height="auto">
            <div
              {...{ [SKELETON_FRAME_ATTR]: f.breakpointId }}
              aria-hidden="true"
              className="relative rounded-lg bg-white shadow-lg ring-2 ring-gray-300/70"
              style={{ width: `${f.width}px`, opacity: leaving ? 0 : 1, transition: 'opacity 200ms ease-out' }}
            >
              <div className="absolute -top-8 left-0 flex max-w-full items-center gap-2 whitespace-nowrap text-sm font-medium text-gray-600">
                <span className="min-w-0 truncate" title={plan.newPage?.title}>
                  {plan.newPage?.title}
                </span>
                <span className="shrink-0 rounded bg-gray-200 px-2 py-0.5 text-xs">Planned</span>
                <span className="shrink-0 rounded bg-gray-200 px-2 py-0.5 text-xs">{f.label}</span>
              </div>
              <div
                className={editorUI.frameDarkClass ? 'rounded-lg dark' : 'rounded-lg'}
                style={viewportFrameContentStyle(f.height)}
                {...surfaceFrameAttributes('frame', editorUI.frameColorScheme)}
              >
                <SkeletonGroupView
                  group={{ items: sections.map((section) => ({ agentId: plan.agentId, section, leaving })) }}
                  breakpointId={f.breakpointId}
                  allBreakpoints={breakpoints}
                />
              </div>
            </div>
          </GroundWrapper>
        ));
      })}
    </>
  );
});
