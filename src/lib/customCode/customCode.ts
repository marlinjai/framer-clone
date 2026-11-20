// src/lib/customCode/customCode.ts
//
// What a page node says about a sandboxed custom code block, read by every
// renderer (plan docs/plans/2026-11-02-sandboxed-custom-code.md, "How a block
// is embedded", D4, D7, D16 and D36 onward).
//
// A block is an ordinary node whose `props.customCode` names the code by hash:
//
//   { sha256: '<64 lower case hex>', title: '<the frame's accessible name>' }
//
// or, written by an agent or the importer and never run, a proposal:
//
//   { proposal: '<id of a custom_code_proposals row>', title: '...' }
//
// The node's children are the fallback. Anything else in `customCode` is
// invalid, and an invalid value, a proposal and a block alike show only the
// fallback wherever the code cannot run. The value never reaches the DOM: the
// renderers draw the block from the parsed value, and the frame's address is
// built from the rendering site's id and the hash (contract.ts), never from
// stored text.
//
// Also the application's side of two switches the middleware reads at run time:
// the kill switch `CUSTOM_CODE_DISABLED` (read exactly as the box reads it,
// decision D16) and the box's origin `SANDBOX_ORIGIN` (decision D37).
//
// PURE: no React, no DOM, no server-only. The edge middleware imports it, so it
// imports nothing but the import-free contract.

import { BOX_SHA256_PATTERN, isExactHostname } from './contract';

/** The prop of a block. Never an attribute. */
export const CUSTOM_CODE_PROP = 'customCode';

/** The renderers' own attribute on a published block: the first characters of its hash, so a report can be traced. */
export const CUSTOM_CODE_ATTR = 'data-fc-custom-code';

/** How many hex characters of the hash the attribute shows. Enough to find the blob, not the whole address. */
export const CUSTOM_CODE_TRACE_LENGTH = 12;

/** The longest title kept. */
export const CUSTOM_CODE_TITLE_MAX = 200;

/** A proposal's id: what the proposals table writes (a UUID or a similar token), nothing that could be markup or a path. */
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// C0 and C1 controls, and the line and paragraph separators.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Characters that change how a title reads without being seen: every format character
 * (Unicode category Cf: the bidirectional marks, embeddings, overrides and isolates, so
 * a title cannot read backwards in the editor or, from slice C3, in a frame's `title`;
 * the zero-width characters; the soft hyphen; the byte order mark; the interlinear
 * annotation marks) and every default-ignorable code point, which a renderer draws as
 * nothing (the tag characters and the rest of U+E0000 to U+E0FFF, assigned or not, all
 * the variation selectors, the combining grapheme joiner, the Hangul fillers, the Khmer
 * inherent vowels U+17B4 and U+17B5, the Mongolian selectors): invisible text an agent
 * reading the title would still see. Besides them, the blank braille pattern, which
 * draws nothing, and the object replacement character, which stands for something not
 * shown at all. The two joiners pass only where they shape visible text (see below).
 */
const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\ufffc]/u;
/**
 * The text and emoji presentation selectors where they make a visible choice: once,
 * right after a pictograph (`\u2764\ufe0f`), and in a keycap (`1\ufe0f\u20e3`). Taken
 * out before the check above; anywhere else they are hidden bytes like the others.
 */
const PRESENTATION_AFTER_PICTOGRAPH = /(\p{Extended_Pictographic})[\ufe0e\ufe0f]/gu;
const KEYCAP = /([0-9#*])\ufe0f(?=\u20e3)/gu;
/** The scripts whose spelling needs the zero-width non-joiner or joiner: Arabic and Syriac, and the Indic scripts. */
const JOINING_SCRIPT =
  '\\p{sc=Arabic}\\p{sc=Syriac}\\p{sc=Devanagari}\\p{sc=Bengali}\\p{sc=Gurmukhi}\\p{sc=Gujarati}\\p{sc=Oriya}\\p{sc=Tamil}\\p{sc=Telugu}\\p{sc=Kannada}\\p{sc=Malayalam}\\p{sc=Sinhala}';
/**
 * The zero-width non-joiner and joiner where a word needs them (decision D97): one,
 * between two characters of a joining script, as Persian writes `\u06a9\u062a\u0627\u0628\u200c\u0647\u0627`
 * ("books") and Sinhala `\u0dc1\u0dca\u200d\u0dbb\u0dd3` ("Sri"). Taken out before the check above;
 * at a word's edge, doubled, or between Latin letters it is a hidden byte.
 */
const SCRIPT_JOINER = new RegExp(`(?<=[${JOINING_SCRIPT}])[\\u200c\\u200d](?=[${JOINING_SCRIPT}])`, 'gu');
/**
 * One zero-width joiner between two pictographs, which draws them as one emoji (a
 * technologist, a rainbow flag, a family); the left one may carry its presentation
 * selector or a skin tone. The flags built from tag characters (England, Scotland,
 * Wales) stay refused: their letters are hidden.
 */
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})?)\u200d(?=\p{Extended_Pictographic})/gu;
/**
 * Most code points one user-perceived character may hold. Real text measured on the
 * grapheme rules of Unicode 17 reaches ten: a kiss with two skin tones; Sanskrit's
 * `\u0915\u093e\u0930\u094d\u0924\u094d\u0938\u094d\u0928\u094d\u092f` holds nine in one conjunct, ten with a joiner inside it. Twelve
 * leaves that margin; a letter carrying a pile of combining marks, a way to smear text
 * or hide bytes, is still refused.
 */
