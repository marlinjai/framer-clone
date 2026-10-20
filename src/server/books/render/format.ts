// src/server/books/render/format.ts
//
// German presentation of the Books' integer units, written out by hand instead
// of `Intl.NumberFormat('de-DE')` so the output cannot change with the Node
// build's ICU data: a stored invoice must re-render to the same bytes on any
// machine, today and in ten years (GoBD retention).
//
//   money      integer cents      -> "1.234,56 €" (a minus sign when negative)
//   quantity   integer thousandths -> "1,5" (no trailing zeros)
//   rate       integer basis points -> "19 %", "7 %", "5,5 %"
//   date       "YYYY-MM-DD"        -> "31.12.2026"
//
// And the one text normalizer every string passes before it reaches the PDF:
// control characters and line breaks become spaces, invisible joiners and
// variation selectors are dropped, runs of spaces collapse. Nothing else is
// changed: a name is printed exactly as written, in the embedded Unicode fonts
// (fonts.ts). Characters those fonts cannot draw are refused at issue
// (fonts.ts undrawable), never transliterated or replaced on a document of
// record. The completeness check (completeness.ts) compares against the same
// normalized text.

/**
 * The text as the PDF will show it: whitespace and control characters
 * normalized, nothing transliterated. Idempotent.
 */
export function toPdfText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200d\ufe0e\ufe0f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Integer cents (hundredths of the currency) as German money: 123456 ->
 * "1.234,56 €"; another currency prints its ISO code ("1.234,56 CHF"), since
 * an imported invoice keeps the currency it was printed in.
 */
export function formatMoney(cents: number, currency = 'EUR'): string {
  if (!Number.isInteger(cents)) throw new Error(`formatMoney: not an integer amount: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${groupThousands(String(units))},${rest} ${currency === 'EUR' ? '€' : currency}`;
}

/** Integer thousandths as a German quantity: 1500 -> "1,5", 2000 -> "2", 1250 -> "1,25". */
export function formatQuantity(thousandths: number): string {
  if (!Number.isInteger(thousandths)) throw new Error(`formatQuantity: not an integer: ${thousandths}`);
  const sign = thousandths < 0 ? '-' : '';
  const abs = Math.abs(thousandths);
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${sign}${groupThousands(String(whole))}${frac ? `,${frac}` : ''}`;
}

/** Integer basis points as a German percentage: 1900 -> "19 %", 550 -> "5,5 %". */
export function formatRate(bp: number): string {
  if (!Number.isInteger(bp)) throw new Error(`formatRate: not an integer: ${bp}`);
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `,${frac}` : ''} %`;
}

/** A calendar day "YYYY-MM-DD" as German "DD.MM.YYYY". */
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`formatDate: not a YYYY-MM-DD date: ${isoDate}`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** "10115 Berlin" (either part may be missing). */
export function postalCity(postalCode: string | null | undefined, city: string | null | undefined): string {
  return [postalCode, city].filter((p) => p && p.trim() !== '').join(' ').trim();
}

/** A safe file name part: letters, digits, dot, dash, underscore. */
export function fileNamePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned === '' ? 'dokument' : cleaned.slice(0, 60);
}
