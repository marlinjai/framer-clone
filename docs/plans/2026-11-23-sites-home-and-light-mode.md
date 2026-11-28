---
title: A real home at app.lumitra.co, a light mode, and a readable dark mode
description: Plan for what app.lumitra.co shows first (signed in and signed out), where the demo editor moves, an interface theme preference (System, Light, Dark) across every editor surface, and a lifted dark palette whose panels and fields separate.
summary: Marlin reported on 2026-11-23 that app.lumitra.co opens straight into "Framer Clone Demo" instead of his projects, that he wants a light mode throughout the product, and that the dark editor is too dark to read. Measured on production the same day, text contrast is fine (17 to 1) but panel surface on background is 1.02 to 1 and field borders 1.2 to 1, so every panel melts into one black. The plan makes `/` a home for a signed-in person (Direction A, a grid of site cards) and a welcome page for a signed-out visitor, with the demo one click away and no login, keeps the demo at `/` by address so no tenant page is shadowed, fixes its return paths, adds a System, Light and Dark preference kept per browser with no flash from a shared Lumitra-wide palette in suite-theme, lifts the dark palette into a three-step ramp with field borders of at least 3 to 1, and proves both modes with a contrast check, a raw-colour check and browser runs. Selection everywhere is a complete glowing ring, never a one-sided edge. Decided by Marlin on 2026-11-23; five slices, each under about 1,500 changed lines.
type: plan
status: in-progress
date: 2026-11-23
tags: [framer-clone, editor, dashboard, theme, light-mode, accessibility, plan]
projects: [framer-clone, suite-theme]
---

# A real home at app.lumitra.co, a light mode, and a readable dark mode

Visual direction (local working file, not published): `~/software-dev/orchestration/sites-home-theme/visual-direction.html`,
with renders in `shots/vd-light.png` and `shots/vd-dark.png` next to it, and the production evidence of
2026-11-23 in the same `shots/` folder.

## 1. What is wrong today (measured on production, 2026-11-23, read-only)

1. **app.lumitra.co opens the demo, also when signed in.** `src/app/page.tsx` mounts the browser-only demo
   editor at `/` for everyone. Signed in through the automation profile, `/` showed "Framer Clone Demo | Lumitra
   Sites" (`shots/root-signedin.png`); the projects only appear at `/projects`, reached by the back arrow.
2. **Signed out**, `/` answers 200 with the demo, `/projects` answers 307 to the auth-brain login
   (`https://auth.lumitra.co/login?return_to=…/projects`). Checked with plain HTTP requests, because the
   automation profile is signed in and a clean browser was not installed; the page reads no session, so the
   code confirms it.
3. **The dashboard (`/projects`) is a bare list** of names with a "published" badge, on near-black
   (`shots/projects-signedin.png`).
4. **At phone width (390 px) the dashboard header overflows sideways** and "New project" sits off-screen
   behind a horizontal scrollbar (`shots/projects-phone.png`). A bug, fixed in slice 4 below.
