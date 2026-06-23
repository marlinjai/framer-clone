// src/lib/renderer/publish/trackerSnippet.ts
//
// Builds the analytics tracker `<head>` snippet injected into published pages
// (publish spec P2c). The snippet does two things:
//   1. Publishes `window.__AP_VARIANTS` — the server-decided experiment-arm
//      assignment for THIS artifact, so events the published site emits are
//      tagged with the variant the edge served (the P3/P4 cookie-bridge consumes
//      this). The control baseline ships `{}` (no forced arm).
//   2. Publishes `window.__AP_CONFIG` — the PUBLIC ingestion config: the
//      `ap_live_` ingestion key (public-by-design), the ingestion endpoint, and
//      the analytics project id.
//
// SECRET HARD-LINE: this module embeds ONLY the public ingestion key. The
// `LumitraBindingModel.apiKeyRef` (a server-side secret reference) is resolved to
// the literal `ap_live_` key by the CALLER, server-side, off the publish path —
// never in MST, never in the build artifact. As a defensive backstop this module
// REFUSES to embed a key that looks non-public (account/secret-shaped), so a
// mis-wired caller can never leak a secret into shipped HTML.

export interface TrackerSnippetInput {
  /** The PUBLIC ingestion key (`ap_live_...`), resolved server-side by the caller. */
  ingestionKey: string;
  /** The analytics ingestion endpoint URL. */
  ingestionEndpoint: string;
  /** The analytics project id, if known. */
  projectId?: string;
  /**
   * The server-decided experiment-arm assignment for this artifact, e.g.
   * `{ 'hero-cta': 'b' }`. Omitted/empty for the control baseline.
   */
  variants?: Record<string, string>;
  /** Optional tracker loader script URL appended as `<script async src>`. */
  trackerScriptSrc?: string;
}

// A key that matches any of these is treated as NON-public and refused.
const NON_PUBLIC_KEY_PATTERNS: RegExp[] = [
  /^ap_account_/i,
  /^ap_secret_/i,
  /secret/i,
];

// U+2028 / U+2029 are valid in JSON strings but act as line terminators inside a
// `<script>`, so they must be escaped when embedding JSON in inline script. Built
// via `RegExp` from a `\u` escape because a literal separator char is itself a
// source line terminator and cannot appear in a regex literal.
const LINE_SEP = new RegExp(' ', 'g');
const PARA_SEP = new RegExp(' ', 'g');

/**
 * Build the tracker `<head>` snippet HTML. Throws when `ingestionKey` is missing
 * or looks non-public (the secret backstop).
 */
export function buildTrackerSnippet(input: TrackerSnippetInput): string {
  if (!input.ingestionKey) {
    throw new Error('buildTrackerSnippet: ingestionKey is required');
  }
  if (NON_PUBLIC_KEY_PATTERNS.some((re) => re.test(input.ingestionKey))) {
    throw new Error(
      'buildTrackerSnippet: refusing to embed a non-public ingestion key in published HTML',
    );
  }

  const config = {
    key: input.ingestionKey,
    endpoint: input.ingestionEndpoint,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  const variants = input.variants ?? {};

  const parts: string[] = [
    `<script>window.__AP_VARIANTS=${safeJson(variants)};` +
      `window.__AP_CONFIG=${safeJson(config)};</script>`,
  ];
  if (input.trackerScriptSrc) {
    parts.push(`<script async src="${escapeAttr(input.trackerScriptSrc)}"></script>`);
  }
  return parts.join('');
}

/**
 * JSON for safe inline-`<script>` embedding: escapes the characters that could
 * break out of the script element or terminate it early.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
