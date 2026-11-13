// src/components/sidebars/left/FxSceneRows.tsx
//
// The rows an FX scene box lists under its own HTML children in the Layers panel
// (docs/plans/2026-11-13-fx-layers-in-layers-panel.md): a foldable "Scene" group, an
// "Effects" sub-group of post effects (the one applied last on top), the content layers
// front to back, and a "Background" pseudo-row.
//
// The rows are DERIVED from the box's stored scene (src/lib/layers/fxRows.ts), never site
// nodes: no row is a drag source or a drop target of the node tree, and none carries the
// attributes the drop resolver and the reveal-on-select scroll read (`data-inner-component-id`,
// `data-layer-row`). Picking a row keeps the box the primary selection and sets the editor's
// `selectedFxLayer`; the properties panel then shows that layer alone.
//
// Each row's name is a button (Enter and Space pick it); hide, delete and "More" are buttons
// beside it, the menu repeats them with rename, duplicate and move, and the picked row answers
// F2, Delete, Cmd+D, Alt+Up / Alt+Down and Escape through the editor's key handler
// (src/lib/canvas/deleteSelection.ts). Rows have no lock: a layer cannot be moved on the canvas.
'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Eye, EyeOff, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FX_PROP } from '@/lib/fxScene/marker';
import { toggleFold } from '@/lib/layers/foldState';
import { layerActionsWidth } from '@/lib/layers/sidebarWidth';
import { fxDropIndex, fxEffectsGroupKey, fxSceneGroupKey, refuseFxDrop, runFxLayerAction, type FxLayerRowModel, type FxRowsModel } from '@/lib/layers/fxRows';
import { FX_BACKGROUND_ICON, FX_EFFECTS_GROUP_ICON, FX_SCENE_GROUP_ICON, fxLayerIconOf } from '../layerIcon';
import { ContextMenu, type MenuCloseReason, type MenuItem } from './ContextMenu';

const TOUCH_SELECTED_REVEAL = '[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto';
const TOUCH_SELECTED_NAME_PAD = '[@media(hover:none)]:pr-[var(--layer-actions-w)] @max-[172px]:[@media(hover:none)]:pr-[26px]';
const actionButtonClass =
  'w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const stopPointer = (e: React.PointerEvent) => e.stopPropagation();
const ROW_HEIGHT = 'h-[28px]';

interface FxSceneRowsProps {
  box: ComponentInstance;
  rows: FxRowsModel;
  /** The depth of the Scene group: one below the box. */
  depth: number;
  breakpointId?: string;
  /** The box or an ancestor is hidden on the canvas: the rows are dimmed with it. */
  dimmed?: boolean;
}

