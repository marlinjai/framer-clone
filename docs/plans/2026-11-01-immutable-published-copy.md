---
type: plan
status: in-progress
date: 2026-11-01
title: "The immutable published copy: publish freezes a revision, visitors read only that"
summary: "Save and publish wrote the same rows, so after a cache miss a visitor saw the last save. Publish now freezes one revision per site (pages, components, settings, redirects, name and analytics binding as one JSON document), `sites.published_revision_id` names the live one, and the public resolver reads only that. A site published before this keeps serving its rows until its first save or publish, which freezes those rows first. Rollback moves the pointer. Additive migration, no data rewritten."
tags: [framer-clone, publishing, revisions, migration, renderer, fleet]
projects: [framer-clone]
---

# The immutable published copy

Roadmap line: "An immutable published copy of each page". First step of point 2 of the
[external frontend research](2026-10-26-external-frontend-visual-editing-research.md); the rest of that point stays
rejected. Decision 12 of the [reusable components contract](https://github.com/marlinjai/framer-clone/pull/220) (a
revision holds `components` beside `pages`) is honoured here, and slice 8 of that contract was waiting for this.

## Contract

**One rule: everything a visitor can read comes from one frozen revision.** Saving writes the working copy
(`sites` plus `site_pages`) and nothing a visitor reads. Only publish and rollback change what is live.

| Question | Answer |
|---|---|
| Unit | One revision per **site**, not per page. Every public reader walks `site.pages` (`matchPageBySlug`, `locateForm`, `sitemap`, the legal page lookup), and pages and components must not mix versions |
| Storage | Table `site_revisions`: `site_id`, `workspace_id`, `tenant_group_id`, `number` (unique per site, from 1), `kind`, `document` (JSON), `published_by`, `created_at`. Column `sites.published_revision_id`, nullable |
| What freezes | `pages` (all of `{ pageId, slug, snapshot }`), `components`, `siteSettings`, `redirects`, `name`, the analytics binding. A new frozen field needs no migration, only `parseRevisionDocument` |
| What stays live | Identity and tenancy (`siteId`, `workspaceId`, `tenantGroupId`, `companyId`), `status`, domains. CMS rows and commerce data stay live too: a revision freezes the design, bindings resolve per request as before |
| Publish | One transaction that first takes `SELECT ... FOR UPDATE` on the site row, then writes the working copy, reads it back, inserts the revision, points the site at it, sets `published` and prunes. Saves and renames update that row, so a concurrent save cannot land in the revision, and a failed publish leaves nothing half done. Not SERIALIZABLE: that made publishes of unrelated sites abort each other (8 at once lost 3 to `P2034`). Publish and save allow 30 seconds (`timeout: 30_000, maxWait: 5_000`), since a first publish at the 10 MB limit could run past Prisma's default of 5 |
| Reading | One `RepeatableRead` snapshot, since Prisma runs one statement per relation. A first save between them would otherwise yield no revision and no pages, cached with no expiry. Only a null pointer means the working copy; a pointer with no revision behind it throws |
| Save | Never touches a revision, except the first save of a legacy site (next row) |
| Sites from before this | `published_revision_id IS NULL` with status `published`: the resolver serves the working copy, exactly as today, so no site moves at deploy. The first save or publish freezes the rows **before** overwriting them, as a `baseline` revision, in the same transaction. From that moment the site is on the new path |
| Rollback | Moves `published_revision_id` to an earlier revision of the same site, sets `published`, revalidates like publish. No new row, no change to the working copy. The dialog asks first, shows the `publishCheck` warnings of that version (checked on the frozen document, a warning and never a gate), and says when it brings an offline site back |
| Retention | The newest 30 revisions of a site. Pruned at publish, when the live revision is by construction the newest. Numbers are never reused |
| Cache | The cached `PublishedSite` is built from the revision, so a miss (restart, deploy, second replica) reads the same content. Publish and rollback revalidate the subdomain and every custom host |
| Custom domains | Nothing special: every host resolves to a site id first, then to the same revision. Domains stay live, a domain connected later serves the revision that is live |
| Draft preview | `/projects/<id>/preview` already loads the working copy through `SiteRepository.loadProject`, behind sign-in. It stays that. No preview tokens: those belonged to external frontends |
| Unpublish | Sets `draft` and keeps the pointer. The resolver requires `published`, so nothing is served |
| Delete | `site_revisions.site_id` cascades. The pointer's foreign key is `NO ACTION`, not `SET NULL`: losing a live revision must fail loudly, never fall through to serving drafts. It is checked at the end of the statement, so the cascade from a site delete passes |

