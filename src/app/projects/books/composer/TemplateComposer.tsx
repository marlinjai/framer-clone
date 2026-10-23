'use client';

// src/app/projects/books/composer/TemplateComposer.tsx
//
// The visual template composer (visual template composer plan, decision 11 and
// phase 4): /projects/books/templates/<id>. Three panels as in the email
// editor: blocks and outline on the left, the real PDF in the middle, the
// inspector on the right.
//
// The template document is plain JSON held in the browser. Every change goes
// through one undo history (`useUndoableState` from
// @marlinjai/block-editor-react: 100 steps, typing in one field coalesced
// within 700 ms into one step); Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z and Ctrl+Y
// redo, Cmd/Ctrl+S saves. Saving sends the whole document with the version it
// was made on: the server runs the save gate (structural rules and the probe
// render) and writes the next version, or refuses with the problems (shown
// next to the blocks they concern) or with `concurrent_edit` when someone saved
// in between. Saving keeps the history.
//
// The four paths of the stateful-flow standard:
//   forward: edit, preview, save (version N+1, the working copy cleared);
//   backtrack: undo and redo; a refused save leaves every edit in place;
//   resume: unsaved edits live in a working copy (workingCopy.ts), restored on
//     reload when made on the current version, OFFERED (never applied) when
//     another save happened since;
//   re-entry: opening the template again after a save starts from the saved
//     version with an empty history and no working copy.
//
// Announcements (preview state, saves, refused moves) go through one
// `aria-live` region.

import { useUndoableState } from '@marlinjai/block-editor-react';
import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  BooksApiError,
  booksApi,
  type DocumentListItem,
  type PreviewSubject,
  type TemplateProblemView,
  type TemplateVersionView,
  type TemplateView,
} from '@/lib/books/api';
import { templateDocumentV2Schema } from '@/server/books/template/schema';

import { ErrorAlert, errorText } from '../ui';
import {
  BLOCK_INFO,
  COLUMN_LABELS,
  REGION_LABELS,
  addBlock,
  isRequired,
  locate,
  moveBlock,
  moveByStep,
  moveRefusal,
  regionList,
  removeBlock,
  requiredReason,
  type BlockType,
  type RegionName,
  type TemplateDocumentV2,
} from './doc';
import Inspector, { type Update } from './Inspector';
import Outline from './Outline';
import PdfCanvas, { type ColumnResize } from './PdfCanvas';
import { problemText } from './problems';
import { usePreview } from './usePreview';
import { clearWorkingCopy, hasDocumentShape, readWorkingCopy, resumeDecision, writeWorkingCopy, type WorkingCopy } from './workingCopy';

/** The fictional sample documents of the preview (the save gate's probes). */
export const SAMPLES: Array<{ variant: string; label: string }> = [
  { variant: 'regular', label: 'Sample: invoice with two tax rates' },
  { variant: 'smallBusiness', label: 'Sample: small-business invoice' },
  { variant: 'reverseCharge', label: 'Sample: reverse-charge invoice' },
  { variant: 'creditNote', label: 'Sample: credit note' },
  { variant: 'longInvoice', label: 'Sample: 40 lines over three pages' },
  { variant: 'longRecipient', label: 'Sample: long foreign address' },
  { variant: 'longDescription', label: 'Sample: very long line description' },
];

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5];
const MM = 72 / 25.4;
const A4_WIDTH_PT = 595.28;

export default function TemplateComposer({ id }: { id: string }) {
  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      setTemplate(await booksApi.template(id));
    } catch (err) {
      setFailure({ code: err instanceof BooksApiError ? err.code : 'error', message: errorText(err) });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failure) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
        <h1 className="text-xl font-semibold">Template composer</h1>
        <p>
          {failure.code === 'template_not_found'
            ? 'This template does not exist or was removed. Documents issued with it keep their layout.'
            : failure.message}
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/projects/books?tab=templates">Back to the templates</Link>
          </Button>
          {failure.code === 'template_not_found' ? null : <Button onClick={() => void load()}>Try again</Button>}
        </div>
      </main>
    );
  }
  if (!template) {
    return (
      <p className="p-8 text-sm text-muted-foreground" role="status">
        Loading the template…
      </p>
    );
  }
  return (
    <Composer
      key={`${template.id}:${generation}`}
      template={template}
      focusOnMount={generation > 0}
      onReload={async () => {
        await load();
        setGeneration((g) => g + 1);
      }}
    />
  );
}