export const CUSTOM_CODE_TITLE_CLUSTER_MAX = 12;
/** A character someone can see: a letter, a number, a symbol or a punctuation mark. */
const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{S}\p{P}]/u;
/** Half of a surrogate pair without its other half: not a character at all. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type CustomCodeValue =
  | { kind: 'block'; sha256: string; title: string }
  | { kind: 'proposal'; proposal: string; title: string };

export type CustomCodeParse = { ok: true; value: CustomCodeValue } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Grapheme clusters, the characters a reader sees, where the runtime can split them. */
let graphemes: Intl.Segmenter | null | undefined;

/**
 * The most code points in one character of the text. Node, every current browser and
 * the edge runtime have Intl.Segmenter; without it a character is counted as a base and
 * the combining marks that follow it, which is what the cap is about.
 */
function largestCluster(text: string): number {
  if (graphemes === undefined) graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  let largest = 0;
  if (graphemes) {
    for (const { segment } of graphemes.segment(text)) largest = Math.max(largest, [...segment].length);
    return largest;
  }
  for (const run of text.match(/\P{M}?\p{M}*/gu) ?? []) largest = Math.max(largest, [...run].length);
  return largest;
}

/**
 * The title as shown: white space runs folded to one space and trimmed. A title
 * that is not a string, is empty, is longer than CUSTOM_CODE_TITLE_MAX, or holds a
 * control character, an invisible formatting character or a lone surrogate half is
 * refused, never repaired further.
 */
function readTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (CONTROL_CHARACTERS.test(value.replace(/[\t\n\r]/g, ' '))) return null;
  if (LONE_SURROGATE.test(value)) return null;
  if (INVISIBLE_CHARACTERS.test(value.replace(SCRIPT_JOINER, '').replace(EMOJI_JOINER, '').replace(PRESENTATION_AFTER_PICTOGRAPH, '$1').replace(KEYCAP, '$1'))) return null;
  if (largestCluster(value) > CUSTOM_CODE_TITLE_CLUSTER_MAX) return null;
  const title = value.replace(/\s+/g, ' ').trim();
  // Not blank: a title made only of spaces and marks would name nothing.
  if (!VISIBLE_CHARACTER.test(title)) return null;
  return title.length <= CUSTOM_CODE_TITLE_MAX ? title : null;
}

/**
 * Reads `props.customCode` from untrusted stored data. Exactly the two keys of a
 * block or of a proposal, each of the right shape; any other key, a hash in
 * upper case or of another length, a missing or unusable title, an object with a
 * prototype of its own: refused with a reason. Each field is read once, so what
 * was checked is what is returned, also for an object with accessors.
 */
export function parseCustomCode(input: unknown): CustomCodeParse {
  if (!isPlainObject(input)) return { ok: false, reason: 'customCode must be an object' };
  const keys = Object.keys(input);
  if (keys.length !== 2) return { ok: false, reason: 'customCode holds exactly a hash or a proposal, and a title' };
  const rawTitle = input.title;
  if (keys.includes('sha256') && keys.includes('title')) {
    const sha256 = input.sha256;
    if (typeof sha256 !== 'string' || !BOX_SHA256_PATTERN.test(sha256)) {
      return { ok: false, reason: 'sha256 must be 64 lower case hex characters' };
    }
    const title = readTitle(rawTitle);
    if (title === null) return { ok: false, reason: 'a block needs a printable title' };
    return { ok: true, value: { kind: 'block', sha256, title } };
  }
  if (keys.includes('proposal') && keys.includes('title')) {
    const proposal = input.proposal;
    if (typeof proposal !== 'string' || !PROPOSAL_ID_PATTERN.test(proposal)) {
      return { ok: false, reason: 'a proposal id is not of the right shape' };
    }
    const title = readTitle(rawTitle);
    if (title === null) return { ok: false, reason: 'a proposal needs a printable title' };
    return { ok: true, value: { kind: 'proposal', proposal, title } };
  }
  return { ok: false, reason: 'customCode holds a key that is not allowed' };
}

