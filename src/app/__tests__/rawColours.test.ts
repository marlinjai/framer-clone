// src/app/__tests__/rawColours.test.ts
//
// The editor's chrome follows the interface's Light and Dark through tokens (plan
// docs/plans/2026-11-23-sites-home-and-light-mode.md, slice S3). This fails on any hard-coded
// palette class or colour literal outside the allow-list below, and on an allow-list entry that
// no longer matches, so the list stays exact. It also fails on a one-sided selection edge and on a
// selected row that has the mint wash without the complete selection ring.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOUR_LITERAL, RAW_CLASS, scanRawColours, SCANNED_ROOTS } from './rawColourScan';

const REPO = path.join(__dirname, '../../..');

/**
 * What may stay, with the reason. Most entries draw a site's own content or a page's paper, which
 * must look the same in both interface modes; the rest are values a person edits (colour-input
 * defaults, swatches, examples), not colours of the chrome.
 */
const ALLOWED: Record<string, { matches: string[]; reason: string }> = {
  'src/components/ResponsivePageRenderer.tsx': { matches: ['bg-white'], reason: "a canvas frame's white backing under the site's own page background" },
  'src/components/live/SkeletonLayer.tsx': { matches: ['#404040', 'bg-white', 'rgba(128, 128, 128, 0.10)', 'rgba(128, 128, 128, 0.22)', 'rgba(128, 128, 128, 0.35)', 'rgba(255, 255, 255, 0.92)'], reason: 'a planned page drawn as a page: its white backing and the neutral bars on it' },
  'src/components/ai/PageGenDraftLayer.tsx': { matches: ['#404040', 'bg-white', 'rgba(120, 120, 120, 0.08)', 'rgba(120, 120, 120, 0.35)', 'rgba(255, 255, 255, 0.92)'], reason: 'a page being generated, drawn as a page: its white backing and the neutral placeholders on it' },
  'src/components/preview/PreviewFrame.tsx': { matches: ['bg-white'], reason: 'the white backing of the browser page base, which shows the canvas colour of a plain page' },
  'src/components/ComponentRenderer.tsx': { matches: ['#92400e', '#92400e'], reason: "a notice drawn inside the site's frame, on the page: a dark amber that reads on the page's white" },
  'src/components/HudSurface.tsx': { matches: ['bg-white'], reason: "a resize handle drawn on the site's content, white with a brand edge so it reads on any site" },
  'src/utils/crossViewportHighlighting.ts': { matches: ['bg-green-300/5', 'bg-green-500/10', 'bg-green-500/10', 'border-green-300', 'border-green-500', 'border-green-500'], reason: "the canvas selection drawn on the site's content (already a complete ring), the same in both modes" },
  'src/components/SpacingHandlesLayer.tsx': { matches: ['rgb(245 158 11)'], reason: "the margin handles on the site's content, colour coded apart from padding and gap" },
  'src/components/fx/FxPickOutline.tsx': { matches: ['#3b82f6', 'rgba(255,255,255,0.55)'], reason: 'the outline of an FX layer under the pointer, drawn on the scene' },
  'src/components/branches/review/reviewText.ts': { matches: ['#16a34a', '#2563eb', '#d97706', '#dc2626'], reason: "the change kinds outlined on the reviewed page's content, and the same dot in the list" },
  'src/components/sidebars/right/sections/ImageSection.tsx': { matches: ['bg-white', 'border-white'], reason: 'the focal point marker over the image, white with a dark halo so it reads on any picture' },
  'src/components/phone/PhoneContextMenu.tsx': { matches: ['rgb(0 0 0 / 0.35)'], reason: 'a drop shadow, black in both modes' },
  'src/components/ui/button.tsx': { matches: ['text-white'], reason: 'white ink on the destructive fill, which keeps 4.5 : 1 in both modes' },
  'src/components/cms/CollectionList.tsx': { matches: ['text-white'], reason: 'white ink on the destructive fill' },
  'src/components/cms/CollectionRail.tsx': { matches: ['text-white'], reason: 'white ink on the destructive fill' },
  'src/components/CanvasDebugPanel.tsx': { matches: ['text-white'], reason: 'white ink on the destructive fill' },
  'src/components/phone/QuickToolbar.tsx': { matches: ['#111111', '#111111', '#111111', '#15803d', '#1d4ed8', '#6b7280', '#6d28d9', '#b45309', '#b91c1c', '#ffffff'], reason: "the text swatches and default a person puts on the site's text" },
  'src/components/sidebars/right/primitives/ColorInput.tsx': { matches: ['#000000', '#000000', '#000000', '#ffffff', '#ffffff', '#ffffff'], reason: "a colour input's starting values for a site colour" },
  'src/components/sidebars/right/sections/StylesSection.tsx': { matches: ['#000000', '#000000', '#ffffff', 'rgba(0,0,0,0.1)'], reason: "the starting values and an example for a site component's colours and shadow" },
  'src/components/sidebars/right/sections/FormSection.tsx': { matches: ['#111827', '#d1d5db', '#ffffff'], reason: "the starting colours of a site form's fields" },
  'src/components/sidebars/right/sections/ComponentSection.tsx': { matches: ['#e5e5e5', 'rgba(0, 0, 0, 0.12)'], reason: 'examples of a border and a shadow value for a site component' },
  'src/components/site/ThemePanel.tsx': { matches: ['#1a2b3c'], reason: "the starting value of a new colour token for the site's theme" },
  'src/app/projects/books/composer/Inspector.tsx': { matches: ['#1a2b3c'], reason: 'an example colour in help text' },
  'src/app/projects/books/composer/PdfCanvas.tsx': { matches: ['bg-white', 'bg-white', 'ring-black/5', 'ring-black/5'], reason: 'the PDF page: white paper with a hairline edge' },
  'src/app/projects/books/composer/LogoPicker.tsx': { matches: ['bg-white', 'bg-white', 'bg-white'], reason: "a logo shown on the document's white paper" },
  'src/app/projects/books/invoice/InvoicePage.tsx': { matches: ['#1a1a1f'], reason: "the default ink of a field on the document's paper" },
  'src/app/Welcome.tsx': { matches: ['bg-white'], reason: "a picture of a site's white page in the welcome illustration" },
};

