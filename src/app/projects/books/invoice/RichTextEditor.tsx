'use client';

// src/app/projects/books/invoice/RichTextEditor.tsx
//
// The formatting editor of the intro and closing texts on the invoice page
// (WYSIWYG invoice editor plan, phase 4, formatted texts part 2): the text in
// place, in the invoice's own faces, with a small toolbar for bold, italic and
// a bullet list floating above it.
//
// - Editing is the browser's own (contenteditable with its editing commands),
//   restricted to what the run model holds: the DOM is scratch, read back as
//   runs (`richFromDom`) after every change, and the runs are what is saved.
// - Only the edits the run model can hold are let through (a `beforeinput`
//   filter): typing, line and paragraph breaks, deleting, undo, bold, italic
//   and a bullet list. Underline, fonts, colours or a writing direction (a
//   shortcut, the macOS context menu) are refused, so the editor never shows
//   formatting the PDF would drop. A paste is plain text, a drop is refused.
// - Keyboard: Ctrl or Cmd plus B and I toggle bold and italic, Ctrl or Cmd
//   plus Enter saves, Escape leaves it as it was (in the toolbar too);
//   Shift+Tab reaches the toolbar, whose buttons the arrow keys move between
//   (WAI-ARIA toolbar pattern, one tab stop). A key pressed while an input
//   method composes (Japanese, Chinese) belongs to the input method.
// - Leaving the editor (focus outside it and its toolbar) saves, as the page's
//   other editors do.
// - A browser without editing commands gets no toolbar: the text is still
//   edited and saved, only not formatted.

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

/** The edits the run model can hold (InputEvent.inputType); every other is refused before the browser applies it. */
const ALLOWED_INPUT = new Set([
  'insertText',
  'insertReplacementText',
  'insertCompositionText',
  'insertFromComposition',
  'deleteByComposition',
  'insertParagraph',
  'insertLineBreak',
  'insertUnorderedList',
  'formatBold',
  'formatItalic',
  'historyUndo',
  'historyRedo',
]);

type ExecDocument = Document & { execCommand?: (command: string, ui: boolean, value?: string) => boolean };

/** Whether this browser has editing commands (jsdom and some embedded views have none). */
function canExec(): boolean {
  return typeof (document as ExecDocument).execCommand === 'function';
}

/** A document editing command, where the browser has one. */
function exec(command: string, value?: string): boolean {
  return canExec() ? (document as ExecDocument).execCommand!(command, false, value) : false;
}

function pressed(command: Command): boolean {
  try {
    return typeof document.queryCommandState === 'function' ? document.queryCommandState(command) : false;
  } catch {
    return false;
  }
}

/** The save shortcut's modifier as the keyboard shows it. */
const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** A key that belongs to an input method composing a character (its Escape cancels the conversion, not the edit). */
function composing(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
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
  // The toolbar button that is the toolbar's one tab stop (it follows the arrow keys).
  const [stop, setStop] = useState(0);
  const [formatting] = useState(canExec);
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
    // Only the edits the run model holds (React's onBeforeInput carries no inputType, so a native listener).
    const filter = (e: InputEvent) => {
      if (!ALLOWED_INPUT.has(e.inputType) && !e.inputType.startsWith('delete')) e.preventDefault();
    };
    el.addEventListener('beforeinput', filter);
    return () => el.removeEventListener('beforeinput', filter);
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

  // Escape and Ctrl or Cmd plus Enter work wherever the focus is in the editor, the toolbar included.
  const closingKeys = (e: React.KeyboardEvent): boolean => {
    if (composing(e)) return true;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onCommit('key');
      return true;
    }
    return false;
  };

  return (
    <div
      ref={wrap}
      className="relative"
      onBlur={(e) => {
        // Moving between the text and its toolbar is not leaving.
        if (wrap.current?.contains(e.relatedTarget as Node | null)) return;
        onCommit('blur');
      }}
    >
      {formatting ? (
        <div
          role="toolbar"
          aria-label={`${label}, formatting`}
          // Floats above the text, so the text stays exactly where the PDF prints it.
          className="glass absolute bottom-full left-0 z-30 mb-2 flex w-max items-center gap-0.5 rounded-xl p-1"
          // A press anywhere on the toolbar (between the buttons too) keeps the focus and the selection in the text.
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (closingKeys(e)) return;
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = (stop + (e.key === 'ArrowRight' ? 1 : -1) + BUTTONS.length) % BUTTONS.length;
            setStop(next);
            e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
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
              tabIndex={i === stop ? 0 : -1}
              // Pressed is a near-black fill (far more than 3 to 1 against the glass, WCAG 1.4.11).
              className={`flex size-7 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                state[command] ? 'bg-foreground text-background' : 'text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground'
              }`}
              onFocus={() => setStop(i)}
              onClick={() => apply(command)}
            >
              <Icon aria-hidden className="size-3.5" />
            </button>
          ))}
          <span aria-hidden className="ml-1 border-l border-foreground/10 pl-2.5 pr-1.5 text-xs text-muted-foreground">
            {MOD}↵ saves · Esc leaves it
          </span>
        </div>
      ) : null}
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
        className="w-full rounded-[3px] bg-background p-0 outline-none ring-2 ring-brand [&_li]:ml-4 [&_li]:list-disc [&_p]:m-0 [&_ul]:m-0 [&_ul]:p-0"
        style={{ ...textStyle, minHeight }}
        onFocus={prepare}
        onInput={changed}
        onPaste={(e) => {
          e.preventDefault();
          // Plain text only, with the line breaks of any platform as one kind.
          const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
          if (!exec('insertText', text)) {
            const sel = document.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(text);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          changed();
        }}
        onDrop={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (closingKeys(e)) return;
          const mod = e.metaKey || e.ctrlKey;
          // Bold and italic from the keyboard (handled here so the toolbar follows at once); without editing
          // commands the keys do what the browser does.
          if (formatting && mod && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
            e.preventDefault();
            apply('bold');
          } else if (formatting && mod && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            apply('italic');
          }
        }}
      />
    </div>
  );
}
