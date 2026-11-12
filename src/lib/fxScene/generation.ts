// src/lib/fxScene/generation.ts
//
// What the page generator and an agent's site operations may write for an FX scene
// (./fxScene.ts), and the one function that reads it. Both come through here, so the
// generator's validator (src/lib/ai/pageGen/validate.ts) and the site operations
// (src/lib/siteOps/applyOps.ts) cannot disagree about what a scene may be.
//
// Two forms are read:
//
//  1. The PRESET form, the only one that is taught:
//
//       { "preset": "<preset id>", "start"?, "calm"?, "background"?,
//         "layers"?: [{ "id": "<a layer of that preset>", "visible"?, "params"?: { ... } }] }
//
//     A scene starts from one of the engine's presets and may be recoloured and
//     retuned inside each setting's range. It cannot gain a layer: an entry that
//     names no layer of the preset is left out with a note, an invented kind of
//     layer included. A picture is never written here (an image layer's picture is
//     uploaded in the FX panel).
//
//  2. The STORED form, `{ version, scene, start, calm }`: what an FX scene box
//     already holds. The generator is shown the nodes it replaces or inserts next
//     to, stored scene included, and an agent may send a scene tuned elsewhere (the
//     lumitra.co hero). It goes through the strict reader exactly as a stored page
//     does: an unknown kind of layer is left out with a note, a value out of range
//     is moved into it with a note, and an image address that is not one of this
//     site's own uploads refuses the scene.
//
// Every change is made by the functions of ./edit.ts, the same ones the panel uses,
// so the result is always something the strict reader accepts.
//
// What a caller does with the outcome differs, on purpose. The generator keeps a
// repaired scene and shows the notes as review notes. A site operation refuses on
// any note: an agent is never handed something other than what it wrote.
//
// PURE: no React, no DOM, no three.js (the engine's render-free entry).

import { FX_CALM_MODES, FX_LIMITS, FX_SOURCE_LAYER_PARAM, FX_START_MODES, PRESETS, type FxCalm, type FxStart, type Layer, type ParamSchema, type StoredFx } from '@/lib/fx/format';
import { FX_DEFAULT_PRESET, fxFromPreset, setFxBackground, setFxCalm, setFxParam, setFxStart, toggleFxLayer, type FxEdit } from './edit';
import { parseFxProp, storedFxProp } from './fxScene';

export type GeneratedFx =
  | {
      ok: true;
      /** The prop to store. */
      stored: StoredFx;
      /** The box's own CSS background for a scene made from a preset: what shows wherever the scene is not drawn. */
      background?: string;
      /** What was left out or repaired, in words a person can act on. Empty when the scene is exactly what was written. */
      notes: string[];
    }
  | { ok: false; message: string };

/** The text settings of a text layer: sample words in a preset, which a page must replace or do without. */
const TEXT_LAYER_TYPE = 'text';
const TEXT_KEYS = ['eyebrowText', 'headlineText', 'taglineText'] as const;

const FORM_KEYS = new Set(['preset', 'start', 'calm', 'background', 'layers']);
const LAYER_KEYS = new Set(['id', 'type', 'visible', 'params']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const quote = (v: unknown): string => JSON.stringify(typeof v === 'string' ? v.slice(0, 60) : v) ?? String(v);
const presetIds = (): string => PRESETS.map((p) => `"${p.id}"`).join(', ');

/**
 * Read what was written under `fx` on an FX scene box. Nothing written gives the
 * default preset. See the header for the two forms.
 */
export function readGeneratedFx(value: unknown): GeneratedFx {
  if (value === undefined || value === null) {
    const made = fxFromPreset();
    return made.ok ? { ok: true, stored: made.stored, background: made.background, notes: [] } : made;
  }
  if (!isRecord(value)) return { ok: false, message: 'fx must be an object: {"preset": "<preset id>", ...}.' };

  if ('scene' in value) {
    const read = parseFxProp(value);
    return read.ok ? { ok: true, stored: storedFxProp(read.fx), notes: read.notes } : read;
  }
  if (typeof value.preset !== 'string') return { ok: false, message: `fx needs a preset to start from: one of ${presetIds()}.` };
  return fromPreset(value as Record<string, unknown> & { preset: string });
}

/** Whether the reader took `raw` as the setting's value (moved into its range or cut to its length at most), not its fallback. */
function tookValue(schema: ParamSchema, raw: unknown, kept: unknown): boolean {
  switch (schema.type) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw);
    case 'vec2':
      return Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === 'number' && Number.isFinite(n));
    case 'string':
      return typeof raw === 'string';
    case 'bool':
      return typeof raw === 'boolean';
    case 'color':
    case 'select':
      return typeof raw === 'string' && kept === raw;
  }
}

