// The FX scene node in the app (src/lib/fxScene/fxScene.ts): what counts as one,
// how its stored scene is read under this app's image rule, which uploads a
// document's scenes name, and what each surface does with the node before its
// island exists: the published page and the editor draw the plain box with its
// children, `fx` never becomes an attribute, the Custom section cannot touch
// the marker, and a site operation cannot set either as a loose prop.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSnapshot } from 'mobx-state-tree';

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { isBlockedProp, isSettingsProp } from '@/lib/renderer/blockedNodes';
import { attributeNameError, isAttributeProp } from '@/lib/styles/customEditor';
import { applyOperations } from '@/lib/siteOps/applyOps';
import ProjectModel from '@/models/ProjectModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { namedSiteImages } from '@/lib/site/siteImages';
import { PRESETS, serializeScene } from '@/lib/fx/format';
import { FX_ATTR, FX_MARKER, FX_PROP, fxSiteImagePaths, isAllowedFxImage, isFxScene, parseFxProp, readFxScene, storedFxProp } from '../fxScene';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const IMAGE_A = `/site-images/${SHA_A}.png`;
const IMAGE_B = `/site-images/${SHA_B}.webp`;

const presetScene = () => serializeScene(PRESETS.find((p) => p.id === 'noise-gradient')!.load());

function imageLayer(id: string, src: string) {
  return { id, type: 'image', name: 'Picture', visible: true, blend: 'normal', params: { src } };
}

function storedFx(extraLayers: unknown[] = [], extra: Record<string, unknown> = {}) {
  const scene = presetScene() as unknown as { layers: unknown[] };
  return { version: 1, scene: { ...scene, layers: [...scene.layers, ...extraLayers] }, start: 'settled', calm: 'background', ...extra };
}

function fxNode(fx: unknown, extra: Record<string, unknown> = {}): ComponentNode {
  return {
    type: 'div',
    id: 'hero',
    props: { [FX_ATTR]: FX_MARKER, [FX_PROP]: fx, style: { position: 'relative', minHeight: '100svh', background: '#000000' }, ...extra },
    children: [{ type: 'h1', id: 'title', props: { children: 'Fresh bread' } }],
  } as ComponentNode;
}

describe('isFxScene', () => {
  it('is a div with the marker', () => {
    expect(isFxScene({ [FX_ATTR]: FX_MARKER })).toBe(true);
    expect(isFxScene({ [FX_ATTR]: FX_MARKER }, 'div')).toBe(true);
  });

  it('is nothing else', () => {
    expect(isFxScene({ [FX_ATTR]: 'other' })).toBe(false);
    expect(isFxScene({ [FX_ATTR]: true })).toBe(false);
    expect(isFxScene({ [FX_PROP]: storedFx() })).toBe(false);
    expect(isFxScene(null)).toBe(false);
    expect(isFxScene([])).toBe(false);
    for (const tag of ['a', 'button', 'section', 'form', 'canvas', 'DIV', undefined, null]) {
      expect(isFxScene({ [FX_ATTR]: FX_MARKER }, tag), String(tag)).toBe(tag === undefined);
    }
  });
});

describe('reading the stored scene', () => {
  it('reads a preset and stores it back unchanged', () => {
    const stored = storedFx();
    const result = readFxScene({ [FX_ATTR]: FX_MARKER, [FX_PROP]: stored });
    if (!result.ok) throw new Error(result.message);
    expect(result.notes).toEqual([]);
    expect(storedFxProp(result.fx)).toEqual(stored);
  });

  it('refuses a node that is not an FX scene, a missing prop and a refused scene, each with a message', () => {
    expect(readFxScene({ [FX_PROP]: storedFx() })).toEqual({ ok: false, message: 'This element is not an FX scene.' });
    expect(readFxScene({ [FX_ATTR]: FX_MARKER, [FX_PROP]: storedFx() }, 'section')).toEqual({ ok: false, message: 'This element is not an FX scene.' });
    expect(readFxScene({ [FX_ATTR]: FX_MARKER })).toEqual({ ok: false, message: 'This box has no FX scene.' });
    const refused = readFxScene({ [FX_ATTR]: FX_MARKER, [FX_PROP]: storedFx([], { version: 9 }) });
    expect(refused.ok).toBe(false);
  });

  it('allows an image layer only one of the site\'s own uploads', () => {
    expect(isAllowedFxImage(IMAGE_A)).toBe(true);
    expect(parseFxProp(storedFx([imageLayer('pic', IMAGE_A)])).ok).toBe(true);
    for (const src of [
      'https://evil.example/pixel.png',
      '//evil.example/pixel.png',
      `https://other.sites.lumitra.co${IMAGE_A}`,
      `${IMAGE_A}?v=2`,
      `/site-images/${SHA_A}.svg`,
      `/site-images/${'a'.repeat(63)}.png`,
      '/site-images/../api/projects/x/images',
      `/api/projects/x/images/${SHA_A}`,
      'data:image/png;base64,AAAA',
    ]) {
      const result = parseFxProp(storedFx([imageLayer('pic', src)]));
      expect(result.ok, src).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/only show an image uploaded to this site/);
    }
  });
});

