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

function runHtml(r: TextRun): string {
  let html = esc(r.text);
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
    const inner = block.runs.length === 0 ? '<br>' : block.runs.map(runHtml).join('');
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
  const bold = inherited.bold || tag === 'B' || tag === 'STRONG' || weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  const italic = inherited.italic || tag === 'I' || tag === 'EM' || el.style?.fontStyle === 'italic' || el.style?.fontStyle === 'oblique';
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
        if (i > 0) open(kind);
        if (text !== '') ensure(kind).runs.push({ text, ...(style.bold ? { bold: true as const } : {}), ...(style.italic ? { italic: true as const } : {}) });
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.tagName === 'BR') {
      // A line break inside a block: the next line is a block of its own, of the same kind. A <br> that ends its
      // block draws no line (the browser keeps it there to hold an empty line open), so it starts nothing.
      if (!endsBlock(el)) open(kind);
      else ensure(kind);
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
  return normalizeRichText({ v: 1, blocks: blocks.length > 0 ? blocks : [{ kind: 'paragraph', runs: [] }] });
}

/** Whether nothing with text or another line break follows a <br> before the end of its block. */
function endsBlock(br: HTMLElement): boolean {
  let node: Node | null = br;
  while (node) {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
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
