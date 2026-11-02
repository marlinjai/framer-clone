// Secret-shaped text: what must not reach a public page because a source held it in a
// constant. `staticEval` resolves local `const`, so `const KEY = "<a live key>"` read into
// an `href` would otherwise be stored and published. The one list here is shared with the
// AI layer, which scans what a person sends. It is a net, not a guarantee: what it misses
// is still the person's to see, and the preview is the real control there.
//
// Every scan is linear in the text. A pattern that starts with a repeated class is
// quadratic on a long run under the size limit, as the slice 2 review proved twice, so no
// pattern here searches for a secret's shape: text is split into maximal runs, which a
// global match of one class finds in one pass, and each run is searched for each known
// prefix with `indexOf`, with constant work at each place one occurs.
//
// What it does not see, by design of a net: a key with no published prefix (other than the
// AWS secret access key, beside a word that names it), a key encoded (base64, hex, split
// over computed strings), and a vendor not in the table. The plan lists these limits.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Untrusted input".

export type SecretKind = 'vendor-key' | 'private-key' | 'signed-token' | 'connection-password';

/** A known key format: its fixed start, and what must follow it. */
interface VendorPrefix {
  prefix: string;
  /** How many characters of the format's own alphabet must follow the prefix, at least. */
  tail: number;
  /** The tail is exactly `tail` long: the character after it is not of its alphabet. */
  exact?: true;
  /** The tail's alphabet, when it is narrower than word characters. */
  alphabet?: RegExp;
  /** A prefix short enough to occur inside ordinary words (`re_` in `store_`): it counts only at a run's start or after a non-letter. */
  boundary?: true;
  /** The tail must mix letters and digits, as a random key over this length does, so `sk-` in `risk-assessment-...` is no key. */
  mixed?: true;
}

const UPPER_DIGIT = /[A-Z0-9]/;
const LOWER_HEX = /[0-9a-f]/;
const WORD_CHAR = /[A-Za-z0-9_-]/;

