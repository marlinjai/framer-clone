// src/server/books/__tests__/templateGate.test.ts
//
// The template document version 2 and its save gate (visual template
// composer plan, decisions 3, 5, 7, 8): the presets parse and pass the whole
// gate (the probe set against every preset), and every hand-made invalid
// document is refused with the block, item or column named.

import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../render/engine';
import { fontMeasure, templateProblems, assertTemplateSavable } from '../template/gate';
import { PRESETS, preset } from '../template/presets';
import { PROBE_NAMES } from '../template/probes';
import { structuralProblems, type ProblemCode } from '../template/rules';
import { parseTemplateDocument, templateDocumentV2Schema, type Block, type TemplateDocumentV2 } from '../template/schema';
import { isBooksError } from '../errors';
import { templateSnapshotSchema } from '../snapshots';

const codes = async (doc: TemplateDocumentV2): Promise<ProblemCode[]> => structuralProblems(doc, await fontMeasure('dejavu-sans')).map((p) => p.code);
const without = (doc: TemplateDocumentV2, type: Block['type']): TemplateDocumentV2 => {
  const strip = (blocks: Block[]) => blocks.filter((b) => b.type !== type);
  return {
    ...doc,
    regions: {
      firstPageHeader: strip(doc.regions.firstPageHeader),
      addressZone: { left: strip(doc.regions.addressZone.left), right: strip(doc.regions.addressZone.right) },
      body: strip(doc.regions.body),
      followingPageHeader: strip(doc.regions.followingPageHeader),
      footer: strip(doc.regions.footer),
    },
  };
};

describe('template document version 2', () => {
  it.each(PRESETS)('the %s preset is a valid document as written', (name) => {
    const doc = preset(name);
    expect(templateDocumentV2Schema.parse(doc)).toEqual(doc);
  });

  it('refuses unknown keys, unknown blocks and values off the scales', () => {
    const doc = preset('klassisch') as unknown as Record<string, unknown>;
    expect(() => parseTemplateDocument({ ...doc, extra: 1 })).toThrow();
    const bad = structuredClone(preset('klassisch')) as unknown as { regions: { body: unknown[] } };
    bad.regions.body.push({ id: 'x', type: 'image', style: {} });
    expect(() => parseTemplateDocument(bad)).toThrow();
    const size = structuredClone(preset('klassisch'));
    (size.regions.body[0].style as { sizePt: number }).sizePt = 13;
    expect(() => parseTemplateDocument(size)).toThrow();
    const font = structuredClone(preset('klassisch')) as unknown as { theme: { fontFamily: string } };
    font.theme.fontFamily = 'comic-sans';
    expect(() => parseTemplateDocument(font)).toThrow();
  });

  it('bounds the work one document can ask for', () => {
    const doc = structuredClone(preset('klassisch'));
    doc.regions.body = Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, type: 'spacer' as const, style: {}, heightPt: 2 }));
    expect(() => parseTemplateDocument(doc)).toThrow();
    const text = structuredClone(preset('klassisch'));
    text.regions.footer = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, type: 'freeText' as const, style: {}, heading: null, text: 'x'.repeat(2000), variant: 'normal' as const }));
    expect(() => parseTemplateDocument(text)).toThrow(/at most 20000/);
  });
});

describe('stored template documents', () => {
  it('are read with the shape check only, so a later, stricter schema never makes an issued invoice unreadable', () => {
    const stored = structuredClone(preset('klassisch')) as unknown as { regions: { body: unknown[] }; theme: { fontFamily: string } };
    // Beyond today's bounds: 31 blocks in the body and a font the live schema does not know.
    stored.regions.body.push(...Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, type: 'spacer', style: {}, heightPt: 2 })));
    stored.theme.fontFamily = 'some-retired-font';
    expect(() => parseTemplateDocument(stored)).toThrow();
    const snapshot = { v: 2, templateId: 't', templateVersionId: 'v', name: 'Alt', document: stored, logo: null };
    expect(templateSnapshotSchema.parse(snapshot).v).toBe(2);
    expect(() => templateSnapshotSchema.parse({ ...snapshot, document: { v: 1 } })).toThrow();
  });
});

