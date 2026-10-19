// src/app/projects/__tests__/NewProjectButton.test.tsx
//
// The "New project" button surfaces every failure as a readable message: a
// permission-service outage (503 authz_unavailable) reads as temporary, never
// as "Forbidden", and a real deny keeps the server's own message.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import NewProjectButton from '../NewProjectButton';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function clickAndReadAlert(): Promise<string> {
  render(<NewProjectButton />);
  fireEvent.click(screen.getByRole('button', { name: /new project/i }));
  return (await screen.findByRole('alert')).textContent ?? '';
}

describe('NewProjectButton', () => {
  it('explains a permission-service outage (503 authz_unavailable) as temporary', async () => {
    respond(503, { error: { code: 'authz_unavailable', message: 'x' } });
    const text = await clickAndReadAlert();
    expect(text).toMatch(/permission service is temporarily unavailable/i);
    expect(text).not.toMatch(/forbidden/i);
    expect(screen.getByRole('button', { name: /new project/i })).not.toHaveProperty('disabled', true);
  });

  it('explains a sign-in outage (503 auth_unavailable) as temporary', async () => {
    respond(503, { error: { code: 'auth_unavailable', message: 'x' } });
    expect(await clickAndReadAlert()).toMatch(/sign-in service is temporarily unavailable/i);
  });

  it('shows the server message for a real deny', async () => {
    respond(403, { error: { code: 'forbidden', message: 'Forbidden' } });
    expect(await clickAndReadAlert()).toBe('Could not create a new project: Forbidden');
  });

  it('navigates to the new project on success', async () => {
    respond(200, { siteId: 'site_new' });
    render(<NewProjectButton />);
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/projects/site_new'));
  });
});
