'use client';

// src/components/cms/agent/AgentInput.tsx
//
// The agent input bar: a textarea + the model slider (Fast = Haiku, Balanced =
// Sonnet, Best = Opus; default Best, the last choice remembered per browser) +
// a paperclip that opens a `.csv`-only file picker + a send button. Send is disabled while a run is in flight or the textarea is empty.
//
// The component owns its draft text and attached-CSV state and exposes a small
// imperative handle (`setText`, `focus`) so the suggestion chips can populate
// and focus it. On send it clears itself and hands the parent a structured
// payload (prompt + model + optional base64 csvPayload).

import React from 'react';
import { Paperclip, ArrowUp, X } from 'lucide-react';
import { ModelSlider } from '@/components/ai/ModelSlider';
import { loadModelChoice, saveModelChoice, type ModelChoice } from '@/lib/ai/modelChoice';

export type AgentModelKey = ModelChoice;

/** The content agent's default step: Best (Opus 5.5). */
export const DEFAULT_AGENT_MODEL: AgentModelKey = 'OPUS';

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

function toBase64Utf8(text: string): string {
  // btoa needs latin1; round-trip through UTF-8 so non-ASCII content survives.
  return btoa(unescape(encodeURIComponent(text)));
}

const AgentInput = React.forwardRef<AgentInputHandle, AgentInputProps>(
  function AgentInput({ isRunning, onSend }, ref) {
    const [text, setText] = React.useState('');
    const [model, setModel] = React.useState<AgentModelKey>(DEFAULT_AGENT_MODEL);
    // Read the remembered choice after mount, not in the state initializer: this
    // component is server-rendered, and reading localStorage during the first
    // render would make the server and client HTML differ (a hydration error).
    // The slider can therefore show the default for one frame before the
    // remembered step.
    React.useEffect(() => {
      setModel(loadModelChoice('cms-agent', DEFAULT_AGENT_MODEL));
    }, []);
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
        <div className="mb-2">
          <ModelSlider
            id="agent-model"
            label="Agent model"
            compact
            value={model}
            disabled={isRunning}
            onChange={(next) => {
              setModel(next);
              saveModelChoice('cms-agent', next);
            }}
          />
        </div>
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
