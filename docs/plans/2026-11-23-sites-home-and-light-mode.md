---
title: A real home at app.lumitra.co, a light mode, and a readable dark mode
description: Plan for what app.lumitra.co shows first (signed in and signed out), where the demo editor moves, an interface theme preference (System, Light, Dark) across every editor surface, and a lifted dark palette whose panels and fields separate.
summary: Marlin reported on 2026-11-23 that app.lumitra.co opens straight into "Framer Clone Demo" instead of his projects, that he wants a light mode throughout the product, and that the dark editor is too dark to read. Measured on production the same day, text contrast is fine (17 to 1) but panel surface on background is 1.02 to 1 and field borders 1.2 to 1, so every panel melts into one black. The plan makes `/` a home (the projects for a signed-in person, a welcome with "Try the editor" for everyone else), moves the demo to `/demo` with every return path, adds a System, Light and Dark preference kept per browser with no flash, lifts the dark palette into a three-step ramp with field borders of at least 3 to 1, and proves both modes with a contrast check, a raw-colour check and browser runs. Five slices, each under about 1,500 changed lines.
type: plan
status: draft
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

- **Signed-out `/` is a welcome, not a login wall.** Not everyone who opens app.lumitra.co has an account, and the
  demo is the way in without one. The welcome offers "Try the editor" (the demo, no sign-in) and "Sign in". Nobody
  is sent to the login just for opening the address.
- **Signed-in `/` shows the home.** One server-side session read (the existing `loadDashboard`). If auth-brain does
  not answer, `/` shows the welcome with a retry note, never an error page and never a login loop.
- **The demo moves to `/demo`, with every path that returns to it.** Today "Keep as project" sends a signed-out
  person to `/projects?next=/` and `safeEditorReturnPath` lets `/` through, so the stashed demo is restored on the way
  back. Once `/` is a home, that person would land on the home and their demo work would look lost. So in the same
  slice: the return allow-list accepts `/demo` (and drops `/`), both hrefs in `saveDemoAsProject.ts` use `/demo`, the
  "Back to the editor" link of `src/app/preview/page.tsx` points at `/demo`, and an old address `/?page=…` or
  `/?preview=1` redirects to `/demo` with its query, so bookmarks and the address sync keep working.
- **`/projects` stays the address of the signed-in home**, because the login's `return_to`, the company chooser,
  `?switch=1`, `?next=` and every "Back to projects" link already use it. `/` for a signed-in person with an active
  company renders the same home (one component, two routes); a person without a company goes to `/projects`, which
  keeps the chooser and the "Sites not enabled" states exactly as they are.
- **The list stays scoped to the active company.** "All projects" means all of this company's sites, with the company
  switcher on the home. Listing sites across companies on one page would mix tenants, which the multi-tenancy design
  forbids.
- **The editor's theme never uses the `.dark` or `.light` class on `<html>`.** Those already mean something else: the
  root layout sets them from a published site's theme, the data-table grid sheet relies on `.light`, the canvas
  frames get `.dark` from the site's own colour mode (`editorUI.frameDarkClass`), and Tailwind's `dark:` variant keys
  on `.dark` ancestors, so a dark editor marked with `.dark` would turn every site in the canvas dark. The interface
  theme is `data-ui-theme="light|dark"` on `<html>` instead, set only on editor surfaces.
- **The preference is System (default), Light or Dark, kept per browser in a host-only cookie** (`lumitra_ui_theme`,
  no `Domain` attribute, so it never reaches a published site on another subdomain). The server reads it and writes
  `data-ui-theme` into the first HTML, so there is no flash; with no cookie the attribute is absent and CSS follows
  `prefers-color-scheme`, which also tracks a system switch live without script. Nothing goes into the account:
  a theme per device is the common expectation and needs no API.
- **Where the switch lives:** in the account menu of the home, and in the editor's existing settings menu, named
  "Interface theme" so it is not confused with the canvas's Light and Dark buttons, which show a site's own colour
  mode to visitors. No new top-bar button, so the measured fold order of the top bar (plan 2026-11-12-top-bar-fold)
  does not change.
- **The canvas and published sites do not follow the interface theme.** A page on the canvas shows the site's own
  colours; only the ground around it (the dotted canvas) follows the interface. Published sites never load the editor
  sheet, and a test keeps it that way (see section 5).
- **Project cards get a picture from the site's own theme tokens** (background, primary, text and font as a small
  abstract page), not a screenshot: nothing stores a preview image today, and live frames of published pages would
  load a WebGL scene per card, against the one-WebGL-context rule of the FX work. Real thumbnails captured at publish
  are a separate idea, not part of this request.

### Genuinely Marlin's (sent to the coordinator)

- **D1. Does the light palette become part of the suite theme, or stay inside Sites?** Recommendation: add it to
  `@marlinjai/suite-theme-core` as a second token set (and the lifted dark ramp as the "app" surfaces), amending rule 5
  of the rebrand plan from "dark only, no toggle" to "dark first; apps offer Light, Dark and System; marketing stays
  dark". Reason: one source for every app (Booking, Mail, Studio and Lumitra OS can follow when they want), and the
  contrast floors are checked in one build. The alternative keeps light inside Sites only, faster by about a day, but
  the next app would copy the values by hand.
- **D2. Which home direction?** A, "Studio grid" (recommended): one top bar, sites as large cards with a theme
  picture, a "New site" card, the tools (Catalog, Payments, Books, Demo) as a quiet row. B, "Workspace rail": a left
  rail with Sites, Catalog, Payments, Books and the company, sites as a dense list, better past about twenty sites, and
  it would restyle the Catalog, Payments and Books pages around the same rail. Both are in the visual direction file.
