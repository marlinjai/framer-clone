// src/lib/customCode/contract.ts
//
// The contract of a sandboxed custom code block, shared by the box service
// (services/box, which serves a block's document from its own registrable
// domain) and, from slice C2 on, by the application's renderers and broker.
// Plan: docs/plans/2026-11-02-sandboxed-custom-code.md, decisions D2, D3, D5
// and D13 to D18.
//
// THIS MODULE IMPORTS NOTHING, and a test fails if it ever does: the box
// bundles it from the application's source, so the two sides cannot drift, and
// at a security boundary every import is surface. It uses only what every
// runtime it runs in already has as a global (Web Crypto, TextEncoder).
//
// Nothing in the application imports this file yet (slice C1a builds the
// service and the contract only; the sandbox is connected to nothing).

/** The version of the postMessage protocol between the page and a frame. */
export const BOX_PROTOCOL_VERSION = 1;

/** The version of the shell, sent in `hello`. The shell is in no hash, so it can change with a deploy. */
export const BOX_SHELL_VERSION = 1;

/** Present in every served document: what the canary monitor looks for. */
export const BOX_SHELL_MARKER = 'fc-box-shell';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const BOX_LIMITS = {
  /** Code plus declaration, in bytes of UTF-8. The guarded route refuses more, and the box refuses a larger row. */
  documentBytes: 256 * 1024,
  /** Blocks drawn per page; the renderer warns for the rest. */
  blocksPerPage: 4,
  /** Live code per site, in bytes. */
  siteBytes: 1024 * 1024,
  /** Height a frame may ask for through `resize`, in pixels. */
  heightPixels: 10_000,
  /** One message on the port, in bytes. */
  messageBytes: 64 * 1024,
  /** Messages a frame may send per second. */
  messagesPerSecond: 30,
  /** `resize` messages per second. */
  resizesPerSecond: 10,
  /** Entries in each of `reads`, `writes` and `emits`. */
  declarationEntries: 32,
  /** Hosts of one site named in `frame-ancestors`, the editor host not counted. */
  frameAncestorHosts: 32,
} as const;

/** The kinds of message of protocol version 1. `hello` and `connect` travel on the window, the rest on the port. */
export const BOX_MESSAGE_KINDS = ['hello', 'connect', 'state', 'setState', 'emit', 'resize', 'ping', 'pong', 'error'] as const;
export type BoxMessageKind = (typeof BOX_MESSAGE_KINDS)[number];

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

/** A site id as the application writes it: a lower case universally unique identifier (UUID). */
export const BOX_SITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A hash: 64 lower case hex characters. Upper case is refused, so one blob has one address and one cache key. */
export const BOX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const BOX_PATH_PATTERN = /^\/box\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/;

export interface BoxAddress {
  siteId: string;
  sha256: string;
}

/**
 * The pair a request path names, or null. The path is matched as it arrived:
 * nothing is decoded, lower cased or trimmed, so a percent-encoded or upper
 * case spelling of an address is simply not an address.
 */
export function parseBoxPath(path: string): BoxAddress | null {
  const match = BOX_PATH_PATTERN.exec(path);
  const siteId = match?.[1];
  const sha256 = match?.[2];
  return siteId && sha256 ? { siteId, sha256 } : null;
}

/** The path of a block. Throws on anything that is not a site id and a hash: an address is never built from stored text. */
export function boxPath(siteId: string, sha256: string): string {
  if (!BOX_SITE_ID_PATTERN.test(siteId) || !BOX_SHA256_PATTERN.test(sha256)) {
    throw new Error('a box address needs a site id and a sha256');
  }
  return `/box/${siteId}/${sha256}`;
}

// ---------------------------------------------------------------------------
// Hosts and frame-ancestors
// ---------------------------------------------------------------------------

/** What every branch preview label starts with (src/lib/sites/previewHost.ts). Repeated here because this module imports nothing; a test holds the two equal. */
export const BOX_PREVIEW_LABEL_PREFIX = 'preview-';

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True for an exact public host name: lower case ASCII (punycode for an
 * internationalized name), at least two labels, a last label that starts with
 * a letter. No scheme, port, path, wildcard, address literal, trailing dot or
 * white space: nothing that could add a source or a directive to a header.
 */