/** Vendor formats, as their providers publish them. A publishable key is meant to be public and is not here. */
const VENDOR_PREFIXES: readonly VendorPrefix[] = [
  { prefix: 'sk_live_', tail: 16 }, { prefix: 'sk_test_', tail: 16 }, { prefix: 'rk_live_', tail: 16 }, { prefix: 'rk_test_', tail: 16 },
  { prefix: 'whsec_', tail: 16 },
  { prefix: 'sk-ant-', tail: 20 }, { prefix: 'sk-proj-', tail: 20 }, { prefix: 'sk-svcacct-', tail: 20 }, { prefix: 'sk-', tail: 32, boundary: true, mixed: true },
  { prefix: 'ghp_', tail: 30 }, { prefix: 'gho_', tail: 30 }, { prefix: 'ghu_', tail: 30 }, { prefix: 'ghs_', tail: 30 }, { prefix: 'ghr_', tail: 30 },
  { prefix: 'github_pat_', tail: 30 },
  { prefix: 'glpat-', tail: 20 },
  { prefix: 'xoxb-', tail: 10 }, { prefix: 'xoxp-', tail: 10 }, { prefix: 'xoxa-', tail: 10 }, { prefix: 'xoxr-', tail: 10 }, { prefix: 'xoxs-', tail: 10 },
  { prefix: 'AKIA', tail: 16, exact: true, alphabet: UPPER_DIGIT }, { prefix: 'ASIA', tail: 16, exact: true, alphabet: UPPER_DIGIT },
  { prefix: 'AIza', tail: 35 },
  { prefix: 'GOCSPX-', tail: 20 },
  { prefix: 'SK', tail: 32, exact: true, alphabet: LOWER_HEX, boundary: true },
  { prefix: 're_', tail: 20, boundary: true, mixed: true },
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

const isLetter = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** Whether a tail of letters and digits mixes both, as a random key does over this length. */
function isMixed(tail: string): boolean {
  let letter = false;
  let digit = false;
  for (const ch of tail) {
    if (isDigit(ch)) digit = true;
    else if (isLetter(ch)) letter = true;
    else return false;
  }
  return letter && digit;
}

/** Whether a format starts at `at` in a run, with all it requires after. Constant work per place. */
function keyAt(word: string, at: number, format: VendorPrefix): boolean {
  const { prefix, tail, exact, alphabet = WORD_CHAR, boundary, mixed } = format;
  const from = at + prefix.length;
  if (word.length - from < tail) return false;
  if (boundary && at > 0 && (isLetter(word[at - 1]) || isDigit(word[at - 1]))) return false;
  const body = word.slice(from, from + tail);
  for (const ch of body) if (!alphabet.test(ch)) return false;
  if (exact && from + tail < word.length && alphabet.test(word[from + tail])) return false;
  return !mixed || isMixed(body);
}

/** The shortest key any vendor format can be, so most words are passed over at once. */
const SHORTEST_KEY = Math.min(...VENDOR_PREFIXES.map(({ prefix, tail }) => prefix.length + tail));

/** A key anywhere inside a run, not only at its start: `token-<key>` and `api_<key>` hold one too. */
function hasVendorKey(word: string): boolean {
  if (word.length < SHORTEST_KEY) return false;
  for (const format of VENDOR_PREFIXES) {
    for (let at = word.indexOf(format.prefix); at >= 0; at = word.indexOf(format.prefix, at + 1)) {
      if (keyAt(word, at, format)) return true;
    }
  }
  return false;
}

/** Mapbox's secret token is dotted: `sk.` and an encoded JSON object. */
const MAPBOX_SECRET = 'sk.eyJ';

function hasMapboxSecret(dotted: string): boolean {
  for (let at = dotted.indexOf(MAPBOX_SECRET); at >= 0; at = dotted.indexOf(MAPBOX_SECRET, at + 1)) {
    if (dotted.length - at >= MAPBOX_SECRET.length + 20) return true;
  }
  return false;
}

/**
 * An AWS secret access key has no prefix: exactly 40 characters of base64, mixed case with digits. A run of
 * exactly that length is rare in honest text (a data address is one long run, a hex digest has no upper case),
 * and rarer still with a `/` or `+` in it, so that counts alone, and the plain shape counts beside a word naming it.
 */
const BASE64_RUN = /[A-Za-z0-9/+]+/g;
const AWS_CONTEXT = /aws|secret_?access/i;

function hasAwsSecret(text: string): boolean {
  let named: boolean | undefined;
  for (const [run] of text.matchAll(BASE64_RUN)) {
    if (run.length !== 40 || !/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) continue;
    if (/[/+]/.test(run)) return true;
    named ??= AWS_CONTEXT.test(text);
    if (named) return true;
  }
  return false;
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
    // `https://<token>@host`: a user part long and random enough to be a token is one.
    if ((colon < 0 || colon > userEnd) && userEnd >= 20 && isMixed(authority.slice(0, userEnd).replace(/[_-]/g, ''))) return true;
  }
  return false;
}

/** The first kind of secret a text holds, or undefined. Linear in the text. */
export function findSecret(text: string): SecretKind | undefined {
  for (const [word] of text.matchAll(WORD_RUN)) if (hasVendorKey(word)) return 'vendor-key';
  if (text.includes('.')) {
    for (const [dotted] of text.matchAll(DOTTED_RUN)) {
      if (!dotted.includes('.')) continue;
      if (hasSignedToken(dotted)) return 'signed-token';
      if (hasDottedVendorKey(dotted) || hasMapboxSecret(dotted)) return 'vendor-key';
    }
  }
  if (hasAwsSecret(text)) return 'vendor-key';
  if (hasPrivateKey(text)) return 'private-key';
  if (hasConnectionPassword(text)) return 'connection-password';
  return undefined;
}
