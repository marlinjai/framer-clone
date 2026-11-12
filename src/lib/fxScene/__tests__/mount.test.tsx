// The lazy mount (../mount) with the engine's scene component stood in for: what it is
// handed, when it is replaced and when it is taken away. The real engine draws in the
// browser suites (test/behaviour/fx.spec.ts, fxCanvas.spec.ts); here is the logic around
// it, which those reach only one path at a time. Also the claim (../claim) and the box
// holder (../box), which every surface that draws a scene shares.

import React, { useEffect } from 'react';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SceneProps {
  config: { background: string; layers: { id: string; type: string; params: Record<string, { value: unknown }> }[] };
  layoutSize?: boolean;
  onFirstFrame?: () => void;
  onFail?: (reason: string) => void;
}
const scene = { mounts: 0, unmounts: 0, props: [] as SceneProps[] };
const lastProps = () => scene.props[scene.props.length - 1];

vi.mock('@/lib/fx', () => ({
  LumitraScene: (props: SceneProps) => {
    scene.props.push(props);
    useEffect(() => {
      scene.mounts++;
      return () => {
        scene.unmounts++;
      };
    }, []);
    return <div data-scene="" />;
  },
}));

import { FX_LAYER_STYLE, holdFxBox } from '../box';
import { FxClaim } from '../claim';
import { addFxLayer, fxFromPreset, setFxBackground, setFxParam, type FxEdit } from '../edit';
import { mountFxScene, renderFxScene } from '../mount';

const SITE_IMAGE = `/site-images/${'b'.repeat(64)}.png`;
const ok = (edit: FxEdit) => {
  if (!edit.ok) throw new Error(edit.message);
  return edit;
};
const PRESET = ok(fxFromPreset()).stored;

let layer: HTMLDivElement;
beforeEach(() => {
  scene.mounts = 0;
  scene.unmounts = 0;
  scene.props = [];
  layer = document.createElement('div');
  document.body.append(layer);
});
afterEach(() => {
  document.body.innerHTML = '';
});

const flush = () => act(async () => {});

