'use client';

// src/components/cms/agent/AgentInput.tsx
//
// The agent input bar: a textarea + a model picker (Haiku / Sonnet / Opus,
// default Opus) + a paperclip that opens a `.csv`-only file picker + a send
// button. Send is disabled while a run is in flight or the textarea is empty.
//
// The component owns its draft text and attached-CSV state and exposes a small
// imperative handle (`setText`, `focus`) so the suggestion chips can populate
// and focus it. On send it clears itself and hands the parent a structured
// payload (prompt + model + optional base64 csvPayload).

import React from 'react';
import { Paperclip, ArrowUp, X } from 'lucide-react';

export type AgentModelKey = 'HAIKU' | 'SONNET' | 'OPUS';

export interface AgentSendPayload {
  prompt: string;
  model: AgentModelKey;
  csvPayload?: { name: string; content: string };
}

export interface AgentInputHandle {
  setText: (text: string) => void;
  focus: () => void;
}

export interface AgentInputProps {
  isRunning: boolean;
  onSend: (payload: AgentSendPayload) => void;
}

const MODEL_OPTIONS: { key: AgentModelKey; label: string }[] = [
  { key: 'HAIKU', label: 'Claude Haiku 4.5' },
  { key: 'SONNET', label: 'Claude Sonnet 4.6' },
  { key: 'OPUS', label: 'Claude Opus 4.8' },
];

function toBase64Utf8(text: string): string {
  // btoa needs latin1; round-trip through UTF-8 so non-ASCII content survives.
  return btoa(unescape(encodeURIComponent(text)));
}

const AgentInput = React.forwardRef<AgentInputHandle, AgentInputProps>(
  function AgentInput({ isRunning, onSend }, ref) {
    const [text, setText] = React.useState('');
    const [model, setModel] = React.useState<AgentModelKey>('OPUS');
    const [csv, setCsv] = React.useState<{ name: string; content: string } | null>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => ({
      setText: (next: string) => setText(next),
      focus: () => textareaRef.current?.focus(),
    }));

    const handleFile = async (file: File | undefined): Promise<void> => {
      if (!file) return;
      const raw = await file.text();
      setCsv({ name: file.name, content: toBase64Utf8(raw) });
    };

    const canSend = !isRunning && text.trim().length > 0;

    const submit = (): void => {
      if (!canSend) return;
      onSend({ prompt: text.trim(), model, csvPayload: csv ?? undefined });
      setText('');
      setCsv(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };

    return (
      <div className="shrink-0 border-t border-border p-3" data-testid="agent-input">
        {csv && (
          <div
            className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[12px] text-foreground"
            data-testid="agent-csv-chip"
          >
            <Paperclip className="size-[12px] text-muted-foreground" />
            <span className="max-w-[180px] truncate">{csv.name}</span>
            <button
              type="button"
              aria-label="Remove attached file"
              onClick={() => {
                setCsv(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-[12px]" />
            </button>
          </div>
        )}

        <div className="rounded-lg border border-border bg-background focus-within:border-ring">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Ask the content agent to create, import, or edit content..."
            aria-label="Content agent prompt"
            data-testid="agent-textarea"
            className="w-full resize-none bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />

          <div className="flex items-center gap-1.5 px-2 pb-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              data-testid="agent-file-input"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <button
              type="button"
              aria-label="Attach CSV file"
              data-testid="agent-attach"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Paperclip className="size-[15px]" />
            </button>

            <select
              value={model}
              onChange={(e) => setModel(e.target.value as AgentModelKey)}
              aria-label="Agent model"
              data-testid="agent-model"
              className="rounded-md border border-border bg-background px-2 py-1 text-[12px] font-medium text-foreground outline-none focus-visible:border-ring"
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>

            <div className="flex-1" />

            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              data-testid="agent-send"
              className="inline-flex size-7 items-center justify-center rounded-md bg-brand text-brand-foreground transition-colors hover:bg-brand/90 disabled:pointer-events-none disabled:opacity-40"
            >
              <ArrowUp className="size-[15px]" />
            </button>
          </div>
        </div>
      </div>
    );
  },
);

export default AgentInput;
