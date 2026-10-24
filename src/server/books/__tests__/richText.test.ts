// src/server/books/__tests__/richText.test.ts
//
// The run model of the formatted intro and closing texts: the plain text is
// derived one way and deterministically, the canonical form makes "unchanged"
// a comparison, and the schema refuses what the engine could not print as one
// line per run.

import { describe, expect, it } from 'vitest';

import { hasItalic, needsFormat, normalizeRichText, plainOf, richFromPlain, richTextSchema, type RichText } from '../render/richText';

const sample: RichText = {
  v: 1,
  blocks: [
    { kind: 'paragraph', runs: [{ text: 'Vielen Dank für ' }, { text: 'Ihren', bold: true }, { text: ' Auftrag.' }] },
    { kind: 'paragraph', runs: [] },
    { kind: 'bullet', runs: [{ text: 'Konzeption', italic: true }] },
    { kind: 'bullet', runs: [{ text: 'Umsetzung', bold: true, italic: true }] },
  ],
};

describe('the plain text of a formatted text', () => {
  it('joins the runs of a block and the blocks by line breaks, nothing else', () => {
    expect(plainOf(sample)).toBe('Vielen Dank für Ihren Auftrag.\n\nKonzeption\nUmsetzung');
    expect(plainOf(sample)).toBe(plainOf(structuredClone(sample)));
  });

  it('round-trips a plain text with its line breaks', () => {
    const text = 'Erster Absatz.\n\nZweiter Absatz.';
    expect(plainOf(richFromPlain(text))).toBe(text);
  });
});

describe('the canonical form', () => {
  it('merges runs of the same style, drops empty runs and trailing empty paragraphs', () => {
    const messy: RichText = {
      v: 1,
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'Ein' }, { text: '' }, { text: 'mal', bold: undefined as never }, { text: '!', bold: true }, { text: '!', bold: true }] },
        { kind: 'paragraph', runs: [] },
        { kind: 'paragraph', runs: [{ text: '' }] },
      ],
    };
    expect(normalizeRichText(messy)).toEqual({ v: 1, blocks: [{ kind: 'paragraph', runs: [{ text: 'Einmal' }, { text: '!!', bold: true }] }] });
    expect(normalizeRichText(normalizeRichText(sample))).toEqual(normalizeRichText(sample));
  });
});

describe('when a format is stored', () => {
  it('only when the text would not print the same from its plain words', () => {
    expect(needsFormat(richFromPlain('Eine Zeile.'))).toBe(false);
    expect(needsFormat(richFromPlain('Zwei\nZeilen'))).toBe(true);
    expect(needsFormat({ v: 1, blocks: [{ kind: 'paragraph', runs: [{ text: 'fett', bold: true }] }] })).toBe(true);
    expect(needsFormat({ v: 1, blocks: [{ kind: 'bullet', runs: [{ text: 'Punkt' }] }] })).toBe(true);
    expect(hasItalic(sample)).toBe(true);
    expect(hasItalic(richFromPlain('Nichts kursiv'))).toBe(false);
    expect(hasItalic(null)).toBe(false);
  });
});

describe('the schema', () => {
  it('accepts the sample and refuses a line break inside a run, an unknown style or kind, and too much text', () => {
    expect(richTextSchema.safeParse(sample).success).toBe(true);
    const run = (r: object) => ({ v: 1, blocks: [{ kind: 'paragraph', runs: [r] }] });
    expect(richTextSchema.safeParse(run({ text: 'a\nb' })).success).toBe(false);
    expect(richTextSchema.safeParse(run({ text: 'a', underline: true })).success).toBe(false);
    expect(richTextSchema.safeParse(run({ text: 'a', bold: false })).success).toBe(false);
    expect(richTextSchema.safeParse({ v: 1, blocks: [{ kind: 'heading', runs: [] }] }).success).toBe(false);
    expect(richTextSchema.safeParse({ v: 2, blocks: [] }).success).toBe(false);
    expect(richTextSchema.safeParse(run({ text: 'x'.repeat(4001) })).success).toBe(false);
    const many = { v: 1, blocks: Array.from({ length: 100 }, () => ({ kind: 'paragraph', runs: [{ text: 'x'.repeat(41) }] })) };
    expect(richTextSchema.safeParse(many).success).toBe(false);
  });
});
