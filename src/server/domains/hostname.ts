// src/server/domains/hostname.ts
//
// THE hostname contract for custom domains (plan
// docs/plans/2026-06-25-framer-custom-domains.md). One validator, used by:
//
//   - the add route (what an owner may claim),
//   - the published-site resolver (which request hosts may be looked up as a
//     custom domain at all),
//   - the proxy hostname feed the host-side Traefik sync reads (which names may
//     ever become a `Host(...)` rule). The sync re-validates every line with
//     its own copy of this rule (deploy/custom-domains/), because it must not
//     trust the app.
//
// A valid custom hostname is lowercase ASCII (an internationalized name is
// stored as punycode, `xn--...`), 1 to 253 characters, at least two labels,
// every label a DNS label (letters, digits, inner hyphens, 1 to 63 characters),
// a top-level label that is alphabetic or punycode (so no IP literal can pass),
// not under a reserved test or local top-level domain, and not equal to or
// under one of the platform's own zones (lumitra.co, the editor host, the
// published-site base host, the platform target host). Nothing else: no
// wildcard, no underscore, no port, no path. A string that passes can never
// carry Traefik rule syntax (backticks, parentheses, `||`), which is what makes
// the generated proxy configuration safe to build from it.
//
// Pure (no server-only, no Prisma), so it is unit testable on its own.

import { domainToASCII, domainToUnicode } from 'node:url';

/** One DNS label: letters, digits, inner hyphens, 1 to 63 characters. */
export const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The top-level label: alphabetic, or an IDN in punycode. Never all digits. */
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The longest hostname DNS allows (without the trailing root dot). */
export const MAX_HOSTNAME_LENGTH = 253;

/**
 * Top-level domains that can never be a real customer's public domain
 * (RFC 2606 / RFC 6761 / RFC 6762 / RFC 7686 and common private ones).
 */
const RESERVED_TOP_LEVEL = new Set([
  'localhost',
  'local',
  'test',
  'example',
  'invalid',
  'internal',
  'onion',
  'arpa',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
]);

/** The platform zone that is always reserved, whatever the environment says. */
export const PLATFORM_ROOT_ZONE = 'lumitra.co';

/** The TXT record label an owner publishes the verification token under. */
export const VERIFICATION_RECORD_PREFIX = '_lumitra-verify';

/** The prefix of the TXT value, so a stray TXT record never matches by accident. */
export const VERIFICATION_VALUE_PREFIX = 'lumitra-verify=';

export type HostnameRejection = 'invalid_hostname' | 'reserved_hostname';

export type HostnameResult =
  | { ok: true; hostname: string }
  | { ok: false; code: HostnameRejection; message: string };

/**
 * The platform zones no custom domain may equal or sit under: lumitra.co plus
 * the configured editor host, published-site base host and target host.
 */
export function platformZones(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const zones = new Set<string>([PLATFORM_ROOT_ZONE]);
  for (const key of ['EDITOR_HOST', 'PUBLIC_SITE_BASE_HOST', 'CUSTOM_DOMAIN_TARGET_HOST']) {
    const value = env[key]?.trim().toLowerCase().replace(/\.$/, '');
    if (value) zones.add(value);
  }
  return [...zones];
}

/** True when `hostname` equals or sits under one of `zones`. */
export function isUnderZone(hostname: string, zones: readonly string[]): boolean {
  return zones.some((zone) => hostname === zone || hostname.endsWith(`.${zone}`));
}

/**
 * The structural check on an already lowercase ASCII hostname (no reserved-zone
 * rule). Exported for the resolver and the proxy feed, which receive names that
 * were normalized before.
 */
export function isWellFormedHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  const top = labels[labels.length - 1];
  if (!TOP_LEVEL_LABEL.test(top)) return false;
  if (RESERVED_TOP_LEVEL.has(top)) return false;
  return true;
}

/**
 * True when `hostname` (lowercase ASCII) may be a custom domain: well formed
 * and not one of the platform's zones.
 */