describe('raw colours in the editor chrome', () => {
  const found = scanRawColours(REPO);

  it('scans the editor code', () => {
    expect(SCANNED_ROOTS.every((root) => fs.existsSync(path.join(REPO, root)))).toBe(true);
    expect(found.size).toBeGreaterThan(0);
  });

  it('sees directional borders and records a colour function whole', () => {
    expect('border-red-500 border-l-red-500 border-x-white/10'.match(RAW_CLASS)).toEqual(['border-red-500', 'border-l-red-500', 'border-x-white/10']);
    expect("'0 0 2px rgba(199, 0, 0, 1)' rgb(0 0 0 / var(--a)) oklch(0.8 0.1 80)".match(COLOUR_LITERAL)).toEqual(['rgba(199, 0, 0, 1)', 'rgb(0 0 0 / var(--a))', 'oklch(0.8 0.1 80)']);
  });

  it('uses tokens everywhere outside the allow-list', () => {
    const outside = [...found].filter(([file]) => !ALLOWED[file]).map(([file, hits]) => `${file}: ${hits.join(' ')}`);
    expect(outside, 'Use an interface token (bg-background, text-muted-foreground, border-input, bg-warning-surface ...) or add an entry with a reason').toEqual([]);
  });

  it.each(Object.entries(ALLOWED))('%s holds exactly its allowed colours', (file, entry) => {
    expect(found.get(file) ?? [], entry.reason).toEqual([...entry.matches].sort());
  });
});

describe('selection is a complete ring', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); } else if (/\.tsx$/.test(e.name) && !/\.harness\.tsx$/.test(e.name)) files.push(full);
    }
  };
  for (const root of ['src/components', 'src/app']) walk(path.join(REPO, root));

  /** A class string chosen by a selected state: `isSelected ? '…'`, `active ? '…'`. */
  const SELECTED = /\b(?:isSelected|selected|isActive|active|picked|checked|isCurrent)\s*\?\s*(['"`])([^'"`]*)\1/g;

  it('has no one-sided edge in a selected state', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [, , classes] of fs.readFileSync(file, 'utf8').matchAll(SELECTED)) {
        if (/(?:^|\s)border-[lrtbse]-(?:\d|\[)|shadow-\[inset_-?[1-9]/.test(classes)) offenders.push(`${path.relative(REPO, file)}: ${classes}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every selected row its ring along with the mint wash', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [, , classes] of fs.readFileSync(file, 'utf8').matchAll(SELECTED)) {
        if (/(?:^|\s)bg-brand\/10(?:\s|$)/.test(classes) && !/(?:^|\s)shadow-selection(?:\s|$)/.test(classes)) offenders.push(`${path.relative(REPO, file)}: ${classes}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('defines the ring from the shared palette', () => {
    expect(fs.readFileSync(path.join(REPO, 'src/app/editor-theme.css'), 'utf8')).toContain('--selection-ring: var(--ui-selection-ring);');
    expect(fs.readFileSync(path.join(REPO, 'src/app/globals.css'), 'utf8')).toMatch(/@utility shadow-selection \{\s*box-shadow: var\(--selection-ring\);/);
  });
});
