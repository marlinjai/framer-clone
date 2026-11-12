// src/lib/sites/branchLabels.ts
//
// Names that the server writes and the editor recognises again. Dependency-free: both sides import it.

/**
 * What an "update from main" is called in a branch's history (the server announces it with this summary, the
 * editor adopts it as one undo step of this name). The editor knows the step by this name when it is undone.
 */
export const UPDATE_FROM_MAIN_LABEL = 'Brought in the changes from main';
