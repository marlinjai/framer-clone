'use client';
// TextContentSection: the "Text" field at the top of the properties panel,
// for every element whose content is its own text (a heading, a paragraph, a
// button label; the rule is holdsText in src/lib/renderer/textContent.ts).
//
// It is the dependable way to change text on a phone: the Edit sheet's
// textarea is a plain form field, which always opens the on-screen keyboard,
// whatever the canvas gestures do. It writes through the same model action
// as inline editing on the canvas (component.setTextContent), once per
// committed edit, so one edit is one undo step: typing only changes a local
// draft, and the draft is committed on blur or Enter (Escape puts the text
// back). Text bound to data shows the binding instead of an editable field.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Type } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindableSlotMeta } from '@/lib/bindings/types';
import { getBindableSlotsFor } from '@/lib/componentRegistry';
import { holdsText, isTextBound } from '@/lib/renderer/textContent';
import { cn } from '@/lib/utils';
import { CollapsibleSection, FIELD_LABEL } from '../primitives';
import BindingControl from '../BindingControl';
import { getRegistryIdForNode } from '../registryId';

interface TextContentFieldProps {
  node: ComponentInstance;
  label?: string;
  /** 'area' (default) wraps and grows with the text; 'line' is a one-line input. */
  variant?: 'area' | 'line';
  className?: string;
}

/** The node's own text as a string ('' when it has none). */
function textOf(node: ComponentInstance): string {
  const v = node.props?.children;
  return typeof v === 'string' ? v : '';
}

/**
 * A text field bound to a node's text content: edits a draft, commits it
 * with one setTextContent on blur or Enter, reverts on Escape. A draft that
 * is still open when the field goes away (the selection changed) is
 * committed to the node it was typed for.
 */
export const TextContentField = observer(({ node, label = 'Text content', variant = 'area', className }: TextContentFieldProps) => {
  const stored = textOf(node);
  const [draft, setDraft] = React.useState(stored);
  const focused = React.useRef(false);
  const dirty = React.useRef(false);
  const ref = React.useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  // Follow changes made elsewhere (inline editing, undo) while not typing here.
  React.useEffect(() => {
    if (!focused.current) setDraft(stored);
  }, [stored]);

  const commit = React.useCallback(
    (value: string) => {
      dirty.current = false;
      if (value !== textOf(node)) node.setTextContent(value);
    },
    [node],
  );

  // The field goes away with a draft open (the selection moved on without a
  // blur): the text still lands on the node it was typed for.
  const latest = React.useRef({ draft, commit });
  latest.current = { draft, commit };
  React.useEffect(
    () => () => {
      if (dirty.current) latest.current.commit(latest.current.draft);
    },
    [],
  );

  // A textarea grows with its text, up to a limit, then scrolls.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (variant !== 'area' || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft, variant]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // Shortcuts of the editor (delete, undo, arrows) must not act on the canvas.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // Enter commits, as on the canvas: the element's text is one run of
      // text (a line break typed here would not show on the page).
      e.preventDefault();
      commit(draft);
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dirty.current = false;
      setDraft(textOf(node));
      // Blur after the revert has rendered, so the blur commits nothing.
      const el = e.currentTarget;
      requestAnimationFrame(() => el.blur());
    }
  };

  const shared = {
    'aria-label': label,
    value: draft,
    placeholder: 'Type the text',
    enterKeyHint: 'done' as const,
    spellCheck: true,
    onFocus: () => {
      focused.current = true;
    },
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      dirty.current = true;
      setDraft(e.target.value);
    },
    onBlur: (e: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      focused.current = false;
      if (dirty.current) commit(e.currentTarget.value);
    },
    onKeyDown,
  };

  // 16px on a phone: readable, and the size iOS does not zoom in on.
  const base =
    'w-full min-w-0 rounded-[6px] border border-border bg-background px-2 text-[12px] phone:text-[16px] text-foreground ' +
    'outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-brand focus:ring-3 focus:ring-brand/12';

  if (variant === 'line') {
    return <input ref={ref} type="text" {...shared} className={cn(base, 'h-7 phone:h-9', className)} />;
  }
  return <textarea ref={ref} rows={2} {...shared} className={cn(base, 'block resize-none py-1.5 leading-snug', className)} />;
});
TextContentField.displayName = 'TextContentField';

const FALLBACK_META: BindableSlotMeta = { label: 'Text', allowedModes: ['read'] };

interface TextContentSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const TextContentSection = observer(({ component }: TextContentSectionProps) => {
  if (!holdsText(component)) return null;
  const registryId = getRegistryIdForNode(component);
  const slotMeta = registryId ? getBindableSlotsFor(registryId).children : undefined;
  const bound = isTextBound(component);
  // key: a new draft per element, so text typed for one element never lands
  // on the next one selected.
  const field = <TextContentField key={component.id} node={component} />;

  return (
    <CollapsibleSection title="Text" icon={<Type size={14} />}>
      <div className="flex min-w-0 flex-col gap-1.5" data-testid="text-content-section">
        {slotMeta || bound ? (
          // Bindable (or already bound): the binding control shows the field
          // with a bind button, or the binding chip instead of the field.
          <BindingControl node={component} slot="children" meta={slotMeta ?? FALLBACK_META}>
            {field}
          </BindingControl>
        ) : (
          field
        )}
        {bound && <span className={FIELD_LABEL}>The text comes from data. Unlink it to type your own.</span>}
      </div>
    </CollapsibleSection>
  );
});
TextContentSection.displayName = 'TextContentSection';

export default TextContentSection;