export function isExactHostname(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && HOSTNAME_PATTERN.test(value);
}

/** True for a host whose first label is kept for branch preview links, under whatever domain. */
export function isPreviewLabelHost(host: string): boolean {
  return host.startsWith(BOX_PREVIEW_LABEL_PREFIX);
}

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The hosts of one site, from what the database holds: its platform subdomain
 * labels (the database stores the label only, the base host is configuration)
 * and its live custom host names. A label that is not one plain DNS label is
 * dropped, so a stored label can never smuggle in a dot, a wildcard or a
 * second host. A custom host name that is not an exact host name, or that is
 * the platform's base host or a name under it, is dropped too, so one site
 * cannot name another site's platform address through its custom domain. What
 * is not allowed is dropped first and the limit applied after, so 32 bad
 * entries cannot push out a good one. Decision D18.
 */
export function siteHostsOf(subdomainLabels: unknown, customHostnames: unknown, sitesBaseHost: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const add = (host: string) => {
    if (hosts.length >= BOX_LIMITS.frameAncestorHosts || seen.has(host) || isPreviewLabelHost(host)) return;
    seen.add(host);
    hosts.push(host);
  };
  // Without a base host no platform host can be told from a custom one, so nothing is named.
  if (!isExactHostname(sitesBaseHost)) return hosts;
  if (Array.isArray(subdomainLabels)) {
    for (const label of subdomainLabels) {
      if (typeof label === 'string' && DNS_LABEL_PATTERN.test(label)) add(`${label}.${sitesBaseHost}`);
    }
  }
  if (Array.isArray(customHostnames)) {
    for (const host of customHostnames) {
      // A custom host name is never the platform's own base or a name under it: those come from a label only.
      if (isExactHostname(host) && host !== sitesBaseHost && !host.endsWith(`.${sitesBaseHost}`)) add(host);
    }
  }
  return hosts;
}

/**
 * The value of `frame-ancestors` for one document: the site's hosts and the
 * editor host as `https://<host>` sources, or `'none'`.
 *
 * Decision D14: every entry must be an exact host name. A wildcard, a scheme,
 * a port or any other spelling is dropped, never repaired, because one
 * `*.sites` entry would let every site and every branch preview frame the
 * code. Decision D13: a branch preview host is dropped even when it is an
 * exact name, so a block shows its fallback on a preview link.
 */
export function frameAncestorsValue(siteHosts: unknown, editorHost: unknown): string {
  const sources: string[] = [];
  const seen = new Set<string>();
  const add = (host: unknown) => {
    if (!isExactHostname(host) || isPreviewLabelHost(host) || seen.has(host)) return;
    seen.add(host);
    sources.push(`https://${host}`);
  };
  if (Array.isArray(siteHosts)) {
    for (const host of siteHosts) {
      // The limit counts what is named, not what was dropped.
      if (sources.length >= BOX_LIMITS.frameAncestorHosts) break;
      add(host);
    }
  }
  add(editorHost);
  return sources.length > 0 ? sources.join(' ') : "'none'";
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Every powerful feature, refused. Decision D5. */
export const BOX_PERMISSIONS_POLICY = [
  'camera', 'microphone', 'geolocation', 'usb', 'serial', 'hid', 'bluetooth', 'midi', 'payment',
  'display-capture', 'fullscreen', 'clipboard-read', 'clipboard-write', 'publickey-credentials-get',
  'xr-spatial-tracking', 'accelerometer', 'gyroscope', 'magnetometer', 'idle-detection',
  'screen-wake-lock', 'browsing-topics', 'attribution-reporting',
].map((feature) => `${feature}=()`).join(', ');

/** The policy of a block's document, without `frame-ancestors` and `report-uri`. Decision D5, byte for byte. */
export const BOX_DOCUMENT_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
  "frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; webrtc 'block'";

/**
 * The policy of every answer that is not a block's document (a refusal, the
 * health checks, the page that says what the domain is): nothing runs,
 * nothing loads, nothing frames it.
 */
export const BOX_REFUSAL_POLICY = "sandbox; default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Where a frame's own violations are reported: the editor host's report route (decision D5). */
export function boxReportUri(editorHost: string): string {
  if (!isExactHostname(editorHost)) throw new Error('the editor host must be an exact host name');
  return `https://${editorHost}/api/csp-report/box`;
}

/** The whole `Content-Security-Policy` of a block's document. */
export function boxDocumentPolicy(siteHosts: unknown, editorHost: string): string {
  return `${BOX_DOCUMENT_POLICY}; frame-ancestors ${frameAncestorsValue(siteHosts, editorHost)}; report-uri ${boxReportUri(editorHost)}`;
}

/** What every answer carries, whatever its status. There is no `Set-Cookie`, ever. */
export const BOX_COMMON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Permissions-Policy': BOX_PERMISSIONS_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
});

