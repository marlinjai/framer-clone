'use client';

// src/app/projects/books/composer/Inspector.tsx
//
// The composer's right panel (visual template composer plan, decision 11):
// the selected block's properties as a form, or the template's page and theme
// when nothing is selected. Every control writes through `update` (one Immer
// recipe per change, so each is one undo step; typing in one field is
// coalesced by its key into one step). The values offered are exactly the
// schema's bounded scales (template/schema.ts); the one way to leave the
// schema is a text emptied while retyping it, which the composer marks and
// keeps out of the preview and the save until it is filled. The gate's rules (legal items and
// columns that cannot be hidden, required sender columns) are shown as locked
// controls with the reason, and its remaining problems are listed for the
// selected block.

import {
  AlignmentField,
  CheckboxField,
  RangeField,
  SelectField,
  TextField,
} from '@marlinjai/block-editor-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import type { TemplateProblemView } from '@/lib/books/api';
import { LEGAL_COLUMNS, LEGAL_META_ITEMS, SINGLETONS } from '@/server/books/template/rules';
import { META_ITEMS, SENDER_COLUMNS, SIZE_SCALE, SPACING_SCALE, TABLE_COLUMNS, templateDocumentV2Schema } from '@/server/books/template/schema';

import {
  BLOCK_INFO,
  CELL_TYPES,
  COLUMN_LABELS,
  META_LABELS,
  REGION_LABELS,
  SENDER_COLUMN_LABELS,
  addCellBlock,
  allowedIn,
  hasType,
  isRequired,
  locate,
  requiredReason,
  type Block,
  type BlockType,
  type CellBlock,
  type RegionName,
  type TemplateDocumentV2,
} from './doc';
import { problemText } from './problems';

/** One change to the document: an Immer recipe, with a key that merges quick typing in one field into one undo step. */
export type Update = (recipe: (draft: TemplateDocumentV2) => void, coalesceKey?: string) => void;

const FONT_LABELS: Record<string, string> = {
  'dejavu-sans': 'DejaVu Sans',
  'noto-sans': 'Noto Sans',
  'noto-serif': 'Noto Serif',
};

/** The font families the schema accepts (phase 5 widens the list; the select follows it). */
const FONT_FAMILIES: readonly string[] = templateDocumentV2Schema.shape.theme.shape.fontFamily.options;

const ALIGNABLE = new Set<BlockType>(['logo', 'senderLine', 'recipient', 'title', 'subject', 'introText', 'outroText', 'taxNote', 'paymentDetails', 'freeText']);
const UNTEXTED = new Set<BlockType>(['logo', 'spacer', 'divider', 'columns']);

const sizeOptions = [{ value: '', label: 'Default' }, ...SIZE_SCALE.map((s) => ({ value: String(s), label: `${String(s).replace('.', ',')} pt` }))];
const spacingOptions = SPACING_SCALE.map((s) => ({ value: String(s), label: `${s} pt` }));
const colorOptions = [
  { value: '', label: 'Default' },
  { value: 'ink', label: 'Text colour' },
  { value: 'accent', label: 'Accent colour' },
  { value: 'muted', label: 'Muted colour' },
];

export interface InspectorProps {
  doc: TemplateDocumentV2;
  selectedId: string | null;
  update: Update;
  /** The current problems (the preview's structural check, or the refused save's). */
  problems: TemplateProblemView[];
  onSelect: (blockId: string | null) => void;
  onRemove: (blockId: string) => void;
  /** Move the selected block one step (the same as Alt+Up and Alt+Down; the way to reorder without dragging). */
  onStep: (delta: -1 | 1) => void;
  /** The logo picker (phase 5): renders the upload and preview for a logo block. */
  renderLogoPicker?: (block: Extract<Block, { type: 'logo' }> | Extract<CellBlock, { type: 'logo' }>, update: Update) => React.ReactNode;
}

