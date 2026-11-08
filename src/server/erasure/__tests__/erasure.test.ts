// src/server/erasure/__tests__/erasure.test.ts
//
// The pure parts of the company erasure consumer (docs/plans/2026-11-05-company-erasure-consumer.md): the
// signature check, the payload parser, the agreement of the delete steps with the coverage map, and the
// scope merge. The database
// side is proven in companyErasure.itest.ts.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ERASURE_COVERAGE, ERASURE_STEPS, groupIdOfSchema } from '../commerce';
import { MAX_ERASURE_WORKSPACE_IDS, parseErasureDelivery } from '../payload';
import { mergeScope, parseScope } from '../public';
import { signErasureBody, verifyErasureSignature } from '../signature';

const secret = `unit-${randomUUID()}`;
const bytes = (text: string) => new TextEncoder().encode(text);

describe('verifyErasureSignature', () => {
  const body = '{"event_id":"e","kind":"tenant.erased"}';

  it('accepts the HMAC of the exact bytes, in either hex case', () => {
    const signature = signErasureBody(body, secret);
    expect(verifyErasureSignature(bytes(body), signature, secret)).toBe(true);
    expect(verifyErasureSignature(bytes(body), `sha256=${signature.slice(7).toUpperCase()}`, secret)).toBe(true);
  });

  it('refuses a changed body, another secret, a missing prefix, a malformed or absent header and an empty secret', () => {
    const signature = signErasureBody(body, secret);
    expect(verifyErasureSignature(bytes(`${body} `), signature, secret)).toBe(false);
    expect(verifyErasureSignature(bytes(body), signErasureBody(body, `${secret}x`), secret)).toBe(false);
    expect(verifyErasureSignature(bytes(body), signature.slice(7), secret)).toBe(false);
    expect(verifyErasureSignature(bytes(body), 'sha256=abc', secret)).toBe(false);
    expect(verifyErasureSignature(bytes(body), null, secret)).toBe(false);
    expect(verifyErasureSignature(bytes(body), signature, '')).toBe(false);
  });
});

