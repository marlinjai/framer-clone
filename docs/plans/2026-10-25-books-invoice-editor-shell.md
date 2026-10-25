---
type: plan
status: decided
date: 2026-10-25
title: "Books: the invoice editor in the app's editor shell"
summary: "Redesign the invoice editor (the draft written on its PDF page, the form, the issued view) so it meets the app's design bar: the site editor's shell (fixed top bar with a brand primary action, a floating bottom toolbar, a full-bleed canvas), no placeholders on the invoice (an Add-to-page menu instead), the app's tokens and shared components everywhere, a designed issue moment, and the same palette and menu fixes in the template composer."
tags: [framer-clone, books, invoices, editor, design]
projects: [framer-clone]
---

# Books: the invoice editor in the app's editor shell

## Why

The owner, 2026-10-25, after the WYSIWYG invoice editor plan
(`2026-10-23-books-wysiwyg-invoice-editor.md`) was completed: "The rest of the app looks so professional
and so good, and this looks really rudimentary." An Impeccable critique (two independent assessments,
snapshot in `.impeccable/critique/`) scored the editor 21/40. The idea is right (writing on the real
page); everything around it is a document page with raw Tailwind colours. Its three P1 issues: not in the
editor shell, an off-system palette, and indistinguishable "+" markers. Its P2 issues: the issue moment
and hand-made menus. Its P3 issue: an instruction paragraph and tiny hint text.

## Decided by the owner (2026-10-25)

1. **Full editor shell**, like the site editor (`src/components/TopBar.tsx`, `Toolbar.tsx`): not a restyle
   of the document page.
2. **No placeholders on the invoice:** empty optional parts (subject, intro, reference, closing text) are
   added from an "Add to page" menu. The page shows exactly what the client gets.
3. **Everything in this round, the template composer's shared palette and menu problems included.**

## Design

- **Top bar** (the TopBar pattern: fixed, `h-16`, `border-b`, `bg-background`):
  - Left: back chevron to the Books, the document's name ("Invoice" or "Invoice 62") and its status chip.
  - Right: a Page | Form switch (segmented, the `PaneTabs` look) where both exist, a save state ("Saved",
    "Saving…"), Preview or Download as an icon button with a tooltip, a More menu (Correct, Cancel), and the
    primary action **Issue** as the brand button. Issue is disabled with a reason on hover and focus
    ("Add a customer and at least one line").
- **Canvas:** full width under the bar on the muted ground, the A4 page centred with the toolbar's elevation.
  Fields show a brand ring on hover and focus (the HudSurface selection). Nothing else is drawn on the page
  except the lines' action buttons, which appear on row hover or focus, and the address window's "Choose a
  customer" while none is chosen.
- **Floating bottom toolbar** (the `Toolbar.tsx` pill):
  - undo and redo;
  - Add (a menu: line, product, then the empty optional parts that the template prints);
  - zoom out, the percentage, zoom in, fit width.
  Each button has a tooltip with its shortcut, shown on hover and on keyboard focus.
- **Menus:**
  - The line menu is the shared dropdown menu with groups (Arrange, Details, a VAT submenu as a radio group,
    then Remove in destructive red after a separator).
  - The product picker uses tokens, lists products at once, and its empty state links to the Products tab.
  - The formatting toolbar uses the active-tool look (brand fill).
- **Editors and messages:** tokens only (`background`, `popover`, `border`, `brand`, `destructive`,
  `muted-foreground`), so dark mode follows. The keyboard hint sits in the formatting toolbar. Errors appear
  as destructive chips under the field.
- **Issue moment:** the shared AlertDialog with a summary (recipient, number, date, total, what issuing
  means). After issuing, a success state shows the number and offers Download PDF, New invoice and Back to
  documents. Books has no sending or "mark as sent" yet, so neither is shown.
- **Banners** (errors, notices, the correction notice, a recalculated draft) appear under the bar, centred
  over the canvas, in tokens.
- **Form view and issued view** live in the same shell. The form keeps its fields, in a centred column on the
  ground; the issued view shows the stored PDF on the canvas.
- **Template composer:** its raw `gray`, `blue` and `amber` classes become tokens, and its selects and
  banners use the shared look.

## Not in this round

Sending invoices by email and "mark as sent" or "paid" (no backend yet). The app-wide font: the root layout
defines Geist but never applies it, so every page, the site editor included, renders in the system font.
That is an app-wide decision, recorded here and not changed by this plan.

## Test strategy

The invoice page tests cover the four stateful-flow paths for the new controls:
- forward: Add-to-page opens the slot's editor; Issue opens the dialog and lands on the success state;
- backtrack: Escape and Back close without effect;
- resume: the reload recovery still reopens the editor;
- re-entry: the issued view and the form view keep the shell.

Then a Chrome check at desktop and phone widths, and a fresh Impeccable critique against 21/40.
