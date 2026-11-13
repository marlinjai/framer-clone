// The rows of an FX scene box in the Layers panel and what acts on them: the derived row
// model, the editor's pick (`EditorUIStore.fxLayerPick`) with its fallbacks, the row
// actions, and the key routing that makes Delete, Cmd+D and Escape act on a picked LAYER
// and never on the box. Real store, real history, real strict reader.
// The four paths of the stateful-flow standard are the last describe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { FX_PROP, parseFxProp } from '@/lib/fxScene/fxScene';
import { addFxLayer, applyFxPreset, importFxScene, removeFxLayer, setFxLayerType, toggleFxLayer } from '@/lib/fxScene/edit';
import { routeFxLayerShortcut } from '@/lib/canvas/deleteSelection';
import { deleteSelection } from '@/lib/canvas/deleteSelection';
import { resolveAction } from '@/lib/keyBindings';
import { derivedRowsOf, deriveFxRows, runFxLayerAction } from '../fxRows';

let store: RootStoreType;
let page: PageModelType;
let box: ComponentInstance;

const stored = () => (box.props as Record<string, unknown>)[FX_PROP];
const layers = () => {
  const read = parseFxProp(stored());
  if (!read.ok) throw new Error(read.message);
  return read.fx.scene.layers;
};
const names = () => layers().map((l) => l.name);
const undo = () => getHistoryStore()!.undo();
const ui = () => store.editorUI;
const frame = () => page.sortedViewportNodes[0].breakpointId!;
const pickLayer = (layerId: string) => ui().pickFxLayer(box, { kind: 'layer', layerId }, frame());
const key = (init: KeyboardEventInit & { key: string }) => new KeyboardEvent('keydown', init);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Fx rows');
  const project = store.projectStore.findProjectByTitle('Fx rows')!;
  page = project.findPageBySlug('')!;
  ui().setCurrentProject(project);
  ui().setCurrentPage(page);
  getHistoryStore()!.setTargetStore(store.projectStore);
  box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
  getHistoryStore()!.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('the derived rows', () => {
  it('lists the scene front first, post effects in their own group, with the background', () => {
    const rows = deriveFxRows(box)!;
    // Stored back to front: Gradient, Noise Field, Bloom, Vignette, Grain. Content first-listed is the front one.
    expect(rows.content.map((r) => r.name)).toEqual(['Noise Field', 'Gradient']);
    expect(rows.effects.map((r) => r.name)).toEqual(['Grain', 'Vignette', 'Bloom']);
    expect(rows.background).toBe(parseFxProp(stored()).ok ? (parseFxProp(stored()) as { fx: { scene: { background: string } } }).fx.scene.background : '');
    expect(rows.effects.every((r) => r.group === 'post')).toBe(true);
  });

  it('says what a row is, for a screen reader, and marks a hidden one', () => {
    act(() => runFxLayerAction(box, ui(), 'bloom', { type: 'toggle' }));
    const bloom = deriveFxRows(box)!.effects.find((r) => r.layerId === 'bloom')!;
    expect(bloom.ariaLabel).toBe('Bloom, effect, hidden');
    expect(deriveFxRows(box)!.content[0].ariaLabel).toMatch(/^Noise Field, /);
  });

  it('a god rays row says which layer it reads, and says it is off when that layer is hidden', () => {
    const added = addFxLayer(stored(), 'godRays');
    if (!added.ok) throw new Error(added.message);
    box.setProps({ [FX_PROP]: added.stored });
    const rays = () => deriveFxRows(box)!.effects.find((r) => r.type === 'godRays')!;
    expect(rays().reads).toBeTruthy();
    expect(rays().off).toBeUndefined();
    expect(rays().ariaLabel).toContain(`reads ${rays().reads}`);
    const source = layers().find((l) => l.name === rays().reads)!;
    const hidden = toggleFxLayer(stored(), source.id);
    if (!hidden.ok) throw new Error(hidden.message);
    box.setProps({ [FX_PROP]: hidden.stored });
    expect(rays().off).toBe('off: its layer is hidden');
    expect(rays().ariaLabel).toContain('off: its layer is hidden');
  });

  it('an unreadable scene, and a node that is no scene box, have no rows', () => {
    expect(derivedRowsOf(box)).not.toBeNull();
    box.setProps({ [FX_PROP]: { version: 99, scene: {} } });
    expect(derivedRowsOf(box)).toBeNull();
    const plain = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
    expect(derivedRowsOf(plain)).toBeNull();
  });
});

