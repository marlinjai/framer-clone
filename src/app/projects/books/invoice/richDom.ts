// src/app/projects/books/invoice/richDom.ts
//
// The formatting editor's two conversions (WYSIWYG invoice editor plan, phase
// 4, formatted texts part 2): the run model (render/richText.ts) to the
// editable HTML it starts from, and whatever the browser's editing turned that
// HTML into back to runs. The DOM is scratch, the runs are the truth: the
// editor reads the DOM only through `richFromDom`, after every change.
//
// `richFromDom` accepts what Chrome's editing commands and a paste can leave
// behind and keeps only what the run model has:
// - blocks: `p` and `div` are paragraphs, `li` (in `ul` or `ol`) bullet items,
//   text outside a block a paragraph of its own;
// - a `br` (or a line break character) inside a block starts a new block of
//   the same kind (the run model has no soft line break: a line is a block, as
//   the plain text's lines are);
// - styles: `b`, `strong` and a span with a font weight of 600 or more are
//   bold; `i`, `em` and a span with an italic font style are italic;
// - every other element is unwrapped (its text kept, its tag dropped), and a
//   non-breaking space (which contenteditable puts at run edges) becomes a
//   space, so it never reaches the PDF or the plain text.

import { normalizeRichText, type RichText, type TextBlock, type TextRun } from '@/server/books/render/richText';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Spaces as an editing surface shows them: a run of several spaces, or a space at a line's start or end, would
 * collapse to nothing in HTML, so they alternate with non-breaking spaces, as Chrome writes them (and `richFromDom`
 * reads a non-breaking space back as a space).
 */
function keepSpaces(text: string, lineStart: boolean, lineEnd: boolean): string {
  let t = text.replace(/ {2,}/g, (m) => Array.from(m, (_, i) => (i % 2 === 0 ? '\u00a0' : ' ')).join(''));
  if (lineStart && t.startsWith(' ')) t = `\u00a0${t.slice(1)}`;
  if (lineEnd && t.endsWith(' ')) t = `${t.slice(0, -1)}\u00a0`;
  return t;
}

function runHtml(r: TextRun, lineStart: boolean, lineEnd: boolean): string {
  let html = esc(keepSpaces(r.text, lineStart, lineEnd));
  if (r.italic) html = `<em>${html}</em>`;
  if (r.bold) html = `<strong>${html}</strong>`;
  return html;
}

