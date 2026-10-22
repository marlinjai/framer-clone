// src/server/books/render/epcQr.ts
//
// The EPC QR payment code ("GiroCode", visual template composer plan,
// decision 17): the European Payments Council's QR code for SEPA credit
// transfers, EPC069-12 version 002, which German banking apps read to prefill a
// transfer. Pure: the payload is built from the frozen document data (never
// from live settings) and the module matrix comes from a pinned pure
// JavaScript encoder in byte mode, error correction level M, with the mask
// chosen by the standard's own penalty scoring. Same input, same matrix, so a
// re-render writes the same bytes.
//
// The engine (render/engine) draws the matrix as vector squares; nothing here
// touches the PDF.

import QRCode from 'qrcode';

import type { PaymentQrData } from './model';

/** The most bytes an EPC069-12 payload may have. */
export const EPC_MAX_BYTES = 331;
const NAME_MAX = 70;
const REMITTANCE_MAX = 140;

/** Cut a string to at most `max` characters (code points, never half a surrogate pair). */
function cut(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

/** The IBAN length of every SEPA country (ISO 13616 registry). */
const SEPA_IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22,
  GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18,
  NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

/** An IBAN as the code carries it: no spaces, upper case. */
export function normalIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * Whether a string is an IBAN: country, check digits, 11 to 30 letters or
 * digits, and the ISO 7064 mod-97 checksum, so a mistyped IBAN prints no code
 * (a banking app would refuse it, or the customer would pay a wrong account).
 */
export function looksLikeIban(iban: string): boolean {
  const s = normalIban(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  // An EPC code is a SEPA transfer: the IBAN must be of a SEPA country, at its length.
  if (SEPA_IBAN_LENGTH[s.slice(0, 2)] !== s.length) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Integer cents as the EPC amount: 123450 -> "EUR1234.50". */
export function epcAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 1 || cents > 99_999_999_999) {
    throw new Error('epcAmount: the amount must be 0.01 to 999999999.99 EUR');
  }
  return `EUR${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * The EPC069-12 version 002 payload, elements separated by a line feed:
 * service tag, version, character set (1, UTF-8), identification, BIC (may be
 * empty in version 002), beneficiary name (at most 70 characters), IBAN,
 * amount, purpose (empty), structured reference (empty), unstructured
 * remittance (at most 140 characters), note (empty). The last populated
 * element is not followed by a separator, so the payload ends with the
 * remittance text.
 *
 * The limits are in characters, the whole payload in bytes (331): a name and
 * a reference full of multi-byte letters are shortened further, the
 * remittance first, so a valid transfer always has a code.
 */
export function epcPayload(data: PaymentQrData): string {
  const iban = normalIban(data.iban);
  // Version 002 lets the BIC be empty; a malformed one is left out rather than make the code unusable.
  const bicRaw = (data.bic ?? '').replace(/\s+/g, '').toUpperCase();
  const bic = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bicRaw) ? bicRaw : '';
  if (data.currency !== 'EUR') throw new Error('epcPayload: only EUR transfers have an EPC code');
  if (!looksLikeIban(iban)) throw new Error('epcPayload: not an IBAN');
  let name = Array.from(cut(data.beneficiaryName.trim(), NAME_MAX));
  if (name.length === 0) throw new Error('epcPayload: the beneficiary name is empty');
  let remittance = Array.from(cut(data.reference.trim(), REMITTANCE_MAX));
  // The last populated element is not followed by a separator: empty trailing elements are left off.
  const build = () => {
    const elements = ['BCD', '002', '1', 'SCT', bic, name.join(''), iban, epcAmount(data.amountCents), '', '', remittance.join(''), ''];
    while (elements.length > 0 && elements[elements.length - 1] === '') elements.pop();
    return elements.join('\n');
  };
  let payload = build();
  while (byteLength(payload) > EPC_MAX_BYTES) {
    if (remittance.length > 0) remittance = remittance.slice(0, -1);
    else name = name.slice(0, -1);
    payload = build();
  }
  return payload;
}

/** A square module matrix: `dark[row * size + col]`. */
export interface QrMatrix {
  size: number;
  dark: boolean[];
}

/** The QR module matrix of a payload (byte mode, error correction M, no quiet zone). */
export function qrMatrix(payload: string): QrMatrix {
  const code = QRCode.create([{ data: new TextEncoder().encode(payload), mode: 'byte' }], { errorCorrectionLevel: 'M' });
  const size = code.modules.size;
  const dark: boolean[] = new Array(size * size);
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) dark[r * size + c] = Boolean(code.modules.get(r, c));
  return { size, dark };
}

/**
 * The dark modules as horizontal runs (row, first column, length): one
 * rectangle per run keeps the drawn code small and identical every time.
 */
export function darkRuns(m: QrMatrix): Array<{ row: number; col: number; len: number }> {
  const out: Array<{ row: number; col: number; len: number }> = [];
  for (let r = 0; r < m.size; r += 1) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark[r * m.size + c]) {
        c += 1;
        continue;
      }
      const start = c;
      while (c < m.size && m.dark[r * m.size + c]) c += 1;
      out.push({ row: r, col: start, len: c - start });
    }
  }
  return out;
}

/** The modules of quiet zone the standard asks for around the code. */
export const QUIET_ZONE_MODULES = 4;
