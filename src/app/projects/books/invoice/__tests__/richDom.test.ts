// src/app/projects/books/invoice/__tests__/richDom.test.ts
//
// The formatting editor's two conversions: runs to editable HTML and back
// without loss, and every shape Chrome's editing and a paste can leave in the
// editor read as the runs it shows.

import { describe, expect, it } from 'vitest';

import { normalizeRichText, type RichText } from '@/server/books/render/richText';

import { richFromDom, richToHtml } from '../richDom';

const dom = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
};
const read = (html: string) => richFromDom(dom(html));
const para = (...runs: RichText['blocks'][number]['runs']) => ({ kind: 'paragraph' as const, runs });
const item = (...runs: RichText['blocks'][number]['runs']) => ({ kind: 'bullet' as const, runs });

const sample: RichText = {
  v: 1,
  blocks: [
    para({ text: 'Vielen ' }, { text: 'Dank', bold: true }, { text: ' für & <Ihren> ' }, { text: 'Auftrag', italic: true }, { text: '.' }),
    para(),
    item({ text: 'Konzeption und ' }, { text: 'Umsetzung', bold: true, italic: true }),
    item({ text: 'Abnahme' }),
    para({ text: 'Danke.' }),
  ],
};

describe('runs to HTML and back', () => {
  it('round-trips every style, a blank line, a list and characters HTML escapes', () => {
    expect(richFromDom(dom(richToHtml(sample)))).toEqual(normalizeRichText(sample));
    expect(richToHtml(sample)).toBe(
      '<p>Vielen <strong>Dank</strong> für &amp; &lt;Ihren&gt; <em>Auftrag</em>.</p><p><br></p><ul><li>Konzeption und <strong><em>Umsetzung</em></strong></li><li>Abnahme</li></ul><p>Danke.</p>',
    );
  });

  it('gives an empty text one empty line to type into, and reads an empty editor as that line', () => {
    expect(richToHtml({ v: 1, blocks: [] })).toBe('<p><br></p>');
    expect(read('')).toEqual({ v: 1, blocks: [para()] });
    expect(read('<p><br></p>')).toEqual({ v: 1, blocks: [para()] });
  });
});

describe('what the browser leaves behind', () => {
  it('reads b, i and styled spans as bold and italic, and unwraps every other element', () => {
    expect(read('<div>ein <b>fett</b> <i>schräg</i> <span style="font-weight: 700">auch</span> <span style="font-style: italic">so</span> <font color="red">rot</font></div>')).toEqual({
      v: 1,
      blocks: [para({ text: 'ein ' }, { text: 'fett', bold: true }, { text: ' ' }, { text: 'schräg', italic: true }, { text: ' ' }, { text: 'auch', bold: true }, { text: ' ' }, { text: 'so', italic: true }, { text: ' rot' })],
    });
    expect(read('<p><b><i>beides</i></b></p>')).toEqual({ v: 1, blocks: [para({ text: 'beides', bold: true, italic: true })] });
  });

  it('turns non-breaking spaces into spaces', () => {
    expect(read('<p>zwei Wörter </p>')).toEqual({ v: 1, blocks: [para({ text: 'zwei Wörter ' })] });
  });

  it('starts a new line at a <br> inside a block, of the same kind, and ignores the <br> that ends a block', () => {
    expect(read('<p>eins<br>zwei<br></p>')).toEqual({ v: 1, blocks: [para({ text: 'eins' }), para({ text: 'zwei' })] });
    expect(read('<ul><li>a<br>b</li></ul>')).toEqual({ v: 1, blocks: [item({ text: 'a' }), item({ text: 'b' })] });
    // Two <br> make an empty line between (Shift+Enter twice).
    expect(read('<p>eins<br><br>zwei</p>')).toEqual({ v: 1, blocks: [para({ text: 'eins' }), para(), para({ text: 'zwei' })] });
    expect(read('<p><b>fett<br></b></p>')).toEqual({ v: 1, blocks: [para({ text: 'fett', bold: true })] });
  });

  it('reads text outside any block, and divs Chrome makes on Enter, as paragraphs', () => {
    expect(read('erste Zeile<div>zweite</div><div><br></div><div>dritte</div>')).toEqual({
      v: 1,
      blocks: [para({ text: 'erste Zeile' }), para({ text: 'zweite' }), para(), para({ text: 'dritte' })],
    });
  });

  it('reads a list Chrome nested in the paragraph it was started from without an empty line', () => {
    expect(read('<p>Leistungen:</p><p><ul><li>Konzeption</li><li>Umsetzung</li></ul></p>')).toEqual({
      v: 1,
      blocks: [para({ text: 'Leistungen:' }), item({ text: 'Konzeption' }), item({ text: 'Umsetzung' })],
    });
    expect(read('<div><ul><li>a</li></ul>danach</div>')).toEqual({ v: 1, blocks: [item({ text: 'a' }), para({ text: 'danach' })] });
  });

  it('reads an ordered list as bullet items, and a heading as a paragraph', () => {
    expect(read('<ol><li>a</li><li>b</li></ol><h2>Titel</h2>')).toEqual({ v: 1, blocks: [item({ text: 'a' }), item({ text: 'b' }), para({ text: 'Titel' })] });
  });
});
