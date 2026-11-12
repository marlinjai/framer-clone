// The notification letter's text: shortened, one line, escaped by Lumitra Mail (not here), localized yes and no.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { summaryText } from '../notify';
import { notificationNote } from '@/components/forms/FormSubmissionsPanel';

describe('summaryText', () => {
  it('writes "label: value" per field on one line, whatever line breaks the visitor typed', () => {
    const text = summaryText(
      [
        { key: 'name', label: 'Name', type: 'text', value: 'Ana' },
        { key: 'message', label: 'Message', type: 'textarea', value: 'Hello\n\n  there\r\nfriend' },
      ],
      'en',
    );
    expect(text).toBe('Name: Ana | Message: Hello there friend');
  });
  it('shows a checkbox as yes or no in the letter language', () => {
    const fields = [{ key: 'c', label: 'Consent', type: 'consent' as const, value: true }];
    expect(summaryText(fields, 'de')).toBe('Consent: ja');
    expect(summaryText([{ ...fields[0], value: false }], 'en')).toBe('Consent: no');
  });
  it('shortens each value and the whole, inside the 2000 characters a merge value may have', () => {
    const long = 'x'.repeat(5000);
    const one = summaryText([{ key: 'm', label: 'Message', type: 'textarea', value: long }], 'en');
    expect(one.length).toBeLessThan(400);
    expect(one.endsWith('…')).toBe(true);
    const many = summaryText(Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `Field ${i}`, type: 'text' as const, value: 'y'.repeat(200) })), 'en');
    expect(many.length).toBeLessThanOrEqual(1800);
  });
});

describe('what the owner is told in the inbox', () => {
  it('says nothing for a submission from before notifications', () => {
    expect(notificationNote(null)).toBeNull();
  });
  it('reports sent and pending quietly, with no resend', () => {
    expect(notificationNote({ status: 'sent', reason: null, recipient: 'a@b.example' })).toMatchObject({ tone: 'ok', canResend: false });
    expect(notificationNote({ status: 'pending', reason: null, recipient: 'a@b.example' })).toMatchObject({ tone: 'ok', canResend: false });
  });
  it('offers a resend for a failure and for "not connected", with the reason', () => {
    expect(notificationNote({ status: 'failed', reason: 'Lumitra Mail refused', recipient: 'a@b.example' })).toMatchObject({ tone: 'warn', canResend: true });
    const notConnected = notificationNote({ status: 'skipped', reason: 'not_connected', recipient: 'a@b.example' });
    expect(notConnected).toMatchObject({ tone: 'warn', canResend: true });
    expect(notConnected?.text).toMatch(/payments page/);
  });
  it('offers a resend for a blocked address and for a missing recipient too, and says what to do first', () => {
    const blocked = notificationNote({ status: 'blocked', reason: null, recipient: 'a@b.example' });
    expect(blocked).toMatchObject({ tone: 'warn', canResend: true });
    expect(blocked?.text).toMatch(/another address/);
    const none = notificationNote({ status: 'skipped', reason: 'no_recipient', recipient: null });
    expect(none).toMatchObject({ tone: 'warn', canResend: true });
    expect(none?.text).toMatch(/notification address/);
  });
});
