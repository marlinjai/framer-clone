---
type: documentation
date: 2026-11-12
title: "Head item model (slice H1): owner and release confirmation, read at main d9e13c26"
summary: "Who owns the head-item model of the theme and head contract, what pull request 385 changes on production without any switch, what a rollback does to what it stored, and the read-only checks to repeat at the exact release commit. A later confirmation for the joint deployment checklist, not a deployment authorization: nothing here starts, requests or approves a deploy."
tags: [framer-clone, head, deployment, rollback, owner-confirmation]
projects: [framer-clone]
---

# Head item model (slice H1): owner and release confirmation

**This is not a deployment authorization.** It answers the deploy checklist (section 12 of `docs/plans/2026-11-10-site-branches.md`, kept by the sites
branching worker) so that it is complete. No deploy is started, requested or approved by it, and it is to be re-confirmed at the exact release commit
when Marlin's go for a deploy is asked for. Read at `origin/main` `d9e13c26`; the production commit the checklist counts from is `7b32ea16`.

## Owner

- **Owner of record:** Marlin Jai, who approved the plan (`docs/plans/2026-11-02-theme-and-head.md`, decided) and the agent fleet (`docs/plans/2026-11-01-agent-fleet.md`, approved 2026-11-01).
- **Worker that built and answers for it:** the Claude Code session `site-head-model` (Herdr pane `w5:pH`), asked through the coordinator (`w2:p11`) and its inbox. Slice H1 is pull request 385, squashed as `7a6ae2ba`.

## What is on main, and what is not

On main: slice H1 only, the model. `src/lib/site/headItems.ts` (the item types, `parseHeadItem`, `resolveHead`, the safe copy), `PageModel` (a page's `metadata.head` and `ogType`),
`ProjectModel.updateSiteHead`, the site list, and `pageMetadata` reading `ogType`. **Not on main:** slice H2, which renders the items (pull request 390, held), and slice H3, the editor panel (not pushed, stacked on 390). Until H2
lands, no head item is written into any page, so the only thing a visitor could see from H1 is the `og:type` tag, below.

## What changes on production from 385 without any switch

1. **A published page's head, for an existing site: nothing.** `pageMetadata` now writes `og:type` from the page's `ogType`, which is `website` for every existing page, the value it wrote before. Checked on 2026-11-12 by running the base commit `c7a2effb` and the branch side by side: the metadata objects of `siteLayoutMetadata`, `pageMetadata`, `previewMetadata` and `buildBusinessJsonLd` over about 110 input combinations serialise to the same bytes, and the raw `<head>` a real `next build` plus `next start` sent for `/`, `/plain` and a 404 is identical (35 lines each). Limits: one site configuration, no page with another `ogType`, no browser.
2. **Stored shape: new optional keys, no migration.** Every page the editor saves from the new image carries `metadata.ogType: "website"` and `metadata.head: []` inside the page's snapshot JSON (the model's defaults), and the yjs shared-document shape carries them too. The site's own `head` list has been part of `siteSettings` since the theme slices, which are already in production's ancestry. The save and publish routes treat a page as opaque JSON (`.passthrough()` in `src/app/api/projects/_schema.ts`), so nothing rejects the new keys.
3. **Migration, setting, dependency: none.** Between `7a6ae2ba^` and `7a6ae2ba` the pull request touches no `prisma/`, no route, no `package.json`, no lockfile, no environment variable and no configuration. (`prisma/` has changed on main since, by the 3D model store's additive `site_models` migration, which is another owner's.)

## What a rollback of 385 does

- **Reading:** the old image reads every snapshot the new one wrote. Its page metadata model and its published-page adapter read only the fields they know and ignore `head` and `ogType`; the published revisions (frozen documents) are untouched by a code rollback.
- **Writing after a rollback:** a page saved by the old image loses `head` and `ogType`. On H1 alone that is no data: nothing in the editor, the AI or the agent plugin writes either key (the panel is H3, and the generator is told head items are not its to write), only the defaults the model adds. The site's list `siteSettings.head` survives, because the older settings normalizer already kept it. The save schemas keep unknown page keys, so an authorized save could in principle have stored a non-default `ogType` or `head`, and a save from the rolled-back build would drop it. No down migration is needed unless a stored page holds a non-default `ogType` or `head`: confirm that before release (check 5 below).
- **A tab left open across the deploy** keeps the old shape and saves without the two keys: the same default-only loss, and the plan accepts it for a page's own head until H3 exists.
- **If H2 and H3 are deployed later and then rolled back,** items stored on pages are dropped by the next save from the old image, Published revisions keep their stored items, but the old image renders pages without them, so the published pages stop serving those items. That belongs to their own confirmation.

## To repeat at the exact release commit (read-only)

1. `git diff --stat 7b32ea16 <release> -- prisma src/app/api package.json pnpm-lock.yaml`: name anything under these paths that belongs to head items (expected: none from 385).
2. Whether 390 (H2) and the Head panel (H3) are in the release; if they are, this note is not enough and they need their own confirmation, including the held crawler-metadata question and the unresolved save-contention decision (coordinator inbox entry `20261112-062705-site-head-model`).
3. Re-run the two checks of item 1 above (the metadata objects and the raw head of a real build) at the release commit, and say what differs.
4. Name who is the owner then.
5. Read-only, on production data: confirm no stored page snapshot holds a non-default `metadata.ogType` (anything but `website`) or a non-empty `metadata.head`.

| Release commit | Read on | Read by | Result |
|---|---|---|---|
| (not yet requested) | | | |
