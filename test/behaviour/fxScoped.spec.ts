// Effects that apply to one content layer (src/lib/fx, `Layer.target`), drawn by the real
// engine in real Chromium. The engine is bundled from source with esbuild and mounted on a
// blank page, like the pixel oracle does for the frozen reference (test/fx-oracle): no
// server and no build of the app is needed, only the browser.
//
// Every claim has a positive control: a picture must DIFFER from the same scene without
// the effect, otherwise "the effect stayed inside its layer" would also pass when
// targeting does nothing at all.
//
// The first half of these proofs; the second half, from adding and removing a scoped effect in a mounted scene on,
// is fxScopedMounted.spec.ts. Both draw on fxScopedStage.ts.

import { describe, expect, it } from 'vitest';
import { HEIGHT, WIDTH, difference } from '../fx-oracle/oracle';
import { PNG as PngWriter, type PNG } from 'pngjs';
import { type Raw, layer, scene, gradient, text, pixelate, session, draw, px, differing, textBox, registerScopedStage } from './fxScopedStage';

registerScopedStage();

describe('effects that apply to one layer', () => {
  it('pixelate on the text changes the text and nothing else (positive control: it differs from the plain scene)', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    const scoped = (await draw(scene([gradient(), text(), pixelate('t')]))).picture;
    const wholeScene = (await draw(scene([gradient(), text(), pixelate()]))).picture;
    const box = await textBox(40);
    expect(differing(scoped, plain, { ...box, inside: true })).toBeGreaterThan(200); // the effect is there
    expect(differing(scoped, plain, box)).toBe(0); // and stays inside the layer's area
    expect(differing(wholeScene, plain, box)).toBeGreaterThan(200); // the same effect on the whole scene does reach outside
  }, 120_000);

  it('works on a layer that is not the text (a gradient), and a different chain of two effects gives a different picture', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    const scoped = (await draw(scene([gradient(), text(), pixelate('g')]))).picture;
    const wholeScene = (await draw(scene([gradient(), text(), pixelate()]))).picture;
    expect(difference(scoped, plain).share).toBeGreaterThan(0.01);
    expect(difference(scoped, wholeScene).differing).toBeGreaterThan(100); // not the whole-scene effect either
    // A convolution effect (bloom) is a pass of its own, which changes where the finished picture sits.
    const chain = (await draw(scene([gradient(), text(), pixelate('t'), layer('bl', 'bloom', { intensity: 2.5, threshold: 0.1, radius: 0.9 }, { target: 't' })]))).picture;
    const single = (await draw(scene([gradient(), text(), pixelate('t')]))).picture;
    expect(difference(chain, single).differing).toBeGreaterThan(100);
    expect(difference(chain, plain).differing).toBeGreaterThan(100);
  }, 120_000);

  it('grain on the text leaves the pixels outside the text unchanged', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    const scoped = (await draw(scene([gradient(), text(), layer('gr', 'grain', { opacity: 1 }, { target: 't' })]))).picture;
    const box = await textBox(8);
    expect(differing(scoped, plain, { ...box, inside: true })).toBeGreaterThan(100);
    expect(differing(scoped, plain, box)).toBe(0);
  }, 120_000);

  it('a hidden target draws without its effect, never on the whole scene', async () => {
    const hidden = (await draw(scene([gradient(), text({ visible: false }), pixelate('t')]))).picture;
    const plain = (await draw(scene([gradient(), text({ visible: false })]))).picture;
    expect(difference(hidden, plain).differing).toBe(0);
  }, 120_000);

  it('a target that is not valid is dropped with a note and the effect applies to the whole scene', async () => {
    const dangling = await draw(scene([gradient(), text(), pixelate('gone')]));
    const whole = (await draw(scene([gradient(), text(), pixelate()]))).picture;
    expect(dangling.notes.join(' ')).toContain('not a layer of this scene');
    expect(difference(dangling.picture, whole).differing).toBe(0);
  }, 120_000);

  it('keeps the order of two layers at the same depth', async () => {
    const shape = (id: string, colorA: string) => layer(id, 'shape', { colorA, colorB: colorA, colorC: colorA, colorD: colorA });
    const noop = (target?: string) => layer('vg', 'vignette', { darkness: 0 }, target ? { target } : {});
    const plain = (await draw(scene([shape('s1', '#ff0000'), shape('s2', '#00ff00')]))).picture;
    const scoped = (await draw(scene([shape('s1', '#ff0000'), shape('s2', '#00ff00'), noop('s1')]))).picture;
    expect(px(plain, WIDTH / 2, HEIGHT / 2)[1]).toBeGreaterThan(px(plain, WIDTH / 2, HEIGHT / 2)[0]); // the later layer is on top
    expect(difference(scoped, plain).share).toBeLessThan(0.002);
  }, 120_000);

  it('a no-op effect on a layer with a screen or multiply blend leaves the picture as it was', async () => {
    // The text lockup applies its stored blend like the other layers (rows for it are in the describe of
    // every content layer below); here the scoped and the unscoped pictures must agree for each blend.
    for (const blend of ['screen', 'multiply', 'add']) {
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 't' });
      const plain = (await draw(scene([gradient(), text({ blend })]))).picture;
      const scoped = (await draw(scene([gradient(), text({ blend }), noop]))).picture;
      expect.soft(difference(scoped, plain).share, blend).toBeLessThan(0.002);
      // Positive control: a real effect on the same layer does change the picture, inside its box only.
      const real = (await draw(scene([gradient(), text({ blend }), layer('px2', 'pixelate', { granularity: 24 }, { target: 't' })]))).picture;
      const box = await textBox(40);
      expect.soft(differing(real, plain, { ...box, inside: true }), `${blend} with a real effect`).toBeGreaterThan(50);
      expect.soft(differing(real, plain, box), `${blend} outside the box`).toBe(0);
    }
  }, 180_000);

  it('a no-op effect on a layer that really applies its blend (noise field) leaves the picture as it was', async () => {
    const noise = (blend: string, extra: Raw = {}) => layer('n', 'noiseFill', { intensity: 0.8 }, { blend, ...extra });
    for (const blend of ['add', 'screen', 'multiply', 'overlay']) {
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'n' });
      const plain = (await draw(scene([gradient(), noise(blend)]))).picture;
      const scoped = (await draw(scene([gradient(), noise(blend), noop]))).picture;
      expect.soft(difference(scoped, plain).share, blend).toBeLessThan(0.002);
      const normal = (await draw(scene([gradient(), noise('normal')]))).picture;
      expect.soft(difference(plain, normal).differing, `${blend} differs from normal`).toBeGreaterThan(1000);
      const real = (await draw(scene([gradient(), noise(blend), layer('px', 'pixelate', { granularity: 24 }, { target: 'n' })]))).picture;
      expect.soft(difference(real, plain).differing, `${blend} with a real effect`).toBeGreaterThan(100);
    }
  }, 240_000);

  describe('multiply', () => {
    const background = '#ff8040';
    const flat = (colour: string, opacity = 1, extra: Raw = {}) =>
      layer('f', 'gradient', { colorA: colour, colorB: colour, colorC: colour, colorD: colour, opacity }, { blend: 'multiply', ...extra });
    const withBackground = (layers: Raw[]): Raw => ({ ...scene(layers), background });
    const middle = (png: PNG) => px(png, WIDTH / 2, HEIGHT / 2);

    const solidImage = (): string => {
      const png = new PngWriter({ width: 64, height: 64 });
      for (let i = 0; i < png.data.length; i += 4) png.data.set([0x80, 0xc0, 0xff, 255], i);
      return `data:image/png;base64,${PngWriter.sync.write(png).toString('base64')}`;
    };
    const flatShape = (colour: string): Raw => layer('f', 'shape', { color: colour, opacity: 1, wobble: 0 }, { blend: 'multiply' });
    const flatImage = (): Raw => layer('f', 'image', { src: solidImage(), opacity: 1, fit: 'cover' }, { blend: 'multiply' });

    it.each([
      ['gradient', () => flat('#80c0ff')],
      ['shape', () => flatShape('#80c0ff')],
      ['image', flatImage],
    ] as const)('a %s layer of a known colour over a known background gives the product, per channel, without a console error', async (_name, make) => {
      const result = await draw(withBackground([make()]));
      const [r, g, b] = middle(result.picture);
      // 0xff * 0x80 / 255, 0x80 * 0xc0 / 255, 0x40 * 0xff / 255 (the framebuffer holds encoded colour, so the product is of encoded values)
      expect.soft(Math.abs(r - 128), `red ${r}`).toBeLessThanOrEqual(3);
      expect.soft(Math.abs(g - 96), `green ${g}`).toBeLessThanOrEqual(3);
      expect.soft(Math.abs(b - 64), `blue ${b}`).toBeLessThanOrEqual(3);
      expect(result.consoleErrors.filter((message) => message.includes('MultiplyBlending')), 'three.js refuses the blend').toEqual([]);
    }, 120_000);

    it('a layer that is not drawn leaves the background as it is, and a half-drawn one is half way to the product', async () => {
      const empty = (await draw(withBackground([]))).picture;
      const hidden = (await draw(withBackground([flat('#000000', 0)]))).picture;
      expect(difference(hidden, empty).differing, 'opacity 0, black').toBe(0);
      const half = middle((await draw(withBackground([flat('#000000', 0.5)]))).picture);
      const bg = middle(empty);
      // Black at half alpha: destination x (1 - 0.5 + 0.5 x 0) = half the background.
      expect.soft(Math.abs(half[0] - bg[0] / 2), `red ${half[0]} of ${bg[0]}`).toBeLessThanOrEqual(3);
      expect.soft(Math.abs(half[1] - bg[1] / 2), `green ${half[1]} of ${bg[1]}`).toBeLessThanOrEqual(3);
      expect.soft(Math.abs(half[2] - bg[2] / 2), `blue ${half[2]} of ${bg[2]}`).toBeLessThanOrEqual(3);
    }, 120_000);

    it('a scoped no-op effect on a multiply layer leaves the same product, and a real one changes it', async () => {
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'f' });
      const plain = (await draw(withBackground([flat('#80c0ff')]))).picture;
      const scoped = (await draw(withBackground([flat('#80c0ff'), noop]))).picture;
      expect(difference(scoped, plain).share).toBeLessThan(0.002);
      const [r, g, b] = middle(scoped);
      expect.soft(Math.abs(r - 128), `red ${r}`).toBeLessThanOrEqual(3);
      expect.soft(Math.abs(g - 96), `green ${g}`).toBeLessThanOrEqual(3);
      expect.soft(Math.abs(b - 64), `blue ${b}`).toBeLessThanOrEqual(3);
      const real = (await draw(withBackground([flat('#80c0ff'), layer('vg2', 'vignette', { darkness: 1, offset: 0 }, { target: 'f' })]))).picture;
      expect(difference(real, plain).differing, 'a real effect').toBeGreaterThan(1000);
      // Where the layer is partly or not at all drawn the quad has to agree with the layer itself.
      for (const opacity of [0.5, 0]) {
        const unscoped = (await draw(withBackground([flat('#80c0ff', opacity)]))).picture;
        const scopedToo = (await draw(withBackground([flat('#80c0ff', opacity), noop]))).picture;
        expect.soft(difference(scopedToo, unscoped).share, `opacity ${opacity}`).toBeLessThan(0.002);
        if (opacity === 0.5) expect.soft(difference(unscoped, plain).differing, 'half drawn differs from fully drawn').toBeGreaterThan(1000);
      }
    }, 180_000);

    // The noise's alpha peaks at 1.008 (1.1 times a vignette that is 0.92 at its brightest), so this row cannot see a
    // missing clamp: that is guarded by the source tests in contentBlend.test.ts (layers and quad). What it does show is
    // that scoped and unscoped multiply agree at the highest intensity the schema allows.
    it('a noise field at full intensity: scoped and unscoped give the same picture', async () => {
      const noise = layer('n', 'noiseFill', { intensity: 1 }, { blend: 'multiply' });
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'n' });
      const unscoped = (await draw(withBackground([noise]))).picture;
      const scoped = (await draw(withBackground([noise, noop]))).picture;
      expect(difference(scoped, unscoped).share).toBeLessThan(0.002);
      expect(difference(unscoped, (await draw(withBackground([]))).picture).differing, 'the noise multiplies something').toBeGreaterThan(1000);
    }, 180_000);

    // At opacity 0.5: premultiplying twice (the group's buffer must hold plain colour) only shows where alpha is below 1.
    it('a blend changed in a mounted scene, multiply to normal and back at half opacity, with and without an effect on the layer', async () => {
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'f' });
      const cases: Array<[string, Raw, Raw]> = [
        ['unscoped', withBackground([flat('#80c0ff', 0.5)]), withBackground([flat('#80c0ff', 0.5, { blend: 'normal' })])],
        ['scoped', withBackground([flat('#80c0ff', 0.5), noop]), withBackground([flat('#80c0ff', 0.5, { blend: 'normal' }), noop])],
      ];
      for (const [name, multiply, normal] of cases) {
        const fresh = { multiply: (await draw(multiply)).picture, normal: (await draw(normal)).picture };
        expect(difference(fresh.multiply, fresh.normal).differing, `${name}: the two differ`).toBeGreaterThan(1000);
        const edits = await session(multiply);
        for (const [step, next] of [['normal', normal], ['multiply', multiply], ['normal', normal], ['multiply', multiply]] as const) {
          expect(difference(await edits.show(next), fresh[step]).differing, `${name}: ${step}`).toBe(0);
        }
      }
    }, 300_000);
  });

  it('a blend changed in a mounted scene drawn on demand (reduced motion) reaches the picture', async () => {
    const noise = (blend: string) => layer('n', 'noiseFill', { intensity: 0.8 }, { blend });
    const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'n' });
    const added = scene([gradient(), noise('add'), noop]);
    const normal = scene([gradient(), noise('normal'), noop]);
    const fresh = { add: (await draw(added)).picture, normal: (await draw(normal)).picture };
    expect(difference(fresh.add, fresh.normal).differing).toBeGreaterThan(1000); // the two differ, so the checks can fail
    const edits = await session(added);
    for (const [name, next] of [['normal', normal], ['add', added], ['normal', normal]] as const) {
      expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
    }
  }, 240_000);

  it('a setting changed in a mounted scene drawn on demand reaches the picture (the layers write uniforms from effects)', async () => {
    const noise = (intensity: number) => layer('n', 'noiseFill', { intensity }, { blend: 'add' });
    const low = scene([gradient(), noise(0.1)]);
    const high = scene([gradient(), noise(0.9)]);
    const fresh = { low: (await draw(low)).picture, high: (await draw(high)).picture };
    expect(difference(fresh.low, fresh.high).differing).toBeGreaterThan(1000);
    const edits = await session(low);
    for (const [name, next] of [['high', high], ['low', low], ['high', high]] as const) {
      expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
    }
  }, 240_000);

  describe('a scene drawn on demand shows every change made in place', () => {
    const noise = (intensity: number, blend = 'add') => layer('n', 'noiseFill', { intensity }, { blend });
    const solid = () => {
      const png = new PngWriter({ width: 64, height: 64 });
      for (let i = 0; i < png.data.length; i += 4) png.data.set([220, 40, 40, 255], i);
      return `data:image/png;base64,${PngWriter.sync.write(png).toString('base64')}`;
    };

    it('adds and removes a layer', async () => {
      const without = scene([gradient()]);
      const withNoise = scene([gradient(), noise(0.9)]);
      const fresh = { without: (await draw(without)).picture, withNoise: (await draw(withNoise)).picture };
      expect(difference(fresh.without, fresh.withNoise).differing).toBeGreaterThan(1000);
      const edits = await session(without);
      for (const [name, next] of [['withNoise', withNoise], ['without', without], ['withNoise', withNoise]] as const) {
        expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
      }
    }, 240_000);

    it('shows an image that loads after the scene is drawn (the layer re-renders from its own state, the scene does not change)', async () => {
      const image = layer('im', 'image', { src: solid(), opacity: 1 });
      const plain = scene([gradient()]);
      const withImage = scene([gradient(), image]);
      const fresh = { plain: (await draw(plain)).picture, withImage: (await draw(withImage)).picture };
      expect(difference(fresh.plain, fresh.withImage).differing).toBeGreaterThan(1000);
      const edits = await session(plain);
      expect(difference(await edits.show(withImage), fresh.withImage).differing).toBe(0);
    }, 240_000);

    it('in development under StrictMode (effects mounted, unmounted and mounted again): same pictures, a group that comes and goes leaves nothing behind, no frame loop', async () => {
      const without = scene([gradient(), noise(0.9)]);
      const withGroup = scene([gradient(), noise(0.9), layer('px', 'pixelate', { granularity: 24 }, { target: 'n' })]);
      const fresh = { without: (await draw(without)).picture, withGroup: (await draw(withGroup)).picture };
      expect(difference(fresh.without, fresh.withGroup).differing).toBeGreaterThan(1000);
      // Reference: the same scenes in the production build, which mounts everything once.
      const reference = await session(without);
      await reference.show(withGroup);
      await reference.show(without);
      const settled = await reference.live();
      const edits = await session(without, { dev: true });
      for (const [name, next] of [['withGroup', withGroup], ['without', without], ['withGroup', withGroup], ['without', without], ['withGroup', withGroup], ['without', without]] as const) {
        expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
      }
      // Every mount ran its effects twice here; what the double mount left would show against the production count.
      const after = await edits.live();
      expect(after.textures, 'textures').toBeLessThanOrEqual(settled.textures);
      expect(after.framebuffers, 'framebuffers').toBeLessThanOrEqual(settled.framebuffers);
      expect(await edits.idle(800), 'frames requested while nothing changes').toBe(0);
    }, 300_000);

    it('asks for no frame when nothing changes, and for a few when the scene does', async () => {
      const edits = await session(scene([gradient(), noise(0.5)]));
      expect(await edits.idle(800), 'idle after the first frame').toBe(0);
      const before = await edits.frames();
      await edits.show(scene([gradient(), noise(0.9)]));
      const used = (await edits.frames()) - before;
      expect(used, 'frames for one change').toBeGreaterThan(0);
      expect(used, 'frames for one change').toBeLessThanOrEqual(6);
      expect(await edits.idle(800), 'idle after the change').toBe(0);
      // The same scene stored again is a new object: one more pass, then quiet again.
      await edits.show(scene([gradient(), noise(0.9)]));
      expect(await edits.idle(800), 'idle after the same scene again').toBe(0);
    }, 240_000);
  });

  describe('scoped text with a stored blend: the scoped picture is the unscoped one', () => {
    const scopedText = (blend: string) => scene([gradient(), text({ blend }), layer('vg', 'vignette', { darkness: 0 }, { target: 't' })]);
    const unscopedText = (blend: string) => scene([gradient(), text({ blend })]);

    it('a frame drawn long after the edit equals the unscoped text with the same blend, deterministically', async () => {
      const normal = (await draw(unscopedText('normal'))).picture;
      for (const blend of ['add', 'screen', 'overlay', 'multiply']) {
        const unscoped = (await draw(unscopedText(blend))).picture;
        expect.soft(difference(unscoped, normal).differing, `${blend} differs from normal`).toBeGreaterThan(50);
        const edits = await session(scopedText(blend));
        expect.soft(difference(await edits.reflow(), unscoped).share, `${blend} after a reflow`).toBeLessThan(0.002);
      }
    }, 300_000);

    it('a blend changed in a mounted scene shows in the frame of the edit and after it, scoped like unscoped', async () => {
      const fresh: Record<string, PNG> = {};
      for (const blend of ['normal', 'add', 'screen', 'overlay', 'multiply']) fresh[blend] = (await draw(unscopedText(blend))).picture;
      const edits = await session(scopedText('normal'));
      for (const blend of ['add', 'screen', 'normal', 'overlay', 'multiply', 'normal']) {
        // The frame the edit itself produces is the one a visitor with reduced motion keeps.
        expect.soft(difference(await edits.show(scopedText(blend)), fresh[blend]).share, `${blend}, the edit's own frame`).toBeLessThan(0.002);
        expect.soft(difference(await edits.reflow(), fresh[blend]).share, `${blend}, after a reflow`).toBeLessThan(0.002);
      }
    }, 300_000);
  });

});
