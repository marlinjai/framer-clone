'use client';

// src/app/projects/payments/UnissuedReceiptsCard.tsx
//
// "Paid orders without an invoice" on the payments page: money a buyer paid that has no receipt yet, each with the
// reason the last attempt failed and whether the shop still retries it or has stopped for the owner. Shown only while
// there are any; a failure to read them is shown too, never a quiet empty card. The reasons are the Books' stable
// codes, put into words where the next step is known.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface UnissuedOrder {
  orderId: string;
  orderNumber: string;
  paidAt: string;
  reason: string | null;
  state: 'retrying' | 'stopped';
}

/** What a reason means for the owner, and what to do. Unknown codes are shown as they are. */
const REASON_TEXT: Record<string, string> = {
  SETTINGS_MISSING: 'the Books are not set up yet',
  COUNTER_MISSING: 'the Books have no invoice number series yet',
  SENDER_INCOMPLETE: 'the sender details of your invoices are incomplete',
  RECIPIENT_UNAVAILABLE: 'the contacts database did not answer',
  CONTACT_ARCHIVED: "the buyer's contact is archived; restore it",
  CUSTOMER_ARCHIVED: "the buyer's customer is archived; restore it",
  TOTALS_MISMATCH: "the invoice would not add up to what was paid (the company's tax status changed after the order)",
  TAX_IDENTITY_MISMATCH: 'a customer of the same name has another VAT id',
  TAX_CASE_UNSUPPORTED: 'the Books cannot invoice a buyer in that country',
  BUYER_NOT_INVOICEABLE: 'the buyer is outside Germany, which this shop cannot invoice correctly',
  BUYER_MISSING: 'the order has no buyer details',
};

const STATE_TEXT: Record<UnissuedOrder['state'], string> = {
  retrying: 'The shop keeps trying on its own and issues it once the reason is fixed.',
  stopped: 'The shop stopped trying: this needs you. After the reason is fixed, an operator must restart the receipt.',
};

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Berlin' }).format(new Date(iso));
}

export default function UnissuedReceiptsCard() {
  const [data, setData] = useState<{ count: number; orders: UnissuedOrder[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/payments/receipts');
      const body = (await res.json().catch(() => ({}))) as { count?: number; orders?: UnissuedOrder[]; error?: { message?: string } };
      if (!res.ok || typeof body.count !== 'number' || !body.orders) {
        setError(body.error?.message ?? `paid orders without an invoice could not be read (${res.status})`);
        return;
      }
      setData({ count: body.count, orders: body.orders });
    } catch {
      setError('paid orders without an invoice could not be read; check your connection and reload');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div role="alert" data-payments-unissued-error className="glass rounded-xl px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data || data.count === 0) return null;

  return (
    <section aria-labelledby="unissued-heading" data-payments-unissued className="glass rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 size-5 text-destructive" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="unissued-heading" className="text-base font-semibold">
            {data.count === 1 ? '1 paid order without an invoice' : `${data.count} paid orders without an invoice`}
          </h2>
          <p className="text-sm text-muted-foreground">
            These buyers paid, but their receipt could not be issued yet. What happens next depends on the order.
          </p>
        </div>
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {data.orders.map((order) => (
          <li key={order.orderId} data-payments-unissued-order className="rounded-xl border px-4 py-3 text-sm">
            <p className="font-medium">
              Order {order.orderNumber} · paid {formatDay(order.paidAt)}
            </p>
            <p className="text-muted-foreground">
              {order.reason ? `Why: ${REASON_TEXT[order.reason] ?? order.reason}.` : 'Not attempted yet.'} {STATE_TEXT[order.state]}
            </p>
          </li>
        ))}
      </ul>
      {data.count > data.orders.length ? (
        <p className="mt-2 text-xs text-muted-foreground">Showing the oldest {data.orders.length}.</p>
      ) : null}
    </section>
  );
}