export default function Inspector({ doc, selectedId, update, problems, onSelect, onRemove, onStep, renderLogoPicker }: InspectorProps) {
  const at = selectedId ? locate(doc, selectedId) : null;
  if (!at) return <PageSettings doc={doc} update={update} />;
  const block = at.cell ? at.cell.block : at.block;
  const required = !at.cell && isRequired(block.type, at.region);
  const own = problems.filter((p) => p.blockId === block.id);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold" id="inspector-title">
          {BLOCK_INFO[block.type].label}
        </h2>
        <p className="text-xs text-muted-foreground">
          {at.cell ? `In a columns row, ${REGION_LABELS[at.region].toLowerCase()}` : REGION_LABELS[at.region]}. {BLOCK_INFO[block.type].description}
        </p>
        {required ? <p className="mt-1 text-xs text-muted-foreground">{requiredReason(block.type)}</p> : null}
      </div>

      {own.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {own.map((p, i) => (
            <li key={i}>{problemText(p)}</li>
          ))}
        </ul>
      ) : null}

      <BlockFields block={block} doc={doc} update={update} onSelect={onSelect} renderLogoPicker={renderLogoPicker} />

      {UNTEXTED.has(block.type) ? null : <TextStyle block={block} update={update} />}
      {ALIGNABLE.has(block.type) ? (
        <AlignmentField
          label="Alignment"
          value={block.style.align ?? 'left'}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
          onChange={(v) => update((d) => void (findBlock(d, block.id)!.style.align = v as 'left' | 'center' | 'right'))}
        />
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Space above"
          value={String(block.style.spaceAbovePt ?? 0)}
          options={spacingOptions}
          onChange={(v) => update((d) => void (findBlock(d, block.id)!.style.spaceAbovePt = Number(v) as (typeof SPACING_SCALE)[number]))}
        />
        <SelectField
          label="Space below"
          value={String(block.style.spaceBelowPt ?? 0)}
          options={spacingOptions}
          onChange={(v) => update((d) => void (findBlock(d, block.id)!.style.spaceBelowPt = Number(v) as (typeof SPACING_SCALE)[number]))}
        />
      </div>

      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button size="sm" variant="outline" onClick={() => onStep(-1)} aria-keyshortcuts="Alt+ArrowUp">
          Move up
        </Button>
        <Button size="sm" variant="outline" onClick={() => onStep(1)} aria-keyshortcuts="Alt+ArrowDown">
          Move down
        </Button>
        {required ? null : (
          <Button size="sm" variant="outline" onClick={() => onRemove(block.id)}>
            Remove block
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
          Page and theme
        </Button>
      </div>
    </div>
  );
}

/** The block with this id in a draft (top level or in a cell). */
function findBlock(d: TemplateDocumentV2, id: string): Block | CellBlock | null {
  const at = locate(d, id);
  return at ? (at.cell ? at.cell.block : at.block) : null;
}

/** Typed access to a block of one type in a draft. */
function blockOf<T extends BlockType>(d: TemplateDocumentV2, id: string, type: T): Extract<Block | CellBlock, { type: T }> | null {
  const b = findBlock(d, id);
  return b && b.type === type ? (b as Extract<Block | CellBlock, { type: T }>) : null;
}

function TextStyle({ block, update }: { block: Block | CellBlock; update: Update }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <SelectField
        label="Text size"
        value={block.style.sizePt === undefined ? '' : String(block.style.sizePt)}
        options={sizeOptions}
        onChange={(v) =>
          update((d) => {
            const b = findBlock(d, block.id)!;
            if (v === '') delete b.style.sizePt;
            else b.style.sizePt = Number(v) as (typeof SIZE_SCALE)[number];
          })
        }
      />
      <SelectField
        label="Colour"
        value={block.style.color ?? ''}
        options={colorOptions}
        onChange={(v) =>
          update((d) => {
            const b = findBlock(d, block.id)!;
            if (v === '') delete b.style.color;
            else b.style.color = v as 'ink' | 'accent' | 'muted';
          })
        }
      />
      <div className="col-span-2">
        <CheckboxField
          label="Bold"
          checked={block.style.bold ?? false}
          onChange={() => update((d) => void (findBlock(d, block.id)!.style.bold = !(block.style.bold ?? false)))}
        />
      </div>
    </div>
  );
}

function moveItem<T>(list: T[], index: number, delta: number): void {
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(to, 0, item);
}

/** An ordered list of items with show/hide checkboxes and up/down buttons (document data, sender columns). */
function OrderedItems<K extends string>(props: {
  legend: string;
  all: readonly K[];
  shown: readonly K[];
  labels: Record<K, string>;
  locked: readonly K[];
  lockedHint: string;
  onToggle: (item: K) => void;
  onMove: (index: number, delta: -1 | 1) => void;
}) {
  const { legend, all, shown, labels, locked, lockedHint, onToggle, onMove } = props;
  const hidden = all.filter((k) => !shown.includes(k));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs font-medium text-gray-600">{legend}</legend>
      {shown.map((item, i) => (
        <div key={item} className="flex items-center justify-between gap-2">
          <CheckboxField
            label={labels[item]}
            checked
            disabled={locked.includes(item)}
            hint={locked.includes(item) ? lockedHint : undefined}
            onChange={() => onToggle(item)}
          />
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" aria-label={`Move ${labels[item]} up`} disabled={i === 0} onClick={() => onMove(i, -1)}>
              ↑
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Move ${labels[item]} down`} disabled={i === shown.length - 1} onClick={() => onMove(i, 1)}>
              ↓
            </Button>
          </span>
        </div>
      ))}
      {hidden.map((item) => (
        <CheckboxField key={item} label={labels[item]} checked={false} onChange={() => onToggle(item)} />
      ))}
    </fieldset>
  );
}

function BlockFields({
  block,
  doc,
  update,
  onSelect,
  renderLogoPicker,
}: {
  block: Block | CellBlock;
  doc: TemplateDocumentV2;
  update: Update;
  onSelect: (id: string | null) => void;
  renderLogoPicker?: InspectorProps['renderLogoPicker'];
}) {
  const id = block.id;
  switch (block.type) {
    case 'logo':
      return (
        <div className="flex flex-col gap-3">
          {renderLogoPicker ? renderLogoPicker(block, update) : null}
          <RangeField
            label="Width"
            unit=" mm"
            min={15}
            max={80}
            value={block.widthMm}
            onChange={(v) => update((d) => void (blockOf(d, id, 'logo')!.widthMm = Math.round(v)), `${id}.widthMm`)}
          />
        </div>
      );
    case 'documentMeta':
      return (
        <OrderedItems
          legend="Items, in print order"
          all={META_ITEMS}
          shown={block.items}
          labels={META_LABELS}
          locked={LEGAL_META_ITEMS}
          lockedHint="Required by law; printed only when the document has it."
          onToggle={(item) =>
            update((d) => {
              const b = blockOf(d, id, 'documentMeta')!;
              const i = b.items.indexOf(item);
              if (i >= 0) {
                if (b.items.length > 1) b.items.splice(i, 1);
              } else b.items.push(item);
            })
          }
          onMove={(i, delta) => update((d) => moveItem(blockOf(d, id, 'documentMeta')!.items, i, delta))}
        />
      );
    case 'lineTable':
      return (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-gray-600">Columns</legend>
            <p className="text-xs text-muted-foreground">
              Widths in hundredths of the text width; Auto is the narrowest width that prints the largest value. The description takes the rest.
              You can also drag the column borders in the preview.
            </p>
            {TABLE_COLUMNS.map((col) => {
              const c = block.columns[col];
              const legal = LEGAL_COLUMNS.includes(col);
              return (
                <div key={col} className="grid grid-cols-[1fr_7rem] items-end gap-2">
                  <CheckboxField
                    label={COLUMN_LABELS[col]}
                    checked={c.visible}
                    disabled={legal}
                    hint={legal ? 'Required by law.' : col === 'rate' ? 'Hidden automatically for small businesses.' : undefined}
                    onChange={() => update((d) => void (blockOf(d, id, 'lineTable')!.columns[col].visible = !c.visible))}
                  />
                  {col === 'title' ? (
                    <span className="pb-2 text-xs text-muted-foreground">The rest</span>
                  ) : (
                    <WidthInput
                      label={`${COLUMN_LABELS[col]} width`}
                      value={c.width}
                      onChange={(w) => update((d) => void (blockOf(d, id, 'lineTable')!.columns[col].width = w), `${id}.${col}.width`)}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
          <CheckboxField
            label="Accent band behind the header row"
            checked={block.headerBand}
            onChange={() => update((d) => void (blockOf(d, id, 'lineTable')!.headerBand = !block.headerBand))}
          />
        </div>
      );
    case 'paymentDetails':
      return (
        <TextField
          label="Heading (optional)"
          value={block.heading ?? ''}
          placeholder="Zahlung"
          onChange={(v) => update((d) => void (blockOf(d, id, 'paymentDetails')!.heading = v.trim() === '' ? null : v.slice(0, 60)), `${id}.heading`)}
        />
      );
    case 'paymentQr':
      return (
        <div className="flex flex-col gap-3">
          <TextArea
            label="Caption"
            value={block.caption}
            maxLength={140}
            onChange={(v) => update((d) => void (blockOf(d, id, 'paymentQr')!.caption = v), `${id}.caption`)}
          />
          <RangeField
            label="Size"
            unit=" mm"
            min={25}
            max={40}
            value={block.sizeMm}
            onChange={(v) => update((d) => void (blockOf(d, id, 'paymentQr')!.sizeMm = Math.round(v)), `${id}.sizeMm`)}
          />
          <p className="text-xs text-muted-foreground">
            Printed only on issued invoices in euros with an IBAN in the sender details. Drafts show a grey placeholder; the sample preview shows a
            code with test data.
          </p>
        </div>
      );
    case 'senderColumns':
      return (
        <div className="flex flex-col gap-3">
          <OrderedItems
            legend="Columns, in print order"
            all={SENDER_COLUMNS}
            shown={block.columns}
            labels={SENDER_COLUMN_LABELS}
            locked={['identity', 'legal']}
            lockedHint="Required: the sender’s name, address and tax number."
            onToggle={(col) =>
              update((d) => {
                const b = blockOf(d, id, 'senderColumns')!;
                const i = b.columns.indexOf(col);
                if (i >= 0) {
                  if (b.columns.length > 1) b.columns.splice(i, 1);
                } else b.columns.push(col);
              })
            }
            onMove={(i, delta) => update((d) => moveItem(blockOf(d, id, 'senderColumns')!.columns, i, delta))}
          />
          <SelectField
            label="Layout"
            value={block.layout}
            options={[
              { value: 'columns', label: 'Side by side' },
              { value: 'line', label: 'One line, separated by dots' },
            ]}
            onChange={(v) => update((d) => void (blockOf(d, id, 'senderColumns')!.layout = v as 'columns' | 'line'))}
          />
        </div>
      );
    case 'freeText':
      return (
        <div className="flex flex-col gap-3">
          <TextField
            label="Heading (optional)"
            value={block.heading ?? ''}
            onChange={(v) => update((d) => void (blockOf(d, id, 'freeText')!.heading = v.trim() === '' ? null : v.slice(0, 60)), `${id}.heading`)}
          />
          <TextArea
            label="Text"
            value={block.text}
            maxLength={2000}
            required
            onChange={(v) => update((d) => void (blockOf(d, id, 'freeText')!.text = v), `${id}.text`)}
          />
          <SelectField
            label="Kind"
            value={block.variant}
            options={[
              { value: 'normal', label: 'Normal text' },
              { value: 'smallPrint', label: 'Small print (small and muted by default)' },
            ]}
            onChange={(v) => update((d) => void (blockOf(d, id, 'freeText')!.variant = v as 'normal' | 'smallPrint'))}
          />
        </div>
      );
    case 'spacer':
      return (
        <SelectField
          label="Height"
          value={String(block.heightPt)}
          options={spacingOptions}
          onChange={(v) => update((d) => void (blockOf(d, id, 'spacer')!.heightPt = Number(v) as (typeof SPACING_SCALE)[number]))}
        />
      );
    case 'divider':
      return (
        <div className="flex flex-col gap-3">
          <RangeField
            label="Thickness"
            unit=" pt"
            min={0.3}
            max={1.5}
            step={0.1}
            value={block.thicknessPt}
            onChange={(v) => update((d) => void (blockOf(d, id, 'divider')!.thicknessPt = Math.round(v * 10) / 10), `${id}.thicknessPt`)}
          />
          <SelectField
            label="Line colour"
            value={block.lineColor}
            options={colorOptions.slice(1)}
            onChange={(v) => update((d) => void (blockOf(d, id, 'divider')!.lineColor = v as 'ink' | 'accent' | 'muted'))}
          />
        </div>
      );
    case 'columns':
      return <ColumnsFields block={block} doc={doc} update={update} onSelect={onSelect} />;
    case 'title':
      return <p className="text-xs text-muted-foreground">The text comes from the document: “Rechnung” or “Gutschrift” with the cancelled invoice.</p>;
    default:
      return <p className="text-xs text-muted-foreground">Its content comes from the document; style it below.</p>;
  }
}

/** A number of hundredths of the text width; 0 shows as Auto (the column's minimum). */
function WidthInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const inputId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={inputId}
          type="number"
          min={0}
          max={100}
          step={1}
          value={value === 0 ? '' : value}
          placeholder="Auto"
          className="w-16 rounded-md border border-gray-500 px-2 py-1 text-sm"
          onChange={(e) => {
            const n = e.target.value === '' ? 0 : Math.round(Number(e.target.value));
            if (Number.isFinite(n)) onChange(Math.max(0, Math.min(100, n)));
          }}
        />
        {value !== 0 ? (
          <button type="button" className="text-xs underline" onClick={() => onChange(0)}>
            Auto
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TextArea({ label, value, maxLength, required, onChange }: { label: string; value: string; maxLength: number; required?: boolean; onChange: (v: string) => void }) {
  const inputId = React.useId();
  const hintId = `${inputId}-hint`;
  const empty = required && value.trim() === '';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-gray-600">
        {label}
      </label>
      <textarea
        id={inputId}
        value={value}
        maxLength={maxLength}
        rows={4}
        aria-invalid={empty || undefined}
        aria-describedby={hintId}
        className="rounded-md border border-gray-500 px-2 py-1 text-sm"
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={hintId} className={`text-xs ${empty ? 'text-red-700' : 'text-muted-foreground'}`}>
        {empty ? 'Enter a text, or remove the block.' : `${value.length} of ${maxLength} characters`}
      </span>
    </div>
  );
}

function ColumnsFields({ block, doc, update, onSelect }: { block: Extract<Block, { type: 'columns' }>; doc: TemplateDocumentV2; update: Update; onSelect: (id: string | null) => void }) {
  const id = block.id;
  const total = block.cells.reduce((s, c) => s + c.width, 0);
  const at = locate(doc, id);
  return (
    <div className="flex flex-col gap-3">
      <p className={`text-xs ${total > 12 ? 'text-red-700' : 'text-muted-foreground'}`}>
        Cell widths in twelfths of the text width: {total} of 12 used.
      </p>
      {block.cells.map((cell, ci) => (
        <fieldset key={ci} className="flex flex-col gap-2 rounded-md border p-2">
          <legend className="px-1 text-xs font-medium text-gray-600">Cell {ci + 1}</legend>
          <SelectField
            label="Width"
            value={String(cell.width)}
            options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} of 12` }))}
            onChange={(v) => update((d) => void (blockOf(d, id, 'columns')!.cells[ci].width = Number(v)))}
          />
          {cell.blocks.length === 0 ? <p className="text-xs text-muted-foreground">Empty.</p> : null}
          <ul className="flex flex-col gap-1">
            {cell.blocks.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 text-sm">
                <button type="button" className="underline" onClick={() => onSelect(b.id)}>
                  {BLOCK_INFO[b.type].label}
                </button>
              </li>
            ))}
          </ul>
          {cell.blocks.length < 6 ? (
            <AddToCell
              doc={doc}
              region={at?.region ?? 'body'}
              onAdd={(type) => {
                let added: string | null = null;
                update((d) => {
                  added = addCellBlock(d, id, ci, type);
                });
                if (added) onSelect(added);
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">A cell holds at most six blocks.</p>
          )}
          {block.cells.length > 2 ? (
            <Button size="sm" variant="ghost" onClick={() => update((d) => void blockOf(d, id, 'columns')!.cells.splice(ci, 1))}>
              Remove cell {ci + 1}
            </Button>
          ) : null}
        </fieldset>
      ))}
      {block.cells.length < 4 ? (
        total < 12 ? (
          <Button size="sm" variant="outline" onClick={() => update((d) => void blockOf(d, id, 'columns')!.cells.push({ width: 12 - total, blocks: [] }))}>
            Add a cell
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">To add a cell, make one of the cells narrower first: the row is full.</p>
        )
      ) : null}
    </div>
  );
}

