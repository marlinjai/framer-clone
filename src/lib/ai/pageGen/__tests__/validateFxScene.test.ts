// @vitest-environment node
// The FX scene box in the page generator's validator (../validate): a scene from a
// preset survives, what the model gets wrong is repaired with a review note or the box
// stays a plain box, a page keeps one scene, and nothing of a stored scene is printed
// into the prompt.

import { describe, expect, it } from 'vitest';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { serializeScene } from '@/lib/fx/format';
import { fxFromPreset } from '@/lib/fxScene/edit';
import { FX_ATTR, FX_PROP, isFxScene, parseFxProp } from '@/lib/fxScene/fxScene';
import { holdsFxScene } from '@/lib/fxScene/marker';
import { serializeRegistry } from '@/lib/ai/serializers/registry';
import { buildSchemaDocs } from '../schemaDocs';
import { validateGeneration, type GeneratedNodeSnapshot, type ValidateContext } from '../validate';

const BREAKPOINTS = [
  { id: 'bp-d', label: 'Desktop', minWidth: 1280, key: 'desktop' },
  { id: 'bp-m', label: 'Mobile', minWidth: 320, key: 'mobile' },
];
let n = 0;
const ctx = (extra: Partial<ValidateContext> = {}): ValidateContext => ({ breakpoints: BREAKPOINTS as never, newId: () => `g${++n}`, ...extra });

function run(nodes: unknown[], extra: Partial<ValidateContext> = {}) {
  const outcome = validateGeneration({ nodes }, ctx(extra));
  if (!outcome.ok) throw new Error(`refused: ${outcome.errors.join('; ')}`);
  return outcome.result;
}
const flat = (nodes: GeneratedNodeSnapshot[]): GeneratedNodeSnapshot[] => nodes.flatMap((node) => [node, ...flat(node.children)]);
const scenes = (nodes: GeneratedNodeSnapshot[]) => flat(nodes).filter((node) => isFxScene(node.props, node.type));
const sceneOf = (node: GeneratedNodeSnapshot) => {
  const read = parseFxProp(node.props[FX_PROP]);
  if (!read.ok) throw new Error(read.message);
  return read.fx;
};
const preset = (id?: string) => {
  const made = fxFromPreset(id);
  if (!made.ok) throw new Error(made.message);
  return made;
};
const hero = (fx?: unknown, more: Record<string, unknown> = {}) => ({
  type: 'div',
  preset: 'fxScene',
  label: 'Hero',
  props: { ...(fx === undefined ? {} : { fx }), ...more },
  children: [{ type: 'h1', props: { children: 'Backhaus Lindner', style: { color: '#ffffff' } } }],
});

describe('a generated FX scene from a preset', () => {
  it('survives the validator exactly as the preset, with its marker, its children and nothing to review', () => {
    const result = run([hero({ preset: 'noise-gradient' })]);
    expect(result.warnings).toEqual([]);
    const [box] = scenes(result.nodes);
    expect(box.props[FX_ATTR]).toBe('scene');
    expect(JSON.stringify(serializeScene(sceneOf(box).scene))).toBe(JSON.stringify(serializeScene(preset('noise-gradient').fx.scene)));
    expect(box.children.map((child) => child.type)).toEqual(['h1']);
  });

  it('with no fx at all is the default scene over its own painted background', () => {
    const result = run([hero()]);
    expect(result.warnings).toEqual([]);
    const [box] = scenes(result.nodes);
    expect(JSON.stringify(box.props[FX_PROP])).toBe(JSON.stringify(preset().stored));
    expect((box.props.style as Record<string, unknown>).background).toBe(preset().background);
  });

  it('takes the box background of the preset it names, and keeps one the model set', () => {
    const other = scenes(run([hero({ preset: 'noise-gradient' })]).nodes)[0];
    expect((other.props.style as Record<string, unknown>).background).toBe(preset('noise-gradient').background);
    expect((other.props.style as Record<string, unknown>).background).not.toBe(preset().background);

    const own = scenes(run([hero({ preset: 'noise-gradient' }, { style: { backgroundColor: '#0b1d2a' } })]).nodes)[0];
    const style = own.props.style as Record<string, unknown>;
    expect(style.backgroundColor).toBe('#0b1d2a');
  });

  it('is retuned inside the ranges, and only where the model said', () => {
    const result = run([hero({ preset: 'gold-noise-gradient', calm: 'frame', layers: [{ id: 'bloom', params: { intensity: 0.9 } }] })]);
    expect(result.warnings).toEqual([]);
    const fx = sceneOf(scenes(result.nodes)[0]);
    expect(fx.calm).toBe('frame');
    const before = preset('gold-noise-gradient').fx.scene;
    const differing = fx.scene.layers.flatMap((layer) =>
      Object.entries(layer.params).filter(([key, schema]) => JSON.stringify(schema.value) !== JSON.stringify(before.layers.find((l) => l.id === layer.id)!.params[key].value)).map(([key]) => `${layer.id}.${key}`),
    );
    expect(differing).toEqual(['bloom.intensity']);
  });
});

