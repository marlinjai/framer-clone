// @vitest-environment node
// The stored form of an FX scene (../format): every repair and every refusal,
// and the proof that on the scenes the engine was written for (the lumitra.co
// hero, lumitra-web's own scenes, the presets) the strict reader gives exactly
// the scene the engine's loader gives, so no clamp changes a real scene.

import { describe, expect, it } from 'vitest';

import {
  FX_LIMITS,
  deserializeScene,
  fxImageAddresses,
  isFxColor,
  parseFx,
  parseFxScene,
  serializeScene,
  toStoredFx,
  type FxSceneResult,
  type SceneConfig,
} from '../format';

import demoPhase2 from './fixtures/demo-phase-2.json';
import hubHero from './fixtures/hub-hero.json';
import v7 from './fixtures/v7.json';
import bokehFocuspull from '../presets/preset-bokeh-focuspull.json';
import godraysHero from '../presets/preset-godrays-hero.json';
import noiseGradient from '../presets/preset-noise-gradient.json';

type Raw = Record<string, unknown>;
const SITE_IMAGE = `/site-images/${'a'.repeat(64)}.png`;
const allowSiteImage = { isAllowedImageSrc: (src: string) => src === SITE_IMAGE };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function layer(type: string, extra: Raw = {}): Raw {
  return { id: type, type, name: type, visible: true, blend: 'normal', params: {}, ...extra };
}

function sceneOf(layers: unknown[], extra: Raw = {}): Raw {
  return { version: 1, id: 'test', size: { mode: 'fill' }, background: '#000000', fps: 60, dpr: [1, 1.75], layers, ...extra };
}

function ok(result: FxSceneResult): { scene: SceneConfig; notes: string[] } {
  if (!result.ok) throw new Error(`expected a scene, got: ${result.message}`);
  return result;
}

function refused(result: { ok: boolean; message?: string }): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.message!;
}

function param(scene: SceneConfig, layerId: string, key: string): unknown {
  return scene.layers.find((l) => l.id === layerId)!.params[key].value;
}

describe('real scenes read the same as through the engine loader', () => {
  // demo phase 2 shows one of lumitra-web's own demo pictures, an address no
  // Sites host allows (asserted below); here the test's rule lets it through so
  // the rest of that scene is compared too.
  const DEMO_IMAGE = '/fx/thumbs/thumb-7.jpg';
  const allowDemoImage = { isAllowedImageSrc: (src: string) => src === DEMO_IMAGE };
  const scenes: Array<[string, unknown]> = [
    ['the lumitra.co hub hero', hubHero],
    ['lumitra-web v7', v7],
    ['lumitra-web demo phase 2', demoPhase2],
    ['preset godrays-hero', godraysHero],
    ['preset noise-gradient', noiseGradient],
    ['preset bokeh-focuspull', bokehFocuspull],
  ];

  it('demo phase 2 is refused without that rule: its picture is not a site upload', () => {
    expect(refused(parseFxScene(demoPhase2))).toMatch(/image address that is not allowed here \("\/fx\/thumbs\/thumb-7\.jpg"\)/);
  });

  it('the hub hero and the presets name no image at all', () => {
    for (const raw of [hubHero, v7, godraysHero, noiseGradient, bokehFocuspull]) {
      expect(fxImageAddresses(ok(parseFxScene(raw)).scene)).toEqual([]);
    }
  });

  for (const [name, raw] of scenes) {
    it(`${name}: same values, nothing repaired`, () => {
      const { scene, notes } = ok(parseFxScene(raw, allowDemoImage));
      expect(notes).toEqual([]);
      expect(serializeScene(scene)).toEqual(serializeScene(deserializeScene(raw)));
    });

    it(`${name}: same scene, apart from the choices a post pass's source offers`, () => {
      const strict = ok(parseFxScene(raw, allowDemoImage)).scene;
      const loose = deserializeScene(raw);
      const withoutSourceChoices = (s: SceneConfig) =>
        s.layers.map((l) => ({
          ...l,
          params: Object.fromEntries(Object.entries(l.params).map(([k, p]) => [k, k === 'sourceLayerId' ? { ...p, options: undefined } : p])),
        }));
      expect(withoutSourceChoices(strict)).toEqual(withoutSourceChoices(loose));
      expect({ ...strict, layers: [] }).toEqual({ ...loose, layers: [] });
    });

    it(`${name}: reading what was stored gives the same scene again`, () => {
      const first = ok(parseFxScene(raw, allowDemoImage)).scene;
      const second = ok(parseFxScene(serializeScene(first), allowDemoImage));
      expect(second.notes).toEqual([]);
      expect(second.scene).toEqual(first);
    });
  }
});

