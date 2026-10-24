// The published form island in a browser-like DOM: accessible markup, validate
// on blur and submit, the loading state and double-submit guard, success
// (inline and redirect), failure, and the four paths of the stateful flow
// standard (forward, backtrack and revise, resume after a reload, re-entry
// after success or failure).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { draftKey } from '@/lib/forms/formState';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { createScope } from '@/lib/bindings/resolver/scope';
import { renderComponentNode } from '../../server/renderComponentNode';
import FormIsland from '../FormIsland';

function formNode(props: Record<string, unknown> = {}): ComponentNode {
  return {
    id: 'form-1',
    type: 'div',
    props: { [FORM_KIND_ATTR]: 'form', formName: 'Contact', successMessage: 'Thanks, we will reply.', style: { padding: '24px' }, ...props },
    children: [
      {
        id: 'row',
        type: 'div',
        props: { style: { display: 'grid' } },
        children: [
          { id: 'f-name', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', label: 'Name', required: true } },
          { id: 'f-email', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'email', name: 'email', label: 'Email', required: true } },
        ],
      },
      { id: 'f-consent', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'consent', name: 'consent', label: 'I agree to the privacy policy' } },
      { id: 'send', type: 'button', props: { [FORM_KIND_ATTR]: 'form-submit', children: 'Send request', loadingLabel: 'Sending now' } },
    ],
  };
}

const RENDERED_AT = 1_700_000_000_000;

function mount(props: Record<string, unknown> = {}) {
  return render(<FormIsland node={formNode(props)} scope={createScope()} renderedAt={RENDERED_AT} />);
}

const nameInput = () => screen.getByLabelText(/^Name/) as HTMLInputElement;
const emailInput = () => screen.getByLabelText(/^Email/) as HTMLInputElement;
const consentBox = () => screen.getByLabelText(/I agree/) as HTMLInputElement;
const submitButton = () => screen.getByRole('button', { name: /Send request|Sending now/ }) as HTMLButtonElement;

function fillValid() {
  fireEvent.change(nameInput(), { target: { value: 'Ana' } });
  fireEvent.change(emailInput(), { target: { value: 'ana@example.com' } });
  fireEvent.click(consentBox());
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
const assign = vi.fn();

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
  document.documentElement.lang = 'en';
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
  assign.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('markup and no-JavaScript fallback', () => {
  it('server-renders a POST form with the hidden transport fields, real labels and no noValidate', () => {
    const html = renderToStaticMarkup(<>{renderComponentNode(formNode(), createScope())}</>);
    expect(html).toContain('<form');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/forms/submit"');
    expect(html).toContain('name="_form" value="form-1"');
    expect(html).toMatch(/name="_rendered" value="\d+"/);
    expect(html).toContain('name="_website"');
    expect(html).not.toContain('novalidate');
    expect(html).toMatch(/<label for="f-form-1-f-name"[^>]*>Name/);
    expect(html).toContain('id="f-form-1-f-name"');
    expect(html).toContain('name="name"');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="submit"');
    // Form configuration never reaches the DOM.
    expect(html).not.toContain('formName');
    expect(html).not.toContain('data-form-kind');
  });

  it('after hydration the island validates itself (noValidate)', async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('form')?.noValidate).toBe(true));
  });
});

