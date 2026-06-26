// FakePaymentGateway: the DEMO provider. It SIMULATES an authorization (no real
// money), validates the amount, declines on demand, and returns a transaction
// reference on success.
import { describe, it, expect } from 'vitest';
import { FakePaymentGateway, DEMO_PROVIDER_ID, getPaymentGateway } from '../index';

const gw = () => new FakePaymentGateway({ latencyMs: 0 });

describe('FakePaymentGateway', () => {
  it('is flagged as a demo gateway with the demo provider id', () => {
    const g = gw();
    expect(g.isDemo).toBe(true);
    expect(g.id).toBe(DEMO_PROVIDER_ID);
  });

  it('authorizes a valid amount and returns a demo transaction reference', async () => {
    const result = await gw().authorize({ orderId: 'o1', amountCents: 1999, currency: 'EUR' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe('demo');
      expect(result.transactionId).toMatch(/^demo_txn_/);
    }
  });

  it('declines when simulateDecline is set (the demo failure path)', async () => {
    const result = await gw().authorize({
      orderId: 'o1',
      amountCents: 1999,
      currency: 'EUR',
      simulateDecline: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('declined');
      expect(result.message).toMatch(/declined/i);
    }
  });

  it('rejects a non-positive amount as invalid (never a silent success)', async () => {
    const result = await gw().authorize({ orderId: 'o1', amountCents: 0, currency: 'EUR' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('rejects a non-integer amount as invalid', async () => {
    const result = await gw().authorize({ orderId: 'o1', amountCents: 12.5, currency: 'EUR' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('rejects a missing currency as invalid', async () => {
    const result = await gw().authorize({ orderId: 'o1', amountCents: 100, currency: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });
});

describe('getPaymentGateway (the provider seam)', () => {
  it('returns the demo gateway today', () => {
    const g = getPaymentGateway();
    expect(g.isDemo).toBe(true);
    expect(g.id).toBe('demo');
  });
});
