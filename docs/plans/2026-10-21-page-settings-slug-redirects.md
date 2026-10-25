---
type: plan
status: completed
date: 2026-10-21
title: Page settings with URL slug, and redirects from old slugs
summary: A page settings panel (name, URL slug, meta description, live URL preview) opened from the PAGES list; one shared slug validator used by the editor and the server save path; and a new per-site redirect list so a page of a published site that changes its slug keeps its old address working (308 to the new one, live with the next publish).
tags: [framer-clone, editor, pages, slug, seo, redirects, published-site]
projects: [framer-clone]
---

# Page settings with URL slug, and redirects from old slugs

> Update 2026-10-25: the home page can now be changed ("Set as home page" on any other page,
> which replaces "Make home page" below) and the save check accepts that change; see
> `2026-10-25-set-as-home-page.md`.

Build notes for the change asked for on 2026-10-20 ("the page settings also need a way to change
the slug"). Written after the build, so it records what exists and why, not a proposal.

## What the owner gets

- In the PAGES list every row has a settings button (visible on hover and on keyboard focus).
  A double-click on the row, or "Page settings" in the row's context menu (right-click, or the
  context-menu key / Shift+F10 on a focused row), opens the same dialog.
- The dialog edits the page name (which is also the browser tab and search result title, since
  the published renderer uses it as `<title>`), the URL slug and the meta description. It shows
  the resulting address live (`<site address>/<slug>`), explains every invalid input inline,
  and offers "Use page name" to fill the slug from the name.
- The home page's URL is the site root and is shown read-only, with the reason. The home page
  can also no longer be deleted from the list, because the site root would answer 404.
- Older projects whose home page was deleted before this change get "Make home page" in a
  row's context menu (only while the project has no home page); the chosen page takes the empty
  slug, and on a published site its old path redirects to the root. Older projects that ended
  up with two empty-slug pages keep saving and may move or delete the extra one.
- On a site that has been published, a changed slug shows "Old links will redirect: /old will
  lead to /new after your next publish."

## Slug rules (one module, both sides)

`src/lib/pages/slug.ts` is the only definition. The editor (`ProjectModel.setPageSlug`,
`ProjectModel.updatePageSettings`, the dialog) and the server (`SiteRepository.saveProject`,
behind both `POST /api/projects/save` and `/publish`) call it.

- Each segment: lowercase a to z, 0 to 9 and single hyphens, no hyphen at either end.
- Nested paths with `/` are allowed, because the published router already matches multi-segment
  slugs. Dynamic segments (`:handle`) are matched by the router but are not authorable: an
  existing page that has one keeps it.
- 1 to 80 characters in total.
- Unique within the project, compared case-insensitively (dynamic segments count as equal).
- Reserved first segments: `api`, `projects`, `preview` (routes in `src/app`), `_next`,
  `static` (Next assets), `images` (the folder in `public/`), `__home` (the root rewrite
  sentinel), `home` and `index` (the router's home aliases), `favicon`, `robots`, `sitemap`.
- The home page's empty slug never changes and the home page cannot be dropped from a save;
  no other page may take the empty slug, except in a project that has no home page at all
  (exactly one page may then take it). Two empty-slug pages already stored are grandfathered.
- Suggestions from a name transliterate umlauts (ä to ae, ö to oe, ü to ue, ß to ss) and other
  accents, cap at 80, append `-page` to a reserved word and `-2`, `-3`, ... on collision. New
  pages (manual and AI generated) get their slug this way.

### Grandfathering on the server

The server refuses only NEW or CHANGED slugs that break the rules. A slug identical to the one
stored for the same page is accepted as is, so a project with pages created before these rules
(long slugs from long titles, an existing dynamic slug, a page called "Preview") can still be
saved. A refusal is the typed `InvalidPageSlugError` (HTTP 400, code `invalid_page_slug`), and
nothing is written.

## Redirects (new mechanism)

There was no redirect mechanism, so a minimal one was added.

- Storage: `sites.redirects`, a JSON list of `{ from, pageId, createdAt }` (migration
  `20261021000000_site_redirects`, additive, default `[]`).
- Recorded by `SiteRepository.saveProject`, inside the save transaction, by comparing the stored
  slug of each page with the incoming one. Only for a site that has been published at least once
  (it holds a platform subdomain); only from a static, non-empty old slug; not when only the
  letter case changed.
- The target is the page id, not a path: the router sends `from` to that page's CURRENT slug.
  So renaming twice never chains (both old paths lead to the page), and a loop cannot exist.
- Cleaned on every save: an entry whose page was deleted, or whose `from` is now a page's own
  path (the page wins), is dropped. At most 100 entries per site, oldest dropped first.
- Served by the published route `(site)/[...slug]/page.tsx`. Precedence: a static page that
  owns the path wins, then a redirect, then a dynamic (`:handle`) page, then the 404. A hit
  answers with Next's `permanentRedirect` (308) to the page's current path, keeping the query
  string (rebuilt from the parsed parameters: the page never sees the raw URL), relative so a
  custom domain stays on its host. The target is rebuilt from the slug's non-empty segments,
  each percent-encoded, and dot segments are refused, so a stored slug can never produce an
  off-site (`//other.host`) address.
- Concurrency: the save runs as a SERIALIZABLE transaction (retried up to four times on a
  serialization conflict, then a loud failure), so two overlapping saves cannot each write a
  redirect list missing the other's entry.
- Timing: the redirect list rides in the cached published-site resolution, which publish
  revalidates, so it takes effect with the next publish, together with the new slug.

## Multiplayer and undo

A settings save is the single MST action `ProjectModel.updatePageSettings`, so it is one entry in
the editor history (one undo restores name, slug and description together) and it travels the
same way every page edit does. The Yjs document shape (`src/lib/multiplayer/yjsDocShape.ts`)
already carries `slug` per page; the live MST to Yjs binding does not exist yet in this
repository, so there is no separate multiplayer channel to wire.

## Where the address comes from

`SiteRepository.getSiteAddress` (scoped to the caller's workspace) returns the host visitors use:
a serving custom domain (verified or active, the first connected), else
`<subdomain>.<PUBLIC_SITE_BASE_HOST>`, else none before the first publish. The editor route
passes it into `SiteAddressProvider`; `PublishButton` updates it after a publish.

## Tests

- `src/lib/pages/__tests__/slug.test.ts`, `redirects.test.ts`: every rule, transliteration,
  suggestions, grandfathering, chains, loops, collisions, cap.
- `src/models/__tests__/ProjectModel.pageSettings.test.ts`: model enforcement, one undo step.
- `src/components/sidebars/left/__tests__/PageSettings.test.tsx`: opening three ways, save,
  cancel, invalid input, home page, redirect note, home page not deletable.
- `src/server/sites/__tests__/repository.test.ts`, `src/app/api/projects/__tests__/save-route.test.ts`:
  the save path refusing invalid slugs sent directly and recording redirects.
- `src/app/(site)/[...slug]/__tests__/page.redirects.test.tsx`: the router serving the new slug,
  redirecting the old one, page wins, 404s.
- `src/server/sites/__tests__/slugRedirects.itest.ts`: the same against real Postgres.
