---
type: readme
title: "BusBasis pages: held-out parity fixtures"
summary: "Real pages of basiscampberlin.de, frozen on 2026-11-02, with node trees lifted from them. Reference data for the primitive score. No product slice edits these files."
tags: [framer-clone, primitives, parity, busbasis]
projects: [framer-clone]
---

# BusBasis pages: held out

**Do not edit anything in this folder from a product slice.** These files are the reference for the
stop condition of the primitive stream (every BusBasis page passes, see
[the fleet plan](../../../../docs/plans/2026-11-01-agent-fleet.md)). A failure here is information
for the fleet's operator, never something to fix by changing a fixture. `pnpm score:primitives`
stops when a file does not match its hash in `manifest.json`.

A failing page closes when the product can express it. It does not close by editing a tree, the
frozen page, or the lift in `test/score/busbasis/lift.ts`.

## What is here

| File | What it is |
|---|---|
| `manifest.json` | Source address, capture time, answer status and fidelity per page, and the hash of every file |
| `busbasis.css` | The storefront's stylesheet, shared by every page |
| `pages/<page>.html` | The rendered page, frozen: no script, no address, placeholders for media |
| `pages/<page>.computed.json.gz` | The live page's computed styles at 1280, 768 and 375 pixels wide |
| `pages/<page>.tree.json.gz` | The node tree, lifted mechanically, generated: not hand-written |

Captured from `https://basiscampberlin.de` on 2026-11-02 with `dev-browser-auto`, headless, logged
out, first visit, only reading. `manifest.json` lists each page. The page list and what each page
needs beyond its markup is `test/score/busbasis/pages.ts`.

## What changed from the live page

- **Personal data removed, same length so the layout holds:** mail addresses, the street address, the
  first names of the team (text and `alt`).
- **Media:** images are flat colour SVGs of the same natural size, the video has no source, the map
  iframe is empty. Image content is not compared.
- **Text:** long dashes became hyphens, because this repository holds none.
- **Keyframes** carry the `u-` prefix a global name needs in the format, as an import would write it.
- **Removed:** script, hidden form fields (they carry server action ids), form actions, source sets.

`manifest.json` records under `fidelity` how many computed values of the live page the frozen page
reproduces, about 99.5 percent. It is not all of them. In the live capture the site's own scrollbar
took 10 pixels of the width, which Playwright's screenshots do not have, so widths and what follows
from them differ on most block elements. The masked text is also narrower than the real text.

## Refreshing

A new capture replaces the reference, so it is the operator's decision, in three steps from the
repository root on the Mac: `bash test/score/busbasis/capture.sh`, then
`pnpm exec tsx test/score/busbasis/freeze.ts`, then `pnpm exec tsx test/score/busbasis/rebuild.ts`.
The live site changes, so a refresh can move the score without the product changing.

The trees were lifted again on 2026-11-02 from the same capture, as an operator step: what
the original sets on `html` now lands as rules on `:root` on the page root, which the
format could not hold when the trees were first lifted, and the manifest records each
page's `<html lang>`. The frozen pages, the sheet and the captured styles did not change.

## Held out from whom

Hashes make an edit visible. They do not make it impossible: a worker could regenerate the manifest.
Real isolation is a path workers cannot write, which the orchestrator leaves to the operator
(`held_out_verify` in `~/.config/orchestrator/repos.toml`).
