// src/lib/customCode/authoring.ts
//
// The rules for writing a sandboxed custom code block (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4, decisions D99 to
// D112): what a write must hold, what it may declare, and the reason for every
// refusal, each a fixed code, an HTTP status and a sentence a person can act on.
// The editor's panel and the guarded route both run these, so the two refuse
// the same things in the same words; the route runs them again on what arrives,
// whatever the panel did.
//
// PURE: no React, no DOM, no server-only, no database.

import {
  BOX_LIMITS,
  canonicalDeclarationJson,
  isWellFormedText,
  parseDeclaration,
  utf8ByteLength,
  type CustomCodeDeclaration,
} from './contract';
import { readCustomCodeTitle } from './customCode';

/**
 * Whether authoring is offered on this server (decision D99): only the exact
 * value `1` turns it on. Unset, empty, `0`, `true` or a typing mistake mean
 * off, so a server nobody configured offers nothing. Read on the server only.
 */
export function isCustomCodeAvailable(value: unknown): boolean {
  return value === '1';
}

/** The largest request body the write route reads: far above the largest block, even with every character escaped (D103). */
export const CUSTOM_CODE_REQUEST_MAX_BYTES = 1024 * 1024;

/** Writes of new code per site and hour (plan "Limits and abuse handling", D106). */
export const CUSTOM_CODE_WRITES_PER_HOUR = 30;

/** Every reason a write is refused, with its status. */
export const REFUSAL_STATUS = {
  custom_code_unavailable: 404,
  title_invalid: 400,
  document_empty: 400,
  document_nul: 400,
  document_not_well_formed: 400,
  declaration_invalid: 400,
  too_large: 413,
  branch_site: 409,
  custom_code_off: 409,
  blocked: 410,
  node_not_saved: 409,
  not_a_block: 409,
  replaces_mismatch: 409,
  declaration_state: 422,
  rate_limited: 429,
  site_budget: 413,
} as const;

export type RefusalCode = keyof typeof REFUSAL_STATUS;

export interface CustomCodeRefusal {
  code: RefusalCode;
  status: number;
  message: string;
  /** For `rate_limited`: when the next write is allowed. */
  retryAfterSeconds?: number;
}

export function refusal(code: RefusalCode, message: string, extra: { retryAfterSeconds?: number } = {}): CustomCodeRefusal {
  return { code, status: REFUSAL_STATUS[code], message, ...extra };
}