- **D3. How much lighter the dark gets.** Proposed: background `#0c1316`, surface `#131e23`, raised `#1a272d`
  (the visual direction's middle editor). Marketing keeps `#04090b`. If he wants it lighter still, the ramp moves up
  as a whole; the checks below hold either way.

## 3. Tokens (proposed; numbers computed 2026-11-23)

| Token | Dark (lifted) | Light |
| --- | --- | --- |
| background | `#0c1316` | `#f3f7f5` |
| surface (panels, cards) | `#131e23` | `#ffffff` |
| raised (menus, popovers) | `#1a272d` | `#ffffff` with shadow |
| sunken (canvas ground, wells) | `#0a1012` | `#e9efec` |
| line (dividers, decorative) | `#2a3b42` | `#d6e0dc` |
| line-strong (field and control edges) | `#56707a` | `#7f948e` |
| text | `#e8f2ef` | `#0a1714` |
| muted text | `#9cb3ae` | `#4b5f5a` |
| primary fill / ink | `#52ffa5` / `#03140c` | `#52ffa5` / `#03140c` |
| primary as text, links, focus ring | `#52ffa5` | `#06764a` (mint fails as text on white) |
| accent as text | `#6aa5ff` | `#1d5fd6` |

| Check | Dark | Light | Floor |
| --- | --- | --- | --- |
| Text on surface | 15.3 | 18.3 | 4.5 |
| Muted on surface / on raised or sunken | 7.9 / 6.9 | 6.8 / 5.8 | 4.5 |
| Field edge (line-strong) on surface | 3.2 | 3.2 | 3.0 |
| Ink on primary | 14.6 | 14.6 | 4.5 |
| Primary text or focus ring on surface | 13.5 | 5.7 | 4.5 text, 3.0 ring |
| Accent text on surface | 7.0 | 5.7 | 4.5 |

Surface steps stay small by design (1.1 : 1, like Linear or Figma); the separation comes from the step plus a
visible line and, in light, a shadow. The suite's `tokens.css` sets `color-scheme: dark` on `:root`, so the light set
sets `color-scheme: light` itself, which also turns native scrollbars and form controls light.

## 4. Slices

Each slice is one branch, about 1,500 changed lines at most, proven by `pnpm verify` before its one review and one
push, landed through land-pr.

1. **S1, tokens** (suite-theme repository, only if D1 is "suite"): `tokens.json` gains the light set and the app
   ramp, the build emits `tokens.css` (dark, unchanged names) and `tokens-ui.css` (both modes under
   `[data-ui-theme]` plus the `prefers-color-scheme` fallback), the build fails under the floors of section 3,
   release 0.2.0. If D1 is "Sites only", the same file lives in `src/app/ui-theme.css` and this slice folds into S2.
2. **S2, theme plumbing in Sites:** `editor-theme.css` maps the semantic tokens (`--background`, `--card`,
   `--border`, `--input` to line-strong, `--ring`, `--sidebar*`, the glass ground of `globals.css`) per mode;
   `cms-grid-theme.css` gets both modes; the cookie, the server read in the editor surfaces' layouts (never in the
   published path), the "Interface theme" control (three toggle buttons with `aria-pressed`, keyboard reachable) in
   the home's account menu and the editor's settings menu; `ColorModeSwitch`'s `tone` follows the interface.
3. **S3, the raw-colour sweep:** 114 hard-coded palette classes in 24 files (most in `PreviewToolbar`,
   `CanvasDebugPanel`, `ProductPreviewBar`, `ResponsivePageRenderer`, `PreviewFrame`, `SkeletonLayer`) and about 50
   colour literals in editor components move to tokens; files that draw a site's own content (the canvas page, the
   published renderer) are on an explicit allow-list. A check fails on any new raw palette class or colour literal in
   editor chrome.
4. **S4, the home and the demo move:** `/` as in section 2, `/demo` with the redirects and return paths, the home in
   the chosen direction (D2), company switcher, account menu with sign out and the theme, empty state ("No sites
   yet" with New site and Try the demo), the phone layout (fixes the overflow of section 1.4), titles per route.
5. **S5, proof:** the browser runs of section 5 on a local build, then on production after Marlin's deploy yes.

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
- **The demo flow, the same four paths:** forward (`/demo`, edit, Keep as project, sign in, back at `/demo` with the
  work, saved as a project); backtrack (cancel at the login or the chooser, return to `/demo` with the work intact);
  resume (reload `/demo`, old `/?page=<id>` redirects with the page kept); re-entry (after saving, `/demo` starts a fresh
  demo, as today).
- **Entry paths:** signed out `/` shows the welcome with no login redirect; signed in `/` shows the home; signed in
  without a company `/` leads to the chooser; auth-brain down shows the welcome with retry; `/projects` behaves as today.
- **Accessibility:** axe on the home, the welcome and the editor in both modes; the theme control and the cards by
  keyboard alone; focus visible in both modes.
- **Responsive:** home and welcome at 390, 768, 1280 and 1680 px with no horizontal scroll; the editor's phone layout
  in both modes.
- **Browser proof (dev-browser, headless, automation profile):** signed in on a local build; signed out in a
  clean context; then the same on production after the deploy, read-only.

## 6. Protections and whom they protect

- The host-only cookie protects visitors of published sites from the editor's preference changing their page. No
  attacker involved: a correctness boundary.
- The return allow-list accepting `/demo` protects against an open redirect through `?next=` (a phishing link that
  sends a signed-in person elsewhere after login). It stays a fixed list, extended by one path.
- Nothing else is added: the theme carries no data worth protecting.

## 7. Out of scope

Thumbnails captured from published pages; a theme preference stored in the account; restyling auth-brain's login
(its own repository, which follows if D1 is "suite"); the marketing site lumitra.co (stays dark).