describe('parseErasureDelivery', () => {
  const eventId = randomUUID();
  const tenantId = randomUUID();
  const base = { event_id: eventId, user_id: randomUUID(), requested_at: '2026-11-05T10:00:00.000Z' };

  it('reads a company erasure with its workspaces, lowercased and without duplicates', () => {
    const parsed = parseErasureDelivery(
      JSON.stringify({ ...base, kind: 'tenant.erased', tenant_id: tenantId.toUpperCase(), workspace_ids: ['w1', 'w1', 'w2'] }),
    );
    expect(parsed).toEqual({ kind: 'company', erasure: { eventId, companyId: tenantId, workspaceIds: ['w1', 'w2'] } });
  });

  it('requires a complete workspace list before acknowledging a company erasure', () => {
    const parsed = parseErasureDelivery(JSON.stringify({ ...base, kind: 'tenant.erased', tenant_id: tenantId, later: true }));
    expect(parsed).toMatchObject({ kind: 'incomplete', eventId });
  });

  it('accepts more than 1000 workspaces within the route body limit and tolerates added fields', () => {
    const workspaceIds = Array.from({ length: 1001 }, (_, i) => `workspace-${i}`);
    const parsed = parseErasureDelivery(JSON.stringify({ ...base, kind: 'tenant.erased', tenant_id: tenantId, workspace_ids: workspaceIds, later: true }));
    expect(parsed).toMatchObject({ kind: 'company', erasure: { workspaceIds } });
  });

  it('accepts event and tenant ids without RFC version or variant bits, as auth-brain derives them', () => {
    // Shaped like auth-brain's SHA-256 derived ids: version nibble 0 and variant nibble 0, which Zod 4's
    // uuid() refuses. Uppercase hex is read too, and lowercased.
    const derivedEventId = '3F2A9C1E-5B7D-0E4F-0A1B-2C3D4E5F6A7B';
    const derivedTenantId = 'c0ffee00-1234-0567-0890-abcdefabcdef';
    expect(parseErasureDelivery(JSON.stringify({ ...base, event_id: derivedEventId, kind: 'user.erased' }))).toEqual({
      kind: 'ignored',
      eventId: derivedEventId.toLowerCase(),
      reason: 'user.erased: no per-user personal data is kept here',
    });
    expect(
      parseErasureDelivery(
        JSON.stringify({ ...base, event_id: derivedEventId, kind: 'tenant.erased', tenant_id: derivedTenantId, workspace_ids: ['w1'] }),
      ),
    ).toEqual({ kind: 'company', erasure: { eventId: derivedEventId.toLowerCase(), companyId: derivedTenantId, workspaceIds: ['w1'] } });
  });

  it('refuses a workspace list longer than any body the route accepts, quickly', () => {
    const workspaceIds = Array.from({ length: MAX_ERASURE_WORKSPACE_IDS + 1 }, () => '');
    const started = performance.now();
    const parsed = parseErasureDelivery(JSON.stringify({ ...base, kind: 'tenant.erased', tenant_id: tenantId, workspace_ids: workspaceIds }));
    expect(parsed).toMatchObject({ kind: 'invalid' });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('acknowledges user.erased and unknown kinds without acting', () => {
    expect(parseErasureDelivery(JSON.stringify({ ...base, kind: 'user.erased' }))).toMatchObject({ kind: 'ignored', eventId });
    expect(parseErasureDelivery(JSON.stringify({ ...base, kind: 'workspace.erased' }))).toMatchObject({ kind: 'ignored' });
  });

  it('refuses what is not an erasure', () => {
    expect(parseErasureDelivery('not json')).toMatchObject({ kind: 'invalid' });
    expect(parseErasureDelivery(JSON.stringify({ ...base, kind: 'tenant.erased' }))).toMatchObject({ kind: 'invalid' });
    expect(parseErasureDelivery(JSON.stringify({ ...base, kind: 'tenant.erased', tenant_id: 'not-a-uuid' }))).toMatchObject({ kind: 'invalid' });
    expect(parseErasureDelivery(JSON.stringify({ ...base, event_id: 'x', kind: 'tenant.erased', tenant_id: tenantId }))).toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('the steps and the coverage map agree', () => {
  it('every table a step deletes from is in the coverage map, and every table it names as deleted has a step', () => {
    const stepTables = new Set(ERASURE_STEPS.flatMap((step) => step.label.split('+')));
    const reachedByCascade = Object.entries(ERASURE_COVERAGE)
      .filter(([, how]) => how.startsWith('cascade from') || how.startsWith('KEPT'))
      .map(([table]) => table);
    expect([...stepTables].sort()).toEqual(
      Object.keys(ERASURE_COVERAGE)
        .filter((table) => !reachedByCascade.includes(table))
        .sort(),
    );
    // Each cascade names a parent a step deletes.
    for (const [, how] of Object.entries(ERASURE_COVERAGE).filter(([, h]) => h.startsWith('cascade from'))) {
      expect(stepTables.has(how.replace('cascade from ', ''))).toBe(true);
    }
  });
});

describe('scopes and schema names', () => {
  it('turns a tenant schema name back into its group id, and nothing else', () => {
    expect(groupIdOfSchema('tg_0123456789abcdef0123456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef');
    expect(groupIdOfSchema('tg_demo')).toBeNull();
    expect(groupIdOfSchema('public')).toBeNull();
  });

  it('merges a stored scope with a new one, and reads garbage as empty', () => {
    const merged = mergeScope(
      { siteIds: ['b', 'a'], workspaceIds: ['w'], subdomains: [], hostnames: ['h'] },
      { siteIds: ['a', 'c'], workspaceIds: [], subdomains: ['s'], hostnames: ['h'] },
    );
    expect(merged).toEqual({ siteIds: ['a', 'b', 'c'], workspaceIds: ['w'], subdomains: ['s'], hostnames: ['h'] });
    expect(parseScope(null)).toEqual({ siteIds: [], workspaceIds: [], subdomains: [], hostnames: [] });
    expect(parseScope({ siteIds: [1, 'x'] })).toMatchObject({ siteIds: ['x'] });
  });
});
