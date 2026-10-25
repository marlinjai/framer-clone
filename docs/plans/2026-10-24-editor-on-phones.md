---
type: plan
status: completed
date: 2026-10-24
title: The editor on phones, a canvas-first layout with sheets, a compact top bar and touch gestures on the canvas
summary: Make the editor usable on a phone, in two parts built in parallel. Part A, the layout: below 768px wide (or a phone held sideways) the canvas fills the screen between a compact top bar and a docked bottom bar, Pages and Layers and the properties panel open as bottom sheets from that bar (same components, one at a time), the top bar keeps Save, Preview and Publish visible and moves every other action into an accessible More menu, dialogs and the preview fit 390px. Part B, canvas touch input: two fingers pan and pinch-zoom on the canvas only, one finger taps, moves the selection, draws the selection rectangle and double-taps to edit text, handles get finger-sized hit areas, the browser's page zoom is off inside the editor. The gesture model was specified by the owner on 2026-10-24.
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

The work has two parts that ship together: part A, the layout, and part B, touch input on the
canvas, built in parallel by two agents and merged on one branch. Neither edited the other's files
beyond what layout strictly needed.

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

## Part B: canvas touch input

Owner's report: "Touch controls on the phone don't yet work properly on the canvas." Owner's
specification (2026-10-24): "Two fingers should pan while pinch gestures should zoom, but only on
the canvas, not everywhere else on the sidebars and the whole rest of the interface."

### Gesture model (decided)

| Input | Where it starts | What it does |
| --- | --- | --- |
| Two fingers, moving together | canvas | pans the camera |
| Two fingers, spreading or closing | canvas | zooms around the midpoint between the fingers, at the same time as the pan, clamped to the zoom limits (10% to 500%), applied once per animation frame |
| A finger lifts mid-pinch | canvas | the camera stays exactly where it is; the remaining finger does nothing (no drag, no click) until it lifts; a finger landing again resumes the pinch from where the camera is |
| One finger, tap | element | selects it, as a click does |
| One finger, tap | empty canvas | clears the selection |
| One finger, drag | the selected element, or anything inside it | moves the selected element through the drag manager; below 8px of travel it stays a tap |
| One finger, drag | empty canvas, or an element that is not selected | draws the selection rectangle (the desktop marquee); on a phone the page fills the screen, so a stray drag selects instead of moving something |
| One finger, drag | a frame's title label | moves the frame (the label is an explicit drag handle) |
| One finger, any | with the Grab tool | pans (the Grab tool is an explicit choice to pan) |
| Double-tap | text element | enters inline text editing, focused within the tap so iOS opens the keyboard |
| Double-tap | empty canvas | zooms in one step (1.5x) around the tap |
| Long-press | anywhere on the canvas | nothing; the browser's callout and context menu are suppressed there |
| Second finger during a one-finger move | canvas | the move is cancelled and reverted, the rectangle is dropped, the pinch takes over |

A pen follows the touch model for gestures (it is a single pointer, so it never pinches) and keeps
the precise small handle targets. Apple Pencil hover is not used.

### Handles under a finger

Resize handles, corner radius dots and the padding, margin and gap handles keep their small
visible size but grow an invisible hit area of 44 by 44 css px while the last input was a finger
(`data-pointer="touch"` on the document root, seeded from the `(pointer: coarse)` media query).
They sit in layers above the canvas and claim their touch (`touch-action: none`), so they win over
any canvas gesture. Where a corner resize handle and the radius dot 10px inside it overlap, the
resize handle wins; radius dots appear only on selections at least 120px on a side under touch
(40px for a mouse). The resize and radius handles used to follow the mouse only, and a touch sends
its compatibility mouse events after the finger lifts, so they could not be dragged by a finger at
all; they now follow the pressing pointer. The spacing handles appear on hover with a mouse; a
finger has no hover, so under touch they show whenever something is selected.

Known consequence: on a small selected element, the grown hit areas of its handles cover much of
the element, so a finger moves it by its middle.

### Page zoom outside the canvas, and the accessibility trade-off

While the editor is mounted (the demo editor at `/` and `/projects/<id>`), the browser's page zoom
by pinch is off: `touch-action: pan-x pan-y` on the document root (one-finger scrolling in panels,
sheets and dialogs keeps working), Safari's `gesturestart` and `gesturechange` prevented, a
multi-finger `touchmove` outside the canvas prevented, and ctrl or cmd plus wheel (a trackpad
pinch) outside the canvas prevented. The canvas ground is `touch-action: none` and runs its own
gestures.

The trade-off: inside the editor a person cannot pinch to enlarge the editor chrome. The editor is
a design tool with its own zoom for the design (pinch on the canvas, the zoom buttons), its chrome
is sized for touch by the layout part, and keyboard zoom (Cmd or Ctrl plus) and the system text
size settings still work. Since 2026-10-25 the viewport meta tag carries `maximum-scale=1` while
the editor is mounted (see "Text editing on a real iPhone" below), restored on unmount; nothing of
this applies to published sites (`src/app/(site)`) or the projects list, which keep normal page zoom. iOS Safari
has ignored `user-scalable=no` for years, so the gesture events are the mechanism there; headless
Chromium cannot prove the iOS path, only the Chromium one.

