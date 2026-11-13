// src/lib/layers/fxRows.ts
//
// The rows an FX scene box lists under itself in the Layers panel, and the actions on them.
//
// The rows are DERIVED from the box's stored scene (`props.fx.scene.layers`) on every render.
// They are not site nodes: nothing here is saved on its own, a row is never a drag source or a
// drop target of the node tree, and the drop resolver never sees one. This file is the one
// provider of derived rows today; a node that lists its inner parts the same way later (the 3D
// scene's objects, docs/plans/2026-11-02-3d-scene-primitive.md) adds a sibling provider and
// `derivedRowsOf` returns whichever one applies to the node.
//
// Every change goes through src/lib/fxScene/edit.ts (the strict reader, one undo step each).
// A change that cannot be made is refused with a reason and stores nothing.

import type { ComponentInstance } from '@/models/ComponentModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import { FX_PROP, isFxScene, parseFxProp } from '@/lib/fxScene/fxScene';
import { duplicateFxLayer, fxLayerKind, removeFxLayer, renameFxLayer, stepFxLayer, toggleFxLayer, type FxEdit } from '@/lib/fxScene/edit';
import { FX_SOURCE_LAYER_PARAM, listAddableTypes, type Layer } from '@/lib/fx/format';

/** One layer of the scene, as a row. */
export interface FxLayerRowModel {
  layerId: string;
  name: string;
  /** The kind of layer, written with a capital ("Text Lockup", "Bloom"). */
  typeLabel: string;
  type: string;
  group: 'content' | 'post';
  visible: boolean;
  /** For a layer that reads another (god rays): the name of the layer it reads. */
  reads?: string;
  /** Why the layer draws nothing though it is shown: its source layer is hidden or gone. */
  off?: string;
  /** The row's full name for a screen reader: "God Rays, effect, reads Lockup". */
  ariaLabel: string;
}

/** The rows under one scene box, front at the top inside each group. */
export interface FxRowsModel {
  /** Post effects, the one applied last at the top. */
  effects: FxLayerRowModel[];
  /** Content layers, the front one at the top. */
  content: FxLayerRowModel[];
  /** The scene's background colour (the Background pseudo-row). */
  background: string;
}

const capital = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

function rowOf(layer: Layer, layers: readonly Layer[], labels: ReadonlyMap<string, string>): FxLayerRowModel {
  const group = fxLayerKind(layer.type) === 'post' ? 'post' : 'content';
  const typeLabel = capital(labels.get(layer.type) ?? layer.type);
  const sourceParam = layer.params[FX_SOURCE_LAYER_PARAM];
  const sourceId = sourceParam && sourceParam.type === 'select' ? sourceParam.value : undefined;
  const source = sourceId ? layers.find((l) => l.id === sourceId) : undefined;
  const reads = group === 'post' && sourceId ? (source?.name ?? sourceId) : undefined;
  // The renderer leaves a pass out when the layer it reads is hidden or gone (src/lib/fx/pipeline.ts).
  const off = group === 'post' && sourceId && (!source || !source.visible) ? 'off: its layer is hidden' : undefined;
  const parts = [layer.name, group === 'post' ? 'effect' : typeLabel];
  if (reads) parts.push(`reads ${reads}`);
  if (!layer.visible) parts.push('hidden');
  if (off) parts.push(off);
  return { layerId: layer.id, name: layer.name, typeLabel, type: layer.type, group, visible: layer.visible, reads, off, ariaLabel: parts.join(', ') };
}

/**
 * The rows of an FX scene box, or `null` when the node is no scene box or its scene cannot
 * be read (it then shows no Scene group; selecting the box leads to a preset).
 */
export function deriveFxRows(component: ComponentInstance): FxRowsModel | null {
  if (!isFxScene(component.props, component.type)) return null;
  const read = parseFxProp((component.props as Record<string, unknown>)[FX_PROP]);
  if (!read.ok) return null;
  const labels = new Map(listAddableTypes().map((t) => [t.type, t.label]));
  const layers = read.fx.scene.layers;
  const rows = layers.map((layer) => rowOf(layer, layers, labels));
  // Stored order is back to front; the list reads front first.
  const front = (group: 'content' | 'post') => rows.filter((r) => r.group === group).reverse();
  return { effects: front('post'), content: front('content'), background: read.fx.scene.background };
}

/** The kind of derived rows a node lists under itself, with the rows, or `null` for an ordinary node. */
export function derivedRowsOf(component: ComponentInstance): { provider: 'fx-scene'; rows: FxRowsModel } | null {
  const rows = deriveFxRows(component);
  return rows ? { provider: 'fx-scene', rows } : null;
}

/**
 * What a pick is called, for the properties panel's header and the phone menu: a layer's name and
 * kind ("Bloom", "Bloom"), or "Background" (kind "Scene background"). `null` when the pick does not match the box's scene.
 */
export function fxPickLabel(box: ComponentInstance, pick: { kind: 'layer'; layerId: string } | { kind: 'background' }): { name: string; kind: string; type: string | null } | null {
  if (pick.kind === 'background') return { name: 'Background', kind: 'Scene background', type: null };
  const read = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
  if (!read.ok) return null;
  const layer = read.fx.scene.layers.find((l) => l.id === pick.layerId);
  if (!layer) return null;
  const label = listAddableTypes().find((t) => t.type === layer.type)?.label ?? layer.type;
  return { name: layer.name, kind: capital(label), type: layer.type };
}

/** The fold-state key of the Scene group row of a box (kept like any other row's folded state). */
export const fxSceneGroupKey = (boxId: string) => `${boxId}:fx-scene`;
/** The fold-state key of its Effects sub-group. */
export const fxEffectsGroupKey = (boxId: string) => `${boxId}:fx-effects`;

