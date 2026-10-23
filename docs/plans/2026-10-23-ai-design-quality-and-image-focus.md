---
type: plan
status: completed
date: 2026-10-23
title: AI page generation, design quality, text over photos and subject-aware crops
summary: The page generator's system prompt carries a compact design brief distilled from the installed design skills; containers can carry a stock photo as a background under a scrim so text sits on photos; every placed stock photo is cropped around its subject by a cheap Haiku vision pass; images get intentional shapes through a new aspectRatio style key; and the properties panel gets an Image section to fix fit, focal point and photo backgrounds by hand.
tags: [framer-clone, ai, page-generation, images, unsplash, design, properties-panel]
projects: [framer-clone]
---

# AI page generation: design quality, text over photos, subject-aware crops

Owner request of 2026-10-23: images and text on top of images were not expressible (or not used
by the generated designs), the generator did not use the frontend design knowledge of the
installed Claude Code design skills, and images must always be cropped so the most relevant part
stays visible. Builds on [the page generation plan](ai-driven-page-generation.md) (phases 1 to 3
and the Unsplash stock photos of 2026-10-20). Written after the build, so it records what exists
and why.

## What the owner gets

- Generated pages follow a concrete design brief: layout variety (at least three layout families,
  never the same twice in a row, at most two image and text splits in a row), background colour
  zones, a hero that fits the first screen with at most four text elements, a type scale with a
  display ceiling and a tracking floor, a body measure of 65 to 75 characters, a spacing scale,
  contrast minimums, one accent colour, and a refuse list of generated-looking defaults (eyebrow
  labels, three equal icon cards, gradient text, decorative glass, one-sided card borders).
- Text over photos: a section, header or div can carry a stock photo as its background, with a
  scrim gradient on top so white text stays readable, and a dark fallback colour if no photo is
  found.
- Every stock photo (img or background) is cropped around its subject, not blindly centred.
- Image boxes get an intentional shape (aspectRatio or a px height), with varied ratios.
- In the editor, an Image section in the properties panel: for an image, Fit and a focal point
  picker (click or drag on a thumbnail, arrow keys, or numeric X / Y); for a container, the
  background image URL, Size, the focal point and the overlay strength.

## Decisions

1. **The design brief is compiled into the prompt, not loaded at run time.** The skills
   (impeccable's craft floor and polish, design-taste-frontend, frontend-design, minimalist-ui,
   high-end-visual-design, redesign-existing-projects, imagegen-frontend-web) are tens of thousands
   of words written for a coding agent with CSS files and web fonts. The generator only needs
   the rules it can act on in this editor's vocabulary, so `INSTRUCTIONS` in
   `src/lib/ai/pageGen/prompt.ts` restates them as style keys, px values and node patterns. It
   stays in the prompt-cached prefix (structure unchanged) and is capped at 1200 words by a test
   (`prompt.test.ts`), since a cached prefix is still paid on every request. The test also fails on
   any long dash in the prompt.
2. **System font stacks, no web fonts.** Neither the canvas nor the published page loads web
   fonts, so the "distinctive type pairing" rule became a serif display stack against a system
   sans body stack. Telling the model to pick a named web font would render as a fallback.
3. **Hero height in px, never viewport units.** The canvas renders breakpoints as div frames
   inside the editor window, so vh, svh and dvh would resolve against the editor, not the page.
