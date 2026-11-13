'use client';
// src/components/sidebars/right/sections/FxSceneSection.tsx
//
// The properties panel's section for an FX scene box (src/lib/fxScene/fxScene.ts). What it
// shows depends on what is picked in the Layers panel (`EditorUIStore.fxLayerPick`):
//   - nothing (the box): the scene-level settings (Live, preset, when the scene starts, what
//     a visitor with reduced motion gets), a compact summary of the layers (each entry picks
//     that layer; the rows themselves, with hide, rename, delete, duplicate and move, are in
//     the Layers panel), adding a layer, and copying or importing the scene as JSON;
//   - the Background row: the scene's background colour and the reduced motion choice;
//   - a layer: that layer alone, behind a crumb back to the box: its name, whether it is
//     shown, its kind and blend mode and one control per setting. The controls are
//     generated from the layer's own schema (src/lib/fx/schemas.ts): a number with its
//     range, a colour, a choice, a switch, text, a pair of numbers. A new kind of layer or
//     a new setting needs no change here.
//
// Every change goes through src/lib/fxScene/edit.ts, which passes the scene through the
// strict reader before it is stored, as one undo step. What the reader repaired is
// shown; a change it refuses is shown as an error and stores nothing.
//
// The box itself (size, layout, its own background, the content over the scene) is
// edited with the normal sections below this one.

import React, { useEffect, useId, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronRight, Sparkles } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import { CollapsibleSection, ColorInput, PropertyRow, PropertySelect, PropertySwitch, TextInput } from '../primitives';
import { FIELD_LABEL } from '../primitives/field';
import { FX_PROP } from '@/lib/fxScene/marker';
import { parseFxProp } from '@/lib/fxScene/fxScene';
import {
  addFxLayer,
  applyFxPreset,
  fxPresetOptions,
  fxSceneJson,
  importFxScene,
  renameFxLayer,
  setFxBackground,
  setFxCalm,
  setFxLayerBlend,
  setFxLayerType,
  setFxParam,
  setFxStart,
  toggleFxLayer,
  type FxEdit,
} from '@/lib/fxScene/edit';
import { FX_LIMITS, FX_SOURCE_LAYER_PARAM, listAddableTypes, type BlendMode, type FxCalm, type FxStart, type Layer, type ParamSchema } from '@/lib/fx/format';
import { editorSiteImageUrl, MAX_SITE_IMAGE_BYTES, formatBytes } from '@/lib/site/siteImages';
import { uploadFailureMessage } from '@/components/site/SiteImageField';

interface FxSceneSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';
const ERROR = 'text-[11px] leading-snug text-destructive';
const TEXT_BUTTON =
  'h-7 flex-none rounded-[6px] border border-border px-2.5 text-[11px] text-foreground transition-colors ' +
  'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50';

const START_OPTIONS: { value: FxStart; label: string }[] = [
  { value: 'settled', label: 'After the page has loaded' },
  { value: 'visible', label: 'When it scrolls into view' },
  { value: 'immediate', label: 'At once' },
];
const CALM_OPTIONS: { value: FxCalm; label: string }[] = [
  { value: 'background', label: 'The box background' },
  { value: 'frame', label: 'One still frame of the scene' },
];
const BLEND_OPTIONS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'add', label: 'Add' },
  { value: 'overlay', label: 'Overlay' },
];

/** Why the live scene is not drawn on the canvas, with the way on (EditorUIStore `fxLiveStatus`). */
const LIVE_OFF: Readonly<Record<string, string>> = {
  'no-webgl':
    'This browser cannot draw the scene here (WebGL is not available or is switched off), so the canvas keeps showing the box background. A visitor in the same situation sees that background too. Try another browser to tune the scene.',
  'renderer-error': 'The scene stopped while it was being drawn. Turn Live off and on to start it again; if it stops again, hide the layer you changed last.',
  'context-lost': 'The browser took the graphics context away (too many are open, or the graphics driver restarted). Turn Live off and on to start the scene again.',
  refused: 'This scene cannot be drawn as it is stored. Replace it with a preset, or undo the last change.',
  engine: 'The part of the editor that draws scenes did not load. Check the connection, then turn Live off and on.',
};

/** "eyebrowText" reads as "Eyebrow text". */
export function settingLabel(key: string, schema: ParamSchema): string {
  const raw = schema.label ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  // A single letter stays a capital: "colorA" reads as "Color A".
  const words = raw.split(' ').map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.length === 1 ? word.toUpperCase() : word.toLowerCase()));
  return words.join(' ');
}