export type FxLayerAction =
  | { type: 'toggle' }
  | { type: 'rename'; name: string }
  | { type: 'delete' }
  | { type: 'duplicate' }
  | { type: 'move'; delta: 1 | -1 };

export interface FxActionResult {
  ok: boolean;
  /** What to tell a person: what was done, or why nothing was. */
  message: string;
}

const storedOf = (box: ComponentInstance) => (box.props as Record<string, unknown>)[FX_PROP];

/** The layers of one group in stored order (back to front), for "Bloom moved behind God Rays" and for the neighbour a delete picks. */
function groupOf(box: ComponentInstance, layerId: string): { id: string; name: string }[] {
  const read = parseFxProp(storedOf(box));
  if (!read.ok) return [];
  const kind = fxLayerKind(read.fx.scene.layers.find((l) => l.id === layerId)?.type ?? '');
  return read.fx.scene.layers.filter((l) => fxLayerKind(l.type) === kind).map((l) => ({ id: l.id, name: l.name }));
}

/**
 * Do one action on one layer of a box: through the one edit module, as one undo step, and
 * say what happened (or why not) in the editor's layer notice, which the Layers panel reads
 * out. Keeps the picked layer right: a removed layer moves the pick to a neighbour (or Background), a copy
 * becomes the pick. Used by the row buttons, the row menu and the keys.
 */
export function runFxLayerAction(box: ComponentInstance, editorUI: EditorUIType, layerId: string, action: FxLayerAction): FxActionResult {
  const before = storedOf(box);
  const read = parseFxProp(before);
  const layer = read.ok ? read.fx.scene.layers.find((l) => l.id === layerId) : undefined;
  const name = layer?.name ?? 'The layer';
  const order = action.type === 'move' || action.type === 'delete' ? groupOf(box, layerId) : [];

  let edit: FxEdit & { layerId?: string };
  switch (action.type) {
    case 'toggle':
      edit = toggleFxLayer(before, layerId);
      break;
    case 'rename':
      edit = renameFxLayer(before, layerId, action.name.trim().length > 0 ? action.name.trim() : name);
      break;
    case 'delete':
      edit = removeFxLayer(before, layerId);
      break;
    case 'duplicate':
      edit = duplicateFxLayer(before, layerId);
      break;
    case 'move':
      edit = stepFxLayer(before, layerId, action.delta);
      break;
  }

  if (!edit.ok) {
    editorUI.setFxLayerNotice({ componentId: box.id, about: JSON.stringify(before ?? null), text: edit.message, problem: true });
    // The Layers panel's own message may be out of sight (a folded box, a phone with its sheets closed): the
    // editor's notice shows a refusal wherever the person is.
    // Only where it displaces nothing: another notice may carry a button (Load the newer version, Undo, Show first values).
    const shown = editorUI.editorNotice;
    // Notices with an action: Load the newer version, Open the page, Undo the delete, Show first values.
    const holdsAction = !!shown && (shown.kind === 'changedElsewhere' || shown.kind === 'previewState' || shown.kind === 'pageDeleted' || !!shown.preview || (shown.kind === 'newPage' && !!shown.pageId));
    if (!holdsAction) editorUI.setEditorNotice({ kind: 'refused', message: edit.message });
    return { ok: false, message: edit.message };
  }

  box.setProps({ [FX_PROP]: edit.stored });
  // The refusal this layer's earlier try raised is out of date once a change is stored.
  const lastRefusal = editorUI.fxLayerNotice;
  if (lastRefusal?.problem && editorUI.editorNotice?.kind === 'refused' && editorUI.editorNotice.message === lastRefusal.text) editorUI.setEditorNotice(undefined);

  let text: string;
  switch (action.type) {
    case 'toggle':
      text = `${name} ${layer?.visible ? 'hidden in the scene' : 'shown in the scene'}.`;
      break;
    case 'rename':
      text = `Renamed to ${action.name.trim() || name}.`;
      break;
    case 'delete':
      text = `${name} removed.`;
      break;
    case 'duplicate':
      text = `${name} copied.`;
      break;
    case 'move': {
      const at = order.findIndex((l) => l.id === layerId);
      const passed = order[at + action.delta];
      text = passed ? `${name} moved ${action.delta > 0 ? 'in front of' : 'behind'} ${passed.name}.` : `${name} moved.`;
      break;
    }
  }
  if (edit.notes.length > 0) text = `${text} ${edit.notes.join(' ')}`;
  editorUI.setFxLayerNotice({ componentId: box.id, about: JSON.stringify(edit.stored), text, problem: false });

  const pick = editorUI.selectedFxLayer;
  if (action.type === 'delete' && pick && pick.kind === 'layer' && pick.componentId === box.id && pick.layerId === layerId) {
    // The pick moves to the next layer in the same group (toward the front, else toward the back), or to the
    // Background row when the group is empty. It is never left on the box: a second Delete or a held key
    // would otherwise remove the box itself.
    const at = order.findIndex((l) => l.id === layerId);
    const next = order[at + 1] ?? order[at - 1];
    if (next) editorUI.pickFxLayer(box, { kind: 'layer', layerId: next.id });
    else editorUI.pickFxLayer(box, { kind: 'background' });
  }
  if (action.type === 'duplicate' && edit.layerId) editorUI.pickFxLayer(box, { kind: 'layer', layerId: edit.layerId });
  if (action.type === 'rename') editorUI.endFxLayerRename();
  return { ok: true, message: text };
}
