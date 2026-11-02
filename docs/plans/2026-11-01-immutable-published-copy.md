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

## Migration

`20261101000000_site_revisions`: one enum, one table, one nullable column with its index, one foreign key each way. It
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

## Open question for Marlin

**Is a history of 30 versions acceptable for personal data, or is an erase tool needed before business customers
arrive?** `siteSettings` carries managing directors, phone, email and address, and pages carry whatever was written on
them. After a change, up to 30 revisions keep the old values, and a rollback republishes them. Deleting a site cascades
correctly, but no single value can be erased from history. Not decided here, and nothing is built for it.

## What the reusable components slices must do

`sites.components` does not exist yet, so `publishProject` freezes `components` from the published body (`{}` when
absent, and a baseline is `{}`). The slice that adds the column must make `freezeRevision` read the column instead, or
a tab loaded before that deploy would publish no definitions. `PublishedSite.components` already carries the frozen
value through the cache, and expansion reads it there.

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
