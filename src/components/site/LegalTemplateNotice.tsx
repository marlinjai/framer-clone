'use client';
// src/components/site/LegalTemplateNotice.tsx
//
// Above the canvas while a page created from a legal template is open
// (PageModel metadata.legalTemplate, src/lib/legal/templates.ts): "Template,
// not legal advice: review before publishing", and how many [placeholders]
// the page still has. Editor chrome only: it is never part of the page, so it
// is never published.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { Scale } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { findPlaceholders } from '@/lib/legal/templates';

interface NodeLike {
  props?: { children?: unknown } | null;
  children?: NodeLike[] | null;
}

/** Every [placeholder] in the text of a component tree. */
export function treePlaceholders(root: NodeLike | null | undefined): string[] {
  const found: string[] = [];
  const stack: NodeLike[] = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const text = node.props?.children;
    if (typeof text === 'string') found.push(...findPlaceholders(text));
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return found;
}

const LegalTemplateNotice = observer(() => {
  const { editorUI } = useStore();
  const page = editorUI.currentPage;
  if (!page || !page.metadata.legalTemplate) return null;
  const count = treePlaceholders(getSnapshot(page.appComponentTree) as NodeLike).length;
  return (
    <div
      role="note"
      aria-label="Legal page template"
      data-editor-ui="true"
      data-testid="legal-template-notice"
      className={`fixed left-1/2 z-90 -translate-x-1/2 ${editorUI.editorNotice ? 'top-28' : 'top-16'} mt-2 flex max-w-[640px] items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow`}
    >
      <Scale size={14} aria-hidden="true" className="mt-px shrink-0" />
      <span>
        <strong className="font-semibold">Template, not legal advice: review before publishing.</strong>{' '}
        {count > 0
          ? `Replace the ${count} ${count === 1 ? 'part' : 'parts'} in [square brackets] with your details or delete them.`
          : 'No [placeholders] left. Have the text checked before you rely on it.'}
      </span>
    </div>
  );
});

LegalTemplateNotice.displayName = 'LegalTemplateNotice';
export default LegalTemplateNotice;