describe('refusals', () => {
  it('refuses a scene format version it does not read', () => {
    expect(refused(parseFxScene(sceneOf([], { version: 2 })))).toMatch(/format "2".*reads format 1/);
    expect(refused(parseFxScene(sceneOf([], { version: '1' })))).toMatch(/format/);
  });

  it('reads a scene without a version as version 1', () => {
    const raw = sceneOf([layer('grain')]);
    delete raw.version;
    expect(ok(parseFxScene(raw)).scene.version).toBe(1);
  });

  it('refuses more layers than a scene may hold, and takes exactly the limit', () => {
    const many = Array.from({ length: FX_LIMITS.layers + 1 }, (_, i) => layer('grain', { id: `g${i}` }));
    expect(refused(parseFxScene(sceneOf(many)))).toMatch(new RegExp(`${FX_LIMITS.layers + 1} layers.*at most ${FX_LIMITS.layers}`));
    expect(ok(parseFxScene(sceneOf(many.slice(0, FX_LIMITS.layers)))).scene.layers).toHaveLength(FX_LIMITS.layers);
  });

  it('refuses what is not a scene', () => {
    for (const bad of [null, undefined, 'scene', 12, [], JSON.stringify(sceneOf([]))]) {
      expect(parseFxScene(bad).ok).toBe(false);
    }
    expect(refused(parseFxScene({ id: 'x' }))).toMatch(/no list of layers/);
    expect(refused(parseFxScene({ id: 'x', layers: {} }))).toMatch(/no list of layers/);
  });

  describe('the image address', () => {
    const withSrc = (src: unknown) => sceneOf([layer('image', { params: { src } })]);

    it('refuses every address when the host gives no rule', () => {
      expect(refused(parseFxScene(withSrc(SITE_IMAGE)))).toMatch(/image address that is not allowed/);
    });

    it('refuses a foreign address under the host rule, in every form', () => {
      for (const src of [
        'https://evil.example/pixel.png',
        '//evil.example/pixel.png',
        'http://169.254.169.254/latest/meta-data',
        'data:image/png;base64,AAAA',
        'javascript:alert(1)',
        '/fx/thumbs/thumb-7.jpg',
        `${SITE_IMAGE}?x=1`,
        ` ${SITE_IMAGE}`,
        '/site-images/../api/secret',
      ]) {
        expect(refused(parseFxScene(withSrc(src), allowSiteImage)), src).toMatch(/only show an image uploaded to this site/);
      }
    });

    it('accepts an address the host allows, and an empty one', () => {
      expect(param(ok(parseFxScene(withSrc(SITE_IMAGE), allowSiteImage)).scene, 'image', 'src')).toBe(SITE_IMAGE);
      expect(param(ok(parseFxScene(withSrc(''))).scene, 'image', 'src')).toBe('');
      expect(param(ok(parseFxScene(sceneOf([layer('image')]))).scene, 'image', 'src')).toBe('');
    });

    it('replaces an address that is not text by the empty default, without asking the rule', () => {
      let asked = 0;
      const result = ok(parseFxScene(withSrc({ href: 'https://evil.example' }), { isAllowedImageSrc: () => (asked++, true) }));
      expect(param(result.scene, 'image', 'src')).toBe('');
      expect(asked).toBe(0);
      expect(result.notes).toHaveLength(1);
    });

    it('does not treat a parameter named src on another layer type as an address', () => {
      const result = ok(parseFxScene(sceneOf([layer('grain', { params: { src: 'https://evil.example' } })])));
      expect(result.scene.layers[0].params.src).toBeUndefined();
    });

    it('lists the addresses a scene names', () => {
      const scene = ok(
        parseFxScene(sceneOf([layer('image', { id: 'a', params: { src: SITE_IMAGE } }), layer('image', { id: 'b' }), layer('grain')]), allowSiteImage),
      ).scene;
      expect(fxImageAddresses(scene)).toEqual([SITE_IMAGE]);
    });
  });
});

