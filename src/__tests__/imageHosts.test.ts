// src/__tests__/imageHosts.test.ts
//
// The hosts `/_next/image` may fetch (next.config.ts), judged by Next's own
// matcher. The route answers anyone, so a wide pattern turns the server into an
// open image proxy and a way to make it fetch internal addresses.

import { hasRemoteMatch } from 'next/dist/shared/lib/match-remote-pattern';
import { describe, expect, it } from 'vitest';

import config from '../../next.config';

const allowed = (url: string) => hasRemoteMatch(config.images?.domains ?? [], config.images?.remotePatterns ?? [], new URL(url));

describe('the hosts the image optimizer may fetch', () => {
  it('keeps the Unsplash photos the app places', () => {
    expect(allowed('https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1200&q=80')).toBe(true);
  });

  it.each([
    ['any other site', 'https://evil.test/a.png'],
    ['a host that only starts like Unsplash', 'https://images.unsplash.com.evil.test/a.png'],
    ['a sibling Unsplash host', 'https://api.unsplash.com/a.png'],
    ['plain http to an allowed host', 'http://images.unsplash.com/a.png'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['this machine', 'http://localhost:3000/a.png'],
  ])('refuses %s', (_name, url) => {
    expect(allowed(url)).toBe(false);
  });

  it('never allows a host wildcard', () => {
    for (const pattern of config.images?.remotePatterns ?? []) {
      expect(pattern.hostname).not.toContain('*');
    }
  });
});
