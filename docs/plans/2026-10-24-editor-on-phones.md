---
type: plan
status: in-progress
date: 2026-10-24
title: The editor on phones, a canvas-first layout with sheets, a compact top bar and touch gestures on the canvas
summary: Below 768px wide the editor shows the canvas between a compact top bar and a docked bottom bar; Pages and Layers and the properties panel open as bottom sheets (same components, a different container) from that bar, one at a time; the top bar keeps Save, Preview and Publish visible and moves every other action into an accessible More menu; dialogs, the preview toolbar and the projects list are checked at 390px. A second part, built in parallel by another agent, makes the canvas itself work by touch (two fingers pan and pinch zoom on the canvas only).
tags: [framer-clone, editor, mobile, responsive, accessibility, touch]
projects: [framer-clone]
---

# The editor on phones

## Why

The owner asked on 2026-10-24: "Is app.lumitra.co mobile responsive and usable from the phone?"
Measured on production at 390x844 (an iPhone 14 sized viewport): the projects list is fine, the
editor is not. The left sidebar (Pages and Layers) and the right properties panel (272px) are both
open and together cover the whole screen, so the canvas cannot be seen, and the top bar runs off
the right edge, so Generate, Polish, Save, Publish, Domains, Site settings, Form submissions,
Preview, undo, redo and history are cut off with no way to reach them (the page does not scroll
sideways).

