// src/lib/renderer/textNode.ts
//
// A text node: a child with `type: '#text'` and its text in `props.children`.
// It emits no element, so `Hello <b>bold</b> world` is three children and the
// DOM is exactly that, with no wrapper around the text. One rule for every
// renderer, so this module stays free of React and of the model (the published
// renderer and the client islands import it too).
//
// Older rows may hold a string AND child nodes on one node. They are not
// migrated: every renderer shows the string first, then the children.
//
// Formatted text from a component's `richtext` input is the one other shape a
// node's text may take: `{ runs: [{ text, marks?, href? }] }`, a validated array
// and never markup. `renderRuns` turns it into elements through the factory each
// renderer passes in (React's createElement), so this module stays free of React.

import { safeHrefFromData } from '@/lib/links/safeHref';

export const TEXT_NODE_TYPE = '#text';

/** True for a node that renders as bare text. */
export function isTextNodeType(type: unknown): boolean {
  return type === TEXT_NODE_TYPE;
}

// Elements whose content model has no place for text. The HTML parser moves
// text out of a table's structure in front of the table (foster parenting) and
// never shows text in a select, so a published page would not match the tree.
const NO_BARE_TEXT: Readonly<Record<string, string>> = {
  table: 'a table',
  thead: 'a table section',
  tbody: 'a table section',
  tfoot: 'a table section',
  tr: 'a table row',
  colgroup: 'a table column group',
  select: 'a dropdown',
  optgroup: 'an option group',
  html: 'the document',
  head: 'the document head',
  frameset: 'a frameset',
};

/** True for an element a browser would not keep bare text in while parsing. */
export function refusesBareText(type: string): boolean {
  return Object.hasOwn(NO_BARE_TEXT, type.toLowerCase());
}

/** Why text may not go directly inside `type`, or undefined when it may. */
export function bareTextRefusal(type: string): string | undefined {
  if (!refusesBareText(type)) return undefined;
  const place = NO_BARE_TEXT[type.toLowerCase()];
  return `Text cannot go directly inside ${place}: a browser would move it out of place. Put it inside a cell or another element.`;
}

let warnedUnrenderable = false;

/**
 * Text as React renders it: strings exactly as stored ("Hello " keeps its
 * space) and numbers, zero included. Nothing is null; anything else stored
 * here cannot render, so it is reported once rather than dropped in silence.
 */
export function renderableText(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value !== undefined && value !== null && !warnedUnrenderable) {
    warnedUnrenderable = true;
    console.warn(`[renderer] stored text is a ${typeof value}, not text: it renders nothing`);
  }
  return null;
}

/** The marks a run of formatted text may carry, and the element each one is. */
const RUN_MARKS = ['strong', 'em', 'u'] as const;

/** One run of formatted text, checked. */
interface Run {
  text: string;
  marks: readonly (typeof RUN_MARKS)[number][];
  href: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The runs of a formatted text value, each checked again here: a node's text is
 * stored JSON, so a value that skipped the input check must not reach a page as
 * an element. Null for anything that is not `{ runs }` with every run valid, so
 * one bad run shows nothing rather than half a sentence.
 */
function runsOf(value: unknown): Run[] | null {
  if (!isRecord(value) || !Array.isArray(value.runs)) return null;
  const runs: Run[] = [];
  for (const run of value.runs) {
    if (!isRecord(run) || typeof run.text !== 'string') return null;
    const marks = run.marks ?? [];
    if (!Array.isArray(marks) || !marks.every(mark => (RUN_MARKS as readonly unknown[]).includes(mark))) return null;
    let href: string | null = null;
    if (run.href !== undefined) {
      href = safeHrefFromData(run.href);
      if (href === null) return null;
    }
    runs.push({ text: run.text, marks: marks as Run['marks'], href });
  }
  return runs;
}

/** True when a node's text is formatted text, `{ runs }`, that renders. */
export function isFormattedText(value: unknown): boolean {
  return runsOf(value) !== null;
}

/** The plain text of formatted text, or '' for anything else. */
export function formattedPlainText(value: unknown): string {
  return (runsOf(value) ?? []).map(run => run.text).join('');
}

/** How an element is made: React's createElement in every renderer. */
export type ElementFactory<N> = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => N;

/**
 * Formatted text as elements: each run its text, wrapped in its marks in a fixed
 * order (strong outermost, then em, then u), and in a link outside those when it
 * has an address. Where the
 * text sits inside a link or a button already, `linksAllowed` is false and a run's
 * address is left out: a link inside a link is invalid, and the HTML parser would
 * close the outer one there, so the published page would not match the tree.
 */
export function renderRuns<N>(value: unknown, h: ElementFactory<N>, linksAllowed = true): (N | string)[] | null {
  const runs = runsOf(value);
  if (!runs) return null;
  return runs.map((run, index) => {
    // Innermost first. A plain run stays a bare string, so `Plain <strong>bold</strong>`
    // is exactly that; the outermost wrapper of a run carries its key, as React wants
    // for a list of siblings.
    const wrappers: { type: string; props: Record<string, unknown> | null }[] = [...RUN_MARKS]
      .reverse()
      .filter(mark => run.marks.includes(mark))
      .map(mark => ({ type: mark, props: null }));
    if (run.href !== null && linksAllowed) wrappers.push({ type: 'a', props: { href: run.href } });
    let content: N | string = run.text;
    wrappers.forEach((wrapper, at) => {
      const props = at === wrappers.length - 1 ? { ...wrapper.props, key: index } : wrapper.props;
      content = h(wrapper.type, props, content);
    });
    return content;
  });
}

/** Tags whose content is interactive already, so a link inside would be invalid. */
const INTERACTIVE_HOSTS: ReadonlySet<string> = new Set(['a', 'button']);

/** Whether formatted text inside this tag may hold links. */
export function runLinksAllowedIn(tag: unknown): boolean {
  return !(typeof tag === 'string' && INTERACTIVE_HOSTS.has(tag.toLowerCase()));
}

/**
 * A node's own text as it renders: formatted text as elements through `h`, and
 * anything else as `renderableText` has it.
 */
export function renderOwnText<N>(value: unknown, h: ElementFactory<N>, linksAllowed = true): (N | string)[] | string | number | null {
  return renderRuns(value, h, linksAllowed) ?? renderableText(value);
}

/**
 * What an element contains: its own text, then its children. Without children
 * the text is all there is; with them, a legacy string stays in front. With `h`,
 * formatted text renders as elements (see renderRuns); without it, only text does.
 */
export function ownTextThenChildren<T, N = unknown>(
  text: unknown,
  children: readonly T[],
  h?: ElementFactory<N>,
  linksAllowed = true,
): unknown {
  const own = h ? renderOwnText(text, h, linksAllowed) : renderableText(text);
  if (children.length === 0) return own;
  if (Array.isArray(own)) return [...own, ...children];
  return own === null || own === '' ? children : [own, ...children];
}