## Routes

- `POST /api/projects/publish`: as before, plus `revision` in the answer.
- `GET /api/projects/<id>/revisions` (`viewSite`): newest first, without documents, with the live number.
- `GET /api/projects/<id>/revisions/<number>` (`viewSite`): the publish warnings of that revision.
- `POST /api/projects/<id>/revisions` `{ number }` (`publishSite`): make that revision live.
- The top bar gets "Published versions" (a dialog, in the More menu on a compact bar).
- `POST /api/projects/<id>/erasures/search`, `POST /api/projects/<id>/erasures`, `GET /api/projects/<id>/erasures`
  (owner only): find, erase and list erasures of personal data (section "Erasing personal data from the history"). The
  Published versions dialog gets "Erase personal data", since those versions are where an old value lives on.

## Migration

`20261102200000_site_revisions`: one enum, one table, one nullable column with its index, one foreign key each way. It
rewrites no row
and has no backfill, because the resolver's fallback covers every site that has no revision. `boot.sh` runs
`prisma migrate deploy` before the server starts. While the old container is still up it keeps working: it ignores the
new table, and a site it publishes keeps a null pointer and is served by the fallback. The one gap: a site the new
container has already frozen and the old container then publishes keeps its frozen revision until the next publish.
That takes a publish in the seconds both containers run.

**Rolling the code back is not safe, although the migration needs no reversing.** The old code ignores the table and
the column, and that is the problem: it serves `site_pages`, so every site shows its last save at once, including work
deliberately not published. A rollback made in the dialog is undone, because the old code never reads the pointer. And
rolling forward again hides what was published meanwhile: a publish under the old code writes rows and leaves the
pointer alone, so visitors get the older frozen revision. Runbook: `deploy/README.md`, "Rolling back past the published
copy".

## Format of a revision

A document carries `schemaVersion`, `REVISION_SCHEMA_VERSION` in `src/server/sites/revision.ts`, and a document whose
version this code cannot read fails loudly. `site_pages` can be rewritten when the page format changes, but a live
revision stays frozen for as long as a site goes unpublished, and each site keeps up to 30.

**The rule: any change to the page format or to this document must also rewrite `site_revisions`, or keep a reader for
the old shape, and bump the version.** A data rewrite that touches only `site_pages` misses what visitors actually read.
The same goes for the reusable components work, whose definitions live inside the document.

## Decided here, say so if you disagree

1. **No backfill in the migration.** A backfill would freeze rows at migration time, and an old container publishing
   during the overlap would then be shadowed by the older frozen copy. The freeze on first write has no such window.
2. **Redirects freeze.** A save can drop a redirect (a page reclaims the path), so reading the live list would let a
   save change the live site. A slug change therefore reaches visitors, with its redirect, at the next publish.
3. **`name` freezes**, although rename is its only writer after creation: the name appears in the published head, and
   a project renamed for internal reasons should not reach visitors on a cache miss. It reaches them at the next
   publish.
4. **The receipt letter reads the frozen name and language** (`siteInfo` in `src/server/commerce/mail/runtime.ts`), so
   a saved, unpublished setting never reaches a customer.
5. **Thirty revisions kept.** A project body may be up to 10 MB, so unbounded history is unbounded growth.
6. **Rollback does not change the working copy.** It fixes the live site at once and never destroys work. Copying a
   revision back into the editor is a separate feature, not built here.
7. **A rename of a legacy site still shows live until its first save or publish.** Only `saveProject` freezes the
   baseline. Same behaviour as today, and it ends with that site's first save.

## Erasing personal data from the history

Decided by Marlin on 2026-11-02: an erase tool is needed. `siteSettings` carries managing directors, phone, email and
address, and pages carry whatever was written on them. After a change, up to 30 revisions keep the old values, and a
rollback would republish them. The erase tool removes one value (a name, an address, a phone number) from every kept
revision and from the working copy, without touching anything else.

### Contract