/** A byte count in words, for a sentence. */
export function sizeInWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 102.4) / 10} KB`;
  return `${Math.ceil(bytes / (1024 * 102.4)) / 10} MB`;
}

export interface CustomCodeInput {
  title: unknown;
  document: unknown;
  declaration: unknown;
}

export interface CheckedCustomCode {
  title: string;
  document: string;
  declaration: CustomCodeDeclaration;
  /** Code plus canonical declaration, in bytes of UTF-8: what counts against the limits. */
  bytes: number;
}

export type CheckResult = { ok: true; value: CheckedCustomCode } | { ok: false; refusal: CustomCodeRefusal };

/**
 * What a write holds, checked on its own (D103): a title the renderers accept,
 * code that is not empty and that Postgres and the hash can hold, a declaration
 * of the right shape, and at most 256 kilobytes of code and declaration
 * together. The check against the page is declarationStateRefusal.
 */
export function checkCustomCodeInput(input: CustomCodeInput): CheckResult {
  const title = readCustomCodeTitle(input.title);
  if (title === null) {
    return { ok: false, refusal: refusal('title_invalid', 'Give the block a title of 1 to 200 visible characters. It is what a screen reader announces for the frame.') };
  }
  const document = input.document;
  if (typeof document !== 'string' || document.trim() === '') {
    return { ok: false, refusal: refusal('document_empty', 'Write some code before saving: an empty block would only ever show its fallback.') };
  }
  if (document.includes('\u0000')) {
    return { ok: false, refusal: refusal('document_nul', 'The code holds a NUL character (U+0000), which cannot be stored. Remove it and save again.') };
  }
  if (!isWellFormedText(document)) {
    return { ok: false, refusal: refusal('document_not_well_formed', 'The code holds half of a surrogate pair (a broken emoji or symbol). Retype that character and save again.') };
  }
  const parsed = parseDeclaration(input.declaration);
  if (!parsed.ok) {
    return { ok: false, refusal: refusal('declaration_invalid', `The declaration is not valid: ${parsed.reason}.`) };
  }
  const bytes = utf8ByteLength(document) + utf8ByteLength(canonicalDeclarationJson(parsed.declaration));
  if (bytes > BOX_LIMITS.documentBytes) {
    return {
      ok: false,
      refusal: refusal('too_large', `The code is ${sizeInWords(bytes)}; a block holds at most ${sizeInWords(BOX_LIMITS.documentBytes)}, code and declaration together.`),
    };
  }
  return { ok: true, value: { title, document, declaration: parsed.declaration, bytes } };
}

/** A state in reach of the block, as the declaration check needs it. */
export interface StateInReach {
  id: string;
  name: string;
  type: 'boolean' | 'number' | 'choice' | 'text';
}

/** The state types a frame may read or write: never `text` (M4). */
export const FRAME_STATE_TYPES: ReadonlySet<StateInReach['type']> = new Set(['boolean', 'number', 'choice']);

/**
 * The first read or write that does not name a state in reach of the block, or
 * names a text state, as a refusal; null when every one does. The same rule
 * the published page applies when it draws the block (applyCustomCode), so a
 * declaration the route accepts is one the page will run.
 */
export function declarationStateRefusal(declaration: CustomCodeDeclaration, reach: readonly StateInReach[]): CustomCodeRefusal | null {
  // The nearest declaration of an id wins, as the runtime's lookup does: reach lists the nearest last.
  const byId = new Map<string, StateInReach>();
  for (const state of reach) byId.set(state.id, state);
  for (const [list, verb] of [[declaration.reads, 'reads'], [declaration.writes, 'writes']] as const) {
    for (const id of list) {
      const state = byId.get(id);
      if (!state) {
        return refusal('declaration_state', `The block ${verb} the value ${id}, which does not stand on this block or above it. Pick a value from the list, or add it in Page state first.`);
      }
      if (!FRAME_STATE_TYPES.has(state.type)) {
        return refusal('declaration_state', `The block ${verb} "${state.name}", a text value. A frame only reads and writes on or off, number and choice values.`);
      }
    }
  }
  return null;
}

/**
 * The plain sentence the panel shows under the pickers: what the code may read,
 * write and fire, and how it sits on the page. `nameOf` turns a state id into
 * the name a person gave it.
 */
export function describeDeclaration(declaration: CustomCodeDeclaration, nameOf: (id: string) => string): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${nameOf(id)}"`).join(', ');
  const parts: string[] = [];
  parts.push(declaration.reads.length ? `It can read ${list(declaration.reads)}` : 'It reads no value of the page');
  parts.push(declaration.writes.length ? `it can change ${list(declaration.writes)}` : 'it changes none');
  parts.push(
    declaration.emits.length
      ? `and it can fire ${declaration.emits.map((name) => `"${name.slice('custom:'.length)}"`).join(', ')}`
      : 'and it fires no event',
  );
  const sizing = declaration.sizing === 'content' ? 'Its height follows its content, up to 10,000 pixels.' : 'It takes the size of its box.';
  const pointer = declaration.interactive ? 'Visitors can click into it and type in it.' : 'Clicks and the keyboard pass through it to the page.';
  return `${parts.join(', ')}. ${sizing} ${pointer} It never reaches the page itself, cookies or the network.`;
}

/** The state ids a declaration names, for the stored-copy check. */
export function declaredStateIds(declaration: CustomCodeDeclaration): string[] {
  return [...new Set([...declaration.reads, ...declaration.writes])];
}
// ci-replay touch