4. **Photo backgrounds reuse `imageQuery` on containers** (`PHOTO_BACKGROUND_TAGS` = the
   properties panel's container tags). The model writes only the scrim into
   `style.backgroundImage` (no url()) plus a dark `backgroundColor`; the server appends the photo as
   the bottom layer, sets `backgroundSize: cover`, `backgroundRepeat: no-repeat` and the focal
   `backgroundPosition`. A responsive scrim keeps its per-breakpoint values, each getting the
   photo layer. Chosen over an absolutely positioned overlay child because it costs no extra
   nodes and keeps one editable layer list; the img-plus-overlay pattern is still taught for
   photos that are content and need alt text.
5. **Credits for background photos**: the same `data-credit-name`, `data-credit-url` and
   `data-credit-source-url` attributes as an image, but **no `title`**: a title on a section would
   show "Photo by ..." as a tooltip over every heading and button inside it. The dialog's credit
   list stays the attribution (the owner's decision of 2026-10-20 on visible credits is
   unchanged). In replace and insert context an images.unsplash.com url() layer is kept only with
   a complete, well-formed credit, otherwise the photo layer is dropped and the scrim kept, exactly
   parallel to an image's src. A brief-provided url() wins over a query.
6. **Subject-aware crops by a Haiku vision pass** (`src/lib/ai/pageGen/focalPoints.ts`): after
   the photos resolve, one batched request to Claude Haiku 5.5 (`AI_MODELS.HAIKU`, effort low,
   2,000 output tokens, `tool_choice: auto` because current models reject a forced tool) with a
   512px thumbnail of each placed photo passed by URL (Anthropic fetches images.unsplash.com;
   nothing is downloaded here), answering through a `report_focal_points` tool with a point per
   photo in percent. Bounded to the existing 12-photo cap and a 12 second timeout that also stops
   on a cancelled generation. Fail-soft everywhere (timeout, refusal, no tool call, malformed or
   out-of-range answers, API error): the affected photos are written as an explicit
   `50% 50%`, with a `[focal-points]` warning in the log; the generation never fails because of
   it. The pass is logged as its own AI call (`generate-page-focal:<workspace>`, its own request
   id and model) and counted in the usage stub, so the generation's log line keeps one model's
   tokens. Cost is a fraction of a cent per generation.
7. **Unsplash keeps delivering the whole photo** (`fit=max`). A server-side `fit=crop` would fix
   one aspect ratio, but boxes change shape per breakpoint; the focal position steers the CSS
   crop at every size instead. The "safe text side" idea was not built: the generator's model
   places text before the photos exist, so a side hint could only be reported, not used.
8. **`aspectRatio` is an editor style key** (`CSS_PROP_SET`). Both renderers pass styles as React
   style objects, so nothing else changed. The validator sets `height: auto` on an img that has an
   aspectRatio but no height of its own (the Image preset's fixed 160px would otherwise win) and
   reads the photo's orientation from the ratio. A background without a px shape is searched as
   landscape and sized as a 1200px-wide box (a 2400px photo).
9. **`maxStyleValueChars` rose from 400 to 700**, so a scrim plus a sized, signed Unsplash URL
   echoed back in replace or insert context is not dropped.
10. **The Image section** (`src/components/sidebars/right/sections/ImageSection.tsx`) is
    registered with three small edits (`sectionConfig.ts`, `RightSidebar.tsx`, `sections/index.ts`)
    for images and containers, using the panel's row layout. The focal point commits on pointer
    release, so a drag is one undo step. Changing a container's photo to a different picture
    removes a stock credit through a new model action, `ComponentModel.clearStockCredit()`. The
    parse and compose helpers for layers and positions are pure and shared
    (`src/lib/images/imageStyle.ts`).

## Tests

`prompt.test.ts` (rules present, word cap, no long dashes, deterministic), `validatePhotos.test.ts`
(schema, background requests, credit rules, aspect ratio), `stockBackgrounds.test.ts` (layering,
credits without title, focal and centred positions), `focalPoints.test.ts` (mocked client: request
shape, full, partial, malformed, refusal, no tool call, API error, timeout, cancel, cap),
`imageStyle.test.ts`, `ImageSection.test.tsx`, and a published-render case in
`stockPhotoRender.test.tsx`. The schema docs golden was regenerated and reviewed.

## Open

Nothing from this change. Phase 4's style references and screenshot feedback loop stay open on the
roadmap line of the page generation plan.