describe('the save gate', () => {
  it.each(PRESETS)('passes the %s preset against every probe document', async (name) => {
    expect(await templateProblems(preset(name))).toEqual([]);
    expect(PROBE_NAMES).toHaveLength(7);
  });

  it.each(['recipient', 'documentMeta', 'title', 'lineTable', 'totals', 'taxNote', 'senderColumns'] as const)(
    'names a missing %s block',
    async (type) => {
      const problems = structuralProblems(without(preset('klassisch'), type), await fontMeasure('dejavu-sans'));
      expect(problems).toContainEqual(expect.objectContaining({ code: 'REQUIRED_BLOCK_MISSING', field: type }));
    },
  );

  it.each(['number', 'issueDate', 'serviceDate', 'recipientVatId'] as const)('names a hidden %s in the document data', async (item) => {
    const doc = structuredClone(preset('klassisch'));
    const meta = doc.regions.addressZone.right[0] as Extract<Block, { type: 'documentMeta' }>;
    meta.items = meta.items.filter((i) => i !== item);
    expect(structuralProblems(doc, await fontMeasure('dejavu-sans'))).toContainEqual(
      expect.objectContaining({ code: 'LEGAL_ITEM_MISSING', field: item, blockId: 'documentMeta' }),
    );
  });

  it.each(['title', 'quantity', 'unit', 'amount'] as const)('names a hidden %s column', async (col) => {
    const doc = structuredClone(preset('klassisch'));
    const table = doc.regions.body.find((b) => b.type === 'lineTable') as Extract<Block, { type: 'lineTable' }>;
    table.columns[col].visible = false;
    expect(structuralProblems(doc, await fontMeasure('dejavu-sans'))).toContainEqual(expect.objectContaining({ code: 'LEGAL_COLUMN_HIDDEN', field: col }));
  });

  it('lets the position and unit price columns be hidden', async () => {
    const doc = structuredClone(preset('klassisch'));
    const table = doc.regions.body.find((b) => b.type === 'lineTable') as Extract<Block, { type: 'lineTable' }>;
    table.columns.pos.visible = false;
    table.columns.unitPrice.visible = false;
    expect(await templateProblems(doc)).toEqual([]);
  });

  it.each(['identity', 'legal'] as const)('names a sender footer without its %s column', async (col) => {
    const doc = structuredClone(preset('klassisch'));
    const footer = doc.regions.footer.find((b) => b.type === 'senderColumns') as Extract<Block, { type: 'senderColumns' }>;
    footer.columns = footer.columns.filter((c) => c !== col);
    expect(structuralProblems(doc, await fontMeasure('dejavu-sans'))).toContainEqual(expect.objectContaining({ code: 'SENDER_COLUMN_MISSING', field: col }));
  });

  it('keeps the recipient in the address field and the legal blocks in their regions', async () => {
    const doc = structuredClone(preset('klassisch'));
    const recipient = doc.regions.addressZone.left.pop()!;
    doc.regions.body.unshift(recipient);
    const problems = structuralProblems(doc, await fontMeasure('dejavu-sans'));
    expect(problems).toContainEqual(expect.objectContaining({ code: 'BLOCK_NOT_ALLOWED_HERE', blockId: 'recipient', region: 'body' }));
    expect(problems).toContainEqual(expect.objectContaining({ code: 'REQUIRED_BLOCK_MISSING', field: 'recipient' }));

    const cell = structuredClone(preset('klassisch'));
    cell.regions.footer.push({
      id: 'row',
      type: 'columns',
      style: {},
      cells: [
        { width: 6, blocks: [{ id: 'pay', type: 'paymentDetails', style: {}, heading: null }] },
        { width: 6, blocks: [] },
      ],
    });
    expect(await codes(cell)).toContain('BLOCK_NOT_ALLOWED_HERE');
  });

  it('refuses duplicates', async () => {
    const doc = structuredClone(preset('klassisch'));
    doc.regions.body.push({ id: 'totals2', type: 'totals', style: {} });
    doc.regions.body.push({ id: 'title', type: 'spacer', style: {}, heightPt: 2 });
    const c = await codes(doc);
    expect(c).toContain('BLOCK_DUPLICATED');
    expect(c).toContain('DUPLICATE_BLOCK_ID');
  });

  it('refuses legal text below 7 pt and the footer below 6.5 pt', async () => {
    const doc = structuredClone(preset('klassisch'));
    const totals = doc.regions.body.find((b) => b.type === 'totals')!;
    totals.style.sizePt = 6.5;
    const problems = structuralProblems(doc, await fontMeasure('dejavu-sans'));
    expect(problems).toContainEqual(expect.objectContaining({ code: 'SIZE_TOO_SMALL', blockId: 'totals' }));
    expect(problems.filter((p) => p.code === 'SIZE_TOO_SMALL')).toHaveLength(1);
  });

  it('refuses colours below 4.5:1 on white, and a header band that drowns its text', async () => {
    const doc = structuredClone(preset('klassisch'));
    doc.theme.muted = '#aaaaaa';
    expect(structuralProblems(doc, await fontMeasure('dejavu-sans'))).toContainEqual(expect.objectContaining({ code: 'CONTRAST_TOO_LOW', field: 'theme.muted' }));

    // #767676 is 4.54:1 on white, but under 4.5:1 on the accent tint behind Modern's table header.
    const band = structuredClone(preset('modern'));
    band.theme.ink = '#767676';
    const problems = structuralProblems(band, await fontMeasure('dejavu-sans'));
    expect(problems.filter((p) => p.field === 'theme.ink')).toEqual([]);
    expect(problems).toContainEqual(expect.objectContaining({ code: 'CONTRAST_TOO_LOW', field: 'headerBand', blockId: 'lineTable' }));
  });

  it('refuses an amount column too narrow for the largest amount, and a starved description column', async () => {
    const doc = structuredClone(preset('klassisch'));
    const table = doc.regions.body.find((b) => b.type === 'lineTable') as Extract<Block, { type: 'lineTable' }>;
    table.columns.amount.width = 10;
    expect(structuralProblems(doc, await fontMeasure('dejavu-sans'))).toContainEqual(expect.objectContaining({ code: 'COLUMN_TOO_NARROW', field: 'amount' }));
    table.columns.amount.width = 0;
    table.columns.unit.width = 40;
    expect(structuralProblems(doc, await fontMeasure('dejavu-sans'))).toContainEqual(expect.objectContaining({ code: 'TITLE_COLUMN_TOO_NARROW' }));
  });

  it('keeps the tax note directly after the totals and the return line above the address', async () => {
    const doc = structuredClone(preset('klassisch'));
    const at = doc.regions.body.findIndex((b) => b.type === 'taxNote');
    const [note] = doc.regions.body.splice(at, 1);
    doc.regions.body.push(note);
    expect(await codes(doc)).toContain('TAX_NOTE_NOT_AFTER_TOTALS');

    const order = structuredClone(preset('klassisch'));
    order.regions.addressZone.left.reverse();
    expect(await codes(order)).toContain('ADDRESS_ORDER');

    const pushed = structuredClone(preset('klassisch'));
    pushed.regions.addressZone.left.unshift({ id: 'gap', type: 'spacer', style: {}, heightPt: 32 });
    expect(structuralProblems(pushed, await fontMeasure('dejavu-sans'))).toContainEqual(
      expect.objectContaining({ code: 'BLOCK_NOT_ALLOWED_HERE', blockId: 'gap', region: 'addressZone.left' }),
    );
  });

  it('refuses a return line so large it pushes the address out of the window, and an overlong right column', async () => {
    const big = structuredClone(preset('klassisch'));
    big.regions.addressZone.left[0].style = { sizePt: 20, spaceBelowPt: 32 };
    expect(await templateProblems(big)).toContainEqual(expect.objectContaining({ code: 'LAYOUT_PROBLEM', field: 'ADDRESS_FIELD_OVERFLOW' }));

    const tall = structuredClone(preset('klassisch'));
    tall.regions.addressZone.right.push({ id: 'long', type: 'freeText', style: {}, heading: null, text: 'Lange Erläuterung. '.repeat(105).trim(), variant: 'normal' });
    expect(await templateProblems(tall)).toContainEqual(expect.objectContaining({ code: 'LAYOUT_PROBLEM', field: 'ADDRESS_ZONE_TOO_TALL' }));
  });

  it('refuses a payment code wider than its cell', async () => {
    const doc = structuredClone(preset('klassisch'));
    doc.regions.body.push({
      id: 'row',
      type: 'columns',
      style: {},
      cells: [
        { width: 11, blocks: [{ id: 'note', type: 'freeText', style: {}, heading: null, text: 'Links', variant: 'normal' }] },
        { width: 1, blocks: [{ id: 'qr', type: 'paymentQr', style: {}, caption: 'Bitte scannen.', sizeMm: 40 }] },
      ],
    });
    expect(await templateProblems(doc)).toContainEqual(expect.objectContaining({ code: 'LAYOUT_PROBLEM', field: 'BLOCK_TOO_WIDE', blockId: 'qr' }));
  });

  it('refuses totals before the line table and a columns row wider than 12', async () => {
    const doc = structuredClone(preset('klassisch'));
    const t = doc.regions.body.findIndex((b) => b.type === 'totals');
    const [totals] = doc.regions.body.splice(t, 1);
    doc.regions.body.unshift(totals);
    doc.regions.body.push({
      id: 'row',
      type: 'columns',
      style: {},
      cells: [
        { width: 8, blocks: [] },
        { width: 8, blocks: [] },
      ],
    });
    const c = await codes(doc);
    expect(c).toContain('TOTALS_BEFORE_TABLE');
    expect(c).toContain('CELLS_TOO_WIDE');
  });

  it('refuses template text the font cannot draw', async () => {
    const doc = structuredClone(preset('klassisch'));
    doc.regions.body.push({ id: 'note', type: 'freeText', style: {}, heading: null, text: 'Danke 谢谢', variant: 'normal' });
    expect(await templateProblems(doc)).toContainEqual(expect.objectContaining({ code: 'UNDRAWABLE_TEXT', blockId: 'note', field: 'text' }));
  });

  it('refuses a layout that does not fit the page', async () => {
    const header = structuredClone(preset('klassisch'));
    header.regions.firstPageHeader = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, type: 'spacer' as const, style: {}, heightPt: 32 as const }));
    expect(await templateProblems(header)).toContainEqual(expect.objectContaining({ code: 'LAYOUT_PROBLEM', field: 'HEADER_TOO_TALL' }));

    const footer = structuredClone(preset('klassisch'));
    footer.regions.footer.push(...Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, type: 'spacer' as const, style: {}, heightPt: 32 as const })));
    expect(await templateProblems(footer)).toContainEqual(expect.objectContaining({ code: 'LAYOUT_PROBLEM', field: 'FOOTER_TOO_TALL' }));

    const tall = structuredClone(preset('klassisch'));
    const long = 'Ausführlicher Hinweis zu den Bedingungen. '.repeat(45).trim();
    tall.regions.body.push({
      id: 'row',
      type: 'columns',
      style: {},
      cells: [
        { width: 4, blocks: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, type: 'freeText' as const, style: {}, heading: null, text: long, variant: 'normal' as const })) },
        { width: 8, blocks: [] },
      ],
    });
    expect(await templateProblems(tall)).toContainEqual(expect.objectContaining({ code: 'LAYOUT_PROBLEM', field: 'BLOCK_TOO_TALL', blockId: 'row' }));
    // Three full template renders (one is a multi-page block): well over the 5s default on a loaded CI runner.
  }, 30_000);

  it('names the probe and the field a template would lose', async () => {
    // A broken engine that drops the footer: the sender's tax ids go missing on every probe.
    const broken: typeof renderTemplate = (model, doc, fonts, opts) =>
      renderTemplate(model, { ...doc, regions: { ...doc.regions, footer: [] } }, fonts, opts);
    const problems = await templateProblems(preset('klassisch'), { render: broken });
    expect(problems).toContainEqual(expect.objectContaining({ code: 'PROBE_INCOMPLETE', probe: 'regular', field: 'sender.taxNumber' }));
    expect(problems).toContainEqual(expect.objectContaining({ code: 'PROBE_INCOMPLETE', probe: 'smallBusiness', field: 'sender.smallBusinessId' }));
  });

  it('refuses with TEMPLATE_INVALID carrying the problems', async () => {
    const err = await assertTemplateSavable(without(preset('klassisch'), 'totals'), new Map()).catch((e: unknown) => e);
    expect(isBooksError(err, 'TEMPLATE_INVALID')).toBe(true);
    expect((err as { details: { problems: unknown[] } }).details.problems).toContainEqual(expect.objectContaining({ field: 'totals' }));
  });
});
