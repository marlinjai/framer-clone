'use client';

// src/app/projects/books/invoice/InvoicePage.tsx
//
// Write the invoice on the invoice (WYSIWYG invoice editor plan, decisions 1
// to 7, phase 3). The draft is shown as the real A4 page in the company's
// template, drawn by the layout engine in the browser (phase 1); every
// editable field of the engine's field map (phase 2) is a button exactly on
// its printed text, and a click (or Enter) opens an editor right there, in the
// invoice's own font, size, colour and alignment.
//
// - Text fields (descriptions, the intro and closing text, the reference)
//   redraw the page from the local input while typing; amounts, dates and the
//   tax rate are sent to the server, which computes every figure, and the page
//   is drawn again from its answer (decision 3).
// - Every change is one request with the draft's version, through the
//   editor's own change path (a stale version reloads and says so).
// - Actions are editing controls on the page, never in the PDF (decision 1a):
//   "+ Add line" and "+ Choose product" where the next line would print, a
//   menu beside each line (move, duplicate, remove, discount, tax rate), and
//   "+ Add ..." where an empty optional field would print.
// - Undo and redo work over the saved changes (Cmd or Ctrl+Z, Shift+Cmd or
//   Ctrl+Z, Ctrl+Y), each step sent as a change of its own.
// - The template's own content (logo, sender, labels, small print) is not a
//   field; the address is the customer's contact, so clicking it chooses
//   another customer (decision 5).
// - Keyboard: every field and control is a real button or input, in reading
//   order; Enter opens a field, Escape leaves it unchanged, Enter in the new
//   line's last field adds it and opens the next one (decision 7).

import { MoreHorizontal, Plus, Search } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { booksApi, type CustomerView, type DocumentDetail, type LineView, type ProductView } from '@/lib/books/api';
import { lineFromProduct } from '@/lib/books/products';
import { money, parseMoney, parseQuantity } from '@/lib/books/units';
import type { FieldRect, LayoutField } from '@/server/books/render/engine';

import PdfCanvas from '../composer/PdfCanvas';
import { errorText } from '../ui';
import { TAX_CLASS_OPTIONS, applyLocal, editValue, fieldLabel, parseValue, readOnlyReason, type FieldRequest } from './fields';
import { cssFontFamily, useDraftPage } from './useDraftPage';

export interface InvoicePageProps {
  id: string;
  detail: DocumentDetail;
  customers: CustomerView[];
  busy: boolean;
  /** One change through the editor's change path (version, stale reload, errors); true when it was saved. */
  change: (fn: () => Promise<DocumentDetail>) => Promise<boolean>;
}

const ZOOMS = [0.75, 1, 1.25, 1.5];

interface ActiveEditor {
  field: LayoutField;
  /** The rectangle the editor sits on (a field may span pages). */
  rect: FieldRect;
  value: string;
  /** The value it started with: an unchanged value sends nothing. */
  initial: string;
  error: string | null;
}

interface UndoStep {
  label: string;
  /** Run against the latest version. */
  undo: (version: number) => Promise<DocumentDetail>;
  redo: (version: number) => Promise<DocumentDetail>;
}

/** What an empty field's placeholder says ("Add details", "Add an intro text"). */
function placeholderText(f: LayoutField): string {
  if (f.id === 'recipient.customer') return 'Choose a customer';
  switch (f.documentField) {
    case 'description':
      return 'Add details';
    case 'introText':
      return 'Add an intro text';
    case 'outroText':
      return 'Add a closing text';
    case 'contractReference':
      return 'Add a reference';
    default:
      return 'Add';
  }
}

/** The request a field change becomes, as a call. */
function call(id: string, req: FieldRequest, version: number): Promise<DocumentDetail> {
  if (req.kind === 'customer') return booksApi.setCustomer(id, req.customerId, version);
  if (req.kind === 'line') return booksApi.updateLine(id, req.lineId, { ...req.body, expectedVersion: version });
  return booksApi.updateDraft(id, { ...req.body, expectedVersion: version });
}

