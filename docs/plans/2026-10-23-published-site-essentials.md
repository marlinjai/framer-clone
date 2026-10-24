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