| Question | Answer |
|---|---|
| Who | The company's **owner** only: the session's role on the company that holds the site is `owner` (auth-brain `tenants[].role`, server verified), on top of the editor guard every per-project route has (editor host, signed in, the company has `sites`, `workspace.admin` through OpenFGA as the new action `eraseSiteData`). An admin who is not the owner gets 403 `owner_required`. Searching is gated the same way, since it shows personal data from versions no other screen shows |
| Audited | Every erase writes one `site_erasures` row in the same transaction: who, when, the site, every place changed (revision number or the working copy, the page id, the path inside the document, the kind of place) and what the proof found afterwards. **Never the searched value, an excerpt or a hash of it**: a hash of a name is still personal data. The row has no foreign key to the site, so it outlives a site delete. `GET .../erasures` lists them, owner only |
| What is searched | Every string in every kept revision (`publish` and `baseline` alike) and in the working copy: `sites.name`, `description`, `site_settings` (business details, theme, head, everything else), `components` (definitions, their trees, inputs and defaults), `redirects`, and every `site_pages.snapshot` (text, attributes, bound values and binding templates, form labels, placeholders and defaults, page metadata). One generic walk over the stored JSON, so a field added later is searched without a change here |
| Not searched | CMS rows, commerce, Books, form submissions, analytics: they are not part of a revision and have their own deletion paths. Database backups and logs (open points below) |
| How a match is found | Exact text, case-insensitive unless asked otherwise, both in the composed (NFC) and decomposed (NFD) form of the value, so `Müller` typed on a Mac and stored from Windows both match. At least 3 and at most 200 characters, so a stray `a` cannot rewrite a site |
| Preview | `POST .../erasures/search` (a POST, so the value never lands in an address or an access log) answers every match with where it is (revision number and date, or the working copy; the page and its slug; the kind of place; the path) and a short excerpt, plus a `token` over the full list. Up to 500 matches are listed; the counts are always complete |
| Blocked matches | Reported, never rewritten: object keys, ids and id references (`id`, any `...Id` or `...Ids`, `for`, `aria-controls` and the other id lists), node and binding types and modes, page slugs and redirect addresses, class names, selectors and behaviour references, `data-*` attributes, form field keys and `name` attributes, analytics references, and any text inside a `{{ }}` binding reference. Rewriting these would change what a visitor sees beyond the value (styles, links, form keys, routing) or break the document. The preview says why, and an address (slug or redirect) is an open point below |
| Choosing | The dialog erases every erasable match by default; the owner can leave single matches out. The erase request carries the search, the `token` from the preview, the replacement (empty, or a placeholder such as `[entfernt]`; it may not contain the value) and the matches left out |
| Stale preview | The erase reruns the search under the lock. When its token differs from the preview's (a publish, a save, a rollback or another erase in between), nothing changes and the answer is 409 `erase_preview_stale`: search again |
| Rewriting | One transaction that first takes `SELECT ... FOR UPDATE` on the site row, as publish does, so publish, rollback and other erases queue behind it. Each revision is read, rewritten and written back one at a time (30 documents of up to 10 MB). Only the matched strings change: the raw stored JSON is rewritten, never a normalised shape, so trimming or defaults cannot slip in. Number, kind, `published_by`, `created_at`, the pointer and the site's status stay. `site_revisions.rewritten_at` is set. Afterwards each document must still parse (`parseRevisionDocument`, `parseComponents`) with the same pages, ids and slugs, or the whole erase rolls back |
| The working copy | Rewritten in the same transaction (`sites` columns and every `site_pages` row), and `sites.erasure_epoch` goes up by one |
| Open editor tabs | A tab opened before the erase still holds the old value in memory. Its next Save or Publish would write it back, so the editor sends the epoch it loaded (`metadata.erasureEpoch`) and the server refuses an older one with 409 `erased_since_load`: reload the page. A tab without the field counts as epoch 0. Reopening a project in the same tab takes the server copy when the epoch moved and the tab has no unsaved work |
| Published pages and caches | The live revision is rewritten in place, so its id does not change: the expanded-page memo keys on `revision:<id>:<rewritten_at>`, and the route revalidates the subdomain and every custom host (as rollback does, a failed revalidation answers 500 so the owner retries, which is idempotent). A site never published gets no subdomain from this |
| An open rollback | A rollback only moves the pointer to a kept revision, and every kept revision has been rewritten, so no rollback can bring the value back. A rollback waiting on the lock runs after the erase and serves the rewritten version |
| Proof | After the commit the route searches again, in a fresh read, and answers `remaining` (matches still there, including blocked ones and the ones left out) and the places changed. `remaining` goes into the audit row. Searching again later must find no erasable match |
| Re-entry | A second erase of the same value finds nothing erasable and changes nothing (409 `nothing_to_erase`). A failed erase changes nothing, so it is simply repeated |

### Decided here, say so if you disagree

1. **Owner, not admin.** Erasing rewrites history nobody can restore, and searching shows every old value, so it sits
   one level above publishing. OpenFGA has no workspace owner, so the owner is read from the verified session's role on
   the company.