/** What a setting takes, for a note. */
function expects(schema: ParamSchema): string {
  switch (schema.type) {
    case 'number':
      return `a number from ${schema.min} to ${schema.max}`;
    case 'vec2':
      return 'two numbers, [x, y]';
    case 'string':
      return 'text';
    case 'bool':
      return 'true or false';
    case 'color':
      return 'a colour such as #c9a04a';
    case 'select':
      return `one of ${schema.options.join(', ')}`;
  }
}

function fromPreset(value: Record<string, unknown> & { preset: string }): GeneratedFx {
  const made = fxFromPreset(value.preset);
  if (!made.ok) return { ok: false, message: `There is no FX preset called ${quote(value.preset)}. The presets are ${presetIds()}.` };

  const notes: string[] = [];
  const note = (text: string) => {
    if (!notes.includes(text)) notes.push(text);
  };
  let stored: StoredFx = made.stored;
  const presetLayers = new Map(made.fx.scene.layers.map((layer) => [layer.id, layer]));
  /** Apply one change of the edit module; a refusal becomes a note and changes nothing. */
  const apply = (edit: FxEdit, what: string): boolean => {
    if (!edit.ok) {
      note(`${what}: ${edit.message}`);
      return false;
    }
    stored = edit.stored;
    for (const repaired of edit.notes) note(repaired);
    return true;
  };

  for (const key of Object.keys(value)) {
    if (!FORM_KEYS.has(key)) note(`fx.${key} is not a setting of a scene and was left out (a scene takes preset, start, calm, background and layers).`);
  }
  if (value.start !== undefined) {
    if ((FX_START_MODES as readonly unknown[]).includes(value.start)) apply(setFxStart(stored, value.start as FxStart), 'start');
    else note(`start ${quote(value.start)} is not one of ${FX_START_MODES.join(', ')}, so the scene starts as the preset does.`);
  }
  if (value.calm !== undefined) {
    if ((FX_CALM_MODES as readonly unknown[]).includes(value.calm)) apply(setFxCalm(stored, value.calm as FxCalm), 'calm');
    else note(`calm ${quote(value.calm)} is not one of ${FX_CALM_MODES.join(', ')}, so reduced motion shows the box background.`);
  }
  if (value.background !== undefined) {
    if (typeof value.background === 'string') apply(setFxBackground(stored, value.background), 'background');
    else note('The scene background must be a colour, so the preset\'s is kept.');
  }

  /** Text layers the entry dealt with: hidden on purpose, or given at least one text. */
  const textSettled = new Set<string>();
  /** The text settings each text layer was given. */
  const textGiven = new Map<string, Set<string>>();

  if (value.layers !== undefined && !Array.isArray(value.layers)) note('fx.layers must be a list of {"id", "params"} entries and was left out.');
  const entries = Array.isArray(value.layers) ? value.layers : [];
  if (entries.length > FX_LIMITS.layers) note(`Only the first ${FX_LIMITS.layers} layer entries were read.`);
  for (const entry of entries.slice(0, FX_LIMITS.layers)) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      note('A layer entry without an "id" was left out: name a layer of the preset.');
      continue;
    }
    const layer = presetLayers.get(entry.id);
    if (!layer || (entry.type !== undefined && entry.type !== layer.type)) {
      const kind = typeof entry.type === 'string' ? ` of the kind ${quote(entry.type)}` : '';
      note(
        `The layer ${quote(entry.id)}${kind} is not a layer of the preset "${value.preset}" and was left out: a scene keeps its preset's layers (${[...presetLayers.keys()].join(', ')}) and cannot gain one.`,
      );
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!LAYER_KEYS.has(key)) note(`Layer "${layer.id}": ${quote(key)} cannot be set here and was left out (a layer takes visible and params).`);
    }
    if (entry.visible !== undefined) {
      if (typeof entry.visible !== 'boolean') note(`Layer "${layer.id}": visible must be true or false, so the layer stays as the preset has it.`);
      else {
        if (entry.visible !== layer.visible) apply(toggleFxLayer(stored, layer.id), `Layer "${layer.id}"`);
        if (!entry.visible) textSettled.add(layer.id);
      }
    }
    if (entry.params !== undefined && !isRecord(entry.params)) note(`Layer "${layer.id}": params must be an object of setting to value and was left out.`);
    for (const [key, raw] of Object.entries(isRecord(entry.params) ? entry.params : {})) {
      const schema: ParamSchema | undefined = layer.params[key];
      if (!schema) {
        note(`Layer "${layer.id}" has no setting called ${quote(key)}, so it was left out (its settings: ${Object.keys(layer.params).join(', ')}).`);
        continue;
      }
      if (layer.type === 'image' && key === 'src') {
        note(`Layer "${layer.id}": a picture is uploaded in the FX panel, not written here, so src was left out.`);
        continue;
      }
      // The strict reader answers a value of the wrong kind with the layer kind's own default, which
      // is right for a stored page and wrong here: the preset's value is what must stay.
      const edit = setFxParam(stored, layer.id, key, raw as ParamSchema['value']);
      const kept = edit.ok ? edit.fx.scene.layers.find((l) => l.id === layer.id)?.params[key]?.value : undefined;
      if (!edit.ok || !tookValue(schema, raw, kept)) {
        note(`Layer "${layer.id}": ${key} cannot be ${quote(raw)} (${expects(schema)}), so the preset's value is kept.`);
        continue;
      }
      apply(edit, `Layer "${layer.id}", ${key}`);
      if (layer.type === TEXT_LAYER_TYPE && (TEXT_KEYS as readonly string[]).includes(key)) {
        textGiven.set(layer.id, (textGiven.get(layer.id) ?? new Set()).add(key));
      }
    }
  }

  // A preset's text layer shows the engine's sample words ("Introducing", "Lumitra"). On a page they are
  // someone else's name: the text the entry did not give is emptied, and a text layer that was given no
  // text at all is hidden, with a note, unless the entry hid it itself.
  for (const layer of presetLayers.values()) {
    if (layer.type !== TEXT_LAYER_TYPE || !layer.visible || textSettled.has(layer.id)) continue;
    const given = textGiven.get(layer.id);
    if (!given) {
      apply(toggleFxLayer(stored, layer.id), `Layer "${layer.id}"`);
      note(
        `Layer "${layer.id}" of the preset "${value.preset}" draws text, and its sample text is not this page's: it was hidden. Give it ${TEXT_KEYS.join(', ')} in its params, or set "visible": false yourself.`,
      );
      continue;
    }
    for (const key of TEXT_KEYS) {
      if (!given.has(key) && layer.params[key]) apply(setFxParam(stored, layer.id, key, ''), `Layer "${layer.id}", ${key}`);
    }
  }

  return { ok: true, stored, background: made.background, notes };
}

