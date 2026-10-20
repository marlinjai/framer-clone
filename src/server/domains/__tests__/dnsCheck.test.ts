// The server-side DNS check: ownership (TXT token) and routing (CNAME or A,
// no stray AAAA), with transient failures kept apart from definitive ones.
// The resolver is a fake; nothing touches the network.

import { describe, expect, it } from 'vitest';
import type { CustomDomainConfig } from '../config';
import { checkDomainDns, type DnsLookup } from '../dnsCheck';

const CONFIG: CustomDomainConfig = {
  targetHost: 'domains.lumitra.co',
  ipv4: ['203.0.113.10'],
  ipv6: [],
  dnsServers: [],
  tlsProbe: true,
};
const TOKEN = 'a'.repeat(64);
const GOOD_TXT = [[`lumitra-verify=${TOKEN}`]];

function err(code: string): Error {
  return Object.assign(new Error(code), { code });
}

type Answers = Partial<Record<keyof DnsLookup, Record<string, unknown[] | Error>>>;

function fakeDns(answers: Answers): DnsLookup {
  const run = (kind: keyof DnsLookup) => async (name: string) => {
    const value = answers[kind]?.[name];
    if (value instanceof Error) throw value;
    if (value === undefined) throw err('ENODATA');
    return value;
  };
  return {
    resolveTxt: run('resolveTxt') as DnsLookup['resolveTxt'],
    resolveCname: run('resolveCname') as DnsLookup['resolveCname'],
    resolve4: run('resolve4') as DnsLookup['resolve4'],
    resolve6: run('resolve6') as DnsLookup['resolve6'],
  };
}

const check = (dns: DnsLookup, requireTxt = true, hostname = 'www.example.com') =>
  checkDomainDns({ hostname, token: TOKEN, requireTxt, config: CONFIG, dns });

describe('checkDomainDns', () => {
  it('passes with the TXT token and a CNAME to the target', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.www.example.com': GOOD_TXT },
      resolveCname: { 'www.example.com': ['Domains.Lumitra.co.'] },
      resolve4: { 'www.example.com': ['203.0.113.10'] },
    });
    expect(await check(dns)).toEqual({ ok: true, via: 'cname' });
  });

  it('passes an apex with A records to the platform (and a split TXT string)', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.example.com': [['lumitra-verify=', TOKEN]] },
      resolve4: { 'example.com': ['203.0.113.10'] },
    });
    expect(await check(dns, true, 'example.com')).toEqual({ ok: true, via: 'a' });
  });

  it('reports a missing TXT record', async () => {
    const result = await check(fakeDns({ resolve4: { 'www.example.com': ['203.0.113.10'] } }));
    expect(result).toMatchObject({ ok: false, code: 'txt_missing', transient: false });
  });

  it('reports a TXT record with an old token', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.www.example.com': [['lumitra-verify=old']] },
      resolve4: { 'www.example.com': ['203.0.113.10'] },
    });
    const result = await check(dns);
    expect(result).toMatchObject({ ok: false, code: 'txt_mismatch' });
    if (!result.ok) expect(result.message).toContain('different verification token');
  });

  it('skips the TXT record for a domain that already holds its claim', async () => {
    const dns = fakeDns({ resolve4: { 'www.example.com': ['203.0.113.10'] } });
    expect(await check(dns, false)).toEqual({ ok: true, via: 'a' });
  });

  it('reports no routing record at all', async () => {
    const dns = fakeDns({ resolveTxt: { '_lumitra-verify.www.example.com': GOOD_TXT } });
    expect(await check(dns)).toMatchObject({ ok: false, code: 'routing_missing', transient: false });
  });

  it('reports foreign A records and names the Cloudflare proxy case', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.www.example.com': GOOD_TXT },
      resolve4: { 'www.example.com': ['104.16.1.1'] },
    });
    const result = await check(dns);
    expect(result).toMatchObject({ ok: false, code: 'routing_mismatch' });
    if (!result.ok) expect(result.message).toContain('DNS only');
  });

  it('reports a CNAME elsewhere even when some address matches', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.www.example.com': GOOD_TXT },
      resolveCname: { 'www.example.com': ['other.host.net'] },
      resolve4: { 'www.example.com': ['203.0.113.10', '198.51.100.7'] },
    });
    const result = await check(dns);
    expect(result).toMatchObject({ ok: false, code: 'routing_mismatch' });
    if (!result.ok) expect(result.message).toContain('other.host.net');
  });

  it('reports a stray AAAA record (certificates would fail over IPv6)', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.www.example.com': GOOD_TXT },
      resolve4: { 'www.example.com': ['203.0.113.10'] },
      resolve6: { 'www.example.com': ['2001:db8::99'] },
    });
    expect(await check(dns)).toMatchObject({ ok: false, code: 'aaaa_mismatch' });
  });

  it('accepts an AAAA record that is a configured platform address', async () => {
    const dns = fakeDns({
      resolveTxt: { '_lumitra-verify.www.example.com': GOOD_TXT },
      resolve4: { 'www.example.com': ['203.0.113.10'] },
      resolve6: { 'www.example.com': ['2001:DB8::1'] },
    });
    const result = await checkDomainDns({
      hostname: 'www.example.com',
      token: TOKEN,
      requireTxt: true,
      config: { ...CONFIG, ipv6: ['2001:db8::1'] },
      dns,
    });
    expect(result).toEqual({ ok: true, via: 'a' });
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED'])(
    'treats %s as transient: nothing is decided',
    async (code) => {
      const dns = fakeDns({ resolveTxt: { '_lumitra-verify.www.example.com': err(code) } });
      const result = await check(dns);
      expect(result).toMatchObject({ ok: false, code: 'dns_unavailable', transient: true });
    },
  );

  it('treats NXDOMAIN as a definitive "no record"', async () => {
    const dns = fakeDns({ resolveTxt: { '_lumitra-verify.www.example.com': err('ENOTFOUND') } });
    expect(await check(dns)).toMatchObject({ ok: false, code: 'txt_missing', transient: false });
  });
});
