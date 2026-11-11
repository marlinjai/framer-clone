// src/lib/siteMerge/types.ts
//
// What a merge of site branches answers (docs/plans/2026-11-10-site-branches.md, section 5): conflicts with
// stable ids and the answers a person gives them. An answer is keyed to the conflict's id and to a
// fingerprint of its base, main and branch values (section 6, "Derived state"): when any of the three
// changes, the answer no longer applies and the conflict is asked again.
//
// PURE: client and server safe.

import { fingerprint } from './value';

export type MergeSide = 'main' | 'branch';

/**
 * - `value`: both sides changed the same part differently (rule 3, 11).
 * - `moved`: a node moved to different places on both sides (rule 7).
 * - `order`: both sides reordered the same parent's children (rule 8).
 * - `removed`: removed on one side, changed on the other (rule 6); `removedOn` names the side that removed.
 *   Picking that side removes it, picking the other keeps it with its changes.
 * - `added-twice`: the same id added on both sides with different content (rule 4).
 * - `cycle`: two moves that are fine alone put a node inside itself together.
 * - `slug`: two pages end with the same address (rule 9); the picked side's page keeps it.
 * - `reference`: something left pointing at a removed thing (rule 10), reported on the removed thing.
 */
export type ConflictKind = 'value' | 'moved' | 'order' | 'removed' | 'added-twice' | 'cycle' | 'slug' | 'reference';

/** What a conflict is about: the site, its settings, a page, a node of a page or component, a component. */
export interface MergeUnit {
  kind: 'site' | 'settings' | 'page' | 'node' | 'component';
  id: string;
  /** The page or component definition a node lives in (`page:<id>` or `component:<id>`). */
  container?: string;
}

export interface MergeConflict {
  /** Stable across runs on the same three documents: unit and part, never a position or a value. */
  id: string;
  kind: ConflictKind;
  unit: MergeUnit;
  /** The part of the unit, as keys (`['props', 'style', 'color']`); empty for the whole unit. */
  path: string[];
  base: unknown;
  main: unknown;
  branch: unknown;
  /** The fingerprint an answer must carry to apply: of base, main and branch. */
  fingerprint: string;
  /** For `removed`: the side that removed it. */
  removedOn?: MergeSide;
  /** The answers this conflict takes. Usually both sides; a rule may allow only one (the home page's address). */
  options: MergeSide[];
}

/** The answers given so far, by conflict id. */
export type MergeAnswers = Readonly<Record<string, { fingerprint: string; pick: MergeSide }>>;

/** Collects conflicts and looks up answers that still apply. */
export class ConflictLog {
  readonly open: MergeConflict[] = [];
  /** Conflicts that had an answer that applied, with that answer (for the review's "settled" list). */
  readonly settled: Array<{ conflict: MergeConflict; pick: MergeSide }> = [];

  constructor(private readonly answers: MergeAnswers = {}) {}

  /**
   * Report a conflict; answer the side to take when an answer with the same fingerprint was given, else
   * undefined (the caller takes main's side and the conflict stays open).
   */
  ask(input: Omit<MergeConflict, 'fingerprint' | 'options'> & { options?: MergeSide[] }): MergeSide | undefined {
    const conflict: MergeConflict = {
      ...input,
      options: input.options ?? ['main', 'branch'],
      fingerprint: fingerprint(input.id, input.base, input.main, input.branch),
    };
    const answer = this.answers[conflict.id];
    if (answer && answer.fingerprint === conflict.fingerprint && conflict.options.includes(answer.pick)) {
      this.settled.push({ conflict, pick: answer.pick });
      return answer.pick;
    }
    this.open.push(conflict);
    return undefined;
  }
}

/** The conflict id of a part of a unit. */
export function conflictId(unit: MergeUnit, kind: ConflictKind, path: readonly string[] = []): string {
  return [unit.container ?? '', `${unit.kind}:${unit.id}`, kind, ...path].join('|');
}
