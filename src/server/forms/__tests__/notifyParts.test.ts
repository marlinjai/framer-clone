// The notification letter's text: shortened, one line, escaped by Lumitra Mail (not here), localized yes and no.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GIVE_UP_AFTER_MS } from '@/server/commerce/mail/outbox';
import { formMailKey, summaryText } from '../notify';
import { formMailKind } from '../notifyJob';
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
  it('never cuts a character in half, at the limit of a value or of the whole', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const field = (label: string, value: string) => ({ key: label, label, type: 'textarea' as const, value });
    const one = summaryText([field('M', `${'a'.repeat(298)}😀!`)], 'en');
    expect(one).toBe(`M: ${'a'.repeat(298)}…`);
    // Every alignment of the emoji against the limit of the whole.
    for (let pad = 0; pad < 4; pad += 1) {
      const whole = summaryText(Array.from({ length: 10 }, (_, i) => field(`F${i}${'x'.repeat(i === 0 ? pad : 0)}`, '😀'.repeat(140))), 'en');
      expect(whole.length).toBeLessThanOrEqual(1800);
      expect(whole).not.toMatch(lone);
    }
    // A value that fits is left as it is.
    expect(summaryText([field('M', `${'a'.repeat(298)}😀`)], 'en')).toBe(`M: ${'a'.repeat(298)}😀`);
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

describe('the form_mail job policy', () => {
  it('leaves the delivery room to end a round: the runner gives up only after many more retries past the three days', () => {
    const { giveUpAfterMs, laterMinutes } = formMailKind.policy;
    expect(giveUpAfterMs! - GIVE_UP_AFTER_MS).toBeGreaterThanOrEqual(20 * laterMinutes * 60 * 1000);
  });
});

describe('the idempotency key of a letter', () => {
  const letter = { workspaceId: 'ws-a', merge: { site_name: 'Bakery' } };
  it('is the same for the same frozen letter, so a retry is replayed, never sent twice', () => {
    expect(formMailKey('c', 's', 1, letter)).toBe(formMailKey('c', 's', 1, { ...letter, merge: { site_name: 'Bakery' } } as typeof letter));
  });
  it('differs when the letter was rebuilt with another body, as after a reconnect A to B to A with the site renamed', () => {
    expect(formMailKey('c', 's', 1, letter)).not.toBe(formMailKey('c', 's', 1, { ...letter, merge: { site_name: 'Bakery 2' } } as typeof letter));
  });
  it('keeps the round and the workspace in the key', () => {
    expect(formMailKey('c', 's', 2, letter)).toContain(':2:ws-a:');
  });
});

describe('the new inbox lines', () => {
  it('tells the owner a notice that could not be prepared, with no resend', () => {
    expect(notificationNote({ status: 'skipped', reason: 'internal_error', recipient: null })).toMatchObject({ tone: 'warn', canResend: false });
  });
  it('tells the owner the hourly cap was reached, and allows a later resend', () => {
    const note = notificationNote({ status: 'skipped', reason: 'rate_limited', recipient: 'a@b.example' });
    expect(note).toMatchObject({ tone: 'warn', canResend: true });
    expect(note?.text).toMatch(/100/);
  });
});
// ci-replay touch