5. **The editor is hard to read in the dark.** The suite tokens of `@marlinjai/suite-theme-core` 0.1.2 (pulled in
   by #455, the mint palette for the Sites editor) give:

   | Pair (WCAG 2 contrast ratio) | Today |
   | --- | --- |
   | Text on surface | 17.1 : 1 |
   | Muted text on surface | 7.6 : 1 |
   | Surface (`#070d10`) on background (`#04090b`) | **1.02 : 1** |
   | Line (`#142024`) on surface | **1.17 : 1** |

   Text was never the problem. Panels, the selected row and field borders have almost no separation, and field
   borders fail WCAG 1.4.11 (non-text contrast, 3 : 1 for the edge that identifies a control).
6. **There is no light mode, by decision.** The rebrand plan of 2026-11-22 (knowledge-base
   `docs/plans/2026-11-22-lumitra-rebrand-mint-light.md`, usage rule 5) says "Dark only. No light theme, no theme
   toggle." Marlin's request of 2026-11-23 reverses that for the product; see decision D1.

## 2. Decisions

### Taken here (decided, say so if you disagree)

- **Nobody is sent to the login for opening app.lumitra.co.** A signed-out visitor keeps a way into the demo with no
  account: the welcome page (D4) opens the demo with one click.
- **Signed-in `/` shows the home.** One server-side session read (the existing `loadDashboard`). A signed-in person
  with an active company gets the home; without a company, `/projects` with its chooser and "Sites not enabled" states
  exactly as today. If auth-brain does not answer, `/` behaves as for a signed-out visitor, with a retry note, never an
  error page and never a login loop.
- **The demo stays at `/`, chosen by the address, not a new route.** A new `/demo` route would shadow any published
  site's own page called "demo" (static app routes beat the site's catch-all, which is why `projects` and `preview`
  are in `RESERVED_SLUG_SEGMENTS` of `src/lib/pages/slug.ts`), and adding `demo` to that list would break existing
  pages. So `/` renders the demo editor when the query names it: `?demo=1`, or the demo's existing `?page=` and
  `?preview=1` (old bookmarks and the address sync keep working). The address sync keeps `demo=1`. "Keep as project"
  sends a signed-out person to `/projects?next=/?demo=1`; `safeEditorReturnPath` adds `/?demo=1` to its existing fixed
  entries (`/`, `/projects`, `/projects/<id>`, `/projects/<id>/preview`), so the stashed demo is restored on the way
  back and no work looks lost. The "Back to the editor" link (`editorHref` in `src/components/preview/PreviewShell.tsx`,
  which today carries `?page=<id>`) becomes `/?demo=1&page=<id>`, keeping the previewed page. Every "Try the demo" link
  carries no page and uses `/?demo=1`.
- **`/projects` stays the address of the signed-in home**, because the login's `return_to`, the company chooser,
  `?switch=1`, `?next=` and every "Back to projects" link already use it. Signed-in `/` without a demo query redirects
  there, so the home exists once. A `/projects?next=/` continuation that is already in flight (for example the "Sign in"
  action in `src/lib/projects/saveDemoAsProject.ts`) resolves to `/?demo=1` before it is followed, so the stashed demo
  is still restored.
- **The list stays scoped to the active company.** "All projects" means all of this company's sites, with the company
  switcher on the home. Listing sites across companies on one page would mix tenants, which the multi-tenancy design
  forbids.
- **The editor's theme never uses the `.dark` or `.light` class on `<html>`.** Those already mean something else: the
  root layout sets them from a published site's theme, the data-table grid sheet relies on `.light`, the canvas
  frames get `.dark` from the site's own colour mode (`editorUI.frameDarkClass`), and Tailwind's `dark:` variant keys
  on `.dark` ancestors, so a dark editor marked with `.dark` would turn every site in the canvas dark. The interface
  theme is `data-ui-theme="light|dark"` on `<html>` instead.
- **The attribute is written by the root layout, in its no-site branch only.** Only the root layout renders `<html>`
  and it serves published sites too; a wrapper element would not do, because menus and dialogs portal to `<body>`.
  The layout already resolves the request's site (for the icon links and `htmlClass`); when no site resolves (the
  editor host), it adds `data-ui-theme` from the cookie. A published host never reads the cookie and never gets the
  attribute. S2 refreshes the published-base hash and extends `src/app/__tests__/publishedSheet.test.ts` to hold this.
- **The preference is System (default), Light or Dark, kept per browser in a host-only cookie** (`lumitra_ui_theme`,
  no `Domain` attribute, so it never reaches a published site on another subdomain). The server writes the attribute
  into the first HTML, so there is no flash; with no cookie the attribute is absent and CSS follows
  `prefers-color-scheme`, which also tracks a system switch live without script. Nothing goes into the account:
  a theme per device is the common expectation and needs no API.
- **Where the switch lives:** the editor's "More actions" menu (`TopBar.tsx`) already holds "Theme", which is the
  *site's* theme, so the interface switch goes into the same menu as its own group under a separator, named
  "Appearance (this browser)" with System, Light and Dark. The demo uses the same top bar, so signed-out visitors have
  it too. On the home it sits in the account menu, and on a signed-out welcome page (if D4 chooses one) in its top
  bar. No new top-bar button, so the measured fold order of plan 2026-11-12-top-bar-fold does not change. It stays
  apart from the canvas's Light and Dark buttons, which show a site's own colour mode to its visitors.
- **Light mode keeps the mint legible:** mint (`#52ffa5`) on white is 1.3 : 1, so in light the star uses the suite's
  light logo version (dark-green `#06764a`), and mint buttons keep their dark ink and get a `#06764a` edge.
