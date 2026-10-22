// src/server/books/__tests__/legacyV1.test.ts
//
// The frozen version 1 renderer (render/legacyV1.ts) must keep producing the
// bytes it produced when the layout engine arrived (visual template composer
// plan, decision 4): a document with a version 1 template snapshot re-renders
// to its stored bytes. Golden SHA-256 values recorded on 2026-10-22 from the
// renderer as it stood on main; a change to them is a regression, never an update.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderLegacyV1 } from '../render/legacyV1';
import { buildRenderModel } from '../render/model';
import { issuedInput, regularInvoice, smallBusinessInvoice } from './renderFixtures';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const GOLDEN = {
  smallBusiness: 'c4cf51b54e9a8bb7d07623fd556e83e8c1c393331efbff3ce811f15288f00e59',
  regular: 'c9ff42dbc785b2470c8168f1ea4456bf05547612f352ba8fc70bcbbc35467b70',
  withTemplate: '9ef55700e9a440a12d932a31cabd592c18ef4666a536849c686aeb0f2030e178',
};

describe('legacy version 1 renderer', () => {
  it('reproduces its recorded bytes', async () => {
    const withTemplate = smallBusinessInvoice();
    withTemplate.document.templateSnapshot = {
      v: 1,
      templateId: 't1',
      name: 'Standard',
      accentColor: '#2b4c7e',
      footerBlocks: [{ heading: 'Hinweis', text: 'Synthetic small print.' }],
    };
    const got = {
      smallBusiness: sha(await renderLegacyV1(buildRenderModel(issuedInput(smallBusinessInvoice())))),
      regular: sha(await renderLegacyV1(buildRenderModel(issuedInput(regularInvoice())))),
      withTemplate: sha(await renderLegacyV1(buildRenderModel(issuedInput(withTemplate)))),
    };
    expect(got).toEqual(GOLDEN);
  });
});
