'use client';

// src/app/projects/books/CustomerForm.tsx
//
// New customer. Name and address live in the shared contacts database (one
// list for the whole suite), the customer row only holds the tax fields, so
// the form first searches the company's contacts: picking one creates the
// customer for it; when the recipient is not there yet, "New contact" creates
// the contact and the customer in one step. A contact that is already a
// customer is shown as such and not offered twice.

import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { booksApi, type ContactLabel, type CustomerView } from '@/lib/books/api';

import { ErrorAlert, Field, errorText } from './ui';

interface Props {
  onCreated: (customer: CustomerView) => void;
  onCancel: () => void;
}

type Mode = 'search' | 'new';

export default function CustomerForm({ onCreated, onCancel }: Props) {
  const [mode, setMode] = useState<Mode>('search');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ContactLabel[] | null>(null);
  const [picked, setPicked] = useState<ContactLabel | null>(null);
  const [customerType, setCustomerType] = useState<'b2b' | 'b2c'>('b2b');
  const [vatId, setVatId] = useState('');
  const [contact, setContact] = useState({
    name: '',
    addressLine1: '',
    postalCode: '',
    city: '',
    country: 'DE',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'search') return;
    let cancelled = false;
    const t = setTimeout(() => {
      booksApi
        .searchContacts(search)
        .then((r) => {
          if (!cancelled) setResults(r.items);
        })
        .catch((err) => {
          if (!cancelled) setError(errorText(err));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const tax = { customerType, vatId: vatId.trim() === '' ? null : vatId.trim() };
      const body =
        mode === 'search'
          ? { contactId: picked!.id, ...tax }
          : {
              contact: {
                kind: customerType === 'b2b' ? 'organization' : 'person',
                name: contact.name,
                addressLine1: contact.addressLine1 || null,
                postalCode: contact.postalCode || null,
                city: contact.city || null,
                country: contact.country.trim().toUpperCase() || null,
                vatId: tax.vatId,
              },
              countryCode: contact.country.trim().toUpperCase() || 'DE',
              ...tax,
            };
      onCreated(await booksApi.createCustomer(body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = mode === 'search' ? picked !== null && !picked.customerId : contact.name.trim() !== '';

  return (
    <form onSubmit={submit} className="rounded-lg border p-4" aria-label="New customer">
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="mb-4 flex gap-2 text-sm">
        <Button type="button" size="sm" variant={mode === 'search' ? 'default' : 'outline'} onClick={() => setMode('search')}>
          Existing contact
        </Button>
        <Button type="button" size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>
          New contact
        </Button>
      </div>

      {mode === 'search' ? (
        <div className="mb-4 flex flex-col gap-2">
          <Field label="Search contacts" htmlFor="contact-search">
            <Input id="contact-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, company or e-mail" />
          </Field>
          <ul className="max-h-56 overflow-auto rounded-md border">
            {results === null ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">Loading contacts…</li>
            ) : results.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No contact found. Use “New contact”.</li>
            ) : (
              results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={Boolean(c.customerId)}
                    onClick={() => setPicked(c)}
                    aria-pressed={picked?.id === c.id}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-60 ${picked?.id === c.id ? 'bg-accent' : ''}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[c.addressLine1, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') ||
                          'No address yet'}
                      </span>
                    </span>
                    {c.customerId ? <span className="text-xs text-muted-foreground">Already a customer</span> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="contact-name">
            <Input id="contact-name" required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
          </Field>
          <Field label="Street and number" htmlFor="contact-street">
            <Input id="contact-street" value={contact.addressLine1} onChange={(e) => setContact({ ...contact, addressLine1: e.target.value })} />
          </Field>
          <Field label="Postal code" htmlFor="contact-postal">
            <Input id="contact-postal" value={contact.postalCode} onChange={(e) => setContact({ ...contact, postalCode: e.target.value })} />
          </Field>
          <Field label="City" htmlFor="contact-city">
            <Input id="contact-city" value={contact.city} onChange={(e) => setContact({ ...contact, city: e.target.value })} />
          </Field>
          <Field label="Country (two letters)" htmlFor="contact-country">
            <Input id="contact-country" maxLength={2} value={contact.country} onChange={(e) => setContact({ ...contact, country: e.target.value })} />
          </Field>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Customer is" htmlFor="customer-type">
          <select
            id="customer-type"
            value={customerType}
            onChange={(e) => setCustomerType(e.target.value as 'b2b' | 'b2c')}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="b2b">a business</option>
            <option value="b2c">a private person</option>
          </select>
        </Field>
        <Field label="VAT id (optional)" htmlFor="customer-vat" hint="Needed for reverse charge to EU businesses.">
          <Input id="customer-vat" value={vatId} onChange={(e) => setVatId(e.target.value)} placeholder="FR12345678901" />
        </Field>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || busy}>
          {busy ? 'Saving…' : 'Create customer'}
        </Button>
      </div>
    </form>
  );
}
