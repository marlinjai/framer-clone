'use client';
// BindingControl: the per-slot bind / unbind affordance rendered next to a prop
// control in the right sidebar's Data section.
//
//  - UNBOUND: renders the static control (passed as `children`) plus a link
//    icon that opens the BindingPicker popover.
//  - BOUND (read): renders a read-only chip showing the bound expression (e.g.
//    `{{row.title}}`) plus an unlink button.
//  - BROKEN (the bound `{{row.<col>}}` references a column that no longer exists
//    on the source collection): renders a `column not found` warning chip. There
//    is deliberately NO auto-migrate; the builder rebinds by hand.
//
// Commits reuse the EXISTING `node.setBinding` / `node.clearBinding` MST actions
// (already tagged MST-WRITE on the model); the calls are flagged here too.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Link2, Unlink, TriangleAlert } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindableSlotMeta, ReadBinding } from '@/lib/bindings/types';
import type { Column } from '@/lib/bindings/dataSource/types';
import { useDataSource } from '@/lib/bindings/dataSource/context';
import { parseExpression } from '@/lib/bindings/resolver/expression';
import { getAvailableScopeFrames } from '@/lib/bindings/scopeIntrospection';
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
  let broken = false;
  if (readBinding) {
    const parsed = parseExpression(readBinding.expression);
    if (parsed && parsed.path[0] === 'row' && parsed.path.length >= 2 && columns) {
      broken = !columns.some((c) => c.id === parsed.path[1]);
    }
  }

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
            className={`flex h-7 flex-1 items-center gap-1.5 rounded border px-2 text-xs ${
              broken
                ? 'border-amber-400 bg-amber-50 text-amber-700'
                : 'border-brand/20 bg-brand/10 text-brand'
            }`}
            title={readBinding.expression}
          >
            {broken && <TriangleAlert size={12} className="shrink-0" />}
            <span className="truncate font-mono">{readBinding.expression}</span>
            {broken && (
              <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] font-medium">
                column not found
              </span>
            )}
          </div>
        ) : (
          <div className="flex-1">{children}</div>
        )}

        {readBinding ? (
          <button
            type="button"
            aria-label={`Unbind ${meta.label}`}
            title="Unlink"
            onClick={handleUnlink}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
          >
            <Unlink size={13} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Bind ${meta.label}`}
            title="Bind to data"
            onClick={() => setPickerOpen((v) => !v)}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border text-gray-500 hover:bg-gray-50 ${
              pickerOpen ? 'border-brand text-brand' : 'border-gray-200'
            }`}
          >
            <Link2 size={13} />
          </button>
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