- **The canvas and published sites do not follow the interface theme.** A page on the canvas shows the site's own
  colours; only the ground around it (the dotted canvas) follows the interface. Published sites never load the editor
  sheet, and a test keeps it that way (see section 5).
- **Project cards get a picture from the site's own theme tokens** (background, primary, text and font as a small
  abstract page), not a screenshot: nothing stores a preview image today, and live frames of published pages would
  load a WebGL scene per card, against the one-WebGL-context rule of the FX work. Real thumbnails captured at publish
  are a separate idea, not part of this request.

### Marlin's decisions (2026-11-23, after reviewing the visual direction)

| Date | Decision | By |
| --- | --- | --- |
| 2026-11-23 | D1: the light palette is shared Lumitra-wide, in `@marlinjai/suite-theme-core` (a `ui` token group, `ui.css`), not inside Sites only. Amends rule 5 of the rebrand plan of 2026-11-22 for app interfaces: apps offer Light, Dark and System; marketing stays dark | Marlin, relayed by the coordinator |
| 2026-11-23 | D2: Direction A, "Studio grid" (top bar, sites as large cards, a New site card, the tools as a quiet row) | Marlin |
| 2026-11-23 | D3: the dark interface is lifted. He first asked for "quite a bit lighter than current" and then approved the "proposed dark" of the visual direction (background `#0c1316`, surface `#131e23`, raised `#1a272d`); that is what is built. A lighter revision (background `#1e282b`, surface `#263236`, raised `#2f3c41`, about Figma's interface brightness, all floors still passing) is shown beside it in the visual direction; taking it is a change of values in `tokens.json` only | Marlin |
| 2026-11-23 | D4: signed-out visitors get the welcome page ("Try the editor" opens the demo with no sign-in, "Sign in" goes to the shared login and back to the home) | Marlin |
| 2026-11-23 | Approved as drawn: the editor chrome, the proposed dark and light, the phone layout | Marlin |
| 2026-11-23 | Selection is a complete ring that blooms outward (`--ui-selection-ring`), never a one-sided edge such as the left bar on the selected Layers row or the selected page. Applied to every selection treatment in the editor and the home, consistently | Marlin |

| 2026-11-26 | The lighter dark replaces the proposed dark (amends D3): background `#1e282b`, surface `#263236`, raised `#2f3c41`, as shown in the visual direction, with its full set (sunken `#182124`, line `#3a4c52`, field edge `#758f97`, text `#edf5f2`, muted `#b2c6c1`, accent text `#86b6ff`). Built as suite-theme #3 and shipped in release 0.3.1 (0.3.0 put the text value on the brand token by mistake; suite-theme #4 fixed it and pins the brand tokens in its verify step); Sites lifts its destructive red so it keeps 4.5 : 1 on the lighter grounds and gives destructive fills dark ink (`--destructive-foreground`) | Marlin, relayed by the coordinator |
| 2026-11-23 | Publishing `@marlinjai/suite-theme-core` 0.2.0 to npm. Tagged `v0.2.0` on suite-theme `e477bb7`, published by the Trusted Publisher workflow; `tokens.css` byte-identical to 0.1.2 | Marlin, relayed by the coordinator |

### Decided while building S2 (say so if you disagree)

- **The switch is a radio group, not three pressed buttons.** Inside a menu, one of three is the menu's own radio pattern
  (`menuitemradio` with `aria-checked`), which screen readers announce as a choice; choosing keeps the menu open.
- **The editor's More menu now shows on the wide bar at every fold level.** It was hidden there until the last fold, so
  Appearance would have been unreachable on a desktop. Unfolded, it holds only Appearance; the bar's own controls appear
  in it only once they folded away (the compact bar keeps everything), so nothing shows twice. The fold measures the bar
  as before, now with the More button in it from the start.
- **Mint splits into `brand` and `brand-fill`.** `brand` is the primary as text, line, ring, dot and wash, dark green
  `#06764a` in light. `brand-fill` is the mint fill of a button with dark ink (13 places, every `bg-brand` that carried
  `text-brand-foreground`); the shared `Button` gets a dark green edge on it in light. Thin indicators (dots, slider
  fills, drop lines) stay `brand`, which keeps 3 : 1 in light where mint would not.
- **A site that cannot be resolved counts as a site**, so the root layout writes no `data-ui-theme` then: a database
  hiccup must never put the editor's choice on a published page.
- **`ColorModeSwitch`'s `tone` moves to S3**, together with the hard-coded grays of the preview toolbar it sits in;
  switching only the switch would leave it mismatched with its bar.

The welcome copy is the visual direction's ("Build and run your website in one place." and its two sentences), which he
approved with the page.

### Decided while building S3 (2026-11-26, say so if you disagree)

- **What counts as a selection.** Selected rows and items (Layers, pages, FX layers, collections, the composer
  outline, the collection icon picker, the current history entry) and tabs (the left pane's tabs, the CMS rail, the
  interaction-state switcher) get `shadow-selection`, the complete ring of `--ui-selection-ring`, and keep the mint
  wash. **Value toggles** (Block/Flex/Grid, the colour-mode switch, toggle groups) keep the raised chip: they show a
  chosen value rather than a selection, and a glow on every toggle of the properties panel would drown the real
  selection. Selections drawn **on content** (the canvas selection, the composer's PDF page) are not chrome and stay
  as they are, on the allow-list.
- **Floating notices** (the editor's notice stack, the legal notice before publishing, the preview's notice bar) take
  two new editor tokens, `--warning-surface` (the warning colour mixed into the popover, so opaque over the canvas)
  and `--warning-edge`, in place of fixed amber; both follow Light and Dark.
- **The preview** follows the interface: its toolbar is the card colour, its stage the canvas ground, and
  `ColorModeSwitch` and the product picker lose their `tone` prop (one look everywhere).
- **The allow-list** of the raw-colour check (`src/app/__tests__/rawColours.test.ts`) names each remaining file
  with its exact matches and a reason: a page's white backing or paper, marks drawn on a site's content, values a
  person edits (colour-input defaults, swatches, examples). A stale entry
  fails the check as well as a new raw colour.

### Whether a public Sites landing page exists (checked 2026-11-23)

No. lumitra.co (still served by lumitra-web) lists Lumitra QR, Ultra Power, email-mcp, Studio and Analytics, not Sites;
`lumitra.co/sites`, `/en/sites`, `/de/sites` and `/products/sites` answer 404, and no page links to app.lumitra.co. The
lumitra.co rebuild inside Sites (project "Lumitra (new landing page)", published at `6zp2te2a5btk.sites.lumitra.co`)
carries the same product list without Sites; its open branch "Test new design" holds the hub sections and `/services`
pages per the plans (the branch's page list was not read directly). `demo.sites.lumitra.co` is the seeded shop demo, not a
product page. So the welcome page of D4 is, for now, the only public explanation of Sites; a Sites entry on lumitra.co is
a separate item for the lumitra.co rebuild, recorded on the roadmap.

## 3. Tokens (decided; numbers computed 2026-11-23, enforced by the suite-theme build)

| Token | Dark (lighter, 2026-11-26) | Light |
| --- | --- | --- |
| background | `#1e282b` | `#f3f7f5` |
| surface (panels, cards) | `#263236` | `#ffffff` |
| raised (menus, popovers) | `#2f3c41` | `#ffffff` with shadow |
| sunken (canvas ground, wells) | `#182124` | `#e9efec` |
| line (dividers, decorative) | `#3a4c52` | `#d6e0dc` |
| line-strong (field and control edges) | `#758f97` | `#768b85` |
| text | `#edf5f2` | `#0a1714` |
| muted text | `#b2c6c1` | `#4b5f5a` |
| primary fill / ink | `#52ffa5` / `#03140c` | `#52ffa5` / `#03140c` |
| primary as text, links, focus ring, the star | `#52ffa5` | `#06764a` (mint is 1.3 : 1 on white) |
| accent as text | `#86b6ff` | `#1d5fd6` |

Every figure is the lowest ratio of the pair against all four grounds (background, surface, raised, sunken),
recomputed against the values of the table above:

| Check | Dark | Light | Floor |
| --- | --- | --- | --- |
| Text | 10.3 | 15.7 | 4.5 |
| Muted text | 6.4 | 5.8 | 4.5 |
| Field edge (line-strong) | 3.3 | 3.1 | 3.0 |
| Ink on primary fill | 14.6 | 14.6 | 4.5 |
| Primary as text or focus ring | 8.8 | 4.9 | 4.5 text, 3.0 ring |
| Accent as text | 5.5 | 4.9 | 4.5 |

Surface steps stay small by design (1.1 : 1, like Linear or Figma); the separation comes from the step plus a
visible line and, in light, a shadow. The suite's `tokens.css` sets `color-scheme: dark` on `:root`, so the light set
sets `color-scheme: light` itself, which also turns native scrollbars and form controls light.

## 4. Slices

Each slice is one branch, about 1,500 changed lines at most, proven by `pnpm verify` before its one review and one
push, landed through land-pr.

1. **S1, tokens** (suite-theme repository): built 2026-11-23 as suite-theme #1. `tokens.json` gains a `ui` group
   (dark and light under the same names), the build emits `dist/ui.css` (both modes under `[data-ui-theme]`, the
   `prefers-color-scheme` fallback, `--ui-selection-ring` and `--ui-focus-ring`) and `dist/ui-tailwind.css`, and fails
   when a mode drops under the floors of section 3 on any of its four grounds. `tokens.css` is byte-identical, so the
   seven apps on this package change nothing until they import `ui.css`. Release 0.2.0 needs a tag push, which waits on
   Marlin's yes; S2 merges only after it.
2. **S2, theme plumbing in Sites:** take suite-theme 0.2.0; `editor-theme.css` maps the semantic tokens
   (`--background`, `--card`, `--popover`, `--border`, `--input` to line-strong, `--ring`, `--sidebar*`, the glass ground
   of `globals.css`) onto `--ui-*`, so both modes follow one attribute; `cms-grid-theme.css` follows too; the cookie and
   the root layout's no-site branch (section 2); the "Appearance (this browser)" group in More actions (three toggle
   buttons with `aria-pressed`, keyboard reachable); `ColorModeSwitch`'s `tone` follows the interface.
3. **S3, the raw-colour sweep and the selection ring:** 114 hard-coded palette classes in 24 files (most in
   `PreviewToolbar`, `CanvasDebugPanel`, `ProductPreviewBar`, `ResponsivePageRenderer`, `PreviewFrame`,
   `SkeletonLayer`) and about 50 colour literals in editor components move to tokens; files that draw a site's own
   content (the canvas page, the published renderer) are on an explicit allow-list. Every selection treatment (the
   selected Layers row, the selected page, the selected tab, cards) becomes `--ui-selection-ring`; one-sided selection
   edges are removed. Checks fail on any new raw palette class or colour literal in editor chrome, and on a one-sided
   selection edge (`border-l-2`, an inset x-offset shadow) in a selected state.
4. **S4, the home and the entry:** `/` as in section 2 (signed in to `/projects`, the demo by `?demo=1`, `?page=`
   or `?preview=1`, the signed-out case as D4 decides), the return paths and the allow-list, the home in the chosen
   direction (D2), company switcher, account menu with sign out and the theme, empty state ("No sites yet" with New
   site and Try the demo), the phone layout (fixes the overflow of section 1.4), titles per route.
5. **S5, proof:** the browser runs of section 5 on a local build, then on production after Marlin's deploy yes. Done on production on 2026-11-27 after release 3 (1b82fe3c); results in section 8.

S1 to S3 and S4 touch different files and can run in parallel after D1 and D2; S4 does not wait for the theme.

## 5. Checks (added to `pnpm verify` where scriptable)

- **Contrast:** a script reads the built token sheets and fails when any pair of section 3 drops under its floor,
  in both modes.
- **Raw colours:** the S3 check above.
- **Isolation:** a published page's HTML (the score's published base) carries no `data-ui-theme`, links no editor
  sheet, and keeps its own `.light` or `.dark` class; a site in the canvas keeps its own mode in both interface modes.
- **Theme preference, the four paths of the stateful-flow standard:** forward (choose Light, the editor turns light
  without reload); backtrack (choose System again, the cookie is removed and the system setting rules, also when it
  changes while the page is open); resume (reload, a new tab, a deep link into `/projects/<id>`: the first paint is
  already in the chosen mode, measured by a screenshot taken before hydration); re-entry (sign out and in, the choice
  stays, because it belongs to the browser).
- **The demo flow, the same four paths:** forward (`/?demo=1`, edit, Keep as project, sign in, back at `/?demo=1`
  with the work, saved as a project); backtrack (cancel at the login or the chooser, back at the demo with the work
  intact); resume (reload, and an old `/?page=<id>` still opens the demo page, signed in or not); re-entry (after
  saving, the demo starts fresh, as today).
- **Entry paths:** signed out `/` gives the demo or the welcome (per D4) with no login redirect; signed in `/` goes to
  the home; signed in without a company it leads to the chooser; auth-brain down behaves as signed out with a retry
  note; `/projects` behaves as today; a published site's own page `/demo` is untouched (no new route).
- **Accessibility:** axe on the home, the welcome and the editor in both modes; the theme control and the cards by
  keyboard alone; focus visible in both modes.
- **Responsive:** home and welcome at 390, 768, 1280 and 1680 px with no horizontal scroll; the editor's phone layout
  in both modes.
- **Browser proof (dev-browser, headless, automation profile):** signed in on a local build; signed out in a
  clean context; then the same on production after the deploy, read-only.

## 6. Protections and whom they protect

- The host-only cookie protects visitors of published sites from the editor's preference changing their page. No
  attacker involved: a correctness boundary.
- The return allow-list accepting `/?demo=1` protects against an open redirect through `?next=` (a phishing link that
  sends a signed-in person elsewhere after login). It stays a fixed list of exact strings, extended by one.
- Nothing else is added: the theme carries no data worth protecting.

## 7. Out of scope

Thumbnails captured from published pages; a theme preference stored in the account; restyling auth-brain's login
(its own repository, which follows if D1 is "suite"); the marketing site lumitra.co (stays dark).

## 8. Proof on production (2026-11-27, release 3 at 1b82fe3c, read-only)

Run headless on the automation profile (signed in, company Lumitra) and in a clean browser (signed out). Nothing was
saved: the only state written was the `lumitra_ui_theme` cookie, removed again at the end. Screenshots:
`~/software-dev/orchestration/sites-home-theme/shots/s5/`.

| Check | Result |
|---|---|
| Entry, signed in | `/` goes to `/projects`, the home with the site cards |
| Entry, signed out | `/` answers 200 with the welcome page, no login; "Try the editor" opens `/?demo=1`; `/projects` goes to the login; an old `/?page=<id>` still opens the demo; `/demo` is a 404 (no new route over a site's own page) |
| Theme, forward | Light and Dark from the Appearance menu change the page without a reload and write the cookie |
| Theme, resume | the first HTML of `/`, of a reload, of a new tab and of a deep link into `/projects/<id>` already carries `data-ui-theme`, so there is no flash |
| Theme, backtrack | System removes the cookie and follows the system setting in both directions while the page is open |
| Theme, re-entry | by construction: the cookie is host-only on app.lumitra.co for a year and the sign-out happens on auth.lumitra.co, which cannot clear it (not signed out on production, which would end the profile's session) |
| Isolation | published pages carry no `data-ui-theme` in their HTML whatever the cookie; a site in the canvas keeps its own white page in both interface modes and holds no `data-ui-theme` inside |
| Contrast, light | text 15.7, muted 5.8, brand 4.9, link 4.9, destructive 4.6, warning 4.9, field border 3.4 (worst of the four grounds) |
| Contrast, dark | text 10.3, muted 6.4, brand 8.8, link 5.5, destructive 4.8, warning 6.0, field border 4.4 |
| Accessibility (axe, WCAG 2 A and AA) | welcome: none; home: a missing document title (fixed, below); demo editor: `meta-viewport`, the deliberate trade-off of `useEditorGestureGuard` (docs/plans/2026-10-24-editor-on-phones.md), kept |
| Keyboard | every stop on the welcome page and the home shows a visible ring; a project card rings as a whole (the selection ring) |
| Responsive | home and welcome at 390, 768, 1280 and 1680 px: no horizontal scroll |
| Demo, keep as project | not run on production (it saves a project); covered by `DemoProjectSaving.test.tsx` and the local run of S4 |

All five slices are done. The plan stays in progress only for its open question on a public Sites product page
(the roadmap line "Sites has no public product page"), whose copy and publish are Marlin's.

Found and fixed in the same change: the projects home, Books, Catalog, Payments and both previews sent no `<title>`
(slice S4 had named only `/`). Each editor page now names its tab "<what> | Lumitra Sites", the root gives the editor
host "Lumitra Sites" as the fallback, published pages still name themselves, and `src/app/__tests__/pageTitles.test.ts`
holds every editor page to it.
<!-- ci-replay touch -->
