---
title: Site branches
description: Plan for branching in Lumitra Sites, modelled on Framer's branching, so a person or an agent can change a copy of a site, have it reviewed, and merge it back into main.
summary: A branch is a hidden copy of a site's working copy that keeps its fork point. The editor, autosave, the version lock, the live stream, the preview and the Model Context Protocol (MCP) tools work on it unchanged, because it is a site row. A pure node-level three-way merge brings main into the branch, conflicts are settled on the branch, and merging into main is then one ordinary write under the version lock. Unlike Framer, Content Management System (CMS) content is not branched in version one; commerce, forms, domains and published revisions never are, and a branch can never be published to the live site. Nine slices of about 35 to 46 agent days, the public preview link included. Approved by Marlin on 2026-11-11 with all four recommendations; S1 to S8 are merged and three whole-feature reviews are fixed; S9, the proof on production, waits for Marlin's go for the deploy and the switch.
type: plan
status: in-progress
date: 2026-11-10
tags: [framer-clone, branches, merge, editor, mcp, publishing, plan]
projects: [framer-clone]
---

# Site branches

**Status:** in progress. Written 2026-11-10 at Marlin's request, approved by him on 2026-11-11 with all four recommendations of section 11 taken (answers recorded there). S1 to S8 are merged (#360, #361, #366, #367, #371, #372, #374, #376). Three whole-feature reviews ran on 2026-11-12 and their findings are fixed (decisions 86 to 97). What is left is S9, the proof on production, prepared in section 12: it needs a deploy of main and the switch for the Lumitra company, each Marlin's own yes, and both wait behind the contacts gate. The switch stays off until then.

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
- **No preview for someone who is not signed in.** The published copy plan decided "No preview tokens". (Since slice S8 a branch can have a public preview link, decisions 72 to 85; a main site's draft still cannot.)
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
| `undone_into_branch_id`, `undone_by`, `undone_at` | Set when this branch's merge was undone (S7, a second additive migration): the new branch that took the merged work, who undid it and when |
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
| Site settings | key path | theme tokens per token; the head as one value (its entries have no id, decision 31); business data per field; every other setting per key |

### Rules

1. **Only one side changed a part:** that side's value is taken.
2. **Both sides made the same change:** taken once.
3. **Both sides changed the same part differently:** a conflict. The person picks main's or the branch's value. Text is one value: two edits of the same text conflict as a whole, they are never spliced.
4. **Added on one side** (a node, a page, a definition, a token): kept. Added on both sides: both kept, since their ids differ. The same id added on both sides with different content (a rare id collision, in practice one copy pasted into both): a conflict, the person picks the copy they mean (decision 32).
5. **Removed on one side, untouched on the other:** removed.
6. **Removed on one side, changed on the other** (the node itself or anything inside it): a conflict, "keep it with the changes" or "remove it". The same for a page and for a component definition that the other side still places.
7. **Moved on one side:** the move is taken. Moved to different places on both sides: a conflict.
8. **Order of children:** main's order is the starting point; nodes the branch added go right after the nearest earlier sibling they followed on the branch that is still there (or first, when none is). Both sides reordering the same parent's existing children is a conflict on that parent, main's order or the branch's.
9. **Slugs:** two pages ending with the same slug is a conflict the person settles by renaming one; the home page's empty slug never changes hands.
10. **References:** after merging, anything that points at a removed node, page or definition is reported: behaviour rules, `for` and `aria-*` attributes and the other references of `src/lib/renderer/idRefs.ts`, the 404 page setting, component placements, a form's thank-you page, and internal links to a page's address (counted with the same code `deletePage` uses, `src/lib/siteOps/pageLinks.ts`; a link to a slug that the other side renamed is reported too, since the redirect only exists once the site is published). A dangling reference the merge itself created is a conflict of rule 6's kind on the removed thing, never silently dropped.

11. **Site and page settings** merge per key like everything else: two different languages, consent modes or title templates are a conflict; a legal template page (Impressum, privacy, terms) is a page like any other, and its marker is one metadata field.

### The merged document must be a valid site

Before anything is written, the merged document is loaded on a scratch copy (`ProjectModel.create`), and must pass what a save checks: slug rules, theme limits, the size limit of every reusable component, behaviour trees that still read (`readBehaviourTree`), and the 10 MB body limit. A result that fails is refused with the reasons and nothing is written. This is `replaysCleanly` grown up.

### What is reused from `rebaseEdit`, and what is new

Moved into `src/lib/siteMerge/shared.ts` so there is one implementation: `nodesOf`, `findNode` and the scratch-copy dry run (`replaysCleanly`), whose component size rule (`outgrewLimit`) the merge's validity check calls too. The merge walks documents in its own flat form (`flatten` in `tree.ts`, node by id with parent and children per container), since it needs parents and order, which `nodesOf` does not keep. New work, and most of the merge slice: comparing two documents (the diff), structure (adds, removes, moves, order), pages and slugs, component definitions, settings, looking inside `props`, the reference check, and conflict objects with stable ids. `rebaseEdit` keeps its narrow job (one undo entry in an open tab) and gains nothing in scope from this plan.

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
28. **Locks are scoped, mains go first.** Every branch lock names the caller's workspace (and the branch lock its main), so a foreign id locks nothing; the company erasure deletes main sites and lets their branches go by the cascade, so no path locks a branch before its main; publish and the erase of personal data scope their row locks the same way. A branch save that names an image takes no lock on main: an image delete scans every branch's pages and both run serializable, so they cannot both commit (a lock there only made branch saves retry while main was being edited).
29. **Branch names are compared in SQL only**, `lower(name)` as the unique index compares, for create, rename and the erase's rewrite of a name (which adds a number on a clash). A rename and the ready state asked together are one transaction.
30. **A record without content closes itself.** A trigger marks an open record discarded (and drops its fork point, draft and approval) when its content row goes some other way than a merge or a discard, so it never holds a name, a place under the cap or a copy.
31. **The head is one value.** Its items carry no id, and merging a list by position is what this merge never does: two different changes to the head are one conflict. Theme tokens, a component's inputs and its states carry ids and merge item by item.
32. **The same id added on both sides with different content is a conflict**, never renamed into two copies: ids are uuids, so this only happens when one copy was pasted into both, and the person knows which one they mean.
33. **A page's timestamps never conflict.** They move with any edit, so they are left out of the comparison and follow the content that stands (main's, or the later one when the branch's content was taken).
34. **Rule 10 asks instead of guessing, from the result.** The merge runs, then looks at what the result points at and does not hold, where main and the branch alone did not leave that same reference (the same referring node, the same target) broken: a behaviour rule, an HTML id reference, a link to an address, a form's thank-you page, the 404 setting, a placement. Each such thing's removal is asked as a rule 6 conflict, and the merge runs again, until a run asks nothing new. Answering "remove" leaves the reference reported with the result. Reference kinds are read through the walks copy and paste already use (`remapBehaviourRefs`, `withFollowedRefs`) and the address keys `deletePage` counts links with, so a new kind there is seen here too.
35. **All three documents go through the editor model before the merge** (S3's job, on the server): a document written without the model's defaults (an import, an old tool) would otherwise count as changed in every node. The merge itself takes defaults added on one side as a change of other keys, so it never conflicts on them; the counts of changes are what would be wrong.
36. **Nodes are matched within one page or component.** A node moved to another page on one side is a removal there and an addition on the other page; when the other side edited it, the removal is asked. Kept in both places, the merged site holds one id twice, which the validity check refuses (unless the site already had that), so the person must take one side before it is written.

Decided while building S3 (2026-11-11), say so if you disagree:

37. **No version bump on a rename after all (revises decision 20).** The review token covers both site names besides the versions and erasure epochs, so a rename of main or of the branch makes an open review stale without changing what a rename does to every open editor tab. A save does not write the name, so the merge and the update write it in the same transaction. A branch whose main was renamed since the fork point counts as behind main even at the same version, so the update merges the two names like any other field: one rename is taken, two different ones are a conflict, and no name is dropped without a word.
38. **"Merge" on a branch behind main runs the update with the answers stored so far and stops**: 409 `branch_updated_from_main` with the new token (the branch's version moved, so an approval is withdrawn and the review is shown again), or 409 `branch_conflicts` when that needs answers. Nothing reaches main in that request.
39. **Answers are stored by an update request only.** There is no separate "save answers" route: an update stores the answers that applied before it tries anything else, so one that leaves a conflict open, finds the result invalid, or fails at its write keeps them (409 `branch_conflicts` with what is left, and `answersKept: false` when main or the branch moved meanwhile, so the person knows to give them again). The token an update answers is built from what it wrote, never read again after the commit. Only an explicit update writes the branch. The review read replaces the draft with the answers that still apply, only while nothing moved since it read, so an answer whose values changed is gone for good and does not come back when they change back.
40. **Merging does not require an approval** (Marlin's answer 2). Approve and send back work on an open or a ready branch; send back sets it to open with the note (control and bidirectional characters removed, at most 2,000 characters).
41. **Going through the editor model may add but never lose.** A stored page, component definition or node that the model's copy of main or the branch lacks refuses the review with `does_not_load` and its first id, and nothing is written: the merge would otherwise read it as removed and write that.
42. **An erase keeps an up-to-date branch up to date.** It rewrites main and a branch's fork point the same way, so a branch whose `base_version` was main's version moves with main's new version, instead of every branch reading as behind main after an erase. Only when the erase left the value nowhere (`remaining` is 0): an erase of some matches may rewrite main and not the fork point, and that branch stays behind main, so the three-way merge keeps main's erased text instead of writing the branch's copy over it. Review bodies are capped at 1.5 MB before they are parsed.
43. **Audit rows of an update or a merge hold ids and versions only** (`branch_update` on the branch, `branch_merge` on main): the erase does not rewrite audit rows, and a branch name can hold personal data. The live event carries the branch name for the undo step "Merged branch <name>"; it is not stored.
44. **A conflict value over 4,096 characters is shown as its size**, never sent whole (a removed page is a whole page); the fingerprint is computed on the server from the full values.
45. **`reviewBranch` and `mergeBranch` map to existing relations** (`workspace.viewer`, `workspace.admin`), so the permission model in auth-brain is unchanged.
46. **Compute outside, verify inside.** The three documents are read in one REPEATABLE READ snapshot and merged and checked with no lock held; the write locks main's row, then the branch's, re-reads the token's state and writes only when it is unchanged, SERIALIZABLE and retried on a serialization failure like a save. A failure at any step writes nothing; a concurrent second merge finds the first one's result.
47. **The editor page is told what the site is (S4).** The loader returns main (with its open branch count) or a branch (its record and its main's name), read through the caller's workspace; a merged or discarded branch's address renders a page naming what happened and when, linking to the site. With the switch off, main is told nothing and a branch's editor and preview answer 404, as the branch routes do.
48. **Each branch is its own address, and leaving saves first.** The switcher does a full navigation to `/projects/<id>` after this tab's work is saved; when it cannot be saved it stays and says why. After a merge or a discard the branch's working copy is given up before leaving, so no save or unsaved warning meets the closed branch.
49. **On a branch, main-only controls are left out**: Publish gives way to "Review and merge", and Published versions, Domains and Form submissions are hidden (decision 7). Site settings and the theme stay, because a branch changes them.
50. **S4's "Review and merge" was a compact dialog** (replaced in S5 by the review page, decision 55): what the branch and main changed, the conflicts by count, the validity problems, and Merge only when none of them is open and the branch changes something. Answering conflicts one by one is S5's review, which replaces this dialog; the switch stays off until S9, so no customer meets the gap. Update from main refuses to run over conflicts and says the branch is unchanged.
51. **"Main has changed" is read, not pushed.** Main's writes are announced on main's stream, not the branch's, so a branch tab reads its record again when it comes back into view and once a minute.
52. **The review stores answers as they are given (S5).** A new route, `POST /api/projects/<branchId>/branch/answers` (editSite), keeps conflict answers in the branch's draft without bringing main in; Update applies them. It is refused as stale only when the documents moved, never because another answer was stored meanwhile (a second click or tab): that one is laid under and retried. A viewer reads the review and answers nothing.
53. **The change list names elements, with old and new values (S5).** `src/lib/siteMerge/elementChanges.ts` lists per page and component each added, removed, moved and changed element with its changed fields, values capped at 4,096 characters as conflicts are; computed on each read, never stored. A reorder marks only the elements outside the longest common order. The reference to where the analytics key is kept is named as changed without its value. Where a frame or floating element sits on the editor's canvas (`canvasX`, `canvasY`, scale, rotation, stacking, visibility, lock) is not listed: no visitor sees it. The screen's totals are counted from this list.
54. **Main and the branch are drawn in two shadow roots (S5).** The preview's theme sheet and rule sheets are written for one page per document and main and the branch share node ids, so in one document each pane would take the other's styles (the browser proof fails without the roots). Each pane draws a standalone, read-only copy of the site at the desktop width, scaled to the pane; nothing of it is registered with the editor, saved or synced. Outlines come from a per-pane sheet keyed on the listed ids. A changed component is drawn on its own page in both panes with the same outlines; every page that places it shows the same change.
55. **The review page knows what the person may do (S5).** `/projects/<branchId>/review` loads main and the branch under the caller's workspace and checks editSite, reviewBranch and mergeBranch, so each control is off with its reason instead of failing on a 403; when the permission service does not answer, the controls stay on and the server decides. When the review data names newer versions than the pictures, the page reloads them. "Review and merge" in the editor opens this page; decision 50's dialog is gone, and an Update that meets conflicts points here.

Decided while building S6 (2026-11-11), say so if you disagree:

56. **The branch tools exist only for a company with the switch on.** For any other key they are not in the tool list, calling one answers "unknown tool" like any name the server does not have, and the server instructions do not mention branches (section 9 said "refuses the MCP tools with 404"; a tool that is listed and always refuses would send every agent after it). Inside the operations the switch is checked again and answers like a missing site.
57. **A branch tool names the branch as `branchId`, and that id is a `siteId` for every existing tool.** `list_branches` and `create_branch` take the site; `branch_status`, `update_branch`, `request_review`, `merge_branch` and `discard_branch` take the branch. The operations (`src/server/siteOps/branches.ts`) call the same repository and merge service as the editor's routes and have no write path of their own.
58. **`merge_branch` asks the person only for a merge that would go through.** Behind main (`branch_behind_main`), with problems, with nothing changed or with a stale token it is refused before any dialog or link. It never runs decision 38's update inside a merge on its own initiative first: bringing main in is the agent's own `update_branch`, after which it looks at the result. If main or the branch moves between the approval and the write, the token no longer matches and the merge answers `branch_review_stale`: being behind main is part of what the token covers, so the merge service's update-and-stop (`branch_updated_from_main`) is never reached through this tool.
59. **A merge approval is for one exact state and is given by someone who may merge.** Its subject names the site, the branch, both versions and the review token (which also covers both names and erasure epochs), so any write to either side makes it useless. The approval page sits under the site's address and checks `mergeBranch`, not `publishSite`, since a merge publishes nothing; it refuses when either version moved or the branch was closed. Keys may hold `mergeBranch` (`MACHINE_ACTIONS`), always behind this approval.
60. **`publish` and `rollback` on a branch id are refused before the person is asked** (`branch_cannot_publish`, naming the branch's site), with the switch on or off: a branch made while it was on stays a branch.
61. **Answers name no person.** Who made a branch is told as a kind (user or key) and whether it was this key, which is all `discard_branch` needs. The review note is passed on as data. Audit rows of `create_branch`, `request_review` and `discard_branch` (`branch_create`, `branch_review`, `branch_discard`, on the site) hold the branch id and versions, never its name (decision 43).
62. **Bounds.** A status or a conflict refusal lists at most 50 conflicts and says how many there are; one `update_branch` takes at most 200 answers; the branch tools share the per-key write and read limits of the other tools, and a merge approval counts against the approval limit.
63. **The plugin (0.4.0) ships the "work on a branch" skill before the switch is on.** The public plugin mirror follows main, so the skill reaches agents while no company has branches. It therefore starts by checking that `create_branch` is in the server's tool list and otherwise sends the agent to the edit-a-site skill; the three site skills name no branch tool; the README says the branch tools are listed only for a company with branches switched on. S6's last acceptance line, a real agent session on production that builds on a branch and asks for review, needs the switch and is part of S9's proof list.

Decided while building S7 (2026-11-11), say so if you disagree:

64. **An undone merge is recorded on the merged branch.** Three nullable columns (`undone_into_branch_id`, `undone_by`, `undone_at`, migration `20261112000000_site_branch_merge_undo`, additive; a fourth, `main_before_ended`, is decision 70) say that the merge was undone and which new branch holds the work. The record stays `merged` and closed (decision 15). Everything that says "its work is on its site" reads the marker and says the opposite when it is set: the closed-branch page, the branch list, and the agent tools' `branch_closed` and repeated `merge_branch` answers. A second undo finds the marker and answers the first result.
65. **The undo reads and writes under the site's row lock, in one transaction.** The kept copy, the site as it is now, the erasure epoch, the 30 days and the open branches' names are all read after the lock is taken. The transaction is read committed, not serializable: every other writer of the site, of its branches' names and of the kept copy takes the same lock or writes the site's row, so each statement after the lock sees what was committed while the undo waited (a branch made or renamed meanwhile). Serializable added only failures against unrelated transactions reading the same tables; in the integration tests six retries in a row failed that way. An erase of personal data rewrites the kept copy under the same lock, so a copy read earlier could put an erased value back on the site.
66. **What the undo writes.** The new branch's content is the site's rows as stored at that moment, copied as a create copies them; its fork point is the kept copy and its base version is the site's version after the write back, so it is up to date and merging it again is an ordinary merge. The site is written back through the save (its checks, its redirect upkeep) as a new version, and its name is restored beside it, since a save does not write the name. The new branch belongs to whoever undid the merge and takes the merged branch's name, or that name with a number when an open branch holds it.
67. **When it is refused, it says what to do.** 30 days over: edit the site or publish an earlier version. A later merge landed: only the latest merge can be undone. An erase removed the kept copy, or the editor cannot load it in full (decisions 70 and 71): the same advice as after 30 days. All with nothing written. Once refused this way the page drops the offer and keeps the reason. The limit of open branches does not apply to an undo (changed after the independent review of S7, 2026-11-12): the refusal used to say "merge or discard one first", and merging one ends the undo for good, since only the latest merge keeps a copy. The undo moves work that is already on the site, so the site can hold one branch more than the limit, never more: the next undo needs a merge first, and making a branch stays refused.
68. **The undo is offered on the merged branch's old address**, with a dialog that says the site's later changes move to the new branch too and that nothing is published or unpublished. It needs `mergeBranch`. There is no agent tool for it: undoing a merge is a person's decision about the site, and an agent that finds a merge undone is told where the work went.
69. **The kept copy is removed when the site's branches are next listed after its 30 days**, not by a timer; until then an undo is refused by its date. (Widened by decision 92: the editor's page and an erase remove it too, and every reader treats it as gone from its date on.)
70. **An erase of personal data that leaves a match in the kept copy removes that copy** (independent review of S7, 2026-11-12). The owner can tick only the listed matches, and the kept copy is listed last, so an erase could clean the working copy and leave the value in the kept copy; the undo writes that copy over the site whole and would bring the value back into the working copy, publishable. A merge is safe in the same case because the three-way merge keeps main's erased text; the undo has no such step. So the erase drops a kept copy it could not clean fully, and the undo is refused with the reason. The reason a kept copy went without an undo is stored in a fourth nullable column, `main_before_ended` (`expired`, `replaced`, `erased`), in the same migration, so a page loaded earlier is told the right one. The cost, accepted: an owner who erases only part of a value loses the undo of the latest merge.
71. **The kept copy goes back as it was stored, or not at all.** Its page addresses are taken as stored, so the rules for new and changed addresses do not refuse a copy the site already held (an address stored before the rules, which the merge had tidied). A copy that this version of the editor cannot load in full, or that no longer parses, is not written: the undo is refused as not available and the cause is logged, since a part the model drops on load would be lost from the site without a word.

Decided while building S8 (2026-11-12), say so if you disagree:

72. **The public preview link is its own kind of host** (slice S8). `preview-<token>.<sites base host>` is neither the editor nor a published site. The middleware knows it by the shape of the host alone (it cannot read the database) and gives it GET and HEAD on the site pages and on the three catalogue reads a page's shop parts make, and nothing else: no form submit, order, payment, report, other API or server action, whatever the token. Routes carry a `preview` mark in `src/lib/hostRoutes.ts` beside `published`, and the host route test runs every route and method against a preview host too. A label that starts with `preview-` is reserved and never looked up as a site, so made-up preview addresses cost no read and push nothing out of the published resolver's caches.
73. **Only a SHA-256 of the token is stored**, so the table (and a backup of it) opens no preview, and the address can be shown exactly once, when the link is made. The dialog is built around that: a link from before is shown with its dates and without its address, and the way on is a new link, which replaces the old one at once. A branch has at most one link (table `site_branch_previews`, migration `20261112120000_site_branch_previews`, additive, tied to its branch and workspace by a composite foreign key).
74. **A link ends at once, from every place.** It is resolved by one indexed read on every request and never cached; every answer of a preview host says `private, no-store`. Revoking deletes the row, expiry is checked per request, closing the branch (merge, discard) deletes the row in the same transaction, and the per-company switch going off hides it. Durations are 1, 7 (default, as approved) or 30 days. (Narrowed by decisions 88 to 90: an unknown token, a branch's content under its exact version, and a picture in the visitor's own browser may be remembered; whether a link is live never is.)
75. **The address is the secret, so nothing may carry it away or point at it.** Every answer sends `x-robots-tag: noindex, nofollow, noarchive`, `referrer-policy: no-referrer` (a link on the page or a font loaded from elsewhere would otherwise hand the address to that site) and forbids framing. The page's metadata is never indexed and has no canonical address, no Open Graph address and no manifest; `robots.txt` disallows everything and there is no sitemap, since such a host names no published site.
76. **A preview renders the branch under main's site id**, because the catalogue's hidden-product rules and the uploaded images are per site and belong to main. Its memo key names the branch and its version, so nothing memoised for a preview can be served for main. Analytics are off whatever the site says. Images are served to a preview host privately (never stored, same origin only), not with the year-long public cache a published host gets.
77. **Inert means said, not only refused.** The middleware's refusal is the enforcement. On top of it every page of a preview carries a band (not the live site, which branch, until when), a form shows "This is a preview: nothing is sent or ordered from it" instead of sending and has no address to post to, and the checkout says the same through the path the editor's own preview already uses.
78. **No agent tool makes or revokes a public link**, and the routes need a signed-in person with `editSite` (reading whether one exists needs `viewSite`). What leaves the company is a person's decision, as with undoing a merge. Making and revoking are audited with ids and the day count only, never the token, its hash or the address.
79. **This reverses "No preview tokens"** of the published copy plan (`docs/plans/2026-11-01-immutable-published-copy.md`) for branches only, as Marlin decided on 2026-11-11. That decision was made for external frontends, which no longer exist. A main site's draft still has only the signed-in preview.
80. **The token is in the hostname, so the certificate must be one wildcard, never one per host** (independent security review of S8, 2026-11-12). A certificate issued for a single preview host would publish that host, and with it the branch, in the public certificate transparency logs. Checked on 2026-11-12: a label nobody had asked for before is served with the certificate `*.sites.lumitra.co` (Let's Encrypt, issued by DNS validation), so no per-host certificate is ever made. This is a standing condition of the feature and is written into `deploy/README.md`; S9 checks it again on a real link. What remains inherent to a secret in a hostname and is accepted: it is seen by the visitor's DNS resolver, in the TLS server name on the wire, and in the proxy's access log on our own server.
81. **A stored node cannot undo what the preview host promises** (same review). Before a preview renders, `referrerpolicy`, `action`, `formaction` and `ping` are dropped from every node (an image or link with its own referrer policy would hand the address to the host it points at; a plain form posting to a newsletter service would really subscribe a visitor while the band says forms are off), and a map box becomes a note of the same shape, because its frame is told the page it sits on. Nothing on a preview asks for maps consent.
82. **The image and catalogue routes resolve a link without loading the branch** (`resolvePreviewLink`: one indexed read), since a page with thirty pictures asks thirty times and nothing of a preview is cached; only the page itself loads the content.
83. **A link is made only where it can show something.** The switch is read for the site's company as it is today, falling back to the one the branch record copied; a site not linked to a company yet is refused with what to do (open the site in the editor once) instead of getting an address that answers 404 for ever.
84. **No preview is served on an editor host.** With no `EDITOR_HOST` (development), every host counts as the editor and gets none of the middleware's preview rules, so the resolver answers nothing there; production cannot start without `EDITOR_HOST`.
85. **A link's end is shown to the minute, in UTC**, in the dialog and on the band: a link made late in the day ends at that time of its last day, not at midnight.

Decided after the whole-feature review (2026-11-12), say so if you disagree. Three independent reviews of S1 to S8 together (isolation and security; data integrity and the flows; usability, accessibility and performance) found no code blocker for one company. Everything they found is fixed in the pull request that carries these decisions, each with a test:

86. **Ending something works with the switch off.** Discarding a branch and revoking its public preview link pass the per-company switch (step 3 of the route guard) and nothing else: the editor host, the session, the active company and the permission all still apply. With the switch off a link is hidden, not deleted, and showed again the day the switch returned; a person who wants it gone can now end it. Every other branch route still answers 404 then, and the agent tools stay unlisted (decision 56 stands: with the switch off there is no branch an agent could have been asked to discard).
87. **Two database backstops and one stored column, in a fourth additive migration** (`20261112180000_site_branch_backstops`). (a) A second foreign key beside the first ties a record's content row to the record's own workspace, `(branch_site_id, workspace_id)` to `sites(id, workspace_id)`, with `ON DELETE SET NULL (branch_site_id)`: only the pointer is cleared, the required workspace stays. That column list needs Postgres 15 or later; production and the tests run 16. Prisma cannot write it, so its schema keeps naming the first key and says so. (b) A trigger refuses a record whose site is itself a branch. (c) `base_name`, a stored generated column (`base_document->>'name'`): "was the site renamed since this branch was made" is asked on every status read and used to unpack the whole fork document (up to 10 MB) of every open branch each time. A generated column cannot drift from the document, whoever writes it, so no writer had to be changed. The read also asks for the one branch when only one is wanted.
88. **A token that names no link is remembered for 30 seconds** (in the process, at most 1,000, the oldest dropped), as the published resolver already remembers unknown hosts. A dead address asked again and again (a revoked link still open in a tab with its pictures, a made-up one in a loop) then costs no read. Only "no such row" is remembered. This narrows decision 74's "never cached": a link that exists is still read on every request, so revoking, expiry, a closed branch and the switch are never delayed, and a token is made here at the moment its link is made, so a hash remembered as unknown cannot become a link. A flood of different made-up tokens still costs one indexed read each, exactly as a flood of made-up published hosts does; guessing a 160 bit token stays out of reach.
89. **A preview's content is kept under its exact version, behind the link check.** A page view used to load and parse the whole branch every time, and the favicon request loaded it a second time. Now the link is resolved first on every request (unchanged), then one small row of the branch is read (its version, its erasure epoch, its name), and the parsed content is reused when the process holds it for that version and epoch: one entry per branch, 8 branches, 5 minutes. The site name is read every time, because a rename moves no version. The favicon reads the link and the branch's settings only. This narrows decisions 74 and 82: what is remembered is content, never whether a link is live.
90. **A preview's images are revalidated, not refetched** (this changes decision 76's "never stored" for images only). They answer `cache-control: private, no-cache` with their content hash as validator: the visitor's own browser may keep the bytes but must ask every time, and the 304 is given only after the link was resolved for that request, so a revoked or expired link still ends every picture at once. A page with thirty pictures then costs thirty small answers on a second view instead of thirty downloads. Pages, the favicon and every refusal stay `private, no-store`.
91. **Closed records are bounded: 50 per site.** Merged and discarded records hold a name and a note and no content; without a bound they grew for ever and an erase of personal data read every one. The oldest beyond 50 are deleted when a branch is closed, in that transaction and under the site's lock, never by a read. Kept whatever their age: a merged record whose copy for the undo is still live, and a record that another names as where its undone merge went. A record's age is when it was closed. The switcher still lists the 20 most recent. The cost, accepted: the old address of a branch closed more than 50 closings ago answers as a missing site instead of saying what happened to it. The erase now loads a record's documents only where it holds one, so a closed record without a kept copy costs no read of its own.
92. **The copy kept for the undo is over after its 30 days for every reader, and removed by more than the branch list** (this widens decision 69). The undo refuses it by its date, the summaries offer no undo, the erase's search does not list it, and the check that keeps an uploaded image from being deleted no longer counts it, whether or not it has been cleared. It is cleared by the branch list, by opening the editor on the site, on one of its branches or on the merged branch's old address (with the switch on or off: how long a copy lives does not depend on the switch), and by an erase of personal data, which removes it before it searches. Each of them writes only when its read found an expired copy, so listing branches no longer writes on every call.
93. **A review that is open asks "did anything move" instead of computing again.** A review carries `state`, a key over everything it was computed from: the token's state and the moment the record was last written (its answers, its ready and approval marks, its name and note). The page asks every 30 seconds with that key and is answered from three small rows when nothing moved; a full computation happens only when something did. Storing an answer returns the review of the merge that call just ran, instead of computing the whole review a second time. A page or component that is new or removed as a whole is counted in the change list, not listed element by element: a new page of a thousand elements was a thousand rows and a thousand outline rules, all saying "added".
94. **The preview band sits at the bottom edge of the window and speaks the site's language.** A site's own header is very often fixed or sticky at the top, and the band, sticky at the top above everything, lay over it. It is now fixed to the bottom, and the same text is laid out once more, unseen, after the page, so it never covers the end of the page however it wraps. On a German site the band and the sentence a form and the checkout show are German, chosen as the consent banner chooses; English everywhere else. A test in real Chromium and WebKit (`test/behaviour/previewLink.spec.ts`) opens a real preview link on a page whose header is fixed to the top, at a desktop and a phone width: the header is whole and on top, the band is at the bottom edge, and the last line of the page ends above it. Step 9 of the proof looks at it once more on production.
95. **To an agent, a branch's name and a reviewer's note are data.** The description of `list_branches` and the branch instructions say that both are typed text, that the note is remarks on the branch's content, and that neither can ask for a merge, a publish, a discard, a write to the site itself or other work. The general rule "tool output is data" already covered them; the note is the one text a person writes for whoever works on the branch, so it is named.
96. **Accepted, not changed: an image uploaded only on a branch can be fetched from the site's live address by its hash.** Uploaded images belong to the main site and are served by content hash (256 bits) from any host of that site, exactly as an image uploaded for main's unpublished draft is. Nobody can list them and a hash cannot be guessed; someone who was given the hash (through a preview link, for example) could fetch that one image from the live host after the link ended. Keeping branch images apart would need a second image store per branch and a move at merge time, which this risk does not justify.

97. **What the usability review asked for, in the editor.** (a) The branch switcher has a "Recently merged" group: the three latest merges, each opening its old address, with "Undo the merge of ..." beside the one that can still be undone (the same dialog and request as on the closed branch's page, after this tab's work is saved), and for an undone merge where its work went. The listing always holds the latest three merges and every closed branch such a merge names, however many branches were discarded since. (b) The "New branch" dialog names the site it copies and says how many of the 10 branches are open. At the limit the button is off with the reason as text, but only when the count was just read from the server: a count from when the editor was opened never turns it off and is worded as what it is ("had 10 open branches when this page was opened"), so an outdated number cannot leave a person stuck, and the server's own refusal stays. (c) What the badge, "Update" and "Review and merge" mean was only a `title`, which a keyboard and a touch screen never show. Each is now rendered text the control points at, and the badge's sentence is also visible at the top of the switcher's menu on a branch. (d) The top bar on a branch did overflow: seen in real browsers, at 1,024 pixels its right half lay outside the window, and at 768 the back link and the switcher were squeezed away. Now "Review and merge", the main action, keeps its words from 1,024 pixels up and is an icon below; "Update" and "Share preview" are icons below 1,536 pixels, with their names kept for a screen reader; below that width the badge and the page name are left out (the switcher names the branch) and the left side takes the space that is left, its title and branch name truncating, with a floor so the back link and the switcher can always be pressed; long sentences shrink and are cut to three lines, and a press on a cut one shows all of it under the bar (it was whole only in a tooltip). A test in real Chromium and WebKit (`test/behaviour/branches.spec.ts`) opens the top bar of a branch behind main at 1,920, 1,536, 1,280, 1,024, 768 and 390 pixels and checks that every control is inside the window, none lies over another and each can be pressed, with the save status a stored site shows; the same for a site that is not a branch at 1,024, 768 and 390 pixels.

## 11. For Marlin to decide (answered 2026-11-11)

Marlin took all four recommendations on 2026-11-11: (1) no tier logic, one constant of 10 open branches per site, switched on for Lumitra's own company first, the tier decided with Sites pricing; (2) no required second approval in version one; (3) yes to the public preview link, slice S8 after the core, 7 day expiry by default and a revoke button; (4) the CMS is not branched now.


1. **Which customers get branches, and at what price?** Options: every plan; from a paid tier up; with a different number of open branches per tier. **Recommendation:** build it without any tier logic (one constant, 10 open branches), turn it on for Lumitra's own company, and decide the tier when pricing for Sites is decided, as was done for the 3D scene quotas. For reference, Framer lists branching on its Pro plan (30 US dollars a month; its Enterprise column could not be read), Webflow and Figma only on their enterprise or organisation plans.
2. **Should a merge be able to require a second person's approval?** In version one a person with the right to merge can merge their own branch, which suits a one-person company, and approval is offered but not forced. A setting "merges need an approval from someone else" is a team feature and a likely tier line. **Recommendation:** not in version one; add the setting when the first team customer asks, since the approval state is already stored.
3. **Should there be a public preview link for people without an account (slice S8)?** Framer gives every branch one. It is how an agency shows a client a branch, and it reverses the earlier decision "No preview tokens", which was made for external frontends rather than for this. It puts unpublished content on an unguessable address. **Recommendation:** yes, as S8 after the core, with a 7 day expiry by default and a revoke button, because sending a client a link is the main reason an agency wants a branch preview at all.
4. **Should CMS content be branched too, as in Framer?** In version one a branch shares the live CMS: an editor who rewrites collection items while on a branch changes main's content at once, and the Draft status of a row is the only staging. Branching the CMS means versioned rows and collection schemas in the shared data-table package and a merge for row data, roughly a second project of this plan's size. **Recommendation:** not now. Ship design branches first, see whether real use asks for staged content beyond the Draft status, and plan CMS branching on its own if it does.

## 12. S9: the production proof, prepared on 2026-11-12

Nothing in this section has been done on production. It records what production looks like, everything a deploy would carry and what it depends on, what the proof will do step by step, how each step is taken back, and the decisions that are Marlin's.

### Production as read on 2026-11-12 (read only)

- **What runs:** the image built from main at `7b32ea16`, deployed by hand on 2026-11-09 (`gh workflow run deploy --ref main`; the workflow has no push trigger).
- **Site branches are absent there:** `GET /api/projects/<id>/branches` answers the framework's own 404 page, not the application's JSON 404, so the route does not exist in that build. `SITE_BRANCHES_COMPANIES` is not among the application's variables in Coolify.
- **Database:** none of the four site branches migrations is applied (`20261111000000_site_branches`, `20261112000000_site_branch_merge_undo`, `20261112120000_site_branch_previews`, and `20261112180000_site_branch_backstops` from the whole-feature review, decision 87). All four are additive; the start sequence applies them on the first start of the new image (`prisma migrate deploy`). The 3D model store's migration `20261112200000_site_models` (#394) is not applied either and comes with the same start.
- **The company and its sites:** the automation profile is signed in on `app.lumitra.co` with Lumitra as the active company (id `019ec2f2-f19e-70f4-a889-8afb34c314ca`; the profile also belongs to two other companies, which stay off). Lumitra has two sites: "Lumitra (new landing page)", published, and "MCP end-to-end test", a draft.
- **The wildcard:** a label never used before is served with the certificate `*.sites.lumitra.co` (decision 80), and the application routes any label under `sites.lumitra.co`.

### What a deploy of main carries besides site branches (inventory re-read at `d9e13c26` on 2026-11-12, nothing applied)

Production runs `7b32ea16`. This inventory was read at main `d9e13c26` (the 3D model store's migration, #394, merged 2026-11-12 05:56 UTC), which includes site branches S1 to S8, the whole-feature review fixes (#379) and the Books snapshot fix (#377).

**The list is only true for the commit it was read at.** Main moves several times a day and every later commit may add a migration, a setting or a behaviour change (the sixth migration below arrived hours after the first version of this list). Before a go for the deploy is asked, the migrations (`git diff --stat 7b32ea16 <release commit> -- prisma/migrations src/server/commerce/migrations`), the commits and `deploy/README.md` are read again at the exact commit to be released, this section is brought up to date, and each owner named below re-confirms their part at that commit. A go is asked for one named commit, and the deploy runs that commit, not "main".

**Migrations the first start of the new image would apply, in this order** (the start sequence of `deploy/README.md`; a failure in any stops the start and Coolify keeps serving the old container):

| # | Migration | Database | Owner | What it does | If it fails, and taking it back |
|---|---|---|---|---|---|
| 1 | `20261111000000_site_branches` (Prisma) | the sites database | site branches | One nullable column on `sites`, the table `site_branches`, a unique index on `sites(id, workspace_id)`, two foreign keys, check constraints and triggers. Builds an index and validates checks on `sites`, so it holds a short lock on that table. | Prisma marks it failed and every later start refuses to migrate until it is resolved by hand (`migrate resolve`, `deploy/README.md`, "Migration rollbacks"). Additive: older code ignores it; not reversed. |
| 2 | `20261112000000_site_branch_merge_undo` (Prisma) | the sites database | site branches | Four nullable columns on `site_branches`. | As 1. |
| 3 | `20261112120000_site_branch_previews` (Prisma, with #376) | the sites database | site branches | One table, one unique index on `site_branches`. | As 1. |
| 4 | `20261112180000_site_branch_backstops` (Prisma, with the whole-feature review fixes) | the sites database | site branches | A second foreign key on `site_branches`, a trigger on it, and one stored generated column (`base_name`), which rewrites `site_branches`. That table holds no row before the switch is on, so each is instant. Needs Postgres 15 or later for the foreign key's column list (production: 16). | As 1. |
| 5 | `20261112200000_site_models` (Prisma, #394) | the sites database | 3D scene format and model store (scene-format) | One new table, `site_models`, with indexes, checks and a cascading foreign key to `sites(id, workspace_id)`. No existing table or row is touched. Nothing reads or writes it: no route exists, nothing constructs its repository, uploads are off and fail closed. | As 1 for a failed start. Additive; safe for old and new code alike. Not reversed by default: the empty table stays. A removal is by hand only, with its own authorization, by `prisma/migrations/20261112200000_site_models/rollback.sql` in one transaction (it drops the table and the migration's history row); never `prisma migrate resolve --rolled-back` on an applied migration (it is refused, `deploy/README.md`). |
| 6 | `030_books_contact_person` (commerce tenant fleet) | every company's commerce schema (`tg_<id>`), through the owner role | Books contact person (#370) | Two nullable columns with a check each, on `customer` and `sales_document`, with a five second lock wait per table. Runs for every company, not only Lumitra. | A lock wait over five seconds on any company's tables fails the start. Additive, no row rewritten. Not reversed. |

**A dependency that is not a migration of this application, and blocks the deploy today.** #370 raises `@marlinjai/contacts-core` from 0.4.0 to 0.5.0. That version needs the shared contacts database at its migration `0003_contact_affiliations`. Read in the code, not assumed:

- This application never applies contacts migrations. It opens the contacts database with `createContactsDb`, whose `ready()` compares the applied migrations with the ones the package ships and throws `ContactsLayoutError` when one is missing. So the new image on a contacts database still at `0002` fails **every** Books call that reads or writes a contact (customers, recipients, issuing an invoice), not only the new contact person screens. Books is in use on production.
- `0003` is applied by the receipts application at its start. Its pull request (receipts #253) is a draft with the `hold` label, on purpose: receipts deploys on every merge, so merging it is the live migration.
- The contacts plan (`docs/plans/2026-11-11-contact-affiliations.md` in the contacts repository, section 2) puts a production gate in front of that: a verified same-day backup of the contacts database, the migration and backfill run on a restored copy with matching counts, and Marlin's yes; then receipts first, Books after. The runbook with the restored-copy evidence is merged there (`f661235`).

**So the order is fixed, and each step keeps its own gate:** (1) the contacts gate and the release of receipts #253, owned by the contacts and receipts work; (2) only then a deploy of this application's main; (3) only then the switch for the Lumitra company; (4) only then the proof, which writes to production. A go for one is not a go for the next.

**The other work in the image, each to be confirmed by its owner before step 2:**

| Work | Commits | Owner | What changes on production without any switch |
|---|---|---|---|
| Books contact person | #370 | Books customer management | New screens and routes; an invoice addressed to a contact person stores its recipient snapshot as version 2; one without stays version 1 (#377, which replaced "always version 2"). |
| Buyer's mail as a job consumer (shop backbone B5) | #364 | shop backbone | How the receipt mail of a paid order is sent changes (a job consumer and a backfill of open letters replace the earlier runtime). Affects real buyers' mails. |
| FX engine F1 to F6 | #365, #368, #369, #373, #378, #383 | Lumitra FX in Sites | **Published pages change**: a page with a stored FX scene draws it through a lazy island; new client dependencies (three, react-three-fiber, postprocessing). The editor gains the FX panel, the live canvas toggle and the preview (F5), and the generator and the agents can write an FX scene (F6). No migration and no setting (FX plan, `docs/plans/2026-11-08-lumitra-fx-in-sites.md`). |
| 3D scene format and model store, offline half | #380, #384, #386, #389, #394 | scene-format | Nothing reachable: the format, the file guard, the validator and the store exist in code with no route, upload or cleanup enabled and their flag unset. One migration (row 5 above). |
| Head items, slice H1 of the theme and head contract | #385 | its own plan's owner, to be named at the release commit | The site and page models and the published head read a new head-item shape. Its owner states what a published page shows differently, if anything. |
| Replay of a settled edit on an agent's write | #358 | live agent canvas | Editor behaviour when an agent writes while a person edits. |
| Site branches S1 to S8 and the whole-feature review fixes | #360, #361, #366, #367, #371, #372, #374, #376, #379 | site branches | Nothing visible while the switch is unset. The save, the erase of personal data and the site listings carry branch-aware code paths that run for every company (a site with no branch takes the same path as before; covered by the existing suites). |
| Tests and workflow only | #362, #363, score commits | several | Nothing at run time. |

**What rolling the image back would and would not undo** (the previous image is `ghcr.io/marlinjai/framer-clone:7b32ea163bef2e1edb5fe0d249f1fc0875d24280`):

- Site branches: clean, with the two conditions of section 9 (merge or discard open branches first; no erase of personal data while rolled back).
- Books: **not clean once a single invoice addressed to a contact person has been issued on the new image** (before #377 it was every invoice). The deployed code parses an invoice's recipient snapshot with version 1 only (`v: z.literal(1)` in `src/server/books/snapshots.ts` at `7b32ea16`), and the new code writes version 2 into an invoice that names a contact person. An issued invoice cannot be changed, so after a rollback the old code could not read those invoices until it is rolled forward again. The Books owner checked the rest read only on 2026-11-12 (contacts plan, section 8): the deployed code runs correctly against a contacts database at `0003` (tried with the old package on a restored copy holding affiliation rows), and against the two new nullable Books columns; a draft given a contact person and then issued by the old build would lose its "z. Hd." line without a word. Their recommendation, not decided here and theirs to build: write snapshot version 1 when an invoice has no contact person and version 2 only with one, so a rollback stays free until the first invoice addressed to a person is issued; or, stricter, deploy a build that only widens the reader first. Marlin authorised that small fix on 2026-11-12 and it is merged as #377 (`95ff35a2`; merging does not deploy): an invoice without a contact person is stored as version 1, which the deployed code reads. With it, an invoice addressed to a person still carries version 2, and from the first such invoice on a rollback to the old reader is not possible: roll forward.
- The buyer's mail and FX: their owners' to state.
- The migrations: none is reversed; all are additive.

### What turning site branches on consists of, once the deploy above has happened

1. **Check the deploy with the switch still off:** the dashboard and both sites open as before, `GET /api/projects/<id>/branches` answers the application's JSON 404, the published landing page renders unchanged, the MCP tool list has no branch tool, Books lists its customers.
2. **Set `SITE_BRANCHES_COMPANIES=019ec2f2-f19e-70f4-a889-8afb34c314ca`** on the application in Coolify (Lumitra's own company only, never `*`) and restart it. An identifier, not a secret.
3. **Run the proof below**, in the headless automation browser and with an agent key of the Lumitra company through the secrets proxy.

### The proof, step by step

Everything is done on **a new draft site made for the proof**, "Branch proof 2026-11-12", in the Lumitra company. The published landing page is opened once to see that it is untouched and is never edited. Each step names what is looked at as evidence.

| # | Step | Evidence |
|---|---|---|
| 1 | Create the proof site with two pages and a form. Open it: the top bar shows the branch switcher with "Main". | The switcher is there; it is absent on a site of a company without the switch (checked by switching company and back). |
| 2 | Create the branch "Proof A" from the switcher. Change a heading and add a section. Reload. | The badge names the branch, the changes survive the reload (autosave on a branch), the dashboard lists one site with "1 branch", and main is unchanged when opened in a second tab. |
| 3 | **A person's branch merged with an agent's concurrent write to main:** while "Proof A" is open, the agent changes another element on main through `apply_batch`. In the branch: "Main has changed", Update. Open the review. | The review lists the branch's changes only, the side by side view shows both, the update brought the agent's change in without a conflict. |
| 4 | **A conflict settled:** the agent changes the same heading on main. Update from main stops with one conflict; answer it with the branch's value on the review page, reload, then change the answer to main's and back. | The answer survives the reload; changing it changes the result shown; the merge is offered only once every conflict has an answer. |
| 5 | Merge "Proof A". | Main holds both sets of changes at a new version, nothing is published (the site is a draft and stays one), the branch's old address says it was merged and offers the undo. |
| 6 | **A merge undone and merged again:** undo the merge from the old address. Review the new branch and merge it. | Main is back to before the merge as a new version, the new branch holds the merged work and is up to date, the second merge lands the same content, the first branch's address says the merge was undone and where the work went. |
| 7 | **An agent's merge approved and one declined:** the agent creates "Proof B" (`create_branch`), edits it, asks for review (`request_review`) and calls `merge_branch`. A person opens the confirmation address and declines. The agent calls again; the person approves. | Declined: nothing merged, the agent is told so. Approved: merged once; a repeat of the call answers the first result. `publish` on the branch id is refused. |
| 8 | **A reviewer without edit rights.** Not provable with the accounts that exist (see "Step 8: who could play the reviewer" below). **8a, with existing accounts, always done:** as an admin, the review of a third branch shows every control on, and the routes `approve`, `send-back`, `answers` and `preview-link` answer 200 or 201. **8b, only with Marlin's go for a temporary viewer account:** that account opens the same review. | 8a: the controls and routes work for an admin, which the earlier steps already use. 8b: "Looks good" and "Send back" work, the conflict answers, "Share preview" and the merge are off with the reason as text, and `answers`, `update`, `merge`, the preview link's `POST` and `DELETE` and the branch's `PATCH` and `DELETE` answer 403 when called directly. Without 8b the review-only case rests on the tests named below, and the proof's report says so in those words. |
| 9 | **The public preview link:** on "Proof C", Share preview, 1 day. Open the address in a clean browser profile with no login. | The page shows the branch with the band at the bottom edge of the window, clear of the page's own header and of the end of the page (decision 94; put a header fixed to the top on the proof page to see it), in German when the proof site's language is German; response headers `x-robots-tag: noindex, nofollow, noarchive`, `cache-control: private, no-store`, `referrer-policy: no-referrer` on the page, and `private, no-cache` with an `etag` on its pictures (decision 90); `robots.txt` disallows all; the form says nothing is sent; a `POST` to `/api/forms/submit` on that host answers 404; the certificate presented is `*.sites.lumitra.co`. Revoke: the address answers 404 at once. Make a new one, discard the branch: 404. |
| 10 | Discard what is left open, and check the published landing page and its sitemap once more. | No open branch on the proof site; the landing page, its address and its published version number are as before step 1. |
| 11 | Turn the switch off and on once (step 2 of turning it on, reversed and repeated). Before it, leave one branch open with a preview link. | Off: no switcher, the branch routes and tools answer 404, a preview address answers 404, main opens and saves as before; a direct `DELETE` of the open branch's preview link and of the branch itself still works (decision 86). On: everything else is back, and the revoked link and the discarded branch stay gone. |

The proof site stays as a draft afterwards (deleting it is not needed and is not done without a word); its closed branches keep no content.

### Step 8: who could play the reviewer (read on 2026-11-12, nothing changed)

Read only, on the organisation page of the sign-in service (auth-brain, `auth.lumitra.co/admin/orgs`), through the automation browser, with every person reduced to a letter before anything left the page:

- **The Lumitra company has two members and no pending invitation.** Person A owns the organisation and the company and is `admin` of its one workspace. Person B is `admin` of the company with no entry of their own on the workspace; an admin of a company holds the management role on its workspaces by inheritance.
- **Nobody holds `viewer` or `member` on the workspace.** The review-only case needs exactly that: `viewSite` and `reviewBranch` ask for `workspace.viewer`, while `editSite` and `mergeBranch` ask for `workspace.admin` (`src/lib/permissions.ts`). Both existing members pass both, so neither can show a control that is off for lack of the right.
- **So step 8 cannot be proven as written with existing accounts**, and no account was created, no role changed and nothing invited to find this out.

What stands in for it, and what it does not cover:

- **Covered by tests on every pull request**, with the real routes and the real guard chain and the permission service answering per action: a member who may view but not edit is refused on the answers route and stores nothing (`branch-merge.itest.ts`, "a viewer may not answer"), on making and revoking a preview link while reading whether one exists still works (`branch-preview.itest.ts`), on the branch routes (`branches-route.itest.ts`, "403 without the permission") and on the undo of a merge (`branch-undo.itest.ts`, "needs the right to merge"); the review page shows each control off with its reason as text when review and merge rights are both off (`ReviewScreen.test.tsx`, "a viewer without review or merge rights reads"). No cited test approves or sends back with review rights on while edit and merge rights are off, which is exactly the review-only combination; that combination is shown only by 8b.
- **Not covered without a real viewer:** the review-only combination end to end (review on, edit and merge off), and that the permission service on production answers "viewer yes, admin no" for a person who holds only `viewer` on the workspace. Those tests put a stand-in in its place. The same mapping has guarded every edit, publish and domain route since launch, so the risk is small, but it is not seen for site branches until 8b runs.

**The safe way to 8b, which is Marlin's to allow and is not done without his word:** invite one address of his own choosing (a second mailbox of his, never a customer's or a colleague's) to the Lumitra company's workspace with the role `viewer`, sign that account in once in the visible automation browser, run 8b, then remove the membership the same hour. Whether a membership on the workspace alone lets that account open the company in Sites is not known; if it does not, that is the first finding of 8b and the invitation is made on the company with the lowest role instead. It creates a user and a membership on the sign-in service's production data and removes the membership again; the user record of an invited address stays unless it is erased separately. The default is not to do it: the proof then runs 8a and reports the review-only case as proven by tests only. It is asked as one line together with the go for the switch, never before the contacts gate, the deploy and the switch have each had their own yes.

### Taking site branches back

| What | How | Effect |
|---|---|---|
| The switch | Remove `SITE_BRANCHES_COMPANIES` in Coolify and restart. Under five minutes. | Branches are hidden, not deleted; every preview address answers 404; main, saving and publishing are unaffected (section 9). Setting it again brings everything back. **It takes back site branches only, nothing else the deploy shipped.** |
| A bad merge during the proof | "Undo this merge". | It is on the proof site only. |
| The image | See "What rolling the image back would and would not undo" above. | Not a clean way back for Books once an invoice addressed to a contact person was issued. |

### For Marlin, when its turn comes

Site branches ask for two things, each a separate yes, and neither is asked while the contacts gate is open:

1. **The deploy of main**, after the contacts database is at `0003` and receipts is released, and after the Books, shop, FX, scene-format, live canvas and head-item owners have each confirmed their part of the image at that commit: the default is not to deploy; it applies the six additive migrations above (four for site branches, one for the 3D model store, one for Books in every company's schema) and is asked for one named commit, after this inventory was re-read at it; the image can be rolled back for site branches, and for Books only until the first invoice addressed to a contact person is issued on it.
2. **The switch for the Lumitra company and the proof**, which makes a new draft site and writes to it on production: the default is off; it comes off again in under five minutes by removing the variable.
3. **Optional, asked with 2: a temporary viewer account for step 8b.** The Lumitra company has no member who may review but not edit, so the review-only case is otherwise proven by tests only. The default is no account; with a yes, one address of Marlin's is invited as `viewer` on the workspace and, only if a workspace membership alone does not open the company in Sites, also on the company with the lowest role (the yes covers both invitations); every membership either invitation created is removed after the proof.

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