The work has two parts that ship together: part A, the layout (this plan's builder), and part B,
touch gestures on the canvas (a parallel agent, files listed below). Neither edits the other's
files beyond what layout strictly needs.

## Part A: the phone layout

### Decisions

1. **Breakpoint: a phone is a viewport under 768px wide** (`(max-width: 767.98px)`, the same edge
   as Tailwind's `md`), **or a touch screen held sideways** (`(max-height: 500px) and (pointer:
   coarse)`, so a phone in landscape at 844x390 does not get two docked sidebars in 390px of
   height). One definition serves both CSS (a `phone:` Tailwind variant in `globals.css`) and
   JavaScript (`useIsPhone` in `src/hooks/use-mobile.ts`); a test keeps the two identical. Below
   it the editor uses the phone layout. From 768px up the docked desktop layout stays: at 768x1024 (tablet portrait)
   the two docked sidebars leave a narrow canvas, but both collapse to 48px strips with their own
   chevrons, which is the desktop behaviour a tablet user expects, and a tablet has room for a
   real sidebar.
2. **The top bar goes compact under 1024px** (`lg`), not only on phones: its full set of buttons
   needs about 1000px, so at 768 it overflowed too. Compact means: back link, project name
   (truncates, the page name is hidden; the Pages sheet and the Layers panel show it), then Save,
   Preview and Publish visible, and a **More** menu (the existing Radix dropdown, so arrow keys,
   Escape and focus return work) holding Generate, Polish, Domains, Site settings, Form
   submissions and History. Save and Publish stay visible because they are the actions with
   consequences the user checks for; Preview is how a phone user sees the real result. Undo and
   redo are already in the bottom bar on every size, so the compact top bar drops its duplicate
   pair; the history list (jump to any step) moves into the More menu as its own dialog.
3. **Save and Publish status in the compact bar** shows as a small notice under the top bar
   (fixed, full width minus 16px margins) instead of the inline text that has no room: a success
   message clears itself after 5 seconds, except Publish's with its "live at" link (something to
   tap), which stays like an error until dismissed. The Publish legal check
   notice already caps itself at the viewport width; it moves up to sit under the 48px phone bar.
4. **Canvas first.** On a phone the canvas fills the screen between a 48px top bar and a docked
   bottom bar (56px plus `env(safe-area-inset-bottom)`, so it clears the iPhone home indicator).
   The bottom bar replaces the floating tool and zoom bar on phones and fits 390px: Layers, Undo,
   Redo, Select, Hand, Fit (showing the zoom percentage; a tap fits every breakpoint frame on
   screen) and Properties. Zoom in and out buttons are dropped on phones, pinch zoom replaces them
   (part B). When the phone layout opens, and when the page changes, the camera fits the
   narrowest breakpoint frame (the phone frame in a default project) to the screen's width, top
   aligned, so the page is readable at once instead of showing a corner of the 1280px frame.
   The fit math lives in `src/lib/canvas/cameraControls.ts` as pure, tested functions
   (`computeFitTransform`, `zoomAroundPoint`), applied separately, so part B's double-tap zoom
   can reuse them.
5. **Panels as bottom sheets.** Pages and Layers (the left sidebar) and the properties panel (the
   right sidebar) render inside a bottom sheet on phones, the same `LeftSidebar` and `RightSidebar`
   components with a `variant="sheet"` that drops only the desktop container (fixed width, collapse
   chevron, resize handle). The sheet is a Radix dialog: `role="dialog"`, `aria-modal`, labelled
   by its visible title, focus moves into it and back to the button that opened it. It closes by
   its close button, Escape, a tap on the backdrop, or a swipe down on its grab handle. Only one
   sheet is open at a time (one state value, opening one replaces the other).
6. **Properties do not open by themselves on select.** Decided: selecting an element turns the
   bottom bar's Properties button into an **Edit** button (with the element's name as its
   accessible label), highlighted while the selection is new, instead of opening the sheet. "New"
   because opening a page selects its root element by itself: that selection, and any whose
   properties were already opened, does not light the button up. Reasons: an automatic sheet would cover the
   element just tapped, and with touch a tap that selects is often the start of a drag that moves
   the element (part B); a sheet popping up mid-gesture would hijack it. The properties sheet is
   at most 60% of the screen high over a light backdrop, so the top of the canvas stays visible
   and edits show live; the Layers sheet may use up to 85%. Tapping a layer in the Layers sheet
   selects it and leaves the sheet open (renaming, hiding and locking happen there too).
7. **The on-screen keyboard.** The sheet reads `window.visualViewport`: while the keyboard is up
   it sits on top of the keyboard (its bottom is lifted by the covered height) and its height is
   capped to the visible area (a pixel `max-height` over the svh height class), and a focused field scrolls itself into view inside the sheet's own
   scroll area. Heights use `svh` (the small viewport height, the house rule for full-viewport
   sections), never `vh` or `dvh`.
8. **Desktop state stays desktop.** The sheet variant never reads or writes
   `leftSidebarCollapsed`, `rightSidebarCollapsed` or the remembered sidebar width, and the width
   handle exists only in the docked variant, so nothing done on a phone leaks into the desktop
   layout. Before hydration the docked sidebars and floating toolbar are hidden by the `phone:`
   CSS variant, so a phone never flashes the desktop panels; after it, EditorApp mounts either the
   docked panels or the phone chrome, never both (two copies of the Layers panel would duplicate
   its listeners).
9. **Dialogs at 390px.** Every dialog already caps itself to the viewport (`dialog-fit.ts`: width
   100vw minus 2rem, height 100dvh minus 2rem, header and footer fixed, body scrolls). Each dialog
   reachable from the top bar is checked in the browser at 390x844: Generate, Polish, Site
   settings, Domains, Form submissions, history, Save as a new project, page settings, and the
   Publish legal notice; anything that overflows inside is fixed.
10. **Preview toolbar.** Under 768px its button labels collapse to icons (the labels stay as
    accessible names), the page select shrinks, and the width and height inputs are hidden (the
    breakpoint select stays, which is the useful control on a phone). On a window narrower than
    the widest breakpoint frame the preview opens on the widest frame that fits (the Mobile frame
    on a phone) instead of a 1280px desktop frame scrolled sideways; on desktop nothing changes.

11. **Adding components on a phone is a tap.** The Components list is drag only on desktop, and
    in the sheet there is no canvas to drop on. In the sheet a tap (or Enter or Space) adds the
    component, by the drop rules: inside the selection when it is a container, otherwise right
    after it, and at the end of the page with nothing selected (`src/lib/layers/tapInsertTarget.ts`).
    The new component is selected and the sheet closes so it is visible; one undo step.
12. **Touch screens have no hover.** Controls that only appeared on hover are shown on touch
    screens (`@media (hover: none)`): the page row's settings and delete buttons, and the action
    cluster (hide, lock, more) of the selected layer row.
13. **Dialog close buttons** get a 32px target on phones (same 16px icon).

### Files (as built)

- New: `src/components/PhoneEditorChrome.tsx` (bottom bar plus the two sheets),
  `src/components/ui/bottom-sheet.tsx`, `src/lib/canvas/cameraControls.ts` (camera math and the
  `useCameraControls` hook, shared with `Toolbar.tsx`), `src/components/TopBarStatus.tsx`,
  `src/hooks/useControllableOpen.ts`.
- `src/hooks/use-mobile.ts` rewritten (it was unused): `useMediaQuery`, `useIsPhone`,
  `PHONE_MEDIA_QUERY`; `src/app/globals.css` gains the `phone:` variant (block form: the short
  form with a comma-separated media list compiles to broken rules in Tailwind 4).
- `EditorApp.tsx` (switch, and one notice stack under the top bar for the editor notice and the
  legal template notice, instead of two fixed boxes with hard-coded offsets that overlapped on
  narrow screens), `TopBar.tsx` (compact bar, More menu, one instance of each dialog, history
  dialog), `Toolbar.tsx` (camera code moved out).
- `LeftSidebar.tsx`, `RightSidebar.tsx`, `right/RightSidebarHeader.tsx` (`variant="sheet"`).
- `SaveButton.tsx`, `PublishButton.tsx` (status as `TopBarStatus`, Save icon-only under 640px),
  the Generate, Polish, Domains, Site settings and Form submissions buttons (controllable open
  state and a trigger class), `EditorNotice.tsx`, `site/LegalTemplateNotice.tsx`,
  `preview/PreviewToolbar.tsx`, `ui/dialog.tsx`, `left/PagesPanel.tsx`, `left/LayersPanel.tsx`.

### Tests

Unit and component tests: the media query hook with `matchMedia` mocked (initial value, change
events, server render), the sheet (opens, closes by button, Escape and backdrop, one at a time,
selection shows Edit and does not open the sheet), the More menu (every action reachable and
opens its dialog), and that the sheet variants do not touch the desktop collapse state. Browser
check with touch emulation at 390x844 and 768x1024, screenshots: editor default, Layers sheet,
Properties sheet after selecting, More menu, Generate dialog, Site settings, preview.

## Part B: touch on the canvas (parallel agent)

Built by a separate agent in `src/components/Canvas.tsx`, `HudSurface`, `SpacingHandlesLayer` and
the `DragManager`; this plan only records the spec so both halves are reviewed as one change.

The gesture spec, as the owner set it on 2026-10-24:

- Two fingers pan and pinch zooms, **on the canvas only**.
- One finger selects, moves selected elements, and on empty canvas draws the selection rectangle.
- A pinch anywhere else in the editor (sidebars, sheets, top bar, bottom bar) never zooms the
  page. Part B owns this (touch-action on the editor shell and canvas, gesturestart and touchmove
  prevention, and any viewport meta change such as `viewport-fit=cover`, which the bottom bar's
  `env(safe-area-inset-bottom)` padding benefits from). Part A adds no touch-action and leaves the
  viewport meta alone; panels and sheets scroll normally with one finger.

## Verification (part A, 2026-10-24)

`pnpm typecheck`, `pnpm lint`, `pnpm lint:guards`, `pnpm test` (295 files, 3774 tests) green.
New tests: `src/hooks/__tests__/use-mobile.test.tsx` (hook with matchMedia mocked, the CSS
variant using the same queries), `src/lib/canvas/__tests__/cameraControls.test.ts`,
`src/components/__tests__/PhoneEditorChrome.test.tsx` (sheets open modal and labelled, close by
button, Escape without clearing the selection, backdrop and swipe; one at a time; Edit cue;
desktop state untouched), `TopBarMoreMenu.test.tsx` (every action reachable, same dialog
instance), `TopBarStatus.test.tsx`, `ui/__tests__/bottomSheet.test.tsx` (keyboard inset).

In the headless automation Chrome with touch emulation (CDP touch events): at 390x844 the page
does not scroll sideways, the top bar is 48px with nothing past the right edge, the canvas opens
fitted to the phone frame, the bottom bar shows all seven buttons; Layers opens a 717px sheet
(focus on its close button, Escape and a swipe down close it); tapping an element highlights
"Edit Main" without opening anything, and Edit opens the properties sheet over the lower 60%;
a tap on the backdrop closes it; the More menu lists all six actions and each opens its dialog at
358px wide (16px margins) with nothing overflowing: Generate, Polish, Domains, Site settings,
Form submissions, History, plus Page settings and Save as a new project; the Publish error on the
demo shows as a notice under the bar. The preview opened from the editor shows a compact toolbar
(Editor, Reload, Fullscreen, page, breakpoint, nothing past the edge) and the Mobile frame. At 844x390 (landscape phone) the phone layout applies.
At 768x1024 and 1024x768 the docked layout stays with no overflow (768 uses the compact top bar,
1024 the full one). The preview's "Nothing to preview" state fits 390px. Not verifiable headless:
the on-screen keyboard itself (covered by the unit test of the visualViewport handling).

## Status

Part A built 2026-10-24 (branch of the phone layout agent). Part B (touch on the canvas) is built
in parallel; when it lands, this plan is marked completed and the roadmap line ticked.
