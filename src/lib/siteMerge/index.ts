// src/lib/siteMerge/index.ts
//
// The merge engine of site branches (docs/plans/2026-11-10-site-branches.md, section 5, slice S2): pure,
// client and server safe. The server (S3) loads the three documents, runs them through the editor model
// (decision 35), merges, checks the result and writes it; the review screen (S5) shows the conflicts and
// sends the answers back.
//
// Answers are an input, not a step: the caller runs `mergeDocuments` again with all answers given so far,
// until `conflicts` is empty. An answer can bring up a conflict that was not there before (keeping a page the
// other side removed can put two pages on one address), and an answer whose conflict no longer comes up is
// simply not used. An answer applies only while its conflict's three values are what they were when it was
// given (its fingerprint), so a change on main or the branch asks it again.

export { mergeDocuments, type DocumentMerge, type MergeDocument, type MergePage } from './document';
export { mergedDocumentProblems, type MergeProblem, type ToProject } from './validate';
export { countChanges, diffDocuments, type DocumentChanges, type UnitChanges } from './diff';
export { danglingReferences, type DanglingReference } from './references';
export { conflictId, type ConflictKind, type MergeAnswers, type MergeConflict, type MergeSide, type MergeUnit } from './types';