/** The fields of a line as an add-line body (duplicating a line, or adding back a removed one). */
function copyOfLine(l: LineView): Record<string, unknown> {
  if (l.kind === 'text') return { kind: 'text', title: l.title };
  return {
    kind: l.kind,
    title: l.title,
    description: l.description,
    quantity: l.quantity,
    unitLabel: l.unitLabel,
    unitPrice: l.unitPrice,
    discountBp: l.discountBp,
    ...(l.taxRateOverride !== null ? { taxRateOverride: l.taxRateOverride } : { taxClass: l.taxClass ?? 'standard' }),
  };
}

export default function InvoicePage({ id, detail, customers, busy, change }: InvoicePageProps) {
  const doc = detail.document;
  const page = useDraftPage(id, doc.version);
  const [zoom, setZoom] = useState(1);
  const [active, setActive] = useState<ActiveEditor | null>(null);
  const [adding, setAdding] = useState<{ title: string; quantity: string; unit: string; price: string; error: string | null } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [undoStack, setUndoStack] = useState<UndoStep[]>([]);
  const [redoStack, setRedoStack] = useState<UndoStep[]>([]);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const focusAfter = useRef<string | null>(null);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const announce = useCallback((text: string) => {
    setAnnouncement('');
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setAnnouncement(text), 30);
  }, []);
  useEffect(() => () => clearTimeout(announceTimer.current), []);

  const layout = page.drawn?.layout ?? null;
  const family = page.payload?.fontFamily ?? 'dejavu-sans';
  const usable = useMemo(() => customers.filter((c) => !c.archivedAt), [customers]);

  /** One saved step that can be undone; the stacks follow. */
  const run = useCallback(
    async (step: UndoStep, fn: (version: number) => Promise<DocumentDetail>, done: string) => {
      const ok = await change(() => fn(detailRef.current.document.version));
      if (ok) {
        setUndoStack((s) => [...s.slice(-49), step]);
        setRedoStack([]);
        announce(done);
      }
      return ok;
    },
    [change, announce],
  );

  // Focus returns to the field (or control) that was edited once the new page is drawn.
  // The canvas swaps in the new page a moment after this render (it draws first), so the field's button is looked
  // for over the next frames, up to about a second.
  useEffect(() => {
    if (!focusAfter.current || !page.drawn) return;
    let frames = 0;
    let handle = 0;
    const tryFocus = () => {
      const target = focusAfter.current;
      if (!target) return;
      const el = Array.from(window.document.querySelectorAll<HTMLElement>('[data-focus-key]')).find((x) => x.dataset.focusKey === target);
      if (el) {
        focusAfter.current = null;
        el.focus();
      } else if (frames++ < 60) handle = requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => cancelAnimationFrame(handle);
  }, [page.drawn]);

  // --- Fields. ---

  function open(field: LayoutField, rect: FieldRect) {
    if (busy) return;
    const value = editValue(field, detail);
    setMenuFor(null);
    setActive({ field, rect, value, initial: value, error: null });
  }

  function onType(value: string) {
    if (!active) return;
    setActive({ ...active, value, error: null });
    const parsed = parseValue(active.field, value);
    if (parsed.ok && parsed.local !== null && page.payload) page.redrawWith(applyLocal(page.payload, active.field, parsed.local));
  }

  async function commit(close = true) {
    if (!active) return;
    const { field, value, initial } = active;
    if (value === initial) {
      if (close) {
        focusAfter.current = field.id;
        setActive(null);
      }
      return;
    }
    const parsed = parseValue(field, value);
    if (!parsed.ok) {
      setActive({ ...active, error: parsed.message });
      return;
    }
    const before = parseValue(field, initial);
    const label = fieldLabel(field, detail);
    focusAfter.current = field.id;
    setActive(null);
    const forward = parsed.request;
    const step: UndoStep = {
      label,
      undo: (v) => (before.ok ? call(id, before.request, v) : Promise.reject(new Error(before.message))),
      redo: (v) => call(id, forward, v),
    };
    const ok = await run(step, (v) => call(id, forward, v), `${label} saved.`);
    // A refused value (the server's rule) reopens the field with what was typed, so nothing is lost.
    if (!ok) setActive({ field, rect: active.rect, value, initial, error: null });
  }

  function cancelEdit() {
    if (!active) return;
    focusAfter.current = active.field.id;
    // The page goes back to the saved text.
    if (page.payload) page.redrawWith(page.payload);
    setActive(null);
  }

  // --- Lines. ---

  async function addLineFrom(body: Record<string, unknown>, label: string): Promise<boolean> {
    const beforeIds = new Set(detailRef.current.lines.map((l) => l.id));
    let addedId: string | null = null;
    const step: UndoStep = {
      label,
      undo: (v) => (addedId ? booksApi.removeLine(id, addedId, v) : Promise.reject(new Error('gone'))),
      redo: async (v) => {
        const d = await booksApi.addLine(id, { ...body, expectedVersion: v });
        addedId = d.lines.find((l) => !beforeIds.has(l.id))?.id ?? addedId;
        return d;
      },
    };
    return run(
      step,
      async (v) => {
        const d = await booksApi.addLine(id, { ...body, expectedVersion: v });
        addedId = d.lines.find((l) => !beforeIds.has(l.id))?.id ?? null;
        return d;
      },
      `${label} added.`,
    );
  }

  async function saveNewLine(again: boolean) {
    if (!adding) return;
    const title = adding.title.trim();
    if (title === '') return setAdding({ ...adding, error: 'Enter a description for the line.' });
    const q = parseQuantity(adding.quantity || '1');
    if (q === null || q <= 0) return setAdding({ ...adding, error: 'Enter a quantity above 0, for example 1,5.' });
    const p = parseMoney(adding.price || '0');
    if (p === null || p < 0) return setAdding({ ...adding, error: 'Enter a unit price in euros, for example 80,00.' });
    const body = { kind: 'service', title, quantity: q, unitLabel: adding.unit.trim() || 'Stk', unitPrice: p, taxClass: 'standard' };
    const ok = await addLineFrom(body, `Line “${title}”`);
    if (ok) setAdding(again ? { title: '', quantity: '1', unit: adding.unit || 'Std', price: '', error: null } : null);
  }

  function lineAction(l: LineView, action: 'up' | 'down' | 'duplicate' | 'remove') {
    setMenuFor(null);
    const ids = detailRef.current.lines.map((x) => x.id);
    const i = ids.indexOf(l.id);
    if (action === 'up' || action === 'down') {
      const j = i + (action === 'up' ? -1 : 1);
      if (j < 0 || j >= ids.length) return;
      const next = [...ids];
      [next[i], next[j]] = [next[j], next[i]];
      focusAfter.current = `menu:${l.id}`;
      void run(
        { label: 'Move', undo: (v) => booksApi.reorderLines(id, ids, v), redo: (v) => booksApi.reorderLines(id, next, v) },
        (v) => booksApi.reorderLines(id, next, v),
        `Line ${i + 1} moved ${action}.`,
      );
      return;
    }
    if (action === 'duplicate') {
      void addLineFrom(copyOfLine(l), `A copy of line ${i + 1}`);
      return;
    }
    // Remove: undo adds it back at its place.
    const body = copyOfLine(l);
    let restoredId: string | null = null;
    void run(
      {
        label: 'Remove',
        undo: async (v) => {
          const before = new Set(detailRef.current.lines.map((x) => x.id));
          const d = await booksApi.addLine(id, { ...body, expectedVersion: v });
          restoredId = d.lines.find((x) => !before.has(x.id))?.id ?? null;
          if (!restoredId) return d;
          const order = d.lines.map((x) => x.id).filter((x) => x !== restoredId);
          order.splice(i, 0, restoredId);
          return booksApi.reorderLines(id, order, d.document.version);
        },
        redo: (v) => (restoredId ? booksApi.removeLine(id, restoredId, v) : booksApi.removeLine(id, l.id, v)),
      },
      (v) => booksApi.removeLine(id, l.id, v),
      `Line ${i + 1} removed. Undo with Ctrl+Z or Cmd+Z.`,
    );
  }

  async function pickProduct(p: ProductView) {
    setPicking(false);
    await addLineFrom({ ...lineFromProduct(p), quantity: 1000 }, `“${p.name}”`);
  }

  // --- Undo and redo. ---

  const undo = useCallback(async () => {
    const step = undoStack[undoStack.length - 1];
    if (!step || busy) return;
    const ok = await change(() => step.undo(detailRef.current.document.version));
    if (ok) {
      setUndoStack((s) => s.slice(0, -1));
      setRedoStack((s) => [...s, step]);
      announce(`Undone: ${step.label}.`);
    }
  }, [undoStack, busy, change, announce]);

  const redo = useCallback(async () => {
    const step = redoStack[redoStack.length - 1];
    if (!step || busy) return;
    const ok = await change(() => step.redo(detailRef.current.document.version));
    if (ok) {
      setRedoStack((s) => s.slice(0, -1));
      setUndoStack((s) => [...s, step]);
      announce(`Redone: ${step.label}.`);
    }
  }, [redoStack, busy, change, announce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // --- The overlay of one page. ---

  const overlay = (pageNo: number, scale: number) => {
    if (!layout) return null;
    const style = (r: FieldRect): React.CSSProperties => ({ left: r.x * scale, top: r.y * scale, width: Math.max(r.width * scale, 12), height: Math.max(r.height * scale, 10) });
    const nodes: React.ReactNode[] = [];

    for (const f of layout.fields) {
      f.rects.forEach((r, ri) => {
        if (r.page !== pageNo) return;
        const key = `${f.id}#${ri}`;
        const isActive = active?.field.id === f.id && active.rect === r;
        if (isActive) return;
        const recipient = f.id.startsWith('recipient.');
        const editable = f.kind !== 'readonly' || recipient;
        if (!editable) {
          nodes.push(<span key={key} aria-hidden title={readOnlyReason(f)} className="absolute cursor-default rounded-[2px] hover:bg-gray-500/5" style={style(r)} />);
          return;
        }
        const label = fieldLabel(f, detail);
        const value = f.kind === 'readonly' ? '' : editValue(f, detail);
        const placeholder = f.empty && f.kind !== 'readonly';
        const room = f.room ?? 999;
        // Where the slot has hardly any free room (an empty line description sits right on the next row), the
        // placeholder is a small "+" in the left margin, faint until hovered or focused, never over printed text.
        if (placeholder && room < 9) {
          nodes.push(
            <button
              key={key}
              type="button"
              data-field-id={f.id}
              data-focus-key={ri === 0 ? f.id : undefined}
              tabIndex={ri === 0 ? 0 : -1}
              aria-label={`${placeholderText(f)} (${label})`}
              title={placeholderText(f)}
              disabled={busy}
              className="absolute flex size-5 items-center justify-center rounded-full border border-blue-500 bg-white text-blue-700 opacity-30 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-600"
              style={{ left: r.x * scale - 34, top: Math.max(0, r.y * scale - 10) }}
              onClick={() => open(f, r)}
            >
              <Plus aria-hidden className="size-3" />
            </button>,
          );
          return;
        }
        nodes.push(
          <button
            key={key}
            type="button"
            data-field-id={f.id}
            data-focus-key={ri === 0 ? f.id : undefined}
            tabIndex={ri === 0 ? 0 : -1}
            aria-label={recipient ? `${label}: from the customer. Choose another customer` : `${label}: ${value || 'empty'}. Edit`}
            title={recipient ? readOnlyReason(f) : undefined}
            disabled={busy}
            className={`absolute rounded-[2px] text-left outline-none hover:ring-1 hover:ring-blue-400 focus-visible:ring-2 focus-visible:ring-blue-600 ${
              placeholder ? 'border border-dashed border-blue-400/70 bg-blue-50/60' : ''
            }`}
            style={placeholder ? { ...style(r), height: Math.max(Math.min(r.height, Math.max(room, 9)) * scale, 14) } : style(r)}
            onClick={() => {
              if (recipient) {
                const asCustomer: LayoutField = { ...f, kind: 'select', source: 'document', documentField: 'customerId', empty: false };
                open(asCustomer, r);
              } else open(f, r);
            }}
          >
            {placeholder ? (
              <span className="pointer-events-none flex items-center gap-1 px-1 text-[11px] leading-none text-blue-700">
                <Plus aria-hidden className="size-3" />
                {placeholderText(f)}
              </span>
            ) : null}
          </button>,
        );
      });
    }

    // The line menus, beside each row in the right margin.
    for (const row of layout.anchors.rows) {
      const r = row.rects.find((x) => x.page === pageNo);
      if (!r || row.rects[0] !== r) continue;
      const l = detail.lines.find((x) => x.id === row.lineId);
      if (!l) continue;
      const n = detail.lines.indexOf(l) + 1;
      const menuOpen = menuFor === l.id;
      nodes.push(
        <div key={`menu:${l.id}`} className="absolute" style={{ left: (r.x + r.width) * scale + 6, top: r.y * scale }}>
          <button
            type="button"
            data-focus-key={`menu:${l.id}`}
            aria-label={`Line ${n} actions`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            disabled={busy}
            className="flex size-6 items-center justify-center rounded border border-gray-500 bg-white text-gray-700 opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-600"
            onClick={() => setMenuFor(menuOpen ? null : l.id)}
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </button>
          {menuOpen ? (
            <LineMenu
              line={l}
              index={n - 1}
              count={detail.lines.length}
              regular={!doc.kleinunternehmer && !doc.reverseCharge}
              onAction={(a) => lineAction(l, a)}
              onDiscount={() => {
                const f: LayoutField =
                  layout.fields.find((x) => x.id === `line.${l.id}.discount`) ??
                  ({ ...syntheticLineField(l.id, 'discountBp', r), kind: 'number', valueUnit: 'basisPoints' } as LayoutField);
                setMenuFor(null);
                open(f, f.rects[0] ?? r);
              }}
              onTax={(taxClass) => {
                setMenuFor(null);
                const f = syntheticLineField(l.id, 'taxClass', r);
                const before = l.taxClass ?? 'standard';
                if (before === taxClass) return;
                void run(
                  {
                    label: `Line ${n}, tax rate`,
                    undo: (v) => call(id, { kind: 'line', lineId: l.id, body: { taxClass: before } }, v),
                    redo: (v) => call(id, { kind: 'line', lineId: l.id, body: { taxClass } }, v),
                  },
                  (v) => call(id, { kind: 'line', lineId: l.id, body: { taxClass } }, v),
                  `${fieldLabel(f, detail)} saved.`,
                );
              }}
              onClose={() => setMenuFor(null)}
            />
          ) : null}
        </div>,
      );
    }

    // Where the next line would print: add a line, or choose one from the product list.
    for (const a of layout.anchors.addLine) {
      if (a.rect.page !== pageNo) continue;
      const table = layout.tables.find((t) => t.blockId === a.blockId);
      if (adding && table) {
        nodes.push(
          <NewLineRow
            key="new-line"
            rect={a.rect}
            scale={scale}
            columns={table.columns}
            value={adding}
            fontFamily={cssFontFamily(family)}
            onChange={(v) => setAdding({ ...adding, ...v, error: null })}
            onSave={(again) => void saveNewLine(again)}
            onCancel={() => {
              setAdding(null);
              focusAfter.current = 'add-line';
            }}
          />,
        );
      } else {
        nodes.push(
          <div key="add-line" className="absolute flex items-center gap-2" style={{ left: a.rect.x * scale, top: a.rect.y * scale + 2 }}>
            <button
              type="button"
              data-focus-key="add-line"
              disabled={busy}
              className="flex items-center gap-1 rounded border border-dashed border-blue-500 bg-white px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600"
              onClick={() => {
                setPicking(false);
                setAdding({ title: '', quantity: '1', unit: 'Std', price: '', error: null });
              }}
            >
              <Plus aria-hidden className="size-3" /> Add line
            </button>
            <button
              type="button"
              disabled={busy}
              aria-expanded={picking}
              className="flex items-center gap-1 rounded border border-dashed border-blue-500 bg-white px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600"
              onClick={() => setPicking(!picking)}
            >
              <Search aria-hidden className="size-3" /> Choose product
            </button>
            {picking ? <ProductSearch onPick={(p) => void pickProduct(p)} onClose={() => setPicking(false)} /> : null}
          </div>,
        );
      }
    }

    // The open editor.
    if (active && active.rect.page === pageNo) {
      nodes.push(
        <InlineEditor
          key="editor"
          editor={active}
          scale={scale}
          fontFamily={cssFontFamily(active.field.style.fontFamily)}
          customers={usable}
          label={fieldLabel(active.field, detail)}
          onType={onType}
          onCommit={() => void commit()}
          onCancel={cancelEdit}
        />,
      );
    }
    return nodes;
  };

  /** A field the map does not print (a line's tax class or a discount of 0), placed on its row. */
  function syntheticLineField(lineId: string, key: 'taxClass' | 'discountBp', r: FieldRect): LayoutField {
    return {
      id: `line.${lineId}.${key === 'taxClass' ? 'rate' : 'discount'}`,
      kind: key === 'taxClass' ? 'select' : 'number',
      source: 'line',
      documentField: key,
      valueUnit: key === 'discountBp' ? 'basisPoints' : null,
      recipientField: null,
      lineId,
      blockId: 'lineTable',
      region: 'body',
      empty: false,
      room: null,
      rects: [{ ...r, x: r.x + r.width - 80, width: 80, height: Math.min(r.height, 16) }],
      style: layout?.fields.find((x) => x.lineId === lineId)?.style ?? { fontFamily: family, bold: false, sizePt: 9, color: '#1a1a1f', align: 'right', lineHeightPt: 12 },
    } as LayoutField;
  }

  const pageCount = layout?.pageCount ?? 0;

  return (
    <section aria-label="Invoice page" className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
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
        <Button size="sm" variant="outline" onClick={() => void undo()} disabled={busy || undoStack.length === 0} aria-keyshortcuts="Control+Z Meta+Z">
          Undo
        </Button>
        <Button size="sm" variant="outline" onClick={() => void redo()} disabled={busy || redoStack.length === 0} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y">
          Redo
        </Button>
        <span className="text-muted-foreground">
          {page.error ? '' : page.pending ? 'Updating the page…' : pageCount > 0 ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : ''}
        </span>
        {page.error ? (
          <span role="alert" className="flex items-center gap-2 text-red-800">
            {page.error}
            <Button size="sm" variant="outline" onClick={page.reload}>
              Try again
            </Button>
          </span>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Click any text you can change and type. Amounts, tax and totals are calculated for you. The logo, the sender and the small print come
        from the template.
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="overflow-auto rounded-lg bg-muted/40 p-6">
        <PdfCanvas
          pdf={page.drawn?.bytes ?? null}
          counter={page.drawn?.counter ?? null}
          layout={layout}
          zoom={zoom}
          dimmed={false}
          selectedId={null}
          labelOf={() => ''}
          isMovable={() => false}
          onSelect={() => {}}
          onDrop={() => {}}
          onColumnResize={() => {}}
          onDrawn={() => {}}
          onError={() => {}}
          overlay={overlay}
        />
      </div>
      <section aria-label="Totals" className="sr-only">
        <p>
          Total {money(doc.total, doc.currencyCode)}, net {money(doc.subtotal, doc.currencyCode)}, tax {money(doc.taxAmount, doc.currencyCode)}.
        </p>
      </section>
    </section>
  );
}

function InlineEditor({
  editor,
  scale,
  fontFamily,
  customers,
  label,
  onType,
  onCommit,
  onCancel,
}: {
  editor: ActiveEditor;
  scale: number;
  fontFamily: string;
  customers: CustomerView[];
  label: string;
  onType: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { field, rect, value, error } = editor;
  const s = field.style;
  const errorId = `edit-error-${field.id}`;
  const box: React.CSSProperties = {
    position: 'absolute',
    left: rect.x * scale - 2,
    top: rect.y * scale - 1,
    width: Math.max(rect.width * scale + 4, 60),
    minHeight: Math.max(rect.height, s.lineHeightPt) * scale + 2,
  };
  const text: React.CSSProperties = {
    fontFamily: `${fontFamily}, system-ui, sans-serif`,
    fontWeight: s.bold ? 700 : 400,
    fontSize: s.sizePt * scale,
    lineHeight: `${s.lineHeightPt * scale}px`,
    color: s.color,
    textAlign: s.align,
  };
  const common = {
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    autoFocus: true,
    onBlur: onCommit,
  };
  const keys = (e: React.KeyboardEvent, multiline: boolean) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onCommit();
    }
  };
  const cls = 'w-full bg-white p-0 outline-2 outline-blue-600 ring-0 border-0';
  let control: React.ReactNode;
  if (field.documentField === 'customerId') {
    control = (
      <select {...common} className={`${cls} text-sm`} value={value} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => keys(e, false)}>
        <option value="">Choose a customer…</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.contact?.name ?? c.contactId}
          </option>
        ))}
      </select>
    );
  } else if (field.documentField === 'taxClass') {
    control = (
      <select {...common} className={`${cls} text-sm`} value={value} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => keys(e, false)}>
        {TAX_CLASS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.documentField === 'serviceDate') {
    control = <input {...common} type="date" className={`${cls} text-sm`} value={value} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => keys(e, false)} />;
  } else if (field.documentField === 'servicePeriod') {
    const [start = '', end = ''] = value.split('/');
    control = (
      <span className="flex gap-1 bg-white p-1 shadow" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && onCommit()}>
        <input aria-label={`${label}, first day`} type="date" autoFocus className="text-sm" value={start} onChange={(e) => onType(`${e.target.value}/${end}`)} onKeyDown={(e) => keys(e, false)} />
        <input aria-label={`${label}, last day`} type="date" className="text-sm" value={end} onChange={(e) => onType(`${start}/${e.target.value}`)} onKeyDown={(e) => keys(e, false)} />
      </span>
    );
  } else if (field.kind === 'multiline') {
    control = (
      <textarea
        {...common}
        className={cls}
        style={{ ...text, resize: 'none', minHeight: Math.max(rect.height, s.lineHeightPt * 2) * scale }}
        value={value}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={(e) => keys(e, true)}
      />
    );
  } else {
    control = (
      <input
        {...common}
        inputMode={field.kind === 'number' || field.kind === 'money' ? 'decimal' : undefined}
        className={cls}
        style={text}
        value={value}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={(e) => keys(e, false)}
      />
    );
  }
  return (
    <div style={box} className="z-20">
      {control}
      {field.kind === 'multiline' ? <span className="mt-0.5 block text-[10px] text-gray-600">Ctrl+Enter or Cmd+Enter saves, Escape leaves it as it was.</span> : null}
      {error ? (
        <span id={errorId} role="alert" className="mt-0.5 block rounded bg-red-50 px-1 text-xs text-red-800">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function NewLineRow({
  rect,
  scale,
  columns,
  value,
  fontFamily,
  onChange,
  onSave,
  onCancel,
}: {
  rect: FieldRect;
  scale: number;
  columns: Partial<Record<string, { x: number; width: number }>>;
  value: { title: string; quantity: string; unit: string; price: string; error: string | null };
  fontFamily: string;
  onChange: (v: Partial<{ title: string; quantity: string; unit: string; price: string }>) => void;
  onSave: (again: boolean) => void;
  onCancel: () => void;
}) {
  const at = (col: string, fallbackX: number, fallbackW: number) => {
    const c = columns[col];
    return { left: (c?.x ?? fallbackX) * scale, width: Math.max((c?.width ?? fallbackW) * scale - 4, 40) };
  };
  const input = 'absolute h-6 rounded-sm border border-blue-500 bg-white px-1 text-xs';
  const style = { fontFamily: `${fontFamily}, system-ui, sans-serif` };
  const keys = (e: React.KeyboardEvent, last: boolean) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSave(last);
    }
  };
  const top = rect.y * scale;
  return (
    <div role="group" aria-label="New line" className="absolute inset-x-0 z-20" style={{ top, height: 0 }}>
      <input aria-label="New line, description" autoFocus className={input} style={{ ...style, ...at('title', rect.x, rect.width * 0.4), top: 0 }} value={value.title} onChange={(e) => onChange({ title: e.target.value })} onKeyDown={(e) => keys(e, false)} />
      <input aria-label="New line, quantity" inputMode="decimal" className={`${input} text-right`} style={{ ...style, ...at('quantity', rect.x + rect.width * 0.45, 50), top: 0 }} value={value.quantity} onChange={(e) => onChange({ quantity: e.target.value })} onKeyDown={(e) => keys(e, false)} />
      <input aria-label="New line, unit" className={input} style={{ ...style, ...at('unit', rect.x + rect.width * 0.55, 40), top: 0 }} value={value.unit} onChange={(e) => onChange({ unit: e.target.value })} onKeyDown={(e) => keys(e, false)} />
      <input aria-label="New line, unit price in euros" inputMode="decimal" className={`${input} text-right`} style={{ ...style, ...at('unitPrice', rect.x + rect.width * 0.65, 70), top: 0 }} value={value.price} onChange={(e) => onChange({ price: e.target.value })} onKeyDown={(e) => keys(e, true)} />
      <div className="absolute flex gap-2" style={{ left: rect.x * scale, top: 28 }}>
        <Button size="sm" onClick={() => onSave(false)}>
          Add the line
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="self-center text-[11px] text-gray-600">Enter in the price adds it and starts the next one.</span>
      </div>
      {value.error ? (
        <p role="alert" className="absolute rounded bg-red-50 px-1 text-xs text-red-800" style={{ left: rect.x * scale, top: 60 }}>
          {value.error}
        </p>
      ) : null}
    </div>
  );
}

function LineMenu({
  line,
  index,
  count,
  regular,
  onAction,
  onDiscount,
  onTax,
  onClose,
}: {
  line: LineView;
  index: number;
  count: number;
  regular: boolean;
  onAction: (a: 'up' | 'down' | 'duplicate' | 'remove') => void;
  onDiscount: () => void;
  onTax: (taxClass: 'standard' | 'reduced' | 'zero') => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const item = 'block w-full rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50';
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Line ${index + 1}`}
      className="absolute left-0 top-7 z-30 w-48 rounded-md border border-gray-500 bg-white p-1 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <button role="menuitem" type="button" className={item} disabled={index === 0} onClick={() => onAction('up')}>
        Move up
      </button>
      <button role="menuitem" type="button" className={item} disabled={index === count - 1} onClick={() => onAction('down')}>
        Move down
      </button>
      <button role="menuitem" type="button" className={item} onClick={() => onAction('duplicate')}>
        Duplicate
      </button>
      {line.kind !== 'text' ? (
        <button role="menuitem" type="button" className={item} onClick={onDiscount}>
          {line.discountBp > 0 ? 'Change the discount' : 'Add a discount'}
        </button>
      ) : null}
      {line.kind !== 'text' && regular
        ? TAX_CLASS_OPTIONS.map((o) => (
            <button
              key={o.value}
              role="menuitemradio"
              aria-checked={(line.taxClass ?? 'standard') === o.value}
              type="button"
              className={item}
              onClick={() => onTax(o.value)}
            >
              VAT {o.label}
            </button>
          ))
        : null}
      <button role="menuitem" type="button" className={`${item} text-red-800`} onClick={() => onAction('remove')}>
        Remove
      </button>
    </div>
  );
}

function ProductSearch({ onPick, onClose }: { onPick: (p: ProductView) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ProductView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      booksApi
        .products({ q: q.trim() || undefined })
        .then((page) => !cancelled && (setItems(page.items.filter((p) => !p.archivedAt)), setError(null)))
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div role="dialog" aria-label="Choose a product or service" className="absolute left-0 top-7 z-30 w-80 rounded-md border border-gray-500 bg-white p-2 shadow-lg">
      <label className="flex flex-col gap-1 text-xs font-medium text-gray-700">
        Search your products and services
        <input
          autoFocus
          className="rounded-md border border-gray-500 px-2 py-1 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && items && items[0]) onPick(items[0]);
          }}
        />
      </label>
      {error ? <p className="mt-2 text-xs text-red-800">{error}</p> : null}
      {items === null ? <p className="mt-2 text-xs text-muted-foreground">Loading…</p> : null}
      {items?.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing found. Products and services are kept in the Books’ Products tab.</p>
      ) : null}
      <ul className="mt-2 max-h-64 overflow-y-auto">
        {items?.map((p) => (
          <li key={p.id}>
            <button type="button" className="flex w-full justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => onPick(p)}>
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {money(p.unitPrice)} / {p.unitLabel}
                {p.priceBasis === 'gross' ? ' brutto' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
