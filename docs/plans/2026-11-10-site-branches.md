---
title: Site branches
description: Plan for branching in Lumitra Sites, modelled on Framer's branching, so a person or an agent can change a copy of a site, have it reviewed, and merge it back into main.
summary: A branch is a hidden copy of a site's working copy that keeps its fork point. The editor, autosave, the version lock, the live stream, the preview and the Model Context Protocol (MCP) tools work on it unchanged, because it is a site row. A pure node-level three-way merge brings main into the branch, conflicts are settled on the branch, and merging into main is then one ordinary write under the version lock. Unlike Framer, Content Management System (CMS) content is not branched in version one; commerce, forms, domains and published revisions never are, and a branch can never be published to the live site. Nine slices of about 35 to 46 agent days, the public preview link included. Approved by Marlin on 2026-11-11 with all four recommendations; S1 in progress.
type: plan
status: in-progress
date: 2026-11-10
tags: [framer-clone, branches, merge, editor, mcp, publishing, plan]
projects: [framer-clone]
---

# Site branches

**Status:** in progress. Written 2026-11-10 at Marlin's request, approved by him on 2026-11-11 with all four recommendations of section 11 taken (answers recorded there). S1 is being built.

## 1. What Framer's branching does

Researched on 2026-11-10 from Framer's help centre, Academy, pricing page, plugin reference and changelog, plus third-party coverage. Numbers in brackets point to the list of sources at the end. Framer's community forum did not load for the research, so what users complain about is thinly covered, and "not documented" below means "not on the pages that could be read".

### Framer

- **Shipped with Framer 3.0 on 2026-06-16**, presented together with its Artificial Intelligence (AI) agents: an agent's changes land in a branch by themselves ("auto-branching"), so an agent's work starts on a branch and not on main [3][8].
- **A branch is a copy of the whole project.** "Think of a branch as a draft version of your entire project, not just a single page or CMS item" (CMS is the Content Management System, the collections of structured content a site shows). Main is the version the live site is published from [1]. The Academy calls it "a virtual copy of its parent" [2].
- **Creating and switching.** The top bar shows the current branch ("main"); clicking it offers New Branch and a name [1]. A person can switch to a branch to look at it and "deliberately join" it to edit [2]. Renaming and deleting need having joined; deleting the branch you are on moves the editor to its base [13][15].
- **Branches can be nested.** A branch can be made from a branch and is applied back to the one it came from [1][2].
- **What is on a branch.** Pages, components, canvas content, styles, and also CMS items and collections: a branch is used to "update CMS content", and "changes made on a branch remain there until they are applied" [1][2]. Framer's plugin Application Programming Interface (API) reference lists change summaries for collections (with per-item changes) and for site settings in the categories general, domains, redirects, performance, forms, custom code and skills [20][21][24]. Code components, assets and localization are not documented.
- **Keeping up with main is automatic.** A branch "inherits updates from its parent while keeping your work separate until you choose to merge it" [2]; Framer's head of product described it as "branches auto-rebase onto main" [27]. No manual update step is documented.
- **Preview.** "You can also publish a branch to generate a branch preview URL" (a web address), shared with others for review; "publishing a branch does not publish main" [1]. Marketing wording: "Every branch gets a staging URL" [4]. The address format is not documented (an affiliate blog shows `your-branch.framer.app` [30]). Framer's older Staging feature is documented separately and does not mention branches [7].
- **Merging back** is called Apply in the help centre and merge elsewhere: open the branch, Review Changes, check the diff, Apply. Applying changes main and publishes nothing; "to make changes live, you must apply them to main and publish main" [1]. The Changes panel shows what was edited and who made the branch [2], and every merge is logged [4].
- **Conflicts are barely documented.** All Framer says: "If two branches modify the same content, review the changes carefully before applying them. In some cases, you may need to manually decide which version to keep." [1] No conflict screen is shown anywhere. Third parties read this both ways: "No conflict resolution, no manual merge step" [31] and Framer "hasn't detailed merge conflict resolution for visual elements" [29].
- **Review and approval.** "Get sign-off" is marketing wording [4]; an enforced approval before merging was not found. Viewers can comment and review, editors design and publish; who may merge is not documented [4].
- **Undoing.** An applied branch is reverted from version history, and "the reverted changes are moved back into a draft so they can be reviewed or reused" [1].
- **Multiplayer.** Cursors are scoped per branch, and joining and leaving a branch is explicit [4][13].
- **Plans.** The pricing page lists "Branching with previews" and "Staging environment" on Pro (30 US dollars a month), not in the Free or Basic lines (0 and 10 US dollars) [5]. Launch coverage said "available to everyone" [30]; the pricing page is the primary source. No limit on the number of branches is stated.
- **What users complain about.** No complaint about branching itself was found. The nearest criticism is the undocumented conflict handling, called "critical as teams scale usage" [29]; the loudest complaint about Framer 3.0 is about agent credits ("credits go fast. Really fast." [32]).

### Webflow and Figma, briefly

- **Webflow: page branching, Enterprise only.** A branch is a copy of one page, with one active branch per page; styles and components stay shared with main, which is where its conflicts come from. Each conflict is answered `main` or `branch`, and every one must be answered before the merge. A branch can be updated from main and published to a staging domain; merging consumes the branch; approvals exist on some plans [34][35][37]. No site-level branching was found [36].
- **Figma: branches on the Organization and Enterprise plans, unlimited.** A branch is an exact copy of the main file. Someone without edit rights asks for a review; reviewers approve or suggest changes. Updating from main is a manual step, with conflicts shown side by side (main left, branch right), a pick per conflict and "resolve all". Merging archives the branch and writes a checkpoint in the version history, and is undone by restoring that version. There is no way to merge only some changes [38][39][40].

### What this plan takes and what it avoids

| Taken | From | Avoided | From |
|---|---|---|---|
| The whole site as the unit | Framer | Page-only branches with shared styles leaking across | Webflow |
| Applying a branch never publishes | Framer | One branch per page | Webflow |
| Agents work on branches, a person reviews | Framer | Conflict handling nobody can see or predict | Framer |
| A pick per conflict, main or branch, with "all from one side" | Figma, Webflow | Coarse conflicts: the merge here compares single properties | Figma |
| Conflicts settled on the branch, before main changes | Figma | | |
| A review with approval tied to what was seen | Figma | | |
| An undone merge comes back as a branch | Framer | | |

Two places where this plan deliberately does less than Framer in version one: **the CMS is not branched** (section 7, and question 4 for Marlin), and **there are no nested branches** (section 10). One place where it differs in kind: Framer updates a branch from main by itself; here "Update" is a button (section 10, decision 16).

## 2. What Sites has today (read on main at d2b26eee, 2026-11-10)

### What branching can build on

