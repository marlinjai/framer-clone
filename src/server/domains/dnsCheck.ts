// src/server/domains/dnsCheck.ts
//
// The server-side DNS check behind "Verify" for a custom domain. Two things
// must hold:
//
//   1. OWNERSHIP: the TXT record `_lumitra-verify.<hostname>` carries
//      `lumitra-verify=<token>`, the random token minted for THIS claim. Only
//      someone who controls the domain's DNS can publish it. Required to
//      take a claim (first verification, or after it was lost); an already
//      verified domain is re-checked on routing alone, so an owner who tidies
//      the TXT record away later does not take their site offline.
//   2. ROUTING: the hostname reaches the platform, either as a CNAME to the
//      platform target host, or with A records that are all platform IPv4
//      addresses (an apex, or a flattened CNAME). An AAAA record must be a
//      platform IPv6 address (or absent when none is configured): Let's
//      Encrypt prefers IPv6, so a stray AAAA would make every certificate
//      request fail.
//
// Every lookup has a timeout (node:dns Resolver timeout and tries, plus an
// overall deadline per lookup). A lookup that does not answer, or answers with
// a server failure, is TRANSIENT: the result says so and the caller changes
// nothing but the "last checked" note. A clean "no such record" is definitive.
//
// The resolver is an injected interface so tests never touch the network.

import { Resolver } from 'node:dns/promises';
import type { CustomDomainConfig } from './config';
import {
  VERIFICATION_VALUE_PREFIX,
  verificationRecordName,
  verificationRecordValue,
} from './hostname';

/** The DNS lookups the check needs (node:dns/promises Resolver shape). */
export interface DnsLookup {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

/** Per-attempt timeout inside node:dns, and how many attempts it makes. */
export const DNS_TIMEOUT_MS = 4_000;
export const DNS_TRIES = 2;
/** The hard ceiling for one lookup, whatever the resolver does. */
export const DNS_DEADLINE_MS = 10_000;

/** A Resolver with timeouts, pointed at the configured servers if any. */
export function createDnsLookup(config: Pick<CustomDomainConfig, 'dnsServers'>): DnsLookup {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  if (config.dnsServers.length > 0) resolver.setServers(config.dnsServers);
  return resolver;
}

export type DnsCheckFailureCode =
  | 'txt_missing'
  | 'txt_mismatch'
  | 'routing_missing'
  | 'routing_mismatch'
  | 'aaaa_mismatch'
  | 'dns_unavailable';

export type DnsCheckResult =
  | { ok: true; via: 'cname' | 'a' }
  | { ok: false; code: DnsCheckFailureCode; message: string; transient: boolean };

/** Errors that mean "this name has no such record": a definitive answer. */
const ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

class TransientDnsError extends Error {
  constructor(readonly lookupName: string, readonly code: string) {
    super(`DNS lookup for ${lookupName} failed: ${code}`);
    this.name = 'TransientDnsError';
  }
}

async function lookup<T>(name: string, run: () => Promise<T[]>): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransientDnsError(name, 'ETIMEOUT')), DNS_DEADLINE_MS);
  });
  try {
    return await Promise.race([run(), deadline]);
  } catch (err) {
    if (err instanceof TransientDnsError) throw err;
    const code = (err as { code?: string } | null)?.code ?? 'EUNKNOWN';
    if (ABSENT_CODES.has(code)) return [];
    throw new TransientDnsError(name, code);
  } finally {
    clearTimeout(timer);
  }
}

function bareName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Check ownership (when `requireTxt`) and routing for `hostname`. Never throws
 * for a DNS problem: every outcome is a result with an owner-readable message.
 */
export async function checkDomainDns(input: {
  hostname: string;
  token: string;
  requireTxt: boolean;
  config: CustomDomainConfig;
  dns: DnsLookup;
}): Promise<DnsCheckResult> {
  const { hostname, token, requireTxt, config, dns } = input;
  try {
    if (requireTxt) {
      const recordName = verificationRecordName(hostname);
      const expected = verificationRecordValue(token);
      const records = await lookup(recordName, () => dns.resolveTxt(recordName));
      // A TXT record may be split into several strings; they join without a
      // separator (RFC 7208 section 3.3 style).
      const values = records.map((chunks) => chunks.join('').trim());
      if (values.length === 0) {
        return {
          ok: false,
          transient: false,
          code: 'txt_missing',
          message: `No TXT record found at ${recordName}. Add a TXT record with the value ${expected}. DNS changes can take a few minutes to appear.`,
        };
      }
      if (!values.includes(expected)) {
        const stale = values.some((v) => v.startsWith(VERIFICATION_VALUE_PREFIX));
        return {
          ok: false,
          transient: false,
          code: 'txt_mismatch',
          message: stale
            ? `The TXT record at ${recordName} holds a different verification token (an older one?). Set its value to ${expected}.`
            : `The TXT record at ${recordName} does not contain ${expected}. Add that value.`,
        };
      }
    }

    const cnames = (await lookup(hostname, () => dns.resolveCname(hostname))).map(bareName);
    const cnameToTarget = cnames.includes(config.targetHost);
    const ipv4 = await lookup(hostname, () => dns.resolve4(hostname));
    const ipv6 = (await lookup(hostname, () => dns.resolve6(hostname))).map((ip) => ip.toLowerCase());

    if (ipv4.length === 0) {
      return {
        ok: false,
        transient: false,
        code: 'routing_missing',
        message:
          cnames.length > 0
            ? `${hostname} is a CNAME to ${cnames[0]}, which has no IPv4 address. Point the CNAME at ${config.targetHost}.`
            : `No CNAME or A record found for ${hostname}. Add a CNAME to ${config.targetHost} (or, for a root domain, an A record to ${config.ipv4[0]}).`,
      };
    }
    const foreign4 = ipv4.filter((ip) => !config.ipv4.includes(ip));
    if (foreign4.length > 0) {
      const where = cnames.length > 0 && !cnameToTarget ? ` (through a CNAME to ${cnames[0]})` : '';
      return {
        ok: false,
        transient: false,
        code: 'routing_mismatch',
        message: `${hostname} resolves to ${foreign4.join(', ')}${where}, not to the platform. Point it at ${config.targetHost} with a CNAME, or use an A record to ${config.ipv4.join(', ')}. If the record is proxied through Cloudflare (orange cloud), set it to DNS only.`,
      };
    }
    const foreign6 = ipv6.filter((ip) => !config.ipv6.includes(ip));
    if (foreign6.length > 0) {
      return {
        ok: false,
        transient: false,
        code: 'aaaa_mismatch',
        message:
          config.ipv6.length > 0
            ? `${hostname} has an AAAA (IPv6) record pointing to ${foreign6.join(', ')}. Change it to ${config.ipv6.join(', ')} or remove it; certificates cannot be issued while it points elsewhere.`
            : `${hostname} has an AAAA (IPv6) record pointing to ${foreign6.join(', ')}. Remove it; certificates cannot be issued while it exists.`,
      };
    }
    return { ok: true, via: cnameToTarget ? 'cname' : 'a' };
  } catch (err) {
    if (err instanceof TransientDnsError) {
      return {
        ok: false,
        transient: true,
        code: 'dns_unavailable',
        message: `The DNS lookup for ${err.lookupName} did not get an answer (${err.code}). Nothing was changed; try again in a minute.`,
      };
    }
    throw err;
  }
}