describe('the uploads a document\'s FX scenes name', () => {
  const page = (...nodes: unknown[]) => ({
    metadata: { title: 'Home' },
    appComponentTree: { id: 'root', type: 'div', props: {}, children: nodes },
    canvasNodes: {},
  });

  it('finds them wherever the nodes sit, once each', () => {
    const snapshot = page(
      { id: 'a', type: 'section', props: {}, children: [fxNode(storedFx([imageLayer('p1', IMAGE_A), imageLayer('p2', IMAGE_B)]))] },
      fxNode(storedFx([imageLayer('p1', IMAGE_A)])),
    );
    expect(fxSiteImagePaths(snapshot).sort()).toEqual([IMAGE_A, IMAGE_B]);
    expect(fxSiteImagePaths([snapshot, snapshot]).sort()).toEqual([IMAGE_A, IMAGE_B]);
  });

  it('finds nothing in a document without FX scenes, in a scene without images, or in nothing', () => {
    expect(fxSiteImagePaths(page({ id: 'a', type: 'img', props: { src: IMAGE_A } }))).toEqual([]);
    expect(fxSiteImagePaths(page(fxNode(storedFx())))).toEqual([]);
    for (const empty of [null, undefined, 'x', 3, [], {}]) expect(fxSiteImagePaths(empty)).toEqual([]);
  });

  it('does not count a scene that is refused or a node that is not an FX scene', () => {
    const foreign = fxNode(storedFx([imageLayer('p1', IMAGE_A), imageLayer('p2', 'https://evil.example/x.png')]));
    const notMarked = { ...fxNode(storedFx([imageLayer('p1', IMAGE_A)])), props: { [FX_PROP]: storedFx([imageLayer('p1', IMAGE_A)]) } };
    const wrongTag = { ...fxNode(storedFx([imageLayer('p1', IMAGE_A)])), type: 'section' };
    expect(fxSiteImagePaths(page(foreign, notMarked, wrongTag))).toEqual([]);
  });

  it('survives a document that refers to itself', () => {
    const node = fxNode(storedFx([imageLayer('p1', IMAGE_A)])) as unknown as Record<string, unknown>;
    node.parent = node;
    expect(fxSiteImagePaths(node)).toEqual([IMAGE_A]);
  });

  it('feeds the save check: an FX image is a named image of the site', () => {
    const named = namedSiteImages({ faviconUrl: IMAGE_B }, [undefined, ...fxSiteImagePaths(page(fxNode(storedFx([imageLayer('p1', IMAGE_A)]))))]);
    expect([...named.keys()].sort()).toEqual([SHA_A, SHA_B]);
    expect(named.get(SHA_A)).toBe(IMAGE_A);
  });
});

