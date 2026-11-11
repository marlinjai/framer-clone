// src/lib/sites/branches.ts
//
// The rules of a site branch that the server and the editor share (plan
// docs/plans/2026-11-10-site-branches.md). PURE and client-safe: no Prisma, no
// `server-only`, so the editor's dialogs refuse exactly what the server refuses.

/** At most this many open branches per site (decision 11; a plan tier, if any, replaces the constant). */
export const MAX_OPEN_BRANCHES_PER_SITE = 10;

/** A branch name is at most this many characters (code points), after cleaning. */
export const BRANCH_NAME_MAX_LENGTH = 60;

/** The states a branch record can be in. `open` and `ready` hold content; the other two are closed for good. */
export type BranchStatus = 'open' | 'ready' | 'merged' | 'discarded';

export function isOpenBranchStatus(status: BranchStatus): status is 'open' | 'ready' {
  return status === 'open' || status === 'ready';
}

// Control characters (C0, C1, DEL, line and paragraph separators) and bidirectional embedding, override and
// isolate controls. They are removed rather than refused: a pasted name keeps its readable part.
const REMOVED = /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
// A name made only of invisible format characters and whitespace reads as empty.
const ONLY_INVISIBLE = /^[\p{Cf}\s]*$/u;

export type BranchNameResult = { ok: true; name: string } | { ok: false; message: string };

/** Clean (remove control and bidirectional characters, collapse whitespace, trim) and check a branch name. */
export function validateBranchName(raw: unknown): BranchNameResult {
  if (typeof raw !== 'string') return { ok: false, message: 'A branch needs a name.' };
  const name = raw.replace(REMOVED, ' ').replace(/\s+/gu, ' ').trim();
  if (name.length === 0 || ONLY_INVISIBLE.test(name)) return { ok: false, message: 'A branch needs a name.' };
  if (Array.from(name).length > BRANCH_NAME_MAX_LENGTH) {
    return { ok: false, message: `A branch name can be at most ${BRANCH_NAME_MAX_LENGTH} characters.` };
  }
  return { ok: true, name };
}

