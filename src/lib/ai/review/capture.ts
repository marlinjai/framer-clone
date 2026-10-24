// src/lib/ai/review/capture.ts
//
// Renders a breakpoint frame to a JPEG for the review model, in the browser,
// with modern-screenshot (DOM cloned into an SVG foreignObject, then drawn on a
// canvas). The frame's content box is captured, not its outer box (that one
// also holds the label above the frame), so the image is exactly the page.
//
// Sizes: Desktop at its css width scaled to about 1000 px wide, smaller frames
// at their own width (scale 1, never the device pixel ratio). The height stops
// at MAX_CAPTURE_CSS_HEIGHT css px: the model downscales anything over about
// 1568 px on the long edge, so a whole 6000 px page would arrive as an
// unreadable strip; what lies below is covered by the per-node findings.
// Every image is capped at REVIEW_LIMITS.maxImageBase64Chars: quality, then
// scale, step down until it fits, else the capture fails.
//
// Cross-origin images: stock photos are hotlinked from images.unsplash.com,
// which answers with `access-control-allow-origin: *`, so modern-screenshot's
// fetch inlines them. An image whose host refuses CORS becomes a flat grey
// placeholder (never a failed capture), and the result says how many.

import { REVIEW_LIMITS, type ReviewImage } from './protocol';

/** Target pixel width of a Desktop capture. */
export const DESKTOP_TARGET_PX = 1000;
/** Tallest captured part of a page, in css px. */
export const MAX_CAPTURE_CSS_HEIGHT = 2400;
/** Per-capture time limit (images and fonts included). */
const CAPTURE_TIMEOUT_MS = 15_000;
/** A 1x1 light-grey GIF for images whose host refuses cross-origin reads. */
const PLACEHOLDER_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAMzMzAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';

export interface CaptureRequest {
  element: HTMLElement;
  breakpoint: string;
}

export type CaptureOutcome =
  | { ok: true; image: ReviewImage; placeholderImages: number }
  | { ok: false; breakpoint: string; reason: string };

/** The renderer, injectable for tests (defaults to modern-screenshot's domToJpeg). */
export type JpegRenderer = (
  element: HTMLElement,
  options: {
    scale: number;
    quality: number;
    width: number;
    height: number;
    backgroundColor: string;
    timeout: number;
    onPlaceholder: () => void;
  },
) => Promise<string>;

const modernScreenshotRenderer: JpegRenderer = async (element, o) => {
  const { domToJpeg } = await import('modern-screenshot');
  return domToJpeg(element, {
    scale: o.scale,
    quality: o.quality,
    width: o.width,
    height: o.height,
    backgroundColor: o.backgroundColor,
    timeout: o.timeout,
    fetch: {
      requestInit: { mode: 'cors', cache: 'force-cache' },
      placeholderImage: () => {
        o.onPlaceholder();
        return PLACEHOLDER_GIF;
      },
    },
  });
};

/** Scale for a frame of `cssWidth`: Desktop-wide frames shrink to about 1000 px, others stay 1:1. */
export function captureScale(cssWidth: number): number {
  return cssWidth > DESKTOP_TARGET_PX ? DESKTOP_TARGET_PX / cssWidth : 1;
}

const STEPS: Array<{ quality: number; scaleFactor: number }> = [
  { quality: 0.72, scaleFactor: 1 },
  { quality: 0.55, scaleFactor: 1 },
  { quality: 0.55, scaleFactor: 0.75 },
];

/** Capture one frame. Never throws: a failure comes back as `{ ok: false, reason }`. */
export async function captureFrame(req: CaptureRequest, render: JpegRenderer = modernScreenshotRenderer): Promise<CaptureOutcome> {
  const cssWidth = req.element.offsetWidth;
  const fullHeight = req.element.offsetHeight;
  if (!cssWidth || !fullHeight) return { ok: false, breakpoint: req.breakpoint, reason: 'the frame is not rendered' };
  const cssHeight = Math.min(fullHeight, MAX_CAPTURE_CSS_HEIGHT);
  const baseScale = captureScale(cssWidth);
  for (const step of STEPS) {
    let placeholders = 0;
    const scale = baseScale * step.scaleFactor;
    let dataUrl: string;
    try {
      dataUrl = await render(req.element, {
        scale,
        quality: step.quality,
        width: cssWidth,
        height: cssHeight,
        backgroundColor: '#ffffff',
        timeout: CAPTURE_TIMEOUT_MS,
        onPlaceholder: () => {
          placeholders += 1;
        },
      });
    } catch (err) {
      return { ok: false, breakpoint: req.breakpoint, reason: `rendering failed (${err instanceof Error ? err.message : 'unknown error'})` };
    }
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl);
    if (!m) return { ok: false, breakpoint: req.breakpoint, reason: 'the renderer returned no JPEG' };
    const data = m[1];
    if (data.length > REVIEW_LIMITS.maxImageBase64Chars) continue;
    return {
      ok: true,
      placeholderImages: placeholders,
      image: {
        breakpoint: req.breakpoint,
        mediaType: 'image/jpeg',
        data,
        width: Math.round(cssWidth * scale),
        height: Math.round(cssHeight * scale),
        cssWidth,
        truncated: cssHeight < fullHeight,
      },
    };
  }
  return {
    ok: false,
    breakpoint: req.breakpoint,
    reason: `the image stayed over ${Math.round(REVIEW_LIMITS.maxImageBase64Chars / 1000)} kB`,
  };
}
