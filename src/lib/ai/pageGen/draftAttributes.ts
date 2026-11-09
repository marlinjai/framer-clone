// src/lib/ai/pageGen/draftAttributes.ts
//
// The attributes the draft of a running generation carries on the canvas
// (src/components/ai/PageGenDraftLayer.tsx), in their own module so code outside
// React (src/lib/projects/liveSync.ts) can find the draft in the page without
// loading the layer.

/** Marks a drawn draft section (its index); the wrapper has no box of its own. */
export const DRAFT_SECTION_ATTR = 'data-pagegen-draft-section';
/** Marks a draft frame of a new page. */
export const DRAFT_FRAME_ATTR = 'data-pagegen-draft-frame';
/** Marks the band of the section still being written. */
export const DRAFT_BAND_ATTR = 'data-pagegen-draft-band';
/** Marks a skeleton of the run's outline (its slot). */
export const DRAFT_SKELETON_ATTR = 'data-pagegen-draft-skeleton';