describe('renderFxScene', () => {
  it('draws the scene it is given into the layer and reports the first frame once', async () => {
    const onLive = vi.fn();
    const onOff = vi.fn();
    await act(async () => void renderFxScene(layer, PRESET, { onLive, onOff }));
    expect(layer.querySelector('[data-scene]')).toBeTruthy();
    expect(lastProps().config.layers).toHaveLength(5);
    act(() => lastProps().onFirstFrame?.());
    act(() => lastProps().onFirstFrame?.());
    expect(onLive).toHaveBeenCalledTimes(1);
    expect(onOff).not.toHaveBeenCalled();
  });

  it('an update draws the new scene in the same mount, and does not ask for a first frame again', async () => {
    const onLive = vi.fn();
    let handle!: ReturnType<typeof renderFxScene>;
    await act(async () => void (handle = renderFxScene(layer, PRESET, { onLive, onOff: vi.fn() })));
    act(() => lastProps().onFirstFrame?.());
    const next = ok(setFxBackground(PRESET, '#123456')).stored;
    await act(async () => handle.update(next));
    expect(lastProps().config.background).toBe('#123456');
    expect(lastProps().onFirstFrame).toBeUndefined();
    expect(scene.mounts).toBe(1);
    expect(scene.unmounts).toBe(0);
    expect(onLive).toHaveBeenCalledTimes(1);
  });

  it('an update that arrives before the first frame does not lose it', async () => {
    const onLive = vi.fn();
    let handle!: ReturnType<typeof renderFxScene>;
    await act(async () => void (handle = renderFxScene(layer, PRESET, { onLive, onOff: vi.fn() })));
    await act(async () => handle.update(ok(setFxBackground(PRESET, '#123456')).stored));
    act(() => lastProps().onFirstFrame?.());
    expect(onLive).toHaveBeenCalledTimes(1);
  });

  it('fetches a picture from where this surface serves it, after the strict read, and never changes what is stored', async () => {
    const added = ok(addFxLayer(PRESET, 'image'));
    const withPicture = ok(setFxParam(added.stored, (added as { layerId?: string }).layerId!, 'src', SITE_IMAGE)).stored;
    const before = JSON.stringify(withPicture);
    const resolveImage = vi.fn((src: string) => `/editor${src}`);
    await act(async () => void renderFxScene(layer, withPicture, { onLive: vi.fn(), onOff: vi.fn(), resolveImage }));
    expect(resolveImage).toHaveBeenCalledWith(SITE_IMAGE);
    const image = lastProps().config.layers.find((l) => l.type === 'image')!;
    expect(image.params.src.value).toBe(`/editor${SITE_IMAGE}`);
    expect(JSON.stringify(withPicture)).toBe(before);
  });

  it('draws an image layer without a picture when the surface cannot serve it', async () => {
    const added = ok(addFxLayer(PRESET, 'image'));
    const withPicture = ok(setFxParam(added.stored, (added as { layerId?: string }).layerId!, 'src', SITE_IMAGE)).stored;
    await act(async () => void renderFxScene(layer, withPicture, { onLive: vi.fn(), onOff: vi.fn(), resolveImage: () => null }));
    expect(lastProps().config.layers.find((l) => l.type === 'image')!.params.src.value).toBe('');
  });

  it('a scene with an address from elsewhere is refused before the resolver ever sees it', async () => {
    const onOff = vi.fn();
    const resolveImage = vi.fn(() => '/x');
    const foreign = { version: 1, start: 'immediate', calm: 'background', scene: { background: '#000000', layers: [{ id: 'p', type: 'image', name: 'P', visible: true, blend: 'normal', params: { src: '/api/projects/x/images/abc' } }] } };
    await act(async () => void renderFxScene(layer, foreign, { onLive: vi.fn(), onOff, resolveImage }));
    expect(onOff).toHaveBeenCalledWith('refused');
    expect(resolveImage).not.toHaveBeenCalled();
    expect(scene.mounts).toBe(0);
    expect(layer.childElementCount).toBe(0);
  });

  it('an update to a refused scene clears the layer and says so; the next good one draws again and reports its first frame', async () => {
    const onLive = vi.fn();
    const onOff = vi.fn();
    let handle!: ReturnType<typeof renderFxScene>;
    await act(async () => void (handle = renderFxScene(layer, PRESET, { onLive, onOff })));
    act(() => lastProps().onFirstFrame?.());
    await act(async () => handle.update({ version: 99 }));
    expect(onOff).toHaveBeenCalledWith('refused');
    expect(scene.unmounts).toBe(1);
    expect(layer.childElementCount).toBe(0);

    await act(async () => handle.update(PRESET));
    expect(scene.mounts).toBe(2);
    act(() => lastProps().onFirstFrame?.());
    expect(onLive).toHaveBeenCalledTimes(2);
  });

  it('a scene that failed is taken out, reported once, and not drawn again by a later update', async () => {
    const onOff = vi.fn();
    let handle!: ReturnType<typeof renderFxScene>;
    await act(async () => void (handle = renderFxScene(layer, PRESET, { onLive: vi.fn(), onOff })));
    await act(async () => lastProps().onFail?.('context-lost'));
    await flush();
    expect(onOff).toHaveBeenCalledTimes(1);
    expect(onOff).toHaveBeenCalledWith('context-lost');
    expect(scene.unmounts).toBe(1);
    await act(async () => handle.update(PRESET));
    expect(scene.mounts).toBe(1);
  });

  it('teardown releases the scene, is safe twice, and nothing is reported after it', async () => {
    const onLive = vi.fn();
    const onOff = vi.fn();
    let handle!: ReturnType<typeof renderFxScene>;
    await act(async () => void (handle = renderFxScene(layer, PRESET, { onLive, onOff })));
    const props = lastProps();
    await act(async () => handle.teardown());
    await act(async () => handle.teardown());
    expect(scene.unmounts).toBe(1);
    props.onFirstFrame?.();
    props.onFail?.('renderer-error');
    await flush();
    await act(async () => handle.update(PRESET));
    expect(onLive).not.toHaveBeenCalled();
    expect(onOff).not.toHaveBeenCalled();
    expect(scene.mounts).toBe(1);
  });

  it('passes the layout sizing on, for a surface under a transform', async () => {
    await act(async () => void renderFxScene(layer, PRESET, { onLive: vi.fn(), onOff: vi.fn(), layoutSize: true }));
    expect(lastProps().layoutSize).toBe(true);
  });
});