export function isClaimableHostname(
  hostname: string,
  zones: readonly string[] = platformZones(),
): boolean {
  return isWellFormedHostname(hostname) && !isUnderZone(hostname, zones);
}

/**
 * Normalize what an owner typed into the "add domain" field. Forgiving about
 * presentation (surrounding spaces, upper case, a pasted `https://` URL with a
 * path, a trailing dot, an internationalized name), strict about the result.
 */
export function normalizeHostnameInput(
  input: unknown,
  zones: readonly string[] = platformZones(),
): HostnameResult {
  const invalid = (message: string): HostnameResult => ({
    ok: false,
    code: 'invalid_hostname',
    message,
  });
  if (typeof input !== 'string') return invalid('Enter a domain such as www.example.com.');
  let raw = input.trim();
  if (raw.length === 0) return invalid('Enter a domain such as www.example.com.');
  if (raw.length > 2048) return invalid('That is not a domain name.');

  // A pasted URL: keep only its host. Anything with credentials, or a port, is
  // refused rather than silently trimmed, since it is clearly not a bare domain.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return invalid('That is not a domain name.');
    }
    if (url.username || url.password || url.port) {
      return invalid('Enter only the domain, without a port or credentials.');
    }
    raw = url.hostname;
  } else {
    // A bare value with a path (`example.com/shop`): keep the part before it.
    raw = raw.split('/')[0];
  }

  if (raw.includes('*')) return invalid('Wildcard domains are not supported.');
  if (raw.includes(':') || raw.startsWith('[')) {
    return invalid('Enter only the domain, without a port.');
  }
  raw = raw.replace(/\.$/, '').toLowerCase();

  // Punycode an internationalized name. domainToASCII returns '' for anything
  // that is not a valid domain under UTS #46.
  const ascii = domainToASCII(raw);
  if (!ascii) return invalid('That is not a valid domain name.');
  const hostname = ascii.toLowerCase();

  if (!isWellFormedHostname(hostname)) {
    return invalid(
      'That is not a public domain name. Use letters, digits and hyphens, with a dot before the ending (for example www.example.com).',
    );
  }
  if (isUnderZone(hostname, zones)) {
    return {
      ok: false,
      code: 'reserved_hostname',
      message: 'This domain belongs to the platform and cannot be connected to a site.',
    };
  }
  return { ok: true, hostname };
}

/**
 * Normalize a request Host header for lookup: drop the port, the trailing dot,
 * lowercase, punycode. Returns null for an absent, IPv6-literal or unparseable
 * host. Applies NO policy (zones, shape): the caller decides what to look up.
 */
export function normalizeRequestHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (!trimmed || trimmed.startsWith('[')) return null;
  const withoutPort = trimmed.split(':')[0].replace(/\.$/, '').toLowerCase();
  if (!withoutPort) return null;
  const ascii = domainToASCII(withoutPort);
  return ascii ? ascii.toLowerCase() : null;
}

/** The hostname as people read it (an IDN shown in its own script). */
export function hostnameForDisplay(hostname: string): string {
  return domainToUnicode(hostname) || hostname;
}

/** The TXT record name that carries the verification token. */
export function verificationRecordName(hostname: string): string {
  return `${VERIFICATION_RECORD_PREFIX}.${hostname}`;
}

/** The TXT record value for a token. */
export function verificationRecordValue(token: string): string {
  return `${VERIFICATION_VALUE_PREFIX}${token}`;
}

/**
 * Common public suffixes with two labels, so `shop.co.uk` reads as an apex. A
 * guess used ONLY to decide which routing record the editor shows first: the
 * verifier accepts either record type for any hostname, so a wrong guess costs
 * nothing but the order of two lines.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.mx', 'co.za', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'co.in',
  'co.kr', 'co.il', 'com.ar', 'com.pl', 'co.at', 'or.at',
]);

/** True when `hostname` looks like a registrable domain itself (no subdomain). */
export function looksLikeApex(hostname: string): boolean {
  const labels = hostname.split('.');
  if (labels.length === 2) return true;
  if (labels.length === 3) return TWO_LABEL_SUFFIXES.has(labels.slice(1).join('.'));
  return false;
}
