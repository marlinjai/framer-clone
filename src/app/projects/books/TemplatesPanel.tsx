'use client';

// src/app/projects/books/TemplatesPanel.tsx
//
// Document templates: the LAYOUT of the company's PDFs. Each template opens in
// the visual composer (/projects/books/templates/<id>, phase 4 of the visual
// template composer plan), which edits the whole layout; a new template starts
// from one of the three presets (Klassisch, Modern, Kompakt) and opens there.
// Who issues the document, the tax status and the number series are company
// configuration and shown read-only elsewhere; a template can never change
// them. The first template becomes the default; new drafts start with the
// default. Removing a template archives it: documents issued with it keep
// their layout.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { booksApi, type TemplateView } from '@/lib/books/api';

import { ErrorAlert, Field, errorText } from './ui';

const PRESETS = [
  { value: 'klassisch', label: 'Klassisch: the standard layout' },
  { value: 'modern', label: 'Modern: logo top right, accent band behind the table header' },
  { value: 'kompakt', label: 'Kompakt: smaller type, one-line footer' },
] as const;

export default function TemplatesPanel() {
  const router = useRouter();
  const [items, setItems] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['value']>('klassisch');
  const [intro, setIntro] = useState('');
  const [creating, setCreating] = useState(false);

  async function reload() {
    try {
      setItems((await booksApi.templates()).items);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const created = await booksApi.createTemplate({ name: name.trim(), preset, defaultIntroText: intro.trim() || null });
      router.push(`/projects/books/templates/${created.id}`);
    } catch (err) {
      setError(errorText(err));
      setCreating(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section aria-label="Templates">
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading templates…</p>
      ) : items.length === 0 ? (
        <p className="mb-4 text-sm text-muted-foreground">
          No template yet. Documents use the built-in Klassisch layout until you create one.
        </p>
      ) : (
        <ul className="mb-6 flex flex-col gap-2">
          {items.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <span className="flex items-center gap-3">
                <span aria-hidden className="size-4 rounded-full border" style={{ background: t.accentColor }} />
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground">Version {t.version}</span>
                {t.isDefault ? <span className="rounded-full border px-2 py-0.5 text-xs">Default</span> : null}
              </span>
              <span className="flex gap-2">
                <Button size="sm" asChild>
                  <Link href={`/projects/books/templates/${t.id}`} aria-label={`Edit the layout of ${t.name}`}>
                    Edit layout
                  </Link>
                </Button>
                {!t.isDefault ? (
                  <Button size="sm" variant="outline" onClick={() => act(() => booksApi.updateTemplate(t.id, { isDefault: true }))}>
                    Make default
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => act(() => booksApi.deleteTemplate(t.id))} aria-label={`Remove ${t.name}`}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="grid grid-cols-1 gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label="New template">
        <Field label="Template name" htmlFor="tpl-name">
          <Input id="tpl-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Start from" htmlFor="tpl-preset">
          <select
            id="tpl-preset"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={preset}
            onChange={(e) => setPreset(e.target.value as typeof preset)}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default intro for new invoices (optional)" htmlFor="tpl-intro">
          <Input id="tpl-intro" value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="Vielen Dank für Ihren Auftrag." />
        </Field>
        <div className="flex items-end justify-end sm:col-span-1">
          <Button type="submit" disabled={name.trim() === '' || creating}>
            {creating ? 'Creating…' : 'Create and open the composer'}
          </Button>
        </div>
      </form>
    </section>
  );
}
