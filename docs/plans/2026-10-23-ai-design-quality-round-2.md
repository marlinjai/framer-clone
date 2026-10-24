---
type: plan
status: in-progress
date: 2026-10-23
title: AI page generation round 2, no vibe-coded tells, real web fonts, a visual review pass
summary: Generated pages must not read as vibe-coded. The generator's instructions and a deterministic screen reject the eighteen tells from the owner's reference post, a curated self-hosted font library replaces system font stacks, and a vision review pass fixes clipped, overlapping and low-contrast layout that the one-shot generation cannot see.
tags: [framer-clone, ai, page-generation, design, fonts, gdpr]
projects: [framer-clone]
---

# AI page generation round 2

## Why

The owner (2026-10-23): generated pages, Spoke & Chain in particular, "look super basic" and not
like the output of the frontend-design skill. A regeneration with the round-1 brief (Opus, saved
as the page "Spoke & Chain (redesign test)") is already much better, but still shows:

- broken layout the model never saw: a hero headline wrapping badly over a busy photo, a stats
  row clipped, a card colliding with its call to action;
- system font stacks only (round 1 decided "no web fonts are loaded"), which flattens every page;
- one of the reference tells: a bento grid for "how it works".

Reference: the owner's Instagram post (nataindata, 2026-10-20, "How I can see your design was
vibe-coded"). Its eighteen tells, all of which generated pages must avoid:

1. Lucide icons (the default icon set everywhere)
2. Emojis in headings, labels and lists
3. Liquid glass (frosted translucent cards, backdrop blur as decoration)
4. Em dashes in copy
5. Inter, Geist or Space Grotesk as the typeface
6. Three feature cards in a row (icon, heading, text)
7. and 8. Bento grids
9. Terminal windows as decoration
10. "It's not X, it's Y" copy (including strike-through "not a to-do list" headlines)
11. No real demos (gradient placeholders where a product screenshot or real photo belongs)
12. Purple and black palettes (violet accents on near-black)
13. Radial orbs (blurred colour blobs as backgrounds)
14. Dot grids as backgrounds
15. Sparkle icons (the "AI" four-point star)
16. Animated arrows on every button ("Get started ->")
17. Hover animations on everything (lift, glow, scale on every card)
18. Rainbow colouring (multi-colour gradient text or rainbow card sets)

## Decisions

1. **Instructions:** the eighteen tells become an explicit "never" list in the system prompt,
   each paired with what to do instead, written in this editor's vocabulary.
2. **Screening:** a deterministic checker runs on every generated tree before it is applied. It
   auto-fixes what is mechanical and safe (em and en dashes in copy, emojis, banned font
   families), and anything structural or stylistic it cannot fix safely (three equal cards in a
   row, bento grids, purple-on-black, radial-gradient orbs, dot-grid backgrounds, rainbow
   gradients, backdrop-filter glass, terminal mock-ups, "not X, it's Y" copy, arrow glyphs on
   every button) goes into the existing repair round with precise findings. The result reports
   what was fixed. The same checker is exported for reuse (the visual review pass and tests).
3. **Fonts:** a curated library of distinctive, openly licensed variable fonts, self-hosted from
   the app's own origin (no requests to Google: a known GDPR problem in Germany since LG
   Muenchen 2022). Inter, Geist and Space Grotesk are deliberately absent. Only the families a
   page uses are loaded, in the editor canvas, the preview and the published page. The
   Typography font picker offers them; the generator chooses from them as display and body pairs.
4. **Visual review:** after a generation is applied, the editor renders the result, measures
   layout problems in the DOM (text clipped by its box, children overflowing their parents,
   overlapping siblings, horizontal scroll on Phone, low text contrast over images), captures the
   Desktop and Phone frames as images, and sends both plus the findings and the tree to a review
   endpoint. A vision model returns targeted style and copy fixes applied as one undo step. The
   same pass is available on demand as "Polish with AI". Bounded: one round automatically, cost
   shown, fails soft (the page stays as generated, the failure is visible).
