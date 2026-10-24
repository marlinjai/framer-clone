'use client';

// src/app/projects/books/invoice/RichTextEditor.tsx
//
// The formatting editor of the intro and closing texts on the invoice page
// (WYSIWYG invoice editor plan, phase 4, formatted texts part 2): the text in
// place, in the invoice's own faces, with a small toolbar for bold, italic and
// a bullet list.
//
// - Editing is the browser's own (contenteditable with its editing commands),
//   restricted to what the run model holds: the DOM is scratch, read back as
//   runs (`richFromDom`) after every change, and the runs are what is saved.
// - A paste is plain text (the clipboard's formatting is dropped), a drop is
//   refused: nothing outside the run model gets in.
// - Keyboard: Ctrl or Cmd plus B and I toggle bold and italic, Ctrl or Cmd
//   plus Enter saves, Escape leaves it as it was; Tab reaches the toolbar,
//   whose buttons the arrow keys move between (WAI-ARIA toolbar pattern).
// - Leaving the editor (focus outside it, toolbar included) saves, as the
//   page's other editors do.

import { Bold, Italic, List } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { RichText } from '@/server/books/render/richText';

import { richFromDom, richToHtml } from './richDom';

type Command = 'bold' | 'italic' | 'insertUnorderedList';

const BUTTONS: Array<{ command: Command; label: string; keys: string; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }> = [
  { command: 'bold', label: 'Bold', keys: 'Control+B Meta+B', icon: Bold },
  { command: 'italic', label: 'Italic', keys: 'Control+I Meta+I', icon: Italic },
  { command: 'insertUnorderedList', label: 'Bullet list', keys: '', icon: List },
];

/** A document editing command, where the browser has one (jsdom has none; the page then simply cannot format). */
function exec(command: string, value?: string): boolean {
  const run = (document as Document & { execCommand?: (c: string, ui: boolean, v?: string) => boolean }).execCommand;
  return typeof run === 'function' ? run.call(document, command, false, value) : false;
}

function pressed(command: Command): boolean {
  try {
    return typeof document.queryCommandState === 'function' ? document.queryCommandState(command) : false;
  } catch {
    return false;
  }
}

export default function RichTextEditor({
  initial,
  label,
  textStyle,
  minHeight,
  invalid,
  describedBy,
  onChange,
  onCommit,
  onCancel,
}: {
  /** The formatted text the editor starts from (read once, when it opens). */
  initial: RichText;
  label: string;
  /** The invoice's own font, size, colour and alignment at the page's zoom. */
  textStyle: React.CSSProperties;
  minHeight: number;
  invalid: boolean;
  describedBy?: string;
  onChange: (rich: RichText) => void;
  onCommit: (by: 'key' | 'blur') => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Record<Command, boolean>>({ bold: false, italic: false, insertUnorderedList: false });
  const initialRef = useRef(initial);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.innerHTML = richToHtml(initialRef.current);
    el.focus();
    // The caret at the end, where a person continues typing.
    const sel = window.getSelection();
    if (sel && typeof document.createRange === 'function') {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  // The toolbar shows the style at the caret.
  useEffect(() => {
    const update = () => {
      const el = box.current;
      if (!el || !el.contains(document.getSelection()?.anchorNode ?? null)) return;
      setState({ bold: pressed('bold'), italic: pressed('italic'), insertUnorderedList: pressed('insertUnorderedList') });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  const changed = () => {
    if (box.current) onChange(richFromDom(box.current));
    setState({ bold: pressed('bold'), italic: pressed('italic'), insertUnorderedList: pressed('insertUnorderedList') });
  };

  const apply = (command: Command) => {
    box.current?.focus();
    exec(command);
    changed();
  };

  const prepare = () => {
    // Plain <b>/<i> instead of styled spans, and <p> for a new paragraph (the walker reads either way).
    exec('styleWithCSS', 'false');
    exec('defaultParagraphSeparator', 'p');
  };

  return (
    <div
      ref={wrap}
      onBlur={(e) => {
        // Moving between the text and its toolbar is not leaving.
        if (wrap.current?.contains(e.relatedTarget as Node | null)) return;
        onCommit('blur');
      }}
    >
      <div
        role="toolbar"
        aria-label={`${label}, formatting`}
        className="mb-0.5 flex w-max gap-0.5 rounded border border-gray-500 bg-white p-0.5 shadow-sm"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}
      >
        {BUTTONS.map(({ command, label: name, keys, icon: Icon }, i) => (
          <button
            key={command}
            type="button"
            aria-label={name}
            aria-pressed={state[command]}
            aria-keyshortcuts={keys || undefined}
            title={keys ? `${name} (${keys.split(' ')[0].replace('Control', 'Ctrl')})` : name}
            // Roving focus: one tab stop for the whole toolbar.
            tabIndex={i === 0 ? 0 : -1}
            className={`flex size-6 items-center justify-center rounded text-gray-800 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-600 ${
              state[command] ? 'bg-blue-100 text-blue-900' : ''
            }`}
            // Pressing a button keeps the selection in the text.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply(command)}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        ))}
      </div>
      <div
        ref={box}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        className="w-full bg-white p-0 outline-2 outline-blue-600 [&_li]:ml-4 [&_li]:list-disc [&_p]:m-0 [&_ul]:m-0 [&_ul]:p-0"
        style={{ ...textStyle, minHeight, whiteSpace: 'pre-wrap' }}
        onFocus={prepare}
        onInput={changed}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (!exec('insertText', text)) {
            const sel = document.getSelection();
            if (sel && sel.rangeCount > 0) sel.getRangeAt(0).insertNode(document.createTextNode(text));
          }
          changed();
        }}
        onDrop={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (mod && e.key === 'Enter') {
            e.preventDefault();
            onCommit('key');
          } else if (mod && (e.key === 'b' || e.key === 'B') && !e.shiftKey) {
            e.preventDefault();
            apply('bold');
          } else if (mod && (e.key === 'i' || e.key === 'I') && !e.shiftKey) {
            e.preventDefault();
            apply('italic');
          }
        }}
      />
    </div>
  );
}