/** A kind's label as the engine has it, with a capital: two of them ("halftone", "pixelate") come without. */
const kindName = (label: string): string => label.charAt(0).toUpperCase() + label.slice(1);

const decimalsOf = (step: number): number => Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));

/**
 * A number with its range: a slider and the value as text. A whole drag of the slider is
 * one undo step; the text commits on Enter and on leaving the field.
 */
function NumberSetting({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const id = useId();
  const decimals = decimalsOf(step);
  const shown = (v: number) => String(Number(v.toFixed(decimals)));
  const [draft, setDraft] = useState(shown(value));
  useEffect(() => setDraft(shown(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragging = useRef(false);
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    getHistoryStore()?.commitBatch();
  };
  // Unmounted mid-drag (the selection moved): the undo step still ends.
  useEffect(() => endDrag, []);
  const commitDraft = () => {
    // Untouched: the stored value stays as it is, at its own precision (an imported 0.7234 is not rounded by a focus and a blur).
    if (draft === shown(value)) return;
    const typed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(typed)) {
      setDraft(shown(value));
      return;
    }
    const next = Math.min(max, Math.max(min, typed));
    if (next !== value) onChange(next);
    else setDraft(shown(value));
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          type="range"
          className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--brand,currentColor)]"
          min={min}
          max={max}
          step={step}
          value={value}
          onPointerDown={() => {
            const history = getHistoryStore();
            if (history && !history.batch && !dragging.current) {
              history.startBatch('FX setting');
              dragging.current = true;
            }
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onBlur={endDrag}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <TextInput
          aria-label={`${label}, as a number`}
          className="w-16 flex-none"
          mono
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDraft();
          }}
        />
      </div>
    </div>
  );
}

/** Text that commits on Enter and on leaving the field, so typing is not one undo step per letter. */
function TextSetting({ label, value, maxLength, onChange }: { label: string; value: string; maxLength?: number; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <PropertyRow label={label}>
      <TextInput
        value={draft}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </PropertyRow>
  );
}

/**
 * Text that keeps its line breaks: the `text` setting of a text box layer. Same draft handling as
 * the single-line field (nothing stored while typing; one undo step on leaving the field or on
 * Cmd+Enter / Ctrl+Enter, which does not insert a line break), but Enter is a line break here.
 */
