// The custom-domain hostname contract: what an owner may claim, how a request
// host is normalized, and that nothing which could carry proxy rule syntax
// ever passes.

import { describe, expect, it } from 'vitest';
import {
  hostnameForDisplay,
  confusableSkeleton,
  isClaimableHostname,
  isWellFormedHostname,
  looksLikeApex,
  normalizeHostnameInput,
  normalizeRequestHost,
  platformZones,
  verificationRecordName,
  verificationRecordValue,
} from '../hostname';

const ZONES = ['lumitra.co', 'app.lumitra.co', 'sites.lumitra.co'];

function claim(input: unknown) {
  return normalizeHostnameInput(input, ZONES);
}

describe('normalizeHostnameInput', () => {
  it('accepts plain domains and normalizes presentation', () => {
    expect(claim('www.example.com')).toEqual({ ok: true, hostname: 'www.example.com' });
    expect(claim('  WWW.Example.COM.  ')).toEqual({ ok: true, hostname: 'www.example.com' });
    expect(claim('example.com')).toEqual({ ok: true, hostname: 'example.com' });
    expect(claim('shop.example.co.uk')).toEqual({ ok: true, hostname: 'shop.example.co.uk' });
  });

  it('keeps only the host of a pasted URL or a value with a path', () => {
    expect(claim('https://www.example.com/shop?x=1')).toEqual({ ok: true, hostname: 'www.example.com' });
    expect(claim('example.com/about')).toEqual({ ok: true, hostname: 'example.com' });
  });

  it('stores an internationalized domain as punycode', () => {
    expect(claim('bücher.de')).toEqual({ ok: true, hostname: 'xn--bcher-kva.de' });
    expect(claim('xn--bcher-kva.de')).toEqual({ ok: true, hostname: 'xn--bcher-kva.de' });
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['a single label', 'localhost'],
    ['an IPv4 literal', '192.168.0.1'],
    ['an IPv6 literal', '[::1]'],
    ['a port', 'example.com:8080'],
    ['a URL with a port', 'https://example.com:8443/'],
    ['credentials', 'https://user:pw@example.com/'],
    ['a wildcard', '*.example.com'],
    ['an underscore', 'my_shop.example.com'],
    ['a leading hyphen', '-shop.example.com'],
    ['a trailing hyphen', 'shop-.example.com'],
    ['an empty label', 'shop..example.com'],
    ['a label over 63 characters', `${'a'.repeat(64)}.example.com`],
    ['over 253 characters', `${'a.'.repeat(127)}com`],
    ['a numeric top-level label', 'example.123'],
    ['a reserved top-level domain', 'shop.local'],
    ['the test top-level domain', 'shop.test'],
    ['rule syntax', 'a.com`) || Host(`evil.com'],
    ['a backtick', 'exa`mple.com'],
    ['spaces inside', 'exa mple.com'],
  ])('rejects %s', (_why, input) => {
    const result = claim(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_hostname');
  });

  it.each(['lumitra.co', 'evil.lumitra.co', 'app.lumitra.co', 'x.sites.lumitra.co'])(
    'refuses the platform zone %s as reserved',
    (input) => {
      const result = claim(input);
      expect(result).toMatchObject({ ok: false, code: 'reserved_hostname' });
    },
  );

  it('does not treat a lookalike outside the zone as reserved', () => {
    expect(claim('notlumitra.co')).toEqual({ ok: true, hostname: 'notlumitra.co' });
  });
});

describe('confusable lookalikes of a platform zone', () => {
  it.each([
    ['a Cyrillic i', 'lumіtra.co'],
    ['a Cyrillic a under the zone', 'shop.lumitrа.co'],
    ['a Greek omicron in the ending', 'lumitra.cο'],
    ['a dotless i', 'lumıtra.co'],
    ['an accented u', 'lümitra.co'],
  ])('refuses %s as reserved', (_why, input) => {
    expect(claim(input)).toMatchObject({ ok: false, code: 'reserved_hostname' });
  });

  it('refuses the lookalike in the predicate the resolver and feed use too', () => {
    const ascii = (claim('lumіtra.co.evil.com') as { ok: boolean }).ok;
    expect(ascii).toBe(true); // a lookalike as a SUBDOMAIN of someone else's zone is theirs
    expect(isClaimableHostname('xn--lumtra-rvf.co', ZONES)).toBe(false);
  });

  it('keeps unrelated internationalized and plain ASCII names claimable', () => {
    expect(claim('bücher.de')).toEqual({ ok: true, hostname: 'xn--bcher-kva.de' });
    expect(claim('1umitra.co')).toEqual({ ok: true, hostname: '1umitra.co' });
    expect(claim('lumitra.com')).toEqual({ ok: true, hostname: 'lumitra.com' });
  });

  it('builds skeletons', () => {
    expect(confusableSkeleton('lumіtra.cο')).toBe('lumitra.co');
  });
});

describe('platformZones', () => {
  it('always reserves lumitra.co and adds the configured hosts', () => {
    expect(platformZones({}).sort()).toEqual(['lumitra.co']);
    expect(
      platformZones({
        EDITOR_HOST: 'App.Lumitra.co',
        PUBLIC_SITE_BASE_HOST: 'sites.example.net',
        CUSTOM_DOMAIN_TARGET_HOST: 'domains.example.net.',
      }).sort(),
    ).toEqual(['app.lumitra.co', 'domains.example.net', 'lumitra.co', 'sites.example.net']);
  });
});

describe('normalizeRequestHost', () => {
  it('drops port and trailing dot, lowercases, punycodes', () => {
    expect(normalizeRequestHost('Shop.Example.com:443')).toBe('shop.example.com');
    expect(normalizeRequestHost('shop.example.com.')).toBe('shop.example.com');
    expect(normalizeRequestHost('bücher.de')).toBe('xn--bcher-kva.de');
  });

  it('returns null for absent or IPv6 hosts', () => {
    expect(normalizeRequestHost(null)).toBeNull();
    expect(normalizeRequestHost('')).toBeNull();
    expect(normalizeRequestHost('[::1]:3000')).toBeNull();
  });
});

describe('the predicates and helpers', () => {
  it('isWellFormedHostname and isClaimableHostname', () => {
    expect(isWellFormedHostname('www.example.com')).toBe(true);
    expect(isWellFormedHostname('www.example.com`')).toBe(false);
    expect(isClaimableHostname('www.example.com', ZONES)).toBe(true);
    expect(isClaimableHostname('app.lumitra.co', ZONES)).toBe(false);
  });

  it('builds the verification record and shows IDNs readably', () => {
    expect(verificationRecordName('www.example.com')).toBe('_lumitra-verify.www.example.com');
    expect(verificationRecordValue('abc')).toBe('lumitra-verify=abc');
    expect(hostnameForDisplay('xn--bcher-kva.de')).toBe('bücher.de');
  });

  it('guesses apex domains only to order the records', () => {
    expect(looksLikeApex('example.com')).toBe(true);
    expect(looksLikeApex('example.co.uk')).toBe(true);
    expect(looksLikeApex('www.example.com')).toBe(false);
    expect(looksLikeApex('a.b.example.com')).toBe(false);
  });
});
