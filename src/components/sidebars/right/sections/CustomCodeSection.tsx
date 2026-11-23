'use client';

// src/components/sidebars/right/sections/CustomCodeSection.tsx
//
// The properties panel's section for a sandboxed custom code block (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, "Authoring" and slice C4, D99 to D112):
// the title (the frame's accessible name), the code editor, what the code may read,
// change and fire, its sizing and pointer, a plain sentence saying all of that, and Save.
//
// Save checks what the panel can check (the same rules as the route), saves the page first
// so the server holds the block (D108), posts the code to the guarded route, and names the
// returned hash on the node through one model action, one undo step. The panel's edits are
// a draft keyed to the node and the value it was loaded from (D109): an answer for a block
// that changed meanwhile (an undo, another tab) is not applied, and such a change closes
// the draft. A change of the title alone posts nothing (D105).
//
// The code never runs here. Every refusal is shown with its reason, in an alert region.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { isAlive } from 'mobx-state-tree';
import { Code2 } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import { CollapsibleSection, PropertyRow, PropertySelect, TextInput } from '../primitives';
import { HINT, REASON, SMALL_BUTTON, SwitchRow, rootsOf, type BehaviourPage } from './behaviourShared';
import { statesInReach } from '@/lib/behaviour/authoring';
import { customCodeHash, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { CUSTOM_CODE_PROP, parseCustomCode } from '@/lib/customCode/customCode';
import {
  FRAME_STATE_TYPES,
  checkCustomCodeInput,
  declarationStateRefusal,
  describeDeclaration,
  sizeInWords,
  type StateInReach,
} from '@/lib/customCode/authoring';
import { existingAutosave } from '@/lib/projects/autosave';
import { useCustomCodeAuthoring } from '@/components/customCode/CustomCodeAuthoring';
import { CustomCodeEditor } from '@/components/customCode/CustomCodeEditor';
import { fetchCustomCodeBlob, postCustomCode } from '@/components/customCode/customCodeClient';

interface CustomCodeSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const DEFAULT_DECLARATION: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
const SIZING_LABEL: Record<CustomCodeDeclaration['sizing'], string> = { fixed: 'The box\'s own size', content: 'Follows its content' };
const EVENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPE_WORD: Record<StateInReach['type'], string> = { boolean: 'on or off', number: 'number', choice: 'choice', text: 'text' };
const CODE_PLACEHOLDER = '<div id="app"></div>\n<script>\n  lumitra.ready().then(() => {\n    document.getElementById("app").textContent = "Hello";\n  });\n</script>';

/** What the code fields show: the stored code, or what the person typed over it. */
interface Fields {
  title: string;
  document: string;
  declaration: CustomCodeDeclaration;
  /** The emits as typed, names without `custom:`, comma separated. */
  emitsText: string;
}

type Loaded =
  | { phase: 'new' }
  | { phase: 'loading' }
  | { phase: 'ready'; document: string; declaration: CustomCodeDeclaration }
  | { phase: 'missing'; message: string }
  | { phase: 'failed'; message: string };

function storedValueOf(component: ComponentInstance): unknown {
  return (component.props as Record<string, unknown>)[CUSTOM_CODE_PROP];
}

/** The key a draft is tied to: the node's stored value, as text (D109). */
function keyOf(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function emitsTextOf(declaration: CustomCodeDeclaration): string {
  return declaration.emits.map((name) => name.slice('custom:'.length)).join(', ');
}

/** The event names a person typed, or the reason one is not a name. */
function readEmits(text: string): { emits: string[] } | { reason: string } {
  const names = text.split(',').map((part) => part.trim()).filter((part) => part !== '').map((part) => (part.startsWith('custom:') ? part.slice(7) : part));
  const bad = names.find((name) => !EVENT_NAME.test(name));
  if (bad !== undefined) return { reason: `"${bad}" is not an event name: lower case letters, digits, - and _, starting with a letter or digit.` };
  return { emits: [...new Set(names)].map((name) => `custom:${name}`) };
}

export const CustomCodeSection = observer(({ component }: CustomCodeSectionProps) => (
  // Keyed by node, so a draft never moves to another block.
  <CustomCodeSectionBody key={component.id} component={component} />
));
CustomCodeSection.displayName = 'CustomCodeSection';

const CustomCodeSectionBody = observer(({ component }: { component: ComponentInstance }) => {
  const { editorUI } = useStore();
  const authoring = useCustomCodeAuthoring();
  const page = editorUI.currentPage;
  const project = editorUI.currentProject;
  const stored = storedValueOf(component);
  const storedKey = keyOf(stored);
  const parsed = stored === null || stored === undefined ? null : parseCustomCode(stored);
  const block = parsed && parsed.ok && parsed.value.kind === 'block' ? parsed.value : null;
  const proposal = parsed && parsed.ok && parsed.value.kind === 'proposal' ? parsed.value : null;
  const projectId = project && !editorUI.isUnsavedDemo ? project.id : null;
  const status = authoring.state.phase === 'ready' ? authoring.state.status : null;
  const mayWrite = !!status && status.enabled && status.canManage && !status.branch && !!projectId;

  // --- the stored code -----------------------------------------------------------------
  const [loaded, setLoaded] = React.useState<{ key: string; value: Loaded }>({ key: '', value: { phase: 'loading' } });
  const savedHere = React.useRef<{ key: string; value: Loaded } | null>(null);
  React.useEffect(() => {
    if (savedHere.current && savedHere.current.key === storedKey) {
      // What this panel just saved: no need to read it back.
      setLoaded(savedHere.current);
      savedHere.current = null;
      return;
    }
    if (!block) {
      setLoaded({ key: storedKey, value: { phase: 'new' } });
      return;
    }
    if (!authoring.available || !projectId) {
      setLoaded({ key: storedKey, value: { phase: 'failed', message: 'The stored code cannot be read on this server.' } });
      return;
    }
    let live = true;
    setLoaded({ key: storedKey, value: { phase: 'loading' } });
    void fetchCustomCodeBlob(projectId, block.sha256).then((result) => {
      if (!live) return;
      if (result.ok) {
        const declaration = result.value.declaration ?? DEFAULT_DECLARATION;
        setLoaded({ key: storedKey, value: { phase: 'ready', document: result.value.document, declaration } });
      } else if (result.status === 404 && result.code === 'blob_not_found') {
        setLoaded({ key: storedKey, value: { phase: 'missing', message: 'This site holds no code under this block\'s hash (it may have been copied from another site). Write the code and save it to store it here.' } });
      } else {
        setLoaded({ key: storedKey, value: { phase: 'failed', message: result.message } });
      }
    });
    return () => {
      live = false;
    };
    // block is derived from storedKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey, projectId, authoring.available]);

  // --- the draft (D109) ----------------------------------------------------------------
  const [edits, setEdits] = React.useState<{ key: string; fields: Partial<Fields> } | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const ownWrite = React.useRef<string | null>(null);

  // The block changed underneath an open draft (an undo, another tab): the draft closes.
  React.useEffect(() => {
    if (!edits || edits.key === storedKey) return;
    setEdits(null);
    if (ownWrite.current === storedKey) {
      ownWrite.current = null;
      return;
    }
    setProblem(null);
    setAnnouncement('The block changed, so the unsaved edits were closed. The panel shows its current code.');
  }, [storedKey, edits]);

  const current: Loaded = loaded.key === storedKey ? loaded.value : { phase: 'loading' };
  const baseDeclaration = current.phase === 'ready' ? current.declaration : DEFAULT_DECLARATION;
  const base: Fields = {
    title: block?.title ?? proposal?.title ?? '',
    document: current.phase === 'ready' ? current.document : '',
    declaration: baseDeclaration,
    emitsText: emitsTextOf(baseDeclaration),
  };
  const draft = edits && edits.key === storedKey ? edits.fields : {};
  const fields: Fields = { ...base, ...draft, declaration: { ...base.declaration, ...(draft.declaration ?? {}) } };
  const dirty = Object.keys(draft).length > 0;

  const edit = (patch: Partial<Fields>) => {
    setProblem(null);
    setEdits((previous) => {
      const fieldsBefore = previous && previous.key === storedKey ? previous.fields : {};
      return { key: storedKey, fields: { ...fieldsBefore, ...patch } };
    });
  };
  const editDeclaration = (patch: Partial<CustomCodeDeclaration>) => edit({ declaration: { ...fields.declaration, ...patch } });

  // --- what the code may touch ---------------------------------------------------------
  const reach: StateInReach[] = page
    ? statesInReach(rootsOf(page as unknown as BehaviourPage), component.id).map(({ state }) => ({ id: state.id, name: state.name, type: state.type }))
    : [];
  const nearest = new Map(reach.map((state) => [state.id, state]));
  const offered = [...nearest.values()].filter((state) => FRAME_STATE_TYPES.has(state.type));
  const nameOf = (id: string) => nearest.get(id)?.name ?? id;
  const emitsRead = readEmits(fields.emitsText);
  const declaration: CustomCodeDeclaration = { ...fields.declaration, emits: 'emits' in emitsRead ? emitsRead.emits : fields.declaration.emits };
  // The stored declaration against the page as it is now: a value deleted since shows here (D108).
  const storedProblem = current.phase === 'ready' ? declarationStateRefusal(current.declaration, reach) : null;
  const draftProblem = declarationStateRefusal(declaration, reach);
  const checked = checkCustomCodeInput({ title: fields.title, document: fields.document, declaration });
  const bytes = checked.ok ? checked.value.bytes : null;

  const toggleIn = (list: 'reads' | 'writes', id: string, on: boolean) => {
    const set = new Set(fields.declaration[list]);
    if (on) set.add(id);
    else set.delete(id);
    editDeclaration({ [list]: [...set].sort() } as Partial<CustomCodeDeclaration>);
  };

  // --- Save ------------------------------------------------------------------------------
  const save = async () => {
    setAnnouncement('');
    setProblem(null);
    if ('reason' in emitsRead) return setProblem(emitsRead.reason);
    if (!checked.ok) return setProblem(checked.refusal.message);
    if (draftProblem) return setProblem(draftProblem.message);
    if (!page || !projectId) return setProblem('Save the project first: a block\'s code is stored with its site.');
    const keyAtStart = storedKey;
    setSaving(true);
    try {
      const sha256 = await customCodeHash(checked.value.document, checked.value.declaration);
      if (block && block.sha256 === sha256) {
        // The same code and declaration (D105): only the title can have changed, and it lives on the node.
        if (block.title === checked.value.title) {
          setEdits(null);
          setAnnouncement('Nothing changed.');
          return;
        }
        const write = component.setCustomCode({ sha256, title: checked.value.title });
        if (!write.ok) return setProblem(write.reason);
        ownWrite.current = keyOf({ sha256, title: checked.value.title });
        savedHere.current = { key: ownWrite.current, value: current };
        setAnnouncement('Title saved.');
        return;
      }
      // D108: the server must hold the block before it can check the declaration against it.
      const autosave = existingAutosave(projectId);
      if (autosave) {
        await autosave.flush();
        if (autosave.hasUnsavedWork()) {
          return setProblem('The page is not saved yet (see the save status at the top), so the code was not sent. Once the page shows Saved, save the code again.');
        }
      }
      const result = await postCustomCode(projectId, {
        pageId: page.id,
        nodeId: component.id,
        title: checked.value.title,
        document: checked.value.document,
        declaration: checked.value.declaration,
        ...(block ? { replaces: block.sha256 } : {}),
      });
      if (!result.ok) return setProblem(result.message);
      // D109: applied only to the block as it was when Save was pressed.
      if (!isAlive(component) || keyOf(storedValueOf(component)) !== keyAtStart) {
        return setProblem('The block changed while saving, so nothing was applied to it. The code is stored; save it again to use it.');
      }
      const write = component.setCustomCode({ sha256: result.value.sha256, title: checked.value.title });
      if (!write.ok) return setProblem(write.reason);
      ownWrite.current = keyOf({ sha256: result.value.sha256, title: checked.value.title });
      savedHere.current = { key: ownWrite.current, value: { phase: 'ready', document: checked.value.document, declaration: checked.value.declaration } };
      setAnnouncement(result.value.created ? 'Code saved. Publish the page to put it live.' : 'Code saved; this exact code was already stored.');
      authoring.reload();
    } catch (error) {
      console.error('[custom code] save failed', error instanceof Error ? error.name : error);
      setProblem('The code could not be saved. Nothing was changed; try again.');
    } finally {
      setSaving(false);
    }
  };

  const showsFallback = authoring.fallbackShown.has(component.id);
  const titleForName = fields.title.trim() || 'this block';
  const readOnly = !mayWrite || !!proposal;

  return (
    <CollapsibleSection title="Custom code" icon={<Code2 size={14} />} normalOnly>
      <div data-testid="custom-code-section" className="flex flex-col gap-2">
        <p className={HINT}>
          Your own HTML and JavaScript, run in an isolated frame on the published page. It never runs in the editor: the canvas
          shows a tile, and the standalone preview shows the fallback, the elements inside this block.
        </p>
        <Notices authoring={authoring} projectId={projectId} proposal={!!proposal} invalid={!!parsed && !parsed.ok} />
        {authoring.available && (
          <SwitchRow
            label="Show the fallback on the canvas"
            hint="Edit the elements visitors see while the code cannot run. Only in this editor, never saved."
            checked={showsFallback}
            onCheckedChange={(on) => authoring.setFallbackShown(component.id, on)}
          />
        )}
        {authoring.available && !proposal && (
          <>
            {current.phase === 'loading' && <p className={HINT} role="status">Loading the stored code…</p>}
            {(current.phase === 'missing' || current.phase === 'failed') && <p className={REASON} role="alert">{current.message}</p>}
            {storedProblem && (
              <p className={REASON} role="alert" data-custom-code-stored-problem="">
                {storedProblem.message.replace('The block', 'The saved code')} Until then the published page shows the fallback.
              </p>
            )}
            <PropertyRow label="Title">
              <TextInput
                value={fields.title}
                maxLength={200}
                readOnly={readOnly}
                aria-label="Title of the custom code block"
                placeholder="Opening hours clock"
                onChange={(event) => edit({ title: event.target.value })}
              />
            </PropertyRow>
            <p className={HINT}>Required. What a screen reader announces for the frame.</p>
            <CustomCodeEditor
              id={`custom-code-${component.id}`}
              value={fields.document}
              onChange={(document) => edit({ document })}
              label={`Code of ${titleForName}`}
              readOnly={readOnly}
              placeholder={CODE_PLACEHOLDER}
            />
            <StatePicker
              legend="Values it reads"
              hint="The frame gets their values and every change."
              states={offered}
              chosen={fields.declaration.reads}
              readOnly={readOnly}
              onToggle={(id, on) => toggleIn('reads', id, on)}
              verb="Read"
            />
            <StatePicker
              legend="Values it can change"
              hint="The page checks every change against the value's type and range."
              states={offered}
              chosen={fields.declaration.writes}
              readOnly={readOnly}
              onToggle={(id, on) => toggleIn('writes', id, on)}
              verb="Change"
            />
            <PropertyRow label="Events">
              <TextInput
                value={fields.emitsText}
                readOnly={readOnly}
                mono
                aria-label="Events it can fire, separated by commas"
                aria-invalid={'reason' in emitsRead ? true : undefined}
                placeholder="done, opened"
                onChange={(event) => edit({ emitsText: event.target.value })}
              />
            </PropertyRow>
            {'reason' in emitsRead ? <p className={REASON} role="alert">{emitsRead.reason}</p> : (
              <p className={HINT}>Names an interaction can react to with &quot;A custom event&quot;.</p>
            )}
            <PropertyRow label="Height">
              {readOnly ? (
                <span className="text-[12px] text-foreground">{SIZING_LABEL[fields.declaration.sizing]}</span>
              ) : (
                <PropertySelect
                  label=""
                  value={fields.declaration.sizing}
                  aria-label="Height of the frame"
                  options={[{ value: 'fixed', label: SIZING_LABEL.fixed }, { value: 'content', label: SIZING_LABEL.content }]}
                  onChange={(sizing) => editDeclaration({ sizing: sizing === 'content' ? 'content' : 'fixed' })}
                />
              )}
            </PropertyRow>
            <SwitchRow
              label="Visitors can click into it"
              hint="Off: clicks, scrolling and the keyboard pass through it, for a scene behind the page's content."
              checked={fields.declaration.interactive}
              onCheckedChange={(interactive) => { if (!readOnly) editDeclaration({ interactive }); }}
            />
            <p className={HINT} data-custom-code-summary="">{describeDeclaration(declaration, nameOf)}</p>
            {draftProblem && dirty && <p className={REASON} role="alert">{draftProblem.message}</p>}
            {status && bytes !== null && (
              <p className={HINT}>
                {sizeInWords(bytes)} of {sizeInWords(status.limits.blockBytes)} for this block. The site&apos;s published and saved
                blocks hold {sizeInWords(status.usedBytes)} of {sizeInWords(status.limits.siteBytes)}.
              </p>
            )}
            {mayWrite && (
              <div className="flex items-center gap-2">
                <button type="button" className={SMALL_BUTTON} disabled={saving || current.phase === 'loading'} onClick={() => void save()}>
                  {saving ? 'Saving code…' : 'Save code'}
                </button>
                {dirty && !saving && (
                  <button type="button" className={SMALL_BUTTON} onClick={() => { setEdits(null); setProblem(null); setAnnouncement('Edits discarded.'); }}>
                    Discard edits
                  </button>
                )}
              </div>
            )}
            {problem && <p className={REASON} role="alert" data-custom-code-problem="">{problem}</p>}
          </>
        )}
        <p className="sr-only" role="status" aria-live="polite" data-custom-code-announcement="">{announcement}</p>
      </div>
    </CollapsibleSection>
  );
});
CustomCodeSectionBody.displayName = 'CustomCodeSectionBody';

function Notices({ authoring, projectId, proposal, invalid }: {
  authoring: ReturnType<typeof useCustomCodeAuthoring>;
  projectId: string | null;
  proposal: boolean;
  invalid: boolean;
}) {
  const lines: { text: string; alert?: boolean; retry?: boolean }[] = [];
  if (!authoring.available) {
    lines.push({ text: 'Custom code is not available on this server yet. The block shows its fallback on every page.' });
  } else if (authoring.state.phase === 'loading') {
    lines.push({ text: 'Checking custom code for this site…' });
  } else if (authoring.state.phase === 'failed') {
    lines.push({ text: `The custom code settings could not be read: ${authoring.state.message}`, alert: true, retry: true });
  } else if (authoring.state.phase === 'ready') {
    const status = authoring.state.status;
    if (!projectId) lines.push({ text: 'Save the project first: a block\'s code is stored with its site.' });
    if (status.branch) lines.push({ text: 'Custom code is written on the main site, not on a branch. Open the main site to change this block.' });
    else if (!status.enabled) lines.push({ text: 'Custom code is not switched on for this site, so its code cannot be saved and the block shows its fallback.' });
    else if (!status.canManage) lines.push({ text: 'Only a workspace admin can change custom code. You can read it here.' });
    if (!status.serving) lines.push({ text: 'This server does not run custom code right now, so published blocks show their fallback.' });
  }
  if (proposal) lines.push({ text: 'Proposed by an import or an agent, not active: it shows its fallback until a person accepts it, which comes with a later release.' });
  if (invalid) lines.push({ text: 'The stored value of this block is not valid, so it shows its fallback. Saving code repairs it.', alert: true });
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <div key={line.text} className="flex items-start gap-2">
          <p className={line.alert ? REASON : HINT} role={line.alert ? 'alert' : undefined}>{line.text}</p>
          {line.retry && <button type="button" className={SMALL_BUTTON} onClick={authoring.reload}>Retry</button>}
        </div>
      ))}
    </>
  );
}