// ---------- what the generator and an agent are told ----------

const round = (n: number): string => String(Number(n.toFixed(4)));

/** One setting with what it may hold. */
function settingDoc(key: string, schema: ParamSchema, layer: Layer): string | null {
  switch (schema.type) {
    case 'number':
      return `${key} ${round(schema.min)} to ${round(schema.max)} (${round(schema.value)})`;
    case 'color':
      return `${key} colour (${schema.value})`;
    case 'bool':
      return `${key} true or false (${schema.value})`;
    case 'select':
      // Which layer a post pass reads from: one of the scene's own layers, by id.
      if (key === FX_SOURCE_LAYER_PARAM) return `${key} a layer id of this preset (${schema.value})`;
      // The fonts a text layer can draw with are the engine's own short list of system fonts, among
      // them typefaces the page generator is told not to use: the preset's font stays, untaught.
      if (/Font$/.test(key)) return null;
      return `${key} one of ${schema.options.map((o) => `"${o}"`).join(', ')} ("${schema.value}")`;
    case 'vec2':
      return `${key} [x, y]${schema.min && schema.max ? `, each ${round(schema.min[0])} to ${round(schema.max[0])}` : ''} ([${schema.value.map(round).join(', ')}])`;
    case 'string':
      // A picture is uploaded in the panel, never written.
      if (layer.type === 'image' && key === 'src') return null;
      return `${key} text, at most ${FX_LIMITS.text} characters`;
  }
}

