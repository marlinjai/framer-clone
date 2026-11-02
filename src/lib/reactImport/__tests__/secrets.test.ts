// @vitest-environment node
// The secret scan: each format it knows, ordinary text it must leave alone, and that it
// stays linear on what the size limit allows. Every key here is made when the test runs,
// so nothing shaped like a real secret sits in the repository
// (knowledge-base/standards/test-credentials.md).

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../budget';
import { findSecret } from '../secrets';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const upper = (count: number) => Array.from(randomBytes(count), (byte) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[byte % 32]).join('');
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fake = (prefix: string, separator: string, bytes = 20) => `${prefix}${separator}${hex(bytes)}`;

describe('what it finds', () => {
  it.each<[string, () => string]>([
    ['a live payment key', () => fake(['sk', 'live'].join('_'), '_')],
    ['a test payment key', () => fake(['sk', 'test'].join('_'), '_')],
    ['a restricted payment key', () => fake(['rk', 'live'].join('_'), '_')],
    ['a webhook signing secret', () => fake('whsec', '_')],
    ['a model provider key', () => fake(['sk', 'ant', 'api03'].join('-'), '-')],
    ['a project key', () => fake(['sk', 'proj'].join('-'), '-')],
    ['a code host token', () => fake('ghp', '_')],
    ['a fine grained code host token', () => fake(['github', 'pat'].join('_'), '_')],
    ['a code host token of the other host', () => fake('glpat', '-')],
    ['a chat bot token', () => fake('xoxb', '-')],
    ['a cloud access key', () => `${'AK'}IA${upper(16)}`],
    ['a maps key', () => `${'AI'}za${hex(17)}x`],
    ['a mail service key', () => fake('re', '_')],
    ['a package registry token', () => `${'np'}m_${hex(18)}`],
    ['a shop admin token', () => fake('shpat', '_', 16)],
    ['a dotted mail key', () => `${'S'}G.${hex(11)}.${hex(22)}`],
    ['a signed login token', () => `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: hex(4) })}.${hex(16)}`],
    ['a private key block', () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    ['a connection string with a password', () => `postgres://app:${hex(8)}@db.internal:5432/main`],
    ['a password in an address', () => `https://user:${hex(4)}@example.test/x`],
  ])('%s', (_name, make) => {
    const secret = make();
    expect(findSecret(secret)).toBeDefined();
    // Where an import holds it: inside an address, in a template, beside other words.
    expect(findSecret(`https://api.example.test/?key=${secret}&x=1`)).toBeDefined();
    expect(findSecret(`Bearer ${secret}`)).toBeDefined();
  });

  it('names what it found', () => {
    expect(findSecret(fake('whsec', '_'))).toBe('vendor-key');
    expect(findSecret(`${encoded({ a: 1 })}x.${encoded({ b: 2 })}y.${hex(8)}`)).toBe('signed-token');
    expect(findSecret(`postgres://a:${hex(4)}@h/db`)).toBe('connection-password');
    expect(findSecret(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toBe('private-key');
  });
});

describe('a key that touches another word (review of slice 4, U1)', () => {
  const live = () => fake(['sk', 'live'].join('_'), '_');
  it.each<[string, (key: string) => string]>([
    ['after a dash', (key) => `token-${key}`],
    ['after an underscore', (key) => `api_${key}`],
    ['after a letter', (key) => `K${key}`],
    ['as part of an attribute name', (key) => `data-${key}`],
    ['between words', (key) => `my-${key}-end`],
  ])('%s', (_name, wrap) => {
    expect(findSecret(wrap(live()))).toBe('vendor-key');
  });

  it.each<[string, () => string]>([
    ['a map service secret token', () => `${'s'}k.${encoded({ u: hex(4), a: hex(6) })}.${hex(12)}`],
    ['an OAuth client secret', () => `${'GOC'}SPX-${hex(14)}`],
    ['a messaging API key', () => `${'S'}K${hex(16)}`],
    ['a cloud secret access key, which has a slash', () => `${Buffer.from(randomBytes(30)).toString('base64').slice(0, 19)}/${'Ab3'}${hex(9)}`.padEnd(40, 'Q').slice(0, 40)],
    ['a cloud secret access key beside its name', () => `aws_secret_access_key = ${`Ab3${upper(20)}${hex(10)}`.slice(0, 40)}`],
    ['a token as the user of an address', () => `https://${hex(16)}@code.example.test/repo.git`],
  ])('%s', (_name, make) => {
    expect(findSecret(make())).toBeDefined();
  });

  it.each([
    'store_customer_identifier_value_kept',
    'risk-assessment-for-the-quarterly-review-meeting',
    'TASK0123456789abcdef0123456789abcdef',
    `sha1 ${'a1b2c3d4e5'.repeat(4)}`,
    `data:image/png;base64,${Buffer.from(randomBytes(300)).toString('base64')}`,
    'https://username@example.test/',
  ])('leaves alone %s', (text) => {
    expect(findSecret(text)).toBeUndefined();
  });
});

describe('what it leaves alone', () => {
  it.each([
    'inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground [&_svg]:size-4',
    'https://example.test/images/hero.png?w=1200&fit=crop',
    'mailto:hello@example.test',
    'https://user@example.test/',
    'postgres://app:@db/main',
    `pk_live_${'a'.repeat(4)}`,
    'sk-short',
    'a.b.c',
    'eyJhbGciOiJub25lIn0',
    '-----BEGIN PUBLIC KEY-----',
    'The ratio is 3:2, see https://example.test.',
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
  ])('%s', (text) => {
    expect(findSecret(text)).toBeUndefined();
  });
});

describe('cost', () => {
  const size = IMPORT_LIMITS.bytesPerFile;

  it.each<[string, string]>([
    ['a run of word characters', 'a'.repeat(size)],
    ['a run of prefixes', 'sk_'.repeat(size / 3)],
    ['a run of token starts', 'eyJ'.repeat(size / 3)],
    ['a run of dotted token starts', 'eyJ.'.repeat(size / 4)],
    ['a run of address starts', 'a://'.repeat(size / 4)],
    ['an address with a long authority', `a://${'b'.repeat(size - 8)}`],
    ['a run of key headers', '-----BEGIN '.repeat(size / 11)],
    ['a run of at signs and colons', 'a://:@'.repeat(size / 6)],
    ['a long run with a dot elsewhere', `${'a'.repeat(size - 2)} .`],
    ['a long dotted run', 'a.'.repeat(size / 2)],
    ['a run of dotted token parts', 'eyJaaaaaaaaaa.'.repeat(size / 14)],
  ])('%s, at the size limit, in well under a second', (_name, text) => {
    const started = performance.now();
    findSecret(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
