// @vitest-environment node
//
// The pure parts of the shop's receipt email (docs/plans/2026-10-27-shop-receipt-email.md): the send key sealed
// at rest, the signed receipt links, the configuration, and the two templates checked against Lumitra Mail's own
// contract (what it would refuse is refused here first).
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TemplateCreate,
  TemplateInputsDeclaration,
  findMergeFields,
  TRANSACTIONAL_UNSUBSCRIBE_URL_REFUSAL,
} from '@marlinjai/mail-contract';

vi.mock('server-only', () => ({}));

import { seal, unseal } from '../seal';
import { readReceiptToken, receiptToken } from '../receiptLink';
import { receiptLinkBase, receiptLinkKey, shopMailConfig } from '../config';
import { MAIL_INPUTS, SHOP_MAIL_KINDS, TEMPLATE_LOCALES, templateCreate, templatesVersion } from '../templates';
import { callKey, nextAttemptDelayMsForTest } from './support';

const key = () => randomBytes(32);
const REF = { tenantGroupId: '01a12d22-54a4-72a3-a0ce-f65f9f518e81', tenantId: '01a178f6-a324-7ba9-835e-ba13cd55e8b8', documentId: '5b2c1f0e-1d3a-4b7e-9c11-2a6f8e0d4c10' };

describe('the send key at rest', () => {
  it('opens with its key, and fails loudly with another key or a changed text', () => {
    const k = key();
    const secretLike = `send-${randomBytes(16).toString('hex')}`;
    const sealed = seal(k, secretLike);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(secretLike);
    expect(unseal(k, sealed)).toBe(secretLike);
    expect(() => unseal(key(), sealed)).toThrow();
    const parts = sealed.split(':');
    parts[3] = Buffer.from('changed').toString('base64url');
    expect(() => unseal(k, parts.join(':'))).toThrow();
    expect(() => unseal(k, 'v2:a:b:c')).toThrow(/unknown form/);
  });

  it('never seals the same text twice the same way', () => {
    const k = key();
    expect(seal(k, 'same')).not.toBe(seal(k, 'same'));
  });
});

describe('the receipt link', () => {
  it('names exactly the document it was signed for', () => {
    const k = key();
    const token = receiptToken(k, REF);
    expect(readReceiptToken(k, token)).toEqual(REF);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('is refused when signed with another key, changed, or not a token at all', () => {
    const k = key();
    const token = receiptToken(k, REF);
    expect(readReceiptToken(key(), token)).toBeNull();
    const [v, payload, sig] = token.split('.');
    const other = Buffer.from(JSON.stringify({ g: REF.tenantGroupId, t: REF.tenantId, d: 'another-document' })).toString('base64url');
    expect(readReceiptToken(k, `${v}.${other}.${sig}`)).toBeNull();
    expect(readReceiptToken(k, `${v}.${payload}.${sig.slice(0, -2)}`)).toBeNull();
    expect(readReceiptToken(k, `v2.${payload}.${sig}`)).toBeNull();
    for (const bad of ['', 'v1', 'v1..', 'x'.repeat(700)]) expect(readReceiptToken(k, bad)).toBeNull();
  });
});

describe('the configuration', () => {
  const hex = () => randomBytes(32).toString('hex');

  it('is off while a value is missing or a placeholder, and loud on a malformed key', () => {
    expect(shopMailConfig({})).toBeNull();
    expect(shopMailConfig({ LUMITRA_MAIL_SERVICE_TOKEN: 'PLACEHOLDER_REPLACE_ME', SHOP_MAIL_KEY: hex() })).toBeNull();
    expect(() => shopMailConfig({ LUMITRA_MAIL_SERVICE_TOKEN: hex(), SHOP_MAIL_KEY: 'short' })).toThrow(/SHOP_MAIL_KEY/);
    const config = shopMailConfig({ LUMITRA_MAIL_SERVICE_TOKEN: hex(), SHOP_MAIL_KEY: hex() })!;
    expect(config.serviceUrl).toBe('https://mail.lumitra.co');
    expect(config.sealKey).toHaveLength(32);
    expect(shopMailConfig({ LUMITRA_MAIL_SERVICE_TOKEN: hex(), SHOP_MAIL_KEY: hex(), LUMITRA_MAIL_URL: 'http://localhost:3000/' })!.serviceUrl).toBe('http://localhost:3000');
    expect(receiptLinkKey({})).toBeNull();
    expect(() => receiptLinkKey({ RECEIPT_LINK_KEY: 'nope' })).toThrow(/RECEIPT_LINK_KEY/);
    expect(receiptLinkBase({ EDITOR_HOST: 'app.lumitra.co' })).toBe('https://app.lumitra.co');
    expect(receiptLinkBase({})).toBe('https://app.lumitra.co');
  });
});

describe('the two templates', () => {
  it('are templates Lumitra Mail accepts, German first with a ready English version', () => {
    for (const kind of SHOP_MAIL_KINDS) {
      const create = templateCreate(kind);
      const parsed = TemplateCreate.safeParse(create);
      expect(parsed.success, `${kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 400)}`).toBe(true);
      expect(create.locale).toBe('de');
      expect(Object.keys(create.translations ?? {})).toEqual(TEMPLATE_LOCALES.filter((l) => l !== 'de'));
    }
  });

  it('declare inputs Lumitra Mail accepts, and read no value they do not declare', () => {
    for (const kind of SHOP_MAIL_KINDS) {
      const declaration = TemplateInputsDeclaration.safeParse({ app: 'Lumitra Sites', app_version: 'test', inputs: MAIL_INPUTS[kind] });
      expect(declaration.success, kind).toBe(true);
      const create = templateCreate(kind);
      const text = JSON.stringify([create.subject, create.preheader, create.document, create.translations]);
      const read = new Set(findMergeFields(text).map((f: { name: string }) => f.name));
      // The greeting is an insertion chosen by first_name, filled by the service.
      read.delete('greeting');
      for (const name of read) expect(Object.keys(MAIL_INPUTS[kind]), `${kind} reads ${name}`).toContain(name);
      // Transactional: no unsubscribe link anywhere.
      expect(text).not.toContain('unsubscribe_url');
      expect(TRANSACTIONAL_UNSUBSCRIBE_URL_REFUSAL).toBeTruthy();
    }
  });

  it('the confirmation links the receipt, and the version changes only with what is installed', () => {
    expect(JSON.stringify(templateCreate('order_confirmation').document)).toContain('{{receipt_url}}');
    expect(templatesVersion()).toBe(templatesVersion());
    expect(templatesVersion()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('retries and call keys', () => {
  it('waits 1, 5, 15 and 60 minutes, then 6 hours', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => nextAttemptDelayMsForTest(n) / 60_000)).toEqual([1, 5, 15, 60, 360, 360]);
  });

  it('keeps a call key within what Lumitra Mail takes', () => {
    expect(callKey('shop:a:b:order_confirmation', 'send')).toBe('shop:a:b:order_confirmation:send');
    const long = callKey(`shop:${'x'.repeat(300)}`, 'send');
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long).toMatch(/^sha256:[0-9a-f]{64}:send$/);
  });
});
