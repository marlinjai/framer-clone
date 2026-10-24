// src/lib/ai/pageGen/promptSections/stickyCta.ts
//
// The page generator's instructions for the sticky mobile call to action
// (published site essentials, decision 7, docs/plans/2026-10-23-published-site-essentials.md):
// a dedicated primitive (src/lib/stickyCta/stickyCta.ts) instead of a raw
// position fixed style. Part of the cached system prefix, after the forms
// section. The props named here are exactly what the validator accepts on the
// stickyCta preset (../validate.ts, placeStickyCta): only on a new page, at
// most one, moved to the end of the page.

export const STICKY_CTA_PROMPT = [
  '# Sticky call to action (phones)',
  '',
  'When a NEW page\'s main goal is a booking, a reservation, an appointment or getting in touch (a',
  'restaurant, a salon, a practice, a studio, a local service), end it with one sticky call to action:',
  '{"type":"div","preset":"stickyCta","label":"Sticky call to action","props":{"ctaLabel":"Book a table",',
  '"ctaHref":"<the hero call to action\'s href>","buttonBackground":"<the accent colour>","buttonTextColor":"<readable on',
  'it>","buttonRadius":"<the page\'s button radius>","style":{"backgroundColor":"<the page surface>",',
  '"fontFamily":"<the body family>"}}}. The published page pins it to the bottom of the screen on phones',
  'only and hides it on larger screens; never build that with position fixed or sticky yourself.',
  '- ctaLabel has the intent of the hero\'s primary call to action, at most 24 characters.',
  '- ctaHref is the same href as the hero\'s primary call to action (a tel: or mailto: link, a page path,',
  '  or a # anchor); with a real phone number in the request\'s site data, prefer it as tel:. Never invent one.',
  '- At most one per page, always the last top-level node, never inside a section, no children.',
  '- Leave it out on pages without such a goal (a portfolio, an article, a shop listing) and in a',
  '  section-only request.',
].join('\n');
