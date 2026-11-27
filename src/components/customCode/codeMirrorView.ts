// src/components/customCode/codeMirrorView.ts
//
// The code editor of the custom code section: CodeMirror 6 with HTML (and the JavaScript
// and CSS inside it), loaded as its own chunk only when the section opens (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, D10 and D112).
//
// Keyboard: Tab is NOT bound, so Tab and Shift+Tab leave the editor as they leave any
// field, and nobody is trapped in it. Read-only is CodeMirror's read-only state alone: the
// content stays editable to the browser, so Tab still reaches it and the arrow keys and
// PageDown move through it, while no edit goes in.
// CodeMirror itself sets `aria-readonly` on the content from that state, so this file does not
// (the gates pin CodeMirror's own). Indenting is Mod-] and Mod-[ (the default keymap),
// undo and redo the editor's own history. The content carries the field's accessible
// name and description. No linting, no formatting, no completion: it never runs the code.

import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { html } from '@codemirror/lang-html';

export interface CodeMirrorOptions {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name of the editable content. */
  label: string;
  /** The id of the element describing how to leave and indent. */
  describedBy?: string;
  readOnly: boolean;
  placeholder?: string;
}

export interface CodeMirrorHandle {
  setValue(value: string): void;
  setReadOnly(readOnly: boolean): void;
  /** Renames the editable content (the block's title changed). */
  setLabel(label: string): void;
  focus(): void;
  destroy(): void;
}

const theme = EditorView.theme({
  '&': { fontSize: '12px', border: '1px solid var(--border)', borderRadius: '6px', backgroundColor: 'var(--background)' },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '1px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minHeight: '200px', maxHeight: '420px', overflow: 'auto' },
  '.cm-content': { padding: '6px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--border)' },
});

export function mountCodeMirror(parent: HTMLElement, options: CodeMirrorOptions): CodeMirrorHandle {
  const editable = new Compartment();
  const named = new Compartment();
  let label = options.label;
  let readOnly = options.readOnly;
  const attributes = () => {
    const values: Record<string, string> = { 'aria-label': label, 'aria-multiline': 'true' };
    if (options.describedBy) values['aria-describedby'] = options.describedBy;
    return EditorView.contentAttributes.of(values);
  };
  let applying = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        html(),
        // No indentWithTab: Tab moves the focus on (D112).
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        named.of(attributes()),
        options.placeholder ? placeholder(options.placeholder) : [],
        // Never `EditorView.editable.of(false)`: that takes the content out of the tab order (review 1 of #459, M2).
        editable.of(EditorState.readOnly.of(readOnly)),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applying) options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    setValue(value: string) {
      const current = view.state.doc.toString();
      if (current === value) return;
      applying = true;
      try {
        view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
      } finally {
        applying = false;
      }
    },
    setReadOnly(next: boolean) {
      readOnly = next;
      view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(readOnly)) });
    },
    setLabel(next: string) {
      label = next;
      view.dispatch({ effects: named.reconfigure(attributes()) });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
// ci-replay touch