2. **Addresses are not rewritten.** A slug or a redirect address holding a name would change where visitors land and
   would break links in a kept version. Reported as blocked; see the open points.
3. **The audit row keeps no trace of the value.** Proof that a value is gone is a search for it, which needs the value
   from the person asking, never from our own records.
4. **Open tabs are fenced, not merged.** Merging an old tab's unsaved work with an erase cannot be done without knowing
   the value, which the server does not keep. The tab is asked to reload instead.

### GDPR check

Run with the `gdpr-compliance` skill on 2026-11-02 against the built code, for Article 17 (right to erasure) and
Article 5(1)(e) (storage limitation). Informational, not legal advice.

**Roles.** The data on a site (a managing director, staff, a contact person) belongs to the company that owns the site,
which is the controller (Art. 4(7)). Lumitra hosts it and acts on that company's instructions, which reads as a
processor (Art. 4(8), Art. 28). Article 17 binds the controller; the tool is how Lumitra assists it, as Art. 28(3)(e)
requires of a processor. That reading is an open point below.

| # | Severity | Article | Finding | What the code does, or what remains |
|---|---|---|---|---|
| 1 | Resolved | Art. 17(1) | Before this, a value changed on a site stayed in up to 30 revisions with no way to remove it short of deleting the site, and a rollback republished it | Erased from every kept revision and the working copy in one transaction; no rollback can bring it back; a fresh search proves it (`remaining`) |
| 2 | Resolved | Art. 5(2), Art. 32 | Erasing must be accountable without keeping what was erased | One audit row per erase with who, when and the places, never the value, an excerpt or a hash; search and erase are owner only, the value travels only in POST bodies and no log line or error carries it (pinned by the route test) |
| 3 | Medium | Art. 5(1)(e) | Old revisions have no time limit: a site that is published 30 times in a week keeps a week, a site published twice keeps both versions for years. Erasure on request does not replace a storage limit | Open point A |
| 4 | Medium | Art. 17(1) | Blocked matches are not erased: a value in a page slug, a redirect address, a class name, an id or a form key stays (reported by the preview and counted in `remaining`) | Open point B |
| 5 | Medium | Art. 17(1) | Exact text only: `M. Mustermann`, a misspelling, a name split by markup, or a name inside an image is not found. The owner must search each form | Said in the dialog's result through `remaining`; the owner searches again for each variant. No code can find a person it is not told about |
| 6 | High | Art. 17(1) | Uploaded files: erasing an image URL removes the reference from the revisions, but the file stays in Storage Brain, and a photo of a person is personal data itself | Open point C |
| 7 | Medium | Art. 17(1), Art. 5(1)(e) | Database backups keep the erased value for their own retention period | Open point D |
| 8 | Low | Art. 17(1) | Caches: the origin cache is revalidated at once, but a replica's on-disk entry is replaced only at its next visit or deploy; published HTML is rendered per request (`force-dynamic`), so this repository sets no edge caching for it; `sitemap.xml` and `robots.txt` carry `max-age=300` and hold only addresses | Nothing further in code. The Cloudflare zone configuration is not in this repository and was not checked |
| 9 | Low | Art. 17(2) | Copies outside Lumitra (search engine caches, archives, people's browsers) are not reached | Open point E |
| 10 | Low | Art. 17 | Other stores are out of scope: CMS rows, form submissions, commerce orders and receipt letters, Books, analytics. Each needs its own deletion path | Open point F |
| 11 | Resolved | Art. 25(1) | A tab opened before an erase could write the value back on Save, and Publish would freeze it again | `sites.erasure_epoch` refuses those writes (`erased_since_load`); proven on Postgres, including races with save and publish |

### Open points (need a lawyer or a later decision, not code)

A. **A retention period for old published versions** (Art. 5(1)(e)). Today the newest 30 are kept with no age limit.
   Whether an age limit is needed (for example versions older than 12 months pruned, the live one always kept), and how
   long, is a legal and product call, not a technical one.

B. **Erasing an address.** A value in a page slug or a redirect address is reported but not rewritten. Rewriting it
   changes where visitors land and breaks links into a kept version. Needs a design (rename the slug in the editor,
   then drop the old redirect and rewrite or prune the kept versions that still hold it) and Marlin's decision.

C. **Uploaded files.** A revision references images and files by URL. Erasing the URL does not delete the file from
   Storage Brain, and the same file may be used elsewhere. Needs a decision on who deletes a file (the site's owner in
   the media library, or the erase tool when nothing references it any more) and a lawyer's view of whether an
   unreferenced file at an unguessable URL is still "kept" for Art. 17.

D. **Backups.** The erased value stays in database backups until they expire. Common practice is to document the
   backup retention and to put the value "beyond use" (never restored into the live system without the erase being
   repeated), as the EDPB's 2025 coordinated enforcement on erasure asks. Needs the backup retention period written
   down and a lawyer's confirmation that this is acceptable, plus a runbook line: after any restore, repeat every erase
   since the backup (the audit rows list the sites and dates, not the values, so the owner must supply them again).

E. **Article 17(2), other controllers.** When the company made the data public, it must take reasonable steps to
   inform those processing copies. Whether Lumitra owes the customer anything here (for example a search engine
   removal request or a note in the dialog) is a lawyer's question.

F. **The other stores.** Form submissions, CMS rows, orders and receipt letters, Books and analytics each need their
   own erasure path and their own legal retention (accounting records, for example, have statutory retention that can
   override Art. 17 through Art. 17(3)(b)). Out of scope here; a separate roadmap item.

G. **The roles, the deadline and the audit row.** Confirm that Lumitra is the processor for site content and that the
   data processing agreement covers assisting erasure (Art. 28(3)(e)); that the customer, not Lumitra, answers the data
   subject within one month (Art. 12(3)); how long an audit row is kept (it names the owner who erased, an employee's
   personal data) and whether it must name the data subject to support notifying recipients (Art. 19), which today it
   deliberately does not.

## How it joined the reusable components column

Slice 3 of the reusable components contract (`sites.components`) landed first, so this branch made the five edits that
contract records ("How slice 3 and the published copy (#226) join"): `freezeRevision` reads the column, which the
shared working-copy write has just written (or kept, for a body without the key), so a baseline and a publish both
freeze it and a tab older than the column still publishes the definitions the site holds. The resolver's branch for a
site with no revision serves the column too. `PublishedSite.components` is parsed once in the resolver, from the
frozen value, so the cached site is ready to expand. The expansion memo keys on the served revision's id, or for a
site with no revision on the row's `updated_at`, because a save no longer changes what is served.

The theme and head keys (`mergeKeptSiteSettings`) are kept by the same shared write, so a revision freezes the merged
settings. The publish warnings of a frozen version (`revisionPublishCheck`) now include the component issues, from the
frozen definitions, as the editor's check does.

## Tests

- Integration (`src/server/sites/__tests__/publishedCopy.itest.ts`, real Postgres): publish then save leaves the
  resolver on the published content by subdomain and by custom hostname; settings, redirects, name and analytics stay
  frozen; rollback, including after a cache miss; an unknown number and a foreign workspace are refused; a legacy site
  serves its rows, freezes them at first save, and offers them for rollback; concurrent publishes get distinct numbers;
  pruning; unpublish and republish; deleting a site removes its revisions, and a live revision cannot be deleted alone;
  draft preview still loads the working copy; a read straddling a first save stays whole; 16 unrelated publishes at
  once; a save racing two publishes; a body near the limit on a first publish.
- Unit: the route guards and answers, `parseRevisionDocument`, the resolver's use of a revision, the versions dialog
  with its confirmation and warnings.
- Erasing (`src/server/sites/__tests__/erasePersonalData.itest.ts`, real Postgres): forward (every kept version and
  the working copy, each document equal to the old one with only the value replaced, the live site and every rollback
  clean, the audit row without the value and surviving a site delete, left-out and blocked matches kept, a site from
  before revisions); backtrack (a publish or a save between preview and erase is refused and changes nothing);
  resume (a failure injected at the last write rolls everything back, the same preview then goes through); re-entry
  (a second erase finds nothing); stale tabs refused on Save and Publish; races of an erase with a save and with a
  publish; bounds and a foreign workspace. Unit: the walker (`erase.test.ts`), the routes with the real guard and its
  owner step (`erasures-route.test.ts`), the panel and the dialog (`ErasePersonalDataPanel.test.tsx`), the epoch in
  `snapshot.test.ts` and `openProject.test.ts`, the memo key in `publicResolver.test.ts`.
- Erase migration: `20261102230000_site_erasures`, additive (two columns with defaults, one table). Older code ignores
  them: it neither fences stale tabs nor keys the memo on `rewritten_at`, so an erase made while old code still runs
  can be undone by such a tab. Erase only once the new code is deployed everywhere.
