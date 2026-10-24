---
type: plan
status: decided
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

## Decided in build (decisions 1 to 3, loading states of 7; 2026-10-24)

- **One object, one column.** `SiteSettings` lives in `src/lib/site/siteSettings.ts` (type, defaults,
  `normalizeSiteSettings`, validation). MST: `ProjectModel.siteSettings`, a frozen value normalized
  on the way in, read through `project.site`, saved by `updateSiteSettings` (one undo step).
  Database: `sites.site_settings` JSONB (migration `20261023000000_site_settings`). Yjs: one JSON
  blob under `YJS_PROJECT_KEYS.siteSettings`. A new field (the effects agent's `smoothScroll`) is a
  change to that one file only.
- **Language default.** Projects saved before this keep `en` (what every published page declared
  until now, so nothing changes for them); the project-create route starts new projects with `de`.
  The site language wins over the brief's language in the generator.
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
