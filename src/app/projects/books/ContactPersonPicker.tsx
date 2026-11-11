'use client';

// src/app/projects/books/ContactPersonPicker.tsx
//
// The contact person ("z. Hd.") of a draft, outside the page canvas: the select of the customer's people used by the
// narrow-window form, and the notice that offers the two ways forward when the chosen person no longer works for the
// customer (issuing is refused until one of them is taken). The on-page editor has its own select inside the page
// (InvoicePage); both send PUT .../contact-person through `change`, which refreshes the draft.

import React from 'react';

import { Button } from '@/components/ui/button';
import { booksApi, type ContactPersonState, type ContactPersonView, type DocumentDetail } from '@/lib/books/api';

import { Field } from './ui';

/** "Anna Beispiel, Einkauf" or just the name. */
export function personLabel(p: { name: string | null; role: string }): string {
  const name = p.name ?? '';
  return p.role ? `${name}, ${p.role}` : name;
}

interface PickerProps {
  id: string;
  version: number;
  contactPerson: ContactPersonState | null;
  contactPersons: ContactPersonView[] | null;
  busy: boolean;
  change: (fn: () => Promise<DocumentDetail>) => Promise<boolean>;
}

/** The narrow form's select. Absent when the customer has no people and none is chosen. */
export function ContactPersonSelect({ id, version, contactPerson, contactPersons, busy, change }: PickerProps) {
  // `== null`: an older answer without the field offers nothing, like a null one.
  if (contactPersons == null) return null;
  if (contactPersons.length === 0 && !contactPerson) return null;
  const current = contactPerson?.status === 'ok' ? contactPerson.contactId : '';
  return (
    <Field label="Contact person (z. Hd.)" htmlFor="doc-contact-person" hint="Printed under the address when the template has the contact person line.">
      <select
        id="doc-contact-person"
        value={current}
        disabled={busy}
        onChange={(e) => void change(() => booksApi.setContactPerson(id, e.target.value === '' ? null : e.target.value, version))}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">None</option>
        {contactPersons.map((p) => (
          <option key={p.affiliationId} value={p.contactId}>
            {personLabel(p)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * The notice for a contact person who is gone (left the customer, erased or archived). Two ways forward, both one
 * action: choose another person of the customer, or remove the contact person. Nothing is guessed.
 */
export function ContactPersonGone({ id, version, contactPersons, busy, change }: Omit<PickerProps, 'contactPerson'>) {
  return (
    <section role="alert" aria-label="Contact person" className="glass rounded-xl px-4 py-3 text-sm">
      <p>
        The contact person of this invoice no longer works for the customer. Choose another contact person or remove
        the contact person; the invoice cannot be issued until you do.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {contactPersons && contactPersons.length > 0 ? (
          <select
            aria-label="Choose another contact person"
            value=""
            disabled={busy}
            onChange={(e) => e.target.value && void change(() => booksApi.setContactPerson(id, e.target.value, version))}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Choose another…</option>
            {contactPersons.map((p) => (
              <option key={p.affiliationId} value={p.contactId}>
                {personLabel(p)}
              </option>
            ))}
          </select>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(() => booksApi.setContactPerson(id, null, version))}>
          Remove the contact person
        </Button>
      </div>
    </section>
  );
}