/** The editable HTML of a formatted text: paragraphs, bullet lists of consecutive items, `strong` and `em`. */
export function richToHtml(rich: RichText): string {
  let html = '';
  let inList = false;
  for (const block of rich.blocks) {
    // An empty block holds a <br>, so the caret has a line to sit in.
    const inner = block.runs.length === 0 ? '<br>' : block.runs.map((r, i) => runHtml(r, i === 0, i === block.runs.length - 1)).join('');
    if (block.kind === 'bullet') {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${inner}</li>`;
    } else {
      if (inList) html += '</ul>';
      inList = false;
      html += `<p>${inner}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html || '<p><br></p>';
}

interface Style {
  bold: boolean;
  italic: boolean;
}

function styleOf(el: HTMLElement, inherited: Style): Style {
  const tag = el.tagName;
  const weight = el.style?.fontWeight ?? '';
  const fontStyle = el.style?.fontStyle ?? '';
  let bold = inherited.bold || tag === 'B' || tag === 'STRONG' || weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  let italic = inherited.italic || tag === 'I' || tag === 'EM' || fontStyle === 'italic' || fontStyle === 'oblique';
  // An explicit "not bold" or "not italic" switches the inherited style off (Chrome writes such a span when it
  // cannot split the bold or italic element around the selection).
  if (weight === 'normal' || weight === 'lighter' || (weight !== '' && Number(weight) < 600)) bold = false;
  if (fontStyle === 'normal') italic = false;
  return { bold, italic };
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);

/** The formatted text an editing surface shows, read back as runs (normalised; one empty paragraph when empty). */
export function richFromDom(root: HTMLElement): RichText {
  const blocks: TextBlock[] = [];
  let current: TextBlock | null = null;
  const open = (kind: TextBlock['kind']) => {
    current = { kind, runs: [] };
    blocks.push(current);
    return current;
  };
  const ensure = (kind: TextBlock['kind']) => current ?? open(kind);

  const walkInline = (node: Node, style: Style, kind: TextBlock['kind']) => {
    if (node.nodeType === 3) {
      // A line break typed as a character (Chrome does so where white space is preserved) is a line break, as a
      // <br> is: what the editor shows on two lines is saved on two lines.
      const parts = (node.textContent ?? '').replace(/\u00a0/g, ' ').split(/\r\n?|\n/);
      parts.forEach((text, i) => {
        // The line before the break exists even when it is empty (a break at the start of a block is a blank line).
        if (i > 0) {
          ensure(kind);
          open(kind);
        }
        if (text !== '') ensure(kind).runs.push({ text, ...(style.bold ? { bold: true as const } : {}), ...(style.italic ? { italic: true as const } : {}) });
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.tagName === 'BR') {
      // A line break inside a block: the next line is a block of its own, of the same kind. A <br> that ends its
      // block draws no line (the browser keeps it there to hold an empty line open), so it starts nothing.
      // The line before it exists even when empty: a <br> at the start of a block leaves a blank line.
      ensure(kind);
      if (!endsBlock(el)) open(kind);
      return;
    }
    if (BLOCK_TAGS.has(el.tagName)) {
      walkBlock(el, style);
      return;
    }
    const s = styleOf(el, style);
    el.childNodes.forEach((c) => walkInline(c, s, kind));
  };

  const walkBlock = (el: HTMLElement, style: Style) => {
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      el.childNodes.forEach((c) => {
        if (c.nodeType === 1 && (c as HTMLElement).tagName === 'LI') walkBlock(c as HTMLElement, style);
        else walkInline(c, style, 'bullet');
      });
      current = null;
      return;
    }
    const kind = el.tagName === 'LI' ? 'bullet' : 'paragraph';
    // The block opens a line when it has text or a line break of its own: one that only wraps other blocks (Chrome
    // nests a new list in the paragraph it was started from, "<p><ul>...</ul></p>") adds no empty line.
    current = null;
    const s = styleOf(el, style);
    el.childNodes.forEach((c) => walkInline(c, s, kind));
    current = null;
  };

  const top: Style = { bold: false, italic: false };
  root.childNodes.forEach((node) => {
    if (node.nodeType === 1 && BLOCK_TAGS.has((node as HTMLElement).tagName)) {
      current = null;
      walkBlock(node as HTMLElement, top);
      current = null;
    } else {
      walkInline(node, top, 'paragraph');
    }
  });
  // An empty list item left at the end (the editor's "<li><br></li>" after Enter) would print a bullet with no text;
  // like trailing empty paragraphs, it is dropped. An empty bullet between two others stays: it was typed there.
  while (blocks.length > 1 && blocks[blocks.length - 1].kind === 'bullet' && blocks[blocks.length - 1].runs.length === 0) blocks.pop();
  return normalizeRichText({ v: 1, blocks: blocks.length > 0 ? blocks : [{ kind: 'paragraph', runs: [] }] });
}

/**
 * Whether the <br> draws no line: nothing with text or another line break follows it before the end of its block,
 * or a block element follows it directly (Chrome leaves "a<br><ul>..." when a list item is turned back into text).
 */
function endsBlock(br: HTMLElement): boolean {
  let node: Node | null = br;
  while (node) {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      if (next.nodeType === 1 && BLOCK_TAGS.has((next as HTMLElement).tagName)) return true;
      if (next.nodeType === 1 && (next as HTMLElement).tagName === 'BR') return false;
      if ((next.textContent ?? '') !== '') return false;
      if (next.nodeType === 1 && (next as HTMLElement).querySelector('br')) return false;
    }
    const parent: HTMLElement | null = node.parentElement;
    if (!parent || BLOCK_TAGS.has(parent.tagName)) return true;
    node = parent;
  }
  return true;
}