- **A site is one row plus its pages.** `sites` holds the name, site settings (theme, head, business data), reusable component definitions and redirects; `site_pages` holds one JSON (JavaScript Object Notation) snapshot per page (`prisma/schema.prisma`). Every route, the editor, autosave, the preview, the live stream and every tool of the Model Context Protocol (MCP) endpoint, through which agents work on sites, address a site by its id and load it through the caller's workspace (`SiteRepository.loadProjectWithVersion` in `src/server/sites/repository.ts`, where a site of another workspace reads as missing).
- **The version lock.** `sites.version` goes up by one on every write of the working copy, and a write names the version it was based on (`expectedVersion`), refused with 409 `site_changed` otherwise. The comparison is repeated inside the `UPDATE`. This is what lets a merge into main be an ordinary write.
- **One write path.** Save and publish both go through the private `writeWorkingCopy`, which checks the slug rules, the theme limits, that every named uploaded image exists, the erasure epoch (a tab loaded before an erase of personal data is refused), and maintains the old-slug redirects. A merge that writes through it inherits all of that.
- **The frozen document format.** `src/server/sites/revision.ts` already defines one JSON document for "everything of a site at one moment" (pages, components, settings, redirects, name), with a `schemaVersion` and a strict reader (`parseRevisionDocument`). A branch's fork point can be stored in that format.
- **The live stream** ([live agent canvas](2026-11-08-live-agent-canvas.md), completed). Every committed write is announced per site, and an open editor fetches the stored copy and adopts it as one undo step named after the writer, by structural sharing. A merge into main, or an update of a branch from main, therefore shows up in open editors with no new client code beyond a label.
- **A small three-way merge already exists.** `rebaseEdit` in `src/lib/projects/liveSync.ts` (the replay-on-top work, #358, plan [live replay on top](2026-11-09-live-replay-on-top.md)) keeps a person's settled edit when an agent wrote meanwhile. It is not a document merge: it replays one undo entry of value replacements on nodes that still exist. What it has that a real merge needs: reading every node of a snapshot by id (`nodesOf`), the rule "one side changed a value the other left as the base had it" (`replayableEdits`, compared through `shareUnchanged`), and a dry run on a scratch copy that also holds the size limit of reusable components (`replaysCleanly`).
- **Node ids are stable and unique.** Nodes, pages, breakpoints and component definitions get ids from `uuid` when they are created (`src/models/PageModel.ts`, `src/models/ProjectModel.ts`, `src/lib/siteOps/generated.ts`), so the same node has the same id on main and on a branch, and nodes created independently on each side do not collide. (Preset children use an 8 character suffix, so a collision is unlikely but possible; the merge handles it, section 5.)
- **Site operations and their audit.** An agent writes through `apply_batch` (`src/server/siteOps/index.ts`, `src/lib/siteOps/applyOps.ts`), all or nothing, one version per batch, with one audit row per write in `site_operation_audits` (ids and operation names, never content).
- **Approvals.** An agent's `publish` and `rollback` need a person's approval, through the client's own dialog or an approval page in the editor, pinned to the company, key, site and version ([agent plugin plan](2026-11-02-lumitra-sites-agent-plugin.md), decision 6). A merge by an agent can use the same mechanism.
- **The signed-in preview.** `/projects/<id>/preview` renders the working copy of any site the person may open.
- **Site settings and page settings are plain keyed data** ([published site essentials](2026-10-23-published-site-essentials.md), completed): one Site settings object (language, favicon, sharing image, title template, business and contact data, consent mode, the 404 page), and per page a slug, metadata, a noindex switch and a legal template marker. Forms name a thank-you page, and pages link to each other by slug. All of it is part of the working copy, so a branch copies it, and the merge needs a rule for each (section 5).
- **Publishing is already separate from saving** ([immutable published copy](2026-11-01-immutable-published-copy.md)). Visitors read one frozen revision; only publish and rollback change it. So a branch never needs to touch what visitors see.

### What is missing

- **No copy of a site that knows where it came from.** There is no parent pointer and no stored fork point. The working copy has no history table at all: the only durable history is the published revisions (30 kept) and, in an open tab, the undo list in the top bar's history dropdown (`HistoryList` in `src/components/TopBar.tsx`, the client-side `HistoryStore`, gone on reload).
- **No document merge.** Inserts, deletes, moves, the order of children, pages, slugs, component definitions, theme and site settings have no merge rule anywhere. The live agent canvas plan left this out on purpose as "a sizeable piece of its own".
- **No comparison of two copies** (a change list or a visual diff), and no review or approval state.
- **`props` is one frozen value per node** (`ComponentModel`), with the style inside it and responsive values as maps keyed by breakpoint. A merge that compared whole fields would call two style edits on the same node a conflict, so the merge has to look inside (section 5).
- **Stores keyed by a site id that a copy must not duplicate:** domains, published revisions, A/B test settings (`site_experiments`), form submissions, uploaded images (`site_images`, checked per site on every save), commerce and catalogue rows, Content Security Policy report counts, MCP approvals and the live bounds.
- **No preview for someone who is not signed in.** The published copy plan decided "No preview tokens".
- **The CMS is not versioned.** Collections and rows live per workspace and are read live; a row's reserved Status field (Draft or Published) is the only staging it has (`src/server/cms/publishedVisibility.ts`).

## 3. Target behaviour

### An author

1. **Create.** In the top bar, next to the site name, a branch switcher shows "Main" and the open branches. "New branch" asks for a name and opens the branch in the editor. The branch starts as an exact copy of main's working copy at that moment (not of what is published).
2. **Work.** The editor on a branch is the editor: autosave, undo, Generate, the preview, live agent presence. A badge with the branch's name sits in the top bar, and the Publish button is replaced by "Review and merge", with a hint that publishing happens from main.
3. **Stay current.** When main moves, the branch's top bar says "Main has changed" with "Update". Updating brings main's changes into the branch. Changes that do not touch the same thing merge by themselves; real conflicts open the review (below).
4. **Switch, rename, discard.** The switcher changes between main and branches (each has its own address, `/projects/<id>`). A branch can be renamed and discarded (with a confirmation that names how many changes are lost).
5. **Merge.** "Review and merge" shows what the branch changes. With no conflicts, "Merge into main" writes the branch's content to main as one new version. The branch is closed. Nothing is published: publishing main stays its own step with its own dialog.
6. **Afterwards.** The branch's old address says "This branch was merged into <site> on <date>" with a link to main. For 30 days, and until another branch is merged, the merge can be taken back ("Undo this merge"): main goes back to what it was, and the merged work comes back as a new open branch, as Framer returns a reverted branch to a draft.

### An agent working through the MCP

1. `create_branch` on a site answers a branch id. That id is a site id for every existing tool: `get_site`, `get_page`, `apply_batch`, `generate_page`, `announce_sections` and `preview_url` work on it unchanged, with their version lock, audit rows and live presence.
2. `branch_status` answers what the branch changes against main, whether main has moved, and any conflicts. `update_branch` brings main in; conflicts come back as a list the agent can answer per conflict ("main" or "branch") or leave to the person.
3. `request_review` marks the branch ready and answers the preview and review links for the person.
4. `merge_branch` needs the person's approval, through the same approval mechanism as `publish`. `publish` and `rollback` on a branch id are refused (`branch_cannot_publish`).
5. The plugin gets a skill, "work on a branch": for anything larger than a small edit on a site that is published, create a branch, work there, hand back the preview link and ask for review; never merge unasked.

### A reviewer

1. Opens the review link (signed in, at least `viewSite` on the workspace). Sees the change list grouped by page: pages added, removed and renamed, nodes added, removed, moved and changed (with the old and new value), component, theme and settings changes.
2. Sees main and the branch side by side per page and breakpoint, with the changed nodes outlined, and can open the branch's full preview.
3. Can approve ("Looks good") or send it back with a note. An approval names the branch version it saw; any later write to the branch withdraws it.
4. A person with the right to merge then merges. Version one does not force a second person (see "For Marlin to decide").

## 4. Data model

### Decision: a branch's content is a hidden `sites` row

A branch needs everything a site has: pages, components, settings, a version, an editor, autosave, a live stream, MCP access, a preview and audit rows. All of that is keyed by a site id today. Giving a branch its own site id means none of it changes. The alternative, separate `site_branch_pages` tables, would need a second code path through the repository, the editor loader, the live stream and every MCP tool, each a place for the two to drift apart.

The cost of a hidden row is that every place that lists or acts on sites must know about it. Section 7 names each one and says why a missed place fails closed.

### Migration (additive, no row rewritten)

**`sites`, new columns and constraints**

| Change | Why |
|---|---|
| `branch_of_site_id` (nullable) | The main site this row is a branch of. NULL for every site that exists today |
| Unique `(id, workspace_id)` and a composite foreign key `(branch_of_site_id, workspace_id)` to it, `ON DELETE CASCADE` | The database itself refuses a branch that points at a site of another workspace, and deleting a site deletes its branches |
| `CHECK (branch_of_site_id IS NULL OR (status = 'draft' AND published_revision_id IS NULL))` | A branch can never be published or carry a live revision, whatever code runs. The public resolver requires `published`, so no visitor can ever be served a branch |
| `CHECK (branch_of_site_id <> id)` and a trigger refusing a parent that is itself a branch | No branch of a branch |
| Trigger on `site_domains` refusing a row whose site is a branch | A branch never holds an address |

**`site_branches`, new table: one row per branch, which outlives the branch's content as a record**

| Column | Meaning |
|---|---|
| `id`, `site_id` (main, cascade), `workspace_id`, `tenant_group_id`, `company_id` | Identity and the isolation boundary, as on every site table. `id` is the same uuid as the hidden `sites` row's id (set at creation, no foreign key to `sites`), so it stays the branch's address after that row is deleted: an old link and a retried merge or discard find the closed record by the id they already hold |
| `branch_site_id` (unique, nullable) | The hidden `sites` row holding the content (always equal to `id` while it exists). NULL once the branch is merged or discarded |
| `name` | Up to 60 characters, control and bidirectional characters removed. Unique per site among open branches |
| `status` | `open`, `ready` (review asked), `merged`, `discarded` |
| `base_version`, `base_document` | Main's version and full copy (in the revision document format, with `schemaVersion`) at the fork, replaced on every update from main. The common ancestor of the three-way merge. NULL once closed |
| `merge_draft` | The review in progress: the conflict answers given so far, each keyed to the values it was given for (section 6) |
| `ready_by`, `ready_at`, `review_note`, `approved_by`, `approved_at`, `approved_branch_version` | Review state. An approval counts only while `approved_branch_version` is the branch's version |
| `merged_by`, `merged_at`, `merged_from_version`, `merged_main_version` | What the merge did |
| `discarded_by`, `discarded_at` | Who discarded it, and when |
| `main_before_document`, `main_before_expires_at` | Main as it was just before the merge, kept 30 days for "Undo this merge", then removed. Only the site's latest merge keeps one: a new merge clears the earlier one in the same transaction |
| `created_by_kind`, `created_by`, `created_at`, `updated_at` | A user or a key, as the audit table records actors |

**The working-copy description and the site name.** `SiteRevisionDocument` has no `description` today, but `writeWorkingCopy` writes one. S1 extends the document format with it (a `schemaVersion` bump with a reader for the old shape, as the rule below requires), so `base_document` and `main_before_document` carry it: the merge sees a description changed on both sides, and "Undo this merge" restores the earlier one. The description merges per field like site settings (section 5, rule 11). The site name is a branch property too: `writeWorkingCopy` does not write it and `renameSite` does not move `version`, so the plan changes both. A rename of a branch or of main bumps that site's `version`, so a review token and an approval go stale on a rename, and the merge transaction copies the branch's name onto main only when main's name is unchanged since the fork (otherwise it is a conflict like any other setting).

The description is added without a version bump (decision 18). Main has no stored history of its working copy, so the fork point cannot be looked up later: it has to be stored when the branch is made. `base_document` and `main_before_document` follow the rule the published copy plan set for revisions: a change to the page format must rewrite them or keep a reader for the old shape.

### What a branch copies and what it shares

| Copied into the branch, merged back | Shared with main, never branched |
|---|---|
| Pages (trees, slugs, page settings and metadata) | Domains and the platform subdomain |
| Reusable component definitions | Published revisions and what visitors see |
| Site settings: theme, head, business data, 404 page | CMS collections and rows |
| The analytics binding fields of the working copy | Commerce, catalogue, orders, Books |
| | Form submissions, A/B test settings, Content Security Policy counts |
| | Uploaded images: stored once on main (`site_images`), named by content hash, usable by every branch |

Redirects are not merged: `writeWorkingCopy` derives them when the merge writes main, so a slug changed on a branch gets its old-slug redirect at the merge, exactly as a slug changed on main does at a save.

**Uploaded images.** The save's check ("every named image is stored for this site") and the upload route read and write the main site's images for a branch. The delete check ("nothing names this image any more") additionally scans every open branch, every `base_document` and every `main_before_document` of the site.

## 5. Merge and conflict rules

### One engine, two directions, conflicts settled only on the branch

A pure, client-safe module `src/lib/siteMerge/` takes three documents (base, main, branch) and answers a merged document plus a list of conflicts. It is used in one direction only: **bringing main into the branch** ("Update"). Merging the branch into main is allowed only when the branch's base is main's current version, and then main simply becomes the branch's content (description and name included), written through `writeWorkingCopy` under main's version lock.

Why: main is never written with a half-settled merge, every conflict answer lands on the branch where it can be previewed, undone and reviewed before main changes, and there is one merge computation to test instead of two. Figma works this way too (section 1). "Merge into main" on a branch that is behind does not merge: it runs the update (in its own transaction) and stops. The update changes the branch's version and so withdraws any approval, so the reviewer is shown the updated branch and must approve again before the merge button works. Conflicts open the review as before.

### Units and granularity

The merge compares by id, never by position or by text.

| Unit | Identity | Compared parts |
|---|---|---|
| Page | page id | exists; slug; each metadata field; its tree |
| Node | node id | exists; parent and place among siblings; each own field; `props` per key; `props.style` per property; a responsive value per breakpoint key; `bindings` per key |
| Component definition | definition id | exists; its inputs and defaults per key; its tree as nodes |
| Site settings | key path | theme tokens per token; head entries per entry; business data per field; every other setting per key |

### Rules

1. **Only one side changed a part:** that side's value is taken.
2. **Both sides made the same change:** taken once.
3. **Both sides changed the same part differently:** a conflict. The person picks main's or the branch's value. Text is one value: two edits of the same text conflict as a whole, they are never spliced.
4. **Added on one side** (a node, a page, a definition, a token): kept. Added on both sides: both kept, since their ids differ. The same id added on both sides with different content (a rare id collision): the branch's copy gets fresh ids, with its references remapped, as paste already does (`renewIds` in `PageModel`).
5. **Removed on one side, untouched on the other:** removed.
6. **Removed on one side, changed on the other** (the node itself or anything inside it): a conflict, "keep it with the changes" or "remove it". The same for a page and for a component definition that the other side still places.
7. **Moved on one side:** the move is taken. Moved to different places on both sides: a conflict.
8. **Order of children:** main's order is the starting point; nodes the branch added go after the sibling they followed on the branch (or first, when that sibling is gone). Both sides reordering the same parent's existing children is a conflict on that parent, main's order or the branch's.
9. **Slugs:** two pages ending with the same slug is a conflict the person settles by renaming one; the home page's empty slug never changes hands.
10. **References:** after merging, anything that points at a removed node, page or definition is reported: behaviour rules, `for` and `aria-*` attributes and the other references of `src/lib/renderer/idRefs.ts`, the 404 page setting, component placements, a form's thank-you page, and internal links to a page's address (counted with the same code `deletePage` uses, `src/lib/siteOps/pageLinks.ts`; a link to a slug that the other side renamed is reported too, since the redirect only exists once the site is published). A dangling reference the merge itself created is a conflict of rule 6's kind on the removed thing, never silently dropped.

11. **Site and page settings** merge per key like everything else: two different languages, consent modes or title templates are a conflict; a legal template page (Impressum, privacy, terms) is a page like any other, and its marker is one metadata field.

### The merged document must be a valid site

Before anything is written, the merged document is loaded on a scratch copy (`ProjectModel.create`), and must pass what a save checks: slug rules, theme limits, the size limit of every reusable component, behaviour trees that still read (`readBehaviourTree`), and the 10 MB body limit. A result that fails is refused with the reasons and nothing is written. This is `replaysCleanly` grown up.

### What is reused from `rebaseEdit`, and what is new

Reused, moved into `src/lib/siteMerge/` and then called from `rebaseEdit` so there is one implementation: `nodesOf`, the "unchanged since the base" comparison, the scratch-copy dry run with the component size limit. New work, and most of the merge slice: comparing two documents (the diff), structure (adds, removes, moves, order), pages and slugs, component definitions, settings, looking inside `props`, the reference check, and conflict objects with stable ids. `rebaseEdit` keeps its narrow job (one undo entry in an open tab) and gains nothing in scope from this plan.

## 6. Flows, states and the four paths

### Routes (all editor host only, the save route's guard chain, 404 for a project of another workspace)

- `POST /api/projects/<mainId>/branches` `{ name }` (`editSite`): creates the hidden site row, its pages and the `site_branches` row in one transaction that locks main's row, so the copy and `base_version` are of one moment.
- `GET /api/projects/<mainId>/branches` (`viewSite`): open branches with status, change counts and whether main moved; closed ones without content.
- `PATCH` and `DELETE /api/projects/<mainId>/branches/<branchId>` (`editSite`): rename, mark ready or back to open, discard.
- `GET /api/projects/<branchId>/branch/changes` (`viewSite`): the change list and conflicts, computed on request, never stored, with a `token` over the three versions.
- `POST /api/projects/<branchId>/branch/update` `{ token, resolutions }` (`editSite`): brings main in.
- `POST /api/projects/<branchId>/branch/approve` and `.../branch/send-back` `{ token, note }` (`reviewBranch`): approve the branch version seen; send it back to open with a note.
- `POST /api/projects/<branchId>/branch/merge` `{ token }` (`mergeBranch`): merge into main.
- `POST /api/projects/<mainId>/branches/<branchId>/undo-merge` (`mergeBranch`): main back to before that merge, the merged work into a new branch.

Closing a branch (merge or discard) deletes its hidden site row through the same cleanup a site delete runs: the kept document bodies, a running generation, skeleton plans, presence and open approvals of that id are ended, and its live streams get the closed notice. "Review and merge" saves the tab's unsaved work first, and the merge names the branch version it reviewed, so a second tab with unsaved edits is not merged unseen: its next save answers 410 `branch_closed`, and its dialog offers "Save mine as a new branch" (a new branch from main with that tab's copy as content) or discarding the edits.

