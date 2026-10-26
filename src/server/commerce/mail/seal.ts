import 'server-only';

// src/server/commerce/mail/seal.ts
//
// A shop's Lumitra Mail send key at rest: AES-256-GCM under SHOP_MAIL_KEY, stored as
// `v1:<iv>:<tag>:<ciphertext>` (base64url). The version names the key, so a rotation adds a second key and
// re-seals without a flag day. Opening fails loudly on a wrong key or a changed text; the key is never logged.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function unseal(key: Buffer, sealed: string): string {
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('a sealed send key in an unknown form');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