describe('what the model gets wrong', () => {
  it('an invented layer type is dropped with a review note, and the scene is kept', () => {
    const result = run([hero({ preset: 'gold-noise-gradient', layers: [{ id: 'storm', type: 'particleStorm', params: { count: 9000 } }] })]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/FX scene: The layer "storm" of the kind "particleStorm" is not a layer of the preset/);
    const [box] = scenes(result.nodes);
    expect(sceneOf(box).scene.layers.map((l) => l.type)).not.toContain('particleStorm');
    expect(sceneOf(box).scene.layers).toHaveLength(preset('gold-noise-gradient').fx.scene.layers.length);
  });

  it('an unknown preset falls back to the default scene, and says so', () => {
    const result = run([hero({ preset: 'sparkles' })]);
    expect(result.warnings.join(' ')).toMatch(/no FX preset called "sparkles".*The default scene is used/);
    expect(JSON.stringify(scenes(result.nodes)[0].props[FX_PROP])).toBe(JSON.stringify(preset().stored));
  });

  it('a value out of range is moved into it with a note', () => {
    const result = run([hero({ preset: 'gold-noise-gradient', layers: [{ id: 'bloom', params: { intensity: 500 } }] })]);
    expect(result.warnings.join(' ')).toMatch(/500 is outside/);
  });

  it('a preset that draws text and was given none has that layer hidden, never the engine\'s sample words', () => {
    const result = run([hero({ preset: 'godrays-hero' })]);
    expect(result.warnings.join(' ')).toMatch(/draws text.*was hidden/);
    const fx = sceneOf(scenes(result.nodes)[0]);
    expect(fx.scene.layers.find((l) => l.type === 'text')!.visible).toBe(false);
  });

  it('the marker or a scene written on a node that is no FX scene box does not make one', () => {
    const result = run([
      { type: 'section', props: { 'data-fx': 'scene', fx: { preset: 'gold-noise-gradient' } }, children: [{ type: 'p', props: { children: 'Text' } }] },
      { type: 'div', props: { fx: { preset: 'gold-noise-gradient' } }, children: [{ type: 'p', props: { children: 'More' } }] },
    ]);
    expect(scenes(result.nodes)).toEqual([]);
    for (const node of flat(result.nodes)) expect(node.props[FX_PROP], node.type).toBeUndefined();
  });

  it('an SVG radialGradient keeps its fx attribute, which is its focal point', () => {
    const result = run([
      {
        type: 'svg',
        props: { viewBox: '0 0 10 10' },
        children: [{ type: 'defs', children: [{ type: 'radialGradient', props: { id: 'g', fx: '0.3' }, children: [{ type: 'stop', props: { offset: '0', stopColor: '#fff' } }] }] }],
      },
    ]);
    const gradient = flat(result.nodes).find((node) => node.type === 'radialGradient');
    expect(gradient?.props.fx).toBe('0.3');
  });
});