/**
 * The section of the generation format that teaches the FX scene: the presets, each
 * with its layers and every setting's range and preset value. Built from the engine's
 * own presets and schemas in their own order, so it is the same text on every run
 * (it sits in a cached prompt prefix) and cannot drift from what the reader accepts.
 */
export function fxGenerationDocs(): string {
  const lines: string[] = [
    '## FX scene (an animated WebGL background)',
    '',
    'A box that draws an animated scene (a gradient, a noise field, god rays, bloom, grain) behind its children:',
    '{"type":"div","preset":"fxScene","label":"Hero","props":{"fx":{"preset":"<preset id>"},"style":{...}},',
    '"children":[...the content over the scene...]}. Use it for a hero or one feature band, never as decoration',
    'on every section: a page draws ONE scene (a second FX scene on a page is kept as a plain box).',
    '',
    'The scene is drawn only where the browser can (JavaScript, WebGL, and by default no reduced motion asked',
    'for). Everywhere else a visitor sees the box\'s own CSS background, which you get from the preset: keep it,',
    'or set style.background to a still background that works with your content, and always give the content',
    'over the scene a colour that reads on both.',
    '',
    'props.fx:',
    `- "preset": one of the presets below. The only way to start a scene; without fx the box is "${FX_DEFAULT_PRESET}".`,
    `- "start": ${FX_START_MODES.map((m) => `"${m}"`).join(', ')}: after the page has loaded (the default), when the box scrolls into view, or at once.`,
    `- "calm": ${FX_CALM_MODES.map((m) => `"${m}"`).join(', ')}: what a visitor who asked for reduced motion gets, the box background (the default) or one still frame of the scene.`,
    '- "background": the scene\'s own background colour, as #rrggbb.',
    '- "layers": [{"id":"<a layer id of the preset>","visible":true|false,"params":{"<setting>":<value>}}]: recolour and',
    '  retune the preset\'s layers. Name only the layers and settings you change. A value outside a range is moved',
    '  into it.',
    '- You cannot add a layer, change a layer\'s kind, change a text layer\'s font, or write a picture address: an',
    '  entry that names no layer of the preset is left out.',
    `- A text layer draws its own words. Give it ${TEXT_KEYS.join(', ')} (leave one out to leave it empty), or set`,
    '  "visible": false; a text layer given no text is hidden. Text for people who cannot see the scene belongs in',
    '  the children, not in the scene.',
    '',
    'Presets (each layer: id, kind, then its settings with the range and, in brackets, the preset\'s value):',
  ];
  for (const preset of PRESETS) {
    const made = fxFromPreset(preset.id);
    if (!made.ok) continue;
    lines.push('', `### FX preset "${preset.id}" (${preset.label}): ${preset.blurb}`);
    for (const layer of made.fx.scene.layers) {
      const settings = Object.entries(layer.params)
        .map(([key, schema]) => settingDoc(key, schema, layer))
        .filter((doc): doc is string => doc !== null);
      lines.push(`- "${layer.id}" (${layer.type}${layer.visible ? '' : ', hidden'}): ${settings.join('; ')}`);
    }
  }
  return lines.join('\n');
}
