// src/server/books/__tests__/contactPerson.test.ts
//
// The contact person ("z. Hd.") on the printed invoice: the `attention` block of the template engine, the model
// line, the layout field the editor opens, the rules for where the block may stand, and the recipient snapshot
// union (version 1 and 2). Synthetic data only.

import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../render/engine';
import { extractDrawnText } from '../render/extractText';
import { fontFiles } from '../render/fonts';
import { attentionLine, buildRenderModel } from '../render/model';
import { buildCustomerSnapshot, customerSnapshotSchema, customerSnapshotV1Schema, snapshotContactPerson, type RecipientContact } from '../snapshots';
import { preset } from '../template/presets';
import { probe, probeInput } from '../template/probes';
import { ALLOWED_REGIONS, SINGLETONS } from '../template/rules';
import { templateProblems } from '../template/gate';
import type { TemplateDocumentV2 } from '../template/schema';

/** The klassisch preset with the contact person line right under the address. */
function withAttention(): TemplateDocumentV2 {
  const doc = structuredClone(preset('klassisch'));
  const at = doc.regions.addressZone.left.findIndex((b) => b.type === 'recipient');
  doc.regions.addressZone.left.splice(at + 1, 0, { id: 'attention', type: 'attention', style: { spaceBelowPt: 4 } });
  return doc;
}

async function render(doc: TemplateDocumentV2, person: { name: string; role: string } | null, draft = false) {
  const input = probeInput(probe('regular'), draft);
  const model = buildRenderModel({ ...input, recipient: { ...input.recipient!, contactPerson: person } });
  return renderTemplate(model, doc, fontFiles('dejavu-sans'));
}

const texts = async (bytes: Uint8Array) => (await extractDrawnText(bytes)).map((d) => d.text);

describe('the attention line', () => {
  it('prints "z. Hd. Name, Rolle" under the address, and only the name when no role was recorded', async () => {
    const withRole = await render(withAttention(), { name: 'Anna Beispiel', role: 'Einkauf' });
    expect(await texts(withRole.bytes)).toContain('z. Hd. Anna Beispiel, Einkauf');
    const noRole = await render(withAttention(), { name: 'Anna Beispiel', role: '' });
    expect(await texts(noRole.bytes)).toContain('z. Hd. Anna Beispiel');
  });

  it('prints nothing when the invoice has no contact person, and leaves the slot for the editor', async () => {
    const none = await render(withAttention(), null, true);
    expect((await texts(none.bytes)).some((t) => t.startsWith('z. Hd.'))).toBe(false);
    const slot = none.layout.fields.find((f) => f.id === 'recipient.attention');
    expect(slot).toMatchObject({ empty: true, kind: 'select', source: 'document', documentField: 'contactPersonId' });
  });

  it('is off by default: a template without the block never prints it, whoever the person is', async () => {
    const plain = await render(preset('klassisch'), { name: 'Anna Beispiel', role: 'Einkauf' });
    expect((await texts(plain.bytes)).some((t) => t.startsWith('z. Hd.'))).toBe(false);
    expect(plain.layout.fields.some((f) => f.id === 'recipient.attention')).toBe(false);
    for (const name of ['klassisch'] as const) {
      expect(preset(name).regions.addressZone.left.some((b) => b.type === 'attention')).toBe(false);
    }
  });

  it('the printed line is the field the editor opens (a select on the contact person), never typed text', async () => {
    const r = await render(withAttention(), { name: 'Anna Beispiel', role: 'Einkauf' }, true);
    const field = r.layout.fields.find((f) => f.id === 'recipient.attention');
    expect(field).toMatchObject({ empty: false, kind: 'select', documentField: 'contactPersonId' });
    expect(field!.rects.length).toBeGreaterThan(0);
  });

  it('never prints an email address or a phone number: the model line is the name and the role only', () => {
    expect(attentionLine({ name: 'Anna Beispiel', role: 'Einkauf' })).toBe('z. Hd. Anna Beispiel, Einkauf');
    expect(attentionLine({ name: '   ', role: 'Einkauf' })).toBeNull();
    expect(attentionLine(null)).toBeNull();
    expect(Object.keys(probeInput(probe('regular')).recipient!.contactPerson!).sort()).toEqual(['name', 'role']);
  });

  it('stands only in the address zone, once, and the template gate accepts it there and refuses it elsewhere', async () => {
    expect(ALLOWED_REGIONS.attention).toEqual(['addressZone.left']);
    expect(SINGLETONS.has('attention')).toBe(true);
    // Every probe document (with a contact person, with long names) is rendered with it and must stay complete.
    expect(await templateProblems(withAttention())).toEqual([]);
    const twice = withAttention();
    twice.regions.addressZone.left.push({ id: 'attention2', type: 'attention', style: {} });
    expect((await templateProblems(twice)).length).toBeGreaterThan(0);
    const inBody = withAttention();
    inBody.regions.addressZone.left = inBody.regions.addressZone.left.filter((b) => b.type !== 'attention');
    inBody.regions.body.unshift({ id: 'attention', type: 'attention', style: {} });
    expect((await templateProblems(inBody)).length).toBeGreaterThan(0);
  }, 60_000);

  it('a very long name and role wrap inside the address zone and never push the address out', async () => {
    const r = await render(withAttention(), { name: 'Anna-Maria Beispiel-Musterfrau von und zu Hohenlohe', role: 'Leiterin Einkauf, Beschaffung und strategische Lieferantenentwicklung' });
    expect(r.layout.issues).toEqual([]);
  });
});

