// src/app/projects/__tests__/AuthUnavailable.test.tsx
//
// The outage notice: an alert with a retry link to the same address, and no
// link to the login.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AuthUnavailable from '../AuthUnavailable';

afterEach(() => cleanup());

describe('AuthUnavailable', () => {
  it('shows a retry link to the same page and nothing pointing at the login', () => {
    const { container } = render(<AuthUnavailable retryHref="/projects/site_1/preview" />);
    expect(screen.getByRole('alert').textContent).toMatch(/sign-in service unavailable/i);
    expect(screen.getByRole('link', { name: /retry/i }).getAttribute('href')).toBe(
      '/projects/site_1/preview',
    );
    expect(container.innerHTML).not.toContain('/login');
  });
});