describe('the published page', () => {
  const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

  async function publish(node: ComponentNode): Promise<string> {
    const page = await renderPublishedPage({ root: { type: 'div', id: 'root', children: [node] } as ComponentNode, pageParams: {}, cmsRepo });
    return renderToStaticMarkup(<>{page.body}</>);
  }

  it('draws the box with its marker, its background and its children, and never the scene data', async () => {
    const markup = await publish(fxNode(storedFx([imageLayer('pic', IMAGE_A)])));
    expect(markup).toContain('data-fx="scene"');
    expect(markup).toContain('<h1');
    expect(markup).toContain('Fresh bread');
    expect(markup).toMatch(/min-height:\s*100svh/);
    expect(markup).not.toMatch(/\sfx=/);
    expect(markup).not.toContain('[object Object]');
    expect(markup).not.toContain('noiseFill');
    expect(markup).not.toContain(SHA_A);
    expect(markup).not.toContain('<canvas');
  });

  it('marks a box whose scene reads cleanly with its place in the page program, and nothing else', async () => {
    const markup = await publish(fxNode(storedFx()));
    expect(markup).toContain('data-fc-fx="0"');
    expect(markup).not.toContain('data-fc-fx-state');
  });

  it('draws a box whose scene is refused or missing as the same box without that mark', async () => {
    const plain = (await publish(fxNode(storedFx()))).replace(' data-fc-fx="0"', '');
    expect(plain).not.toContain('data-fc-fx');
    expect(await publish(fxNode(storedFx([imageLayer('pic', 'https://evil.example/x.png')])))).toBe(plain);
    expect(await publish(fxNode(storedFx([], { version: 9 })))).toBe(plain);
    expect(await publish(fxNode(undefined))).toBe(plain);
    expect(await publish(fxNode('not a scene'))).toBe(plain);
    expect(plain).not.toContain('evil.example');
  });

  it('gives the same markup as the box without the scene, apart from the marker and the mark', async () => {
    const withScene = await publish(fxNode(storedFx()));
    const plain = await publish({ ...fxNode(storedFx()), props: { style: { position: 'relative', minHeight: '100svh', background: '#000000' } } } as ComponentNode);
    expect(withScene.replace(' data-fx="scene"', '').replace(' data-fc-fx="0"', '')).toBe(plain);
  });

  it('drops a stored mark that only the page may write', async () => {
    const markup = await publish(fxNode(undefined, { 'data-fc-fx': '0', 'data-fc-fx-state': 'live' }));
    expect(markup).not.toContain('data-fc-fx');
  });
});

describe('the editor surfaces', () => {
  it('keep `fx` off the element without reporting it, and let the marker through', () => {
    expect(isBlockedProp(FX_PROP, storedFx())).toBe(true);
    expect(isSettingsProp(FX_PROP)).toBe(true);
    expect(isBlockedProp(FX_ATTR, FX_MARKER)).toBe(false);
  });

  it('do not offer the scene or its marker in the Custom section', () => {
    expect(isAttributeProp(FX_PROP)).toBe(false);
    expect(isAttributeProp(FX_ATTR)).toBe(false);
    expect(attributeNameError(FX_ATTR, 'div')).toMatch(/belongs to the editor/);
    expect(attributeNameError(FX_PROP, 'div')).not.toBeNull();
    // A neighbouring name is an ordinary data attribute.
    expect(isAttributeProp('data-fx-note')).toBe(true);
  });
});

describe('site operations', () => {
  function makeProject() {
    return ProjectModel.create({
      id: 'site-1',
      metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 1 },
      pages: {
        home: {
          id: 'home',
          slug: '',
          metadata: { title: 'Home', description: '' },
          appComponentTree: {
            id: 'root',
            type: 'div',
            componentType: 'host',
            props: {},
            children: [{ id: 'hero', type: 'div', componentType: 'host', parentId: 'root', props: {}, children: [] }],
          },
          canvasNodes: defaultViewportSnapshots(),
        },
      },
    });
  }

  async function refused(props: Record<string, unknown>): Promise<string> {
    const project = makeProject();
    const before = JSON.stringify(getSnapshot(project));
    let n = 0;
    const outcome = await applyOperations(project, [{ op: 'setProps', nodeId: 'hero', props }], { newId: () => `id${++n}` });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
    if (outcome.ok) throw new Error('expected a refusal');
    return outcome.rejected[0].reason;
  }

  it('refuse setting a scene or the marker as a loose prop, and change nothing', async () => {
    // An object is no prop value at all for setProps; a plain value is refused by name.
    expect(await refused({ [FX_PROP]: storedFx() })).toMatch(/props\.fx/);
    expect(await refused({ [FX_PROP]: 'scene' })).toMatch(/fx is not set/);
    expect(await refused({ [FX_PROP]: null })).toMatch(/fx is not set/);
    expect(await refused({ [FX_ATTR]: FX_MARKER })).toMatch(/data-fx is not set/);
    expect(await refused({ [FX_ATTR]: null })).toMatch(/data-fx is not set/);
  });
});
