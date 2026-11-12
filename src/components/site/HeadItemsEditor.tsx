'use client';

// src/components/site/HeadItemsEditor.tsx
//
// The list of head items a page or the site carries, and the form that adds and edits one
// (docs/plans/2026-11-02-theme-and-head.md, slice H3). The two homes use this one component.
//
// Every list change is ONE write through `write` (ProjectModel.updateSiteHead, or the page's
// updateMetadata), so it is one undo step and the canvas and preview need no reload.
//
// A form holds its text as a local draft. Nothing is stored until the draft is an item
// parseHeadItem accepts, and the form says why while it is not, with the refusal's own words
// (an owned name names the field to use). So a half-typed item, and a half-typed JSON-LD, is
// never saved, and invalid JSON-LD leaves the last valid version in place and shows why.
//
// An item already stored that this build refuses (a list from an older build, an edit by hand)
// is shown as refused with its reason, still editable, and can be deleted: it is not silently gone.

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  FEED_TYPES,
  HEAD_KINDS,
  LINK_RELS,
  META_NAMES,
  PROPERTY_NAMES,
  PROPERTY_PREFIXES,
  changeHeadKind,
  parseHeadItem,
  parseJsonLdInput,
  type HeadKind,
  type StoredHeadItem,
} from '@/lib/site/headItems';
import { META_HELP, PROPERTY_HELP, REL_HELP, propertyRow } from '@/lib/site/headItemHelp';

const fieldLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const inputBase = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40';
const hint = 'text-[11px] text-muted-foreground';

const KIND_LABEL: Record<HeadKind, string> = {
  meta: 'Meta tag (name)',
  property: 'Property tag',
  link: 'Link',
  jsonld: 'Structured data (JSON-LD)',
};

interface Draft {
  kind: HeadKind;
  name: string;
  property: string;
  content: string;
  rel: string;
  href: string;
  hreflang: string;
  type: string;
  title: string;
  json: string;
}

const BLANK: Draft = { kind: 'meta', name: '', property: '', content: '', rel: 'alternate', href: '', hreflang: '', type: '', title: '', json: '' };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The form's text for a stored item, whatever its shape. */
function draftOf(stored: StoredHeadItem | null): Draft {
  if (!stored) return { ...BLANK };
  const kind = (HEAD_KINDS as readonly string[]).includes(stored.kind) ? (stored.kind as HeadKind) : 'meta';
  const data = stored.data;
  return {
    kind,
    name: text(stored.name),
    property: text(stored.property),
    content: text(stored.content),
    rel: text(stored.rel) || 'alternate',
    href: text(stored.href),
    hreflang: text(stored.hreflang),
    type: text(stored.type),
    title: text(stored.title),
    json: data && typeof data === 'object' ? JSON.stringify(data, null, 2) : '',
  };
}

type Candidate = { ok: true; items: StoredHeadItem[] } | { ok: false; message: string };

