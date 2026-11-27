// Effects that apply to one content layer (src/lib/fx, `Layer.target`), the second half: adding and removing them in
// a mounted scene, every content layer's stored blend, the step down on a phone, the particle ring among other
// layers, and that nothing is left behind. The first half and the method (real engine, real Chromium, a positive
// control for every claim) are in fxScoped.spec.ts; both draw on fxScopedStage.ts.

import { describe, expect, it } from 'vitest';
import { listLayerSchemas } from '@/lib/fx/format';
import { CHANNEL_TOLERANCE, HEIGHT, WIDTH, difference } from '../fx-oracle/oracle';
import { PNG as PngWriter, type PNG } from 'pngjs';
import { type Raw, layer, scene, gradient, text, pixelate, session, draw, px, registerScopedStage } from './fxScopedStage';

registerScopedStage();

describe('effects that apply to one layer', () => {
  it('adds and removes an effect that applies to one layer in a mounted scene (on, off, on)', async () => {
    const without = scene([gradient(), layer('n', 'noiseFill', { intensity: 0.9 }, { blend: 'add' })]);
    const withEffect = scene([...(without.layers as Raw[]), pixelate('n', 24)]);
    const fresh = { without: (await draw(without)).picture, withEffect: (await draw(withEffect)).picture };
    expect(difference(fresh.without, fresh.withEffect).differing).toBeGreaterThan(1000);
    const edits = await session(without);
    for (const [name, next] of [['withEffect', withEffect], ['without', without], ['withEffect', withEffect], ['without', without]] as const) {
      expect(difference(await edits.show(next), fresh[name]).differing, name).toBe(0);
    }
  }, 240_000);

  it('after the last targeted effect is removed, a layer added later is drawn in front as stored (the ranks the group gave are reset)', async () => {
    const noise = layer('n', 'noiseFill', { intensity: 0.9 }, { blend: 'add' });
    const grouped = scene([gradient(), noise, pixelate('n', 24)]);
    const ungrouped = scene([gradient(), noise]);
    const withText = scene([gradient(), noise, text()]);
    const fresh = (await draw(withText)).picture;
    const edits = await session(grouped); // the group ranks the layers: gradient 0, noise 1
    await edits.show(ungrouped); // the last group is gone
    // A new layer starts at render order 0: left-over ranks would draw the noise field over it.
    expect(difference(await edits.show(withText), fresh).differing).toBe(0);
  }, 240_000);

  describe('every content layer applies its stored blend', () => {
    const background = '#606060';
    const withBackground = (layers: Raw[]): Raw => ({ ...scene(layers), background });
    const solidPng = (): string => {
      const png = new PngWriter({ width: 64, height: 64 });
      for (let i = 0; i < png.data.length; i += 4) png.data.set([0xdf, 0xe6, 0xff, 255], i);
      return `data:image/png;base64,${PngWriter.sync.write(png).toString('base64')}`;
    };
    /** What each kind needs to show something with a blend over the background; everything else is drawn from its defaults. */
    const visible: Record<string, Raw> = {
      noiseFill: { intensity: 0.8 },
      image: { src: solidPng(), opacity: 1 },
      textBox: { text: 'Blend', size: 0.25 },
    };
    const only = (type: string, blend: string): Raw => withBackground([layer('l', type, visible[type] ?? {}, { blend })]);
    /** The pixels a layer changes over the plain background, and the mean of the three channels there. */
    const box = (a: PNG, b: PNG): Array<[number, number]> => {
      const mask: Array<[number, number]> = [];
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        const [r1, g1, b1] = px(a, x, y);
        const [r2, g2, b2] = px(b, x, y);
        if (Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) > CHANNEL_TOLERANCE) mask.push([x, y]);
      }
      return mask;
    };
    /** The mean of the three channels over the pixels the layer changed (a mask, not its box, whose corners are background). */
    const mean = (png: PNG, mask: Array<[number, number]>): number => {
      let sum = 0;
      for (const [x, y] of mask) {
        const [r, g, b] = px(png, x, y);
        sum += r + g + b;
      }
      return sum / Math.max(1, mask.length * 3);
    };

    it.each(['text', 'textBox'])('a %s layer is lighter with add and screen, and darker with multiply, than with a normal blend', async (type) => {
      const normal = (await draw(only(type, 'normal'))).picture;
      const plain = (await draw(withBackground([]))).picture;
      const area = box(normal, plain);
      expect(area.length, 'the layer is on the picture').toBeGreaterThan(200);
      const base = mean(normal, area);
      for (const blend of ['add', 'screen']) {
        const picture = (await draw(only(type, blend))).picture;
        expect.soft(mean(picture, area) - base, `${type} ${blend}: lighter than normal`).toBeGreaterThan(2);
      }
      const multiplied = (await draw(only(type, 'multiply'))).picture;
      expect.soft(base - mean(multiplied, area), `${type} multiply: darker than normal`).toBeGreaterThan(2);
    }, 240_000);

    it('a text box at half opacity with multiply: scoped equals unscoped, and nothing is lighter than the background', async () => {
      const textBoxAt = (extra: Raw[] = []): Raw => withBackground([layer('l', 'textBox', { text: 'Blend', size: 0.25, opacity: 0.5 }, { blend: 'multiply' }), ...extra]);
      const noop = layer('vg', 'vignette', { darkness: 0 }, { target: 'l' });
      const plain = (await draw(withBackground([]))).picture;
      const unscoped = (await draw(textBoxAt())).picture;
      const scoped = (await draw(textBoxAt([noop]))).picture;
      expect(difference(unscoped, plain).differing, 'the text box is on the picture').toBeGreaterThan(200);
      // Every text pixel is partly drawn here, which is where premultiplying twice (the group's reset missing)
      // changes the picture, and where colour that is not premultiplied lightens it (multiply never lightens).
      expect.soft(difference(scoped, unscoped).share, 'scoped equals unscoped').toBeLessThan(0.002);
      for (const [name, picture] of [['unscoped', unscoped], ['scoped', scoped]] as const) {
        let lighter = 0;
        for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
          const [r, g, b] = px(picture, x, y);
          const [r0, g0, b0] = px(plain, x, y);
          if (Math.max(r - r0, g - g0, b - b0) > CHANNEL_TOLERANCE) lighter++;
        }
        expect.soft(lighter, `${name}: pixels lighter than the background`).toBe(0);
      }
    }, 240_000);

    it('every content layer in the registry changes the picture with add, screen, overlay and multiply compared with normal', async () => {
      // A kind with one fixed blend (the particle ring always adds) is held by the next test instead.
      const types = listLayerSchemas().filter((schema) => schema.kind === 'content' && !schema.fixedBlend).map((schema) => schema.type);
      expect(types.length).toBeGreaterThanOrEqual(6);
      for (const type of types) {
        const normal = (await draw(only(type, 'normal'))).picture;
        for (const blend of ['add', 'screen', 'overlay', 'multiply']) {
          const picture = (await draw(only(type, blend))).picture;
          expect.soft(difference(picture, normal).differing, `${type} with ${blend} differs from normal`).toBeGreaterThan(50);
        }
      }
    }, 600_000);

    it('a content layer with a fixed blend draws the same picture whatever blend a scene stores for it', async () => {
      const fixed = listLayerSchemas().filter((schema) => schema.kind === 'content' && schema.fixedBlend);
      expect(fixed.map((schema) => schema.type)).toContain('particleRing');
      const plain = (await draw(withBackground([]))).picture;
      for (const schema of fixed) {
        const own = (await draw(only(schema.type, schema.fixedBlend!))).picture;
        expect(difference(own, plain).differing, `${schema.type} is on the picture`).toBeGreaterThan(200);
        for (const blend of ['normal', 'screen', 'overlay', 'multiply']) {
          const picture = (await draw(only(schema.type, blend))).picture;
          expect.soft(difference(picture, own).differing, `${schema.type} stored as ${blend} draws as ${schema.fixedBlend}`).toBe(0);
        }
      }
    }, 240_000);
  });

  it('on a phone the step down leaves out a heavy effect of a group, and the layer is drawn plainly', async () => {
    const bloom = layer('bl', 'bloom', { intensity: 2.5, threshold: 0.1, radius: 0.9 }, { target: 't' });
    const plainPhone = (await draw(scene([gradient(), text()]), { touch: true })).picture;
    const phone = (await draw(scene([gradient(), text(), bloom]), { touch: true })).picture;
    expect(difference(phone, plainPhone).differing).toBe(0);
    // Positive control: on a desktop the same bloom is there.
    const desktopPlain = (await draw(scene([gradient(), text()]))).picture;
    const desktop = (await draw(scene([gradient(), text(), bloom]))).picture;
    expect(difference(desktop, desktopPlain).differing).toBeGreaterThan(100);
  }, 180_000);

  describe('the particle ring among other layers', () => {
    const ring = (extra: Raw = {}) => layer('r', 'particleRing', {}, { blend: 'add', ...extra });
    const vignette = (target: string) => layer('vg', 'vignette', { offset: 0.2, darkness: 0.9 }, { target });

    it('stays under a text layer stored after it, after it is hidden and shown again, and whatever the stored order', async () => {
      const ringText = scene([ring(), text()]);
      const hidden = scene([ring({ visible: false }), text()]);
      const fresh = { ringText: (await draw(ringText)).picture, hidden: (await draw(hidden)).picture, ringOnly: (await draw(scene([ring()]))).picture };
      expect(difference(fresh.ringText, fresh.ringOnly).differing, 'the text is on the picture').toBeGreaterThan(200);
      expect(difference(fresh.ringText, fresh.hidden).differing, 'the ring is on the picture').toBeGreaterThan(200);
      // A ring shown again is a new object, newer than the text: what it covers must not depend on that.
      const edits = await session(ringText);
      for (const [name, next] of [['hidden', hidden], ['shown', ringText], ['hidden', hidden], ['shown', ringText]] as const) {
        expect(difference(await edits.show(next), name === 'hidden' ? fresh.hidden : fresh.ringText).differing, name).toBe(0);
      }
      expect(difference((await draw(scene([text(), ring()]))).picture, fresh.ringText).differing, 'text stored first').toBe(0);
    }, 240_000);

    it('adds its light over a fill stored after it, and the fill stays visible', async () => {
      const both = (await draw(scene([ring(), gradient()]))).picture;
      expect(difference(both, (await draw(scene([ring()]))).picture).differing, 'the gradient is on the picture').toBeGreaterThan(200);
      expect(difference(both, (await draw(scene([gradient()]))).picture).differing, 'the ring is on the picture').toBeGreaterThan(200);
    }, 180_000);

    it('is drawn inside a group, with an effect on the ring alone', async () => {
      const plain = (await draw(scene([]))).picture;
      const alone = (await draw(scene([ring()]))).picture;
      const grouped = (await draw(scene([ring(), vignette('r')]))).picture;
      expect(difference(grouped, plain).differing, 'the ring is on the picture').toBeGreaterThan(200);
      expect(difference(grouped, alone).differing, 'the vignette changes the ring').toBeGreaterThan(200);
    }, 180_000);
  });

  it('edits in a mounted scene give the same picture as a fresh draw: scope, whole scene, scope again, hide, show', async () => {
    const scoped = scene([gradient(), text(), pixelate('t')]);
    const whole = scene([gradient(), text(), pixelate()]);
    const hidden = scene([gradient(), text({ visible: false }), pixelate('t')]);
    const fresh = { scoped: (await draw(scoped)).picture, whole: (await draw(whole)).picture, hidden: (await draw(hidden)).picture };
    expect(difference(fresh.scoped, fresh.whole).differing).toBeGreaterThan(100); // the three differ, so the checks below can fail
    const edits = await session(scoped);
    for (const [name, next] of [['whole', whole], ['scoped', scoped], ['hidden', hidden], ['scoped', scoped], ['whole', whole], ['scoped', scoped]] as const) {
      expect(difference(await edits.show(next), fresh[name === 'whole' ? 'whole' : name === 'hidden' ? 'hidden' : 'scoped']).differing, name).toBe(0);
    }
  }, 240_000);

  it('in development (StrictMode runs effects twice) the picture is the same, with an effect on the whole scene and on one layer', async () => {
    const plain = (await draw(scene([gradient(), text()]))).picture;
    for (const [name, layers] of [
      ['whole scene', [gradient(), text(), pixelate()]],
      ['one layer', [gradient(), text(), pixelate('t')]],
    ] as const) {
      const production = (await draw(scene([...layers]))).picture;
      const development = (await draw(scene([...layers]), { dev: true })).picture;
      expect(difference(production, plain).differing, `${name} has an effect`).toBeGreaterThan(100);
      expect(difference(development, production).differing, `${name} in development`).toBe(0);
    }
  }, 240_000);

  it('leaves no WebGL textures or framebuffers behind when an effect on the whole scene comes and goes', async () => {
    // The library builds the main composer and never frees it; the scene frees it itself. Measured on
    // origin/main before the fix: one texture and one framebuffer more per cycle.
    const plain = scene([gradient(), text()]);
    const whole = scene([gradient(), text(), pixelate()]);
    const edits = await session(plain);
    await edits.show(whole);
    await edits.show(plain);
    const settled = await edits.live();
    for (let i = 0; i < 6; i++) {
      await edits.show(whole);
      await edits.show(plain);
    }
    const after = await edits.live();
    expect(after.framebuffers).toBeLessThanOrEqual(settled.framebuffers);
    expect(after.textures).toBeLessThanOrEqual(settled.textures);
  }, 240_000);

  it('leaves no WebGL textures or framebuffers behind when a group comes and goes', async () => {
    const withGroup = scene([gradient(), text(), pixelate('t')]);
    // Without the effect no main composer is built either, so only the group's buffers are counted.
    // Measured on origin/main and on this branch (test log /tmp/fxlayers/fx-l4-engine/diag.txt): a scene
    // that adds and removes an UNTARGETED effect leaks one texture and one framebuffer per cycle, because
    // @react-three/postprocessing never disposes its composer. That is older than this change and is
    // listed separately; a group's own composer is freed (this test is flat).
    const without = scene([gradient(), text()]);
    const edits = await session(withGroup);
    await edits.show(without);
    const settled = await edits.live();
    for (let i = 0; i < 6; i++) {
      await edits.show(withGroup);
      await edits.show(without);
    }
    const after = await edits.live();
    expect(after.framebuffers).toBeLessThanOrEqual(settled.framebuffers);
    expect(after.textures).toBeLessThanOrEqual(settled.textures + 2);
  }, 240_000);
});
