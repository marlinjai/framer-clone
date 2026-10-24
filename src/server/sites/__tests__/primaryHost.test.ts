import { describe, expect, it } from 'vitest';
import { pickPrimaryHost, type DomainRowForHost } from '../primaryHost';

const at = (iso: string) => new Date(iso);
const platform: DomainRowForHost = {
  subdomain: 'abc123',
  customHostname: null,
  verificationStatus: 'active',
  activatedAt: null,
  createdAt: at('2026-01-01'),
};
const custom = (host: string, status: string, activated: string | null, created = '2026-02-01'): DomainRowForHost => ({
  subdomain: null,
  customHostname: host,
  verificationStatus: status,
  activatedAt: activated ? at(activated) : null,
  createdAt: at(created),
});

describe('pickPrimaryHost', () => {
  it('prefers the oldest live custom domain', () => {
    expect(
      pickPrimaryHost(
        [platform, custom('new.de', 'active', '2026-05-01'), custom('first.de', 'verified', '2026-03-01')],
        'sites.lumitra.co',
      ),
    ).toBe('first.de');
  });

  it('ignores pending, failed and released claims', () => {
    expect(
      pickPrimaryHost(
        [platform, custom('p.de', 'pending', null), custom('f.de', 'failed', null), { ...custom('x.de', 'active', null), customHostname: null }],
        'sites.lumitra.co',
      ),
    ).toBe('abc123.sites.lumitra.co');
  });

  it('falls back to the request host without a base host, and to null without anything', () => {
    expect(pickPrimaryHost([platform], undefined, 'abc123.localhost')).toBe('abc123.localhost');
    expect(pickPrimaryHost([], 'sites.lumitra.co')).toBeNull();
  });
});
