// src/server/books/__tests__/epcQr.test.ts
//
// The EPC QR payment code (render/epcQr.ts, visual template composer plan,
// decision 17): the exact EPC069-12 version 002 payload, the amount format,
// the limits, when a code may be printed at all, and a round trip that
// rasterises the drawn module runs and decodes them back to the payload.

import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';

import { darkRuns, epcAmount, epcPayload, EPC_MAX_BYTES, looksLikeIban, qrMatrix, QUIET_ZONE_MODULES } from '../render/epcQr';
import { buildRenderModel, paymentQrData, type PaymentQrData } from '../render/model';
import { probe, probeInput } from '../template/probes';

const DATA: PaymentQrData = {
  beneficiaryName: 'Musterwerk Beispiel GmbH',
  iban: 'DE02 1203 0000 0000 2020 51',
  bic: 'BYLADEM1001',
  amountCents: 123450,
  currency: 'EUR',
  reference: 'Rechnung 2026-0042',
};

/** The drawn runs as an RGBA raster with the quiet zone, `scale` pixels per module. */
function raster(payload: string, scale = 4): { data: Uint8ClampedArray; size: number } {
  const m = qrMatrix(payload);
  const size = (m.size + 2 * QUIET_ZONE_MODULES) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const run of darkRuns(m)) {
    for (let c = run.col; c < run.col + run.len; c += 1) {
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = (c + QUIET_ZONE_MODULES) * scale + dx;
          const py = (run.row + QUIET_ZONE_MODULES) * scale + dy;
          const i = (py * size + px) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

describe('the EPC069-12 payload', () => {
  it('has the elements of version 002 in order, ending with the last populated one', () => {
    expect(epcPayload(DATA)).toBe(
      ['BCD', '002', '1', 'SCT', 'BYLADEM1001', 'Musterwerk Beispiel GmbH', 'DE02120300000000202051', 'EUR1234.50', '', '', 'Rechnung 2026-0042'].join('\n'),
    );
    expect(epcPayload(DATA).endsWith('\n')).toBe(false);
  });

  it('leaves a malformed BIC out (version 002 allows an empty one)', () => {
    expect(epcPayload({ ...DATA, bic: 'BYLADEM' }).split('\n')[4]).toBe('');
    expect(epcPayload({ ...DATA, bic: 'byladem1' }).split('\n')[4]).toBe('BYLADEM1');
  });

  it('formats the amount with a dot and two decimals, from 0.01 to the maximum', () => {
    expect(epcAmount(1)).toBe('EUR0.01');
    expect(epcAmount(123450)).toBe('EUR1234.50');
    expect(epcAmount(99_999_999_999)).toBe('EUR999999999.99');
    expect(() => epcAmount(0)).toThrow();
    expect(() => epcAmount(100_000_000_000)).toThrow();
  });

  it('cuts the name to 70 and the reference to 140 characters in the code only', () => {
    const lines = epcPayload({ ...DATA, beneficiaryName: 'A'.repeat(90), reference: 'r'.repeat(200), bic: null }).split('\n');
    expect(lines[4]).toBe('');
    expect(lines[5]).toBe('A'.repeat(70));
    expect(lines[10]).toBe('r'.repeat(140));
  });

  it('stays within 331 bytes with multi-byte letters, shortening the remittance first', () => {
    const payload = epcPayload({ ...DATA, beneficiaryName: 'Ä'.repeat(90), reference: 'ü'.repeat(200) });
    const lines = payload.split('\n');
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(EPC_MAX_BYTES);
    expect(Array.from(lines[5])).toHaveLength(70);
    expect(lines[10]).toMatch(/^ü+$/);
    expect(Array.from(lines[10]).length).toBeLessThan(140);
  });

  it('refuses what is not a SEPA transfer in EUR', () => {
    expect(() => epcPayload({ ...DATA, currency: 'CHF' })).toThrow();
    expect(() => epcPayload({ ...DATA, iban: 'not an iban' })).toThrow();
    expect(() => epcPayload({ ...DATA, beneficiaryName: ' ' })).toThrow();
  });
});

describe('when a code is printed', () => {
  it('prints on an issued EUR invoice with an IBAN, the payment reference first, else "Rechnung <number>"', () => {
    const p = probe('regular');
    expect(paymentQrData(p.document, p.document.senderSnapshot, false)).toMatchObject({ amountCents: p.document.total, reference: 'Rechnung 2026-0042' });
    const noRef = { ...p.document, paymentReference: null };
    expect(paymentQrData(noRef, p.document.senderSnapshot, false)?.reference).toBe('Rechnung 2026-0042');
    const custom = { ...p.document, paymentReference: 'Kunde 1042 Oktober' };
    expect(paymentQrData(custom, p.document.senderSnapshot, false)?.reference).toBe('Kunde 1042 Oktober');
  });

  it('prints nothing for a credit note, a draft, another currency, a zero total or a missing IBAN', () => {
    const p = probe('regular');
    const s = p.document.senderSnapshot;
    expect(paymentQrData(probe('creditNote').document, s, false)).toBeNull();
    expect(paymentQrData(p.document, s, true)).toBeNull();
    expect(paymentQrData({ ...p.document, currencyCode: 'CHF' }, s, false)).toBeNull();
    expect(paymentQrData({ ...p.document, total: 0 }, s, false)).toBeNull();
    expect(paymentQrData(p.document, s ? { ...s, iban: null } : s, false)).toBeNull();
    // A mistyped IBAN (right shape, wrong checksum) prints no code either.
    expect(paymentQrData(p.document, s ? { ...s, iban: 'DE02 1203 0000 0000 2020 52' } : s, false)).toBeNull();
    expect(looksLikeIban('DE02 1203 0000 0000 2020 51')).toBe(true);
    // A malformed IBAN in the snapshot prints no code rather than failing the issue.
    expect(paymentQrData(p.document, s ? { ...s, iban: 'DE12 3' } : s, false)).toBeNull();
    // A draft invoice that will carry a code shows the placeholder instead.
    expect(buildRenderModel(probeInput(p, true)).paymentQrPending).toBe(true);
    expect(buildRenderModel(probeInput(probe('creditNote'), true)).paymentQrPending).toBe(false);
  });
});

describe('the drawn code', () => {
  it('decodes back to the exact payload', () => {
    for (const data of [DATA, { ...DATA, beneficiaryName: 'Société Exemple à Genève', reference: 'Ü'.repeat(140), amountCents: 99_999_999_999 }]) {
      const payload = epcPayload(data);
      const { data: pixels, size } = raster(payload);
      const decoded = jsQR(pixels, size, size);
      expect(decoded?.data).toBe(payload);
    }
  });

  it('is the same matrix every time', () => {
    const a = qrMatrix(epcPayload(DATA));
    const b = qrMatrix(epcPayload(DATA));
    expect(a).toEqual(b);
  });
});