describe('forward', () => {
  it('validates, sends JSON with the elapsed time and submission id, shows a loading state, then the message', async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    mount();
    fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(submitButton().textContent).toContain('Sending now');
    // A second click while sending sends nothing more.
    fireEvent.submit(submitButton().closest('form')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/forms/submit');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ formId: 'form-1', values: { name: 'Ana', email: 'ana@example.com', consent: true }, website: '', locale: 'en' });
    expect(typeof sent.elapsedMs).toBe('number');
    expect(sent.submissionId).toMatch(/^[0-9a-f-]{36}$/);

    await act(async () => answer.resolve(jsonResponse(200, { ok: true, submissionId: sent.submissionId, message: 'Thanks, we will reply.' })));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Thanks, we will reply.');
    expect(document.activeElement).toBe(status);
    expect(window.sessionStorage.getItem(draftKey('form-1'))).toBeNull();
  });

  it('navigates to the thank-you page the server names', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, redirectTo: '/danke' }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/danke'));
  });

  it('never follows an off-site redirect', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, redirectTo: '//evil.example', message: 'Thanks' }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByRole('status');
    expect(assign).not.toHaveBeenCalled();
  });

  it('submit with problems sends nothing, marks the fields invalid, wires the error text and focuses the first', async () => {
    mount();
    fireEvent.change(emailInput(), { target: { value: 'nope' } });
    fireEvent.click(submitButton());
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(nameInput().getAttribute('aria-invalid')).toBe('true'));
    expect(document.activeElement).toBe(nameInput());
    const errorId = emailInput().getAttribute('aria-describedby')!;
    expect(document.getElementById(errorId)?.textContent).toMatch(/valid email/);
    expect(consentBox().getAttribute('aria-invalid')).toBe('true');
  });

  it('validates a field when the visitor leaves it', async () => {
    mount();
    fireEvent.change(emailInput(), { target: { value: 'x@' } });
    fireEvent.blur(emailInput());
    await waitFor(() => expect(emailInput().getAttribute('aria-invalid')).toBe('true'));
    expect(nameInput().getAttribute('aria-invalid')).toBeNull();
  });
});

describe('backtrack and revise', () => {
  it('fixing a field clears its error only; a server field error is shown and cleared the same way', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { error: { code: 'invalid_fields', message: 'Some fields need your attention.', fieldErrors: { email: 'That address bounced.' } } }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(emailInput().getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('That address bounced.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Some fields need your attention.');
    fireEvent.change(emailInput(), { target: { value: 'ana@other.example' } });
    await waitFor(() => expect(emailInput().getAttribute('aria-invalid')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('a retry with the same values reuses the submission id, changed values get a new one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { code: 'submit_failed', message: 'x' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { code: 'submit_failed', message: 'x' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, message: 'ok' }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText(/could not be sent/);
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const id1 = JSON.parse(fetchMock.mock.calls[0][1].body).submissionId;
    const id2 = JSON.parse(fetchMock.mock.calls[1][1].body).submissionId;
    expect(id2).toBe(id1);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.change(nameInput(), { target: { value: 'Anna' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).submissionId).not.toBe(id1);
  });
});

describe('resume', () => {
  it('a reload restores the typed text but never the ticked consent', async () => {
    const first = mount();
    fillValid();
    await waitFor(() => expect(window.sessionStorage.getItem(draftKey('form-1'))).not.toBeNull());
    first.unmount();
    mount();
    await waitFor(() => expect(nameInput().value).toBe('Ana'));
    expect(emailInput().value).toBe('ana@example.com');
    expect(consentBox().checked).toBe(false);
  });

  it('a draft from an older version of the form is discarded', async () => {
    window.sessionStorage.setItem(draftKey('form-1'), JSON.stringify({ v: 1, signature: 'old', values: { name: 'Stale' } }));
    mount();
    await new Promise((r) => setTimeout(r, 0));
    expect(nameInput().value).toBe('');
  });
});

describe('re-entry after completion or failure', () => {
  it('"send another" after success shows a clean form', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, message: 'Thanks' }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Send another message' }));
    expect(nameInput().value).toBe('');
    expect(consentBox().checked).toBe(false);
    expect(nameInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('a network failure shows a form error, keeps the values and allows a new send', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, message: 'Thanks' }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    const alert = await screen.findByText(/Check your connection/);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(nameInput().value).toBe('Ana');
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await screen.findByRole('status');
  });

  it('a rate-limit answer shows its message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { code: 'rate_limited', message: 'Too many messages were sent in a short time.' } }));
    mount();
    fillValid();
    fireEvent.click(submitButton());
    await screen.findByText(/Too many messages/);
  });
});

describe('German pages', () => {
  it('shows German messages when the page language is German', async () => {
    document.documentElement.lang = 'de';
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /Send request/ })).toBeTruthy());
    fireEvent.click(submitButton());
    await screen.findAllByText('Bitte füllen Sie dieses Feld aus.');
  });
});