describe('repairs, each with a note', () => {
  it('leaves out a layer of an unknown type and keeps the rest', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([layer('grain'), layer('customShader'), layer('vignette')])));
    expect(scene.layers.map((l) => l.type)).toEqual(['grain', 'vignette']);
    expect(notes).toEqual(['Layer 2 has the unknown type "customShader" and was left out.']);
  });

  it('leaves out what is not a layer', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([null, 'grain', { id: 'x' }, [], layer('grain')])));
    expect(scene.layers).toHaveLength(1);
    expect(notes).toHaveLength(4);
  });

  it('does not reach a layer type through the prototype of the registry', () => {
    for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(ok(parseFxScene(sceneOf([layer(type)]))).scene.layers).toEqual([]);
    }
  });

  it('cuts text longer than the limit', () => {
    const long = 'x'.repeat(FX_LIMITS.text + 50);
    const { scene, notes } = ok(parseFxScene(sceneOf([layer('text', { params: { headlineText: long, taglineText: 'short' } })])));
    expect(param(scene, 'text', 'headlineText')).toBe('x'.repeat(FX_LIMITS.text));
    expect(param(scene, 'text', 'taglineText')).toBe('short');
    expect(notes).toEqual([expect.stringMatching(/headline: the text was longer than 200 characters and was cut/)]);
  });

  it('keeps text as text: markup is not interpreted, only stored', () => {
    const markup = '<img src=x onerror=alert(1)>';
    expect(param(ok(parseFxScene(sceneOf([layer('text', { params: { headlineText: markup } })]))).scene, 'text', 'headlineText')).toBe(markup);
  });

  it('clamps a number to its range, both ends', () => {
    const high = ok(parseFxScene(sceneOf([layer('image', { params: { opacity: 40 } })])));
    expect(param(high.scene, 'image', 'opacity')).toBe(1);
    expect(high.notes).toEqual([expect.stringMatching(/40 is outside 0 to 1 and was set to 1/)]);
    expect(param(ok(parseFxScene(sceneOf([layer('image', { params: { opacity: -3 } })]))).scene, 'image', 'opacity')).toBe(0);
  });

  it('keeps a number on the edge of its range without a note', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([layer('image', { params: { opacity: 1, scale: 0.25 } })])));
    expect(param(scene, 'image', 'opacity')).toBe(1);
    expect(param(scene, 'image', 'scale')).toBe(0.25);
    expect(notes).toEqual([]);
  });

  it('replaces a value of the wrong kind by the default', () => {
    const defaults = ok(parseFxScene(sceneOf([layer('image'), layer('text')]))).scene;
    const { scene, notes } = ok(
      parseFxScene(
        sceneOf([
          layer('image', { params: { opacity: '0.5', fit: 'stretch', scale: null } }),
          layer('text', { params: { color: 'url(https://evil.example)', headlineText: 12, headlineWeight: 500 } }),
        ]),
      ),
    );
    for (const [id, key] of [['image', 'opacity'], ['image', 'fit'], ['image', 'scale'], ['text', 'color'], ['text', 'headlineText'], ['text', 'headlineWeight']]) {
      expect(param(scene, id, key), `${id}.${key}`).toEqual(param(defaults, id, key));
    }
    expect(notes).toHaveLength(6);
  });

  it('replaces a number that is not finite by the default', () => {
    const defaults = ok(parseFxScene(sceneOf([layer('image')]))).scene;
    // What JSON cannot carry can still arrive from code: a panel, an agent tool.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(param(ok(parseFxScene(sceneOf([layer('image', { params: { opacity: bad } })]))).scene, 'image', 'opacity')).toBe(param(defaults, 'image', 'opacity'));
    }
  });

  it('does not carry a parameter the layer does not have, or a field it does not know', () => {
    const { scene } = ok(parseFxScene(sceneOf([layer('grain', { params: { evil: 1, __proto__: { x: 1 } }, onLoad: 'alert(1)', Component: 'x' })], { script: 'x' })));
    expect(Object.keys(scene)).toEqual(['version', 'id', 'size', 'background', 'fps', 'dpr', 'layers']);
    expect(Object.keys(scene.layers[0]).sort()).toEqual(['blend', 'id', 'name', 'params', 'type', 'visible']);
    expect(Object.keys(scene.layers[0].params)).not.toContain('evil');
  });

  it('gives a layer without a usable id one from its type, and a repeated id a new one', () => {
    const { scene, notes } = ok(
      parseFxScene(sceneOf([layer('grain', { id: 'a' }), layer('grain', { id: 'a' }), layer('grain', { id: 'has space' }), layer('grain', { id: 7 }), layer('grain', { id: 'x'.repeat(65) })])),
    );
    expect(scene.layers.map((l) => l.id)).toEqual(['a', 'a-1', 'grain', 'grain-1', 'grain-2']);
    expect(new Set(scene.layers.map((l) => l.id)).size).toBe(5);
    expect(notes).toHaveLength(4);
  });

  it('cuts a long name and falls back to the label for an empty one', () => {
    const { scene } = ok(parseFxScene(sceneOf([layer('grain', { id: 'a', name: 'n'.repeat(200) }), layer('grain', { id: 'b', name: '   ' }), layer('grain', { id: 'c', name: 5 })])));
    expect(scene.layers[0].name).toBe('n'.repeat(FX_LIMITS.name));
    expect(scene.layers[1].name).toBe('Grain');
    expect(scene.layers[2].name).toBe('Grain');
  });

  it('falls back to normal for an unknown blend mode and to visible for a visibility that is not a boolean', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([layer('grain', { blend: 'difference', visible: 'no' })])));
    expect(scene.layers[0].blend).toBe('normal');
    expect(scene.layers[0].visible).toBe(true);
    expect(notes).toEqual([expect.stringMatching(/blend mode "difference" is unknown/)]);
    expect(ok(parseFxScene(sceneOf([layer('grain', { blend: 'screen', visible: false })]))).scene.layers[0]).toMatchObject({ blend: 'screen', visible: false });
  });

  it('leaves out per-parameter animation, which the engine does not run', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([layer('grain', { animate: { opacity: { speed: 900, drift: 1, phase: 0 } } })])));
    expect(scene.layers[0].animate).toBeUndefined();
    expect(notes).toEqual([expect.stringMatching(/per-parameter animation is not supported/)]);
    expect(ok(parseFxScene(sceneOf([layer('grain', { animate: {} })]))).notes).toEqual([]);
  });

  it('keeps valid pointer settings inside 0 to 1 and leaves out invalid ones', () => {
    const good = ok(parseFxScene(sceneOf([layer('gradient', { interactivity: { trackMouse: 4, momentum: -1, spring: 0.5, axes: 'x', extra: 1 } })])));
    expect(good.scene.layers[0].interactivity).toEqual({ trackMouse: 1, momentum: 0, spring: 0.5, axes: 'x' });
    const bad = ok(parseFxScene(sceneOf([layer('gradient', { interactivity: { trackMouse: 1, momentum: 0, spring: 0.5, axes: 'z' } })])));
    expect(bad.scene.layers[0].interactivity).toBeUndefined();
    expect(bad.notes).toHaveLength(1);
  });

  it('uses black for a background that is not a colour: no address reaches CSS', () => {
    for (const background of ['url(https://evil.example/pixel.png)', 'red; background-image: url(//evil.example)', 'expression(alert(1))', 'var(--x)', 'linear-gradient(red, blue)', 12, null, '#12', '#xyzxyz']) {
      const { scene, notes } = ok(parseFxScene(sceneOf([], { background })));
      expect(scene.background, String(background)).toBe('#000000');
      expect(notes).toHaveLength(1);
    }
  });

  it('accepts hex and numeric colour forms', () => {
    for (const colour of ['#fff', '#ffff', '#08080b', '#08080bcc', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(210 40% 50%)', 'hsl(210deg, 40%, 50%)', 'rgb(1 2 3 / 50%)']) {
      expect(isFxColor(colour), colour).toBe(true);
      expect(ok(parseFxScene(sceneOf([], { background: colour }))).scene.background).toBe(colour);
    }
    for (const colour of ['rgb(url(x))', 'rgb(1,2)', 'red', '', `#${'f'.repeat(9)}`, `rgb(${'1,'.repeat(40)}1)`]) {
      expect(isFxColor(colour), colour).toBe(false);
    }
  });

  it('keeps the pixel ratio range inside 1 to 1.75, low end first', () => {
    expect(ok(parseFxScene(sceneOf([], { dpr: [0.25, 4] }))).scene.dpr).toEqual([1, 1.75]);
    expect(ok(parseFxScene(sceneOf([], { dpr: [1.5, 1.2] }))).scene.dpr).toEqual([1.5, 1.5]);
    expect(ok(parseFxScene(sceneOf([], { dpr: [1, 1.5] }))).notes).toEqual([]);
    expect(ok(parseFxScene(sceneOf([], { dpr: 'high' }))).scene.dpr).toEqual([1, 1.75]);
    expect(ok(parseFxScene(sceneOf([], { dpr: [1, Number.NaN] }))).scene.dpr).toEqual([1, 1.75]);
  });

  it('uses 60 for an unknown frame rate, the scene id default for an unusable id, and ignores a fixed size', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([], { fps: 144, id: '../x', size: { mode: 'fixed', width: 99999, height: 99999 } })));
    expect(scene.fps).toBe(60);
    expect(scene.id).toBe('scene');
    expect(scene.size).toEqual({ mode: 'fill' });
    expect(notes).toHaveLength(3);
  });
});

