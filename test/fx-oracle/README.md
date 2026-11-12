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
