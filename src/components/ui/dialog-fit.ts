// src/components/ui/dialog-fit.ts

/**
 * Every modal dialog fits the viewport, however small the window: the panel is
 * at most the viewport's height and width minus a 1rem margin on each side
 * (dynamic viewport units, so mobile browser bars are accounted for) and lays
 * its parts out as a column. DialogHeader and DialogFooter never shrink, so the
 * title and the action buttons stay on screen; the part between them goes in
 * DialogBody, which takes the remaining height and scrolls. Content that does
 * not use DialogBody still stays reachable, because the panel itself scrolls
 * as a fallback. Shared by dialog.tsx and alert-dialog.tsx.
 */
export const DIALOG_VIEWPORT_FIT_CLASSES =
  "flex flex-col w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto"
