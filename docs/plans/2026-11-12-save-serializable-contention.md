---
type: plan
status: in-progress
date: 2026-11-12
title: "Saving a site fails with a serialization conflict because of other sites' saves"
summary: "The site save runs at the SERIALIZABLE isolation level and retries four times at once. Under PostgreSQL's predicate locking, saves of different sites conflict with each other, so a save can fail after its retries whenever other sites are written at the same moment. Found when the publishedCopy integration test failed on pull request 390, reproduced locally, and not caused by that pull request. Decided 2026-11-12 (option A, approved through the coordinator); built, with the invariants the isolation level carried named and tested."
tags: [framer-clone, sites, concurrency, postgres, ci]
projects: [framer-clone]
---

# Saving a site fails with a serialization conflict because of other sites' saves

## What happened

On 2026-11-12 the `verify` check of pull request 390 (head items on the published page) failed in
`src/server/sites/__tests__/publishedCopy.itest.ts`, the test "a body near the limit publishes, on a site from before revisions too":

```
PrismaClientKnownRequestError: Invalid `tx.sitePage.upsert()` invocation in repository.ts:894
Transaction failed due to a write conflict or a deadlock. Please retry your transaction      (code P2034)
  at LatestVersionRepository.writeWorkingCopy repository.ts:894
  at withSerializationRetry repository.ts:125   (SERIALIZATION_ATTEMPTS = 4)
  at LatestVersionRepository.saveProject repository.ts:598
```

Everything else passed (1,143 of 1,144 integration tests, 13,624 unit tests). The pull request changes no repository code. Its only
earlier red `verify` on main (run 43147439768) was an unrelated jsdom test, so this is the first sighting of P2034 in the logs
looked at, which is not evidence that it is rare.

## Is it test isolation or a real defect

**Not test isolation.** Each test of that file saves its own site (`randomUUID()`), its own workspace and a tenant group that no other
file uses, and no other file deletes that group's sites. The test competes with nobody for a row.

