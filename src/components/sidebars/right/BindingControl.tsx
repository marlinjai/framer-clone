'use client';
// BindingControl: the per-slot bind / unbind affordance rendered next to a prop
// control in the right sidebar's Data section.
//
//  - UNBOUND: renders the static control (passed as `children`) plus a link
//    icon that opens the BindingPicker popover.
//  - BOUND (read): renders a read-only chip showing the bound expression (e.g.
//    `{{row.title}}`) plus an unlink button.
//  - BROKEN (the bound `{{row.<col>}}` references a column that no longer exists
//    on the source collection, or `{{input.<id>}}` an input the component no
//    longer has): renders a warning chip. There is deliberately NO auto-migrate;
//    the builder rebinds by hand.
//  - INSIDE A DEFINITION, unbound: a "Make input" button beside the bind button
//    adds an input to the component with this value as its default and binds the
//    slot to it, as one step (ProjectModel.makeInput, src/lib/components/makeInput.ts).
//
// Commits reuse the EXISTING `node.setBinding` / `node.clearBinding` MST actions
// (already tagged MST-WRITE on the model); the calls are flagged here too.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Link2, Unlink, TriangleAlert, SquarePlus } from 'lucide-react';
import { getSnapshot } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindableSlotMeta, ReadBinding } from '@/lib/bindings/types';
import type { Column } from '@/lib/bindings/dataSource/types';
import { useDataSource } from '@/lib/bindings/dataSource/context';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { getAvailableScopeFrames } from '@/lib/bindings/scopeIntrospection';
import { useStore } from '@/hooks/useStore';
import { isPlacementType } from '@/lib/components/placement';
import { inputDraftFor } from '@/lib/components/makeInput';
import BindingPicker from './BindingPicker';

export interface BindingControlProps {
  node: ComponentInstance;
  slot: string;
  meta: BindableSlotMeta;
  /** The static (non-bound) control to show when the slot is unbound. */
  children?: React.ReactNode;
}

const BindingControl = observer(({ node, slot, meta, children }: BindingControlProps) => {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const dataSource = useDataSource();

  const binding = node.getBinding(slot);
  const readBinding = binding && binding.mode === 'read' ? (binding as ReadBinding) : null;

  // Resolve the source collection (if any) so we can validate `{{row.<col>}}`
  // bindings against the LIVE column set and surface broken ones.
  const frames = getAvailableScopeFrames(node);
  const rowCollectionId = frames.find((f) => f.kind === 'row')?.collectionId ?? null;
  const inputFrame = frames.find((f) => f.kind === 'input');
  const { editorUI } = useStore();
  const [columns, setColumns] = React.useState<Column[] | null>(null);

  React.useEffect(() => {
    if (!rowCollectionId) {
      setColumns(null);
      return;
    }
    let active = true;
    dataSource
      .getCollection(rowCollectionId)
      .then((collection) => {
        if (active) setColumns(collection ? collection.columns : []);
      })
      .catch(() => {
        if (active) setColumns([]);
      });
    return () => {
      active = false;
    };
  }, [dataSource, rowCollectionId]);

  // A binding is "broken" when it reads `{{row.<col>}}` and `<col>` is not a
  // column on the resolved source collection. We only flag once columns have
  // actually loaded, so loading never produces a false positive.
  let broken: string | null = null;
  if (readBinding) {
    const parsed = parseExpression(readBinding.expression);
    if (parsed && parsed.path[0] === 'row' && parsed.path.length >= 2 && columns) {
      if (!columns.some((c) => c.id === parsed.path[1])) broken = 'column not found';
    }
    if (parsed && parsed.path[0] === 'input' && inputFrame) {
      if (!inputFrame.inputs?.some((input) => input.id === parsed.path[1])) broken = 'input not found';
    }
  }

  // The inner input a nested placement's `input.<id>` slot sets, so the new outer input has its type.
  const innerInput = () => {
    if (!isPlacementType(node.type) || !slot.startsWith('input.')) return undefined;
    const inner = editorUI.currentProject?.components.get(String(node.props.component ?? ''));
    return inner?.inputs.find((input) => input.id === slot.slice('input.'.length));
  };
  const makeInput = () => {
    const project = editorUI.currentProject;
    const definitionId = inputFrame?.definitionId;
    if (!project || !definitionId) return;
    const props = (getSnapshot(node) as { props?: Record<string, unknown> }).props ?? {};
    const { input, expression } = inputDraftFor({ type: node.type, props, inner: innerInput() }, slot, meta.label, inputFrame?.inputs ?? []);
    const result = project.makeInput(definitionId, node.id, slot, input, expression);
    if (!result.ok) editorUI.setEditorNotice({ kind: 'refused', message: result.message });
  };

  const handleCommit = (b: ReadBinding) => {
    // MST-WRITE: reuses the existing setBinding action.
    node.setBinding(slot, b);
  };

  const handleUnlink = () => {
    // MST-WRITE: reuses the existing clearBinding action.
    node.clearBinding(slot);
  };

  return (
    <div className="relative space-y-1">
      <div className="flex items-center gap-1.5">
        {readBinding ? (
          <div
            className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border px-2 text-xs ${
              broken
                ? 'border-warning bg-warning/10 text-warning'
                : 'border-brand/20 bg-brand/10 text-brand'
            }`}
            title={readBinding.expression}
          >
            {broken && <TriangleAlert size={12} className="shrink-0" />}
            <span className="truncate font-mono">{readBinding.expression}</span>
            {broken && (
              <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] font-medium">
                {broken}
              </span>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">{children}</div>
        )}

        {readBinding ? (
          <button
            type="button"
            aria-label={`Unbind ${meta.label}`}
            title="Unlink"
            onClick={handleUnlink}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent"
          >
            <Unlink size={13} />
          </button>
        ) : (
          <>
          {inputFrame && (
            <button
              type="button"
              aria-label={`Make ${meta.label} an input`}
              title="Make input: each placement can set this"
              onClick={makeInput}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent"
            >
              <SquarePlus size={13} />
            </button>
          )}
          <button
            type="button"
            aria-label={`Bind ${meta.label}`}
            title="Bind to data"
            onClick={() => setPickerOpen((v) => !v)}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border text-muted-foreground hover:bg-accent ${
              pickerOpen ? 'border-brand text-brand' : 'border-border'
            }`}
          >
            <Link2 size={13} />
          </button>
          </>
        )}
      </div>

      {pickerOpen && !readBinding && (
        <div className="absolute right-0 top-8">
          <BindingPicker
            node={node}
            slot={slot}
            meta={meta}
            onCommit={handleCommit}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}
    </div>
  );
});

BindingControl.displayName = 'BindingControl';

export default BindingControl;
