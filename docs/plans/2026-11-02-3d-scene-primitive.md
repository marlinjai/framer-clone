---
type: plan
status: decided
date: 2026-11-02
title: "A 3D scene primitive: declarative three.js scenes that a person without code can build"
summary: "A `scene` node (a div marked `data-scene` with `props.scene`, like the map embed) describes a 3D scene as data: models from the site's model library, material roles and curated presets, an environment preset, camera keyframes, and a timeline driven by scroll progress, time or page state. The server renders a required poster and the node's children; a lazy island loads three.js only when a scene is on the page and WebGL works. Models live in Storage Brain on Cloudflare R2 behind a content-addressed route, validated and re-encoded at upload. Eleven slices, about 34 to 47 agent days. The forcing case is the hand-built Grothe truck wash hero, measured side by side against the same scene as a sandboxed custom code block: not buildable under the sandbox contract Marlin accepted, buildable with stated losses under the widening the custom code plan proposes."
tags: [framer-clone, primitives, 3d, three-js, webgl, gltf, scroll, storage, custom-code]
projects: [framer-clone]
---

# A 3D scene primitive

## The question

The truck wash site at grothe.lumitra.co has a 3D hero: a truck rolls through a wash hall as the visitor
scrolls, gets foamed, brushed, rinsed and comes out shining, and the visitor can swap the vehicle. It was built
by hand in about 1,600 lines of HTML and JavaScript on three.js (the standard JavaScript library for drawing 3D
with WebGL, the browser's graphics interface). framer-clone cannot express any of it today: there is no canvas
primitive, the render gate in `src/lib/renderer/blockedNodes.ts` refuses `script`, and the planned sandboxed
custom code block (step 6 of the [complete primitives plan](2026-11-01-complete-primitives.md), designed in the
[behaviour model plan](2026-11-02-behaviour-model.md)) has no network and a 256 kilobyte limit per block.

This plan defines a dedicated primitive so that pages like that hero can be built in the editor without code,
and says precisely what it will not cover, so the custom code block remains the route for the rest.

## The short answer

- **A `scene` is data, never code.** A node stores a declarative scene description: which models (by content
  hash from the site's model library), which material roles and curated presets, which environment, which camera
  keyframes, and which timeline drives them. The runtime that draws it is one constant module of ours.
- **Curated presets carry the craft, free parameters stay few.** "Wash bay foam" is a preset with three or four
  knobs, not a particle system an author assembles.
- **It costs nothing where it is absent.** A page without a scene loads no byte of three.js, proven over the
  network as the behaviour plan proves its runtime.
- **Every visitor gets the page.** A poster image is required; without WebGL, under reduced motion, on a failed
  load, the page reads correctly.
- **Models need real storage.** Postgres is capped at 2 megabytes per image by design; models go to Storage
  Brain (the suite's file service on Cloudflare R2, Cloudflare's object storage) behind a content-addressed,
  immutable route on the site's own host.

## The forcing case: what the Grothe scene does

Read from the client repository on 2026-11-02 (`site/scene.js`, `site/astra-effects.js`, `site/main.js`,
`site/index.html` and the client's 3D rebuild plan). Only the technique is recorded here; no client model, image
or copy enters this repository.

### Files and sizes, measured

| Part | Raw | Gzipped |
|---|---|---|
| three.js core (`three.module.min.js`) | 687 KB | 170 KB |
| `GLTFLoader` (reads glTF, the standard 3D model format, and GLB, its single binary file form) | 110 KB | 24 KB |
| `DRACOLoader` plus Draco decoder (Draco is Google's mesh compression; the decoder is WebAssembly) | 264 KB | 79 KB |
| `RoomEnvironment`, `RoundedBoxGeometry`, `BufferGeometryUtils` | 40 KB | 9 KB |
| GSAP core (the GreenSock animation library), only for the load-time intro | 72 KB | 28 KB |
| The scene's own code (`scene.js`, `astra-effects.js`) | 50 KB | 16 KB |
| Truck model (38 meshes, 14 materials, about 108,000 triangles, Draco compressed, clearcoat material extension) | 534 KB | |
| Bus, van, motorhome models (about 21,000 to 25,000 triangles each) | 117 to 127 KB each | |
| Brush model (Draco, three WebP textures) | 233 KB | |
| Dirt masks, one greyscale WebP per vehicle, only the red channel read | 46 to 96 KB each | |
| Camera-flight video (generated, shown elsewhere on the page, loaded on press) | 626 KB | |

Code before any model: about 300 KB gzipped. First view on a phone: that plus one vehicle and its mask, about
1 MB. The client plan's budget for the whole scene is about 8 MB and 60 frames per second (FPS) on a real phone;
60 FPS was measured on a desktop with a four times throttled processor, never on a physical phone.

### What it draws

- **Models and loaders.** Four vehicles as GLB with Draco compression, the decoder path set and preloaded, a
  30 second timeout per model, a cache per vehicle, a retry button and a visible status line on failure. The
  model carries roles in glTF node extras: `astraPaint` on paint meshes, `astraWheel` on wheel pivots, and glass
  is found by material name. If a model fails, a procedural blocky vehicle of the same type stands in with a
  notice.
- **Hall.** Built in code: floor with a canvas-drawn texture, lane lines, back wall with ribs, roof with
  emissive light strips, striped portal posts, three gantry arches with pipes, three brushes (two vertical, one
  horizontal) whose procedural mesh is upgraded to the brush model once idle.
- **Materials.** Physically based rendering (PBR, materials described by colour, roughness and metalness) with
  clearcoat. A wash material patches three.js's standard shader: a dirt mask darkens the paint (never the glass)
  until the brushes pass, a noise-driven foam film whitens and roughens the body between the foam arch and the
  rinse, and clearcoat rises with wetness and shine. All driven by one uniform, the vehicle's position in the hall.
- **Lights and environment.** Hemisphere light, a key directional light, a warm daylight that comes up at the
  exit, a point light that sweeps along the paint at the end, an image-based environment from `RoomEnvironment`,
  ACES (Academy Color Encoding System) filmic tone mapping (a film-like curve for bright values), fog, and a background that blends from the
  dark hall to the brighter exit.
- **Effects.** Foam: about 260 to 380 clusters of five instanced bubbles sampled on the real mesh surface by ray
  casts, sliding down under a simple gravity model, partly detaching under the brushes, rinsed away; a seeded
  random sequence makes every visit identical. Falling foam from the arch (150 to 240 instances), rinse water jets
  (160 to 260), osmosis mist (160 to 260 points). Brushes hug the vehicle profile, measured by dropping rays from
  above, spin fast while it passes and retract after. Wheels roll with distance travelled.
- **Camera.** A three-quarter front view that follows the vehicle with damping, pulls back at the end, frames
  every vehicle the same by computing distance from the screen width on a phone, and on a phone slides the
  picture into the free band above the copy panels with a view offset instead of stretching it.
- **Triggers.** The scene sits on a sticky stage behind one section. Scroll progress through that section maps
  to the vehicle's position. The keyframes are not fixed numbers: each copy panel on the page (`data-station`)
  becomes a keyframe at the scroll position where that panel is centred, so copy and scene always line up at any
  screen size. The panel nearest the middle is fully opaque, the others dimmed. Page state drives the model: the
  vehicle picker swaps the model, keeps the current one until the next has arrived, remembers the choice, and
  preloads a model on hover or focus of its button. A load-time intro (lights up, vehicle rolls in over 1.1
  seconds) runs only for a visitor still at the top.
- **Performance.** Renders only while the section is in view and something moves; device pixel ratio capped at
  1.35 on phones and 1.75 elsewhere; fewer particles on phones; shaders compiled asynchronously before the first
  frame; foam and brush models built when the browser is idle; the model, mask, decoder and modules requested from
  an inline head script before any other script runs; a skeleton drawing of the vehicle with real download
  progress while it loads.
- **Fallbacks.** No WebGL: the page never loads the scene and shows its content. Reduced motion ("calm"): one
  static frame at the final position, no foam, no spin, rendered on demand, and the intro skipped. A failed start
  removes the 3D classes and the page reads as without WebGL. The canvas is `aria-hidden`; every fact is in the
  page's own text.
- **No poster image for the 3D stage.** The fallback is the page's own layout. This plan makes a poster required,
  which is better than the forcing case.

## The node

### Why a marked `div` and not a new tag

The [map embed](../../src/lib/mapEmbed/mapEmbed.ts) set the precedent on 2026-11-02: a dedicated primitive is an
ordinary `div` with a marker attribute and props the renderers read, never a stored `iframe`. The scene follows it.
The render gate stays untouched: the node stores no `canvas`, no `script` and no address. (The proposed HTML
`model` element is in `BLOCKED_TAGS` and stays there; it is a single-vendor experiment.)

```json
{
  "type": "div",
  "props": {
    "data-scene": "three",
    "scene": { "...": "the description below" },
    "style": { "position": "sticky", "top": "0", "height": "100svh" }
  },
  "children": [ "the fallback content: ordinary nodes, shown until the scene is ready and whenever it is not" ]
}
```

The box is sized and styled through the normal sections, so sticky staging behind a section is ordinary layout.
The server renders the box, the poster as an `img` and the node's children; a client island creates the `canvas`
inside the box. `scene` is denied as a Document Object Model (DOM) prop, as `effects` and `behaviour` are.

### The stored description

```ts
/** props.scene. Parsed by parseScene in src/lib/scene/format.ts, the one trust boundary. */
/** The sha256 of a site image, served as /site-images/<sha256>.<ext> on the site's hosts. */
type ImageRef = string;
type Vec3 = [number, number, number];

interface StoredScene {
  version: 1;
  poster: ImageRef;                 // required: a site image, the fallback and the editor's default view
  title?: string;                   // set only when the scene is content; otherwise the canvas is decorative
  models: SceneModel[];             // at most 8
  variants?: { id: string; label: string; model: string }[]; // swappable models, e.g. vehicle types
  roles?: Record<string, RoleBinding>; // per model: which parts are paint, glass, wheels
  environment: EnvironmentPreset;   // 'studio' | 'hall' | 'overcast' | 'sunset' | 'night', plus exposure
  lights?: LightPreset;             // 'three-point' | 'top' | 'rim' | 'none'; the environment lights by default
  background?: { color: string } | { transparent: true } | { fade: [string, string] };
  camera: CameraTrack;
  timeline: Timeline;
  effects?: EffectInstance[];       // curated presets only, at most 6
  quality?: 'auto' | 'low' | 'medium' | 'high'; // pin a tier; 'auto' by default
  calm?: { at: number } | 'poster'; // reduced motion: a still frame at this progress, or the poster
  intro?: 'none' | 'drive-in' | 'lights-up'; // load-time choreography, 'none' by default
}

interface SceneModel {
  id: string;
  asset: string;                    // sha256 of a model in this site's library, never an address
  position?: Vec3; rotation?: Vec3; scale?: number;
  clip?: string;                    // a glTF animation clip to play on the timeline, see "Animation clips"
}

interface RoleBinding {             // role -> the model's own material or node names, chosen in the panel
  paint?: string[]; glass?: string[]; wheels?: string[]; emissive?: string[];
  dirtMask?: ImageRef;              // optional greyscale image for the dirt preset, red channel read
}

interface CameraTrack {
  keys: CameraKey[];                // at least 1, at most 24
  follow?: string;                  // a model id the camera tracks with damping
  framing?: 'fixed' | 'fit-width';  // fit-width: distance from screen width, as Grothe does on phones
  phone?: { offsetY?: number; fov?: number }; // slide the picture into a free band, no stretching
}

interface CameraKey {
  at: number | { anchor: string };  // 0 to 1, or the scroll position where a named node is centred
  position: Vec3; target: Vec3; fov?: number;
  ease?: 'linear' | 'smooth' | 'out'; // no ease-in: an entrance never starts slow
}

interface Timeline {
  drive: TimelineDrive;
  tracks: Track[];                  // model positions, effect amounts, light intensities, at most 32
  markers?: { at: number; emit: string }[]; // fire custom:<name> into page behaviour
}

type TimelineDrive =
  | { scroll: { section: string } } // progress of a named ancestor or sibling section, 0 at its top
  | { time: { seconds: number; loop?: false } } // plays once on view-enter; never loops by itself
  | { state: { id: string } }       // a number state 0 to 1 from the behaviour model drives it
  | { still: true };                // one camera key, no motion: an orbitable product shot is "still" plus orbit

interface Track {
  target: string;                   // 'model:<id>.x', 'effect:<id>.amount', 'light:key.intensity', ...
  keys: { at: number | { anchor: string }; value: number }[];
  ease?: 'linear' | 'smooth' | 'out';
}

interface EffectInstance { id: string; preset: EffectPreset; on: string; params?: Record<string, number> }
```

`anchor` is what made the Grothe scene robust: a keyframe pinned to the scroll position where a page node (a copy
panel) is centred, measured at run time, so copy and scene line up at every width. The anchor names a node by its
id; `parseScene` resolves it at render and drops a key whose anchor is gone, with a warning.

`orbit` (the visitor drags to rotate) is a separate boolean on a `still` scene only, off by default, never combined
with scroll, since dragging and scrolling fight for the same gesture on a phone.

### Presets versus free parameters

The line: **an author picks what something is and how much; the runtime owns how it looks.** A free parameter is a
number with a clamp, a colour, or a choice among named values. Anything that would need a shader, a particle rule
or a script is a preset.

| Area | Curated preset | Free parameters |
|---|---|---|
| Environment | `studio`, `hall`, `overcast`, `sunset`, `night` (generated environment maps, no downloaded high dynamic range (HDR) file) | exposure 0.5 to 1.5, background colour or fade |
| Lights | `three-point`, `top`, `rim`, `none` | intensity per light 0 to 3, a warm or cool tint |
| Paint | `gloss`, `satin`, `matte`, `metallic` applied to the paint role | base colour override, clearcoat 0 to 1 |
| Glass | `tinted`, `clear` on the glass role | tint colour |
| Wash effects | `dirt-wash` (mask fades as a track crosses a point), `foam-film` (white film over paint between two points), `wet-shine` (clearcoat rises) | start and end positions on the timeline, strength 0 to 1 |
| Particles | `wash-foam` (bubble clusters sampled on the paint role, slide and detach), `water-jets`, `mist`, `dust`, `sparks-off` | density 0 to 1 (tiered), start and end, colour within a range |
| Motion | `wheels-roll` (wheel role rotates with distance), `brushes-hug` (the brush model follows the paint role's roof profile and spins while overlapping) | speed 0 to 2 |
| Light moves | `paint-sweep` (a point light sweeps along the paint role), `exit-daylight` (a light and background fade in over a range) | range, intensity |
| Intro | `drive-in`, `lights-up` | none |

"Wash bay foam" is the combination `dirt-wash` + `foam-film` + `wash-foam` + `brushes-hug` + `water-jets`, shipped
as a starter scene template, not a new primitive: a template is a stored `scene` the palette inserts, the same way
the behaviour plan's presets expand into stored behaviour.

Every particle preset is seeded, so a scroll position always shows the same picture, which is what makes the
screenshots in the score and the comparison stable.

### Material roles: how a model from a 3D artist becomes presets without code

The Grothe presets work only because the Blender export tagged paint and wheels. A customer's model will not carry
our tags. So at upload the server lists the model's materials, meshes and named nodes; the panel shows them with a
thumbnail per material, and the author assigns roles (paint, glass, wheels, emissive) by ticking names. A preset binds
to a role, never to a name. When a model carries glTF extras `paint`, `glass` or `wheel`, or materials named that
way, the roles are proposed automatically and the author confirms. A dirt mask is an optional image input per model,
read only on the paint role.

### Animation clips

A glTF file can carry animation clips, including skinned characters. **Clip playback is included,** as a track: a
clip's time follows the timeline between two points, or plays once on view-enter. It costs nothing extra (three.js's
animation mixer is in the core already) and covers the common case of a model that comes with its own motion. Not
included: blending between clips, a state machine of clips, retargeting a clip onto another skeleton, inverse
kinematics. Those are character animation tools, and custom code is their route.

## Triggers and the behaviour model

The scene adds **no new verb to the behaviour model's action list,** which the behaviour plan froze after
prototyping. It uses the two routes that plan already opens for islands:

- **Into the scene: bindings on `data-u-*`.** The behaviour plan allows a binding on an island to write only
  `aria-*` and `data-u-*`. The scene island watches its box for `data-u-variant` (which variant model to show),
  `data-u-progress` (a 0 to 1 override of the timeline, which is how a slider or a set of buttons scrubs it), and
  `data-u-paused`. So "the vehicle picker swaps the truck for the bus" is a `choice` state on the page, a `set` on
  each button's click, and a binding `data-u-variant` on the scene node. No scene-specific action exists.
- **Out of the scene: `custom:<name>` events.** A timeline marker fires `custom:<name>` up the scopes, the one way
  into page state the behaviour plan defines for a custom code frame. A marker at the shine point can set state that
  shows a price panel.
- **Scroll is a drive, not a trigger.** `{ scroll: { section } }` reads the progress of a named section exactly as
  Grothe does: `-rect.top / (rect.height - innerHeight)`, clamped. The scene never pins, never scrubs the page,
  never installs a wheel or touch handler and never calls `scrollTo`. Making the stage sticky behind a tall section
  is ordinary layout an author sets in the style panel. This is **not** the GSAP ScrollTrigger exception the
  "Scroll-driven page type" roadmap line reserves for scrollytelling pages: that page type would add pinning and
  scrubbing on top, and stays a separate, later plan. A scroll-driven scene reads the scroll the visitor already
  makes; it changes nothing about how the page scrolls.
- **Variant loading.** Swapping keeps the current model until the next one has arrived, ignores a late answer that a
  newer choice superseded, preloads a variant on hover or focus of whatever sets it (the island watches the
  binding's source buttons through the program's targets), and on a failed load keeps the poster for that variant
  with a notice and a retry. These are the four stateful paths the stateful-flow standard asks for: forward, a
  changed choice invalidating the pending load, resume (the chosen variant is page state and resets on reload, as all
  behaviour state does), and re-entry after a failure.

### Motion rules

The repository's design work is bound by the motion rules in the `animate` and `review-animations` skills (user
interface animations under 300 milliseconds, never `ease-in` on an entrance, nothing perpetual, nothing on
high-frequency actions). How the scene keeps them:

- **Scroll-driven and state-driven motion is not a user interface animation.** It moves only while the visitor
  scrolls or chooses, at the visitor's pace, like the sanctioned scroll-craft exception, without its pinning.
- **Time-driven scenes play once on view-enter and stop.** `loop` is not in the format. Particles keep moving only
  while the timeline sits inside their range and the scene is in view; idle ambient motion is not offered.
- **Intro presets are longer than 300 milliseconds** (Grothe's 1.1 second drive-in was Marlin's explicit wish for
  that site). They are opt-in per scene, `none` by default, skipped when the visitor has already scrolled, and absent
  under reduced motion. Eases are `out` or `smooth`; `ease-in` is not a value the parser accepts.
- **Reduced motion** gives the `calm` frame or the poster, and the island renders on demand only.

## The runtime

### Loading

- **An island, loaded only when a scene node exists.** `applyScene(root)`, a pure pass in `renderPublishedPage` after
  `applyBehaviour`, finds scene nodes, renders the box, the poster `img` (with `srcset` from the site image route) and
  the children, and returns a program table. `SceneIsland` is a client island like `BehaviourIsland`: a dynamic
  `import('@/lib/scene/runtime')` inside its effect, so the runtime is its own chunk.
- **Probe first.** The island probes for WebGL 2 (falling back to WebGL 1) with a throwaway context, as Grothe's head
  script does, and loses that context at once. No WebGL: nothing more is fetched.
- **Lazy by position.** The island starts loading when the box comes within one viewport height of view
  (`IntersectionObserver` with a root margin), or at once when the box is above the fold on first render.
- **Above the fold, start in the head.** When `applyScene` finds a scene in the first viewport at the base breakpoint,
  the published renderer emits `modulepreload` hints for the runtime chunk and `preload` hints for the first variant's
  model and the decoder, behind the same WebGL probe in a small inline constant script, exactly Grothe's pattern. This
  is what took Grothe's real vehicle from 3.8 to 1.6 seconds on fast 4G.
- **No placeholder model.** The box shows the poster until the first real frame is compiled
  (`renderer.compileAsync`), then crossfades in 200 milliseconds. Grothe learned this the hard way: a stand-in model
  that is later replaced reads as a bug.

### Bundle budget

**three.js version (2026-11-11):** the Lumitra FX import ([plan](2026-11-08-lumitra-fx-in-sites.md), slice F1) landed
first and pinned `three` 0.184.0 exactly in `package.json`, the version lumitra.co runs. This primitive uses that one
entry; a version change is made once, for both, with the FX pixel comparison as its check.

| Chunk | Gzipped budget | Note |
|---|---|---|
| three.js core, tree-shaken to what the runtime imports | 150 KB | Grothe ships the whole minified module at 170 KB |
| `GLTFLoader` | 24 KB | |
| meshopt decoder | 7 KB | The default decoder, see the asset pipeline |
| Draco decoder | 79 KB | Only when a model on the page is Draco compressed, which re-encoding at upload makes rare |
| KTX2 (Khronos Texture 2, a container for textures the graphics processor reads compressed) and Basis Universal transcoder | 0 in version 1 | Out of version 1, see "not covered" |
| Our runtime: scene graph from data, timeline, camera, tiers, fallbacks | 25 KB | |
| Each effect preset | 3 KB, own chunk | `wash-foam` and the wash material are fetched only when used |

Held at about 210 KB gzipped before models for a scene without Draco, measured on Next's real chunks in a test, as
the behaviour plan holds its runtime. GSAP is not used: the timeline is our own few lines, and the intro presets are
plain eased tweens in the render loop.

### Quality tiers

Three named tiers, chosen at start from `navigator.hardwareConcurrency`, `navigator.deviceMemory` where it exists,
screen width, and the time of the first three frames; the author can pin one with `quality`.

| Tier | Pixel ratio cap | Particle density | Antialias | Shadows | Environment map size |
|---|---|---|---|---|---|
| low | 1.0 | 40 percent | off | none | 128 |
| medium | 1.35 | 70 percent | on | contact shadow plane only | 256 |
| high | 1.75 | 100 percent | on | contact shadow plane only | 512 |

If the frame time stays above 22 milliseconds for two seconds, the runtime steps down one tier once and stays there
for the visit. Rendering runs only while the box is in view and something on the timeline moves; a still scene
renders on demand.

### Fallback ladder

| Situation | What the visitor gets |
|---|---|
| JavaScript off, script blocked | The poster and the children. The poster is in the first HTML |
| No WebGL, or the probe throws | The poster and the children; nothing is fetched |
| Reduced motion | The `calm` frame rendered once, or the poster when `calm` is `'poster'`. No intro, no particles, no damping |
| A model fails or times out (30 seconds) | The poster stays, a visible status line in the box with a retry button, a console warning. A variant swap that fails keeps the current model |
| WebGL context lost | The poster returns at once; on `webglcontextrestored` the scene rebuilds from cache |
| A start error | The island removes the canvas and the page stays on the poster, as Grothe's `drop3d` does |

### Accessibility

- **Decorative by default.** The canvas is `aria-hidden="true"` and takes no focus, and the poster has an empty `alt`.
  The meaning lives in the page's own text, as on Grothe, where every fact a station shows is in its copy panel. The
  panel says so in words when a scene is placed.
- **When the scene is content** (a product shown for itself), `title` is required: the box becomes `role="img"` with
  that name, and the poster's `alt` is the same text.
- **Orbit** is reachable by keyboard: the box takes focus, arrow keys rotate, a visible focus ring, and a one-line
  hint in the accessible description.
- **No flashing.** The light presets are clamped so no full-screen luminance change exceeds three per second.
- **Status and retry** messages are in a live region and the retry is a real button.

## The asset pipeline

### Storage

Site image uploads (in progress on `feat/site-image-uploads`) store bytes in Postgres, a `site_images` table with a
database CHECK of 2 megabytes per row, served at `/site-images/<sha256>.<ext>` on the site's own hosts: host-resolved,
content-addressed, `immutable` cache headers, the hash as entity tag, `nosniff` and a `sandbox` policy. Catalogue
images follow the same 2 megabyte rule. Models do not fit: the Grothe truck alone is 0.5 megabytes after Draco, a
customer's export is commonly 5 to 30 megabytes before optimisation.

**Decided here:** models go to **Storage Brain** (the suite's file service on Cloudflare R2), which both the Books
migrations (`008_books_files.ts`) and the catalogue image repository already name as the intended home "until a
storage-brain client exists here". This plan builds that client. Metadata lives in Postgres in a `site_models` table
(site, sha256, byte size, triangle and texture counts, extensions, materials and node names for the role panel,
uploader, created), unique on site and hash, never updated, cascading with the site. Serving copies the site images
pattern: `GET /site-models/<sha256>.glb` on the site's own hosts, resolved by host, streamed from Storage Brain,
`Cache-Control: public, max-age=31536000, immutable`, the hash as entity tag, `nosniff`, `Content-Type:
model/gltf-binary`, and same-origin, so the report-only Content Security Policy (CSP, the header that says what a page
may load) needs only a `connect-src 'self'` that it already implies, and no third party sees a visitor.

A published revision freezes the hashes it references, so a model a revision uses is never deleted while that revision
is kept; a model no kept revision and no draft references is collected after 30 days.

### Upload, validation and re-encoding

`POST /api/projects/<id>/models` (the `editSite` guard), body the GLB or a glTF with embedded buffers. The route runs
the work in a worker with a 20 second and 512 megabyte limit:

1. **Bound the input.** At most 50 megabytes read, bounded like `boundedBytes`.
2. **Parse strictly.** The GLB header and chunk lengths checked against the byte count, the JSON chunk parsed with a
   size cap, then the Khronos glTF validator (`gltf-validator`). Errors refuse with the validator's message.
3. **Refuse anything that reaches out.** Every `uri` must be absent (GLB buffer) or a `data:` address inside the file;
   any other address refuses. A file that names an external texture or buffer is never fetched.
4. **Allow-list extensions:** `KHR_draco_mesh_compression`, `EXT_meshopt_compression`, `KHR_mesh_quantization`,
   `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_specular`,
   `KHR_materials_emissive_strength`, `KHR_materials_variants`, `KHR_texture_transform`, `EXT_texture_webp`. Anything
   else, and every extension in `extensionsRequired` not on the list, refuses.
5. **Bound the decoded size, not the file size.** Compression hides size, so the worker decodes and counts: at most
   500,000 triangles, 256 meshes, 64 materials, 16 textures, textures at most 4,096 pixels on a side, 1,000 nodes,
   node depth 32, 32 animation clips, 128 bones, a bounding box at most 1,000 units on a side with no `NaN` or
   infinite value.
6. **Re-encode** with glTF-Transform (the standard library for rewriting glTF files): dedupe, prune, weld, textures
   resized to at most 2,048 pixels and converted to WebP, meshes compressed with meshopt (smaller decoder than Draco,
   7 against 79 KB), quantised. The original is kept in Storage Brain for one re-encode later, not served.
7. **Store** under the re-encoded file's hash, return `{ sha256, bytes, triangles, materials, nodes, clips, roles }`.

The served file is then something our own pipeline wrote, which bounds what the browser's decoder ever sees.

Default limits (product decision D1 below): 8 megabytes per stored model after re-encoding, a scene's first variant at
most 4 megabytes transferred, 12 megabytes for all of one scene's models, 200 megabytes of models per site. The upload
answers 413 with the measured figure and which step would help (fewer triangles, smaller textures).

## Editor experience

- **Place a scene.** The palette gains "3D scene", which inserts a box with a placeholder poster and a starter template
  picker: "Product turntable" (a still model, orbit), "Scroll fly-through" (scroll drive, three camera keys), "Wash bay"
  (the full wash preset set on a sample model). The model library dialog uploads or picks models, with the size and
  triangle readout, and refuses with reasons.
- **The poster is the canvas default.** The editor canvas shows the poster image, as the map embed shows a tile. A
  "Live preview" toggle on the selected scene mounts the runtime in the canvas frame. This is first-party code with no
  third party, so it may run in the editor, unlike custom code and the map.
- **Orbit and scrub belong to Interact.** In Select mode the wheel pans the canvas and the scene must not take it. In
  the Interact tool (behaviour plan slice B10) and in a panel viewport, the live preview takes pointer drag for orbit
  and the wheel for zoom.
- **The timeline strip.** A strip under the canvas when a scene is selected: a scrub handle writes `data-u-progress` to
  the preview only (volatile, never saved), anchors show as ticks with the node names, tracks as rows of keys.
- **Camera keys visually.** Orbit to a view, press "Capture camera key", and the current camera becomes a key at the
  scrub position; a key can be retimed by dragging and deleted. Numbers are editable for whoever wants them.
- **Roles and presets in the panel.** A "Scene" section: model list, variants, role ticking with material thumbnails,
  environment and light presets, effect presets with their few sliders, quality pin, calm frame ("use the current scrub
  position"), poster ("render the current view as the poster", which stores a PNG through the site image route).
- **Stateful paths.** Changing a model invalidates its role binding (roles are keyed to the asset hash) and the poster
  render, keeping the old poster until the author renders a new one; keeping the same model keeps both. A deleted
  anchor node drops its keys with a warning in the panel. All four paths have tests.

## AI and Lumitra Sites MCP operations

No Model Context Protocol (MCP, the standard for exposing tools to AI agents) server exists in this repository today;
the [AI page generation plan](ai-driven-page-generation.md) names MCP tools as one future consumer of the snapshot
format. Scenes are designed for it anyway:

- **One trust boundary.** `parseScene` runs in the panel, the generator's validator (`validateGeneration`), the review
  operations in `src/lib/ai/review/ops.ts`, the import, and any future MCP route.
- **What a generator may do:** place a scene from a starter template, set camera keys, environment, light and effect
  presets, assign roles from names the model library reports, bind variants to page state, set anchors to nodes it
  created. Taught as templates in `schemaDocs`, like the behaviour presets.
- **What it may not:** upload a model, invent an asset hash (an unknown hash is dropped with a warning), set an intro
  preset (a motion choice for a person), or set `quality: 'high'` on a phone breakpoint.
- **Tool shapes a Lumitra Sites MCP server would expose,** all thin wrappers over the same functions:
  `scene_list_models(siteId)`, `scene_place(pageId, parentId, template, modelHashes)`,
  `scene_set_camera_keys(nodeId, keys)`, `scene_assign_roles(nodeId, modelId, roles)`,
  `scene_set_effects(nodeId, effects)`, `scene_render_poster(nodeId, at)`. Uploading stays a person's action in the
  editor or a separate authenticated upload tool, never a generation step.

## Score rows and corpus fixtures

The primitive score (`pnpm score:primitives`, `docs/primitives-score/latest.md`) gains a kind, **"Scene promises"**,
promises of the format like the reusable component rows, each through the five columns (format, published, canvas,
panel, AI):

| Row | Published cell passes when |
|---|---|
| `scene-poster-first` | The poster is in the first HTML, before any script |
| `scene-no-bytes-without-scene` | A page with no scene fetches no runtime byte, counted over the network |
| `scene-no-webgl` | With WebGL disabled in Chromium, poster and children show and no model is fetched |
| `scene-reduced-motion` | Under emulated reduced motion, the calm frame matches its golden screenshot, and no second frame renders |
| `scene-load-failure` | A model answering 500 gives the poster, the status line and a working retry |
| `scene-context-lost` | Forcing `WEBGL_lose_context` returns the poster, restoring rebuilds |
| `scene-scroll-drive` | Screenshots at five scroll positions match goldens in Chromium |
| `scene-anchor-keys` | An anchored key lands on its node's centre at three widths |
| `scene-variant-swap` | A `set` on page state swaps the model, a superseded load is ignored, a failed swap keeps the old model |
| `scene-marker-emits` | A timeline marker fires `custom:<name>` and a stored trigger runs |
| `scene-time-once` | A time drive plays once on view-enter and stops |
| `scene-orbit-keyboard` | Arrow keys rotate a focused orbit scene |
| `scene-tier-step-down` | A throttled profile steps down one tier |
| `scene-bundle-budget` | Runtime chunks within their budgets on Next's real chunks |
| `scene-model-refusals` | An external `uri`, an unknown required extension, a decoded size over the caps each refuse at upload |
| `scene-role-presets` | `dirt-wash`, `foam-film` and `wash-foam` affect only the paint role (glass pixels unchanged in the golden) |

**Corpus fixture `three-scroll-scene`.** The repository is public, so the fixture is never the Grothe scene. The
original is a hand-written three.js page of a few hundred lines; the model is a Khronos glTF sample model whose licence
permits redistribution (CC0, the public domain dedication, preferred; CC-BY, the Creative Commons attribution licence, with its attribution file beside it
otherwise), or a procedural truck built in the fixture; the replica is the same scene as a stored `scene`. Compared
by screenshots at fixed scroll positions at 1280 and 390 pixels wide with the seeded particles, within the corpus's
existing pixel tolerance. A second fixture, `three-turntable`, covers the still and orbit case.

The event rows `contextlost` and `contextrestored`, labelled `custom code` in the behaviour plan, stay so: they are
about a stored action on an author's own `canvas`, which the scene never gives an author.

## Side by side: the primitive against a custom code block

The question this answers: for a page like the Grothe hero, is the primitive worth its cost compared with letting an
author paste three.js into the sandboxed custom code block planned in parallel (`2026-11-02-sandboxed-custom-code.md`,
pull request #311, open and not on main when this was written)? Its numbers below are as its author reported them on
2026-11-02; where the two plans differ, that plan wins on the sandbox.

### Four columns, the same scene

| Column | What it is |
|---|---|
| Reference | The hand-built site at grothe.lumitra.co, the fidelity target |
| Primitive | The same hero rebuilt in a local framer-clone instance as a stored `scene`: the four vehicle models uploaded through the real route, roles assigned in the panel, the wash preset set, anchors on the copy panels, the picker as page state |
| Custom code, accepted contract | The behaviour plan's sandbox as Marlin accepted it (M1 to M10): 256 kilobytes per block, `connect-src 'none'`, `img-src data:`, no fetch, 1 megabyte of blobs per site |
| Custom code, proposed widening | The custom code plan's proposals M11 to M15 (its slice C8), which need Marlin's yes because the sandbox's security design is his: a block of up to 17 text files in 256 kilobytes; per-site content-addressed assets served by the sandbox host (each at most 8 megabytes, 16 per block, 64 live per site; GLB, image, font, media and JSON types; no SVG, HTML or script); a pinned library shelf on the sandbox host with three.js and its loaders, not counted against the limit; a `viewport` broker message carrying the frame's rectangle and up to 16 declared anchor rectangles, so a scene can follow the parent page's scroll; Draco only if a probe shows a `blob:` worker inherits the frame's policy in all three engines, otherwise uncompressed GLB (Grothe's uncompressed set is about 3.1 megabytes) |

**Expected result under the accepted contract: not buildable.** three.js's minified core alone is about 670 to 690
kilobytes, nearly three times the block limit, the models about 1 megabyte per vehicle, and nothing may be fetched. The
harness records this as a refusal at the guarded route, not as an assumption.

**Expected result under the proposed widening: buildable, with stated losses.** Grothe's own code (about 58 kilobytes)
fits the bundle, three.js comes from the shelf, the models from the asset route, scroll and the copy-panel anchors from
the `viewport` message. GSAP is not on the shelf until its licence has been read and recorded, so the author bundles
their own copy inside the 256 kilobytes (72 kilobytes) or drops the intro. What it still lacks against the primitive:
nothing renders on the editor canvas (a tile; the standalone preview tab runs it), nothing for the AI generator to edit,
off by default per site and enabled by a person, a lawyer's reading of the consent wording before it switches on, no
poster or fallback ladder unless the author writes one, and a hung scene freezes the parent page in WebKit. Those losses
are measured where they can be, not only listed.

### What is measured

| Measure | How |
|---|---|
| Fidelity | Screenshots at scroll positions 0, 0.2, 0.4, 0.6, 0.8, 1.0 of the run section, at 1440 by 900, 390 by 664 (Marlin's real phone viewport) and 844 by 340, for each vehicle, compared against the reference with a perceptual difference score; reviewed by eye side by side |
| Load size | Bytes transferred until the first real 3D frame and until idle, from the Chrome DevTools Protocol network log, split into code, models, textures |
| Load time | Time to first real frame and to the full scene, on simulated fast and slow 4G with a four times throttled processor, as the client plan measured |
| Frame rate | Frames per second sampled with `requestAnimationFrame` during a scripted scroll through the run, median and 5th percentile, desktop and throttled; plus a real phone run on Marlin's iPhone through the visible automation browser when he is available, since simulated phones do not count as phone measurements |
| Mobile behaviour | The view offset framing at the phone sizes the client checks (390 by 664, 360 by 560, 320 by 500, 430 by 760, 844 by 340), the tier chosen, reduced motion and no WebGL |
| Authoring effort | Time and steps for a person in the editor against lines of code for the block, recorded during the build |

### Where it runs: local only, outside every repository

The comparison uses the client's models and copy, so **none of it is committed to framer-clone,** and it sits outside the
client's repository too, in one folder shared with the custom code plan's half of the fixture:
`~/software-dev/clients/lkw-waschhalle-grothe-worktrees/comparison-sandbox-vs-3d/`, a sibling of the client's `astra`
worktree (the containing folder is not a git repository). It holds

- `load-primitive.ts` (the name the custom code plan reserves for this half), which uploads the client's GLB files and
  masks to a local framer-clone (`pnpm dev`, local database) through the real model upload route and writes the scene
  page through the projects application programming interface (API);
- the custom code plan's seed for its two columns, specified in that plan;
- `compare.mjs`, a Playwright script that serves the reference locally from the `astra` worktree's `site/` (and runs once
  against the live site), opens each column, scripts the scroll, takes the screenshots, and collects the network log and
  the frame samples, reusing the phone sizes of the client's `lab/check-phone.mjs`;
- `report/`, the screenshots and a generated HTML report with the four columns, a local working file.

framer-clone gets only the conclusion, written into this plan's "Comparison result" section by slice S11, with numbers and
no client material.

### What would change the plan

If the primitive's fidelity at the six scroll positions is visibly below the reference on the wash effects, the gap goes to
the effect presets, not to custom code. If authoring the primitive version takes longer than writing the block would for a
person who can code, that is expected and fine: the primitive is for people who cannot.

## What the primitive deliberately does not cover

Custom code remains the route for each of these:

- **Custom shaders** or any material beyond the presets and free parameters above. The Grothe wash material is reproduced
  as presets; a new look needs a new preset from us, or custom code.
- **Physics:** rigid bodies, collisions with the visitor, fluids, cloth. The foam is a seeded approximation.
- **Character animation beyond clip playback:** blending, state machines, retargeting, inverse kinematics.
- **Scroll pinning and page scrubbing.** That is the separate scroll-driven page type.
- **Procedural geometry an author writes.** Grothe's hall is built in code; in the primitive it would be a modelled GLB.
  A small set of primitive shapes (floor plane, box, cylinder, rounded box) is the most this plan offers, as a
  `primitives` model kind in a later slice if the comparison shows the need.
- **Video textures, live data in the scene, text in 3D,** and more than one canvas sharing one rendering context.
- **Fetching anything at run time** beyond the site's own models and images.
- **Virtual and augmented reality** (WebXR), post-processing passes (bloom, depth of field), real-time shadow maps.
- **Compressed graphics processor textures** (KTX2 with Basis Universal) in version 1; WebP textures cover the forcing case. A later slice
  adds them if the tier measurements ask for it.
- **Game-like interaction:** clicking objects in the scene to do things. Only orbit, scroll, time and page state drive it.

## Slices

Each slice is one pull request, green alone, raising the score baseline where a number rises. Sizes are judgement in agent
days.

| # | Slice | What it builds | Depends on | Acceptance | Size |
|---|---|---|---|---|---|
| S1 | `scene-format` | `src/lib/scene/format.ts` (`parseScene`, types, clamps, every refusal), `scene` denied as a DOM prop, the marker in the renderers' dispatch | none | Unit tests for each clamp and refusal, unknown hash, missing poster, ease-in refused, loop refused; format column for the scene rows | 2 to 3 |
| S2 | `scene-model-store` | Storage Brain client in `src/server/storage/`, `site_models` table and migration, upload route with the worker (validate, bound, re-encode), `/site-models/<sha>.glb` route, collection of unreferenced models | S1 | Integration tests: each refusal with a crafted file (external `uri`, bomb by decoded size, required unknown extension, broken chunk length), immutable headers and 304, host isolation (site B cannot read site A's hash), round trip of a Khronos sample | 4 to 6 |
| S3 | `scene-render-island` | `applyScene` pass, poster and children on the server, `SceneIsland` with probe, lazy start, head hints above the fold, fallback ladder | S1, S2, and site image uploads (`feat/site-image-uploads`, today only `favicon` and `sharing` kinds) merged first. This slice adds the `poster` kind there (agreed with that branch's author on 2026-11-02): `poster` in `SITE_IMAGE_KINDS` and `SITE_IMAGE_TYPES` in `src/lib/site/siteImages.ts` (PNG, JPEG, WebP; the shared 2 MB and 8,000 pixel limits apply), a refusal message in `checkSiteImage`, a branch in `siteImageWarnings`, an `ACCEPT` entry in `SiteImageField`. The upload route, storage and `/site-images` serving need no change | `scene-poster-first`, `scene-no-bytes-without-scene`, `scene-no-webgl`, `scene-load-failure` published | 3 to 4 |
| S4 | `scene-runtime-core` | Runtime: scene graph from data, environment and light presets, camera keys and follow, fit-width framing and phone offset, scroll, time and still drives, anchors, tiers, calm, context loss, bundle test | S3 | `scene-scroll-drive`, `scene-anchor-keys`, `scene-time-once`, `scene-reduced-motion`, `scene-tier-step-down`, `scene-bundle-budget`, `scene-context-lost` | 5 to 7 |
| S5 | `scene-behaviour` | `data-u-variant`, `data-u-progress`, `data-u-paused` read by the island, markers emitting `custom:<name>`, variant loading with the four stateful paths. Shares `src/lib/behaviour/runtime.ts`: the runtime must accept `custom:<name>` from a first-party island (today only `emit` and the custom code broker) and expose a binding's source targets for preload | S4, behaviour B4 | `scene-variant-swap`, `scene-marker-emits` | 2 to 3 |
| S6 | `scene-presets` | Material roles, paint and glass presets, `dirt-wash`, `foam-film`, `wet-shine`, `wash-foam`, `water-jets`, `mist`, `wheels-roll`, `brushes-hug`, `paint-sweep`, `exit-daylight`, intro presets, clip playback | S4 | `scene-role-presets`; seeded goldens per preset; each preset chunk within 3 KB | 5 to 7 |
| S7 | `scene-panel` | Palette entry, starter templates, model library dialog, Scene section with roles, presets, quality, calm, poster rendering | S2, S6 | Panel column for the scene rows; the four stateful paths in the panel (model change invalidates roles and poster) | 3 to 4 |
| S8 | `scene-canvas-live` | Poster on the canvas, live preview toggle, orbit and wheel in Interact only, the timeline strip, capture camera key | S7, behaviour B10 | Canvas column; no wheel captured in Select mode; capture writes a key at the scrub position; no save marked dirty by scrubbing | 4 to 5 |
| S9 | `scene-ai` | Validator, review operations, templates in `schemaDocs`, refusals (unknown hash, intro, high on phone), the MCP tool shapes as functions | S6 | AI column; generated scene from a template survives `validateGeneration`; invented hash dropped | 2 |
| S10 | `scene-score-corpus` | "Scene promises" kind in `test/score/`, fixtures `three-scroll-scene` and `three-turntable` with a licensed sample model | S4, S6 | Rows reported in `latest.md`; both fixtures pass within tolerance | 2 to 3 |
| S11 | `scene-comparison` | The local harness in `comparison-sandbox-vs-3d/`, the run, the "Comparison result" section in this plan | S8, the custom code plan's guarded route if it exists | The four-column report produced locally; numbers and conclusion written here with no client material | 2 to 3 |

Total about 34 to 47 agent days, roughly 6 to 9 weeks for one agent, less with two working S2 and S4 in parallel after S1.
S3 is the first slice a visitor can see (a poster with a working scene behind it for a hand-written description); S7 is the
first a person without code can use.

## Decided here, say so if you disagree

- **Storage Brain for models,** not Postgres and not a new bucket: the existing migrations already name it, and the site
  images owner advises against stretching the 2 megabyte bytea table.
- **meshopt as the re-encoded default, Draco accepted.** Seven against seventy-nine kilobytes of decoder on every visit.
- **No new behaviour verb.** Bindings on `data-u-*` and `custom:` events cover the forcing case; reopening the frozen action
  list would cost more than it buys.
- **Scroll drive without pinning ships with this primitive,** independent of the deferred scroll-driven page type.
- **Clip playback in, character tools out.**
- **Poster required,** which the forcing case did not have.
- **No GSAP.** The timeline and intros are our own code, which keeps the bundle budget.
- **Vocabulary (decided in S1, 2026-11-12): "3D scene" is this primitive, "FX scene" or "visual effect" is Lumitra FX** (`src/lib/fxScene`, prop `fx`, marker `data-fx="scene"`). This primitive uses prop `scene`, marker `data-scene="three"`, directory `src/lib/scene`. The editor panel, palette and AI documentation never say a bare "scene": always "3D scene" here and "FX scene" there. The two never share a prop or marker.
- **`parseScene` contract (S1):** strict shape (unknown keys, bad names, counts over caps, an `ease-in`, any `loop`, an orbit on a non-still drive are refused), numbers clamped with a warning, an unknown model or image hash refused when the site's library is passed in, an anchor to a node that is gone dropped with a warning. `scene` and `data-scene` are refused in `setProps` (the scene is written by the editor through `parseScene`).
- **Reading details settled in S1:** any `loop` key is refused, even `false` (the format has no loop); a scene needs at least one model; a `still` drive means one camera key and no tracks; anchor, section and state ids use a selector-safe alphabet; track values clamp by target (light 0 to 3, effect 0 to 1, model scale 0.001 to 1000).
- **S2a (2026-11-12) is the dependency-free structure guard `checkGlb` (`src/lib/scene/glb.ts`), not upload security.** It covers steps 1, 3, 4 and the count caps of step 5 (header and chunk lengths, JSON cap, no external `uri`, extension allow-list, counts, node depth, buffer bounds). Duplicate JSON keys are refused (parsers disagree on which counts, so a file could show the guard one `buffers` list and a later reader another); that stays until the upload flow is proven to hand every later stage (the Khronos validator, glTF-Transform) exactly the object the guard read, not the raw bytes. Still owed by the complete upload flow (S2): the Khronos validator (step 2), decoded triangle, size, texture-pixel and bounding-box caps (step 5), re-encode (6), storage and quotas (7), and the 20 second, 512 megabyte worker.
- **S2 offline half (2026-11-12): ports, pipeline, serving and collection exist with in-memory fakes and tests; the live half is GATED.** Built (new files only, `src/lib/scene/modelQuota.ts`, `modelFile.ts`, `src/server/models/`): the quotas as constants with no override (D1 defaults), the `/site-models/<sha>.glb` address and headers, an upload pipeline that fails closed (no validator or re-encoder injected means nothing is stored; guard, validator, decoded caps enforced on the decoder's measurements, guard again on the output, quotas, then store with compensation), host-isolated serving with 304 and preview privacy, and a collection planner that keeps blobs shared across sites. Review findings folded in: the quota is checked inside an atomic `insertWithinQuota` (parallel uploads cannot pass it), a failed save deletes no shared blob, kept originals are counted under their own 200 megabyte per site cap (stricter than the plan, which counted none) and collected with their row, a repeat upload refreshes `lastUsedAt` so a model is collected only after 30 days unused, the collection planner takes repository-wide row counts and deletes no blob on an unknown count. Open for the gated parts: the scene-save path must call `checkSceneQuota` (4 megabyte first model, 12 megabytes per scene), the route must rate-limit uploads, the real executor re-checks for rows right before each blob delete, an immutable year of caching means a deleted model can linger in caches (acceptable for a content-addressed asset), and `cross-origin-resource-policy: same-origin` must be revisited if the editor loads preview-host models from another origin. **Validator and re-encoder (2026-11-12, `src/server/models/pipeline/`):** the Khronos validator and the glTF-Transform re-encoder run offline in a worker thread (heap cap 512 megabytes, 20 second timeout, both enforced and tested) and are exported as adapters wired to no route, so uploads stay fail-closed. Dependencies added, all exact-pinned, from the repository lockfile with install scripts off and none declared: `gltf-validator` 2.0.0-dev.3.10 (Apache-2.0), `@gltf-transform/core`, `extensions` and `functions` 4.5.1 (MIT), `meshoptimizer` 1.3.0 (MIT), and `sharp` 0.35.5 as a direct dependency (it was already in the lockfile through Next; the encoder for the WebP textures). Bomb defences run before anything is decoded: Draco refused (no decoder is installed, so it cannot be measured; export without compression or with meshopt), the decoded bytes every accessor and meshopt view declares are summed and capped (64 megabytes, guard's own bound), every texture's size is read from its header and capped per side (4,096), in total (40 million pixels) and the output texture side (2,048); the output is read back and measured again. Review of the pipeline folded in: a validator report that stops at its issue limit is a refusal (it was a pass), triangles are counted per placing node (1,000 instances of a mesh are 1,000 meshes), node, mesh, material, texture, image, animation and bone counts and node depth are refused from the JSON before decoding, textures must be single png, jpeg or webp images, workers queue (two at a time), a validator timeout answers 413 rather than "invalid file", the decoded byte bound is 64 megabytes, and the `sharp` override is pinned exactly. The worker's memory cap bounds the JavaScript heap only (typed arrays and sharp's native memory are bounded by the pre-decode caps and the queue); a container memory limit is a deployment step that stays gated before any route exists. Also before wiring: the worker file path breaks under Next's bundling (`new URL(..., import.meta.url)` needs a built-output smoke test), `worker.mjs` and `engine.mjs` need `outputFileTracingIncludes`, `gltf-validator` and `sharp` need `serverExternalPackages`; the bounding box is the rest-pose box (skinning, morph targets and animation are not sampled); `gltf-validator` is a `-dev` prerelease (the only published 2.0 line). Second review: a glTF text file with embedded buffers now re-encodes end to end (it passed the guard and validator but failed at the re-encoder), the validator runs unlimited issues (a limit counted infos, so a noisy valid export was refused; a cut-off report is still a refusal), points and lines count as primitives, an unreadable image answers 422 not "too large", a timed-out worker's slot is freed only after the thread stops, and more than 16 queued uploads answer 503 busy. **Draco input stays REFUSED, with the exact blocker (2026-11-12).** The plan says "Draco accepted" and the package is appropriate on paper (`draco3dgltf` 1.5.9, Google maintained from `github.com/google/draco`, Apache-2.0, no dependencies, no install scripts, about 0.8 megabytes). It is not enabled because decoded size cannot be bounded before native allocation. Measured offline: Draco expands 47 to 67 times for one attribute and 167 times for a regular mesh with several constant attributes (a 1.8 megabyte stream decodes to about 300 megabytes), so the compressed size does not bound the decoded size; forged face and point counts are refused by the decoder without allocating, but an honestly encoded stream is not; the decoder's WebAssembly memory is declared inside its binary (258 pages minimum, 32,768 pages maximum, that is 2 gigabytes) with no supported option to lower it, and overriding the `WebAssembly.Memory` constructor has no effect because the memory is created from the module's own declaration. Rewriting that maximum in a copy of the binary did make an oversize decode abort cleanly in an experiment, but shipping a patched vendor binary needs a maintained, validated design and an independent security review, and a tested operating-system or container memory boundary cannot be proven offline on this machine. Worker heap limits do not cover WebAssembly or typed-array memory. To enable Draco later one of these must exist: an official decoder build with a memory limit option, a reviewed and checksum-pinned patched decoder with its own tests, or a tested container or cgroup memory limit around the worker. Until then a Draco model is refused with a message to export without compression or with meshopt; a test (`refuses Draco`) pins the refusal. Still gated, each needing a decision or access first: a Storage Brain adapter (credentials and its SDK, and its file type handling for `model/gltf-binary` to be confirmed), the Prisma repository and the `site_models` migration (`prisma migrate deploy` runs at the next boot, so merging it is a production schema change), the route file wiring the real host resolver, and the integration tests that prove them.
- **S1 leaves the score's format column to S10,** which builds the "Scene promises" kind; S1's unit tests cover every clamp and refusal directly.

## For Marlin to decide

**Answered by Marlin on 2026-11-02:** D1, keep the default quotas, with 3D included in every plan until pricing is decided.

- **D1, quotas.** Defaults above: 8 megabytes per model, 12 per scene, 200 per site. They set what storage and egress cost
  Lumitra per customer and whether 3D becomes a paid tier. Recommended: the defaults, with 3D in every plan until pricing is
  decided, since R2 has no egress fee and the totals are small.

## Comparison result

Written by slice S11.