describe('the layer a post pass reads', () => {
  const rays = (source: unknown) => layer('godRays', { params: { sourceLayerId: source } });

  it('keeps a source that names a content layer of the scene and offers the content layers as choices', () => {
    const { scene, notes } = ok(parseFxScene(sceneOf([layer('gradient', { id: 'bg' }), layer('text', { id: 'title' }), rays('title'), layer('grain')])));
    expect(scene.layers[2].params.sourceLayerId).toMatchObject({ value: 'title', options: ['bg', 'title'] });
    expect(notes).toEqual([]);
  });

  it('moves a source that names no content layer to the first one', () => {
    for (const source of ['missing', 'grain', 5, undefined]) {
      const { scene } = ok(parseFxScene(sceneOf([layer('gradient', { id: 'bg' }), rays(source), layer('grain')])));
      expect(scene.layers[1].params.sourceLayerId).toMatchObject({ value: 'bg', options: ['bg'] });
    }
  });

  it('falls back to the default when the scene has no content layer, never keeping the stored text', () => {
    const fallback = ok(parseFxScene(sceneOf([layer('godRays')]))).scene.layers[0].params.sourceLayerId;
    for (const source of ['missing', 'x'.repeat(100_000), '<script>', 5]) {
      const { scene, notes } = ok(parseFxScene(sceneOf([rays(source), layer('grain')])));
      expect(scene.layers[0].params.sourceLayerId).toEqual(fallback);
      expect(notes).toEqual([]);
    }
  });
});