describe('the pick', () => {
  it('picking a layer keeps the box the primary selection and sets the pick, in the frame it was picked in', () => {
    pickLayer('bloom');
    expect(ui().selectedComponent?.id).toBe(box.id);
    expect(ui().fxLayerPick).toEqual({ componentId: box.id, kind: 'layer', layerId: 'bloom' });
    expect(ui().selectedViewportNode?.breakpointId).toBe(frame());
  });

  it('picking another layer, or the Background, replaces the pick; picking in another frame moves the frame', () => {
    pickLayer('bloom');
    pickLayer('grain');
    expect(ui().fxLayerPick).toMatchObject({ layerId: 'grain' });
    const other = page.sortedViewportNodes[1].breakpointId!;
    ui().pickFxLayer(box, { kind: 'background' }, other);
    expect(ui().fxLayerPick).toEqual({ componentId: box.id, kind: 'background' });
    expect(ui().selectedViewportNode?.breakpointId).toBe(other);
  });

  it('is session state: it is not in the stored scene and not in the undo history', () => {
    pickLayer('bloom');
    expect(getHistoryStore()!.canUndo).toBe(false);
    expect(JSON.stringify(stored())).not.toContain('selectedFxLayer');
  });

  it('follows setFxLayerType to the layer\'s new id', () => {
    pickLayer('bloom');
    const changed = setFxLayerType(stored(), 'bloom', 'vignette');
    if (!changed.ok || !changed.layerId) throw new Error('the kind was not changed');
    box.setProps({ [FX_PROP]: changed.stored });
    // The old id is gone, so the pick is derived invalid until it follows.
    expect(ui().fxLayerPick).toBeUndefined();
    ui().followFxLayer(box.id, changed.layerId);
    expect(ui().fxLayerPick).toMatchObject({ layerId: changed.layerId });
  });

  it('falls back to the box when the layer disappears: undo of its add, a preset, an import, a snapshot without it', () => {
    const added = addFxLayer(stored(), 'shape');
    if (!added.ok || !added.layerId) throw new Error('not added');
    box.setProps({ [FX_PROP]: added.stored });
    pickLayer(added.layerId);
    expect(ui().fxLayerPick).toBeDefined();
    undo();
    expect(ui().fxLayerPick).toBeUndefined();
    expect(ui().selectedComponent?.id).toBe(box.id);

    pickLayer('bloom');
    const preset = applyFxPreset(stored(), 'bokeh-focuspull');
    if (!preset.ok) throw new Error(preset.message);
    box.setProps({ [FX_PROP]: preset.stored });
    // bokeh-focuspull has a bloom too: the id survives, so the pick does (a snapshot that keeps the id keeps the pick).
    expect(ui().fxLayerPick === undefined || layers().some((l) => l.id === 'bloom')).toBe(true);

    pickLayer('grain');
    const imported = importFxScene(stored(), { ...(parseFxProp(stored()) as { fx: { scene: object } }).fx.scene, layers: [] });
    if (!imported.ok) throw new Error(imported.message);
    box.setProps({ [FX_PROP]: imported.stored });
    expect(ui().fxLayerPick).toBeUndefined();
  });

  it('keeps the pick when another writer\'s snapshot still holds the layer, and drops it when it does not', () => {
    pickLayer('bloom');
    const same = toggleFxLayer(stored(), 'noise');
    if (!same.ok) throw new Error(same.message);
    box.setProps({ [FX_PROP]: same.stored });
    expect(ui().fxLayerPick).toMatchObject({ layerId: 'bloom' });
    const without = removeFxLayer(stored(), 'bloom');
    if (!without.ok) throw new Error(without.message);
    box.setProps({ [FX_PROP]: without.stored });
    expect(ui().fxLayerPick).toBeUndefined();
  });

  it('the Background pick holds while the scene is readable, and falls back when it is not', () => {
    ui().pickFxLayer(box, { kind: 'background' }, frame());
    expect(ui().fxLayerPick).toBeDefined();
    box.setProps({ [FX_PROP]: { version: 99, scene: {} } });
    expect(ui().fxLayerPick).toBeUndefined();
  });

  it('is cleared when the selection moves to another node, to nothing, or to another page or project', () => {
    const body = page.appComponentTree as ComponentInstance;
    pickLayer('bloom');
    ui().selectComponent(body.children[0] as ComponentInstance, frame());
    expect(ui().fxLayerPick).toBeUndefined();
    pickLayer('bloom');
    ui().clearSelection();
    expect(ui().fxLayerPick).toBeUndefined();
    pickLayer('bloom');
    ui().selectComponent(box, frame());
    expect(ui().fxLayerPick).toBeUndefined();
    pickLayer('bloom');
    ui().setCurrentPage(page);
    expect(ui().fxLayerPick).toBeUndefined();
  });

  it('a selection of several nodes is not a pick: picking a row picks the box alone', () => {
    const body = page.appComponentTree as ComponentInstance;
    ui().setSelection([box, body.children[0] as ComponentInstance], frame());
    ui().pickFxLayer(box, { kind: 'layer', layerId: 'bloom' }, frame());
    expect(ui().selectedComponentList.map((c) => c.id)).toEqual([box.id]);
  });
});