function StatePicker({ legend, hint, states, chosen, readOnly, onToggle, verb }: {
  legend: string;
  hint: string;
  states: readonly StateInReach[];
  chosen: readonly string[];
  readOnly: boolean;
  onToggle: (id: string, on: boolean) => void;
  verb: string;
}) {
  const known = new Set(states.map((state) => state.id));
  const gone = chosen.filter((id) => !known.has(id));
  return (
    <fieldset className="flex flex-col gap-1 border-0 p-0">
      <legend className="text-[11px] font-medium text-foreground">{legend}</legend>
      {states.length === 0 && gone.length === 0 && (
        <p className={HINT}>No on or off, number or choice value stands on this block or above it. Add one in Page state.</p>
      )}
      {states.map((state) => (
        <label key={state.id} className="flex items-center gap-2 text-[12px] text-foreground">
          <input
            type="checkbox"
            checked={chosen.includes(state.id)}
            disabled={readOnly}
            aria-label={`${verb} ${state.name}`}
            onChange={(event) => onToggle(state.id, event.target.checked)}
          />
          <span className="truncate">{state.name}</span>
          <span className="text-muted-foreground">({TYPE_WORD[state.type]})</span>
        </label>
      ))}
      {gone.map((id) => (
        <label key={id} className="flex items-center gap-2 text-[12px] text-destructive">
          <input type="checkbox" checked disabled={readOnly} aria-label={`${verb} ${id}, a value that is gone`} onChange={() => onToggle(id, false)} />
          <span className="truncate">{id}: gone from the page, untick it</span>
        </label>
      ))}
      <p className={HINT}>{hint}</p>
    </fieldset>
  );
}
