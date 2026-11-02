// src/lib/components/richText.ts
//
// The panel's way to write a `richtext` input: a text area that reads
// `**bold**`, `*italic*`, `__underlined__` and `[label](address)`, turned into
// the validated runs the input stores, and back. It is a notation for the field,
// never markup: what it makes still goes through parseInputValue, so an address
// it reads is checked by safeHrefFromData like any other.
//
// - Markers pair up, and a marker opens only before text and closes only after
//   it. One without its partner is literal text, so `2 * 3` and a lone `[` stay
//   as typed.
// - Marks nest inside a link's label (`[**Shop**](/shop)`), and a link inside a
//   mark (`**[Shop](/shop)**`) carries that mark.
// - A backslash keeps the next marker character literal: `\*` is a star.
// - formatRuns gives back text that parseRuns reads as the same runs, for runs
//   the field itself could have made.
//
// Contract: docs/plans/2026-11-02-reusable-components.md, "The input types".
//
// PURE: no React, no MST. Client and server safe.

import { RICH_TEXT_MARKS, type RichTextMark, type TextRun } from './inputs';

/** The notation for each mark, longest first so `**` is read before `*`. */
const MARKERS: readonly { marker: string; mark: RichTextMark }[] = [
  { marker: '**', mark: 'strong' },
  { marker: '__', mark: 'u' },
  { marker: '*', mark: 'em' },
];

const SPECIAL = /[*_[\]()\\]/g;

/** Text with every character the notation reads kept literal. */
const escape = (text: string): string => text.replace(SPECIAL, (c) => `\\${c}`);

/** The end of a run of text with `marker` closing it, or -1 when it never closes. */
function closing(source: string, from: number, marker: string): number {
  for (let at = from; at < source.length; at++) {
    if (source[at] === '\\') {
      at++;
      continue;
    }
    // Inside an italic, `**` opens a bold of its own: skipped whole when it pairs.
    if (marker === '*' && source.startsWith('**', at) && !/\s/.test(source[at + 2] ?? ' ')) {
      const inner = closing(source, at + 2, '**');
      if (inner !== -1) {
        at = inner + 1;
        continue;
      }
    }
    // A marker after a space does not close: `a * b` keeps its star.
    if (at > from && source.startsWith(marker, at) && !/\s/.test(source[at - 1])) return at;
  }
  return -1;
}

/** Where a `[label](address)` starting at `at` ends, with its parts, or null. */
function linkAt(source: string, at: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === '[') depth++;
    if (source[i] === ']' && --depth === 0) {
      if (source[i + 1] !== '(') return null;
      const close = source.indexOf(')', i + 2);
      if (close === -1) return null;
      return { label: source.slice(at + 1, i), href: source.slice(i + 2, close).trim(), end: close + 1 };
    }
  }
  return null;
}

function read(source: string, marks: readonly RichTextMark[], href: string | undefined, out: TextRun[]): void {
  let text = '';
  const flush = () => {
    if (text === '') return;
    out.push({ text, ...(marks.length > 0 ? { marks: [...marks] } : {}), ...(href !== undefined ? { href } : {}) });
    text = '';
  };
  for (let at = 0; at < source.length; ) {
    const c = source[at];
    if (c === '\\' && at + 1 < source.length) {
      text += source[at + 1];
      at += 2;
      continue;
    }
    if (c === '[' && href === undefined) {
      const link = linkAt(source, at);
      if (link && link.href !== '') {
        flush();
        read(link.label, marks, link.href, out);
        at = link.end;
        continue;
      }
    }
    // `***both***` is bold and italic at once, as formatRuns writes it.
    if (source.startsWith('***', at) && !marks.includes('strong') && !marks.includes('em') && !/\s/.test(source[at + 3] ?? ' ')) {
      const end = source.indexOf('***', at + 4);
      if (end !== -1 && !/\s/.test(source[end - 1])) {
        flush();
        read(source.slice(at + 3, end), [...marks, 'strong', 'em'], href, out);
        at = end + 3;
        continue;
      }
    }
    const opener = MARKERS.find(({ marker }) => source.startsWith(marker, at));
    // A marker before a space does not open, as in `2 * 3`.
    const opens = opener && !/\s/.test(source[at + opener.marker.length] ?? ' ');
    if (opener && opens && !marks.includes(opener.mark)) {
      const end = closing(source, at + opener.marker.length, opener.marker);
      if (end !== -1) {
        flush();
        read(source.slice(at + opener.marker.length, end), [...marks, opener.mark], href, out);
        at = end + opener.marker.length;
        continue;
      }
    }
    text += c;
    at++;
  }
  flush();
}

/** Runs next to each other with the same marks and address become one. */
function merged(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  const same = (a: TextRun, b: TextRun) =>
    a.href === b.href && (a.marks ?? []).join() === (b.marks ?? []).join();
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && same(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

/** In a fixed order, so the same marks always compare and format the same. */
const ordered = (marks: readonly RichTextMark[]): RichTextMark[] =>
  RICH_TEXT_MARKS.filter((mark) => marks.includes(mark));

/** The field's text as formatted text. Empty text is no runs. */
export function parseRuns(source: string): { runs: TextRun[] } {
  const runs: TextRun[] = [];
  read(source, [], undefined, runs);
  return {
    runs: merged(runs.map((run) => (run.marks ? { ...run, marks: ordered(run.marks) } : run))),
  };
}

const MARKER_OF: Record<RichTextMark, string> = { strong: '**', em: '*', u: '__' };

/**
 * Formatted text as the field shows it. A plain string (from a CMS, say) shows as
 * itself with its marker characters kept literal; anything else that is not runs
 * shows as nothing.
 */
export function formatRuns(value: unknown): string {
  if (typeof value === 'string') return escape(value);
  const runs = (value as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return '';
  return runs
    .map((run: TextRun) => {
      if (!run || typeof run.text !== 'string') return '';
      let text = escape(run.text);
      // Innermost last in the notation: strong outside, then em, then underline.
      for (const mark of [...ordered(run.marks ?? [])].reverse()) text = `${MARKER_OF[mark]}${text}${MARKER_OF[mark]}`;
      return typeof run.href === 'string' ? `[${text}](${run.href})` : text;
    })
    .join('');
}
