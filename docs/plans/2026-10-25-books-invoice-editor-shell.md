---
type: plan
status: in-progress
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

4. **Glass, like the reference dashboard the owner sent** ("this nice glass morphism that is incorporated
   everywhere, which looks really beautiful and really clean"): frosted surfaces over a soft grey ground.

## Decided while building (say so if you disagree)

- **Glass is a set of shared utilities in `globals.css`** (`glass-ground`, `glass`, `glass-inset`, with dark
  variants), not one-off classes, so the rest of the app can adopt it later. The shared menus and dialogs
  take the same frosted fill through `GLASS_SURFACE` in `invoice/chrome.tsx`.
- **The top bar floats as a frosted pill** (inset from the edges, rounded) instead of the site editor's
  edge-to-edge bar: it is what makes the reference read as glass, and the canvas shows through under it.
- **Emphasis is near-black, not iris:** Issue, the pressed formatting buttons and the active segment use
  the foreground colour, as in the reference. Iris (the brand colour) stays for focus rings and the
  selection outline on a field being edited, so it always means "this is where you are".
- **Imported invoices keep a disabled Correct** in the More menu that says how to fix one, instead of
  hiding it, so the way forward stays findable.
- **The form view stacks each line on a phone** (title, then quantity × price · rate, the amount beside
  it, the actions below) instead of a table that scrolled the page sideways.

## Design

- **Top bar** (the TopBar pattern, as a floating frosted pill, see the decisions above):
  - Left: back chevron to the Books, the document's name ("Invoice" or "Invoice 62") and its status chip.
  - Right: a Page | Form switch (segmented, the `PaneTabs` look) where both exist, a save state ("Saved",
    "Saving…"), Preview or Download as an icon button with a tooltip, a More menu (Correct, Cancel), and the
    primary action **Issue** as the near-black button. Issue is disabled with a reason on hover and focus
    ("Choose a customer first", "Add at least one line first").
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
  - The formatting toolbar uses the active-tool look (near-black fill).
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

## Fresh critique (2026-10-25)

A second, independent Impeccable critique scored the redesign **25/40** (from 21). Fixed in this round:

- line menus are named as the invoice numbers its rows ("Line 2", "Text row 1"), not by their place in the
  list, so a screen reader says the same number the "Pos." column prints;
- the line action buttons are darker at rest (`foreground/60`, above 3:1);
- one name for the product action ("Product or service") on the page and in the Add menu;
- the product picker is a combobox with a listbox: the arrow keys move a highlight, Enter picks it;
- the formatting hint is 12px;
- an issued invoice without a stored recipient says so instead of showing an empty label;
- "Issued on" appears only with a date.

Set aside, with the reason:

- "the issued view still says draft": an artefact of the local stand-in, which prints every PDF as a draft;
  the real issued PDF is the stored one (proven on TEST-4 to TEST-6);
- near-black for the pressed Bold button and Issue: the owner's glass direction, decided above;
- the toolbar over the page while scrolling: the canvas has room to scroll the last line clear of it;
- the document data block, the logo band and the draft stamp: the template's own design, edited in the
  composer, not the editor's chrome;
- renaming the dialog's "Back" to "Cancel": next to issuing and cancelling invoices, "Cancel" would be read
  as cancelling the invoice;
- collapsing the always-open "Add line" form on a phone: adding lines is the main job of a draft there.

