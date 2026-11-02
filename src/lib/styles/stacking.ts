// src/lib/styles/stacking.ts
//
// Who stacks above whom on a published page. The platform's own layers sit at
// the top of the z-index range, and every z-index a stored page writes is held
// below them when it is emitted, whichever path it takes: the inline style
// (blockedNodes.ts), the sheet (responsiveCss.ts: Normal, rules, definitions
// such as a keyframe, the canvas and the preview). A stored node at
// `position:fixed;inset:0;z-index:2147483647` would otherwise cover the
// consent banner and take both of its buttons, a tie included: at equal
// z-index the later element wins, and the banner comes first in the body.
//
// The value is capped as it is written, never refused, so a page keeps its own
// order below the ceiling. A value the sheet cannot read as a number (`var()`,
// `calc()`) is wrapped in `min()`, so the browser holds it below the ceiling
// whatever the custom property says, including one the behaviour runtime
// writes later. The page generator keeps its own, lower limit
// (GENERATION_LIMITS.maxZIndex). Stored content in the top layer (a popover, a
// modal dialog, fullscreen), which no z-index reaches, is the consent runtime's
// part: src/lib/consent/consent.ts.
//
// PURE: no imports.

/** The consent banner: the highest z-index there is, and nothing stored can reach it. */
export const CONSENT_BANNER_Z_INDEX = 2147483647;

/** The pinned sticky call to action bar: above page content, below the consent banner. */
export const STICKY_CTA_Z_INDEX = 2147482000;

/** The highest z-index a stored page is emitted with: below every platform layer, with room for more. */
export const STORED_Z_INDEX_MAX = 2147480000;

const KEYWORD = /^(?:auto|inherit|initial|unset|revert|revert-layer)$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const IMPORTANT = /^([\s\S]*?)\s*!\s*important$/i;

/**
 * A stored z-index as it may be emitted: a number above STORED_Z_INDEX_MAX
 * becomes the ceiling, a keyword stays, anything else is wrapped in `min()`.
 * `!important` stays where it was. Text React would not write (empty, not a
 * scalar) is returned as it came, for the caller's own rules to drop.
 */
export function cappedZIndex(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) && value > STORED_Z_INDEX_MAX ? STORED_Z_INDEX_MAX : value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const important = IMPORTANT.exec(trimmed);
  const core = important ? important[1] : trimmed;
  const flag = important ? ' !important' : '';
  if (core === '' || KEYWORD.test(core)) return value;
  if (NUMBER.test(core)) return Number(core) > STORED_Z_INDEX_MAX ? `${STORED_Z_INDEX_MAX}${flag}` : value;
  return `min(${core}, ${STORED_Z_INDEX_MAX})${flag}`;
}

/** A style with its z-index capped (cappedZIndex); the same object when nothing changes. */
export function withCappedZIndex<T extends Record<string, unknown>>(style: T): T {
  if (!('zIndex' in style)) return style;
  const capped = cappedZIndex(style.zIndex);
  return capped === style.zIndex ? style : { ...style, zIndex: capped };
}