/** The headers of a block's document. */
export function boxDocumentHeaders(siteHosts: unknown, editorHost: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': boxDocumentPolicy(siteHosts, editorHost),
    ...BOX_COMMON_HEADERS,
    // Decision D19: the visitor's browser may keep it for five minutes, a shared cache never, and any
    // cache is told that the answer depends on the two headers that decide whether it is given at all.
    'Cache-Control': 'private, max-age=300',
    Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site',
  };
}

/** The headers of every other answer: plain text, never stored, the refusal policy. */
export function boxRefusalHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': BOX_REFUSAL_POLICY,
    ...BOX_COMMON_HEADERS,
    'Cache-Control': 'no-store',
  };
}

/** The two fetch metadata headers a frame request carries. Anything else is a direct visit or a same-site embed, and is refused. */
export function isCrossSiteFrameRequest(secFetchDest: unknown, secFetchSite: unknown): boolean {
  return secFetchDest === 'iframe' && secFetchSite === 'cross-site';
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/**
 * The script that runs first in every document. Version 1 removes the WebRTC
 * constructors and says `hello` to the page; the bridge client (`lumitra.read`
 * and the rest) joins it in slice C3.
 *
 * Removing the constructors is a mitigation, not a boundary (behaviour plan,
 * "The frame"): a script can reach a fresh set through a new realm, such as an
 * empty nested frame, which `frame-src 'none'` does not refuse. Where an
 * engine refuses a fixed property on its window object the shell deletes the
 * name instead; either way the constructor the page started with is gone, and
 * only a fresh realm gives another. Whether `webrtc 'block'` is enforced by
 * any engine is unproven here. Slice C6 probes all of it in three engines
 * (decision D15), and nothing is switched on before that.
 *
 * The text must never hold the character sequence that closes a script
 * element; a test holds that.
 */
export const BOX_SHELL_SCRIPT =
  `/*${BOX_SHELL_MARKER} v${BOX_SHELL_VERSION}*/(function(){'use strict';` +
  "var w=window,n=['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceTransport','RTCSessionDescription','RTCIceCandidate'];" +
  'for(var i=0;i<n.length;i++){' +
  'try{Object.defineProperty(w,n[i],{value:undefined,writable:false,configurable:false,enumerable:false});}' +
  'catch(e){try{delete w[n[i]];}catch(f){}}}' +
  `try{w.parent.postMessage({fc:${BOX_PROTOCOL_VERSION},kind:'hello',shell:${BOX_SHELL_VERSION}},'*');}catch(e){}` +
  '})();';

/** What stands before the author's document in every answer. */
export const BOX_DOCUMENT_PREFIX = `<!doctype html><meta charset="utf-8"><script>${BOX_SHELL_SCRIPT}</script>`;

/** The served document: the constant shell, then the author's document, unchanged. */
export function composeBoxDocument(authorDocument: string): string {
  return BOX_DOCUMENT_PREFIX + authorDocument;
}

// ---------------------------------------------------------------------------
// The declaration and the hash
// ---------------------------------------------------------------------------

export type BoxSizing = 'fixed' | 'content';

/** What a block may touch. Lives in the blob row and is covered by the hash, so a page save cannot widen it. */
export interface CustomCodeDeclaration {
  /** State ids sent to the frame. Only `boolean`, `number` and `choice` state; the type is checked where the page is known. */
  reads: string[];
  /** State ids the frame may set. */
  writes: string[];
  /** `custom:<name>` events the frame may fire. */
  emits: string[];
  sizing: BoxSizing;
  /** False: the frame takes no pointer and no focus (decision D8). */
  interactive: boolean;
}

export type DeclarationResult = { ok: true; declaration: CustomCodeDeclaration } | { ok: false; reason: string };

// The same grammars as the behaviour model's state ids and custom events (src/lib/behaviour/format.ts).
const STATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CUSTOM_EVENT_PATTERN = /^custom:[a-z0-9][a-z0-9_-]{0,63}$/;
const DECLARATION_KEYS = new Set(['reads', 'writes', 'emits', 'sizing', 'interactive']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function listOf(value: unknown, pattern: RegExp, what: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${what} must be a list`;
  if (value.length > BOX_LIMITS.declarationEntries) return `${what} holds more than ${BOX_LIMITS.declarationEntries} entries`;
  const out = new Set<string>();
  // A copy first: the list is read once, whatever it is.
  for (const entry of Array.from(value as unknown[])) {
    if (typeof entry !== 'string' || !pattern.test(entry)) return `${what} holds an entry that is not allowed`;
    out.add(entry);
  }
  return [...out].sort();
}

/**
 * Reads a declaration from untrusted input and returns its one canonical
 * form: every list present, sorted and without repeats. An unknown key, a
 * wrong type or a missing `sizing` or `interactive` is refused with a reason,
 * never repaired: what code may do is stated, not guessed.
 */
export function parseDeclaration(input: unknown): DeclarationResult {
  if (!isPlainObject(input)) return { ok: false, reason: 'a declaration must be an object' };
  for (const key of Object.keys(input)) {
    if (!DECLARATION_KEYS.has(key)) return { ok: false, reason: 'a declaration holds a key that is not allowed' };
  }
  // Each field is read exactly once, so what was checked is what is returned, also for an object with accessors.
  const rawReads = input.reads;
  const rawWrites = input.writes;
  const rawEmits = input.emits;
  const sizing = input.sizing;
  const interactive = input.interactive;
  const reads = listOf(rawReads, STATE_ID_PATTERN, 'reads');
  if (typeof reads === 'string') return { ok: false, reason: reads };
  const writes = listOf(rawWrites, STATE_ID_PATTERN, 'writes');
  if (typeof writes === 'string') return { ok: false, reason: writes };
  const emits = listOf(rawEmits, CUSTOM_EVENT_PATTERN, 'emits');
  if (typeof emits === 'string') return { ok: false, reason: emits };
  if (sizing !== 'fixed' && sizing !== 'content') return { ok: false, reason: 'sizing must be fixed or content' };
  if (typeof interactive !== 'boolean') return { ok: false, reason: 'interactive must be true or false' };
  return { ok: true, declaration: { reads, writes, emits, sizing, interactive } };
}

/** The one text form of a canonical declaration: fixed key order, sorted lists. */
export function canonicalDeclarationJson(declaration: CustomCodeDeclaration): string {
  const parsed = parseDeclaration(declaration);
  if (!parsed.ok) throw new Error(parsed.reason);
  const d = parsed.declaration;
  return JSON.stringify({ emits: d.emits, interactive: d.interactive, reads: d.reads, sizing: d.sizing, writes: d.writes });
}

/** The number of bytes a text takes as UTF-8. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * True when a text holds no half of a surrogate pair on its own. Such a half
 * has no UTF-8 form: an encoder replaces it, so two different texts would get
 * one hash.
 */
export function isWellFormedText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** SHA-256 of a text's UTF-8 bytes, as lower case hex, through the runtime's Web Crypto. Refuses a text that is not well formed. */
export async function sha256Hex(text: string): Promise<string> {
  if (!isWellFormedText(text)) throw new Error('the text holds half of a surrogate pair and cannot be hashed');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The hash a node names: of the canonical manifest
 * `{"v":1,"document":"<sha256 of the text>","declaration":<canonical JSON>}`.
 * It covers the code and the declaration, so changing either is a new hash.
 */
export async function customCodeHash(document: string, declaration: CustomCodeDeclaration): Promise<string> {
  const manifest = `{"v":1,"document":"${await sha256Hex(document)}","declaration":${canonicalDeclarationJson(declaration)}}`;
  return sha256Hex(manifest);
}