**It is a real property of the save path.** `saveProject` (`repository.ts:598`) runs `SERIALIZABLE` and wraps the transaction in
`withSerializationRetry`, which retries P2034 and P2002 up to four attempts with no pause. PostgreSQL enforces `SERIALIZABLE` with
predicate locks on what a transaction read, and it coarsens them: this database has `max_pred_locks_per_page = 2` and
`max_pred_locks_per_relation = -2`, so after two index entries on a page the lock covers the page, and after enough pages it covers
the relation. A save reads and writes `sites`, `site_pages` and their indexes through upserts and a `deleteMany ... notIn`, so
two saves of **different** sites that touch the same index or heap pages see a read/write dependency in both directions and one is
aborted. The abort is a false positive for the invariant the isolation level is there for, which is per site (the redirect list is read,
changed and written back, so two saves of one site must not each lose the other's entry).

## Measured

`ssi-experiment.test.ts` in `~/software-dev/decision-pages/2026-11-12-save-contention-evidence/` (with the full log of the failed job, its excerpt and a README; the script is to become the regression test of the fix), run through
`vitest.integration.config.ts` against the integration Postgres, saving through `latestVersionRepository` and counting
`prisma.$transaction` calls to see retries:

| Big save | Other writers | Big saves | Failed after four attempts | Transactions started (6 saves, no retry would be 6) |
|---|---|---|---|---|
| 100 pages of 95 kilobytes | none | 6 | **0** | 6 |
| 100 pages of 95 kilobytes | six loops saving small sites | 6 | **6** | 208 |
| 3 pages of 95 kilobytes | six loops saving small sites | 6 | **4** | 206 |

So it is not the size of the save: three pages fail too. It is other sites being written at the same time. The load of the experiment
is harsh (six loops with no pause), and CI's own load is whatever the other 87 files make of it; a production database with many tenants saving
at once is the same shape, with longer gaps between writers and the same four immediate retries.

## What a fix must satisfy

1. A save of one site never fails because of a save, publish or delete of another site. The experiment above is the test: zero failures
   with six background writers.
2. Two saves of the same site still cannot both write a redirect list that lacks the other's entry, and the version lock
   (`expectedVersion`) still refuses the second writer, exactly as `versionLock.itest.ts` and `publishedCopy.itest.ts` prove today.
3. The first save of a new site (no row to lock yet) and a save racing a publish (`publishedCopy.itest.ts`, "a save racing a publish never lands
   in the revision") stay correct.

## Options

- **A. Lock the site, not the table.** Take the site row first (`SELECT id FROM public.sites WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, which
  `publishProject` already does at `repository.ts:1090`, and a `pg_advisory_xact_lock(hashtext('site_save:' || id))` for a site that does not exist
  yet) and run the save at `READ COMMITTED`. Writers of one site queue; writers of different sites do not interact. Needs the first-save race
  (a unique violation on the new row, which `withSerializationRetry` already retries as P2002) and every read inside the transaction checked for
  the lost-update it relied on `SERIALIZABLE` to prevent. The same change applies to the other `SERIALIZABLE` transactions at
  `repository.ts:1131` and `siteImages.ts:257`.
- **B. Keep `SERIALIZABLE`, retry better.** Exponential backoff with jitter and more attempts. Smaller change, and it only makes the
  failure rarer: the conflict is still there, the saves of a busy site still do work twice, and a failure remains possible at the end of the
  retries.
- **C. Raise `max_pred_locks_per_page` and `max_pred_locks_per_transaction` on the database.** Fewer promotions, fewer false conflicts, more memory
  in shared memory; an infrastructure setting outside this repository, and it still leaves true page-level overlaps.

Recommendation: **A** for the save, with B's jittered retry kept as a backstop for the first-save race. No product or pricing decision is in it.
It changes the save path of every site, so it ships as its own pull request, with the experiment as an integration test, the existing lock and race
tests green, and an independent review of the transaction ordering before anything is deployed.

## Decision

On 2026-11-12 Marlin approved, through the coordinator (w2:p11), developing option A, subject to validating the design and an independent review: "take care of the Sites save contention issue and finish it". The
isolation level is not weakened: the save is serialised by locking the site instead of by the database's predicate locking, and every invariant the isolation level carried for this write path is
named below with the lock or comparison that now carries it, and a test. The failing check was not bypassed; #390 stays held until this has landed (inbox entry `20261112-062705-site-head-model`).

## As built

**Precedents in this repository.** `publishProject` already takes the site row `FOR UPDATE` first and runs `writeWorkingCopy` at the default (read committed) level; its `mustExist` UPDATE repeats the version comparison in its
`WHERE`. The branch merge's undo (`merge.ts`, `UNDO_TRANSACTION`) records the same finding in a comment: "Serializable would add nothing but failures against unrelated transactions that happen to read the same tables (seen in the integration tests, six retries in a row)".

**The save** (`SiteRepository.saveProject`, `lockSiteForSave`) runs at read committed behind three locks, in this order:

1. `pg_advisory_xact_lock(hashtext('site_save:' || id))`: two creators of one id queue although there is no row to lock yet. The second then finds the first's site and is refused by the version lock (`SiteVersionRequiredError`).
2. For a branch that names an uploaded image, **main's row `FOR SHARE`**. An image delete takes main's row `FOR UPDATE`, so a delete and such a save cannot overlap. Shared, so branch saves do not wait for one another here.
3. The site's own row `FOR UPDATE`, as publish takes it.

Main is always taken before the branch, the order of the branch merge's `lockPair` and of an erase of personal data (main, then its branches by id), so no two writers wait for each other in a circle.
`withSerializationRetry` stays, for a deadlock (P2034) and for the first-save unique violation (P2002).

**The image delete** (`deleteSiteImage`) drops from serializable to read committed. It already took main's row `FOR UPDATE` and the image advisory lock, and every statement after the lock now sees what the writers it waited for committed. Left serializable it would
have been protected against a branch save only if it locked a row that save modifies (a branch save modifies only the branch's row), which is exactly the gap an audit of the remaining serializable transactions found.

### The invariants, and what carries them now

| Invariant | Carried by | Test (`saveLocking.itest.ts` unless named) |
|---|---|---|
| One writer of a site at a time; the second sees the first's write | the site row lock (save, publish, merge, erase) | ten saves on one version: one wins, nine `SiteChangedError`; a save behind a held lock waits, then writes |
| Version lock | unchanged: compared after the lock, and the UPDATE's `WHERE version` repeats it | `versionLock.itest.ts` |
| Redirect list read, changed, written | same site lock, the read comes after it | `publishedCopy.itest.ts`, `versionLock.itest.ts` |
| Two creators of one id | the advisory lock, the PK, the version lock | eight creators: one wins, seven `SiteVersionRequiredError`, one row, two pages |
| A save never names an image a delete removed, and a delete never removes an image a committed page names (main or branch) | main's row: exclusive for the delete and a main save, shared for a branch save naming an image | the lock held, both orders, eight rounds each: never "committed page names a missing image"; `branches.itest.ts` |
| A save and a publish or rollback of the same site | the site row lock; the version comparison | `publishedCopy.itest.ts` ("a save racing a publish never lands in the revision") |
| No deadlock among the writers | one lock order: advisory, main, branch | a mix of main saves, branch saves, publishes, image deletes and saves of other sites, ten rounds: no P2034, no deadlock |
| **Saves of different sites do not conflict** | no cross-site lock and no predicate locks | six writers of other sites and four 20-page saves: one transaction per save, zero retries, zero failures. Red before the change: 16 `P2034` failures and 8 conflicts in the mixed test |

### What was not changed, and why

- **The branch update and merge** (`merge.ts` `WRITE_TRANSACTION`) stay serializable. They lock main then the branch before they write, so they are correct; they can still be aborted by an unrelated serializable transaction, as the undo's comment says, but that is the branch owner's path and a separate change.
- **`rollbackToRevision`** stays serializable: it moves one site's pointer, is rare, and a conflict with a save of the same site is a true one that its retry answers.
- **A save that waits behind a long writer of its own site** can reach the 30-second transaction limit, which Prisma reports as a transaction timeout and the route answers as a failed save, the same class of answer as the exhausted retries it replaces and the autosave retries. Before it, the failure came from unrelated sites.
- **A rolling deploy** runs old serializable saves beside new locking ones: an old save's `UPDATE` waits on the new save's row lock and, once that has committed, is aborted by the database (the row changed under its snapshot) and retried; the version lock holds on both sides. The one gap is an old image delete (serializable, no share lock) against a new branch save naming the same image, for the length of the deploy.

## Until the change lands

Pull request 390 stays held (`land-pr hold`) for the same reason as before: its `verify` failed on this defect, and no unattended fixer is to paper over it. After this has landed, 390 is rebased onto main so that `verify` runs against the fix, and driven once.
