'use client';
// src/components/InlineFormatBar.tsx
//
// Bold, italic and link for the words selected while text is edited on the
// canvas. It is the same on a phone, where no shortcut key exists, only pinned
// under the top bar: the on-screen keyboard and the system's own selection menu
// take the space around the words there.
//
// The buttons never take focus (pointer and mouse down are cancelled), so a
// press does not blur the text, which would end the edit before the action ran.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { Bold, Italic, Link } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { useIsPhone } from '@/hooks/use-mobile';
import type { ComponentInstance } from '@/models/ComponentModel';
import { DATA_EDITOR_UI } from '@/lib/drag/markers';
import { measureVisibleArea } from '@/lib/quickbar/dom';
import { applyInlineFormat, editedElement, hasInlineFormat, ownerOfRun, type InlineFormat } from '@/lib/canvas/inlineFormat';
import { cn } from '@/lib/utils';

const GAP_PX = 8;
const BAR_WIDTH_PX = { desktop: 112, phone: 148 };
const BAR_HEIGHT_PX = 40;

const BUTTONS: ReadonlyArray<{ format: InlineFormat; label: string; keys: string; icon: React.ReactNode }> = [
  { format: 'bold', label: 'Bold', keys: 'Meta+B Control+B', icon: <Bold size={16} /> },
  { format: 'italic', label: 'Italic', keys: 'Meta+I Control+I', icon: <Italic size={16} /> },
  { format: 'link', label: 'Link', keys: 'Meta+K Control+K', icon: <Link size={16} /> },
];

interface BarPosition {
  left: number;
  top: number;
}

/** Above the words where there is room, below them otherwise, and always on screen. */
export function barPosition(
  words: { left: number; top: number; bottom: number; width: number },
  visible: { width: number; top: number; bottom: number },
  phone: boolean,
): BarPosition {
  const width = phone ? BAR_WIDTH_PX.phone : BAR_WIDTH_PX.desktop;
  const centred = phone ? visible.width / 2 - width / 2 : words.left + words.width / 2 - width / 2;
  const left = Math.max(GAP_PX, Math.min(centred, visible.width - width - GAP_PX));
  if (phone) return { left, top: visible.top + GAP_PX };
  const above = words.top - BAR_HEIGHT_PX - GAP_PX;
  if (above >= visible.top) return { left, top: above };
  return { left, top: Math.min(words.bottom + GAP_PX, visible.bottom - BAR_HEIGHT_PX - GAP_PX) };
}

const cancel = (e: React.SyntheticEvent) => e.preventDefault();

const InlineFormatBar = observer(() => {
  const { editorUI } = useStore();
  const isPhone = useIsPhone();
  const editing = editorUI.editingComponent as ComponentInstance | undefined;
  const owner = editing ? ownerOfRun(editing) : undefined;
  const element = editing && editing === owner ? owner : undefined;
  const [position, setPosition] = React.useState<BarPosition | null>(null);

  React.useEffect(() => {
    if (!editing) {
      setPosition(null);
      return;
    }
    const update = () => {
      const el = editedElement(editing);
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (!el || !range || !el.contains(range.commonAncestorContainer)) {
        setPosition(null);
        return;
      }
      // With a caret only, the bar is there to take a format off the element.
      const formatted = !!element && BUTTONS.some(({ format }) => hasInlineFormat(element, format));
      if (range.collapsed && !formatted) {
        setPosition(null);
        return;
      }
      const words = range.collapsed ? el.getBoundingClientRect() : range.getBoundingClientRect();
      setPosition(barPosition(words, measureVisibleArea(0), isPhone));
    };
    update();
    document.addEventListener('selectionchange', update);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('resize', update);
    };
  }, [editing, element, isPhone]);

  if (!editing || !position) return null;

  return (
    <div
      role="toolbar"
      aria-label="Format selected text"
      data-testid="inline-format-bar"
      {...{ [DATA_EDITOR_UI]: '' }}
      style={{ position: 'fixed', left: position.left, top: position.top, zIndex: 95 }}
      className="flex items-center gap-0.5 rounded-md border border-border bg-background p-1 shadow-md"
      onPointerDown={cancel}
      onMouseDown={cancel}
    >
      {BUTTONS.map(({ format, label, keys, icon }) => (
        <button
          key={format}
          type="button"
          aria-label={label}
          aria-pressed={!!element && hasInlineFormat(element, format)}
          aria-keyshortcuts={keys}
          title={label}
          onClick={() => applyInlineFormat(editorUI, format)}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded text-foreground transition-colors hover:bg-muted phone:h-11 phone:w-11',
            'aria-pressed:bg-brand/15 aria-pressed:text-brand',
          )}
        >
          {icon}
        </button>
      ))}
    </div>
  );
});
InlineFormatBar.displayName = 'InlineFormatBar';

export default InlineFormatBar;
