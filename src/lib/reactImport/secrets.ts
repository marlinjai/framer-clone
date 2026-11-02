// Secret-shaped text: what must not reach a public page because a source held it in a
// constant. `staticEval` resolves local `const`, so `const KEY = "<a live key>"` read into
// an `href` would otherwise be stored and published. The one list here is shared with the
// AI layer, which scans what a person sends. It is a net, not a guarantee: what it misses
// is still the person's to see, and the preview is the real control there.
//
// Every scan is linear in the text. A pattern that starts with a repeated class is
// quadratic on a long run under the size limit, as the slice 2 review proved twice, so no
// pattern here searches for a secret's shape: text is split into maximal runs, which a
// global match of one class finds in one pass, and each run is checked from its start.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Untrusted input".

export type SecretKind = 'vendor-key' | 'private-key' | 'signed-token' | 'connection-password';

/** A known key format: its fixed start, and how long the rest of the run must at least be. */
interface VendorPrefix {
  prefix: string;
  tail: number;
  /** The whole run is exactly this long, for formats of a fixed length. */
  length?: number;
  /** The rest is upper case letters and digits only. */
  upper?: true;
}

/** Vendor formats, as their providers publish them. A publishable key is meant to be public and is not here. */
const VENDOR_PREFIXES: readonly VendorPrefix[] = [
  { prefix: 'sk_live_', tail: 16 }, { prefix: 'sk_test_', tail: 16 }, { prefix: 'rk_live_', tail: 16 }, { prefix: 'rk_test_', tail: 16 },
  { prefix: 'whsec_', tail: 16 },
  { prefix: 'sk-ant-', tail: 20 }, { prefix: 'sk-proj-', tail: 20 }, { prefix: 'sk-svcacct-', tail: 20 }, { prefix: 'sk-', tail: 32 },
  { prefix: 'ghp_', tail: 30 }, { prefix: 'gho_', tail: 30 }, { prefix: 'ghu_', tail: 30 }, { prefix: 'ghs_', tail: 30 }, { prefix: 'ghr_', tail: 30 },
  { prefix: 'github_pat_', tail: 30 },
  { prefix: 'glpat-', tail: 20 },
  { prefix: 'xoxb-', tail: 10 }, { prefix: 'xoxp-', tail: 10 }, { prefix: 'xoxa-', tail: 10 }, { prefix: 'xoxr-', tail: 10 }, { prefix: 'xoxs-', tail: 10 },
  { prefix: 'AKIA', tail: 16, length: 20, upper: true }, { prefix: 'ASIA', tail: 16, length: 20, upper: true },
  { prefix: 'AIza', tail: 35, length: 39 },
  { prefix: 're_', tail: 20 },
  { prefix: 'npm_', tail: 36 },
  { prefix: 'shpat_', tail: 32 }, { prefix: 'shpss_', tail: 32 }, { prefix: 'shppa_', tail: 32 },
  { prefix: 'xkeysib-', tail: 40 },
];

/**
 * Maximal runs of word characters, and of word characters and dots. A run of one class, matched globally,
 * fails at once on every character outside it and never retries inside a run, so each is linear.
 */
const WORD_RUN = /[A-Za-z0-9_-]+/g;
const DOTTED_RUN = /[A-Za-z0-9_.-]+/g;

const UPPER_OR_DIGIT = /^[A-Z0-9]+$/;

/** The shortest word any vendor format can be, so most words are passed over at once. */
const SHORTEST_KEY = Math.min(...VENDOR_PREFIXES.map(({ prefix, tail }) => prefix.length + tail));

function isVendorKey(word: string): boolean {
  if (word.length < SHORTEST_KEY) return false;
  return VENDOR_PREFIXES.some(({ prefix, tail, length, upper }) => {
    if (!word.startsWith(prefix) || word.length - prefix.length < tail) return false;
    if (length !== undefined && word.length !== length) return false;
    return !upper || UPPER_OR_DIGIT.test(word.slice(prefix.length));
  });
}

const SIGNED_PART = 10;

/** A signed login token is three dotted parts, the first two encoded JSON objects, so each starts `eyJ`. */
function hasSignedToken(dotted: string): boolean {
  const parts = dotted.split('.');
  for (let i = 0; i + 2 < parts.length; i += 1) {
    const [header, payload, signature] = [parts[i], parts[i + 1], parts[i + 2]];
    if (header.startsWith('eyJ') && payload.startsWith('eyJ') && header.length >= SIGNED_PART && payload.length >= SIGNED_PART && signature.length >= SIGNED_PART) return true;
  }
  return false;
}

/** SendGrid's key is dotted: `SG.`, an id, a secret. */
function hasDottedVendorKey(dotted: string): boolean {
  const parts = dotted.split('.');
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (parts[i].endsWith('SG') && parts[i + 1].length >= 16 && parts[i + 2].length >= 30) return true;
  }
  return false;
}

const PRIVATE_KEY_HEADER = '-----BEGIN ';
const PRIVATE_KEY_TAIL = /^[A-Z0-9 ]{0,40}PRIVATE KEY-----/;

function hasPrivateKey(text: string): boolean {
  for (let at = text.indexOf(PRIVATE_KEY_HEADER); at >= 0; at = text.indexOf(PRIVATE_KEY_HEADER, at + 1)) {
    if (PRIVATE_KEY_TAIL.test(text.slice(at + PRIVATE_KEY_HEADER.length, at + PRIVATE_KEY_HEADER.length + 64))) return true;
  }
  return false;
}

const isSchemeChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 45 || code === 46;

/** Where an address's authority ends: a path, a query, a fragment, a space, a quote. */
const ENDS_AUTHORITY = new Set([47, 63, 35, 32, 9, 10, 13, 34, 39, 96, 60, 62, 92, 41, 40]);

/** `scheme://user:password@host`. The authority stops at the next `/`, so a run of `://` scans nothing twice. */
function hasConnectionPassword(text: string): boolean {
  for (let at = text.indexOf('://'); at >= 0; at = text.indexOf('://', at + 3)) {
    if (at === 0 || !isSchemeChar(text.charCodeAt(at - 1))) continue;
    let end = at + 3;
    while (end < text.length && !ENDS_AUTHORITY.has(text.charCodeAt(end))) end += 1;
    const authority = text.slice(at + 3, end);
    const userEnd = authority.lastIndexOf('@');
    if (userEnd < 0) continue;
    const colon = authority.indexOf(':');
    if (colon >= 0 && colon < userEnd && userEnd - colon > 1) return true;
  }
  return false;
}

/** The first kind of secret a text holds, or undefined. Linear in the text. */
export function findSecret(text: string): SecretKind | undefined {
  for (const [word] of text.matchAll(WORD_RUN)) if (isVendorKey(word)) return 'vendor-key';
  if (text.includes('.')) {
    for (const [dotted] of text.matchAll(DOTTED_RUN)) {
      if (!dotted.includes('.')) continue;
      if (hasSignedToken(dotted)) return 'signed-token';
      if (hasDottedVendorKey(dotted)) return 'vendor-key';
    }
  }
  if (hasPrivateKey(text)) return 'private-key';
  if (hasConnectionPassword(text)) return 'connection-password';
  return undefined;
}
