'use client';
// src/components/sidebars/right/sections/FxSceneSection.tsx
//
// The properties panel's section for an FX scene box (src/lib/fxScene/fxScene.ts): the
// preset, when the scene starts, what a visitor with reduced motion gets, the scene's
// layers (add, remove, reorder, show or hide) and, for the layer picked in the list,
// one control per setting. The controls are generated from the layer's own schema
// (src/lib/fx/schemas.ts): a number with its range, a colour, a choice, a switch, text,
// a pair of numbers. A new kind of layer or a new setting needs no change here.
//
// Every change goes through src/lib/fxScene/edit.ts, which passes the scene through the
// strict reader before it is stored, as one undo step. What the reader repaired is
// shown; a change it refuses is shown as an error and stores nothing.
//
// The box itself (size, layout, its own background, the content over the scene) is
// edited with the normal sections below this one.

import React, { useEffect, useId, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowDown, ArrowUp, Eye, EyeOff, Sparkles, Trash2 } from 'lucide-react';
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
  moveFxLayer,
  removeFxLayer,
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
import { FX_SOURCE_LAYER_PARAM, listAddableTypes, type BlendMode, type FxCalm, type FxStart, type Layer, type ParamSchema } from '@/lib/fx/format';
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
const ICON_BUTTON =
  'flex h-6 w-6 flex-none items-center justify-center rounded-[5px] text-muted-foreground transition-colors ' +
  'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40';

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