### Also fixed on the way

Double-click to edit text never worked on a page with more than one breakpoint frame: every frame's
copy of the node became editable and took focus, the second focus blurred the first, and the blur
ended the edit. Only the copy in the frame where editing began becomes the text box now.

### Where it lives

- `src/lib/canvas/touchGestures.ts`: the pure math and bookkeeping (pinch around a midpoint, pan,
  tap and drag thresholds, double-tap timing, what happens when fingers lift), unit tested.
- `src/components/Canvas.tsx`: the touch branch of the canvas pointer handling; the mouse path is
  unchanged.
- `src/hooks/useEditorGestureGuard.ts`: the page zoom guard and the last-input flag, mounted once by
  `EditorApp`.
- `src/components/HudSurface.tsx`, `src/components/SpacingHandlesLayer.tsx`, `src/app/globals.css`:
  handles under a finger.
- `src/lib/drag/DragManager.ts`: an 8px threshold for a finger (4px for mouse and pen) and an
  optional capture target.
- Tests: `src/lib/canvas/__tests__/touchGestures.test.ts`,
  `src/components/__tests__/Canvas.touch.test.tsx`, `src/components/__tests__/HudSurface.touch.test.tsx`,
  `src/hooks/__tests__/useEditorGestureGuard.test.tsx`.

## Verification (part A, 2026-10-24)

`pnpm typecheck`, `pnpm lint`, `pnpm lint:guards`, `pnpm test` (301 files, 3829 tests, both parts merged) green.
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

## Text editing on a real iPhone (2026-10-25)

The owner, on his iPhone in Safari: "I can't change text with touch on mobile, it doesn't open the
keyboard." Double-tap to edit had only been verified in headless Chromium, where focus needs no
user gesture.

Causes found:

- The double-tap was recognised in `pointerup`, and the element only became `contentEditable` on
  React's re-render after it. iOS opens the on-screen keyboard only for a `focus()` made
  synchronously inside a `touchend` (or `click`) handler, on an element editable at that moment.
- A selected small text is covered by the 44px touch targets of the resize handles (a HUD element
  outside the canvas ground), so the second tap of a double-tap often hit a handle and never
  reached the text.

What changed (decided by the implementing session, say so if you disagree):

- The double-tap is recognised from touch events (`DoubleTapRecognizer` in `touchGestures.ts`,
  window listeners in `Canvas.tsx`) and acts inside `touchend`: the element turns editable and
  selectable, takes focus and gets its caret in the same call stack
  (`src/lib/canvas/inlineTextEdit.ts`), then the store is told, and React keeps the same DOM node.
  The handled `touchend` is cancelled, so no emulated click follows into the text. A contact
  without touch events (a pen on Windows) keeps the pointer path. The mouse double-click focuses
  synchronously the same way.
- A double-tap looks through handles to the canvas element under the finger, and the resize and
  corner handles are hidden while a text is edited, so taps that move the caret are not taken for
  a resize.
- Caret: a finger puts the caret where it tapped (the end when beside the text); the mouse
  double-click still selects the whole text.
- The edited text carries `user-select: text` against the ground's `select-none` (defensive: iOS
  reports say WebKit refuses a caret there; desktop WebKit accepted typing either way).
- `maximum-scale=1` on the viewport meta tag while the editor is mounted: iOS zooms the page in on
  focusing a field under 16px, and measures the font before the canvas zoom, so a 16px heading on
  a canvas at 34% is a 5px field to it (as is every 12px panel field). With page pinch already off
  in the editor the user could not even zoom back out.
- A press elsewhere on the canvas ends the edit and commits it (iOS keeps focus otherwise).
- While a text is edited on a phone the bottom bar is hidden, any sheet closes, and the camera pans
  the text into the area above the keyboard (`revealOffset` in `cameraControls.ts`, driven by
  `visualViewport` in `PhoneEditorChrome.tsx`); pans only, never zooms.
- A Text field at the top of the properties panel (`TextContentSection`) for every element that
  holds its own text, the path that works on a phone whatever the gestures do (a form field always
  opens the keyboard). It writes through `setTextContent` once per committed edit (blur or Enter;
  Escape reverts), so one edit is one undo step. Bound text shows the binding chip instead. It
  replaces the Data section's text input and the submit button's Label row, which wrote on every
  keystroke (one undo step per character).
- Text bound to data is no longer typed over on the canvas: the binding would overwrite it.

Verification: unit and component tests assert focus and `contentEditable` inside the `touchend`
dispatch, before any re-render. Playwright WebKit 26 with touch at 390x844 and headless Chromium
with CDP touches: the double-tap focuses the text inside `touchend`, typing and Enter commit to
every breakpoint copy, two undos revert two edits, the Text field in the Edit sheet edits the same
node. Neither can show the iOS keyboard itself; that needs the phone.

## Status

Completed 2026-10-24: both parts built in parallel and merged on one branch (the layout agent's
worktree branch, with the touch agent's branch merged in). One zoom-math source after the merge:
`src/lib/canvas/touchGestures.ts` (limits, clamping, zooming around a point), used by the canvas
pinch and wheel, the toolbar's zoom buttons and the phone layout's fit (`cameraControls.ts`).
