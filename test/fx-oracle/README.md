# The FX pixel oracle's reference

`lumitra-web-fx-8a77254.tar.gz` is the source of Lumitra FX as lumitra-web runs it: `packages/fx/src` of the
lumitra-web repository at commit `8a77254ee5d66f2c8b7e4005933290c6c0796393` (package `@lumitra-web/fx` 0.4.0), the
commit the engine in `src/lib/fx` was copied from.

- Made with `git archive --format=tar 8a77254ee5d66f2c8b7e4005933290c6c0796393 packages/fx/src | gzip -n -9`.
- SHA-256: `e04a4967341b20559443ca5fc21e0e3b6661278958e8b157a97b7c0a3c97242d` (checked by the test before use).
- Read only by `test/behaviour/fxOracle.spec.ts`, which unpacks it into a temporary directory, bundles it and draws
  the same scenes through it and through this app's published page, then compares the pixels
  (plan `docs/plans/2026-11-08-lumitra-fx-in-sites.md`, slice F4).

It is an archive and not a folder of source on purpose: as loose `.ts` files the frozen copy would be typechecked,
linted and searched as if it were this app's code. Never edit it. It can be deleted, with the test, once lumitra.co
itself runs on Lumitra Sites and lumitra-web is retired (steps R3 and R5 of the plan).

## The particle ring's reference

`suite-theme-lumitra-light-2105604.js.gz` is Lumitra's brand light, the `<lumitra-light>` web component of
`@marlinjai/suite-theme-core`: `light/lumitra-light.js` of the `marlinjai/suite-theme` repository at commit `2105604`
(it includes the `highp` fix `83b41a1`), unchanged.

- Made with `git show 2105604:light/lumitra-light.js | gzip -n -9`.
- SHA-256 of the archive: `12d21c5b37e747aed787f3d7b5f380a8ca0e02584f87fc097456515dfc78b13b`; of the file inside it:
  `babca5425511d1c8a3eebc240cd24f8ee5f48e68de20307ab7fd9b80f419545b` (both checked by the test before use).
- Read only by `test/behaviour/fxRingOracle.spec.ts`, which draws it on a blank page and the `lumitra-light` preset
  through this app's published page, then compares the pixels (plan `docs/plans/2026-11-08-lumitra-fx-in-sites.md`,
  addendum "the particle ring as a built-in FX layer").

The component draws from `Math.random` and from the clock, so its frame is not repeatable as shipped. The test
makes it repeatable from outside, without changing the file: `Math.random` is replaced, just before the component
loads, by the same seeded generator the layer uses (`mulberry32`, seed 1), and the clock is stopped
(`performance.now` and the time each animation frame is given are both 0). The component also leans toward the
pointer under reduced motion, so a listener on the window stops pointer events before they reach it, and the test
prints how many it stopped. It can be deleted with the test if the
ring's reference ever moves into this repository.
<!-- ci-replay touch -->
