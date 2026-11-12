// The FX section of the properties panel (../sections/FxSceneSection): one test per
// kind of generated control (number, colour, choice, switch, text, pair of numbers,
// picture), the layer list, the messages, copy and import, and the four paths of a
// flow with state (knowledge-base/standards/stateful-flow-testing.md): forward, going
// back and changing an earlier choice, a reload, and coming back after an undo, a
// refusal or to another box. The store, the history and the strict reader are the
// real ones; only the network and the clipboard are stood in for.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import ProjectModel from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FX_LIMITS, type Layer, type ParsedFx } from '@/lib/fx/format';
import { FX_PROP, isFxScene, parseFxProp } from '@/lib/fxScene/fxScene';
import { SECTION_MAP, getComponentCategory } from '../sectionConfig';
import { FxSceneSection } from '../sections/FxSceneSection';

const SITE_IMAGE = `/site-images/${'a'.repeat(64)}.png`;
let projects = 0;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A project of its own with one FX scene box on its page, under a clean history. */
function setup() {
  // Not a hook: the editor's one store, which the section reads too.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useStore();
  const title = `FX panel ${++projects}`;
  store.projectStore.createProject(title);
  const project = store.projectStore.findProjectByTitle(title)!;
  const page = project.findPageBySlug('')!;
  store.editorUI.consumeDemo();
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  const box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
  const history = getHistoryStore()!;
  history.clear();
  return { store, project, page, box, history };
}

/** The scene the box stores, through the one reader. */
function fxOf(box: ComponentInstance): ParsedFx {
  const read = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
  if (!read.ok) throw new Error(`the box holds no scene: ${read.message}`);
  return read.fx;
}
const layersOf = (box: ComponentInstance): Layer[] => fxOf(box).scene.layers;
const layerOf = (box: ComponentInstance, id: string): Layer => {
  const layer = layersOf(box).find((l) => l.id === id);
  if (!layer) throw new Error(`no layer ${id}`);
  return layer;
};
const valueOf = (box: ComponentInstance, id: string, key: string) => layerOf(box, id).params[key]?.value;

const choose = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pick = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
const listed = () => within(screen.getByRole('list', { name: 'Layers, back to front' })).queryAllByRole('listitem');
const listedNames = () => listed().map((item) => within(item).getAllByRole('button')[0].querySelector('span')!.textContent);
const settings = (name: string) => screen.getByRole('group', { name: `Settings of ${name}` });
const undo = () => act(() => getHistoryStore()!.undo());

/** Add a layer of `type` and return it: the panel selects what it adds. */
function add(box: ComponentInstance, type: string): Layer {
  const before = new Set(layersOf(box).map((l) => l.id));
  choose('Add a layer', type);
  const added = layersOf(box).find((l) => !before.has(l.id));
  if (!added) throw new Error(`no ${type} layer was added`);
  return added;
}

describe('the FX scene box in the editor', () => {
  it('arrives from the palette as the lumitra.co hero, with its section first', () => {
    const { box } = setup();
    expect(isFxScene(box.props, box.type)).toBe(true);
    expect(getComponentCategory(box)).toBe('fxScene');
    expect(SECTION_MAP.fxScene[0]).toBe('fxScene');
    render(<FxSceneSection component={box} />);
    expect(listedNames()).toEqual(['Gradient', 'Noise Field', 'Bloom', 'Vignette', 'Grain']);
    expect((screen.getByLabelText('Starts') as HTMLSelectElement).value).toBe('settled');
    expect((screen.getByLabelText('With reduced motion') as HTMLSelectElement).value).toBe('background');
    // Nothing is picked yet, and the panel says what to do.
    expect(screen.getByText('Pick a layer in the list to change its settings.')).toBeTruthy();
  });
});