Locking: update and merge take `SELECT ... FOR UPDATE` on main's row first, then the branch's, always in that order, as publish and erase take main's. Both run in one transaction; a failure leaves both sites and the branch record as they were.

### Derived state and what it is keyed to

| Derived state | Keyed to | Invalidated when |
|---|---|---|
| The change list and its `token` | base version, main version, branch version | any of the three moves: the request answers 409 `branch_review_stale`, the review reloads |
| One conflict answer in `merge_draft` | the conflict's stable id plus a hash of its base, main and branch values (two conflicts on different nodes can carry identical values, so the value hash alone would make their answers collide) | any of the three values changes. An answer whose values are unchanged is kept, also when main moved elsewhere. An erase of personal data clears every `merge_draft` of the site, since a hash of a value is still a trace of it (the erase tool's own rule) |
| An approval | the branch version it saw | any write to the branch (an edit, an update from main) |
| "Ready for review" | the branch | set back to open by discarding or by the author; an edit keeps it and withdraws the approval |
| An agent's merge approval | company, key, main, branch, branch version, main version | either version moves |
| "Undo this merge" | the site's latest merge and its kept `main_before_document` (one per site: the next merge replaces it) | a later merge landed, or the 30 days ran out (no longer offered). Main written since the merge does not block it: main as it is now, later changes included, becomes the new branch's content with `main_before_document` as its base, and main is written back to that document as a new version (the counter never rewinds). The dialog says so |

