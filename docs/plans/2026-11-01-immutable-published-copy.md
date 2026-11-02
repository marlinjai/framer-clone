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
  top bar's More menu gets "Erase personal data".

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

Filled in from the `gdpr-compliance` review below (Articles 17 and 5(1)(e)).

### Open points (need a lawyer or a later decision, not code)

Filled in from the GDPR check below.

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