describe('one control per kind of setting', () => {
  it('a number: the slider stores as it moves, a whole drag is one undo step, typed text is clamped', () => {
    const { box, history } = setup();
    render(<FxSceneSection component={box} />);
    pick('Bloom');
    const schema = layerOf(box, 'bloom').params.intensity;
    if (schema.type !== 'number') throw new Error('bloom intensity is a number');
    const before = schema.value;
    const slider = screen.getByLabelText('Intensity') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(Number(slider.min)).toBe(schema.min);
    expect(Number(slider.max)).toBe(schema.max);

    fireEvent.pointerDown(slider);
    for (const value of [schema.min, schema.max, schema.min]) fireEvent.change(slider, { target: { value: String(value) } });
    expect(valueOf(box, 'bloom', 'intensity')).toBe(schema.min);
    fireEvent.pointerUp(slider);
    expect(history.batch).toBeFalsy();
    undo();
    expect(valueOf(box, 'bloom', 'intensity')).toBe(before);
    expect(history.canUndo).toBe(false);

    // Typed: nothing until Enter, then clamped into the range.
    const text = screen.getByLabelText('Intensity, as a number') as HTMLInputElement;
    fireEvent.change(text, { target: { value: String(schema.max + 1000) } });
    expect(valueOf(box, 'bloom', 'intensity')).toBe(before);
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(valueOf(box, 'bloom', 'intensity')).toBe(schema.max);
    expect(text.value).toBe(String(schema.max));

    // Not a number: the field goes back to what is stored.
    fireEvent.change(text, { target: { value: 'bright' } });
    fireEvent.blur(text);
    expect(valueOf(box, 'bloom', 'intensity')).toBe(schema.max);
    expect(text.value).toBe(String(schema.max));
  });

  it('a number left untouched keeps its stored precision when the field is focused and left', () => {
    const { box, history } = setup();
    render(<FxSceneSection component={box} />);
    pick('Bloom');
    fireEvent.change(screen.getByLabelText('Intensity, as a number'), { target: { value: '0.7234' } });
    fireEvent.blur(screen.getByLabelText('Intensity, as a number'));
    expect(valueOf(box, 'bloom', 'intensity')).toBe(0.7234);
    history.clear();
    const text = screen.getByLabelText('Intensity, as a number') as HTMLInputElement;
    fireEvent.focus(text);
    fireEvent.blur(text);
    expect(valueOf(box, 'bloom', 'intensity')).toBe(0.7234);
    expect(history.canUndo).toBe(false);
  });

  it('a slider left mid-drag (the selection moved) still ends its undo step', () => {
    const { box, history } = setup();
    const view = render(<FxSceneSection component={box} />);
    pick('Bloom');
    fireEvent.pointerDown(screen.getByLabelText('Intensity'));
    expect(history.batch).toBeTruthy();
    view.unmount();
    expect(history.batch).toBeFalsy();
  });

  it('a colour: the text commits on Enter', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    pick('Noise Field');
    const colour = within(settings('Noise Field')).getByLabelText('Color') as HTMLInputElement;
    fireEvent.change(colour, { target: { value: '#112233' } });
    fireEvent.keyDown(colour, { key: 'Enter' });
    fireEvent.blur(colour);
    expect(valueOf(box, 'noise', 'color')).toBe('#112233');
  });

  it('a choice: the options are the schema\'s own', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    const shape = add(box, 'shape');
    const schema = shape.params.shape;
    if (schema.type !== 'select') throw new Error('a shape\'s shape is a choice');
    const field = within(settings(shape.name)).getByLabelText('Shape') as HTMLSelectElement;
    expect([...field.options].map((o) => o.value)).toEqual(schema.options);
    const other = schema.options.find((o) => o !== schema.value)!;
    fireEvent.change(field, { target: { value: other } });
    expect(valueOf(box, shape.id, 'shape')).toBe(other);
  });

  it('a switch', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    pick('Grain');
    const before = valueOf(box, 'grain', 'premultiply');
    fireEvent.click(within(settings('Grain')).getByRole('switch', { name: 'Premultiply' }));
    expect(valueOf(box, 'grain', 'premultiply')).toBe(!before);
  });

  it('text: nothing is stored while typing, Enter stores it as one undo step', () => {
    const { box, history } = setup();
    render(<FxSceneSection component={box} />);
    const text = add(box, 'text');
    history.clear();
    const field = within(settings(text.name)).getByLabelText('Headline') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'W' } });
    fireEvent.change(field, { target: { value: 'Werkstatt' } });
    expect(valueOf(box, text.id, 'headlineText')).toBe('Lumitra');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(valueOf(box, text.id, 'headlineText')).toBe('Werkstatt');
    undo();
    expect(valueOf(box, text.id, 'headlineText')).toBe('Lumitra');
    expect(history.canUndo).toBe(false);
  });

  it('a pair of numbers: each half is a number of its own and keeps the other', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    const shape = add(box, 'shape');
    const before = valueOf(box, shape.id, 'position') as [number, number];
    const horizontal = within(settings(shape.name)).getByLabelText('Position, horizontal, as a number') as HTMLInputElement;
    fireEvent.change(horizontal, { target: { value: '0.25' } });
    fireEvent.keyDown(horizontal, { key: 'Enter' });
    expect(valueOf(box, shape.id, 'position')).toEqual([0.25, before[1]]);
    const vertical = within(settings(shape.name)).getByLabelText('Position, vertical, as a number') as HTMLInputElement;
    fireEvent.change(vertical, { target: { value: '-0.5' } });
    fireEvent.keyDown(vertical, { key: 'Enter' });
    expect(valueOf(box, shape.id, 'position')).toEqual([0.25, -0.5]);
  });

  it('what god rays read from is offered by layer name, and follows a removal with a note', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    const rays = add(box, 'godRays');
    const field = within(settings(rays.name)).getByLabelText('Reads from') as HTMLSelectElement;
    expect([...field.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Gradient', 'Noise Field']));
    fireEvent.change(field, { target: { value: 'noise' } });
    expect(valueOf(box, rays.id, 'sourceLayerId')).toBe('noise');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Noise Field' }));
    expect(valueOf(box, rays.id, 'sourceLayerId')).toBe('gradient-bg');
    expect(screen.getByRole('status').textContent).toMatch(/Adjusted while saving/);

    // The note belongs to that change: after an undo it is gone, not left behind.
    undo();
    expect(valueOf(box, rays.id, 'sourceLayerId')).toBe('noise');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a picture for an image layer', () => {
  const file = (bytes = 10) => new File([new Uint8Array(bytes)], 'hero.png', { type: 'image/png' });
  const upload = (f: File) => fireEvent.change(screen.getByLabelText('Upload a picture for this layer'), { target: { files: [f] } });

  it('is uploaded to the site and stored as its site path, never as a typed address', async () => {
    const { box, project } = setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: SITE_IMAGE }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FxSceneSection component={box} />);
    const image = add(box, 'image');
    expect(within(settings(image.name)).queryByLabelText('Src')).toBeNull();

    upload(file());
    await waitFor(() => expect(valueOf(box, image.id, 'src')).toBe(SITE_IMAGE));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/projects/${project.id}/images?kind=scene`);
    expect(init.method).toBe('POST');
    // The preview is the editor's own address of the stored picture.
    expect(settings(image.name).querySelector('img')?.getAttribute('src')).toBe(`/api/projects/${project.id}/images/${'a'.repeat(64)}`);

    fireEvent.click(within(settings(image.name)).getByRole('button', { name: 'Remove' }));
    expect(valueOf(box, image.id, 'src')).toBe('');
  });

  it('lands on the scene as it is when the upload finishes, keeping what was changed meanwhile', async () => {
    const { box } = setup();
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))));
    render(<FxSceneSection component={box} />);
    const image = add(box, 'image');
    upload(file());
    // Changed while the picture is on its way.
    choose('Starts', 'visible');
    expect(fxOf(box).start).toBe('visible');
    await act(async () => finish(new Response(JSON.stringify({ path: SITE_IMAGE }), { status: 200 })));
    await waitFor(() => expect(valueOf(box, image.id, 'src')).toBe(SITE_IMAGE));
    expect(fxOf(box).start).toBe('visible');
    expect(screen.getByText('Picture uploaded.').getAttribute('aria-live')).toBe('polite');
  });

  it('refuses a file that is too large before sending it', () => {
    const { box } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<FxSceneSection component={box} />);
    const image = add(box, 'image');
    const big = file(1);
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 });
    upload(big);
    expect(screen.getByRole('alert').textContent).toMatch(/can be at most/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(valueOf(box, image.id, 'src')).toBe('');
  });

  it('shows the server\'s refusal and the lost connection, and stores nothing', async () => {
    const { box } = setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'This is not a picture the site can show. Export it as PNG.' } }), { status: 415 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FxSceneSection component={box} />);
    const image = add(box, 'image');
    upload(file());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Export it as PNG/));
    expect(valueOf(box, image.id, 'src')).toBe('');

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    upload(file());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no connection/));
    expect(valueOf(box, image.id, 'src')).toBe('');
    // The button is back: the upload can be tried again.
    expect((within(settings(image.name)).getByRole('button', { name: 'Upload' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('in the demo, which no server holds, says how to get on instead of failing', () => {
    const { box, store, project } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    store.editorUI.markUnsavedDemo(project.id);
    render(<FxSceneSection component={box} />);
    add(box, 'image');
    upload(file());
    expect(screen.getByRole('alert').textContent).toMatch(/Keep as project/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the layer list', () => {
  it('adds at the front and selects what it added, hides, moves and removes', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    const shape = add(box, 'shape');
    expect(listedNames().at(-1)).toBe(shape.name);
    expect(settings(shape.name)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: `Hide ${shape.name}` }));
    expect(layerOf(box, shape.id).visible).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: `Show ${shape.name}` }));
    expect(layerOf(box, shape.id).visible).toBe(true);

    // The ends cannot move further.
    expect((screen.getByRole('button', { name: 'Move Gradient toward the back' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: `Move ${shape.name} toward the front` }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Noise Field toward the back' }));
    expect(listedNames().slice(0, 2)).toEqual(['Noise Field', 'Gradient']);

    // Removing the picked layer closes its settings.
    fireEvent.click(screen.getByRole('button', { name: `Remove ${shape.name}` }));
    expect(layersOf(box).some((l) => l.id === shape.id)).toBe(false);
    expect(screen.queryByRole('group', { name: `Settings of ${shape.name}` })).toBeNull();
  });

  it('renames a layer, and the list and the settings follow', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    pick('Bloom');
    const name = within(settings('Bloom')).getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Glow' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(layerOf(box, 'bloom').name).toBe('Glow');
    expect(listedNames()).toContain('Glow');
    expect(settings('Glow')).toBeTruthy();
  });

  it('refuses one layer too many with the way on, and keeps the scene', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    while (layersOf(box).length < FX_LIMITS.layers) add(box, 'vignette');
    choose('Add a layer', 'vignette');
    expect(layersOf(box)).toHaveLength(FX_LIMITS.layers);
    expect(screen.getByRole('alert').textContent).toMatch(new RegExp(`at most ${FX_LIMITS.layers} layers. Remove one first`));
    // The refusal goes away with the next change that is stored.
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove / }).at(-1)!);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an empty scene says so and offers the way on', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    for (const name of ['Gradient', 'Noise Field', 'Bloom', 'Vignette', 'Grain']) fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    expect(layersOf(box)).toEqual([]);
    expect(screen.getByText(/This scene has no layers/)).toBeTruthy();
    add(box, 'gradient');
    expect(listed()).toHaveLength(1);
  });
});

describe('the scene\'s own settings', () => {
  it('stores when it starts, what reduced motion shows and the scene background', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    choose('Starts', 'visible');
    choose('With reduced motion', 'frame');
    const background = screen.getByLabelText('Scene background') as HTMLInputElement;
    fireEvent.change(background, { target: { value: '#010203' } });
    fireEvent.keyDown(background, { key: 'Enter' });
    fireEvent.blur(background);
    const fx = fxOf(box);
    expect(fx.start).toBe('visible');
    expect(fx.calm).toBe('frame');
    expect(fx.scene.background).toBe('#010203');
  });

  it('a preset replaces the layers and keeps the start and reduced motion settings', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    choose('Starts', 'immediate');
    pick('Bloom');
    choose('Replace with a preset', 'bokeh-focuspull');
    expect(listedNames()).toEqual(['Backdrop', 'Orb A', 'Orb B', 'Lockup', 'Bokeh Focus-Pull', 'Bloom', 'Vignette', 'Grain']);
    expect(fxOf(box).start).toBe('immediate');
    // The picked layer was the old scene's: nothing is picked now.
    expect(screen.queryByRole('group', { name: /^Settings of/ })).toBeNull();
  });
});

describe('copying and importing the scene as JSON', () => {
  it('copies exactly what is stored, and an import of it gives the same scene back', async () => {
    const { box } = setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<FxSceneSection component={box} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy scene JSON' }));
    await waitFor(() => expect(screen.getByText('Copied.')).toBeTruthy());
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    const before = JSON.stringify(fxOf(box).scene);

    choose('Replace with a preset', 'godrays-hero');
    choose('With reduced motion', 'frame');
    expect(JSON.stringify(fxOf(box).scene)).not.toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Import scene JSON' }));
    fireEvent.change(screen.getByLabelText('Scene JSON'), { target: { value: copied } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace the scene with this' }));
    await waitFor(() => expect(JSON.stringify(fxOf(box).scene)).toBe(before));
    // The import replaces the scene only.
    expect(fxOf(box).calm).toBe('frame');
    // And it closes: the field is gone.
    expect(screen.queryByLabelText('Scene JSON')).toBeNull();
  });

  it('where the clipboard is refused, shows the text to copy by hand', async () => {
    const { box } = setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true });
    render(<FxSceneSection component={box} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy scene JSON' }));
    await waitFor(() => expect(screen.getByText(/Copying was not allowed here/)).toBeTruthy());
    expect(JSON.parse((screen.getByLabelText('Scene JSON') as HTMLTextAreaElement).value).layers).toHaveLength(5);
  });

  it('refuses a Studio scene with a layer that has no id or type, instead of dropping it silently', async () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    const before = layersOf(box).length;
    fireEvent.click(screen.getByRole('button', { name: 'Import scene JSON' }));
    fireEvent.change(screen.getByLabelText('Scene JSON'), { target: { value: JSON.stringify({ root: { children: [{}] } }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace the scene with this' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Layer 1 .* no id or no type/));
    expect(layersOf(box)).toHaveLength(before);
  });

  it('converts a scene in Lumitra Studio\'s format, which holds its layers under root.children', async () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    const studio = {
      version: 2,
      id: 'from-studio',
      canvas: { background: '#101010' },
      root: {
        id: 'root',
        type: 'fx.stack',
        children: [
          { id: 'wash', type: 'fx.gradient', name: 'Wash', visible: true, blend: 'normal', params: {} },
          { id: 'glow', type: 'fx.bloom', name: 'Glow', visible: true, blend: 'add', params: {} },
        ],
      },
    };
    fireEvent.click(screen.getByRole('button', { name: 'Import scene JSON' }));
    fireEvent.change(screen.getByLabelText('Scene JSON'), { target: { value: JSON.stringify(studio) } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace the scene with this' }));
    await waitFor(() => expect(listedNames()).toEqual(['Wash', 'Glow']));
    expect(layersOf(box).map((l) => l.type)).toEqual(['gradient', 'bloom']);
    expect(fxOf(box).scene.background).toBe('#101010');
  });

  it('refuses text that is not JSON, JSON that is no scene, and a scene the reader refuses, each with the reason', async () => {
    const { box } = setup();
    const before = JSON.stringify(fxOf(box));
    render(<FxSceneSection component={box} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import scene JSON' }));
    const replace = screen.getByRole('button', { name: 'Replace the scene with this' }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    const field = screen.getByLabelText('Scene JSON');

    fireEvent.change(field, { target: { value: '{ not json' } });
    fireEvent.click(replace);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/This is not JSON/));

    fireEvent.change(field, { target: { value: '{"hello":"world"}' } });
    fireEvent.click(replace);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not an FX scene/));

    // An image layer with an address from somewhere else: refused whole.
    const foreign = { background: '#000000', layers: [{ id: 'pic', type: 'image', name: 'Pic', visible: true, blend: 'normal', params: { src: 'https://evil.test/a.png' } }] };
    fireEvent.change(field, { target: { value: JSON.stringify(foreign) } });
    fireEvent.click(replace);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/uploaded to this site/));

    expect(JSON.stringify(fxOf(box))).toBe(before);
    // The text is still there to correct.
    expect((field as HTMLTextAreaElement).value).toContain('evil.test');
  });
});

describe('the four paths of editing a scene', () => {
  it('forward: a preset, a layer, a setting, each stored through the reader', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    choose('Replace with a preset', 'noise-gradient');
    const shape = add(box, 'shape');
    const size = within(settings(shape.name)).getByLabelText('Size, as a number') as HTMLInputElement;
    const schema = shape.params.size;
    if (schema.type !== 'number') throw new Error('a shape\'s size is a number');
    fireEvent.change(size, { target: { value: String(schema.max) } });
    fireEvent.keyDown(size, { key: 'Enter' });
    expect(valueOf(box, shape.id, 'size')).toBe(schema.max);
    // What is stored reads back with nothing to repair.
    const again = parseFxProp(JSON.parse(JSON.stringify((box.props as Record<string, unknown>)[FX_PROP])));
    expect(again.ok && again.notes).toEqual([]);
  });

  it('going back: another kind resets that layer\'s settings and keeps every other layer; the same kind keeps them', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    pick('Noise Field');
    const colour = within(settings('Noise Field')).getByLabelText('Color') as HTMLInputElement;
    fireEvent.change(colour, { target: { value: '#445566' } });
    fireEvent.keyDown(colour, { key: 'Enter' });
    fireEvent.blur(colour);
    const others = () => JSON.stringify(layersOf(box).filter((_, index) => index !== 1));
    const othersBefore = others();
    const noiseBefore = JSON.stringify(layersOf(box)[1]);

    // The same kind again: nothing derived is thrown away.
    choose('Kind', 'noiseFill');
    expect(JSON.stringify(layersOf(box)[1])).toBe(noiseBefore);

    // Another kind: its own defaults, in the same place, shown and blended as before.
    choose('Kind', 'shape');
    const replaced = layersOf(box)[1];
    expect(replaced.type).toBe('shape');
    expect(Object.keys(replaced.params)).not.toContain('intensity');
    expect(replaced.params.color.value).not.toBe('#445566');
    expect(others()).toBe(othersBefore);
    // The settings shown are the new layer's, not the old one's left on screen.
    const shown = settings(replaced.name);
    expect(within(shown).getByLabelText('Shape')).toBeTruthy();
    expect(within(shown).queryByLabelText('Intensity')).toBeNull();

    // And back again: the first kind starts from its defaults, not from what was typed before.
    choose('Kind', 'noiseFill');
    expect(layersOf(box)[1].type).toBe('noiseFill');
    expect(layersOf(box)[1].params.color.value).not.toBe('#445566');
    expect(others()).toBe(othersBefore);
  });

  it('a reload: the saved project restores the scene exactly, and the panel edits it on', () => {
    const { box, project } = setup();
    const view = render(<FxSceneSection component={box} />);
    choose('Starts', 'visible');
    const shape = add(box, 'shape');
    const stored = JSON.stringify(fxOf(box));
    view.unmount();

    const reloaded = ProjectModel.create(JSON.parse(JSON.stringify(getSnapshot(project))));
    const find = (node: ComponentInstance): ComponentInstance | undefined =>
      node.id === box.id ? node : (node.children as ComponentInstance[]).map(find).find(Boolean);
    const again = find(reloaded.findPageBySlug('')!.appComponentTree as ComponentInstance)!;
    expect(JSON.stringify(fxOf(again))).toBe(stored);

    render(<FxSceneSection component={again} />);
    expect(listedNames().at(-1)).toBe(shape.name);
    expect((screen.getByLabelText('Starts') as HTMLSelectElement).value).toBe('visible');
    // What was picked before the reload is not: the panel starts clean.
    expect(screen.queryByRole('group', { name: /^Settings of/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Hide ${shape.name}` }));
    expect(layerOf(again, shape.id).visible).toBe(false);
  });

  it('coming back: undo after a removal restores the layer with its settings, and it can be picked again', () => {
    const { box } = setup();
    render(<FxSceneSection component={box} />);
    pick('Bloom');
    const text = screen.getByLabelText('Intensity, as a number') as HTMLInputElement;
    fireEvent.change(text, { target: { value: '0.5' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    const before = JSON.stringify(layersOf(box));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bloom' }));
    expect(listedNames()).not.toContain('Bloom');
    expect(screen.queryByRole('group', { name: 'Settings of Bloom' })).toBeNull();

    undo();
    expect(JSON.stringify(layersOf(box))).toBe(before);
    expect(listedNames()).toEqual(['Gradient', 'Noise Field', 'Bloom', 'Vignette', 'Grain']);
    pick('Bloom');
    expect((screen.getByLabelText('Intensity, as a number') as HTMLInputElement).value).toBe('0.5');
  });

  it('coming back: another box starts clean, with nothing of the last one\'s selection or messages', () => {
    const { box, page } = setup();
    const other = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
    const view = render(<FxSceneSection component={box} />);
    pick('Bloom');
    while (layersOf(box).length < FX_LIMITS.layers) add(box, 'vignette');
    choose('Add a layer', 'vignette');
    expect(screen.getByRole('alert')).toBeTruthy();

    view.rerender(<FxSceneSection component={other} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('group', { name: /^Settings of/ })).toBeNull();
    expect(listed()).toHaveLength(5);
  });

  it('coming back from a scene that cannot be read: the box says why and a preset is the way on', () => {
    const { box } = setup();
    act(() => box.setProps({ [FX_PROP]: { version: 99, scene: {} } }));
    render(<FxSceneSection component={box} />);
    expect(screen.getByRole('alert').textContent).toMatch(/has no FX scene that can be drawn/);
    expect(screen.queryByRole('list')).toBeNull();
    choose('Start from a preset', 'gold-noise-gradient');
    expect(listedNames()).toEqual(['Gradient', 'Noise Field', 'Bloom', 'Vignette', 'Grain']);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Live: the scene on the canvas', () => {
  const liveSwitch = () => screen.getByRole('switch', { name: 'Live' });

  it('is off by default and says what the canvas shows; on, it is for this box in the frame it is picked in', () => {
    const { box, store, page } = setup();
    const frame = page.sortedViewportNodes[1];
    act(() => store.editorUI.selectComponent(box, frame.breakpointId!));
    render(<FxSceneSection component={box} />);
    expect(liveSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/The canvas shows the box with its own background/)).toBeTruthy();

    fireEvent.click(liveSwitch());
    expect(store.editorUI.fxLive).toEqual({ componentId: box.id, frameId: frame.breakpointId });
    expect(liveSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe(`Starting the scene in ${frame.label}...`);

    act(() => store.editorUI.reportFxLive({ state: 'live' }));
    expect(screen.getByRole('status').textContent).toMatch(new RegExp(`The scene is drawn in ${frame.label}, and every change here shows at once`));

    fireEvent.click(liveSwitch());
    expect(store.editorUI.fxLive).toBeUndefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a box picked outside a frame (in the Layers panel) is drawn wherever it is drawn first', () => {
    const { box, store } = setup();
    act(() => store.editorUI.selectComponent(box));
    render(<FxSceneSection component={box} />);
    fireEvent.click(liveSwitch());
    expect(store.editorUI.fxLive).toEqual({ componentId: box.id, frameId: null });
    expect(screen.getByRole('status').textContent).toBe('Starting the scene on the canvas...');
    act(() => store.editorUI.stopFxLive());
  });

  it('Live on for another box does not show as on here', () => {
    const { box, page, store } = setup();
    const other = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
    act(() => store.editorUI.startFxLive(other.id, null));
    render(<FxSceneSection component={box} />);
    expect(liveSwitch().getAttribute('aria-checked')).toBe('false');
    act(() => store.editorUI.stopFxLive());
  });

  it.each([
    ['no-webgl', /WebGL is not available/],
    ['context-lost', /took the graphics context away/],
    ['renderer-error', /stopped while it was being drawn/],
    ['refused', /cannot be drawn as it is stored/],
    ['engine', /did not load/],
    ['something-new', /stopped while it was being drawn/],
  ])('says why the scene is not drawn (%s), with the way on', (reason, text) => {
    const { box, store } = setup();
    act(() => store.editorUI.startFxLive(box.id, null));
    act(() => store.editorUI.reportFxLive({ state: 'off', reason }));
    render(<FxSceneSection component={box} />);
    expect(screen.getByRole('alert').textContent).toMatch(text);
    act(() => store.editorUI.stopFxLive());
  });
});
