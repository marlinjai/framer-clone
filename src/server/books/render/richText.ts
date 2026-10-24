// src/server/books/render/richText.ts
//
// The formatted intro and closing texts of a document (WYSIWYG invoice editor
// plan, decided by the owner, item 2): paragraphs and bullet items made of
// runs that are bold, italic, both or neither. A small run model, never
// markup: the document keeps its plain text in `intro_text` / `outro_text`,
// derived from the runs by the server (`plainOf`), so the legal checks, the
// search and the check for characters a font cannot print read words, never
// formatting. Browser-safe (zod only): the engine, the field mapping and the
// page editor share it.

import { z } from 'zod';

export interface TextRun {
  text: string;
  bold?: true;
  italic?: true;
}

export interface TextBlock {
  kind: 'paragraph' | 'bullet';
  /** Empty runs make an empty paragraph (a blank line between two others). */
  runs: TextRun[];
}

/** Version 1 of the shape; a later shape gets `v: 2` and its own reader. */
export interface RichText {
  v: 1;
  blocks: TextBlock[];
}

/** The longest plain text a formatted text may have (the plain columns' bound). */
export const RICH_TEXT_MAX_PLAIN = 4000;

const runSchema = z
  .object({
    // One line of text: a line break is a new block, never a character inside a run.
    text: z
      .string()
      .min(1)
      .max(RICH_TEXT_MAX_PLAIN)
      .refine((t) => !/[\r\n]/.test(t), 'a run is one line'),
    bold: z.literal(true).optional(),
    italic: z.literal(true).optional(),
  })
  .strict();

export const richTextSchema = z
  .object({
    v: z.literal(1),
    blocks: z
      .array(z.object({ kind: z.enum(['paragraph', 'bullet']), runs: z.array(runSchema).max(200) }).strict())
      .min(1)
      .max(200),
  })
  .strict()
  .refine((rt) => plainOf(rt as RichText).length <= RICH_TEXT_MAX_PLAIN, `at most ${RICH_TEXT_MAX_PLAIN} characters`);

/** The plain text of a formatted text: each block one line, its runs' text joined. */
export function plainOf(rt: RichText): string {
  return rt.blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n');
}

/**
 * The same text in its one canonical form: adjacent runs of the same style merged, empty runs dropped, trailing
 * empty paragraphs removed. Two texts that print the same are equal after this, so "unchanged" is a comparison.
 */
export function normalizeRichText(rt: RichText): RichText {
  const blocks = rt.blocks.map((b) => {
    const runs: TextRun[] = [];
    for (const r of b.runs) {
      if (r.text === '') continue;
      const run: TextRun = { text: r.text, ...(r.bold ? { bold: true as const } : {}), ...(r.italic ? { italic: true as const } : {}) };
      const prev = runs[runs.length - 1];
      if (prev && Boolean(prev.bold) === Boolean(run.bold) && Boolean(prev.italic) === Boolean(run.italic)) prev.text += run.text;
      else runs.push(run);
    }
    return { kind: b.kind, runs };
  });
  while (blocks.length > 1 && blocks[blocks.length - 1].runs.length === 0 && blocks[blocks.length - 1].kind === 'paragraph') blocks.pop();
  return { v: 1, blocks };
}

/** A plain text as paragraphs, one per line. */
export function richFromPlain(text: string): RichText {
  return { v: 1, blocks: text.split(/\r?\n/).map((line) => ({ kind: 'paragraph' as const, runs: line === '' ? [] : [{ text: line }] })) };
}

/**
 * Whether a formatted text needs its format to print as written: any bold or italic run, any bullet, or more than
 * one line. A single unformatted line prints the same from its plain text, so its format is not stored.
 */
export function needsFormat(rt: RichText): boolean {
  return rt.blocks.length > 1 || rt.blocks.some((b) => b.kind === 'bullet' || b.runs.some((r) => r.bold || r.italic));
}

/** Whether a formatted text has formatting beyond its line breaks: a bold or italic run, or a bullet item. */
export function isStyled(rt: RichText | null | undefined): boolean {
  return Boolean(rt?.blocks.some((b) => b.kind === 'bullet' || b.runs.some((r) => r.bold || r.italic)));
}

/** Whether any run is italic (the italic faces are embedded only then). */
export function hasItalic(rt: RichText | null | undefined): boolean {
  return Boolean(rt?.blocks.some((b) => b.runs.some((r) => r.italic)));
}
