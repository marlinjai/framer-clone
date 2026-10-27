// The payment block of an invoice (render/model.ts): an ordinary invoice asks for the transfer with its due date,
// reference and bank details; the receipt of a paid shop order (it names its order) says it is paid on the day the payment
// recorded (its issue day when none) and asks for nothing.
import { describe, expect, it } from 'vitest';
import { buildRenderModel } from '../render/model';
import { probe, probeInput } from '../template/probes';

describe('the payment block', () => {
  it('asks for the transfer on an ordinary invoice', () => {
    const p = probe('regular');
    const model = buildRenderModel(probeInput(p));
    expect(model.payment.join(' ')).toMatch(/Bitte überweisen Sie den Gesamtbetrag bis zum|Zahlbar innerhalb von/);
    expect(model.paymentFields).not.toContain('paid');
  });

  it('says the receipt of a paid shop order is paid, with no due date, reference or bank details', () => {
    const p = probe('regular');
    p.document = { ...p.document, sourceOrderId: '7b0c2a9e-3f4d-4c1b-9a8e-1d2c3b4a5f60', issueDate: '2026-10-27', dueDate: '2026-11-10' };
    const model = buildRenderModel(probeInput(p));
    expect(model.payment).toEqual(['Bezahlt am 27.10.2026. Es ist kein Betrag offen.']);
    expect(model.paymentFields).toEqual(['paid']);
  });

  it('prints the day the buyer paid, not the later day a retry issued the receipt', () => {
    const p = probe('regular');
    p.document = { ...p.document, sourceOrderId: '7b0c2a9e-3f4d-4c1b-9a8e-1d2c3b4a5f60', issueDate: '2026-10-29', paidOn: '2026-10-27' };
    const model = buildRenderModel(probeInput(p));
    expect(model.payment).toEqual(['Bezahlt am 27.10.2026. Es ist kein Betrag offen.']);
  });
});