function Composer({ template, onReload, focusOnMount }: { template: TemplateView; onReload: () => Promise<void>; focusOnMount: boolean }) {
  const initial = template.document as TemplateDocumentV2;
  const { state: doc, update: rawUpdate, undo, redo, canUndo, canRedo } = useUndoableState<TemplateDocumentV2>(initial, {
    limit: 100,
    coalesceMs: 700,
  });
  const [base, setBase] = useState({ id: template.currentVersionId, version: template.version });
  const [saved, setSaved] = useState<string>(() => normalized(initial));
  const [name, setName] = useState(template.name);
  const [savedName, setSavedName] = useState(template.name);
  const skipRename = useRef(false);
  const [isDefault, setIsDefault] = useState(template.isDefault);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetRegion, setTargetRegion] = useState<RegionName>('body');
  const [subject, setSubject] = useState<PreviewSubject>({ kind: 'sample', variant: 'regular' });
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveProblems, setSaveProblems] = useState<TemplateProblemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [versions, setVersions] = useState<TemplateVersionView[] | null>(null);
  const [documents, setDocuments] = useState<DocumentListItem[] | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [pageInView, setPageInView] = useState(1);
  const [resume, setResume] = useState<{ kind: 'restored' | 'stale'; copy: WorkingCopy } | null>(null);
  const [docsError, setDocsError] = useState(false);
  const resumeSettled = useRef(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const announceTimer = useRef<number | undefined>(undefined);

  const announce = useCallback((text: string) => {
    // Re-announce the same sentence: clear first, then set.
    setAnnouncement('');
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => setAnnouncement(text), 30);
  }, []);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  const update: Update = useCallback(
    (recipe, coalesceKey) => rawUpdate((d) => recipe(d as TemplateDocumentV2), coalesceKey ? { coalesceKey } : undefined),
    [rawUpdate],
  );

  // The document as the schema reads it: what is previewed and saved, and what "unsaved" compares.
  const parsed = useMemo(() => templateDocumentV2Schema.safeParse(doc), [doc]);
  const current = parsed.success ? normalized(parsed.data) : JSON.stringify(doc);
  const dirty = current !== saved;

  // Resume: a working copy is restored or offered once, when the template opens.
  useEffect(() => {
    const decision = resumeDecision(readWorkingCopy(template.id), template.currentVersionId, template.document);
    if (decision.kind === 'none') {
      clearWorkingCopy(template.id);
      resumeSettled.current = true;
      return;
    }
    // A copy may end mid-edit with a field the schema refuses (an emptied text): it is restored as it is and the
    // preview waits for the field. Only a copy the composer cannot even show (not a template document) is dropped.
    if (!hasDocumentShape(decision.copy.document)) {
      clearWorkingCopy(template.id);
      resumeSettled.current = true;
      return;
    }
    if (decision.kind === 'restore') {
      // As one step, so Undo returns to the saved version.
      rawUpdate(decision.copy.document as TemplateDocumentV2);
      setResume({ kind: 'restored', copy: decision.copy });
      resumeSettled.current = true;
    } else {
      // Offered, never applied: the copy stays stored until the user decides.
      setResume({ kind: 'stale', copy: decision.copy });
    }
    // Once per opened template.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After "Load the newest version" the composer is new: focus goes to the offer of the earlier edits, or the name.
  useEffect(() => {
    if (!focusOnMount) return;
    const offer = window.document.querySelector<HTMLButtonElement>('[data-resume-offer] button');
    (offer ?? nameRef.current)?.focus();
    // Once, after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep unsaved edits as the working copy (not while an older copy is still offered).
  useEffect(() => {
    if (!resumeSettled.current) return;
    if (dirty) writeWorkingCopy(template.id, base, doc);
    else clearWorkingCopy(template.id);
  }, [doc, dirty, base, template.id]);

  // A refused save's problems belong to the layout it was made with.
  useEffect(() => setSaveProblems(null), [doc]);

  const preview = usePreview(parsed.success ? parsed.data : null, subject, { enabled: parsed.success });

  const liveProblems: TemplateProblemView[] = useMemo(() => {
    const r = preview.result;
    if (!r) return [];
    const layout = r.layout.issues.map((i) => ({
      code: 'LAYOUT_PROBLEM',
      message: i.code,
      field: i.code,
      region: i.region,
      blockId: i.blockId ?? undefined,
    }));
    return [...r.problems, ...layout];
  }, [preview.result]);
  const problems = saveProblems ?? liveProblems;

  const loadVersions = useCallback(async () => {
    try {
      setVersions((await booksApi.templateVersions(template.id)).items);
    } catch (err) {
      setError(errorText(err));
    }
  }, [template.id]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  async function loadDocuments() {
    if (documents && !docsError) return;
    try {
      setDocsError(false);
      setDocuments((await booksApi.documents()).items);
    } catch {
      // The samples still work; the list says the documents could not be read, and opening it again retries.
      setDocsError(true);
    }
  }

  // Announce the preview's state changes.
  const lastStatus = useRef('');
  const lastPages = useRef<number | null>(null);
  useEffect(() => {
    const status = !parsed.success ? 'invalid' : preview.error ? 'error' : preview.pending ? 'pending' : preview.result ? 'ready' : 'loading';
    if (status === lastStatus.current) return;
    lastStatus.current = status;
    if (status === 'error') announce(`The preview could not be updated: ${preview.error}`);
    // Every edit refreshes the preview; saying so each time would drown what the edit itself announced. Only a new page count is news.
    if (status === 'ready' && preview.result && preview.result.layout.pageCount !== lastPages.current) {
      if (lastPages.current !== null) {
        announce(`The document now has ${preview.result.layout.pageCount} ${preview.result.layout.pageCount === 1 ? 'page' : 'pages'}.`);
      }
      lastPages.current = preview.result.layout.pageCount;
    }
  }, [parsed.success, preview.error, preview.pending, preview.result, announce]);

  // --- Actions. ---

  const select = useCallback((blockId: string | null) => {
    setSelectedId(blockId);
    if (blockId) {
      const at = locate(doc, blockId);
      if (at) setTargetRegion(at.region);
    }
  }, [doc]);

  function add(type: BlockType, region: RegionName) {
    let added: string | null = null;
    const sel = selectedId ? locate(doc, selectedId) : null;
    // After the selected block when it stands in the same region, else at the region's end.
    const index = sel && !sel.cell && sel.region === region ? sel.index + 1 : undefined;
    update((d) => {
      added = addBlock(d, type, region, index);
    });
    if (added) {
      setSelectedId(added);
      announce(`${BLOCK_INFO[type].label} added to the ${REGION_LABELS[region].toLowerCase()}.`);
    }
  }

  function remove(blockId: string, fromKeyboard = false) {
    const at = locate(doc, blockId);
    if (!at) return;
    const type = at.cell ? at.cell.block.type : at.block.type;
    if (!at.cell && isRequired(type, at.region)) {
      announce(requiredReason(type));
      return;
    }
    // The next block of the region (or the previous one) takes the selection, so focus has a place to go.
    const list = regionList(doc, at.region);
    const neighbour = at.cell ? at.cell.rowId : (list[at.index + 1] ?? list[at.index - 1])?.id ?? null;
    update((d) => void removeBlock(d, blockId));
    setSelectedId(neighbour);
    // The removed block's row is gone: keyboard focus moves to the block that took the selection.
    if (fromKeyboard && neighbour) refocus.current = { announce: false };
    announce(`${BLOCK_INFO[type].label} removed. Undo with Ctrl+Z or Cmd+Z.`);
  }

  function move(blockId: string, region: RegionName, index: number) {
    const at = locate(doc, blockId);
    if (!at) return;
    const refusal = moveRefusal(doc, blockId, region);
    if (refusal) {
      announce(refusal);
      return;
    }
    let moved = false;
    update((d) => {
      moved = moveBlock(d, blockId, region, index);
    });
    if (moved) announce(`${BLOCK_INFO[at.block.type].label} moved${region !== at.region ? ` to the ${REGION_LABELS[region].toLowerCase()}` : ''}.`);
  }

  /** One step up or down (Alt+Up and Alt+Down, or the inspector's buttons); from the keyboard, focus follows the block. */
  function step(delta: -1 | 1, fromKeyboard = false) {
    if (!selectedId) return;
    const before = locate(doc, selectedId);
    if (!before) return;
    let moved = false;
    update((d) => {
      moved = moveByStep(d, selectedId, delta);
    });
    const label = BLOCK_INFO[(before.cell?.block ?? before.block).type].label;
    if (!moved) announce(`${label} cannot move further ${delta < 0 ? 'up' : 'down'}.`);
    else if (fromKeyboard) refocus.current = { announce: true };
    else announcePosition(selectedId);
  }

  function announcePosition(blockId: string) {
    // Read on the next render, when the document holds the move.
    window.setTimeout(() => {
      const at = locate(docRef.current, blockId);
      if (at) announce(`${BLOCK_INFO[(at.cell?.block ?? at.block).type].label}, ${REGION_LABELS[at.region].toLowerCase()}, position ${(at.cell?.index ?? at.index) + 1}.`);
    }, 0);
  }

  // After a keyboard move or delete the row is drawn anew: focus goes to the selected block's name. Set only when
  // something actually changed, so a refused move never pulls focus away later.
  const refocus = useRef<{ announce: boolean } | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    const pending = refocus.current;
    if (!pending || !selectedId) return;
    refocus.current = null;
    Array.from(window.document.querySelectorAll<HTMLButtonElement>('[data-outline-select]'))
      .find((b) => b.dataset.outlineSelect === selectedId)
      ?.focus();
    if (pending.announce) announcePosition(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selectedId]);

  // Enter on a block in the outline: select it, then (once the inspector shows it) focus its first control.
  const focusInspector = useRef(false);
  useEffect(() => {
    if (!focusInspector.current) return;
    focusInspector.current = false;
    inspectorRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }, [selectedId]);

  function dropOn(blockId: string, targetId: string, after: boolean) {
    const from = locate(doc, blockId);
    const target = locate(doc, targetId);
    if (!from || !target || from.cell || target.cell || from.region !== target.region) return;
    // The index counted after the moved block is taken out.
    let index = target.index + (after ? 1 : 0);
    if (from.index < index) index -= 1;
    move(blockId, target.region, index);
  }

  function resizeColumn(r: ColumnResize) {
    const marginsPt = (doc.page.marginsMm.left + doc.page.marginsMm.right) * MM;
    const units = Math.max(1, Math.min(100, Math.round((r.widthPt / (A4_WIDTH_PT - marginsPt)) * 100)));
    update((d) => {
      const at = locate(d, r.blockId);
      if (at && !at.cell && at.block.type === 'lineTable') at.block.columns[r.column].width = units;
    });
    announce(`${COLUMN_LABELS[r.column]} column set to ${units} of 100.`);
  }

  async function save() {
    if (saving) return;
    if (!parsed.success) {
      announce('Not saved: fix the fields marked in the panel above the preview first.');
      return;
    }
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const result = await booksApi.updateTemplate(template.id, { document: parsed.data, baseVersionId: base.id });
      const unchanged = result.currentVersionId === base.id;
      setBase({ id: result.currentVersionId, version: result.version });
      setSaved(normalized(result.document as TemplateDocumentV2));
      clearWorkingCopy(template.id);
      setResume(null);
      resumeSettled.current = true;
      announce(unchanged ? 'Nothing to save: the layout is the saved one.' : `Saved as version ${result.version}.`);
      void loadVersions();
    } catch (err) {
      if (err instanceof BooksApiError && err.code === 'template_invalid' && Array.isArray(err.details.problems)) {
        const list = err.details.problems as TemplateProblemView[];
        setSaveProblems(list);
        announce(`Not saved: ${list.length} ${list.length === 1 ? 'problem' : 'problems'} to fix. They are listed above the preview.`);
      } else if (err instanceof BooksApiError && err.code === 'concurrent_edit') {
        setConflict(true);
        announce('Not saved: someone saved a newer version of this template meanwhile.');
      } else {
        setError(errorText(err));
        announce(`Not saved: ${errorText(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function rename(next: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === savedName) {
      setName(savedName);
      return;
    }
    try {
      const result = await booksApi.updateTemplate(template.id, { name: trimmed });
      setName(result.name);
      setSavedName(result.name);
      announce(`Renamed to ${result.name}.`);
    } catch (err) {
      setName(savedName);
      setError(errorText(err));
    }
  }

  async function makeDefault() {
    try {
      await booksApi.updateTemplate(template.id, { isDefault: true });
      setIsDefault(true);
      announce('This is now the default template for new documents.');
    } catch (err) {
      setError(errorText(err));
    }
  }

  // --- Keyboard. ---

  // On the window, not the composer's element: after a clicked button disappears focus falls back to the
  // page body, and the shortcuts must keep working there.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    const editable = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (resume?.kind !== 'stale') void save();
      return;
    }
    // In a text field the browser's own undo applies to the text being typed.
    if (editable) return;
    // On an outline drag handle the keys belong to the drag (Space, arrows, Escape while a block is picked up).
    if (t.closest('[data-drag-handle]')) return;
    // While earlier edits are offered, nothing changes the document until the user has chosen.
    if (resume?.kind === 'stale') return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (canRedo) redo();
      } else if (canUndo) undo();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      if (canRedo) redo();
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedId) {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? -1 : 1, true);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      remove(selectedId, true);
      return;
    }
    if (e.key === 'Escape' && selectedId) {
      setSelectedId(null);
    }
  }

  const labelOf = useCallback(
    (blockId: string) => {
      const at = locate(doc, blockId);
      return at ? BLOCK_INFO[(at.cell?.block ?? at.block).type].label : blockId;
    },
    [doc],
  );
  const isMovable = useCallback((blockId: string) => {
    const at = locate(doc, blockId);
    return !!at && !at.cell;
  }, [doc]);

  const status = !parsed.success
    ? 'Preview paused: fix the marked fields'
    : preview.error
      ? 'Preview not updated'
      : preview.pending
        ? 'Updating the preview…'
        : preview.result
          ? `Preview current${preview.endToEndMs !== null ? ` (${preview.endToEndMs} ms)` : ''}`
          : 'Loading the preview…';

  const pageCount = preview.result?.layout.pageCount ?? 0;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <h1 className="sr-only">Template composer: {name}</h1>
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <Link href="/projects/books?tab=templates" className="text-sm underline">
          Templates
        </Link>
        <label className="sr-only" htmlFor="composer-name">
          Template name
        </label>
        <input
          id="composer-name"
          value={name}
          maxLength={80}
          className="rounded-md border border-transparent px-2 py-1 text-lg font-semibold hover:border-gray-300 focus:border-gray-400"
          ref={nameRef}
          onChange={(e) => setName(e.target.value)}
          onBlur={(e) => {
            // Escape cancels: the blur it causes must not save what was typed.
            if (skipRename.current) {
              skipRename.current = false;
              return;
            }
            void rename(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              skipRename.current = true;
              setName(savedName);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="text-xs text-muted-foreground">
          Version {base.version}
          {dirty ? ', unsaved changes' : ''}
        </span>
        {isDefault ? (
          <span className="rounded-full border px-2 py-0.5 text-xs">Default</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void makeDefault()}>
            Make default
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={undo} disabled={!canUndo} aria-keyshortcuts="Control+Z Meta+Z">
            Undo
          </Button>
          <Button size="sm" variant="outline" onClick={redo} disabled={!canRedo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y">
            Redo
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || resume?.kind === 'stale'} aria-keyshortcuts="Control+S Meta+S">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </span>
      </header>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="flex flex-col gap-2 px-4 pt-2">
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
        {resume?.kind === 'restored' ? (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
            Your unsaved changes from {formatTime(resume.copy.savedAt)} are back. Undo returns to the saved version.
            <Button size="sm" variant="ghost" onClick={() => setResume(null)}>
              OK
            </Button>
          </div>
        ) : null}
        {resume?.kind === 'stale' ? (
          <div role="alert" data-resume-offer className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
            <span>
              Unsaved changes from {formatTime(resume.copy.savedAt)} are kept in this browser. They were made on version {resume.copy.baseVersion}; version{' '}
              {base.version} was saved since. Applying them replaces what the newer version changed when you save. Choose first: editing waits until
              then.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                rawUpdate(resume.copy.document as TemplateDocumentV2);
                setResume(null);
                resumeSettled.current = true;
                announce('The earlier changes are applied. Save to keep them.');
              }}
            >
              Apply them anyway
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearWorkingCopy(template.id);
                setResume(null);
                resumeSettled.current = true;
                announce('The earlier changes are discarded.');
              }}
            >
              Discard them
            </Button>
          </div>
        ) : null}
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
            Someone saved a newer version of this template meanwhile, so yours was not saved. Load the newest version; your changes stay in this browser and are
            offered to you there.
            <Button size="sm" variant="outline" onClick={() => void onReload()}>
              Load the newest version
            </Button>
          </div>
        ) : null}
        {!parsed.success ? (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            <p className="font-medium">Some fields need a value before the preview can update:</p>
            <ul className="list-disc pl-5">
              {parsed.error.issues.slice(0, 5).map((issue, i) => (
                <li key={i}>{issueText(doc, issue.path, issue.code, issue.message)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {problems.length > 0 ? (
          <section aria-label="What stops this template from being saved" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <p className="font-medium">
              {saveProblems ? 'Not saved. To fix:' : 'To fix before saving:'} {problems.length} {problems.length === 1 ? 'problem' : 'problems'}
            </p>
            <ul className="flex flex-col gap-1 pt-1">
              {problems.slice(0, 8).map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span>{problemText(p)}</span>
                  {p.blockId && locate(doc, p.blockId) ? (
                    <Button size="sm" variant="link" className="h-auto p-0" onClick={() => select(p.blockId!)}>
                      Show
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* While earlier edits are offered (stale working copy) the panels wait for the choice, so nothing is lost between the two. */}
      <div
        inert={resume?.kind === 'stale'}
        className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[16rem_1fr_20rem] lg:overflow-hidden"
      >
        <nav aria-label="Blocks" className="overflow-y-auto border-r p-3">
          <Outline
            doc={doc}
            selectedId={selectedId}
            problems={problems}
            targetRegion={targetRegion}
            onTargetRegion={setTargetRegion}
            onSelect={select}
            onAdd={add}
            onMove={move}
            onRefused={announce}
            onOpenInspector={(blockId) => {
              focusInspector.current = true;
              select(blockId);
              // Already selected: no render follows, so focus now.
              if (blockId === selectedId) {
                focusInspector.current = false;
                inspectorRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
              }
            }}
          />
        </nav>

        <section aria-label="Preview" className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-sm">
            <label className="flex items-center gap-2">
              <span>Preview with</span>
              <select
                className="rounded-md border border-gray-500 px-2 py-1"
                value={subject.kind === 'sample' ? `sample:${subject.variant}` : `document:${subject.documentId}`}
                onFocus={() => void loadDocuments()}
                onChange={(e) => {
                  const raw = e.target.value;
                  const kind = raw.slice(0, raw.indexOf(':'));
                  const value = raw.slice(raw.indexOf(':') + 1);
                  setSubject(kind === 'sample' ? { kind: 'sample', variant: value } : { kind: 'document', documentId: value });
                }}
              >
                <optgroup label="Samples (fictional data)">
                  {SAMPLES.map((s) => (
                    <option key={s.variant} value={`sample:${s.variant}`}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Your newest documents">
                  {docsError ? <option disabled>Your documents could not be loaded. Open this list again to retry.</option> : null}
                  {documents === null && !docsError ? <option disabled>Loading…</option> : null}
                  {documents?.length === 0 ? <option disabled>No documents yet</option> : null}
                  {documents?.map((d) => (
                    <option key={d.id} value={`document:${d.id}`}>
                      {d.documentNumber ?? 'Draft'}
                      {d.customerName ? `, ${d.customerName}` : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span>Zoom</span>
              <select className="rounded-md border border-gray-500 px-2 py-1" value={String(zoom)} onChange={(e) => setZoom(Number(e.target.value))}>
                {ZOOMS.map((z) => (
                  <option key={z} value={String(z)}>
                    {Math.round(z * 100)} %
                  </option>
                ))}
              </select>
            </label>
            {pageCount > 0 ? (
              <span className="text-muted-foreground">
                Page {Math.min(pageInView, pageCount)} of {pageCount}
              </span>
            ) : null}
            {/* Visual only: every edit refreshes the preview, and the live region says what matters. */}
            <span className="ml-auto text-muted-foreground">
              {status}
            </span>
            {preview.result ? (
              <Button size="sm" variant="outline" onClick={() => openPdf(preview.result!.pdf)}>
                Open the preview as PDF
              </Button>
            ) : null}
            {preview.error ? (
              <Button size="sm" variant="outline" onClick={preview.retry}>
                Try again
              </Button>
            ) : null}
          </div>
          {preview.error ? <p className="px-3 pt-2 text-sm text-red-800">{preview.error}</p> : null}
          {drawError ? <p className="px-3 pt-2 text-sm text-red-800">The preview could not be drawn: {drawError}</p> : null}
          <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-6">
            <PdfCanvas
              pdf={preview.result?.pdf ?? null}
              counter={preview.result?.counter ?? null}
              layout={preview.result?.layout ?? null}
              zoom={zoom}
              dimmed={preview.pending || !parsed.success}
              selectedId={selectedId}
              labelOf={labelOf}
              isMovable={isMovable}
              onSelect={select}
              onDrop={dropOn}
              onColumnResize={resizeColumn}
              onDrawn={(n) => {
                setDrawError(null);
                preview.markDrawn(n);
              }}
              onError={setDrawError}
              onPageInView={setPageInView}
            />
          </div>
        </section>

        <aside aria-labelledby="inspector-title" ref={inspectorRef} className="overflow-y-auto border-l p-3">
          <Inspector doc={doc} selectedId={selectedId} update={update} problems={problems} onSelect={select} onRemove={(id) => remove(id)} onStep={(d) => step(d)} />
          <Versions versions={versions} />
        </aside>
      </div>
    </div>
  );
}

function Versions({ versions }: { versions: TemplateVersionView[] | null }) {
  return (
    <details className="mt-6 border-t pt-3 text-sm">
      <summary className="cursor-pointer font-medium">Saved versions</summary>
      {versions === null ? (
        <p className="pt-2 text-muted-foreground">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-1 pt-2">
          {versions.map((v) => (
            <li key={v.id}>
              Version {v.version} of {localDate(v.createdAt)}
              {v.current ? ' (current)' : ''}, {v.documentCount === 0 ? 'no issued documents' : `used by ${v.documentCount} ${v.documentCount === 1 ? 'document' : 'documents'}`}
            </li>
          ))}
        </ul>
      )}
      <p className="pt-2 text-xs text-muted-foreground">Issued documents keep the version they were issued with; a new version changes only documents issued later.</p>
    </details>
  );
}

/** The document as one comparable string (keys in schema order, defaults filled). */
function normalized(doc: TemplateDocumentV2): string {
  const parsed = templateDocumentV2Schema.safeParse(doc);
  return JSON.stringify(parsed.success ? parsed.data : doc);
}

/**
 * The preview as a PDF file in a new tab: the canvas is a picture, the file is
 * the same document with its text, readable by the browser's PDF viewer and a
 * screen reader.
 */
function openPdf(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener');
  // The tab has read it by then; the address is not kept.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A timestamp's calendar day where the user is (a save after midnight in Germany is on the German date). */
function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A schema issue named by the block it concerns ("Text: enter a text"). */
function issueText(doc: TemplateDocumentV2, path: ReadonlyArray<PropertyKey>, code: string, message: string): string {
  const keys = path.map(String);
  let label = 'The template';
  if (keys[0] === 'regions') {
    let list: unknown = doc.regions;
    for (const k of keys.slice(1)) {
      list = (list as Record<string, unknown> | undefined)?.[k];
      const b = list as { type?: string } | undefined;
      if (b && typeof b === 'object' && typeof b.type === 'string' && b.type in BLOCK_INFO) label = BLOCK_INFO[b.type as BlockType].label;
    }
  } else if (keys[0] === 'theme' || keys[0] === 'page') {
    label = 'Page and theme';
  }
  const field = keys[keys.length - 1];
  if (field === 'text' && code === 'too_small') return `${label}: enter a text, or remove the block.`;
  return `${label} (${field}): ${message}.`;
}