describe('a box sent back with the scene it holds (a regeneration is shown the nodes it replaces)', () => {
  const echoed = (fx: unknown) => ({ type: 'div', props: { 'data-fx': 'scene', fx, style: { minHeight: '480px' } }, children: [{ type: 'h2', props: { children: 'Kept' } }] });

  it('keeps a hand-tuned scene exactly, without the preset', () => {
    const tuned = JSON.parse(JSON.stringify(preset('bokeh-focuspull').stored));
    tuned.scene.layers[0].params.speed = 0.123;
    const result = run([echoed(tuned)]);
    expect(result.warnings).toEqual([]);
    const [box] = scenes(result.nodes);
    expect(sceneOf(box).scene.layers[0].params.speed.value).toBe(0.123);
    // The box's own style is the model's: no preset background is laid over it.
    expect((box.props.style as Record<string, unknown>).background).toBeUndefined();
  });

  it('with a picture from another address is kept as a plain box with its content, and says why', () => {
    const foreign = JSON.parse(JSON.stringify(preset().stored));
    foreign.scene.layers.push({ id: 'pic', type: 'image', name: 'Pic', visible: true, blend: 'normal', params: { src: 'https://evil.test/a.png' } });
    const result = run([echoed(foreign)]);
    expect(result.warnings.join(' ')).toMatch(/image address that is not allowed here.*kept as a plain box/);
    expect(scenes(result.nodes)).toEqual([]);
    expect(flat(result.nodes).map((node) => node.type)).toEqual(['div', 'h2']);
    expect(JSON.stringify(result.nodes)).not.toContain('evil.test');
  });
});

describe('a page draws one FX scene', () => {
  it('a generation keeps its first, in document order, and the second as a plain box with its content', () => {
    const result = run([{ type: 'section', children: [hero({ preset: 'noise-gradient' })] }, hero({ preset: 'gold-noise-gradient' })]);
    expect(scenes(result.nodes)).toHaveLength(1);
    expect(JSON.stringify(serializeScene(sceneOf(scenes(result.nodes)[0]).scene))).toBe(JSON.stringify(serializeScene(preset('noise-gradient').fx.scene)));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/a generation holds one FX scene.*kept as a plain box/);
    // Its heading is still there.
    expect(flat(result.nodes).filter((node) => node.type === 'h1')).toHaveLength(2);
  });

  it('none is added to a page that keeps one', () => {
    const result = run([hero({ preset: 'noise-gradient' })], { pageHasFxScene: true });
    expect(scenes(result.nodes)).toEqual([]);
    expect(result.warnings[0]).toMatch(/this page already has an FX scene/);
  });

  it('holdsFxScene finds a scene anywhere in a tree, and not inside what is being replaced', () => {
    const tree = { id: 'root', type: 'div', props: {}, children: [{ id: 'a', type: 'section', props: {}, children: [{ id: 'fx', type: 'div', props: { 'data-fx': 'scene' }, children: [] }] }] };
    expect(holdsFxScene([tree])).toBe(true);
    expect(holdsFxScene([tree], 'a')).toBe(false);
    expect(holdsFxScene([tree], 'fx')).toBe(false);
    expect(holdsFxScene([{ id: 'root', type: 'div', props: {}, children: [] }])).toBe(false);
  });
});

describe('what is printed into the prompts', () => {
  const docs = buildSchemaDocs();

  it('teaches the preset entry and the FX section, and never the stored scene', () => {
    expect(docs).toContain('### preset "fxScene" (FX scene, category layout)');
    expect(docs).toContain('## FX scene (an animated WebGL background)');
    expect(docs).toContain('### FX preset "gold-noise-gradient"');
    // The defaults line of the entry holds no scene: no layer list, no schema version of a scene.
    const block = docs.slice(docs.indexOf('### preset "fxScene"'), docs.indexOf('### preset "', docs.indexOf('### preset "fxScene"') + 5));
    expect(block).not.toContain('"layers"');
    expect(block).not.toContain('"fx"');
    expect(block).toContain('"data-fx":"scene"');
  });

  it('the serialized registry lists the box without its scene', () => {
    const entry = serializeRegistry().find((at) => at.type === 'fxScene');
    expect(entry).toBeDefined();
    expect(entry!.defaults).not.toHaveProperty(FX_PROP);
    expect(entry!.defaults[FX_ATTR]).toBe('scene');
    // The registry itself still holds it: a dropped box starts with a scene.
    expect(COMPONENT_REGISTRY.fxScene.defaultProps).toHaveProperty(FX_PROP);
  });
});
