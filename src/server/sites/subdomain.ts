// MT-01 — pure, tested subdomain LABEL generator for publish-time allocation.
//
// This is a LEAF building block with ZERO cross-deps. It produces a random,
// URL-safe, human-readable DNS label that the DB layer (MT-06) later allocates
// onto the `*.sites.lumitra.co` wildcard. It is intentionally PURE:
//   - no `import 'server-only'`
//   - no Prisma / no DB
//   - no `process.env`
//   - no internal registry / no dedupe (collision-avoidance is the DB's job,
//     enforced via the `@@unique([subdomain])` index in MT-06)
// so it is importable from a plain Vitest unit test with zero setup.

import { customAlphabet } from 'nanoid';

// RFC-1035 label: lowercase, <= 63 chars, starts/ends alphanumeric, internal
// hyphens allowed. We generate over [a-z0-9] only (no hyphens), so every output
// trivially satisfies the leading/trailing-alphanumeric rule. Exported so tests
// (and any caller) can validate against the exact same contract.
export const RFC1035_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Length 12 over a 36-char alphabet => 36^12 (~4.7e18) keyspace, comfortably
// collision-resistant and well under the 63-char DNS limit so that
// `<label>.sites.lumitra.co` stays within bounds.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LABEL_LENGTH = 12;

const nanoLabel = customAlphabet(ALPHABET, LABEL_LENGTH);

// Labels that must never be handed out as a tenant subdomain because they
// collide with platform / infrastructure hosts. Case-insensitive (see
// `isReserved`). `readonly` so callers cannot mutate the denylist.
export const RESERVED_SUBDOMAINS: readonly string[] = Object.freeze([
  'www',
  'app',
  'editor',
  'api',
  'admin',
  'auth',
  'mail',
  'sites',
]);

const RESERVED_LOOKUP: ReadonlySet<string> = new Set(
  RESERVED_SUBDOMAINS.map((s) => s.toLowerCase()),
);

/**
 * True if `label` is a reserved platform subdomain. Case-insensitive, so
 * `'app'`, `'APP'` and `'App'` all return true.
 */
export function isReserved(label: string): boolean {
  return RESERVED_LOOKUP.has(label.toLowerCase());
}

/**
 * Produce a random, lowercase, RFC-1035-safe subdomain LABEL.
 *
 * The output ALWAYS matches `RFC1035_LABEL` and is NEVER a reserved label (if a
 * generated value happens to be reserved — astronomically unlikely at length
 * 12, but guarded regardless — it regenerates).
 *
 * Stateless by design: two calls can in principle collide and there is no
 * internal registry. Uniqueness is the DB layer's responsibility (MT-06's
 * `@@unique([subdomain])` index + bounded retry on P2002).
 */
export function generateSubdomain(): string {
  // Loop guard: regenerate on the (vanishingly rare) reserved hit. Bounded only
  // by the reserved set being finite and the keyspace being enormous, so this
  // terminates immediately in practice.
  for (;;) {
    const label = nanoLabel();
    if (!isReserved(label)) {
      return label;
    }
  }
}