/** The text of a group row (Scene, Effects): chevron, icon, label. Clicking it picks the box itself. */
const GroupRow = observer(
  ({ icon: Icon, label, depth, folded, onToggle, onSelect, selected }: { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; depth: number; folded: boolean; onToggle: () => void; onSelect: () => void; selected?: boolean }) => (
    <div
      className={`@container group flex ${ROW_HEIGHT} cursor-pointer items-center gap-1.5 rounded-[6px] px-1.5 hover:bg-accent ${selected ? 'bg-brand/10' : ''}`}
      style={{ paddingLeft: `${6 + depth * 14}px` }}
      onClick={onSelect}
    >
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={`${folded ? 'Expand' : 'Collapse'} ${label}`}
        onPointerDown={stopPointer}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex h-[13px] w-[13px] flex-none items-center justify-center text-muted-foreground hover:text-foreground"
      >
        {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <Icon size={14} className="flex-none text-muted-foreground" />
      <span className="flex-1 truncate text-muted-foreground" style={{ fontSize: '12px', fontWeight: 600 }}>
        {label}
      </span>
    </div>
  ),
);

/**
 * The row being dragged, shared by every row of every box (a drag is one gesture at a time). A row
 * accepts a drop only from the same group of the same box: a layer never leaves its group by
 * dragging, as it never does by the keys or the menu. These rows use the browser's own drag and
 * drop (a layer is not a node, so the node tree's pointer drag never sees them).
 */
let dragging: { boxId: string; layerId: string; name: string; groupKey: string; groupLabel: string } | null = null;
const DRAG_TYPE = 'application/x-fx-layer';

/** One layer of the scene. `order` is the ids of its group as listed (front first), `groupKey` names the group. */
const FxLayerRow = observer(({ box, row, depth, breakpointId, dimmed, order, groupKey, groupLabel }: { box: ComponentInstance; row: FxLayerRowModel; depth: number; breakpointId?: string; dimmed?: boolean; order: readonly string[]; groupKey: string; groupLabel: string }) => {
  const { editorUI } = useStore();
  const pick = editorUI.fxLayerPick;
  // Highlighted in the frame whose box is selected, as node rows are.
  const picked =
    pick?.kind === 'layer' && pick.componentId === box.id && pick.layerId === row.layerId && (!breakpointId || editorUI.selectedViewportNode?.breakpointId === breakpointId);
  const renaming = editorUI.fxLayerRenaming;
  const isRenaming = picked && !!renaming && renaming.componentId === box.id && renaming.layerId === row.layerId;
  const Icon = fxLayerIconOf(row.type, row.group);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback((reason: MenuCloseReason) => {
    setMenu(null);
    if (reason !== 'outside') moreRef.current?.focus();
  }, []);
  const dim = dimmed || !row.visible;
  const act = (action: Parameters<typeof runFxLayerAction>[3]) => runFxLayerAction(box, editorUI, row.layerId, action);
  const choose = () => editorUI.pickFxLayer(box, { kind: 'layer', layerId: row.layerId }, breakpointId);
  const rename = () => {
    choose();
    editorUI.startFxLayerRename(box.id, row.layerId);
  };
  // Drag to reorder inside the group: where the dragged row would land, shown as a line above or below this row.
  const [dropPlace, setDropPlace] = useState<'above' | 'below' | 'refused' | null>(null);
  // Our own drag over a row of this box (a file or text dragged over a row is not one): a row of another group is shown as refused, and says why when dropped.
  const ours = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(DRAG_TYPE) && !!dragging && dragging.boxId === box.id && dragging.layerId !== row.layerId;
  const canDrop = (e: React.DragEvent) => ours(e) && dragging!.groupKey === groupKey;
  const placeOf = (e: React.DragEvent): 'above' | 'below' => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
  };

  const items: MenuItem[] = [
    { label: row.visible ? 'Hide in the scene' : 'Show in the scene', icon: row.visible ? <EyeOff size={14} /> : <Eye size={14} />, onClick: () => act({ type: 'toggle' }) },
    { label: 'Rename', icon: <Pencil size={14} />, onClick: rename },
    { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => act({ type: 'duplicate' }) },
    { label: 'Bring forward', icon: <ArrowUp size={14} />, onClick: () => act({ type: 'move', delta: 1 }) },
    { label: 'Send backward', icon: <ArrowDown size={14} />, onClick: () => act({ type: 'move', delta: -1 }) },
    { label: 'Delete layer', icon: <Trash2 size={14} />, onClick: () => act({ type: 'delete' }), destructive: true },
  ];

  return (
    <div>
      <div
        data-fx-layer-row={row.layerId}
        data-fx-layer-box={box.id}
        data-fx-layer-breakpoint={breakpointId}
        data-fx-layer-group={groupKey}
        data-fx-drop={dropPlace ?? undefined}
        draggable={!isRenaming}
        onDragStart={(e) => {
          dragging = { boxId: box.id, layerId: row.layerId, name: row.name, groupKey, groupLabel };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(DRAG_TYPE, row.layerId);
        }}
        onDragEnd={() => {
          dragging = null;
          setDropPlace(null);
        }}
        onDragOver={(e) => {
          if (!ours(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDropPlace(canDrop(e) ? placeOf(e) : 'refused');
        }}
        onDragLeave={() => setDropPlace(null)}
        onDrop={(e) => {
          if (!ours(e) || !dragging) return;
          e.preventDefault();
          if (!canDrop(e)) {
            const gone = dragging;
            dragging = null;
            setDropPlace(null);
            refuseFxDrop(box, editorUI, gone.name, gone.groupLabel, groupLabel);
            return;
          }
          const place = placeOf(e);
          const from = dragging.layerId;
          dragging = null;
          setDropPlace(null);
          const toIndex = fxDropIndex(order, from, row.layerId, place);
          if (toIndex !== null) runFxLayerAction(box, editorUI, from, { type: 'moveTo', toIndex, relativeTo: `${place === 'above' ? 'in front of' : 'behind'} ${row.name}` });
        }}
        className={`@container group relative flex ${ROW_HEIGHT} items-center gap-1.5 rounded-[6px] px-1.5 hover:bg-accent ${picked ? 'bg-brand/10' : ''} ${dropPlace === 'above' ? 'shadow-[inset_0_2px_0_0_var(--brand,currentColor)]' : ''} ${dropPlace === 'below' ? 'shadow-[inset_0_-2px_0_0_var(--brand,currentColor)]' : ''} ${dropPlace === 'refused' ? 'shadow-[inset_0_0_0_1px_var(--destructive,red)]' : ''}`}
        style={{ paddingLeft: `${6 + depth * 14}px`, ['--layer-actions-w' as string]: `${layerActionsWidth(3)}px` }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="flex flex-none justify-center text-border" style={{ width: '14px', fontSize: '12px' }} aria-hidden="true">
          │
        </span>
        <Icon size={14} className={`flex-none ${picked ? 'text-brand' : 'text-muted-foreground'} ${dim ? 'opacity-50' : ''}`} />
        {row.swatch ? <span data-fx-swatch={row.swatch} className={`inline-block h-2.5 w-2.5 flex-none rounded-[3px] border border-border ${dim ? 'opacity-50' : ''}`} style={{ background: row.swatch }} aria-hidden="true" /> : null}

        {isRenaming ? (
          <RenameField initial={row.name} onCommit={(name) => act({ type: 'rename', name })} onCancel={() => editorUI.endFxLayerRename()} />
        ) : (
          <button
            type="button"
            aria-label={row.ariaLabel}
            aria-current={picked ? 'true' : undefined}
            title={row.ariaLabel}
            onClick={choose}
            onDoubleClick={rename}
            className={`flex min-w-0 flex-1 items-baseline gap-1.5 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded-[4px] group-hover:pr-[var(--layer-actions-w)] group-focus-within:pr-[var(--layer-actions-w)] @max-[172px]:group-hover:pr-[26px] @max-[172px]:group-focus-within:pr-[26px] ${picked ? `text-brand ${TOUCH_SELECTED_NAME_PAD}` : 'text-foreground'} ${dim ? 'opacity-50' : ''}`}
            style={{ fontSize: '13px', fontWeight: picked ? 500 : 400 }}
          >
            <span className="max-w-[70%] flex-none truncate">{row.name}</span>
            <span className="min-w-0 truncate text-muted-foreground" style={{ fontSize: '10.5px' }}>
              {row.reads ? `reads ${row.reads}` : row.typeLabel}
            </span>
            {row.off ? (
              <span className="min-w-0 truncate text-amber-500" style={{ fontSize: '10.5px' }}>
                {row.off}
              </span>
            ) : null}
          </button>
        )}

        {!row.visible ? <EyeOff size={12} className="flex-none text-muted-foreground" aria-hidden="true" /> : null}

        <span
          className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-[5px] bg-accent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto ${picked ? TOUCH_SELECTED_REVEAL : ''}`}
        >
          <button
            type="button"
            className={actionButtonClass}
            title={row.visible ? 'Hide in the scene' : 'Show in the scene'}
            aria-label={`${row.visible ? 'Hide' : 'Show'} ${row.name} in the scene`}
            aria-pressed={!row.visible}
            onPointerDown={stopPointer}
            onClick={(e) => {
              e.stopPropagation();
              act({ type: 'toggle' });
            }}
          >
            {row.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button
            type="button"
            className={actionButtonClass}
            title="Delete layer"
            aria-label={`Delete ${row.name}`}
            onPointerDown={stopPointer}
            onClick={(e) => {
              e.stopPropagation();
              act({ type: 'delete' });
            }}
          >
            <Trash2 size={13} />
          </button>
          <button
            ref={moreRef}
            type="button"
            className={actionButtonClass}
            title="More layer actions"
            aria-label={`More actions for ${row.name}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onPointerDown={stopPointer}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </span>
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} /> : null}
    </div>
  );
});

/** The name of a layer while it is renamed: Enter and leaving the field store it, Escape keeps the old name. */
function RenameField({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Enter commits and unmounts the field, which blurs it: the second commit would repeat the change.
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && draft.trim() !== '' && draft !== initial) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      aria-label="Layer name"
      value={draft}
      maxLength={80}
      className="min-w-0 flex-1 rounded-[4px] border border-border bg-background px-1 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      onChange={(e) => setDraft(e.target.value)}
      onPointerDown={stopPointer}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

/** The scene's background colour as a row. It cannot be hidden, moved or deleted. */
const FxBackgroundRow = observer(({ box, color, depth, breakpointId, dimmed }: { box: ComponentInstance; color: string; depth: number; breakpointId?: string; dimmed?: boolean }) => {
  const { editorUI } = useStore();
  const pick = editorUI.fxLayerPick;
  const picked = pick?.kind === 'background' && pick.componentId === box.id && (!breakpointId || editorUI.selectedViewportNode?.breakpointId === breakpointId);
  const Icon = FX_BACKGROUND_ICON;
  return (
    <div
      data-fx-background-row={box.id}
      data-fx-layer-breakpoint={breakpointId}
      className={`@container group flex ${ROW_HEIGHT} items-center gap-1.5 rounded-[6px] px-1.5 hover:bg-accent ${picked ? 'bg-brand/10' : ''}`}
      style={{ paddingLeft: `${6 + depth * 14}px` }}
    >
      <span className="flex flex-none justify-center text-border" style={{ width: '14px', fontSize: '12px' }} aria-hidden="true">
        │
      </span>
      <Icon size={14} className={`flex-none ${picked ? 'text-brand' : 'text-muted-foreground'} ${dimmed ? 'opacity-50' : ''}`} />
      <button
        type="button"
        aria-label={`Background, ${color}`}
        aria-current={picked ? 'true' : undefined}
        onClick={() => editorUI.pickFxLayer(box, { kind: 'background' }, breakpointId)}
        className={`flex min-w-0 flex-1 items-baseline gap-1.5 truncate rounded-[4px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${picked ? 'text-brand' : 'text-foreground'} ${dimmed ? 'opacity-50' : ''}`}
        style={{ fontSize: '13px', fontWeight: picked ? 500 : 400 }}
      >
        <span className="flex-none truncate">Background</span>
        <span className="inline-block h-2.5 w-2.5 flex-none self-center rounded-[3px] border border-border" style={{ background: color }} title={color} aria-hidden="true" />
      </button>
    </div>
  );
});

/** What the last change from a row or a key said: read out politely, and shown when it was a refusal. */
const Notice = observer(({ box, breakpointId }: { box: ComponentInstance; breakpointId?: string }) => {
  const { editorUI } = useStore();
  const notice = editorUI.fxLayerNotice;
  const frame = editorUI.selectedViewportNode?.breakpointId;
  // Every breakpoint lists the same rows: one live region reads the message out, not one per frame.
  // With no frame selected, only the first breakpoint's list carries it.
  const first = editorUI.currentPage?.sortedViewportNodes[0]?.breakpointId;
  if (breakpointId && (frame ? frame !== breakpointId : first !== breakpointId)) return null;
  const current = JSON.stringify((box.props as Record<string, unknown>)[FX_PROP] ?? null);
  const said = notice && notice.componentId === box.id && notice.about === current ? notice : null;
  return (
    <div role="status" aria-live="polite" className={said?.problem ? 'px-3 py-1 text-[11px] leading-snug text-destructive' : 'sr-only'}>
      {said?.text ?? ''}
    </div>
  );
});

/** The Scene group of one box in one breakpoint's tree. */
export const FxSceneRows = observer(({ box, rows, depth, breakpointId, dimmed }: FxSceneRowsProps) => {
  const { editorUI } = useStore();
  const sceneKey = fxSceneGroupKey(box.id);
  const effectsKey = fxEffectsGroupKey(box.id);
  const collapsed = editorUI.collapsedLayerIds;
  const sceneFolded = collapsed.has(sceneKey);
  const effectsFolded = collapsed.has(effectsKey);
  const inner = depth + 1;
  const effectOrder = rows.effects.map((r) => r.layerId);
  const contentOrder = rows.content.map((r) => r.layerId);
  const selectBox = () => editorUI.selectComponent(box, breakpointId);
  const boxPickedAlone = editorUI.isSelected(box.id) && !editorUI.fxLayerPick && (!breakpointId || editorUI.selectedViewportNode?.breakpointId === breakpointId);

  return (
    <div data-fx-scene-rows={box.id}>
      <GroupRow
        icon={FX_SCENE_GROUP_ICON}
        label="Scene"
        depth={depth}
        folded={sceneFolded}
        selected={boxPickedAlone}
        onToggle={() => editorUI.setCollapsedLayerIds(toggleFold(collapsed, sceneKey))}
        onSelect={selectBox}
      />
      <Notice box={box} breakpointId={breakpointId} />
      {sceneFolded ? null : (
        <>
          {rows.effects.length > 0 ? (
            <>
              <GroupRow icon={FX_EFFECTS_GROUP_ICON} label="Effects" depth={inner} folded={effectsFolded} onToggle={() => editorUI.setCollapsedLayerIds(toggleFold(collapsed, effectsKey))} onSelect={selectBox} />
              {effectsFolded
                ? null
                : rows.effects.map((row) => (
                    <FxLayerRow key={row.layerId} box={box} row={row} depth={inner + 1} breakpointId={breakpointId} dimmed={dimmed} order={effectOrder} groupKey="effects" groupLabel="the scene's effects" />
                  ))}
            </>
          ) : null}
          {rows.content.map((row) => (
            <React.Fragment key={row.layerId}>
              <FxLayerRow box={box} row={row} depth={inner} breakpointId={breakpointId} dimmed={dimmed} order={contentOrder} groupKey="content" groupLabel="the layers that draw" />
              {/* Effects that apply to this layer only, nested under it (their own group: they move among themselves). */}
              {row.nested?.map((effect) => (
                <FxLayerRow
                  key={effect.layerId}
                  box={box}
                  row={effect}
                  depth={inner + 1}
                  breakpointId={breakpointId}
                  dimmed={dimmed}
                  order={row.nested!.map((n) => n.layerId)}
                  groupKey={`nested:${row.layerId}`}
                  groupLabel={`the effects of ${row.name}`}
                />
              ))}
            </React.Fragment>
          ))}
          <FxBackgroundRow box={box} color={rows.background} depth={inner} breakpointId={breakpointId} dimmed={dimmed} />
        </>
      )}
    </div>
  );
});

FxSceneRows.displayName = 'FxSceneRows';