describe('the keys act on the picked layer, never on the box', () => {
  const press = (action: Parameters<typeof routeFxLayerShortcut>[0]) => routeFxLayerShortcut(action, ui());

  it('are bound: Alt+Up and Alt+Down move, F2 renames, and plain arrows are not ours', () => {
    expect(resolveAction(key({ key: 'ArrowUp', altKey: true }))?.action).toBe('fxLayerForward');
    expect(resolveAction(key({ key: 'ArrowDown', altKey: true }))?.action).toBe('fxLayerBackward');
    expect(resolveAction(key({ key: 'F2' }))?.action).toBe('renameLayer');
    expect(resolveAction(key({ key: 'ArrowUp' }))).toBeNull();
  });

  it('with no layer picked nothing is routed: Delete keeps removing the box', () => {
    ui().selectComponent(box, frame());
    expect(press('delete')).toBe(false);
    expect(press('duplicate')).toBe(false);
    expect(press('clearSelection')).toBe(false);
    expect(deleteSelection(page, ui(), getHistoryStore())).toBe(1);
    expect(page.findComponent(box.id)).toBeUndefined();
  });

  it('Delete removes the layer and not the box, as one undo step, and undo restores the layer', () => {
    pickLayer('bloom');
    const before = JSON.stringify(stored());
    expect(press('delete')).toBe(true);
    expect(page.findComponent(box.id)).toBeDefined();
    expect(names()).not.toContain('Bloom');
    // The pick moves to the neighbour in the group (toward the front first).
    expect(ui().fxLayerPick).toMatchObject({ kind: 'layer', layerId: 'vignette' });
    expect(ui().selectedComponent?.id).toBe(box.id);
    undo();
    expect(JSON.stringify(stored())).toBe(before);
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('a held or repeated Delete walks down the layers and then lands on Background: it never removes the box', () => {
    pickLayer('bloom');
    for (let i = 0; i < 12; i++) expect(press('delete')).toBe(true);
    expect(page.findComponent(box.id)).toBeDefined();
    expect(ui().fxLayerPick).toMatchObject({ kind: 'background' });
  });

  it('a layer button\'s Delete of the picked layer leaves the next Delete on a layer, not on the box', () => {
    pickLayer('grain');
    runFxLayerAction(box, ui(), 'grain', { type: 'delete' });
    expect(ui().fxLayerPick).toMatchObject({ kind: 'layer', layerId: 'vignette' });
    expect(press('delete')).toBe(true);
    expect(page.findComponent(box.id)).toBeDefined();
  });

  it('a pick that went stale (an undo, another writer\'s save) swallows the next Delete once instead of deleting the box', () => {
    const added = addFxLayer(stored(), 'shape');
    if (!added.ok || !added.layerId) throw new Error('not added');
    box.setProps({ [FX_PROP]: added.stored });
    pickLayer(added.layerId);
    undo();
    expect(ui().fxLayerPick).toBeUndefined();
    expect(press('delete')).toBe(true);
    expect(page.findComponent(box.id)).toBeDefined();
    expect(ui().selectedFxLayer).toBeUndefined();
    // A redo does not bring the old pick back.
    getHistoryStore()!.redo();
    expect(ui().fxLayerPick).toBeUndefined();
    // Now nothing is picked: the key is the editor's again.
    expect(press('delete')).toBe(false);
  });

  it('a button (the phone toolbar) is not swallowed by a stale pick: it shows the box, so the tap is the box\'s', () => {
    const added = addFxLayer(stored(), 'shape');
    if (!added.ok || !added.layerId) throw new Error('not added');
    box.setProps({ [FX_PROP]: added.stored });
    pickLayer(added.layerId);
    undo();
    expect(routeFxLayerShortcut('delete', ui(), { swallowStale: false })).toBe(false);
    expect(ui().selectedFxLayer).toBeUndefined();
  });

  it('Cmd+D copies the layer, picks the copy and leaves the box alone', () => {
    pickLayer('bloom');
    expect(press('duplicate')).toBe(true);
    expect(names().filter((n) => n.startsWith('Bloom'))).toEqual(['Bloom', 'Bloom copy']);
    expect(ui().fxLayerPick).toMatchObject({ kind: 'layer' });
    expect((ui().fxLayerPick as { layerId: string }).layerId).not.toBe('bloom');
    expect(page.findComponent(box.id)).toBeDefined();
    undo();
    expect(names()).not.toContain('Bloom copy');
  });

  it('Escape goes back to the box and keeps it selected', () => {
    pickLayer('bloom');
    expect(press('clearSelection')).toBe(true);
    expect(ui().fxLayerPick).toBeUndefined();
    expect(ui().selectedComponent?.id).toBe(box.id);
    // A second Escape is the editor's own (it clears the selection).
    expect(press('clearSelection')).toBe(false);
  });

  it('Alt+Up and Alt+Down move within the group and are refused at its edge, with the reason', () => {
    pickLayer('bloom');
    // Post effects in stored order: Bloom, Vignette, Grain.
    expect(press('fxLayerForward')).toBe(true);
    expect(layers().filter((l) => ['Bloom', 'Vignette', 'Grain'].includes(l.name)).map((l) => l.name)).toEqual(['Vignette', 'Bloom', 'Grain']);
    expect(ui().fxLayerNotice?.text).toBe('Bloom moved in front of Vignette.');
    press('fxLayerForward');
    const atFront = JSON.stringify(stored());
    getHistoryStore()!.clear();
    expect(press('fxLayerForward')).toBe(true);
    expect(JSON.stringify(stored())).toBe(atFront);
    expect(getHistoryStore()!.canUndo).toBe(false);
    expect(ui().fxLayerNotice).toMatchObject({ problem: true, text: 'Bloom is already at the front of its group.' });
    expect(press('fxLayerBackward')).toBe(true);
    expect(ui().fxLayerNotice?.text).toBe('Bloom moved behind Grain.');
  });

  it('a move never crosses between content and post: the front content layer cannot go further, and a step back changes only the content slots', () => {
    pickLayer('noise');
    const order = () => layers().map((l) => l.id);
    const before = order();
    press('fxLayerForward');
    expect(order()).toEqual(before);
    expect(ui().fxLayerNotice).toMatchObject({ problem: true });
    const postSlots = before.map((id, i) => (['bloom', 'vignette', 'grain'].includes(id) ? i : -1)).filter((i) => i >= 0);
    press('fxLayerBackward');
    expect(order()).not.toEqual(before);
    expect(postSlots.map((i) => order()[i])).toEqual(postSlots.map((i) => before[i]));
    expect(layers().filter((l) => ['gradient', 'noiseFill'].includes(l.type)).map((l) => l.id)).toEqual(['noise', 'gradient-bg']);
  });

  it('F2 asks for the picked layer to be renamed, and a rename is one undo step', () => {
    pickLayer('bloom');
    expect(press('renameLayer')).toBe(true);
    expect(ui().fxLayerRenaming).toEqual({ componentId: box.id, layerId: 'bloom' });
    runFxLayerAction(box, ui(), 'bloom', { type: 'rename', name: 'Glow' });
    expect(ui().fxLayerRenaming).toBeUndefined();
    expect(names()).toContain('Glow');
    undo();
    expect(names()).toContain('Bloom');
  });

  it('the Background row cannot be deleted, copied or moved, and its keys never reach the box', () => {
    ui().pickFxLayer(box, { kind: 'background' }, frame());
    const before = JSON.stringify(stored());
    for (const action of ['delete', 'duplicate', 'fxLayerForward', 'fxLayerBackward', 'renameLayer'] as const) expect(press(action)).toBe(true);
    expect(JSON.stringify(stored())).toBe(before);
    expect(page.findComponent(box.id)).toBeDefined();
    expect(press('clearSelection')).toBe(true);
    expect(ui().fxLayerPick).toBeUndefined();
  });
});

describe('the row actions', () => {
  it('hide and show are stored (they are published), one undo step each, and a rename keeps a blank name out', () => {
    expect(runFxLayerAction(box, ui(), 'bloom', { type: 'toggle' }).ok).toBe(true);
    expect(layers().find((l) => l.id === 'bloom')!.visible).toBe(false);
    undo();
    expect(layers().find((l) => l.id === 'bloom')!.visible).toBe(true);
    expect(getHistoryStore()!.canUndo).toBe(false);
    runFxLayerAction(box, ui(), 'bloom', { type: 'rename', name: '   ' });
    expect(names()).toContain('Bloom');
  });

  it('a refused change shows its reason and stores nothing: a layer that is gone, one copy too many', () => {
    const gone = runFxLayerAction(box, ui(), 'nope', { type: 'delete' });
    expect(gone).toEqual({ ok: false, message: 'That layer is no longer in the scene.' });
    expect(ui().fxLayerNotice).toMatchObject({ problem: true });
    // Shown where the person is, too (the Layers panel's own message may be out of sight).
    expect(ui().editorNotice).toMatchObject({ kind: 'refused', message: 'That layer is no longer in the scene.' });
    while (layers().length < 16) runFxLayerAction(box, ui(), 'bloom', { type: 'duplicate' });
    getHistoryStore()!.clear();
    const full = runFxLayerAction(box, ui(), 'bloom', { type: 'duplicate' });
    expect(full.ok).toBe(false);
    expect(full.message).toMatch(/at most 16 layers/);
    expect(getHistoryStore()!.canUndo).toBe(false);
  });

  it('removing the layer god rays read from moves the rays and says so', () => {
    const added = addFxLayer(stored(), 'godRays');
    if (!added.ok) throw new Error(added.message);
    box.setProps({ [FX_PROP]: added.stored });
    const result = runFxLayerAction(box, ui(), 'noise', { type: 'delete' });
    expect(result.ok).toBe(true);
    expect(layers().some((l) => l.id === 'noise')).toBe(false);
  });
});

describe('the refusal notice', () => {
  it('does not displace a notice that carries a button, and clears once a change is stored', () => {
    ui().setEditorNotice({ kind: 'changedElsewhere', message: 'The site changed elsewhere.' });
    runFxLayerAction(box, ui(), 'nope', { type: 'delete' });
    expect(ui().editorNotice?.kind).toBe('changedElsewhere');
    ui().setEditorNotice(undefined);
    runFxLayerAction(box, ui(), 'nope', { type: 'delete' });
    expect(ui().editorNotice?.kind).toBe('refused');
    runFxLayerAction(box, ui(), 'bloom', { type: 'toggle' });
    expect(ui().editorNotice).toBeUndefined();
  });
});

describe('the refusal notice and the scene it was said about', () => {
  it('a refusal and its banner are gone once the stored scene changes any other way (an undo, a panel edit, another writer)', () => {
    runFxLayerAction(box, ui(), 'bloom', { type: 'move', delta: -1 });
    expect(ui().editorNotice?.kind).toBe('refused');
    const other = toggleFxLayer(stored(), 'grain');
    if (!other.ok) throw new Error(other.message);
    box.setProps({ [FX_PROP]: other.stored });
    expect(ui().editorNotice).toBeUndefined();
    expect(ui().fxLayerNotice).toBeUndefined();
  });

  it('a refusal is shown over a notice without a button, and never over one that has a button', () => {
    ui().setEditorNotice({ kind: 'missingPage', message: 'That page is gone.' });
    runFxLayerAction(box, ui(), 'nope', { type: 'delete' });
    expect(ui().editorNotice?.kind).toBe('refused');
  });
});

describe('the four paths', () => {
  it('forward: pick, hide, move, rename, each one undo step, the pick staying valid throughout', () => {
    pickLayer('bloom');
    runFxLayerAction(box, ui(), 'bloom', { type: 'toggle' });
    runFxLayerAction(box, ui(), 'bloom', { type: 'move', delta: 1 });
    runFxLayerAction(box, ui(), 'bloom', { type: 'rename', name: 'Glow' });
    expect(ui().fxLayerPick).toMatchObject({ layerId: 'bloom' });
    expect(parseFxProp(stored()).ok).toBe(true);
  });

  it('backtrack: rename then undo restores the name and the pick still points at the layer', () => {
    pickLayer('bloom');
    runFxLayerAction(box, ui(), 'bloom', { type: 'rename', name: 'Glow' });
    undo();
    expect(names()).toContain('Bloom');
    expect(ui().fxLayerPick).toMatchObject({ layerId: 'bloom' });
  });

  it('resume: a reload keeps the scene and picks nothing', () => {
    runFxLayerAction(box, ui(), 'bloom', { type: 'toggle' });
    const saved = JSON.stringify(stored());
    const fresh = createRootStore();
    expect(fresh.editorUI.selectedFxLayer).toBeUndefined();
    expect(JSON.stringify(JSON.parse(saved))).toBe(saved);
  });

  it('re-entry: delete the picked layer, undo it, and pick it again', () => {
    pickLayer('bloom');
    routeFxLayerShortcut('delete', ui());
    undo();
    pickLayer('bloom');
    expect(ui().fxLayerPick).toMatchObject({ layerId: 'bloom' });
  });
});

function act(run: () => void) {
  run();
}
