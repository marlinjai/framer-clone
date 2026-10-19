import { describe, expect, it } from 'vitest';
import { readCustomDomainConfig } from '../config';

const BASE = {
  CUSTOM_DOMAIN_TARGET_HOST: 'domains.lumitra.co',
  CUSTOM_DOMAIN_TARGET_IPV4: '203.0.113.10',
};

describe('readCustomDomainConfig', () => {
  it('is configured with a target host and an IPv4 address', () => {
    expect(readCustomDomainConfig(BASE)).toEqual({
      configured: true,
      config: {
        targetHost: 'domains.lumitra.co',
        ipv4: ['203.0.113.10'],
        ipv6: [],
        dnsServers: [],
        tlsProbe: true,
      },
    });
  });

  it('parses lists, IPv6, resolvers and the probe switch', () => {
    const result = readCustomDomainConfig({
      CUSTOM_DOMAIN_TARGET_HOST: 'Domains.Lumitra.co.',
      CUSTOM_DOMAIN_TARGET_IPV4: '203.0.113.10, 203.0.113.11',
      CUSTOM_DOMAIN_TARGET_IPV6: '2001:DB8::1',
      CUSTOM_DOMAIN_DNS_SERVERS: '1.1.1.1,8.8.8.8',
      CUSTOM_DOMAIN_TLS_PROBE: 'off',
    });
    expect(result).toEqual({
      configured: true,
      config: {
        targetHost: 'domains.lumitra.co',
        ipv4: ['203.0.113.10', '203.0.113.11'],
        ipv6: ['2001:db8::1'],
        dnsServers: ['1.1.1.1', '8.8.8.8'],
        tlsProbe: false,
      },
    });
  });

  it.each([
    ['nothing set', {}],
    ['no IPv4', { CUSTOM_DOMAIN_TARGET_HOST: 'domains.lumitra.co' }],
    ['a bad IPv4', { ...BASE, CUSTOM_DOMAIN_TARGET_IPV4: '999.1.1.1' }],
    ['an IPv6 in the IPv4 list', { ...BASE, CUSTOM_DOMAIN_TARGET_IPV4: '2001:db8::1' }],
    ['a bad IPv6', { ...BASE, CUSTOM_DOMAIN_TARGET_IPV6: 'nope' }],
    ['a single-label target', { ...BASE, CUSTOM_DOMAIN_TARGET_HOST: 'domains' }],
    ['a bad resolver', { ...BASE, CUSTOM_DOMAIN_DNS_SERVERS: 'dns.google' }],
  ])('is not configured with %s', (_why, env) => {
    expect(readCustomDomainConfig(env as Record<string, string>).configured).toBe(false);
  });
});