/** True when the props hold a `customCode` of their own, whatever its value: the renderers then draw the node as a block. */
export function hasCustomCode(props: unknown): boolean {
  return typeof props === 'object' && props !== null && !Array.isArray(props) && Object.prototype.hasOwnProperty.call(props, CUSTOM_CODE_PROP);
}

/** The value of the trace attribute for a hash. */
export function customCodeTrace(sha256: string): string {
  return sha256.slice(0, CUSTOM_CODE_TRACE_LENGTH);
}

/** `props` without `customCode`; the same object when there is none. */
export function withoutCustomCodeProp<P extends Record<string, unknown>>(props: P): P {
  if (!Object.prototype.hasOwnProperty.call(props, CUSTOM_CODE_PROP)) return props;
  const { [CUSTOM_CODE_PROP]: _dropped, ...rest } = props;
  void _dropped;
  return rest as P;
}

/** The part of a stored node this module reads: its props and its children. */
export interface CustomCodeTreeNode {
  props?: Record<string, unknown>;
  children?: CustomCodeTreeNode[];
}

/**
 * A node and every descendant without `props.customCode`, for a node that crosses
 * into a client island (a form, a shop control): an island's props are serialized
 * into the page's script data, and nothing of a block's stored value may reach the
 * page (decisions D36, D45 and D95). Unchanged nodes are returned as they are.
 */
export function withoutCustomCodeTree<N extends CustomCodeTreeNode>(node: N): N {
  const props = node.props ? withoutCustomCodeProp(node.props) : node.props;
  let children = node.children;
  if (Array.isArray(node.children)) {
    const next = node.children.map((child) => (child && typeof child === 'object' ? withoutCustomCodeTree(child) : child));
    if (next.some((child, i) => child !== node.children![i])) children = next;
  }
  if (props === node.props && children === node.children) return node;
  return { ...node, props, children } as N;
}

// ---------------------------------------------------------------------------
// The switches the application reads at run time
// ---------------------------------------------------------------------------

/**
 * Whether custom code may run at all, read exactly as the box reads its kill
 * switch (decision D16, services/box/src/config.ts): only the value `0` serves.
 * Unset, empty, `1`, `false` or a typing mistake all mean every block shows its
 * fallback. A test holds the two readings equal.
 */
export function isCustomCodeServing(value: unknown): boolean {
  return value === '0';
}

/**
 * The box's origin from configuration (decision D37): exactly `https://` and an
 * exact host name, nothing before or after. Anything else, unset included, is
 * null, and then no page may frame the box at all: the domain is not live yet,
 * and a default naming it would allow frames from a host nobody controls.
 */
export function sandboxOriginFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  const host = value.slice('https://'.length);
  return isExactHostname(host) ? `https://${host}` : null;
}

/**
 * The `frame-src` source of the box on this server, or null when no page may
 * frame it: the kill switch is on, or no valid origin is configured. Only ever
 * the box's path, `/box/`, never the whole origin.
 */
export function boxFrameSource(env: { CUSTOM_CODE_DISABLED?: string; SANDBOX_ORIGIN?: string }): string | null {
  if (!isCustomCodeServing(env.CUSTOM_CODE_DISABLED)) return null;
  const origin = sandboxOriginFrom(env.SANDBOX_ORIGIN);
  return origin === null ? null : `${origin}/box/`;
}

/**
 * The start-time message for a SANDBOX_ORIGIN that is set but unusable, or null.
 * Unset is not a mistake: it is how a server without custom code runs.
 */
export function sandboxOriginProblem(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return sandboxOriginFrom(value) === null
    ? 'SANDBOX_ORIGIN must be https:// and an exact host name, such as https://run.example.com; custom code frames stay refused until it is'
    : null;
}

/** Where the editor's tile links to: the standalone preview of the page, which runs blocks. */
export function customCodePreviewHref(projectId: string, pageId: string | null): string {
  const base = `/projects/${encodeURIComponent(projectId)}/preview`;
  return pageId ? `${base}?page=${encodeURIComponent(pageId)}` : base;
}
