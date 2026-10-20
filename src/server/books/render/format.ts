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
// And the one text sanitizer every string passes before it reaches the PDF:
// the built-in PDF fonts (Helvetica) encode Windows-1252 only, which covers
// German (äöüß, €, „“) and Western European text. A character outside it (a
// Polish ł, a Czech ř, an emoji) is transliterated (its accents dropped:
// "Łódź" stays readable as "Lodz") or, if that is impossible, replaced by "?".
// The completeness check (completeness.ts) compares against the same sanitized
// text, so a transliterated name still counts as present. Embedding a Unicode
// font would lift this; it is a deliberate limit of the first renderer.

/** Windows-1252's characters in 0x80..0x9F (the rest of 0x20..0xFF is Latin-1). */
const CP1252_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e,
  0x0178,
]);

/** True when the built-in PDF fonts can draw the code point. */
export function isWinAnsi(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(cp);
}

/** Letters NFKD cannot take apart but that have an obvious plain form. */
const TRANSLITERATE: Record<string, string> = {
  'ł': 'l',
  'Ł': 'L',
  'đ': 'd',
  'Đ': 'D',
  'ı': 'i',
  'ħ': 'h',
  'Ħ': 'H',
  'ŋ': 'n',
  'Ŋ': 'N',
};

/**
 * The text as the PDF will show it: control characters and line breaks become
 * spaces, runs of spaces collapse, characters outside Windows-1252 are
 * transliterated or replaced by "?". Idempotent.
 */
export function toPdfText(value: string): string {
  let out = '';
  for (const ch of value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')) {
    const cp = ch.codePointAt(0)!;
    if (isWinAnsi(cp)) {
      out += ch;
      continue;
    }
    if (TRANSLITERATE[ch]) {
      out += TRANSLITERATE[ch];
      continue;
    }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += [...base].every((c) => isWinAnsi(c.codePointAt(0)!)) && base !== '' ? base : '?';
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Integer cents as German money: 123456 -> "1.234,56 €". */
export function formatMoney(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`formatMoney: not an integer amount: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${groupThousands(String(euros))},${rest} €`;
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
