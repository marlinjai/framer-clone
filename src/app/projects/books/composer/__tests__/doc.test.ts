// src/app/projects/books/composer/__tests__/doc.test.ts
//
// The composer's document operations against the presets and the save gate's
// own rules: a block is only ever added or moved where the gate allows it,
// required blocks are never removed, single blocks are not added twice, ids
// stay unique, and every operation keeps the document valid under the schema.

import { produce } from 'immer';
import { describe, expect, it } from 'vitest';

import { preset } from '@/server/books/template/presets';
import { templateDocumentV2Schema } from '@/server/books/template/schema';

import {
  addBlock,
  addCellBlock,
  blockIds,
  canAdd,
  hasType,
  locate,
  moveBlock,
  moveByStep,
  moveRefusal,
  regionList,
  removeBlock,
  uniqueId,
  type TemplateDocumentV2,
} from '../doc';

const klassisch = () => preset('klassisch');
const change = (doc: TemplateDocumentV2, recipe: (d: TemplateDocumentV2) => void) => produce(doc, recipe);
const ids = (doc: TemplateDocumentV2, region: Parameters<typeof regionList>[1]) => regionList(doc, region).map((b) => b.id);

describe('composer document operations', () => {
  it('adds a block where the gate allows it, with a fresh id and a valid shape', () => {
    let added: string | null = null;
    const doc = change(klassisch(), (d) => {
      added = addBlock(d, 'freeText', 'body', 2);
    });
    expect(added).toBe('freeText');
    expect(ids(doc, 'body')[2]).toBe('freeText');
    expect(templateDocumentV2Schema.safeParse(doc).success).toBe(true);

    const again = change(doc, (d) => void addBlock(d, 'freeText', 'footer'));
    expect(ids(again, 'footer')).toContain('freeText2');
  });

  it('refuses a block in a region it may not stand in, and a single block twice', () => {
    const doc = klassisch();
    expect(canAdd(doc, 'lineTable', 'footer')).toEqual({ ok: false, reason: 'Not allowed in the footer (every page).' });
    expect(canAdd(doc, 'totals', 'body')).toEqual({ ok: false, reason: 'Already in the template.' });
    expect(canAdd(doc, 'paymentQr', 'body')).toEqual({ ok: true });
    const same = change(doc, (d) => void addBlock(d, 'totals', 'body'));
    expect(same).toBe(doc);
  });

  it('every new block of every type the body allows passes the schema', () => {
    for (const type of ['freeText', 'logo', 'divider', 'spacer', 'columns', 'paymentQr'] as const) {
      const region = type === 'logo' ? 'firstPageHeader' : 'body';
      const doc = change(klassisch(), (d) => void addBlock(d, type, region));
      expect(hasType(doc, type)).toBe(true);
      expect(templateDocumentV2Schema.safeParse(doc).success).toBe(true);
    }
  });

  it('never removes a required block; removes an optional one', () => {
    const doc = klassisch();
    const kept = change(doc, (d) => { expect(removeBlock(d, 'totals')).toBe(false); });
    expect(kept).toBe(doc);
    const removed = change(doc, (d) => void removeBlock(d, 'paymentDetails'));
    expect(locate(removed, 'paymentDetails')).toBeNull();
  });

  it('moves a block inside its region and into another region that allows it, never into one that does not', () => {
    const doc = klassisch();
    const moved = change(doc, (d) => void moveBlock(d, 'outroText', 'body', 0));
    expect(ids(moved, 'body')[0]).toBe('outroText');
    const intoFooter = change(doc, (d) => void moveBlock(d, 'footerRule', 'body', 1));
    expect(ids(intoFooter, 'body')[1]).toBe('footerRule');
    expect(ids(intoFooter, 'footer')).not.toContain('footerRule');
    const refused = change(doc, (d) => { expect(moveBlock(d, 'lineTable', 'footer', 0)).toBe(false); });
    expect(refused).toBe(doc);
  });

  it('a columns row moves only where every block in its cells may stand', () => {
    let row: string | null = null;
    const doc = change(klassisch(), (d) => {
      row = addBlock(d, 'columns', 'firstPageHeader');
      addCellBlock(d, row!, 0, 'logo');
    });
    // A logo may not stand in the body, so neither may the row holding it.
    expect(change(doc, (d) => { expect(moveBlock(d, row!, 'body', 0)).toBe(false); })).toBe(doc);
    // And no logo goes into a body row's cell.
    const body = change(klassisch(), (d) => {
      const r = addBlock(d, 'columns', 'body')!;
      expect(addCellBlock(d, r, 0, 'logo')).toBeNull();
      expect(addCellBlock(d, r, 0, 'freeText')).toBe('freeText');
    });
    expect(templateDocumentV2Schema.safeParse(body).success).toBe(true);
  });

  it('moves a block one step, across a region edge to the nearest region that allows it', () => {
    const doc = klassisch();
    const up = change(doc, (d) => void moveByStep(d, 'subject', -1));
    expect(ids(up, 'body').slice(0, 3)).toEqual(['subject', 'title', 'introText']);
    // The divider at the top of the footer moves up into the following-page header (it may stand there).
    const across = change(doc, (d) => void moveByStep(d, 'footerRule', -1));
    expect(ids(across, 'followingPageHeader')).toEqual(['continuation', 'footerRule']);
    // The recipient may stand only in the address field: at its edge it stays.
    const stuck = change(doc, (d) => { expect(moveByStep(d, 'recipient', 1)).toBe(false); });
    expect(stuck).toBe(doc);
  });

  it('keeps ids unique, cells included', () => {
    const doc = change(klassisch(), (d) => {
      const row = addBlock(d, 'columns', 'body')!;
      addCellBlock(d, row, 0, 'freeText');
      addCellBlock(d, row, 1, 'freeText');
    });
    const all = [...blockIds(doc)];
    expect(new Set(all).size).toBe(all.length);
    expect(uniqueId(doc, 'freeText')).toBe('freeText3');
  });

  it('keeps one title per region and the required body title in the body', () => {
    const doc = klassisch();
    expect(canAdd(doc, 'title', 'body')).toEqual({ ok: false, reason: 'This region has its title already.' });
    expect(canAdd(doc, 'title', 'followingPageHeader')).toEqual({ ok: false, reason: 'This region has its title already.' });
    expect(moveRefusal(doc, 'title', 'followingPageHeader')).toBe('Title is required in the body and stays there.');
    // Alt+Down on the body's last block never carries a required block out of its region.
    const lastTitle = change(doc, (d) => void moveBlock(d, 'title', 'body', 99));
    expect(ids(lastTitle, 'body').at(-1)).toBe('title');
    expect(change(lastTitle, (d) => { expect(moveByStep(d, 'title', 1)).toBe(false); })).toBe(lastTitle);
    // Without a continuation title, a new title may go into the page 2 header, never a second into the body.
    const noContinuation = change(doc, (d) => void removeBlock(d, 'continuation'));
    expect(canAdd(noContinuation, 'title', 'followingPageHeader')).toEqual({ ok: true });
  });

  it('a move that changes nothing leaves the document untouched (no undo step, no preview request)', () => {
    const doc = klassisch();
    expect(change(doc, (d) => { expect(moveBlock(d, 'introText', 'body', 2)).toBe(false); })).toBe(doc);
    expect(change(doc, (d) => { expect(moveBlock(d, 'outroText', 'body', 99)).toBe(false); })).toBe(doc);
  });
});
