import type { Migration } from '@marlinjai/tenant-db';

/**
 * The hosted checkout's request, fixed once, `028_checkout_request` (the money review of 2026-11-02, finding 5).
 *
 * A Stripe Checkout Session is created under the idempotency key `checkout:<orderId>`, and Stripe refuses a key reused
 * with other parameters. The parameters changed between pay clicks: the session's end was computed from the clock, and
 * the buyer's email and the return address came from each request. So a buyer who pressed Pay again got a server
 * fault, and the pay route had already overwritten the buyer while the first session, made out to the first email,
 * stayed payable: the receipt could go to the second buyer.
 *
 * `order_payment.checkout_request` holds the request a start sends (email and return address; the session's end follows
 * from the payment window) and whether Stripe confirmed it with a session (`confirmed`). Every later start with the same
 * buyer sends exactly that, so Stripe answers the same session. Until Stripe confirmed it, another buyer may replace it:
 * no session is made out to anyone yet, so a first click that failed at Stripe locks no typo in (the review's second
 * round, R2-3). Once confirmed, one trigger holds two rules:
 *   - the request is set once (BK018 on a change);
 *   - the buyer is fixed too (BK018): the session is made out to them.
 *
 * Additive: one nullable column, a CHECK, and a trigger beside `order_payment_guard` (021), which stays as it is. House
 * style as 007 to 027: BARE names. Re-runnable.
 */
export const checkoutRequest: Migration = {
  id: '028_checkout_request',
  up: async (tx) => {
    await tx`ALTER TABLE "order_payment" ADD COLUMN IF NOT EXISTS "checkout_request" JSONB`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'order_payment_checkout_request_check' AND conrelid = 'order_payment'::regclass
        ) THEN
          ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_checkout_request_check"
            CHECK ("checkout_request" IS NULL OR (jsonb_typeof("checkout_request") = 'object' AND length("checkout_request"::text) <= 2000));
        END IF;
      END $$`;
    await tx`
      CREATE OR REPLACE FUNCTION "order_payment_checkout_guard"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $$
      BEGIN
          IF coalesce((OLD."checkout_request" ->> 'confirmed')::boolean, false) = false THEN
              RETURN NEW;
          END IF;
          IF NEW."checkout_request" IS DISTINCT FROM OLD."checkout_request" THEN
              RAISE EXCEPTION 'order_payment of order %: the hosted checkout request is set once', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          IF NEW."buyer" IS DISTINCT FROM OLD."buyer" THEN
              RAISE EXCEPTION 'order_payment of order %: the buyer is fixed once a hosted checkout is made out to them', OLD."order_id"
                  USING ERRCODE = 'BK018';
          END IF;
          RETURN NEW;
      END;
      $$
    `;
    await tx`DROP TRIGGER IF EXISTS "order_payment_checkout_guard" ON "order_payment"`;
    await tx`
      CREATE TRIGGER "order_payment_checkout_guard"
          BEFORE UPDATE ON "order_payment"
          FOR EACH ROW EXECUTE FUNCTION "order_payment_checkout_guard"()
    `;
  },
};