### The four stateful paths (`stateful-flow-testing.md`)

1. **Forward.** Create a branch, edit it, main does not move, review, approve, merge: main has one new version equal to the branch, the branch is closed, open editors of main adopt the merge as one undo step "Merged branch <name>", nothing is published.
2. **Backtrack and revise.**
   - Main changes during the review: the token no longer matches, the merge is refused and the review reloads with the new changes and conflicts. Conflict answers whose three values are unchanged are still there; answers to conflicts that changed or vanished are gone.
   - The author edits the branch after approval: the approval is withdrawn, the reviewer sees the new changes.
   - A conflict answer is changed from "main" to "branch": only that conflict's outcome changes.
   - The counter-case: the person leaves the review and comes back with nothing changed. The token still matches, every answer and the approval are kept, nothing is recomputed into a different result.
   - Updating from main, then undoing it in the branch's editor: the undo is an ordinary edit of the branch (a new version). `base_version` has moved, so the next "Update" finds nothing new from main, and the review shows the undone parts as differences against main. This is said in the undo's notice.
3. **Resume.** A reload in the middle of a review reads `merge_draft` and recomputes the conflicts: answers whose key no longer matches are discarded on load, never reattached; a draft written before the key existed parses as no answers. A request that failed or was cut off (update or merge) wrote nothing, so the same request is simply sent again. A branch editor reloaded mid-work is an ordinary editor reload. A restart of the server loses nothing: all of this is in the database, nothing in process memory.
4. **Re-entry after completion or failure.**
   - After a merge or a discard, the branch's address shows the closed notice; update, merge and writes to it answer 410 `branch_closed`; an agent that still holds the branch id gets the same.
   - A second merge request for the same branch (a double click, a retry after a lost answer) finds the branch merged and answers the first merge's result, never merging twice.
   - A new branch may take a closed branch's name and starts from main as it is now, with no draft, approval or answer left over.
   - A failed merge (validation refused, main moved, the lock timed out) leaves the branch open and reviewable.
   - Undoing a merge does not reopen the closed branch: it creates a new open branch holding the merged work, based on main as it was before the merge, so merging it again later is an ordinary merge. A second undo of the same merge finds it already undone and answers the first result.