describe('the stored envelope', () => {
  const envelope = (extra: Raw = {}): Raw => ({ version: 1, scene: clone(hubHero), start: 'visible', calm: 'frame', ...extra });

  it('reads a scene with its start and reduced motion settings', () => {
    const result = parseFx(envelope());
    if (!result.ok) throw new Error(result.message);
    expect(result.fx.start).toBe('visible');
    expect(result.fx.calm).toBe('frame');
    expect(result.fx.scene.id).toBe('lumitra-hub-hero');
    expect(result.notes).toEqual([]);
  });

  it('defaults to what lumitra.co does: start when settled, the background under reduced motion', () => {
    const result = parseFx({ version: 1, scene: clone(hubHero) });
    if (!result.ok) throw new Error(result.message);
    expect(result.fx).toMatchObject({ start: 'settled', calm: 'background' });
    expect(result.notes).toEqual([]);
  });

  it('notes an unknown start or reduced motion setting and uses the default', () => {
    const result = parseFx(envelope({ start: 'now', calm: 'video' }));
    if (!result.ok) throw new Error(result.message);
    expect(result.fx).toMatchObject({ start: 'settled', calm: 'background' });
    expect(result.notes).toHaveLength(2);
  });

  it('refuses a missing envelope, a missing version and a version it does not read', () => {
    for (const bad of [undefined, null, 'x', [], 3]) expect(refused(parseFx(bad))).toBe('This box has no FX scene.');
    expect(refused(parseFx({ scene: clone(hubHero) }))).toMatch(/no format version/);
    expect(refused(parseFx(envelope({ version: 2 })))).toMatch(/format "2".*reads format 1/);
    expect(refused(parseFx(envelope({ version: '1' })))).toMatch(/format/);
  });

  it('passes on a refusal of the scene', () => {
    expect(refused(parseFx(envelope({ scene: undefined })))).toMatch(/empty or not a scene/);
    const foreign = clone(hubHero) as { layers: unknown[] };
    foreign.layers.push(layer('image', { params: { src: 'https://evil.example/x.png' } }));
    expect(refused(parseFx(envelope({ scene: foreign }), allowSiteImage))).toMatch(/image address that is not allowed/);
  });

  it('stores values only, and reading what was stored gives the same result', () => {
    const first = parseFx(envelope());
    if (!first.ok) throw new Error(first.message);
    const stored = toStoredFx(first.fx);
    expect(stored).toMatchObject({ version: 1, start: 'visible', calm: 'frame' });
    expect(stored.scene).toEqual(clone(hubHero));
    expect(JSON.stringify(stored)).not.toMatch(/"min"|"max"|"options"|"step"/);
    const second = parseFx(clone(stored));
    if (!second.ok) throw new Error(second.message);
    expect(second.fx).toEqual(first.fx);
    expect(second.notes).toEqual([]);
  });

  it('a repaired scene is stable: storing and reading it again repairs nothing more', () => {
    const messy = sceneOf([layer('grain', { id: 'a' }), layer('grain', { id: 'a' }), layer('image', { params: { opacity: 9 } }), layer('nope')], { background: 'url(x)' });
    const first = parseFx({ version: 1, scene: messy });
    if (!first.ok) throw new Error(first.message);
    expect(first.notes.length).toBeGreaterThan(0);
    const second = parseFx(toStoredFx(first.fx));
    if (!second.ok) throw new Error(second.message);
    expect(second.notes).toEqual([]);
    expect(second.fx).toEqual(first.fx);
  });
});
