'use client';
// src/components/ProjectNameInput.tsx
//
// The inline field both rename entry points use (the editor's top bar and the
// dashboard card). Keyboard contract: Enter saves, Escape cancels, leaving the
// field (blur) saves. An empty or otherwise invalid name is refused with a
// message announced to screen readers, and the field stays open. Saving or
// cancelling happens at most once per opening, so Escape followed by the blur
// it causes never saves.

import React, { useEffect, useId, useRef, useState } from 'react';
import { validateProjectName, PROJECT_NAME_MAX_LENGTH } from '@/lib/projectName';
import { cn } from '@/lib/utils';

interface ProjectNameInputProps {
  /** The current name, prefilled and selected. */
  initialName: string;
  /** Called once with the trimmed, valid new name (also when unchanged). */
  onSubmit: (name: string) => void;
  /** Called once when the person cancels (Escape). */
  onCancel: () => void;
  className?: string;
}

export default function ProjectNameInput({
  initialName,
  onSubmit,
  onCancel,
  className,
}: ProjectNameInputProps) {
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const submit = () => {
    if (settled.current) return;
    const result = validateProjectName(value);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    settled.current = true;
    onSubmit(result.name);
  };

  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <span className="relative inline-flex min-w-0 flex-col">
      <input
        ref={inputRef}
        type="text"
        aria-label="Project name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        // Generous hard cap: the real limit (in characters) is validated with
        // a message; this only stops pasting a novel.
        maxLength={PROJECT_NAME_MAX_LENGTH * 4}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // Keep Escape from also closing a surrounding dialog or panel.
            e.stopPropagation();
            cancel();
          }
        }}
        onBlur={submit}
        className={cn(
          'min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-sm text-foreground outline-none focus:border-brand',
          error && 'border-destructive focus:border-destructive',
          className,
        )}
      />
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded bg-background px-1.5 py-0.5 text-xs text-destructive shadow"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
