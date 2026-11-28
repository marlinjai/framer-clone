// src/lib/customCode/fallbackText.ts
//
// What a new custom code block shows visitors until its frame says hello, and for
// good when the frame cannot run (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// D102): one paragraph in the site's language, which the author replaces with their
// own fallback. Site content, so in German or English as the site is; the editor's
// own words stay English.

export const CUSTOM_CODE_FALLBACK_TEXT: Readonly<Record<'en' | 'de', string>> = Object.freeze({
  en: 'Interactive content appears here. If it does not, your browser may block it or not support it.',
  de: 'Hier erscheint interaktiver Inhalt. Falls nicht, blockiert Ihr Browser ihn oder unterstützt ihn nicht.',
});
// ci-replay touch