## 7. Preview, the CMS, permissions and isolation

### Preview addresses

- **Version one: the signed-in preview, per branch.** `/projects/<branchId>/preview` already renders any site's working copy for a person who may open it. A branch gets a "Copy preview link" in its top bar and review page. A reviewer needs an account in the company with at least `viewSite`.
- **A public share link is a separate, optional slice** (S8), because it reopens the published copy plan's decision "No preview tokens" and puts unpublished content on an address anyone with the link can read. If Marlin wants it (see "For Marlin to decide"), the design is: an address `preview-<token>.sites.lumitra.co` under the existing wildcard certificate and wildcard record (no new certificate depth; `preview-` joins the reserved subdomain prefixes so no site can be given such a label), a token of 160 random bits stored hashed, created per branch by someone with `editSite`, with an expiry (7 days by default) and a revoke button, rendering the branch's working copy read only: `noindex` in the header and the page, `robots.txt` disallowing everything, no sitemap, forms and checkout inert with a visible "Preview" band, no analytics, and only GET routes in the `src/lib/hostRoutes.ts` allowlist for such a host.

### The CMS

- **Collections and rows are shared and live, on main and on every branch.** This is less than Framer, where CMS edits made on a branch stay there until it is applied (section 1). Here a branch changes how content is shown (pages, bindings, templates), not the content.
- **New content for a branch** uses what exists: a row with Status "Draft" shows in the editor and the signed-in preview and not on the published site.
- **Draft rows show on a branch as they do on main today:** the editor host reads through `getCmsRepository`, which shows drafts, and only published hosts read through `getPublishedCmsRepository`.
- **A schema change is not branched and is immediate** (removing a field breaks bindings on main at once). The review warns when the branch binds to a collection or field that no longer exists, and the merge check reports it like any dangling reference.
- **Not built in version one:** a branch-scoped copy of the CMS. It needs versioned rows and schema in the data-table adapter (`@marlinjai/data-table-adapter-prisma`, a package other apps use too) and a merge of row data, a project of its own size. Whether it follows is question 4 for Marlin.

### Permissions

