'use client';

// src/app/projects/books/TemplatesPanel.tsx
//
// Document templates: the LAYOUT of the company's PDFs (accent colour, a block
// of small print, default intro and outro for new drafts). Who issues the
// document, the tax status and the number series are company configuration
// and shown read-only above; a template can never change them. The first
// template becomes the default; new drafts start with the default.

import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { booksApi, type TemplateView } from '@/lib/books/api';

import { ErrorAlert, Field, errorText } from './ui';

export default function TemplatesPanel() {
  const [items, setItems] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [accent, setAccent] = useState('#2b4c7e');
  const [smallPrint, setSmallPrint] = useState('');
  const [intro, setIntro] = useState('');

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
    try {
      await booksApi.createTemplate({
        name,
        accentColor: accent,
        footerBlocks: smallPrint.trim() ? [{ text: smallPrint.trim() }] : [],
        defaultIntroText: intro.trim() || null,
      });
      setName('');
      setSmallPrint('');
      setIntro('');
      await reload();
    } catch (err) {
      setError(errorText(err));
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
          No template yet. Documents use the plain layout until you create one.
        </p>
      ) : (
        <ul className="mb-6 flex flex-col gap-2">
          {items.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <span className="flex items-center gap-3">
                <span aria-hidden className="size-4 rounded-full border" style={{ background: t.accentColor ?? 'transparent' }} />
                <span className="font-medium">{t.name}</span>
                {t.isDefault ? <span className="rounded-full border px-2 py-0.5 text-xs">Default</span> : null}
              </span>
              <span className="flex gap-2">
                {!t.isDefault ? (
                  <Button size="sm" variant="outline" onClick={() => act(() => booksApi.updateTemplate(t.id, { isDefault: true }))}>
                    Make default
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => act(() => booksApi.deleteTemplate(t.id))}>
                  Delete
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
        <Field label="Accent colour" htmlFor="tpl-accent">
          <Input id="tpl-accent" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
        </Field>
        <Field label="Default intro for new invoices" htmlFor="tpl-intro">
          <Input id="tpl-intro" value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="Vielen Dank für Ihren Auftrag." />
        </Field>
        <Field label="Small print (optional)" htmlFor="tpl-small">
          <Input id="tpl-small" value={smallPrint} onChange={(e) => setSmallPrint(e.target.value)} />
        </Field>
        <div className="sm:col-span-2 flex justify-end">
          <Button type="submit" disabled={name.trim() === ''}>
            Create template
          </Button>
        </div>
      </form>
    </section>
  );
}
