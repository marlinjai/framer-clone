---
type: plan
status: in-progress
date: 2026-10-23
title: Published site essentials, the things that make a generated site real
summary: Close the gaps between a generated page and a real business site, from the owner's 19-point checklist of 2026-10-23 (custom 404, call to action above the fold, meta title and description, Open Graph image, favicon set, robots.txt, sitemap.xml, alt text, mobile breakpoints, sticky mobile call to action, loading states, form error states, thank-you page, privacy policy, terms, cookie banner, analytics, real contact address), audited against the code the same day; built around one Site settings object, forms, legal page templates and consent.
tags: [framer-clone, publishing, seo, legal, gdpr, forms, ai]
projects: [framer-clone]
---

# Published site essentials

## Why

The owner's checklist ("your vibe coded site is fake, it's missing 20 things that make it real",
2026-10-23). An audit of main the same day found, for the sites customers publish:

| Status | Items |
|---|---|
| Exists | meta title and description per page (PageSettingsDialog, `generateMetadata`), mobile breakpoints (responsive stylesheet since #147), analytics snippet (`trackerSnippet.ts`) |
| Partial | 404 (one generic `src/app/(site)/not-found.tsx` for every site), Open Graph image (model field, no editor field, no site default, no twitter card), alt text (generator writes it, validator falls back to "Image" silently), canonical URL (only when set by hand) |
| Missing | favicon set (every site shows the platform icon), robots.txt and sitemap.xml per host, sticky mobile call to action (`position: fixed` is blocked by a validator guard), loading states (no image `loading`, no island fallbacks), forms at all (`form` is a forbidden tag), thank-you page, privacy policy, terms, Impressum (legally required for German sites), consent banner (analytics loads ungated, tracker cookie use unverified), structured contact data, JSON-LD, per-page noindex, `lang` (hardcoded `en`) |

## Decisions

1. **One Site settings object** on the project: site name, language (drives `<html lang>` and the
   generator's copy language), favicon (uploaded, rendered as the icon set and a web manifest),
   default Open Graph image and twitter card, title template ("%s | Site name"), business and
   contact data (legal name, address, phone, email, opening hours, VAT ID, register entry), and the
   consent mode. Edited in a Site settings dialog; the generator reads it (real address, hours and
   contact in footers and contact sections, never invented ones).
2. **Per host, generated:** `robots.txt` (with the sitemap pointer, and respecting per-page
   noindex) and `sitemap.xml` from the published pages (dynamic `:param` pages expanded from their
   collection or left out, decided in build), `<link rel=canonical>` defaulting to the page's own
   URL on its primary host, JSON-LD `LocalBusiness` from the business data.
3. **Per page:** an Open Graph image field and a noindex switch in Page settings; the 404 becomes a
   page type the site owner designs like any page (falling back to a styled default that uses the
   site's fonts and colours).
4. **Forms:** a form component family (input, textarea, select, checkbox, submit) with client and
   server validation, visible error states, a loading state on submit, spam protection without
   third-party trackers, submissions stored per company and notified by email (Lumitra Mail), and a
   success target: an inline message or a thank-you page. The generator may then use forms.
5. **Legal pages:** Impressum, privacy policy (DSGVO) and terms as page templates filled from the
   business data, with clearly marked placeholders for what only the owner can state. They are
   templates, not legal advice; the dialog says so and links the owner to review them. Footers link
   them automatically.
6. **Consent:** first verify whether the Lumitra Analytics tracker sets cookies or storage. If it is
   cookieless and stores no personal data, no banner is needed and the site says so in its privacy
   page. If anything requires consent, a small first-party consent banner gates it (no third-party
   consent platform), styled from the site's fonts and colours.
7. **Generator:** every page has a primary call to action above the fold, alt text is required and
   meaningful (the silent "Image" fallback becomes a repair finding), images below the fold get
   `loading="lazy"` and the hero image `fetchpriority="high"`, and a sticky mobile call to action
   is allowed as a dedicated primitive (not raw `position: fixed`).

## Order

Site settings object, lang, favicon set, OG image, title template and canonical first (small,
unblock the rest); then robots, sitemap, noindex and JSON-LD; then the 404 page type and loading
states; then forms with the thank-you page; then legal templates; then consent after the tracker
check. Each step ships on its own.

## Forms as built (decision 4, 2026-10-24)

Decided while building, each reversible:

- **Components, not raw tags.** Form, Text, Email, Phone, Textarea, Select, Checkbox, Consent checkbox
  and Submit button are registry presets marked `data-form-kind` (`src/lib/forms/definition.ts`). The
  container and fields are divs in the editor (so they get the layout and spacing controls); the
  published page renders a real `<form>` island (`src/lib/renderer/forms/FormIsland.tsx`). Raw `form`,
  `input`, `select` and `textarea` stay in the generator's FORBIDDEN_TAGS, so the tag list did not need
  an exception.
- **The server reads the form from the published snapshot**, never from the request, and validates with
  the same module the island uses (`src/lib/forms/validation.ts`).
- **No mail.** The repository has no mail transport (no Lumitra Mail client, Resend or SMTP), so
  submissions are stored only and read in the editor's Form submissions view; the Form section says so.
  The notification email field was left out rather than shipped as a control that does nothing.
- **No IP stored**, not even hashed (an IPv4 hash is reversible by enumeration). Rate limits are in
  memory per IP and per form.
- **Without JavaScript** the form posts normally: a thank-you page answers 303, an inline success or an
  error answers a small self-contained HTML page with a link back (the page route stays untouched).
- **Deletes:** one submission (owner), all of a project's (after the project delete commits, loud 500
  `delete_submissions_failed` on failure), all of a workspace's (company erasure, `deleteWorkspaceSubmissions`)
  and the schema drop. No company erasure orchestrator exists in the repository yet; it must call
  `deleteWorkspaceSubmissions` or drop the schema.

## Decided in build (decisions 1 to 3, loading states of 7; 2026-10-24)

- **One object, one column.** `SiteSettings` lives in `src/lib/site/siteSettings.ts` (type, defaults,
  `normalizeSiteSettings`, validation). MST: `ProjectModel.siteSettings`, a frozen value normalized
  on the way in, read through `project.site`, saved by `updateSiteSettings` (one undo step).
  Database: `sites.site_settings` JSONB (migration `20261023000000_site_settings`). Yjs: one JSON
  blob under `YJS_PROJECT_KEYS.siteSettings`. A new field (the effects agent's `smoothScroll`) is a
  change to that one file only.
- **Language default.** Projects saved before this keep `en` (what every published page declared
  until now, so nothing changes for them); the project-create route starts new projects with `de`.
  In the generator the brief's language wins when it is clearly another one (otherwise every
  existing project, all `en`, would switch a German brief to English copy); a short or neutral
  brief is written in the site language.
- **Site name** is an optional public override; blank uses the project title, which the dashboard
  rename flow keeps owning.
- **Favicon and Open Graph image by https URL.** The only upload path today is the Books logo store
  (behind `editBooks`, not publicly servable), so no upload was reused. Every renderer re-checks
  `isHttpsUrl` and leaves a bad value out. `src/app/favicon.ico` became a per-host route (site icon,
  404 for a site without one, platform icon on the editor host); the platform icon moved to
  `public/platform-favicon.ico` and the root layout links it only on hosts without a site.
- **`<html lang>`** comes from the root layout, which reads the request's site
  (`src/server/sites/requestSite.ts`, one cached resolution shared with the (site) layout and the
  page). Cost: `/`, `/preview` and the root `/_not-found`, which were prerendered shells, now
  render per request (the published routes were already dynamic). Accepted: they are editor
  shells whose content is client-side, and the alternative (separate root layouts per route
  group) would move every editor route.
- **Primary host** for canonical, Open Graph URL, sitemap and robots: the oldest live custom domain,
  else the platform subdomain, else the request host (`src/server/sites/primaryHost.ts`, also used
  by the editor's site address). Read uncached per request, because the per-host site cache is not
  invalidated for the subdomain when a custom domain is claimed or released.
- **Title template** default "%s | site name"; a page titled like the site (the home page) shows
  the site name alone.
- **JSON-LD** `LocalBusiness` with a complete address (with valid opening-hours rows), else
  `Organization`, nothing without business data; on the home page only.
- **robots.txt** allows everything and points at the sitemap; it never disallows a noindex page (the
  crawler must see the noindex). A host without a site gets `Disallow: /`.
- **sitemap.xml** lists published pages minus noindex pages and the 404 page, lastmod from the
  page's `updatedAt`. Dynamic pages are expanded only when the values are knowable: a RecordView
  bound to a literal collection id on a `:id` page (published row ids), or a bound ProductDetail on
  a `:handle` page (product handles); at most 1000 values per page and 5000 URLs in total; any
  other dynamic page is left out.
- **404 page**: one pointer, `notFoundPageId`, set from Page settings ("Use as 404 page") or Site
  settings; never the home page; cleared when the page is deleted or becomes the home page. Its own
  path also answers 404. Without one, a default in the site's language with its name and the look
  of its home page (font, colours, first filled button).
- **Loading**: the hero is the first img of at least 160 px in the first section
  (`fetchpriority="high"`, never lazy); a hero made of a photo background is preloaded instead;
  every other img is `loading="lazy" decoding="async"`; author values are kept. Commerce islands
  render a sized `aria-busy` placeholder until mounted, an error boundary with "Try again", and a
  plain visitor sentence (not the internal message) when a data read fails.

## Legal and consent as built (decisions 5 and 6, 2026-10-24)

The tracker check of decision 6 came out: the Lumitra Analytics tracker stores a session id and
experiment variants in sessionStorage and a variants cookie (`lumitra_variants_pub`), so under
section 25 TDDDG it needs consent. Decided while building, each reversible:

- **The tracker is never in the HTML of a site with analytics.** `renderPublishedPage` renders
  `ConsentBanner` (`src/lib/consent/`) instead of the old snippet: server-rendered markup, hidden
  by default, and an inline runtime (hand-written ES5 in `consent.ts`) that runs before hydration.
  A stored "yes" loads the tracker at once (the same `__AP_VARIANTS` and `__AP_CONFIG` globals and
  loader the snippet used, `buildTrackerPayload` keeps the secret-key backstop); a stored "no" or
  a decline loads nothing, not even the globals. Without JavaScript nothing shows and nothing loads.
  A site with analytics off, or without a key or endpoint, gets no banner and no runtime.
- **The choice** lives in localStorage `lumitra-consent` as `{v, analytics, at}`; bumping
  `CONSENT_VERSION` asks every visitor again. Storage that throws keeps the choice for the page
  view. Declining after an earlier yes removes the tracker's `ap_*` session entries and cookie and
  reloads the page.
- **Banner**: non-modal `role="dialog"` labelled by its heading, first in the reading order, takes
  focus only when reopened; Accept and Decline share one style (no dark pattern), 44 px tall;
  German for `de*`, English otherwise; font and colours from the home page (`siteLookFromPages`);
  links the privacy page when one exists. Reopened by any link to `#cookie-settings` or
  `window.__lumitraConsent.open()`; Escape closes a reopened banner. On a site where nothing needs
  consent, `#cookie-settings` links are hidden by CSS.
- **No banner setting.** Site settings shows the banner's status instead: "off" while analytics runs
  would break the law, "off" otherwise changes nothing. The preview and the editor canvas never go
  through `renderPublishedPage`, so the banner never appears there; no testing toggle was added.
- **Loader contract, open on the analytics side.** No loader that reads `__AP_CONFIG` exists in the
  analytics-platform repository (the npm tracker is ESM with `init()`), so after consent the
  runtime also sets `__AP_CONFIG.consent = { analytics: true }`, dispatches `lumitra:consent`, and
  calls `window.LumitraAnalytics.enableTracking()` when the loader exposes it. The loader at
  `ANALYTICS_TRACKER_SCRIPT_URL` must honour one of these to enable clicks and scroll.
- **Legal pages** (`src/lib/legal/`): Impressum (section 5 DDG, section 18 (2) MStV), privacy policy
  (controller, Hetzner hosting in Germany, server logs, analytics with consent and what it stores,
  forms without IP, Unsplash hotlinking with a third-country placeholder, self-hosted fonts,
  rights, supervisory authority) and short neutral terms, German and English by site language.
  Filled from the business data; anything missing, and anything only the owner can judge, is a
  `[placeholder]`. The analytics, forms and Unsplash sections appear only when the project uses them
  (read off its pages when the page is created).
- **Created from Site settings** ("Create Impressum", "Open ..." once it exists) as ordinary pages at
  stable slugs (`impressum`, `datenschutz`, `agb`; `imprint`, `privacy`, `terms`), never a second
  copy, marked by page metadata `legalTemplate` (not a prop, so nothing leaks into the published
  HTML). The draft settings are saved first so the page uses what the owner just typed. Creating a
  page also links it from every footer; "Add legal links to footers" repeats that for pages made
  later. The editor shows "Template, not legal advice: review before publishing" with the count of
  placeholders above such a page (never published).
- **Publish warning**: business data without an Impressum, or a template page that still holds
  placeholders, opens an in-page notice before publishing with "Create Impressum" (or "Open ...")
  and "Publish anyway".
- **Generator**: `promptSections/legalLinks.ts` tells it to end every footer with links to the legal
  pages that exist plus the cookie settings link, with exact hrefs and labels (sent as an optional
  `legalLinks` field of the site context). Links to pages that do not exist are never generated.
