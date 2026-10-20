// src/lib/books/units.ts
//
// The editor's conversion between what a person types and the Books' integer
// units (Books plan P1.1): quantities in thousandths ("1,5" -> 1500), money in
// cents ("80,00" or "80.00" -> 8000), rates in basis points. German input
// (comma decimals, dot thousands) and plain input both parse; anything else is
// null, so the form can say which field is wrong instead of sending a guess.
// Client-safe: no server imports.

/** Parse a decimal with at most `decimals` places into an integer of 10^decimals units. */
export function parseScaled(input: string, decimals: number): number | null {
  let s = input.trim().replace(/\s|€/g, '');
  if (s === '') return null;
  // "1.234,56" (German) and "1,234.56" (English) both become "1234.56".
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.replace('-', '').split('.');
  if (frac.length > decimals) return null;
  const value = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || '0');
  if (!Number.isSafeInteger(value)) return null;
  return s.startsWith('-') ? -value : value;
}

/** "1,5" -> 1500 (thousandths). */
export const parseQuantity = (input: string) => parseScaled(input, 3);
/** "80,00" -> 8000 (cents). */
export const parseMoney = (input: string) => parseScaled(input, 2);
/** "10" -> 1000 (basis points). */
export const parsePercent = (input: string) => parseScaled(input, 2);

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** 123456 -> "1.234,56 €". */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${group(String(Math.floor(abs / 100)))},${String(abs % 100).padStart(2, '0')} €`;
}

/** 1500 -> "1,5". */
export function quantity(thousandths: number): string {
  const abs = Math.abs(thousandths);
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${thousandths < 0 ? '-' : ''}${group(String(Math.floor(abs / 1000)))}${frac ? `,${frac}` : ''}`;
}

/** 8000 -> "80,00" (an input value, no currency sign). */
export function moneyInput(cents: number): string {
  return money(cents).replace(' €', '').replace(/\./g, '');
}

/** 1900 -> "19 %". */
export function rate(bp: number): string {
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return `${Math.floor(bp / 100)}${frac ? `,${frac}` : ''} %`;
}

/** "2026-12-31" -> "31.12.2026". */
export function date(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