| Action | Permission (today's mapping) |
|---|---|
| See branches, the change list, the preview | `viewSite` (`workspace.viewer`) |
| Create, edit, rename, update from main, mark ready, discard | `editSite` (`workspace.admin`) |
| Approve a branch or send it back with a note | a new action `reviewBranch` (`workspace.viewer`, so a reviewer with only `viewSite` can complete the review the section 3 flow promises). Approving names the branch version seen; sending back sets the branch to open and stores the note |
| Merge into main, undo a merge | a new action `mergeBranch` (`workspace.admin` for now, in `src/lib/permissions.ts`, so it can be tightened alone later) |
| Publish | unchanged, `publishSite`, on main only |
| An API key | what its role allows, as today; `merge_branch` additionally needs a person's approval |

### Tenant isolation

- A branch row carries its main's `workspace_id`, `tenant_group_id` and `company_id`, written by the creating transaction from main's row, never from the request, and the composite foreign key makes any other workspace impossible.
- Every branch route resolves the id it was given through the caller's verified scope (the workspace in the `WHERE`), then resolves the other side of the pair through the same scope. A branch or main of another workspace answers the same 404 as a missing one.
- The live stream, the document route, the MCP scope and the audit rows need no change: they are per site id and already scoped.
- Tests name a foreign company's branch id and main id in every new route and tool and expect 404 and nothing written, announced or audited.

### Every place keyed by a site, and how a missed one fails closed

| Place | What it must do with a branch | If the change were forgotten |
|---|---|---|
| `listSites` (dashboard) and MCP `list_sites` | List mains only, with a branch count | A branch shows as an extra draft site to its own company. Cosmetic, never a leak |
| Publish, rollback, unpublish | Refuse (`branch_cannot_publish`) | The `CHECK` constraint fails the write loudly |
| `ensureSiteDomain`, domain routes (`src/server/domains`) | Refuse | The trigger refuses the row |
| The public resolver (`publicResolver.ts`, `cachedResolver.ts`, `primaryHost.ts`) | Nothing | A branch is never `published` and has no domain, so it cannot resolve |
| `site_images` save check, upload, delete check | Use main's images; the delete check scans branches and stored documents | A save on a branch is refused (`SiteImageMissingError`): loud, nothing lost |
| The erase of personal data (`erasePersonalData`, search and proof) | Search and rewrite every open branch's working copy, every `base_document` and `main_before_document`, and raise every branch's `erasure_epoch` with main's, in the same transaction. After the transaction, for every branch: end its live generation, clear its document cache, and advance and announce its erased version so open branch editors reload and clear their undo history (a generation started before the erase must not keep streaming the erased value, and a cache must not retain it) | This one would fail open (an erased value could come back through a merge), so it is in the first slice, with a test that an erase followed by a merge leaves `remaining` at zero |
| Merge and update after an erase | Refused while the epochs of main, the branch and the tab differ | Covered by the existing epoch check in `writeWorkingCopy` |
| The company erasure consumer (`src/server/erasure/public.ts`) | Nothing: it deletes sites by workspace and company, and a branch is a site row there | Already covered; `site_branches` cascades from the site |
| Site delete (`deleteSite`, `src/server/forms/projectDelete.ts`) | Delete the branches with main | The foreign key cascades |
| Form submissions, commerce and catalogue (`editorTenant.ts`, `storefrontTenant.ts`, `catalog/repository/sites.ts`), A/B tests, Content Security Policy counts | Belong to main only; a branch has no storefront and collects nothing | A branch has no host, so no visitor request can reach them |
| `siteCompany.ts` (stamping the company on open) | Stamp as for a site | Same company by the foreign key |
| Live bounds (`liveBus.ts`, presence, plans, generation runs) | Count a branch as a site of the same company | Already per site id and per company |
| MCP approvals (`approvals.ts`, `approvalCheck.ts`) | A merge approval names main, the branch and both versions | A wrong subject is refused, as today |

A unit test walks every use of the site tables in `src` (as `hostRoutes.test.ts` walks the routes) and fails on one that is not classified in a table of "sees branches" or "mains only", so a new query has to decide before it ships.

## 8. Slices

Each slice is its own pull request with its tests, landed by land-pr. Sizes are in agent days. Everything sits behind one switch (section 9) until S9.

| # | Slice | Size | Accepted when |
|---|---|---|---|
| S1 | **Data model and repository.** The per-company switch; the migration with its constraints and triggers; create, list, rename, mark ready, discard; mains-only listings; refusals of publish, rollback and domains; uploaded images through main; the erase of personal data and its proof covering branches and stored documents; the classification test | 5 to 6 | Integration tests on real Postgres: a branch is an exact copy with the right base; each constraint refuses what it should (publish, a domain, a foreign workspace, a branch of a branch); a foreign company gets 404 everywhere; deleting main deletes its branches; an erase reaches every copy; forward, a retried create, and re-entry on a discarded branch |
| S2 | **The merge engine** (`src/lib/siteMerge/`, pure): diff, three-way merge, conflicts with stable ids, the validity check; `rebaseEdit` moved onto the shared pieces with its tests unchanged | 7 to 9 | A unit test per rule of section 5; property tests (merging a document with itself changes nothing; changes on disjoint nodes with no cross-node reference between them always merge without conflict and contain both (a branch that adds a reference to a node main removed is a rule 10 conflict, not a disjoint change); the result always loads as a `ProjectModel`); the real stored format run through the real schema (`parseRevisionDocument`), not only fixtures; the replay-on-top tests still pass |
| S3 | **Update and merge on the server.** The changes, update, approve and merge routes; the token; locking order; the merge written through `writeWorkingCopy` with origin `merge`; audit rows; `main_before_document` written at the merge | 4 to 5 | The four paths of section 6 as integration tests, including a merge racing a save of main (one wins, the other is refused, nothing half written), a double merge request, an injected failure at the last write, and an open editor of main adopting the merge as one undo step |
| S4 | **Branches in the editor.** The switcher, create, rename and discard dialogs, the branch badge, "Review and merge" in place of Publish, "Main has changed" with Update, the closed-branch page, the branch count on the dashboard | 3 to 4 | Component tests for each state (no branches, open, ready, behind main, closed); keyboard and screen reader checks; proven in the browser on app.lumitra.co |
| S5 | **The review.** The change list, the side-by-side view with changed nodes outlined, conflict answers with "all from main" and "all from the branch", ready and approved states, the merge button's states and refusals | 5 to 7 | Component and integration tests for backtrack (an answer changed, main moving mid-review, an edit after approval), resume (reload mid-review, stale answers dropped) and the counter-case (nothing changed, nothing lost); a review of a 200 node change renders in under a second |
| S6 | **MCP tools and the plugin.** `list_branches`, `create_branch`, `branch_status`, `update_branch`, `request_review`, `merge_branch` (approval), `discard_branch` (only a branch that key created); refusals on a branch id for `publish` and `rollback`; server instructions, tool descriptions, the "work on a branch" skill, plugin version | 3 to 4 | Tool tests for arguments, bounds, permissions and a foreign company; a merge without approval, with a stale approval and with a declined one writes nothing; the plugin's skill tests against the live tool list; a real agent session on production builds on a branch and asks for review |
| S7 | **Undo the latest merge**: main back to its kept copy, the merged work into a new branch, with its dialog, and the lazy removal of expired `main_before_document` values | 2 to 2.5 | Forward; main written since (the later changes are in the new branch, nothing is lost); a later merge landed or the 30 days ran out (no longer offered, the earlier kept copy is gone); a second undo (answers the first); an erase in between (the kept document was rewritten too); merging the new branch again |
| S8 | **Public share link** (only if Marlin says yes): the token, the `preview-` host, read-only rendering, expiry and revoke | 3 to 4 | A revoked or expired link answers 404; forms, checkout and analytics are inert; `noindex` everywhere; no POST route reachable; a token of another branch or company reads nothing |
| S9 | **Whole-feature review and proof.** Fresh reviewers for security and isolation, stateful flows, user experience and accessibility, performance; fixes; end-to-end proof on app.lumitra.co; the switch turned on | 3 to 4 | The proof list: a person's branch merged with an agent's concurrent write to main; a conflict settled; a reviewer without edit rights; an agent's merge approved and one declined; a merge undone and merged again |

Order: S1, then S2 (S4 can start beside it), S3, S5, S6, S7, S9; S8 wherever it fits after S3. **Total: about 32 to 42 agent days without the public share link, 35 to 46 with it.** The merge engine and the review are the two large pieces, and the estimate for S2 is the least certain: the live agent canvas plan already judged a per-node merge "sizeable".

## 9. Rollback

- **A switch per company.** The repository has no feature flag mechanism today, so S1 adds the smallest one: a server-side environment variable `SITE_BRANCHES_COMPANIES` (a list of company ids, or `*`), read in one function. Off by default, it hides the switcher, refuses the branch routes and the MCP tools with 404, and leaves everything else as it is. Turned on for Lumitra's own company first.
- **Turning it off later** hides branches without deleting them. Open branches stay in the database and come back when it is turned on again; main is unaffected, since nothing about main depends on a branch.
- **The migration is additive** and needs no reversing: one nullable column, constraints that every existing row satisfies, one new table. No backfill.
- **Rolling the code back past S1** is safe for visitors and for main, with one visible effect: older code lists a branch as one more draft site in its company's dashboard (it does not know the column). It cannot publish it (the `CHECK` refuses) or give it a domain (the trigger refuses). The runbook line for `deploy/README.md`: before rolling back past S1 with open branches, merge or discard them, or accept the extra dashboard entries until the code is rolled forward again.
- **An erase of personal data while rolled back** does not reach branch copies (fork points, pre-merge copies, branch names and notes), because older code does not know them. Merge or discard every branch before rolling back and run no erase meanwhile; an erase that had to run is repeated after rolling forward. A record whose branch older code deleted as a site is closed by a database trigger, keeping no copy (`deploy/README.md`, Site branches).
- **A bad merge** is undone by "Undo this merge" (the latest merge, for 30 days), and in an open editor by one undo. It never reaches visitors by itself: only a publish does, and a publish can be rolled back to any of the 30 kept revisions.

## 10. Decided here, say so if you disagree

1. **A branch copies the whole site's working copy**, not single pages: pages share components, theme and settings, and a page-only branch could not change any of them consistently.
2. **A branch's content is a hidden `sites` row**, so the editor, autosave, the version lock, the live stream, the preview and the MCP tools work on it unchanged; the database constraints make a branch unpublishable whatever code runs.
3. **Conflicts are settled only on the branch.** Main is brought into the branch by a three-way merge; merging into main requires an up-to-date branch and is then a plain write under the version lock.
4. **A branch starts from main's working copy**, not from the published revision. A fix for the live site while main holds unfinished work is not solved here; with branches, unfinished work belongs on a branch and main stays publishable.
5. **A branch is never published.** Merging and publishing stay two steps; there is no "merge and publish".
6. **Main stays editable while branches are open.** Locking main would turn branches into a queue.
7. **The CMS, commerce, forms, domains, A/B tests and published revisions are not branched.**
8. **The merge compares by node id, inside `props` and `style`, and treats text as one value.**
9. **Merged or discarded branches keep a record without content**; the content row is deleted at once, and main's pre-merge copy is kept 30 days for undoing the merge.
10. **An agent's `merge_branch` needs a person's approval**, like `publish`, although an agent may already write main directly with `apply_batch`: a merge is the moment a reviewed piece of work lands, and the approval is what makes "the agent works on a branch, a person reviews" real. An agent may discard only a branch its own key created (the lesson of `deletePage`: agents must be able to clean up their own test work).
11. **At most 10 open branches per site**, each within the existing 10 MB site limit, as constants in one place. A plan-tier limit, if any, replaces the constant (see below).
12. **No branch of a branch, and no moving work between branches** other than through main. Framer has nested branches; they multiply the merge paths and can be added later without changing the model (the parent pointer would then allow a branch as parent).
13. **The erase of personal data covers every branch and stored document from the first slice**, since otherwise a merge could bring an erased value back.
14. **Version one's preview is the signed-in preview.** A public link is S8 and needs Marlin's yes.
15. **A merged branch is never reopened.** Undoing a merge puts the work into a new branch instead, so a closed branch's id stays closed for good.
16. **Updating a branch from main is a button, not automatic.** Framer rebases branches onto main by itself. Here a silent update could change the canvas under the author and withdraw an approval without anyone acting; the top bar says that main has changed, and "Merge into main" runs the update itself when there is no conflict. Making a conflict-free update automatic later is a small change on top of the live stream.
17. **The interface says "merge" and "branch"**, not Framer's "apply".

Decided while building S1 (2026-11-11), say so if you disagree:

18. **No `schemaVersion` bump for the description.** `parseRevisionDocument` throws on a version it does not know, and a rolling deploy runs old and new containers side by side (`boot.sh`), so a bump would make every site published by the new code unreadable to the old one, which is also what section 9 promises a code rollback never does. `description` joins the revision document as an optional field read as `''` when absent; published revisions carry it too, harmlessly.
19. **A retried create names its id.** `POST .../branches` takes an optional `branchId` (a UUID the client chose). The same id from the same person on the same site answers the branch it made (200, `created: false`); any other row under that id answers 404 like a missing branch, so a caller learns only that an id it already holds is in use, never whose or what (ids are random UUIDs and cannot be guessed). The same id sent for two sites at once: the primary key decides and the loser gets the same 404.
20. **The rename version bump moves to S3.** Bumping `version` on a rename changes main's behaviour for every open editor tab and only matters once review tokens exist, so it lands with the tokens in S3.
21. **"An erase followed by a merge leaves nothing" is tested in S3**, where the merge exists. S1 proves the erase reaches every copy: open branches' working copies, their fork points, kept pre-merge copies, and a branch record's name and review note (a branch name or a note can hold the value too). The erase is started from main only; on a branch id it answers 409 `site_is_branch`.
22. **The closed notice on a branch's live stream is S4.** In S1 an open tab of a discarded branch hears 410 `branch_closed` on its next save or load; S4 adds the live notice and the closed page that reads it.
23. **A branch's `site_branches.branch_site_id` has a foreign key with `ON DELETE SET NULL`**, so whatever deletes a content row, the record reads as closed (410) rather than pointing at nothing. `DELETE /api/projects/<branchId>` is refused (409 `site_is_branch`): a branch is discarded from its site's branch list.
24. **The page settings address of a branch is its site's**: a branch has no address of its own, its pages will live there once merged and published.
25. **Closing a branch ends what a site delete ends, no more.** In S1 that is the kept document bodies and a running generation, in this process and, for the company erasure, for every branch that cascades with a main site of its batch. Presence, skeleton plans and approvals keep no per-site cleanup even for a deleted site, and they fail closed on a closed branch: an approval re-reads the site before it counts and a closed branch answers as changed, a skeleton plan is fulfilled only by a write that is refused with 410, and presence expires with the idle timeout. Section 6's wider list is met by these, plus S4's closed notice (decision 22).
26. **The list's change counts and "main moved" move to S3**, with the diff that counts them. S1's list answers each branch's state, name, fork version, who made it and when.
27. **A closed branch is a kind of missing site in code.** `BranchClosedError` extends `SiteNotFoundError`, so every existing caller that handles a missing site (the editor page, the live stream, MCP approvals, site operations) fails closed on it; the live stream guard, the branch routes and site operations say 410 `branch_closed` (site operations: `site_not_found` naming the main site, as their error codes are fixed).
28. **Locks are scoped, mains go first.** Every branch lock names the caller's workspace (and the branch lock its main), so a foreign id locks nothing; the company erasure deletes main sites and lets their branches go by the cascade, so no path locks a branch before its main; a branch save names images under a share lock on main's row, which an image delete takes for update.
29. **Branch names are compared in SQL only**, `lower(name)` as the unique index compares, for create, rename and the erase's rewrite of a name (which adds a number on a clash). A rename and the ready state asked together are one transaction.
30. **A record without content closes itself.** A trigger marks an open record discarded (and drops its fork point, draft and approval) when its content row goes some other way than a merge or a discard, so it never holds a name, a place under the cap or a copy.

## 11. For Marlin to decide (answered 2026-11-11)

Marlin took all four recommendations on 2026-11-11: (1) no tier logic, one constant of 10 open branches per site, switched on for Lumitra's own company first, the tier decided with Sites pricing; (2) no required second approval in version one; (3) yes to the public preview link, slice S8 after the core, 7 day expiry by default and a revoke button; (4) the CMS is not branched now.


1. **Which customers get branches, and at what price?** Options: every plan; from a paid tier up; with a different number of open branches per tier. **Recommendation:** build it without any tier logic (one constant, 10 open branches), turn it on for Lumitra's own company, and decide the tier when pricing for Sites is decided, as was done for the 3D scene quotas. For reference, Framer lists branching on its Pro plan (30 US dollars a month; its Enterprise column could not be read), Webflow and Figma only on their enterprise or organisation plans.
2. **Should a merge be able to require a second person's approval?** In version one a person with the right to merge can merge their own branch, which suits a one-person company, and approval is offered but not forced. A setting "merges need an approval from someone else" is a team feature and a likely tier line. **Recommendation:** not in version one; add the setting when the first team customer asks, since the approval state is already stored.
3. **Should there be a public preview link for people without an account (slice S8)?** Framer gives every branch one. It is how an agency shows a client a branch, and it reverses the earlier decision "No preview tokens", which was made for external frontends rather than for this. It puts unpublished content on an unguessable address. **Recommendation:** yes, as S8 after the core, with a 7 day expiry by default and a revoke button, because sending a client a link is the main reason an agency wants a branch preview at all.
4. **Should CMS content be branched too, as in Framer?** In version one a branch shares the live CMS: an editor who rewrites collection items while on a branch changes main's content at once, and the Draft status of a row is the only staging. Branching the CMS means versioned rows and collection schemas in the shared data-table package and a merge for row data, roughly a second project of this plan's size. **Recommendation:** not now. Ship design branches first, see whether real use asks for staged content beyond the Draft status, and plan CMS branching on its own if it does.

## Sources

Read on 2026-11-10.

Framer:
1. How to use branches in Framer (help centre): https://www.framer.com/help/articles/how-to-use-branches-in-framer/
2. Framer Academy, "Branching: explore variations safely": https://www.framer.com/academy/lessons/branching-explore-variations-safely
3. Introducing Framer 3.0 (blog): https://framer.com/blog/framer-3/
4. Framer Collaborate: https://www.framer.com/collaborate/
5. Framer pricing: https://www.framer.com/pricing
6. AI credits, simpler plans, and lower prices (blog): https://www.framer.com/blog/ai-credits-simpler-plans-and-lower-prices/
7. Staging and versions (help centre): https://www.framer.com/help/articles/staging-and-versions/
8. Dictionary, Auto-branching: https://www.framer.com/dictionary/auto-branching
9. Dictionary, Branch Preview: https://www.framer.com/dictionary/branch-preview
10. Dictionary, Agent Branch: https://www.framer.com/dictionary/agent-branch
11. Plugins 4.1 update: https://www.framer.com/updates/plugins-4-1
12. Developer changelog: https://framer.com/developers/changelog
13. Plugin reference, Branch: https://www.framer.com/developers/reference/plugins-branch
14. Plugin reference, merge: https://www.framer.com/developers/reference/plugins-branch-merge
15. Plugin reference, delete: https://www.framer.com/developers/reference/plugins-branch-delete
16. Plugin reference, getChanges: https://www.framer.com/developers/reference/plugins-branch-get-changes
17. Plugin reference, createBranch: https://www.framer.com/developers/reference/plugins-create-branch
18. Plugin reference, BranchChange: https://www.framer.com/developers/reference/plugins-type-branch-change
19. Plugin reference, BranchChangeType: https://www.framer.com/developers/reference/plugins-type-branch-change-type
20. Plugin reference, BranchCollectionChange: https://www.framer.com/developers/reference/plugins-type-branch-collection-change
21. Plugin reference, collection change items: https://www.framer.com/developers/reference/plugins-branch-collection-change-items
22. Plugin reference, BranchChangeBase: https://www.framer.com/developers/reference/plugins-type-branch-change-base
23. Plugin reference, BranchSiteSettingsChange: https://www.framer.com/developers/reference/plugins-type-branch-site-settings-change
24. Plugin reference, site settings change category: https://www.framer.com/developers/reference/plugins-type-branch-site-settings-change-category
25. Plugin reference, MergeBranchOptions: https://www.framer.com/developers/reference/plugins-type-merge-branch-options
26. Plugin reference, UnpublishedPageChange: https://www.framer.com/developers/reference/plugins-unpublished-page-change
27. Post by Framer's head of product (original, and the mirror it was read through): https://x.com/benjaminnathan/status/2069093239110397975 and https://api.fxtwitter.com/benjaminnathan/status/2069093239110397975
28. Framer's post linking to Collaborate (mirror): https://api.fxtwitter.com/framer/status/2071663891642544565

Third parties on Framer:
29. createwith, "Framer ships 3.0 with canvas-native AI agents and Git-style branching": https://createwith.com/tool/framer/updates/framer-ships-30-with-canvas-native-ai-agents-and-git-style-branching
30. yoframer (an affiliate blog): https://yoframer.com/framer-updates/framer-agents-branching-community-update/
31. oma-kase, Framer 3.0 launch: https://www.oma-kase.com/blog/framer-3-launch
32. dragdropship, review of Framer 3.0: https://dragdropship.com/blog/framer-3-0-is-here-agents-branching-and-a-bet-on-the-canvas
33. Stefano Designer, Framer 3.0 against Webflow: https://www.stefanodesigner.com/en/post/framer-3-0-agents-vs-webflow

Webflow:
34. Branch API overview: https://developers.webflow.com/data/v2.0.0-beta/reference/enterprise/branches/overview.md
35. Branch API merge: https://developers.webflow.com/data/v2.0.0-beta/reference/enterprise/branches/merge.md
36. Developer changelog of 2026-08-27: https://developers.webflow.com/home/changelog/2026/8/27.md
37. Webflow University, Page branching: https://university.webflow.com/lesson/page-branching

Figma:
38. Guide to branching: https://help.figma.com/hc/en-us/articles/360063144053
39. Merge a branch into the main file: https://help.figma.com/hc/en-us/articles/5691189138839/
40. Get updates from main files: https://help.figma.com/hc/en-us/articles/5665728006423

Not found or uncertain (a second pass on 2026-11-10 with a headless browser found Framer's community address redirecting to its marketplace, and the plan cells of the pricing table drawn as icons without text): Framer's conflict screen; whether Framer's Enterprise plan includes branching and whether any plan limits the number of branches; who may merge in Framer; how Framer branches code components, assets and localization; the format of Framer's branch preview address; user complaints (two community posts and one analysis did not load, and no forum threads turned up).
