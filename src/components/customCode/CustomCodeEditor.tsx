'use client';

// src/components/customCode/CustomCodeEditor.tsx
//
// The code field of the custom code section (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// D10 and D112). A plain labelled textarea first, which works at once and without the chunk;
// CodeMirror (./codeMirrorView) takes its place once it has loaded. If the chunk cannot load,
// the textarea stays and says so, so the section always works. Either way Tab leaves the field.

import React from 'react';
import type { CodeMirrorHandle } from './codeMirrorView';

export interface CustomCodeEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The accessible name, such as "Code of Clock". */
  label: string;
  readOnly?: boolean;
  placeholder?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';

export function CustomCodeEditor({ id, value, onChange, label, readOnly = false, placeholder }: CustomCodeEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const handle = React.useRef<CodeMirrorHandle | null>(null);
  const [mode, setMode] = React.useState<'plain' | 'rich' | 'failed'>('plain');
  // The latest props for the editor's listener, which is created once.
  const latest = React.useRef({ onChange, value });
  latest.current = { onChange, value };
  const hintId = `${id}-hint`;

  React.useEffect(() => {
    let cancelled = false;
    import('./codeMirrorView')
      .then(({ mountCodeMirror }) => {
        if (cancelled || !host.current) return;
        const hadFocus = textarea.current !== null && document.activeElement === textarea.current;
        handle.current = mountCodeMirror(host.current, {
          value: latest.current.value,
          onChange: (next) => latest.current.onChange(next),
          label,
          describedBy: hintId,
          readOnly,
          placeholder,
        });
        setMode('rich');
        if (hadFocus) handle.current.focus();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn('[custom code] the code editor did not load; the plain field stays', error instanceof Error ? error.name : error);
        setMode('failed');
      });
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
    // Mounted once per field; the name, the read-only state and the value follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    handle.current?.setValue(value);
  }, [value, mode]);

  React.useEffect(() => {
    handle.current?.setReadOnly(readOnly);
  }, [readOnly, mode]);

  // The name follows the block's title as it is typed.
  React.useEffect(() => {
    handle.current?.setLabel(label);
  }, [label, mode]);

  return (
    <div className="flex flex-col gap-1" data-custom-code-editor={mode}>
      {mode !== 'rich' && (
        <textarea
          ref={textarea}
          id={id}
          aria-label={label}
          aria-describedby={hintId}
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={12}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-[200px] w-full resize-y rounded-[6px] border border-border bg-background p-2 font-mono text-[12px] leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
      )}
      <div ref={host} hidden={mode !== 'rich'} />
      <p id={hintId} className={HINT}>
        {mode === 'failed'
          ? 'The code editor did not load, so this is a plain field; it saves the same way. '
          : ''}
        Tab moves on to the next field.
        {mode === 'rich' ? ` Indent with ${isMac() ? 'Cmd' : 'Ctrl'}+] and outdent with ${isMac() ? 'Cmd' : 'Ctrl'}+[.` : ''}
      </p>
    </div>
  );
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
// ci-replay touch
