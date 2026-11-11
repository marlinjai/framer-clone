'use client';

// src/app/projects/books/ContactPersonsPanel.tsx
//
// The people at a business customer ("Contact persons"), opened from the customer's row. Each is a person of the
// shared contacts database with an open affiliation to the customer's business and the role they hold there. A new
// person is created in the shared database and affiliated in one step (name and role only: no mail address or phone
// is taken here); an existing person is found by search. "End" stops the affiliation (the contacts database keeps the
// row as history; drafts that point at the person show them as gone and cannot be issued until changed). "Default"
// is whom a new draft for this customer is addressed to. A private-person customer has no contact persons.

import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { booksApi, type ContactLabel, type ContactPersonView, type CustomerView } from '@/lib/books/api';

import { ErrorAlert, Field, errorText } from './ui';

type Mode = 'search' | 'new';

interface Props {
  customer: CustomerView;
  /** The customer changed (its default contact person); the list shows the new value. */
  onCustomer: (customer: CustomerView) => void;
}

export default function ContactPersonsPanel({ customer, onCustomer }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ContactPersonView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open || items !== null) return;
    let cancelled = false;
    booksApi
      .contactPersons(customer.id)
      .then((r) => !cancelled && setItems(r.items))
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [open, items, customer.id]);

  if (customer.customerType !== 'b2b') return null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const end = (p: ContactPersonView) =>
    run(async () => {
      const r = await booksApi.endContactPerson(customer.id, p.affiliationId);
      setItems(r.items);
      if (customer.defaultContactPersonId === p.contactId) onCustomer({ ...customer, defaultContactPersonId: null });
    });

  const setDefault = (contactId: string | null) =>
    run(async () => onCustomer(await booksApi.setDefaultContactPerson(customer.id, contactId)));

  return (
    <div className="mt-3 border-t pt-3">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={`persons-${customer.id}`}
        onClick={() => setOpen(!open)}
      >
        Contact persons
      </Button>
      {open ? (
        <div id={`persons-${customer.id}`} className="mt-2 flex flex-col gap-2">
          <ErrorAlert message={error} onDismiss={() => setError(null)} />
          {items === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contact persons yet.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label={`Contact persons of ${customer.contact?.name ?? 'this customer'}`}>
              {items.map((p) => (
                <li key={p.affiliationId} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.role || 'No role recorded'}
                      {customer.defaultContactPersonId === p.contactId ? ' · default for new invoices' : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {customer.defaultContactPersonId === p.contactId ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setDefault(null)}>
                        Not the default
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setDefault(p.contactId)}>
                        Make default
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void end(p)}>
                      End
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {adding ? (
            <AddPerson
              customerId={customer.id}
              onAdded={(p) => {
                setItems([...(items ?? []), p]);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <div>
              <Button size="sm" variant="outline" disabled={busy || items === null} onClick={() => setAdding(true)}>
                Add a contact person
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AddPerson({
  customerId,
  onAdded,
  onCancel,
}: {
  customerId: string;
  onAdded: (p: ContactPersonView) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<Mode>('new');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ContactLabel[] | null>(null);
  const [picked, setPicked] = useState<ContactLabel | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'search') return;
    let cancelled = false;
    const t = setTimeout(() => {
      booksApi
        .searchContacts(search)
        .then((r) => !cancelled && setResults(r.items.filter((c) => c.kind === 'person')))
        .catch((err) => !cancelled && setError(errorText(err)));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'search' ? { contactId: picked!.id, role: role.trim() || null } : { person: { name: name.trim() }, role: role.trim() || null };
      onAdded(await booksApi.addContactPerson(customerId, body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = mode === 'search' ? picked !== null : name.trim() !== '';

  return (
    <form onSubmit={submit} className="rounded-md border p-3" aria-label="Add a contact person">
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="mb-3 flex gap-2 text-sm">
        <Button type="button" size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>
          New person
        </Button>
        <Button type="button" size="sm" variant={mode === 'search' ? 'default' : 'outline'} onClick={() => setMode('search')}>
          Existing person
        </Button>
      </div>
      {mode === 'new' ? (
        <Field label="Name" htmlFor={`cp-name-${customerId}`}>
          <Input id={`cp-name-${customerId}`} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          <Field label="Search persons" htmlFor={`cp-search-${customerId}`}>
            <Input id={`cp-search-${customerId}`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name" />
          </Field>
          <ul className="max-h-40 overflow-auto rounded-md border">
            {results === null ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">Loading…</li>
            ) : results.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No person found. Use “New person”.</li>
            ) : (
              results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={picked?.id === c.id}
                    onClick={() => setPicked(c)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${picked?.id === c.id ? 'bg-accent' : ''}`}
                  >
                    {c.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
      <Field label="Role at this business (optional)" htmlFor={`cp-role-${customerId}`} hint="For example Einkauf or Geschäftsführung. Printed after the name.">
        <Input id={`cp-role-${customerId}`} maxLength={160} value={role} onChange={(e) => setRole(e.target.value)} />
      </Field>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || busy}>
          {busy ? 'Saving…' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
