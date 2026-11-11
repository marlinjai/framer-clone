// src/app/projects/books/__tests__/ContactPersonsPanel.test.tsx
//
// The "Contact persons" section of a business customer, and the optional first contact person of the new-customer
// form, against a scripted /api/books server (fetch stubbed). The paths at the interface:
//   forward: open, add a new person with a role (name and role only), make them the default;
//   backtrack: end a person (the default clears), cancel an add;
//   resume: reopening shows what the server holds; a failed read is said, not shown as "none";
//   re-entry: after an add the form is closed and ready for the next one.
// All data is synthetic.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ContactPersonsPanel from '../ContactPersonsPanel';
import CustomerForm from '../CustomerForm';
import type { CustomerView } from '@/lib/books/api';

type Json = Record<string, unknown>;
type Handler = (body: Json | null, url: string) => { status: number; body: unknown };
let calls: Array<{ method: string; url: string; body: Json | null }>;

function server(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
      calls.push({ method, url, body });
      const handler = routes[`${method} ${url.split('?')[0]}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
      const res = handler(body, url);
      return new Response(JSON.stringify(res.body), { status: res.status });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const business = (over: Partial<CustomerView> = {}): CustomerView =>
  ({
    id: 'cust-1',
    contactId: 'c1',
    customerType: 'b2b',
    vatId: null,
    countryCode: 'DE',
    taxNumber: null,
    defaultContactPersonId: null,
    archivedAt: null,
    contact: { name: 'Sample GmbH' },
    contactStatus: 'ok',
    drift: [],
    ...over,
  }) as unknown as CustomerView;

const ANNA = { affiliationId: 'aff-1', contactId: 'p1', name: 'Anna Beispiel', role: 'Einkauf', startedOn: null, primary: true };

describe('ContactPersonsPanel', () => {
  it('a private-person customer has no contact persons section', () => {
    server({});
    const { container } = render(<ContactPersonsPanel customer={business({ customerType: 'b2c' })} onCustomer={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('forward: opens, lists the people with their roles, adds a new person with a role (name and role only), shows them', async () => {
    let items: unknown[] = [ANNA];
    server({
      'GET /api/books/customers/cust-1/contact-persons': () => ({ status: 200, body: { items } }),
      'POST /api/books/customers/cust-1/contact-persons': (body) => {
        const created = { affiliationId: 'aff-2', contactId: 'p2', name: (body!.person as Json).name, role: body!.role ?? '', startedOn: null, primary: false };
        items = [...items, created];
        return { status: 201, body: created };
      },
    });
    render(<ContactPersonsPanel customer={business()} onCustomer={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Contact persons' }));
    const list = await screen.findByRole('list', { name: 'Contact persons of Sample GmbH' });
    expect(within(list).getByText('Anna Beispiel')).toBeTruthy();
    expect(within(list).getByText('Einkauf')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add a contact person' }));
    const form = screen.getByRole('form', { name: 'Add a contact person' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Ben Muster ' } });
    fireEvent.change(within(form).getByLabelText(/Role at this business/), { target: { value: 'Leitung' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Contact persons of Sample GmbH' })).getByText('Ben Muster')).toBeTruthy());
    // Only a name and a role are sent: no mail address, no phone number.
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ person: { name: 'Ben Muster' }, role: 'Leitung' });
    // Re-entry: the form closed and is offered again.
    expect(screen.queryByRole('form', { name: 'Add a contact person' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a contact person' })).toBeTruthy();
  });

  it('backtrack: cancelling an add sends nothing; ending a person that is the default clears the default', async () => {
    let items: unknown[] = [ANNA];
    const onCustomer = vi.fn();
    server({
      'GET /api/books/customers/cust-1/contact-persons': () => ({ status: 200, body: { items } }),
      'DELETE /api/books/customers/cust-1/contact-persons/aff-1': () => {
        items = [];
        return { status: 200, body: { items } };
      },
    });
    render(<ContactPersonsPanel customer={business({ defaultContactPersonId: 'p1' })} onCustomer={onCustomer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Contact persons' }));
    await screen.findByText('Anna Beispiel');
    expect(screen.getByText(/default for new invoices/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add a contact person' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await screen.findByText('No contact persons yet.');
    expect(onCustomer).toHaveBeenCalledWith(expect.objectContaining({ defaultContactPersonId: null }));
  });

  it('makes a person the default and takes the customer the server answers', async () => {
    const onCustomer = vi.fn();
    server({
      'GET /api/books/customers/cust-1/contact-persons': () => ({ status: 200, body: { items: [ANNA] } }),
      'PUT /api/books/customers/cust-1/default-contact-person': (body) => ({ status: 200, body: { ...business(), defaultContactPersonId: body!.contactPersonId } }),
    });
    render(<ContactPersonsPanel customer={business()} onCustomer={onCustomer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Contact persons' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(onCustomer).toHaveBeenCalledWith(expect.objectContaining({ defaultContactPersonId: 'p1' })));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ contactPersonId: 'p1' });
  });

  it('resume: a read that fails is said, and the list is not shown as empty', async () => {
    server({ 'GET /api/books/customers/cust-1/contact-persons': () => ({ status: 503, body: { error: { code: 'recipient_unavailable', message: 'down' } } }) });
    render(<ContactPersonsPanel customer={business()} onCustomer={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Contact persons' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('No contact persons yet.')).toBeNull();
  });

  it('a refused add (the person exists) names the reason and keeps what was typed', async () => {
    server({
      'GET /api/books/customers/cust-1/contact-persons': () => ({ status: 200, body: { items: [] } }),
      'POST /api/books/customers/cust-1/contact-persons': () => ({ status: 409, body: { error: { code: 'duplicate_contact', message: 'a contact with this name already exists' } } }),
    });
    render(<ContactPersonsPanel customer={business()} onCustomer={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Contact persons' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a contact person' }));
    const form = screen.getByRole('form', { name: 'Add a contact person' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Anna Beispiel' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await within(form).findByRole('alert');
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Anna Beispiel');
  });
});

describe('CustomerForm: the first contact person', () => {
  const fill = () => {
    fireEvent.click(screen.getByRole('button', { name: 'New contact' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New GmbH' } });
  };

  it('creates the business, then its first contact person with the role, in one step', async () => {
    const created = { ...business(), id: 'cust-9' };
    const onCreated = vi.fn();
    server({
      'GET /api/books/contacts': () => ({ status: 200, body: { items: [] } }),
      'POST /api/books/customers': () => ({ status: 201, body: created }),
      'POST /api/books/customers/cust-9/contact-persons': () => ({ status: 201, body: ANNA }),
    });
    render(<CustomerForm onCreated={onCreated} onCancel={() => {}} />);
    fill();
    fireEvent.change(screen.getByLabelText('First contact person (optional)'), { target: { value: 'Anna Beispiel' } });
    fireEvent.change(screen.getByLabelText('Their role (optional)'), { target: { value: 'Einkauf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, undefined));
    expect(calls.find((c) => c.url.endsWith('/contact-persons'))!.body).toEqual({ person: { name: 'Anna Beispiel' }, role: 'Einkauf' });
  });

  it('a private person gets no contact person fields; a business without one creates only the customer', async () => {
    server({
      'GET /api/books/contacts': () => ({ status: 200, body: { items: [] } }),
      'POST /api/books/customers': () => ({ status: 201, body: business() }),
    });
    const onCreated = vi.fn();
    render(<CustomerForm onCreated={onCreated} onCancel={() => {}} />);
    fill();
    fireEvent.change(screen.getByLabelText('Customer is'), { target: { value: 'b2c' } });
    expect(screen.queryByLabelText('First contact person (optional)')).toBeNull();
    fireEvent.change(screen.getByLabelText('Customer is'), { target: { value: 'b2b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.some((c) => c.url.endsWith('/contact-persons'))).toBe(false);
  });

  it('when the person cannot be added the customer still exists and the list is told what is missing', async () => {
    const onCreated = vi.fn();
    server({
      'GET /api/books/contacts': () => ({ status: 200, body: { items: [] } }),
      'POST /api/books/customers': () => ({ status: 201, body: { ...business(), id: 'cust-9' } }),
      'POST /api/books/customers/cust-9/contact-persons': () => ({ status: 409, body: { error: { code: 'duplicate_contact', message: 'a contact with this name already exists' } } }),
    });
    render(<CustomerForm onCreated={onCreated} onCancel={() => {}} />);
    fill();
    fireEvent.change(screen.getByLabelText('First contact person (optional)'), { target: { value: 'Anna Beispiel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create customer' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0]![1]).toMatch(/customer was created, but the contact person could not be added/);
  });
});
