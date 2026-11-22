import type { Migration } from '@marlinjai/tenant-db';

/**
 * The hosted checkout session, pinned once, `031_checkout_session` (docs/plans/2026-11-02-shop-backbone.md, section 2.1
 * and slice B7).
 *
 * A Stripe Checkout Session is created under the idempotency key `checkout:<orderId>`. Stripe answers a repeated key with
 * the first answer only for the same request and refuses it otherwise (proven in the sandbox on 2026-11-23, section 2.5).
 * So everything the request carries is fixed before Stripe is first asked, and kept: the session's end, the return
 * address and the buyer (whose email the session is made out to). Once Stripe answers, the session id is kept too, so a
 * later click asks Stripe how that session stands instead of creating it again.
 *
 *   provider_session_id  the Checkout Session id, set once after Stripe answered the create
 *   session_expires_at   when Stripe ends the session; fixed at the pin, 45 minutes after it
 *   session_return_url   where the hosted page returns the buyer; fixed at the pin
 *
 * The pin also moves `expires_at` (the stock hold) to the session's end plus a grace, so the hold never ends while the
 * session can still be paid.
 *
 * The structural guarantees, and why each exists:
 *
 *   1. Pinned together: the end and the return address are both set or both empty, and a session id needs a pin.
 *   2. The hold outlasts the session: a pinned payment's `expires_at` is after `session_expires_at`.
 *   3. Only a Stripe payment has a session: the demo provider decides at once.
 *   4. One payment per session: `(provider, provider_session_id)` is unique.
 *   5. `order_payment_session_guard` (BK018): a payment starts unpinned; it is pinned only while pending; once pinned
 *      the end, the return address, the hold and the buyer are fixed, because each is part of the request or follows
 *      from it, and a change would make Stripe refuse the key (the buyer's email) or let the hold end before the session;
 *      the session id is set once.
 *
 * A separate trigger beside `order_payment_guard` (021), as 028 did, rather than a new body for that function: 029 split
 * its triggers for the erasure, and replacing the function would mean copying the whole of 021's body.
 *
 * `checkout_request` (028) stays during the cutover: the build before this one still writes it while both run. This
 * build never writes it and reads only its `confirmed`, to know a payment whose session the build before made under the
 * same key (checkoutSession.ts); slice B9 drops the column, its trigger and its CHECK.
 *
 * Additive: three nullable columns, four CHECKs, one partial unique index and one trigger. House style as 007 to 030: BARE
 * names, functions `SET search_path FROM CURRENT`. Re-runnable.
 */
export const checkoutSession: Migration = {
  id: '031_checkout_session',
  up: async (tx) => {
    await tx`ALTER TABLE "order_payment" ADD COLUMN IF NOT EXISTS "provider_session_id" TEXT`;
    await tx`ALTER TABLE "order_payment" ADD COLUMN IF NOT EXISTS "session_expires_at" TIMESTAMP(3)`;
    await tx`ALTER TABLE "order_payment" ADD COLUMN IF NOT EXISTS "session_return_url" TEXT`;

    const checks: ReadonlyArray<readonly [string, string]> = [
      // Guarantee 1.
      [
        'order_payment_session_pin_check',
        `("session_expires_at" IS NULL) = ("session_return_url" IS NULL)
           AND ("provider_session_id" IS NULL OR "session_expires_at" IS NOT NULL)
           AND ("session_return_url" IS NULL OR length("session_return_url") BETWEEN 1 AND 2000)
           AND ("provider_session_id" IS NULL OR length("provider_session_id") BETWEEN 1 AND 255)`,
      ],
      // Guarantee 2.
      ['order_payment_session_hold_check', `"session_expires_at" IS NULL OR "expires_at" > "session_expires_at"`],
      // Guarantee 3.
      ['order_payment_session_provider_check', `"session_expires_at" IS NULL OR "provider" = 'stripe'`],
    ];
    for (const [name, check] of checks) {
      await tx.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'order_payment'::regclass
          ) THEN
            ALTER TABLE "order_payment" ADD CONSTRAINT "${name}" CHECK (${check});
          END IF;
        END $$`);
    }

    // Guarantee 4.
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS "order_payment_provider_session_key"
        ON "order_payment" ("provider", "provider_session_id")
        WHERE "provider_session_id" IS NOT NULL
    `;

    // Guarantee 5.
    await tx`
      CREATE OR REPLACE FUNCTION "order_payment_session_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF TG_OP = 'INSERT' THEN
              IF NEW."session_expires_at" IS NOT NULL OR NEW."session_return_url" IS NOT NULL OR NEW."provider_session_id" IS NOT NULL THEN
                  RAISE EXCEPTION 'order_payment of order %: a payment starts without a checkout session', NEW."order_id"
                      USING ERRCODE = 'BK018';
              END IF;
              RETURN NEW;
          END IF;
          IF OLD."session_expires_at" IS NULL THEN
              IF NEW."session_expires_at" IS NOT NULL AND OLD."status" <> 'pending' THEN
                  RAISE EXCEPTION 'order_payment of order %: only a pending payment opens a checkout session', OLD."order_id"
                      USING ERRCODE = 'BK018';
              END IF;
              RETURN NEW;
          END IF;
          IF NEW."session_expires_at" IS DISTINCT FROM OLD."session_expires_at"
             OR NEW."session_return_url" IS DISTINCT FROM OLD."session_return_url"
             OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
              RAISE EXCEPTION 'order_payment of order %: the checkout session and its hold are pinned once', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF NEW."buyer" IS DISTINCT FROM OLD."buyer" THEN
              RAISE EXCEPTION 'order_payment of order %: the buyer is fixed once a checkout session is pinned to them', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF OLD."provider_session_id" IS NOT NULL AND NEW."provider_session_id" IS DISTINCT FROM OLD."provider_session_id" THEN
              RAISE EXCEPTION 'order_payment of order %: the checkout session id is set once', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "order_payment_session_guard" ON "order_payment"`;
    await tx`
      CREATE TRIGGER "order_payment_session_guard"
          BEFORE INSERT OR UPDATE ON "order_payment"
          FOR EACH ROW EXECUTE FUNCTION "order_payment_session_guard"()
    `;
  },
};
