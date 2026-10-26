import 'server-only';

// src/server/commerce/mail/config.ts
//
// What the shop's receipt email needs from the environment (docs/plans/2026-10-27-shop-receipt-email.md). Three
// secrets, all minted with copy_secret into Infisical (framer-clone, production):
//
//   LUMITRA_MAIL_SERVICE_TOKEN  the token Lumitra Mail knows this application by (`sites`, the same value as its
//                               SITES_SERVICE_TOKEN); only for connecting and disconnecting, never for sending
//   SHOP_MAIL_KEY               AES-256-GCM key sealing each shop's send key at rest (64 hex characters)
//   RECEIPT_LINK_KEY            HMAC-SHA256 key signing the buyers' receipt links (64 hex characters)
//
// LUMITRA_MAIL_URL points at another service (tests, local); the default is production. Unset or placeholder
// values read as "not configured": the payments page says so and nothing is sent.

export interface ShopMailConfig {
  serviceUrl: string;
  serviceToken: string;
  sealKey: Buffer;
}

const PLACEHOLDER = 'PLACEHOLDER_REPLACE_ME';
const HEX64 = /^[0-9a-f]{64}$/i;

function real(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '' && value !== PLACEHOLDER;
}

/** The connection settings, or null while any is missing or a placeholder. A malformed key is a loud error. */
export function shopMailConfig(env: Record<string, string | undefined> = process.env): ShopMailConfig | null {
  const token = env.LUMITRA_MAIL_SERVICE_TOKEN;
  const key = env.SHOP_MAIL_KEY;
  if (!real(token) || !real(key)) return null;
  if (!HEX64.test(key)) throw new Error('SHOP_MAIL_KEY must be 64 hex characters (32 random bytes)');
  return {
    serviceUrl: real(env.LUMITRA_MAIL_URL) ? env.LUMITRA_MAIL_URL.replace(/\/+$/, '') : 'https://mail.lumitra.co',
    serviceToken: token,
    sealKey: Buffer.from(key, 'hex'),
  };
}

/** The receipt link key (version 1), or null while unset. A malformed key is a loud error. */
export function receiptLinkKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const key = env.RECEIPT_LINK_KEY;
  if (!real(key)) return null;
  if (!HEX64.test(key)) throw new Error('RECEIPT_LINK_KEY must be 64 hex characters (32 random bytes)');
  return Buffer.from(key, 'hex');
}

/** Where buyers open their receipt: the editor host, which serves /api/receipts/<token>. */
export function receiptLinkBase(env: Record<string, string | undefined> = process.env): string {
  const host = env.EDITOR_HOST?.trim();
  return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : 'https://app.lumitra.co';
}
