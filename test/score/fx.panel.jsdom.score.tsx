// The panel column of the FX scene rows (docs/plans/2026-11-08-lumitra-fx-in-sites.md,
// slice F5). Each cell is a person's work on a real root store, through the real FX
// section of the properties panel: the reference scene is pasted into "Import scene
// JSON", and then every layer is picked and every one of its settings is looked for.
// A cell passes only when the box stores exactly the reference scene, with nothing
// repaired, AND the panel offers a control for every setting of every layer, so the
// same scene could have been built there by hand.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FX_SOURCE_LAYER_PARAM, PRESETS, deserializeScene, serializeScene, type Layer } from '@/lib/fx/format';
import { FX_PROP, parseFxProp } from '@/lib/fxScene/fxScene';
import fxScenes from './data/fx-scenes.json';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';
import { fxSceneEntries } from './lib/universe';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { FxSceneSection, settingLabel } from '@/components/sidebars/right/sections/FxSceneSection';

const preset = (id: string) => serializeScene(PRESETS.find((p) => p.id === id)!.load());

/** The same three scenes as the format and renderer columns (fx.score.ts). */
const SCENES: Readonly<Record<string, ReturnType<typeof serializeScene>>> = {
  'hub-hero': preset('gold-noise-gradient'),
  'godrays-hero': preset('godrays-hero'),
  'noise-gradient': preset('noise-gradient'),
};

const key = (id: string) => rowKey('fx-scene', `scene:${id}`);
const fail = (note: string): Cell => ({ status: 'fail', gap: 'fx-scene', note });

function fresh(): ComponentInstance {
  cleanup();
  store = createRootStore();
  store.projectStore.createProject('FX panel probe');
  const project = store.projectStore.findProjectByTitle('FX panel probe')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(store.projectStore);
  return page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
}

/** The settings of `layer` the open settings group offers no control for. */
function missingControls(layer: Layer, group: HTMLElement): string[] {
  const missing: string[] = [];
  const has = (label: string) => within(group).queryAllByLabelText(label).length > 0;
  for (const [name, schema] of Object.entries(layer.params)) {
    const label = settingLabel(name, schema);
    const found =
      schema.type === 'vec2'
        ? has(`${label}, horizontal`) && has(`${label}, vertical`)
        : schema.type === 'bool'
          ? within(group).queryAllByRole('switch', { name: label }).length > 0
          : schema.type === 'select' && name === FX_SOURCE_LAYER_PARAM
            ? has('Reads from')
            : schema.type === 'string' && layer.type === 'image' && name === 'src'
              ? has('Upload a picture for this layer')
              : has(label);
    if (!found) missing.push(`${layer.name}: ${name}`);
  }
  return missing;
}

async function panelCell(scene: ReturnType<typeof serializeScene>): Promise<Cell> {
  const box = fresh();
  render(<FxSceneSection component={box} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import scene JSON' }));
  fireEvent.change(screen.getByLabelText('Scene JSON'), { target: { value: JSON.stringify(scene) } });
  fireEvent.click(screen.getByRole('button', { name: 'Replace the scene with this' }));
  try {
    await waitFor(() => {
      if (screen.queryByLabelText('Scene JSON')) throw new Error('the import is still open');
    });
  } catch {
    return fail(`the panel refused the scene: ${screen.queryByRole('alert')?.textContent ?? 'no reason shown'}`);
  }
  if (screen.queryByRole('status')?.textContent?.includes('Adjusted while saving')) return fail(`the panel repaired the scene: ${screen.getByRole('status').textContent}`);

  const read = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
  if (!read.ok) return fail(`what the panel stored is refused: ${read.message}`);
  if (JSON.stringify(serializeScene(read.fx.scene)) !== JSON.stringify(serializeScene(deserializeScene(scene)))) return fail('what the panel stored differs from the reference scene');

  const missing: string[] = [];
  for (const layer of read.fx.scene.layers) {
    const row = screen.getAllByRole('button').find((button) => button.hasAttribute('aria-pressed') && button.querySelector('span')?.textContent === layer.name);
    if (!row) {
      missing.push(`${layer.name}: not in the layer list`);
      continue;
    }
    fireEvent.click(row);
    const group = screen.queryByRole('group', { name: `Settings of ${layer.name}` });
    if (!group) missing.push(`${layer.name}: no settings shown`);
    else missing.push(...missingControls(layer, group));
    fireEvent.click(row);
  }
  if (missing.length > 0) return fail(`no control for ${missing.join('; ')}`);
  const settings = read.fx.scene.layers.reduce((count, layer) => count + Object.keys(layer.params).length, 0);
  return { status: 'pass', note: `imported unchanged; a control for each of ${settings} settings in ${read.fx.scene.layers.length} layers` };
}

describe('FX scene promises: the panel', () => {
  it('stores every reference scene through the FX section and offers a control for each of its settings', async () => {
    expect(Object.keys(SCENES).sort()).toEqual([...fxScenes.scenes].sort());
    const panel: SurfaceResults = {};
    for (const [id, scene] of Object.entries(SCENES)) panel[key(id)] = await panelCell(scene);
    const rows = new Set(fxSceneEntries().map((e) => rowKey(e.kind, e.id)));
    for (const name of Object.keys(panel)) expect(rows.has(name), name).toBe(true);
    writeOut('fx-scenes-panel', { panel });
    cleanup();
  });

  it('the probe can fail: a setting without a control is named', () => {
    const box = fresh();
    render(<FxSceneSection component={box} />);
    const layer = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
    if (!layer.ok) throw new Error(layer.message);
    const bloom = layer.fx.scene.layers.find((l) => l.type === 'bloom')!;
    fireEvent.click(screen.getAllByRole('button').find((button) => button.hasAttribute('aria-pressed') && button.querySelector('span')?.textContent === bloom.name)!);
    const group = screen.getByRole('group', { name: `Settings of ${bloom.name}` });
    expect(missingControls(bloom, group)).toEqual([]);
    const invented: Layer = { ...bloom, params: { ...bloom.params, sparkle: { type: 'number', value: 1, min: 0, max: 2 } } };
    expect(missingControls(invented, group)).toEqual([`${bloom.name}: sparkle`]);
    cleanup();
  });
});
