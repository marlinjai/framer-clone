// services/box/src/config.ts
//
// What the box is told at start. Everything is checked before the first
// request: a missing or malformed value stops the process with the name of
// the variable (never its value), because a box that guessed a default for a
// host or a proxy would be a box that is wrong quietly.

import { isExactHostname } from '../../../src/lib/customCode/contract';
import { parseAddress, parseCidr, type Cidr } from './clientAddress';

export interface BoxConfig {
  /** The address the server binds. */
  listenHost: string;
  port: number;
  /** The connection string of the `box_reader` role. The only secret the box holds. */
  databaseUrl: string;
  /** The editor's host: named in `frame-ancestors` for the standalone preview, and where violation reports go. */
  editorHost: string;
  /** The host platform subdomains live under, such as `sites.lumitra.co`. */
  sitesBaseHost: string;
  /** Peers whose `X-Forwarded-For` is believed. Empty: the header is never read. */
  trustedProxies: Cidr[];
  /** Shown on the page that says what the domain is. Unset: the line is left out. */
  abuseContact: string | null;
  securityContact: string | null;
  takedownUrl: string | null;
  /** The `Expires` of security.txt, an ISO date. security.txt is answered only with this and a security contact. */
  securityTxtExpires: string | null;
}

export class ConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new ConfigError(`${name} is not set`);
  return value;
}

function hostname(env: Env, name: string): string {
  const value = required(env, name);
  if (!isExactHostname(value)) throw new ConfigError(`${name} must be an exact lower case host name`);
  return value;
}

const EMAIL_PATTERN = /^[a-z0-9._+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function optional(env: Env, name: string, check: (value: string) => boolean, what: string): string | null {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (!check(value)) throw new ConfigError(`${name} must be ${what}`);
  return value;
}

function isHttpsUrl(value: string): boolean {
  if (value.length > 512 || /[\s"'<>\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && isExactHostname(url.hostname);
  } catch {
    return false;
  }
}

function isIsoInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function readConfig(env: Env): BoxConfig {
  const databaseUrl = required(env, 'BOX_DATABASE_URL');
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    throw new ConfigError('BOX_DATABASE_URL is not a connection string');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') throw new ConfigError('BOX_DATABASE_URL is not a Postgres connection string');

  const portText = env.BOX_PORT ?? '8080';
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new ConfigError('BOX_PORT must be a port number');

  const trustedProxies: Cidr[] = [];
  for (const entry of (env.BOX_TRUSTED_PROXIES ?? '').split(',')) {
    const text = entry.trim();
    if (text === '') continue;
    const cidr = parseCidr(text);
    if (!cidr) throw new ConfigError('BOX_TRUSTED_PROXIES must be a comma-separated list of addresses or networks');
    // A network that wide would believe a header from anyone.
    if (cidr.bits < 8) throw new ConfigError('BOX_TRUSTED_PROXIES holds a network wider than /8');
    trustedProxies.push(cidr);
  }

  const listenHost = env.BOX_LISTEN_HOST ?? '0.0.0.0';
  if (!parseAddress(listenHost)) throw new ConfigError('BOX_LISTEN_HOST must be an address');

  return {
    listenHost,
    port: Number(portText),
    databaseUrl,
    editorHost: hostname(env, 'BOX_EDITOR_HOST'),
    sitesBaseHost: hostname(env, 'BOX_SITES_BASE_HOST'),
    trustedProxies,
    abuseContact: optional(env, 'BOX_ABUSE_CONTACT', (v) => EMAIL_PATTERN.test(v), 'a lower case mail address'),
    securityContact: optional(env, 'BOX_SECURITY_CONTACT', (v) => EMAIL_PATTERN.test(v), 'a lower case mail address'),
    takedownUrl: optional(env, 'BOX_TAKEDOWN_URL', isHttpsUrl, 'an https address'),
    securityTxtExpires: optional(env, 'BOX_SECURITY_TXT_EXPIRES', isIsoInstant, 'an ISO date such as 2027-11-01T00:00:00Z'),
  };
}

/**
 * The platform kill switch, read on every request. Decision D16: the box
 * serves a document only while `CUSTOM_CODE_DISABLED` is exactly `0`. Unset,
 * empty, `1`, `false`, a typing mistake: every other value is the switch being
 * on, and every block answers 410. So a box that was started without anyone
 * deciding to serve does not serve.
 */
export function isKillSwitchOn(env: Env): boolean {
  return env.CUSTOM_CODE_DISABLED !== '0';
}