/** "eyebrowText" reads as "Eyebrow text". */
function settingLabel(key: string, schema: ParamSchema): string {
  const raw = schema.label ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

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

/** An image layer's picture: one the site stores, uploaded here. Never an address typed by hand. */
function PictureSetting({ projectId, value, onChange }: { projectId: string | undefined; value: string; onChange: (value: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const preview = projectId && value ? editorSiteImageUrl(projectId, value) : null;

  const upload = async (file: File) => {
    setProblem('');
    if (!projectId) {
      setProblem('Save the site first, then upload a picture.');
      return;
    }
    if (file.size > MAX_SITE_IMAGE_BYTES) {
      setProblem(`This file is ${formatBytes(file.size)}; a picture can be at most ${formatBytes(MAX_SITE_IMAGE_BYTES)}. Export it smaller and try again.`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/images?kind=scene`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      const body = (await res.json().catch(() => null)) as { path?: string; error?: { message?: string } } | null;
      if (!res.ok || !body?.path) {
        setProblem(uploadFailureMessage(res.status, body?.error?.message, 'upload the picture'));
        return;
      }
      onChange(body.path);
    } catch {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [problem, setProblem] = useState('');
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState('');

  // Another box: nothing of the last one's messages or selection carries over.
  useEffect(() => {
    setSelectedId(null);
    setNotes([]);
    setProblem('');
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
    setProblem('');
    setNotes(edit.notes);
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
        if (id && apply(applyFxPreset(stored, id))) setSelectedId(null);
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
  const selected = layers.find((l) => l.id === selectedId) ?? null;
  const addable = listAddableTypes();
  const kindLabel = (type: string) => addable.find((t) => t.type === type)?.label ?? type;
  const layerName = (id: string) => layers.find((l) => l.id === id)?.name ?? id;

  const settingControl = (layer: Layer, key: string, schema: ParamSchema) => {
    const label = settingLabel(key, schema);
    const set = (value: ParamSchema['value']) => apply(setFxParam(stored, layer.id, key, value));
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
        if (layer.type === 'image' && key === 'src') return <PictureSetting key={key} projectId={projectId} value={schema.value} onChange={set} />;
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
    let scene = value;
    const looksPlain = !!value && typeof value === 'object' && Array.isArray((value as { layers?: unknown }).layers);
    if (!looksPlain) {
      // Not the engine's own format: it may be a scene in Lumitra Studio's format, which the bridge converts.
      try {
        const { sceneConfigFromUnified } = await import('@/lib/fx/unified');
        const { serializeScene } = await import('@/lib/fx/format');
        scene = serializeScene(sceneConfigFromUnified(value));
      } catch {
        setProblem('This is JSON, but not an FX scene: it has no list of layers and is not a Lumitra Studio scene either.');
        return;
      }
    }
    if (apply(importFxScene(stored, scene))) {
      setImporting(false);
      setImportText('');
      setSelectedId(null);
    }
  };

  return (
    <CollapsibleSection title="FX" icon={<Sparkles size={14} />} normalOnly>
      <p className={HINT}>
        The scene is drawn behind what is in this box. Where it cannot be drawn (no JavaScript, an old browser) a visitor sees the box&apos;s own background, set under Styles,
        so pick one that works with the content.
      </p>

      {presetPicker('Replace with a preset')}
      <PropertySelect label="Starts" value={fx.start} options={START_OPTIONS} onChange={(value) => apply(setFxStart(stored, value as FxStart))} />
      <PropertySelect label="With reduced motion" value={fx.calm} options={CALM_OPTIONS} onChange={(value) => apply(setFxCalm(stored, value as FxCalm))} />
      <p className={HINT}>Some visitors ask their device for less motion. They get the box background, or one frame of the scene that does not move.</p>
      <ColorInput label="Scene background" value={fx.scene.background} onChange={(value) => apply(setFxBackground(stored, value))} />

      <div className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL} id={`fx-layers-${component.id}`}>
          Layers, back to front
        </span>
        {layers.length === 0 ? <p className={HINT}>This scene has no layers, so it draws only its background. Add one below.</p> : null}
        <ul aria-labelledby={`fx-layers-${component.id}`} className="flex min-w-0 flex-col gap-1">
          {layers.map((layer, index) => (
            <li key={layer.id} className={`flex min-w-0 items-center gap-1 rounded-[6px] border px-1.5 py-1 ${layer.id === selectedId ? 'border-brand bg-accent' : 'border-border'}`}>
              <button
                type="button"
                aria-pressed={layer.id === selectedId}
                className="min-w-0 flex-1 truncate rounded-[4px] px-1 text-left text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => setSelectedId(layer.id === selectedId ? null : layer.id)}
              >
                <span className={layer.visible ? '' : 'opacity-50'}>{layer.name}</span>
                <span className="ml-1.5 text-[10px] text-muted-foreground">{kindLabel(layer.type)}</span>
              </button>
              <button type="button" className={ICON_BUTTON} aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`} aria-pressed={!layer.visible} onClick={() => apply(toggleFxLayer(stored, layer.id))}>
                {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button type="button" className={ICON_BUTTON} aria-label={`Move ${layer.name} toward the back`} disabled={index === 0} onClick={() => apply(moveFxLayer(stored, layer.id, -1))}>
                <ArrowUp size={13} />
              </button>
              <button type="button" className={ICON_BUTTON} aria-label={`Move ${layer.name} toward the front`} disabled={index === layers.length - 1} onClick={() => apply(moveFxLayer(stored, layer.id, 1))}>
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={`Remove ${layer.name}`}
                onClick={() => {
                  if (apply(removeFxLayer(stored, layer.id)) && layer.id === selectedId) setSelectedId(null);
                }}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <PropertySelect
        label="Add a layer"
        value=""
        placeholder="Choose a kind..."
        options={addable.map((t) => ({ value: t.type, label: `${t.label} (${t.kind === 'content' ? 'draws' : 'changes what is drawn'})` }))}
        onChange={(type) => {
          if (!type) return;
          const edit = addFxLayer(stored, type);
          if (apply(edit) && edit.ok && edit.layerId) setSelectedId(edit.layerId);
        }}
      />

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

      {selected ? (
        <div className="flex min-w-0 flex-col gap-2.5 border-t border-border pt-2.5" role="group" aria-label={`Settings of ${selected.name}`}>
          <TextSetting label="Name" value={selected.name} maxLength={80} onChange={(name) => apply(renameFxLayer(stored, selected.id, name))} />
          <PropertySelect
            label="Kind"
            value={selected.type}
            options={addable.map((t) => ({ value: t.type, label: t.label }))}
            onChange={(type) => {
              const edit = setFxLayerType(stored, selected.id, type);
              if (apply(edit) && edit.ok && edit.layerId) setSelectedId(edit.layerId);
            }}
          />
          <p className={HINT}>Another kind starts from that kind&apos;s own settings: the settings below are replaced.</p>
          <PropertySelect label="Blend" value={selected.blend} options={BLEND_OPTIONS} onChange={(blend) => apply(setFxLayerBlend(stored, selected.id, blend as BlendMode))} />
          {Object.entries(selected.params).map(([key, schema]) => settingControl(selected, key, schema))}
        </div>
      ) : layers.length > 0 ? (
        <p className={HINT}>Pick a layer in the list to change its settings.</p>
      ) : null}

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