describe('mountFxScene, the published page\'s way in', () => {
  const makeBox = () => {
    const box = document.createElement('div');
    box.innerHTML = '<h1>Over the scene</h1>';
    document.body.append(box);
    return box;
  };

  it('makes the layer as the box\'s first child, fades it in on the first frame, and removes it on teardown', async () => {
    const box = makeBox();
    const onLive = vi.fn();
    let teardown!: () => void;
    await act(async () => void (teardown = mountFxScene(box, PRESET, { onLive, onOff: vi.fn() })));
    const made = box.firstElementChild as HTMLElement;
    expect(made.hasAttribute('data-fc-fx-layer')).toBe(true);
    expect(made.getAttribute('aria-hidden')).toBe('true');
    expect(made.style.opacity).toBe('0');
    expect(box.style.isolation).toBe('isolate');
    expect(box.style.position).toBe('relative');
    act(() => lastProps().onFirstFrame?.());
    expect(made.style.opacity).toBe('1');
    expect(onLive).toHaveBeenCalledTimes(1);
    await act(async () => teardown());
    await act(async () => teardown());
    expect(box.innerHTML).toBe('<h1>Over the scene</h1>');
    expect(box.getAttribute('style') ?? '').toBe('');
  });

  it('leaves a box whose scene is refused untouched', () => {
    const box = makeBox();
    const onOff = vi.fn();
    mountFxScene(box, { version: 99 }, { onLive: vi.fn(), onOff });
    expect(onOff).toHaveBeenCalledWith('refused');
    expect(box.innerHTML).toBe('<h1>Over the scene</h1>');
    expect(box.getAttribute('style')).toBeNull();
  });

  it('gives the box back when the scene fails, then reports why', async () => {
    const box = makeBox();
    const onOff = vi.fn(() => expect(box.querySelector('[data-fc-fx-layer]')).toBeNull());
    await act(async () => void mountFxScene(box, PRESET, { onLive: vi.fn(), onOff }));
    await act(async () => lastProps().onFail?.('renderer-error'));
    await flush();
    expect(onOff).toHaveBeenCalledWith('renderer-error');
    expect(box.style.isolation).toBe('');
  });
});

describe('holdFxBox', () => {
  it('gives a static box a position and a stacking context, and takes both back', () => {
    const box = document.createElement('div');
    document.body.append(box);
    const release = holdFxBox(box);
    expect([box.style.position, box.style.isolation]).toEqual(['relative', 'isolate']);
    release();
    expect([box.style.position, box.style.isolation]).toEqual(['', '']);
  });

  it('leaves a position the box already has, and one that was set while it held the box', () => {
    const placed = document.createElement('div');
    placed.style.position = 'absolute';
    document.body.append(placed);
    holdFxBox(placed)();
    expect(placed.style.position).toBe('absolute');

    const box = document.createElement('div');
    document.body.append(box);
    const release = holdFxBox(box);
    box.style.position = 'sticky';
    release(true);
    expect(box.style.position).toBe('sticky');
  });

  it('describes a layer behind the content that takes no pointer', () => {
    expect(FX_LAYER_STYLE).toMatchObject({ position: 'absolute', inset: '0', zIndex: '-1', pointerEvents: 'none', opacity: '0' });
  });
});

describe('FxClaim: one element draws', () => {
  it('goes to the first to ask, and to no one else until it is given up', () => {
    const claim = new FxClaim();
    const a = {};
    const b = {};
    expect(claim.claim(a)).toBe(true);
    expect(claim.claim(b)).toBe(false);
    expect(claim.claim(a)).toBe(true);
    expect(claim.heldBy(a)).toBe(true);
    claim.release(b);
    expect(claim.heldBy(a)).toBe(true);
    claim.release(a);
    expect(claim.taken).toBe(false);
    expect(claim.claim(b)).toBe(true);
  });

  it('tells those waiting when the holder changes, and not those who left', () => {
    const claim = new FxClaim();
    const heard = vi.fn();
    const gone = vi.fn();
    claim.subscribe(heard);
    claim.subscribe(gone)();
    const a = {};
    claim.claim(a);
    claim.claim({});
    claim.release(a);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(gone).not.toHaveBeenCalled();
    expect(claim.snapshot()).toBeUndefined();
  });
});
