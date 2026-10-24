---
type: plan
status: in-progress
date: 2026-10-24
title: The editor on phones, layout and canvas touch input
summary: Make the editor usable on a phone. Two parts worked in parallel, the phone layout (top bar, sidebars as bottom sheets, toolbar sizing) and canvas touch input (two fingers pan and pinch-zoom on the canvas only, one finger taps, moves the selection, draws the selection rectangle and double-taps to edit text, handles get finger-sized hit areas, the browser's page zoom is off inside the editor). The gesture model was specified by the owner on 2026-10-24.
tags: [framer-clone, editor, mobile, touch, accessibility]
projects: [framer-clone]
---

# The editor on phones

## Canvas touch input

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
size settings still work. The viewport meta tag is unchanged and nothing of this applies to
published sites (`src/app/(site)`) or the projects list, which keep normal page zoom. iOS Safari
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
