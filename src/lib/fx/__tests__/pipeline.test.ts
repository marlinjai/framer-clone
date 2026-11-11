// @vitest-environment node
// Which layers a scene draws (../pipeline): visibility, the performance step
// down, and a post pass's source layer.

import { describe, expect, it } from 'vitest';

import { deserializeScene } from '../serialize';
import { planPipeline } from '../pipeline';
import type { Layer } from '../types';

import v7 from './fixtures/v7.json';

function layers(): Layer[] {
  return deserializeScene(v7).layers;
}

const all = () => true;
const none = () => false;
const ids = (list: Layer[]) => list.map((l) => l.id);

describe('planPipeline', () => {
  it('splits the v7 hero into content and post layers in stored order', () => {
    const scene = layers();
    const plan = planPipeline(scene, false, all);
    expect(ids(plan.content)).toEqual(ids(scene.filter((l) => ['text', 'noiseFill'].includes(l.type))));
    expect(ids(plan.post)).toEqual(ids(scene.filter((l) => !['text', 'noiseFill'].includes(l.type))));
    expect(plan.post.some((l) => l.type === 'godRays')).toBe(true);
    expect(plan.postReady).toBe(true);
  });

  it('holds the composer until the source of a post pass is mounted', () => {
    const scene = layers();
    expect(planPipeline(scene, false, none).postReady).toBe(false);
    expect(planPipeline(scene, false, (id) => id === 'text-lockup').postReady).toBe(true);
  });

  it('leaves out hidden layers', () => {
    const scene = layers().map((l) => (l.type === 'chromaticAberration' || l.type === 'noiseFill' ? { ...l, visible: false } : l));
    const plan = planPipeline(scene, false, all);
    expect(plan.post.some((l) => l.type === 'chromaticAberration')).toBe(false);
    expect(plan.content.some((l) => l.type === 'noiseFill')).toBe(false);
  });

  it('drops heavy layers after the step down and keeps the rest', () => {
    const scene = layers();
    const plan = planPipeline(scene, true, all);
    expect(plan.post.map((l) => l.type)).not.toContain('bloom');
    expect(plan.post.map((l) => l.type)).not.toContain('godRays');
    expect(plan.post.map((l) => l.type)).toEqual(['chromaticAberration']);
    expect(ids(plan.content)).toEqual(ids(planPipeline(scene, false, all).content));
  });

  it('leaves out only the pass whose source is hidden, and no longer waits for it', () => {
    const scene = layers().map((l) => (l.id === 'text-lockup' ? { ...l, visible: false } : l));
    const plan = planPipeline(scene, false, none);
    expect(plan.post.map((l) => l.type)).not.toContain('godRays');
    expect(plan.post.length).toBeGreaterThan(0);
    expect(plan.postReady).toBe(true);
  });

  it('leaves out only the pass whose source is not in the scene', () => {
    const scene = layers().filter((l) => l.id !== 'text-lockup');
    const plan = planPipeline(scene, false, none);
    expect(plan.post.map((l) => l.type)).not.toContain('godRays');
    expect(plan.post.map((l) => l.type)).toContain('bloom');
    expect(plan.postReady).toBe(true);
  });

  it('leaves out a pass whose source is a post layer, not a content layer', () => {
    const scene = layers().map((l) =>
      l.type === 'godRays' ? { ...l, params: { ...l.params, sourceLayerId: { type: 'select' as const, value: 'bloom', options: ['bloom'] } } } : l,
    );
    expect(planPipeline(scene, false, all).post.map((l) => l.type)).not.toContain('godRays');
  });

  it('ignores a layer of a type the registry does not know', () => {
    const scene = [...layers(), { ...layers()[0], id: 'x', type: 'customShader' }];
    const plan = planPipeline(scene, false, all);
    expect([...plan.content, ...plan.post].some((l) => l.id === 'x')).toBe(false);
  });

  it('is ready with no post pass at all', () => {
    const plan = planPipeline(layers().filter((l) => l.type === 'noiseFill'), false, none);
    expect(plan.post).toEqual([]);
    expect(plan.postReady).toBe(true);
  });
});
