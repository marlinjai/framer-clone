// src/lib/ai/review/measureDom.ts
//
// The DOM runner of the layout audit: turns the rendered breakpoint frames on
// the editor canvas into the plain numbers ./layoutAudit.ts classifies.
//
// Where things are (src/components/ResponsivePageRenderer.tsx):
//   [data-viewport-id]          a frame's outer box (it also holds the label)
//     [data-viewport-content-id] the clipping box the page renders into: this
//                                is what gets measured and captured
//       [data-inner-component-id] one rendered component (its node id;
//                                `data-component-id` is "<breakpointId>-<id>",
//                                two hyphenated uuids, so it is never split)
//
// Units: the canvas camera scales the frames with a CSS transform, so every
// getBoundingClientRect value is divided by the frame's zoom, calibrated per
// frame as rendered width / offsetWidth. client* and scroll* sizes are layout
// px already (transforms do not change them).
//
// The browser APIs are injectable (`env`) for tests; the classification is
// tested on numbers in layoutAudit's tests.

import {
  DISPLAY_FONT_PX,
  auditFrames,
  type Box,
  type FrameMeasurement,
  type LayoutFinding,
  type MeasuredNode,
} from './layoutAudit';

export interface MeasureEnv {
  getComputedStyle: (el: Element) => CSSStyleDeclaration;
  createRange: () => Range;
}

const defaultEnv = (): MeasureEnv => ({
  getComputedStyle: (el) => window.getComputedStyle(el),
  createRange: () => document.createRange(),
});

/** Most nodes measured per frame (a generated page has at most 200). */
const MAX_NODES = 600;
/** Display text with more words than this is not split into per-word ranges. */
const MAX_WORDS_FOR_LINES = 60;

/** The content box of a frame, by viewport node id. */
export function frameContentElement(root: ParentNode, viewportId: string): HTMLElement | null {
  // Escaped for a double-quoted attribute value (CSS.escape is not everywhere, e.g. jsdom).
  const value = viewportId.replace(/["\\]/g, '\\$&');
  return root.querySelector<HTMLElement>(`[data-viewport-content-id="${value}"]`);
}

/** The element's own text: its direct text nodes, whitespace collapsed. */
function ownText(el: Element): string {
  let s = '';
  el.childNodes.forEach((c) => {
    if (c.nodeType === 3) s += c.textContent ?? '';
  });
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Words per rendered line, by a Range per word grouped on its top edge.
 * Only for an element whose text sits in direct text nodes.
 */
function wordsPerLine(el: Element, env: MeasureEnv, zoom: number): number[] | undefined {
  const tops: number[] = [];
  let words = 0;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== 3) continue;
    const text = node.textContent ?? '';
    for (const m of text.matchAll(/\S+/g)) {
      if (++words > MAX_WORDS_FOR_LINES) return undefined;
      const range = env.createRange();
      range.setStart(node, m.index ?? 0);
      range.setEnd(node, (m.index ?? 0) + m[0].length);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      tops.push(rect.top / zoom);
    }
  }
  if (tops.length === 0) return undefined;
  const lines: number[] = [];
  let lastTop = Number.NEGATIVE_INFINITY;
  for (const top of tops) {
    // A new line starts when a word sits clearly lower than the previous one.
    if (top - lastTop > 4) {
      lines.push(1);
      lastTop = top;
    } else {
      lines[lines.length - 1] += 1;
    }
  }
  return lines;
}

const px = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Measure one frame's content box. */
export function measureFrame(
  content: HTMLElement,
  frame: { breakpoint: string; isSmallest: boolean },
  env: MeasureEnv = defaultEnv(),
): FrameMeasurement {
  const width = content.offsetWidth || content.clientWidth;
  const rect = content.getBoundingClientRect();
  const zoom = width > 0 && rect.width > 0 ? rect.width / width : 1;
  const toBox = (r: DOMRect): Box => ({
    x: (r.left - rect.left) / zoom,
    y: (r.top - rect.top) / zoom,
    w: r.width / zoom,
    h: r.height / zoom,
  });

  const nodes: MeasuredNode[] = [];
  const elements = Array.from(content.querySelectorAll<HTMLElement>('[data-inner-component-id]')).slice(0, MAX_NODES);
  for (const el of elements) {
    const id = el.getAttribute('data-inner-component-id');
    if (!id) continue;
    const parentEl = el.parentElement?.closest('[data-inner-component-id]');
    const parentId = parentEl && content.contains(parentEl) ? parentEl.getAttribute('data-inner-component-id') ?? undefined : undefined;
    const cs = env.getComputedStyle(el);
    const inline = cs.display === 'inline';
    const text = ownText(el);
    const fontSizePx = px(cs.fontSize);
    const node: MeasuredNode = {
      id,
      ...(parentId ? { parentId } : {}),
      tag: el.tagName.toLowerCase(),
      box: toBox(el.getBoundingClientRect()),
      ...(inline
        ? {}
        : { clientW: el.clientWidth, clientH: el.clientHeight, scrollW: el.scrollWidth, scrollH: el.scrollHeight }),
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      position: cs.position,
      display: cs.display,
      negativeMargin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].some((m) => px(m) < 0),
      transformed: !!cs.transform && cs.transform !== 'none',
      gridPlaced: [cs.gridRowStart, cs.gridColumnStart, cs.gridRowEnd, cs.gridColumnEnd].some((v) => !!v && v !== 'auto'),
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      ...(text
        ? {
            text: {
              content: text.slice(0, 120),
              fontSizePx,
              fontWeight: px(cs.fontWeight) || 400,
              ...(fontSizePx >= DISPLAY_FONT_PX ? { wordsPerLine: wordsPerLine(el, env, zoom) } : {}),
            },
          }
        : {}),
    };
    nodes.push(node);
  }
  return {
    breakpoint: frame.breakpoint,
    width,
    isSmallest: frame.isSmallest,
    contentScrollWidth: content.scrollWidth,
    inheritedColor: env.getComputedStyle(content).color,
    nodes,
  };
}

export interface AuditFrameRef {
  /** The viewport node's id (the frame's data-viewport-content-id). */
  viewportId: string;
  breakpoint: string;
  isSmallest: boolean;
}

export interface DomAuditResult {
  findings: LayoutFinding[];
  /** Frames that were not on the canvas (not rendered) or could not be measured. */
  missing: string[];
}

/** Measure and classify every listed frame that is rendered. */
export function auditRenderedFrames(
  frames: AuditFrameRef[],
  opts: { root?: ParentNode; maxFindings: number; env?: MeasureEnv },
): DomAuditResult {
  const root = opts.root ?? document;
  const measured: FrameMeasurement[] = [];
  const missing: string[] = [];
  for (const f of frames) {
    const content = frameContentElement(root, f.viewportId);
    if (!content) {
      missing.push(f.breakpoint);
      continue;
    }
    measured.push(measureFrame(content, f, opts.env));
  }
  return { findings: auditFrames(measured, opts.maxFindings), missing };
}