/** What the draft would store: an item parseHeadItem accepts, or why not. A JSON-LD box can hold several. */
function candidateOf(d: Draft): Candidate {
  if (d.kind === 'jsonld') {
    if (d.json.trim() === '') return { ok: false, message: 'Paste the structured data.' };
    const read = parseJsonLdInput(d.json);
    return read.ok ? { ok: true, items: read.items.map((data) => ({ kind: 'jsonld', data })) } : { ok: false, message: read.message };
  }
  const stored: StoredHeadItem =
    d.kind === 'meta'
      ? { kind: 'meta', name: d.name.trim(), content: d.content }
      : d.kind === 'property'
        ? { kind: 'property', property: d.property.trim(), content: d.content }
        : {
            kind: 'link',
            rel: d.rel,
            href: d.href.trim(),
            ...(d.rel === 'alternate' && d.hreflang.trim() !== '' ? { hreflang: d.hreflang.trim() } : {}),
            ...(d.rel === 'alternate' && d.type !== '' ? { type: d.type } : {}),
            ...(d.title.trim() !== '' ? { title: d.title } : {}),
          };
  const parsed = parseHeadItem(stored);
  return parsed.ok ? { ok: true, items: [stored] } : { ok: false, message: parsed.refusal.message };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface FormProps {
  idPrefix: string;
  value: StoredHeadItem | null;
  /** The stored item's own refusal, when this build refuses it. */
  refusal: string | null;
  mode: 'new' | 'edit';
  onCommit: (items: StoredHeadItem[]) => void;
}

function HeadItemForm({ idPrefix, value, refusal, mode, onCommit }: FormProps) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(value));
  const [touched, setTouched] = React.useState(false);
  const stamp = JSON.stringify(value);
  // An undo, a redo or a write from elsewhere replaces the stored item: the draft follows it.
  React.useEffect(() => {
    setDraft(draftOf(value));
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const candidate = candidateOf(draft);
  const set = (patch: Partial<Draft>) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setKind = (kind: HeadKind) => {
    // The fields the new kind cannot hold are dropped, not hidden (changeHeadKind).
    const carried = changeHeadKind(value ?? { kind: draft.kind, content: draft.content }, kind);
    setTouched(true);
    setDraft({ ...BLANK, kind, content: text(carried.content) });
  };
  const dirty = !(candidate.ok && value && candidate.items.length === 1 && same(candidate.items[0], value));
  const commit = () => {
    if (candidate.ok && dirty) onCommit(candidate.items);
  };
  // An existing row saves when focus leaves the whole row, never per keystroke.
  const leave = (event: React.FocusEvent<HTMLDivElement>) => {
    if (mode !== 'edit' || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    commit();
  };
  const id = (field: string) => `${idPrefix}-${field}`;
  const help = draft.kind === 'meta' ? META_HELP[draft.name.trim()] : draft.kind === 'property' ? PROPERTY_HELP[propertyRow(draft.property.trim())] : draft.kind === 'link' ? REL_HELP[draft.rel] : undefined;
  const showMessage = !candidate.ok && (touched || (mode === 'edit' && refusal !== null));
  const message = !candidate.ok ? (touched ? candidate.message : refusal ?? candidate.message) : null;

  return (
    <div onBlur={leave} className="flex flex-col gap-2" data-testid={mode === 'new' ? 'head-new' : 'head-row'}>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('kind')} className={fieldLabel}>Kind</label>
        <select id={id('kind')} className={inputBase} value={draft.kind} onChange={(e) => setKind(e.target.value as HeadKind)}>
          {HEAD_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      {draft.kind === 'meta' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id('name')} className={fieldLabel}>Name</label>
          <input id={id('name')} list={id('names')} className={inputBase} value={draft.name} spellCheck={false} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
          <datalist id={id('names')}>{[...META_NAMES].map((n) => <option key={n} value={n} />)}</datalist>
        </div>
      )}
      {draft.kind === 'property' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id('property')} className={fieldLabel}>Property</label>
          <input id={id('property')} list={id('properties')} className={inputBase} value={draft.property} spellCheck={false} autoComplete="off" onChange={(e) => set({ property: e.target.value })} />
          <datalist id={id('properties')}>
            {[...PROPERTY_NAMES, ...PROPERTY_PREFIXES.map((p) => `${p}tag`)].map((n) => <option key={n} value={n} />)}
          </datalist>
        </div>
      )}
      {(draft.kind === 'meta' || draft.kind === 'property') && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id('content')} className={fieldLabel}>Content</label>
          <input id={id('content')} className={inputBase} value={draft.content} autoComplete="off" onChange={(e) => set({ content: e.target.value })} />
        </div>
      )}

      {draft.kind === 'link' && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={id('rel')} className={fieldLabel}>Relation</label>
            <select id={id('rel')} className={inputBase} value={draft.rel} onChange={(e) => set({ rel: e.target.value, hreflang: '', type: '' })}>
              {LINK_RELS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={id('href')} className={fieldLabel}>Address</label>
            <input id={id('href')} className={inputBase} value={draft.href} placeholder="https://example.com/page or /path" spellCheck={false} autoComplete="off" onChange={(e) => set({ href: e.target.value })} />
          </div>
          {draft.rel === 'alternate' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={id('hreflang')} className={fieldLabel}>Language</label>
                <input id={id('hreflang')} className={inputBase} value={draft.hreflang} placeholder="de, en-GB or x-default" spellCheck={false} autoComplete="off" onChange={(e) => set({ hreflang: e.target.value, type: '' })} />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={id('type')} className={fieldLabel}>Or feed type</label>
                <select id={id('type')} className={inputBase} value={draft.type} onChange={(e) => set({ type: e.target.value, hreflang: '' })}>
                  <option value="">None</option>
                  {FEED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor={id('title')} className={fieldLabel}>Title (optional)</label>
            <input id={id('title')} className={inputBase} value={draft.title} autoComplete="off" onChange={(e) => set({ title: e.target.value })} />
          </div>
        </>
      )}

      {draft.kind === 'jsonld' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id('json')} className={fieldLabel}>JSON-LD</label>
          <textarea
            id={id('json')}
            rows={8}
            spellCheck={false}
            className={`${inputBase} h-auto py-2 font-mono text-xs`}
            value={draft.json}
            placeholder={'{ "@context": "https://schema.org", "@type": "Organization", "name": "..." }'}
            aria-invalid={showMessage || undefined}
            aria-describedby={id('message')}
            onChange={(e) => set({ json: e.target.value })}
          />
        </div>
      )}

      {help && <p className={hint}>{help}</p>}
      <p id={id('message')} role={showMessage ? 'alert' : undefined} className={showMessage ? 'text-[12px] text-destructive' : hint} data-testid="head-message">
        {showMessage
          ? mode === 'edit' && value
            ? `${message} Not saved: the last saved version is kept.`
            : message
          : ''}
      </p>
      {mode === 'new' && (
        <div>
          <Button type="button" size="sm" variant="brand" disabled={!candidate.ok} onClick={commit}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> {draft.kind === 'jsonld' && candidate.ok && candidate.items.length > 1 ? `Add ${candidate.items.length} items` : 'Add item'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A one-line summary of a stored item for the list. */
function summary(item: StoredHeadItem): string {
  if (item.kind === 'meta') return `${text(item.name) || '(no name)'}: ${text(item.content)}`;
  if (item.kind === 'property') return `${text(item.property) || '(no property)'}: ${text(item.content)}`;
  if (item.kind === 'link') return `${text(item.rel) || '(no rel)'} ${text(item.href)}`;
  if (item.kind === 'jsonld') return `Structured data ${JSON.stringify((item.data as { '@type'?: unknown })?.['@type'] ?? '')}`;
  return `(unknown kind "${String(item.kind).slice(0, 40)}")`;
}

export interface HeadItemsEditorProps {
  /** The stored list, as the model holds it. */
  items: readonly StoredHeadItem[];
  /** The most items this home may hold (HEAD_LIMITS). */
  cap: number;
  /** One write of the whole list; the count it dropped, or why it was refused. */
  write: (next: StoredHeadItem[]) => { ok: true; dropped: number } | { ok: false; errors: string[] };
  /** Names the home in the messages: "page" or "site". */
  home: 'page' | 'site';
}

export function HeadItemsEditor({ items, cap, write, home }: HeadItemsEditorProps) {
  const [notice, setNotice] = React.useState('');
  const [adding, setAdding] = React.useState(items.length === 0);
  const [formKey, setFormKey] = React.useState(0);
  const run = (next: StoredHeadItem[], done: string) => {
    const result = write(next);
    if (!result.ok) setNotice(result.errors.join(' '));
    else setNotice(result.dropped > 0 ? `${done} ${result.dropped} past the limit of ${cap} were left out.` : done);
    return result.ok;
  };
  const replaceAt = (index: number, replacement: StoredHeadItem[]) => {
    const next = [...items.slice(0, index), ...replacement, ...items.slice(index + 1)];
    run(next, 'Saved.');
  };
  const remove = (index: number) => run(items.filter((_, i) => i !== index), 'Item deleted.');
  const full = items.length >= cap;

  return (
    <div className="flex flex-col gap-3" data-testid="head-editor">
      <p className={hint} data-testid="head-count">{items.length} of {cap} items on the {home}.</p>
      <p role="status" aria-live="polite" className={hint} data-testid="head-notice">{notice}</p>

      {items.length === 0 && <p className="text-xs text-muted-foreground">No head items yet.</p>}
      <ul className="flex flex-col gap-3">
        {items.map((item, index) => {
          const parsed = parseHeadItem(item);
          const refusal = parsed.ok ? null : parsed.refusal.message;
          return (
            <li key={`${index}:${JSON.stringify(item)}`} className="rounded-md border border-border p-3" data-testid="head-item" data-refused={refusal ? 'true' : undefined}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium" title={summary(item)}>{summary(item)}</p>
                  <p className={refusal ? 'text-[11px] text-destructive' : hint} data-testid="head-status">
                    {refusal ? `Refused, not published: ${refusal}` : 'Published'}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" aria-label={`Delete head item ${index + 1}`} onClick={() => remove(index)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
              <HeadItemForm idPrefix={`head-${home}-${index}`} value={item} refusal={refusal} mode="edit" onCommit={(next) => replaceAt(index, next)} />
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="mb-2 text-[12px] font-medium">New head item</p>
          {full ? (
            <p className="text-xs text-destructive" role="alert">The {home} holds {cap} items, the most it can. Delete one to add another.</p>
          ) : (
            <HeadItemForm
              key={formKey}
              idPrefix={`head-${home}-new`}
              value={null}
              refusal={null}
              mode="new"
              onCommit={(added) => {
                if (run([...items, ...added], added.length > 1 ? `${added.length} items added.` : 'Item added.')) setFormKey((k) => k + 1);
              }}
            />
          )}
        </div>
      ) : (
        <div>
          <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add head item
          </Button>
        </div>
      )}
    </div>
  );
}
