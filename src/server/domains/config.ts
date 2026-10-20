// src/server/domains/config.ts
//
// The platform side of a custom domain: where an owner points their records.
// Read from the environment on every call (cheap, and tests can vary it).
//
//   CUSTOM_DOMAIN_TARGET_HOST   the DNS-only (not Cloudflare-proxied) name a
//                               subdomain is CNAMEd to, e.g. domains.lumitra.co
//   CUSTOM_DOMAIN_TARGET_IPV4   comma-separated IPv4 address(es) of the shared
//                               server, for an apex A record
//   CUSTOM_DOMAIN_TARGET_IPV6   optional, comma-separated IPv6 address(es) the
//                               proxy answers on. Unset means "no AAAA record":
//                               a stray AAAA elsewhere is then reported, because
//                               Let's Encrypt prefers IPv6 and would fail.
//   CUSTOM_DOMAIN_DNS_SERVERS   optional, comma-separated resolver IPs for the
//                               ownership check (default: the system resolver)
//   CUSTOM_DOMAIN_TLS_PROBE     `off` disables the certificate probe that moves
//                               a domain from verified to active
//
// Without a target host and at least one valid IPv4 address the feature is
// "not configured": the routes answer 503 `custom_domains_not_configured`
// instead of showing records that point nowhere.

import { isIP } from 'node:net';
import { DNS_LABEL } from './hostname';

export interface CustomDomainConfig {
  targetHost: string;
  ipv4: string[];
  ipv6: string[];
  dnsServers: string[];
  tlsProbe: boolean;
}

export type CustomDomainConfigResult =
  | { configured: true; config: CustomDomainConfig }
  | { configured: false; reason: string };

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function readCustomDomainConfig(
  env: Record<string, string | undefined> = process.env,
): CustomDomainConfigResult {
  const targetHost = (env.CUSTOM_DOMAIN_TARGET_HOST ?? '').trim().toLowerCase().replace(/\.$/, '');
  const labels = targetHost.split('.');
  if (!targetHost || labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) {
    return { configured: false, reason: 'CUSTOM_DOMAIN_TARGET_HOST is not set to a hostname' };
  }
  const ipv4 = list(env.CUSTOM_DOMAIN_TARGET_IPV4);
  if (ipv4.length === 0 || !ipv4.every((ip) => isIP(ip) === 4)) {
    return { configured: false, reason: 'CUSTOM_DOMAIN_TARGET_IPV4 is not a list of IPv4 addresses' };
  }
  const ipv6 = list(env.CUSTOM_DOMAIN_TARGET_IPV6).map((ip) => ip.toLowerCase());
  if (!ipv6.every((ip) => isIP(ip) === 6)) {
    return { configured: false, reason: 'CUSTOM_DOMAIN_TARGET_IPV6 is not a list of IPv6 addresses' };
  }
  const dnsServers = list(env.CUSTOM_DOMAIN_DNS_SERVERS);
  if (!dnsServers.every((ip) => isIP(ip) !== 0)) {
    return { configured: false, reason: 'CUSTOM_DOMAIN_DNS_SERVERS is not a list of IP addresses' };
  }
  return {
    configured: true,
    config: {
      targetHost,
      ipv4,
      ipv6,
      dnsServers,
      tlsProbe: (env.CUSTOM_DOMAIN_TLS_PROBE ?? '').trim().toLowerCase() !== 'off',
    },
  };
}
