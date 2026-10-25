---
type: plan
status: completed
date: 2026-10-25
title: Set any page as the home page, and explain the undeletable home page
summary: "Set as home page" on every other page (row menu, right-click menu, page settings) swaps the site root in one undo step; the home page's delete control stays visible, explains why it cannot delete, and offers a chooser for a new home page. Published sites keep old links working through the existing redirect list.
tags: [framer-clone, editor, pages, slug, redirects, published-site, touch]
projects: [framer-clone]
---

# Set any page as the home page

Owner's report from his iPhone (2026-10-25): "The first page is never deletable." The guard is
right (the published site serves the home page at its root, so deleting it would make the root
answer 404), but there was no way to make another page the home page, and on a touch screen
nothing said why the delete button was missing. Written after the build; it records what exists
and why. Builds on `2026-10-21-page-settings-slug-redirects.md`.

## What the owner gets

- Every page except the home page has "Set as home page" in its row menu (the new "more actions"
  button, the only way into the menu on a touch screen) and its right-click menu, and under the
  URL in Page settings. Each asks first and says what will happen: the page opens at the site
  root, the current home page stays as a normal page at `/<slug from its name>`, and on a
  published site links to the page's old address will lead to the home page after the next
  publish.
- The home page row shows a house icon. Its delete X is visible (always on touch screens), looks
  disabled, but stays focusable and tappable, and so does the disabled Delete menu item. Choosing
  either shows a notice in the Pages list: "The home page cannot be deleted. Make another page the
  home page first." with "Set another page as home", which opens a chooser of the other pages.
  A project's only page says "A site needs at least one page" instead.
- After the change the former home page deletes like any page.

## How it works

- `ProjectModel.setHomePage(pageId)`: ONE MST action, one undo step. The chosen page takes the
  empty slug; every other page holding the empty slug (normally the one home page, two in some
  older projects) gets `suggestSlug(title, taken)`. The chosen page's old path counts as taken,
  so the former home page cannot claim it and the redirect to the root survives. In-site links
  to the old path (`/about`, `/about#x`, `/about?y`) are pointed at `/` in the same action, so
  they also work on a site that was never published. The 404 pointer is cleared if it named the
  chosen page. `previewHomeChange` returns the same plan for the confirmation text. The older
  `makeHomePage` (only for projects without a home page) is folded into it.
- Server save check (`findProjectSlugProblem` in `src/lib/pages/slug.ts`): the root must still
  serve a page. A stored home page may keep the empty slug (no other page may join it), or the
  home page may change to exactly one other page while the former home page moves to a valid,
  unique slug or is deleted in the same save. A save with nothing at the root is still refused,
  now with "Make another page the home page first." in the message.
- Redirects: no new mechanism. `nextSiteRedirects` already records the new home page's old static
  slug as a redirect to its page id, and `findRedirectTarget` resolves a page at the empty slug
  to `/`. The root itself is never a redirect source; it simply serves the new home page.

## Decisions (say so if you disagree)

- Redirects are recorded only once the site has been published (the existing `everPublished`
  gate): a draft site has no old links to keep. The editor's link retargeting covers in-site
  links either way.
- A page with a dynamic slug (`products/:handle`) cannot become the home page: at the root there
  is no value for the segment, so it would render empty, and no redirect could be recorded. The
  action is not offered for it (`ProjectModel.canBecomeHomePage`, shared by both menus, Page
  settings and the chooser), and `setHomePage` refuses it.
- Links to `/` are left alone: they mean "the home page", which is now the new one.
- The confirmation is a dialog (or, inside Page settings, an in-place question) rather than an
  instant action, because the change moves the site's front door; it is still undoable in one
  step.
- Sitemap, canonical URLs, the home-page JSON-LD, form redirect targets (stored by page id) and
  legal footer links follow without code changes: they read slugs or ids at render time, and a
  legal page made home has its footer links retargeted like any other link.

## Tests

- `src/models/__tests__/ProjectModel.homePage.test.ts`: swap, unique slug and reserved old path,
  preview equals action, link retargeting, 404 pointer, refusals, legacy two-home projects, one
  undo step with redo, and the four stateful paths (forward, changing your mind, resume from a
  snapshot with the server check, re-entry after deleting the former home page).
- `src/lib/pages/__tests__/slug.test.ts`, `redirects.test.ts`: the save check for a home change,
  its refusals, changing back, and the redirect bookkeeping of a swap.
- `src/components/sidebars/left/__tests__/HomePage.test.tsx`: the action in both menus and in
  Page settings, the confirmation text (published and draft), the disabled-looking but focusable
  delete control, the notice (keyboard, Escape, Dismiss, only page), the chooser, the former home
  page deleting, and the four stateful paths in the panel.
- `src/app/(site)/[...slug]/__tests__/page.redirects.test.tsx`: after a real `setHomePage`, the
  new home page serves at the root, its old path answers 308 to `/` with the query string, the
  former home page serves at its new slug.
- `src/server/sites/__tests__/slugRedirects.itest.ts`: the same against real Postgres, then the
  former home page deleted, and a save that leaves the root empty refused.