describe('the recipient snapshot union', () => {
  const contact: RecipientContact = {
    id: '0190a000-0000-7000-8000-0000000000c9',
    kind: 'organization',
    name: 'Sample Customer GmbH',
    companyOrRole: '',
    legalForm: 'GmbH',
    addressLine1: 'Beispielweg 2',
    addressLine2: null,
    postalCode: '20095',
    city: 'Hamburg',
    country: 'DE',
    vatId: null,
    customerNumber: 7,
    archived: false,
  };
  const tax = { customerType: 'b2b' as const, vatId: null, taxNumber: null };
  const person = { contactId: '0190a000-0000-7000-8000-0000000000d1', affiliationId: '0190a000-0000-7000-8000-0000000000d2', name: 'Anna Beispiel', role: 'Einkauf' };

  it('reads a version 1 snapshot (every document issued before, every import) unchanged, with no contact person', () => {
    const v1 = customerSnapshotV1Schema.parse({ ...buildCustomerSnapshot(contact, tax), v: 1, contactPerson: undefined });
    const parsed = customerSnapshotSchema.parse(v1);
    expect(parsed).toEqual(v1);
    expect(parsed.v).toBe(1);
    expect(snapshotContactPerson(parsed)).toBeNull();
  });

  it('reads a version 2 snapshot with and without a contact person, from the real JSON shape', () => {
    const withPerson = JSON.parse(JSON.stringify(buildCustomerSnapshot(contact, tax, person)));
    const parsed = customerSnapshotSchema.parse(withPerson);
    expect(parsed.v).toBe(2);
    expect(snapshotContactPerson(parsed)).toEqual(person);
    const none = customerSnapshotSchema.parse(JSON.parse(JSON.stringify(buildCustomerSnapshot(contact, tax))));
    expect(snapshotContactPerson(none)).toBeNull();
  });

  it('refuses a corrupt version 2 (a missing or malformed person) and an unknown version', () => {
    const good = JSON.parse(JSON.stringify(buildCustomerSnapshot(contact, tax, person)));
    expect(() => customerSnapshotSchema.parse({ ...good, contactPerson: undefined })).toThrow();
    expect(() => customerSnapshotSchema.parse({ ...good, contactPerson: { ...person, name: '' } })).toThrow();
    expect(() => customerSnapshotSchema.parse({ ...good, contactPerson: { contactId: person.contactId } })).toThrow();
    expect(() => customerSnapshotSchema.parse({ ...good, v: 3 })).toThrow();
  });

  it('a version 2 snapshot frozen at issue keeps the role it was issued with, whatever is stored later', () => {
    const frozen = buildCustomerSnapshot(contact, tax, person);
    const later = { ...person, role: 'Leitung' };
    buildCustomerSnapshot(contact, tax, later);
    expect(snapshotContactPerson(frozen)!.role).toBe('Einkauf');
  });
});