/** The block types this row's cells may still take: allowed in the row's region, and a single block only once. */
function cellOptions(doc: TemplateDocumentV2, region: RegionName): CellBlock['type'][] {
  return CELL_TYPES.filter((t) => allowedIn(t, region) && !(SINGLETONS.has(t) && hasType(doc, t)));
}

function AddToCell({ doc, region, onAdd }: { doc: TemplateDocumentV2; region: RegionName; onAdd: (type: CellBlock['type']) => void }) {
  const options = cellOptions(doc, region);
  const [chosen, setChosen] = React.useState<CellBlock['type']>('freeText');
  const type = options.includes(chosen) ? chosen : options[0];
  if (!type) return <p className="text-xs text-muted-foreground">Nothing more can go into a cell here.</p>;
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <SelectField
          label="Add to this cell"
          value={type}
          options={options.map((t) => ({ value: t, label: BLOCK_INFO[t].label }))}
          onChange={(v) => setChosen(v as CellBlock['type'])}
        />
      </div>
      <Button size="sm" variant="outline" onClick={() => onAdd(type)} aria-label={`Add ${BLOCK_INFO[type].label} to this cell`}>
        Add
      </Button>
    </div>
  );
}

function PageSettings({ doc, update }: { doc: TemplateDocumentV2; update: Update }) {
  const m = doc.page.marginsMm;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold" id="inspector-title">
          Page and theme
        </h2>
        <p className="text-xs text-muted-foreground">Select a block in the preview or the outline to change it.</p>
      </div>
      <SelectField
        label="Address field position (DIN 5008)"
        value={doc.page.addressLayout}
        options={[
          { value: 'din5008-b', label: 'Form B: 45 mm from the top' },
          { value: 'din5008-a', label: 'Form A: 27 mm from the top' },
        ]}
        onChange={(v) => update((d) => void (d.page.addressLayout = v as 'din5008-a' | 'din5008-b'))}
      />
      <RangeField label="Left margin" unit=" mm" min={20} max={25} value={m.left} onChange={(v) => update((d) => void (d.page.marginsMm.left = Math.round(v)), 'page.left')} />
      <RangeField label="Right margin" unit=" mm" min={10} max={20} value={m.right} onChange={(v) => update((d) => void (d.page.marginsMm.right = Math.round(v)), 'page.right')} />
      <RangeField label="Bottom margin" unit=" mm" min={10} max={25} value={m.bottom} onChange={(v) => update((d) => void (d.page.marginsMm.bottom = Math.round(v)), 'page.bottom')} />
      <SelectField
        label="Page number"
        value={doc.page.pageNumber}
        options={[
          { value: 'right', label: 'Right, under the footer' },
          { value: 'center', label: 'Centred, under the footer' },
        ]}
        onChange={(v) => update((d) => void (d.page.pageNumber = v as 'right' | 'center'))}
      />
      <SelectField
        label="Font"
        value={doc.theme.fontFamily}
        options={FONT_FAMILIES.map((f) => ({ value: f, label: FONT_LABELS[f] ?? f }))}
        onChange={(v) => update((d) => void (d.theme.fontFamily = v as TemplateDocumentV2['theme']['fontFamily']))}
      />
      <SelectField
        label="Base text size"
        value={String(doc.theme.baseSizePt)}
        options={[8, 8.5, 9, 9.5, 10, 10.5, 11].map((s) => ({ value: String(s), label: `${String(s).replace('.', ',')} pt` }))}
        onChange={(v) => update((d) => void (d.theme.baseSizePt = Number(v)))}
      />
      {(['ink', 'accent', 'muted'] as const).map((name) => (
        <HexColorField
          key={name}
          label={name === 'ink' ? 'Text colour' : name === 'accent' ? 'Accent colour' : 'Muted colour (labels, small print)'}
          value={doc.theme[name]}
          onChange={(v) => update((d) => void (d.theme[name] = v), `theme.${name}`)}
        />
      ))}
    </div>
  );
}

/**
 * A theme colour: the native picker plus a text input. The schema takes
 * #rrggbb only, so what is typed is held here until it is a complete colour
 * (a half-typed value never reaches the document, and is not lost either).
 */
function HexColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const inputId = React.useId();
  const hintId = `${inputId}-hint`;
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(text);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-gray-600">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={`${label}, colour picker`}
          value={value}
          className="h-8 w-8 cursor-pointer rounded border border-gray-500"
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
        <input
          id={inputId}
          value={text}
          spellCheck={false}
          aria-invalid={!valid || undefined}
          aria-describedby={valid ? undefined : hintId}
          className="w-28 rounded-md border border-gray-500 px-2 py-1 font-mono text-sm"
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
          onBlur={() => setText(value)}
        />
      </div>
      {valid ? null : (
        <span id={hintId} className="text-xs text-red-700">
          A colour such as #1a2b3c. The template keeps {value} until then.
        </span>
      )}
    </div>
  );
}