export function MultilineTextSetting({ label, value, maxLength, onChange }: { label: string; value: string; maxLength?: number; onChange: (value: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        value={draft}
        maxLength={maxLength}
        spellCheck={false}
        className="w-full resize-y rounded-[6px] border border-border bg-background p-2 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

/** An image layer's picture: one the site stores, uploaded here. Never an address typed by hand. */
function PictureSetting({ projectId, demo, value, onChange }: { projectId: string | undefined; demo: boolean; value: string; onChange: (value: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [progress, setProgress] = useState('');
  const preview = projectId && value ? editorSiteImageUrl(projectId, value) : null;

  const upload = async (file: File) => {
    setProblem('');
    setProgress('');
    if (!projectId || demo) {
      // The demo lives in this browser tab only: no server holds it, so there is nowhere to store a picture.
      setProblem('The demo is not stored anywhere yet, so it cannot hold a picture. Choose Keep as project in the editor, then upload the picture.');
      return;
    }
    if (file.size > MAX_SITE_IMAGE_BYTES) {
      setProblem(`This file is ${formatBytes(file.size)}; a picture can be at most ${formatBytes(MAX_SITE_IMAGE_BYTES)}. Export it smaller and try again.`);
      return;
    }
    setBusy(true);
    setProgress('Uploading the picture.');
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/images?kind=scene`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      const body = (await res.json().catch(() => null)) as { path?: string; error?: { message?: string } } | null;
      if (!res.ok || !body?.path) {
        setProgress('');
        setProblem(uploadFailureMessage(res.status, body?.error?.message, 'upload the picture'));
        return;
      }
      onChange(body.path);
      setProgress('Picture uploaded.');
    } catch {
      setProgress('');
      setProblem('The picture could not be sent (no connection to the server). Check the connection and upload it again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={FIELD_LABEL}>Picture</span>
      <div className="flex min-w-0 items-center gap-2">
        {preview ? (
          // The editor's own address of the stored picture (behind sign-in); the scene stores its site path.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-9 w-14 flex-none rounded-[5px] border border-border object-cover" />
        ) : (
          <span className="flex h-9 w-14 flex-none items-center justify-center rounded-[5px] border border-dashed border-border text-[10px] text-muted-foreground">None</span>
        )}
        <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Uploading...' : value ? 'Replace' : 'Upload'}
        </button>
        {value ? (
          <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={() => onChange('')}>
            Remove
          </button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          aria-label="Upload a picture for this layer"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {progress}
      </p>
      {problem ? (
        <p role="alert" className={ERROR}>
          {problem}
        </p>
      ) : (
        <p className={HINT}>PNG, JPEG or WebP, up to {formatBytes(MAX_SITE_IMAGE_BYTES)}. It is stored with this site and listed under Uploaded images in Site settings.</p>
      )}
    </div>
  );
}

export const FxSceneSection = observer(({ component }: FxSceneSectionProps) => {
  const { editorUI } = useStore();
  const projectId = editorUI.currentProject?.id;
  const stored = (component.props as Record<string, unknown>)[FX_PROP];
  const read = parseFxProp(stored);
  // The prop as it is NOW: an edit that completes later (a picture upload, a Studio conversion) is built from this,
  // never from the scene captured when it began, or it would overwrite what was changed in between.
  const currentStored = () => (component.props as Record<string, unknown>)[FX_PROP];
  // What the last change left to say, kept with the scene it was said about: after an
  // undo, or a change made elsewhere, the scene is another one and the message is gone.
  const sceneKey = JSON.stringify(stored ?? null);
  const [said, setSaid] = useState<{ about: string; notes: string[]; problem: string }>({ about: sceneKey, notes: [], problem: '' });
  const notes = said.about === sceneKey ? said.notes : [];
  const problem = said.about === sceneKey ? said.problem : '';
  const setProblem = (message: string) => setSaid({ about: JSON.stringify(currentStored() ?? null), notes: [], problem: message });
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState('');

  // Another box: nothing of the last one's messages or selection carries over.
  useEffect(() => {
    setSaid({ about: '', notes: [], problem: '' });
    setImporting(false);
    setImportText('');
    setCopied('');
  }, [component.id]);

  /** Store a change, or show why it was refused. Returns whether it was stored. */
  const apply = (edit: FxEdit): boolean => {
    if (!edit.ok) {
      setProblem(edit.message);
      return false;
    }
    setSaid({ about: JSON.stringify(edit.stored), notes: edit.notes, problem: '' });
    component.setProps({ [FX_PROP]: edit.stored });
    return true;
  };

  const presets = fxPresetOptions();
  const presetPicker = (label: string) => (
    <PropertySelect
      label={label}
      value=""
      placeholder="Choose a preset..."
      options={presets.map((p) => ({ value: p.id, label: p.label }))}
      onChange={(id) => {
        if (id && apply(applyFxPreset(stored, id))) editorUI.clearFxLayerPick();
      }}
    />
  );

  if (!read.ok) {
    // A box whose scene is missing or cannot be read draws as a plain box everywhere. The way forward is a preset.
    return (
      <CollapsibleSection title="FX" icon={<Sparkles size={14} />} normalOnly>
        <p role="alert" className={ERROR}>
          This box has no FX scene that can be drawn: {read.message} It shows as a plain box until it gets one.
        </p>
        {presetPicker('Start from a preset')}
        {problem ? (
          <p role="alert" className={ERROR}>
            {problem}
          </p>
        ) : null}
      </CollapsibleSection>
    );
  }

  const { fx } = read;
  const layers = fx.scene.layers;
  const pick = editorUI.fxLayerPick;
  const picked = pick && pick.componentId === component.id ? pick : undefined;
  const selected = picked && picked.kind === 'layer' ? (layers.find((l) => l.id === picked.layerId) ?? null) : null;
  const addable = listAddableTypes();
  const kindLabel = (type: string) => kindName(addable.find((t) => t.type === type)?.label ?? type);
  const layerName = (id: string) => layers.find((l) => l.id === id)?.name ?? id;

  const settingControl = (layer: Layer, key: string, schema: ParamSchema) => {
    const label = settingLabel(key, schema);
    const set = (value: ParamSchema['value']) => apply(setFxParam(currentStored(), layer.id, key, value));
    switch (schema.type) {
      case 'number':
        return <NumberSetting key={key} label={label} value={schema.value} min={schema.min} max={schema.max} step={schema.step ?? (schema.max - schema.min) / 100} onChange={set} />;
      case 'color':
        return <ColorInput key={key} label={label} value={schema.value} onChange={set} />;
      case 'select':
        return (
          <PropertySelect
            key={key}
            label={key === FX_SOURCE_LAYER_PARAM ? 'Reads from' : label}
            value={schema.value}
            options={schema.options.map((option) => ({ value: option, label: key === FX_SOURCE_LAYER_PARAM ? layerName(option) : option }))}
            onChange={set}
          />
        );
      case 'bool':
        return (
          <PropertyRow key={key} label={label}>
            <PropertySwitch checked={schema.value} onCheckedChange={set} />
          </PropertyRow>
        );
      case 'string':
        if (layer.type === 'textBox' && key === 'text') return <MultilineTextSetting key={key} label={label} value={schema.value} maxLength={FX_LIMITS.text} onChange={set} />;
        if (layer.type === 'image' && key === 'src') return <PictureSetting key={key} projectId={projectId} demo={editorUI.isUnsavedDemo} value={schema.value} onChange={set} />;
        return <TextSetting key={key} label={label} value={schema.value} maxLength={200} onChange={set} />;
      case 'vec2':
        return (
          <div key={key} className="flex min-w-0 flex-col gap-2">
            {(['horizontal', 'vertical'] as const).map((axis, index) => (
              <NumberSetting
                key={axis}
                label={`${label}, ${axis}`}
                value={schema.value[index]}
                min={schema.min?.[index] ?? -1}
                max={schema.max?.[index] ?? 1}
                step={schema.step ?? 0.01}
                onChange={(value) => set(index === 0 ? [value, schema.value[1]] : [schema.value[0], value])}
              />
            ))}
          </div>
        );
    }
  };

  // "Live": the scene drawn on the canvas, for this box, in one breakpoint frame.
  const fxLive = editorUI.fxLive;
  const live = fxLive?.componentId === component.id;
  const liveNote = () => {
    if (!live) {
      return (
        <p className={HINT}>
          The canvas shows the box with its own background. Turn Live on to draw the scene there while you tune it: in one breakpoint at a time, the one you pick the box in.
        </p>
      );
    }
    const status = editorUI.fxLiveStatus;
    if (status.state === 'off') {
      return (
        <p role="alert" className={ERROR}>
          {LIVE_OFF[status.reason] ?? LIVE_OFF['renderer-error']}
        </p>
      );
    }
    const frame = fxLive?.frameId ? editorUI.currentPage?.viewportNodes.find((v) => v.breakpointId === fxLive.frameId)?.label : undefined;
    const where = frame ? `in ${frame}` : 'on the canvas';
    return (
      <p role="status" className={HINT}>
        {status.state === 'live'
          ? `The scene is drawn ${where}, and every change here shows at once. Pick the box in another breakpoint to draw it there. With reduced motion asked for on this device it is one still frame.`
          : `Starting the scene ${where}...`}
      </p>
    );
  };

  const copyJson = async () => {
    const text = fxSceneJson(stored);
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied.');
    } catch {
      // Clipboard access refused: show the text to copy by hand.
      setImportText(text);
      setImporting(true);
      setCopied('Copying was not allowed here. The scene is in the field below: select it and copy.');
    }
  };

  const importJson = async () => {
    let value: unknown;
    try {
      value = JSON.parse(importText);
    } catch {
      setProblem('This is not JSON. Paste the whole scene, from the first { to the last }.');
      return;
    }
    const NOT_A_SCENE = 'This is JSON, but not an FX scene: it has no list of layers and is not a Lumitra Studio scene either.';
    let scene = value;
    const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as { layers?: unknown; root?: unknown }) : null;
    if (!record) {
      setProblem(NOT_A_SCENE);
      return;
    }
    if (!Array.isArray(record.layers)) {
      // Not the engine's own format. A scene in Lumitra Studio's format holds its layers under `root.children`,
      // and the bridge converts it. Anything else is refused here: the bridge reads any object as an empty scene.
      const root = record.root && typeof record.root === 'object' ? (record.root as { children?: unknown }) : null;
      if (!root || !Array.isArray(root.children)) {
        setProblem(NOT_A_SCENE);
        return;
      }
      // The bridge skips a child without a string id and type without a word: refuse here, naming it, so no layer is dropped silently.
      const bad = root.children.findIndex((child) => !child || typeof child !== 'object' || typeof (child as { id?: unknown }).id !== 'string' || typeof (child as { type?: unknown }).type !== 'string');
      if (bad >= 0) {
        setProblem(`Layer ${bad + 1} of this Lumitra Studio scene has no id or no type, so it cannot be imported. Export the scene again from Studio and paste the whole text.`);
        return;
      }
      try {
        const { sceneConfigFromUnified } = await import('@/lib/fx/unified');
        const { serializeScene } = await import('@/lib/fx/format');
        scene = serializeScene(sceneConfigFromUnified(value));
      } catch {
        setProblem('This looks like a Lumitra Studio scene, but it could not be converted. Export it again from Studio and paste the whole text.');
        return;
      }
    }
    if (apply(importFxScene(currentStored(), scene))) {
      setImporting(false);
      setImportText('');
      editorUI.clearFxLayerPick();
    }
  };

  const messages = (
    <>
      {notes.length > 0 ? (
        <div role="status" className="flex min-w-0 flex-col gap-1 rounded-[6px] border border-border px-2 py-1.5">
          <span className={FIELD_LABEL}>Adjusted while saving</span>
          {notes.map((note) => (
            <p key={note} className={HINT}>
              {note}
            </p>
          ))}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className={ERROR}>
          {problem}
        </p>
      ) : null}
    </>
  );

  /** The way back to the box, above whatever one part of the scene is shown. */
  const crumb = (title: string, detail?: string) => (
    <nav aria-label="Scene path" className="flex min-w-0 items-center gap-1 text-[12px]">
      <button
        type="button"
        className="flex-none rounded-[4px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onClick={() => editorUI.clearFxLayerPick()}
      >
        FX scene
      </button>
      <ChevronRight size={12} className="flex-none text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium text-foreground" aria-current="page">
        {title}
      </span>
      {detail ? <span className="flex-none text-[10px] text-muted-foreground">{detail}</span> : null}
    </nav>
  );

  if (picked?.kind === 'background') {
    return (
      <CollapsibleSection title="FX" icon={<Sparkles size={14} />} normalOnly>
        {crumb('Background')}
        <ColorInput label="Scene background" value={fx.scene.background} onChange={(value) => apply(setFxBackground(stored, value))} />
        <p className={HINT}>The colour drawn behind every layer of the scene. The box&apos;s own background, set under Styles, is a different thing: it shows where the scene cannot be drawn.</p>
        <PropertySelect label="With reduced motion" value={fx.calm} options={CALM_OPTIONS} onChange={(value) => apply(setFxCalm(stored, value as FxCalm))} />
        <p className={HINT}>Some visitors ask their device for less motion. They get the box background, or one frame of the scene that does not move.</p>
        {messages}
      </CollapsibleSection>
    );
  }

  if (selected) {
    return (
      <CollapsibleSection title="FX" icon={<Sparkles size={14} />} normalOnly>
        {crumb(selected.name, kindLabel(selected.type))}
        {messages}
        <div className="flex min-w-0 flex-col gap-2.5" role="group" aria-label={`Settings of ${selected.name}`}>
          <TextSetting label="Name" value={selected.name} maxLength={80} onChange={(name) => apply(renameFxLayer(stored, selected.id, name))} />
          <PropertyRow label="Visible" hint="Hide or show this layer in the scene, on the published page too">
            <PropertySwitch checked={selected.visible} onCheckedChange={() => apply(toggleFxLayer(stored, selected.id))} />
          </PropertyRow>
          <PropertySelect
            label="Kind"
            value={selected.type}
            options={addable.map((t) => ({ value: t.type, label: kindName(t.label) }))}
            onChange={(type) => {
              const edit = setFxLayerType(stored, selected.id, type);
              if (apply(edit) && edit.ok && edit.layerId) editorUI.followFxLayer(component.id, edit.layerId);
            }}
          />
          <p className={HINT}>Another kind starts from that kind&apos;s own settings: the settings below are replaced.</p>
          <PropertySelect label="Blend" value={selected.blend} options={BLEND_OPTIONS} onChange={(blend) => apply(setFxLayerBlend(stored, selected.id, blend as BlendMode))} />
          {Object.entries(selected.params).map(([key, schema]) => settingControl(selected, key, schema))}
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="FX" icon={<Sparkles size={14} />} normalOnly>
      <p className={HINT}>
        The scene is drawn behind what is in this box. Where it cannot be drawn (no JavaScript, an old browser) a visitor sees the box&apos;s own background, set under Styles,
        so pick one that works with the content.
      </p>

      <PropertyRow label="Live" hint="Draw the scene on the canvas, in one breakpoint at a time">
        <PropertySwitch
          checked={live}
          onCheckedChange={(on) => (on ? editorUI.startFxLive(component.id, editorUI.selectedViewportNode?.breakpointId ?? null) : editorUI.stopFxLive())}
        />
      </PropertyRow>
      {liveNote()}

      {presetPicker('Replace with a preset')}
      <PropertySelect label="Starts" value={fx.start} options={START_OPTIONS} onChange={(value) => apply(setFxStart(stored, value as FxStart))} />
      <PropertySelect label="With reduced motion" value={fx.calm} options={CALM_OPTIONS} onChange={(value) => apply(setFxCalm(stored, value as FxCalm))} />
      <p className={HINT}>Some visitors ask their device for less motion. They get the box background, or one frame of the scene that does not move.</p>

      <div className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL} id={`fx-layers-${component.id}`}>
          Layers in this scene
        </span>
        {layers.length === 0 ? (
          <p className={HINT}>This scene has no layers, so it draws only its background. Add one below.</p>
        ) : (
          <p className={HINT}>Each layer is a row under this box in the Layers panel, front at the top: hide, rename, copy, move and delete them there. Pick one to change its settings.</p>
        )}
        <ul aria-labelledby={`fx-layers-${component.id}`} className="flex min-w-0 flex-col gap-1">
          {[...layers].reverse().map((layer) => (
            <li key={layer.id}>
              <button
                type="button"
                className="flex w-full min-w-0 items-baseline gap-1.5 rounded-[6px] border border-border px-2 py-1 text-left text-[12px] text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => editorUI.pickFxLayer(component, { kind: 'layer', layerId: layer.id })}
              >
                <span className={`min-w-0 truncate ${layer.visible ? '' : 'opacity-50'}`}>{layer.name}</span>
                <span className="flex-none text-[10px] text-muted-foreground">{layer.visible ? kindLabel(layer.type) : `${kindLabel(layer.type)}, hidden`}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className={`${TEXT_BUTTON} self-start`} onClick={() => editorUI.pickFxLayer(component, { kind: 'background' })}>
          Background colour
        </button>
      </div>

      <PropertySelect
        label="Add a layer"
        value=""
        placeholder="Choose a kind..."
        options={addable.map((t) => ({ value: t.type, label: `${kindName(t.label)} (${t.kind === 'content' ? 'draws' : 'changes what is drawn'})` }))}
        onChange={(type) => {
          if (!type) return;
          const edit = addFxLayer(stored, type);
          if (apply(edit) && edit.ok && edit.layerId) editorUI.pickFxLayer(component, { kind: 'layer', layerId: edit.layerId });
        }}
      />

      {messages}

      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border pt-2.5">
        <button type="button" className={TEXT_BUTTON} onClick={() => void copyJson()}>
          Copy scene JSON
        </button>
        <button
          type="button"
          className={TEXT_BUTTON}
          aria-expanded={importing}
          onClick={() => {
            setImporting(!importing);
            setCopied('');
          }}
        >
          Import scene JSON
        </button>
        {copied ? (
          <span role="status" className={HINT}>
            {copied}
          </span>
        ) : null}
      </div>
      {importing ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`fx-import-${component.id}`} className={FIELD_LABEL}>
            Scene JSON
          </label>
          <textarea
            id={`fx-import-${component.id}`}
            className="h-28 w-full resize-y rounded-[6px] border border-border bg-background p-2 font-mono text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            value={importText}
            spellCheck={false}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={TEXT_BUTTON} disabled={importText.trim() === ''} onClick={() => void importJson()}>
              Replace the scene with this
            </button>
          </div>
          <p className={HINT}>A scene copied from here, exported from the tuning panel on lumitra.co, or a Lumitra Studio scene. It replaces all layers; undo brings them back.</p>
        </div>
      ) : null}
    </CollapsibleSection>
  );
});

FxSceneSection.displayName = 'FxSceneSection';
