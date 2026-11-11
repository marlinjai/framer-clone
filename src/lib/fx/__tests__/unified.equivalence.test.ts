/**
 * U1 zero-regression oracle.
 *
 * The FX render is a pure function of `SceneConfig`, so structural equality of
 * the config is a sound proxy for pixel-identity of the rendered scene. This
 * spec asserts that the U1 boundary adapter (`sceneConfigFromUnified`, via
 * scene-core's migration) produces a `SceneConfig` deep-equal to FX's existing
 * flat loader (`deserializeScene`) for the real hero fixtures.
 *
 *   deepEqual( deserializeScene(json), sceneConfigFromUnified(json) )
 *
 * If the two match (same layers, params, order, ids, canvas), the adapter is a
 * structurally-lossless bridge: the operator's later visual review backstops
 * the remaining pixel-true confirmation.
 *
 * Dependency-light by design: it imports the pure loaders plus the builtin
 * registry (for layer defaults). It never mounts a component or touches
 * R3F/WebGL. `import "../builtins"` populates FX's render registry.
 *
 * The fixtures are lumitra-web's own scenes (`src/scenes/v7.json` and
 * `demo-phase-2.json` at commit 8a77254), copied unchanged.
 */

import { describe, expect, it } from "vitest";

import "../builtins";
import { deserializeScene } from "../serialize";
import { sceneConfigFromUnified } from "../unified";

import v7Json from "./fixtures/v7.json";
import demoPhase2Json from "./fixtures/demo-phase-2.json";

describe("sceneConfigFromUnified: zero-regression equivalence", () => {
  it("v7 hero matches the FX flat loader byte-for-byte", () => {
    const flat = deserializeScene(v7Json);
    const unified = sceneConfigFromUnified(v7Json);
    expect(unified).toEqual(flat);
  });

  it("preserves the god-rays sourceLayerId binding to text-lockup", () => {
    // The post-effect binds to its source layer by id; if the adapter ever
    // rewrote ids, this binding would silently break. Assert the id survives.
    const unified = sceneConfigFromUnified(v7Json);
    const godRays = unified.layers.find((l) => l.type === "godRays");
    const lockup = unified.layers.find((l) => l.id === "text-lockup");
    expect(lockup).toBeDefined();
    expect(godRays?.params.sourceLayerId).toMatchObject({
      value: "text-lockup",
    });
  });

  it("demo phase 2 matches the FX flat loader byte-for-byte", () => {
    const flat = deserializeScene(demoPhase2Json);
    const unified = sceneConfigFromUnified(demoPhase2Json);
    expect(unified).toEqual(flat);
  });
});
