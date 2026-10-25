// src/components/sidebars/left/ContextMenu.tsx
// Lightweight self-contained floating menu shared by the left sidebar's lists
// (Pages rows, Layers rows). Positions at (x, y) in viewport coords. Closes on
// outside click, Escape, or after any item fires.
'use client';
import React from 'react';

export interface MenuItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /**
   * For a disabled item that should explain itself: the item stays focusable
   * and tappable (aria-disabled instead of the disabled attribute), looks
   * disabled, and choosing it runs this instead of onClick. Touch screens have
   * no hover tooltip, so this is how they learn why.
   */
  onDisabledClick?: () => void;
}

/** Why the menu closed: Escape and choosing an item hand focus back to the row. */
export type MenuCloseReason = 'escape' | 'item' | 'outside';

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: (reason: MenuCloseReason) => void;
}

/** Keep at least this much space between the menu and the window edge. */
const MENU_EDGE_MARGIN = 8;

/**
 * Where a menu of `size` opened at (x, y) must sit to stay fully inside a
 * `viewport`: shifted left / up when it would cross the right / bottom edge,
 * never past the top-left margin.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(MENU_EDGE_MARGIN, Math.min(x, viewport.width - size.width - MENU_EDGE_MARGIN));
  const top = Math.max(MENU_EDGE_MARGIN, Math.min(y, viewport.height - size.height - MENU_EDGE_MARGIN));
  return { left, top };
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState({ left: x, top: y });

  // Opened near the bottom or right edge of a small window, the menu moves
  // back inside it before it is painted, so every item stays clickable.
  // Measured again when the window is resized or the items change.
  const itemCount = items.length;
  React.useLayoutEffect(() => {
    const clamp = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPosition(
        clampMenuPosition(
          x,
          y,
          { width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [x, y, itemCount]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose('escape');
    };
    // Keyboard users land on the first item.
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    // Register on the next tick so the click that opened the menu doesn't
    // immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Up and Down move between the enabled items, wrapping around; Escape
  // closes. No key pressed inside the menu travels further, so Delete or
  // Cmd+Z on a focused item never reaches the editor's canvas shortcuts.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose('escape');
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length].focus();
  };

  return (
    <div
      ref={rootRef}
      role="menu"
      onKeyDown={onMenuKeyDown}
      data-editor-ui="true"
      style={{ left: position.left, top: position.top }}
      className="fixed z-[200] min-w-[160px] max-h-[calc(100vh-1rem)] supports-[height:100dvh]:max-h-[calc(100dvh-1rem)] overflow-y-auto bg-background border border-border rounded-md shadow-lg py-1"
    >
      {items.map(item => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled && !item.onDisabledClick}
          aria-disabled={item.disabled && item.onDisabledClick ? true : undefined}
          onClick={() => {
            if (item.disabled) {
              if (!item.onDisabledClick) return;
              item.onDisabledClick();
            } else {
              item.onClick();
            }
            onClose('item');
          }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
            item.disabled
              ? `text-muted-foreground ${item.onDisabledClick ? 'cursor-help hover:bg-accent' : 'cursor-not-allowed'}`
              : item.destructive
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-foreground hover:bg-accent'
          }`}
        >
          <span className="shrink-0 opacity-70">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
};

export default ContextMenu;
