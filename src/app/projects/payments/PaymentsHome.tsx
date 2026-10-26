'use client';

// src/app/projects/payments/PaymentsHome.tsx
//
// The company's payments: whether its shop takes real payments through its own Stripe account, and the two
// ways to get there: Stripe's hosted onboarding for a new account, or connecting an account the business
// already has. Until then the shop's checkout uses the demo payment (no real money). The 1% platform fee is
// stated before anyone connects. Glass look as the Books (globals.css glass utilities).

import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, CreditCard, ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

type AccountStatus = 'not_connected' | 'pending' | 'ready' | 'restricted';

const STATUS_TEXT: Record<AccountStatus, { title: string; body: string }> = {
  not_connected: {
    title: 'Not connected',
    body: 'Your shop takes demo payments only: no real money moves. Connect a Stripe account to take real payments.',
  },
  pending: {
    title: 'Waiting for Stripe',
    body: 'Stripe still needs details before your account can take payments. Continue the setup with Stripe.',
  },
  ready: {
    title: 'Ready',
    body: 'Your shop takes real payments into your own Stripe account. Every paid order gets its receipt in your Books.',
  },
  restricted: {
    title: 'Paused by Stripe',
    body: 'Stripe paused payments on your account until it gets more details. Continue the setup with Stripe.',
  },
};

/** What the address says after coming back from Stripe. */
const RETURN_TEXT: Record<string, string> = {
  invalid_state: 'That link from Stripe was not for this company or has expired. Start again.',
  cancelled: 'Connecting was cancelled. Nothing changed.',
  access_denied: 'Connecting was cancelled at Stripe. Nothing changed.',
  failed: 'Stripe could not connect the account. Try again in a moment.',
  refresh: 'The setup link expired. Continue the setup to get a new one.',
};

export default function PaymentsHome({ returned }: { returned: string | null }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/payments/stripe/account');
      const body = (await res.json().catch(() => ({}))) as { status?: AccountStatus; error?: { message?: string } };
      if (!res.ok || !body.status) {
        setError(body.error?.message ?? `the payment status could not be read (${res.status})`);
        return;
      }
      setStatus(body.status);
    } catch {
      setError('the payment status could not be read; check your connection and reload');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onboard() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/payments/stripe/onboarding', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
      if (!res.ok || !body.url) {
        setError(body.error?.message ?? `Stripe could not be reached (${res.status})`);
        setBusy(false);
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError('Stripe could not be reached; check your connection and try again');
      setBusy(false);
    }
  }

  const text = status ? STATUS_TEXT[status] : null;
  const notice = returned && RETURN_TEXT[returned];

  return (
    <div className="glass-ground flex min-h-dvh flex-col">
      <header className="glass sticky top-3 z-50 mx-3 flex h-14 shrink-0 items-center gap-2 rounded-2xl px-2 lg:px-3">
        <Link
          href="/projects"
          aria-label="Back to the projects"
          className="flex size-8 items-center justify-center rounded-lg text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <ChevronLeft size={18} aria-hidden />
        </Link>
        <h1 className="text-sm font-semibold">Payments</h1>
      </header>

      <main className="mx-auto mt-6 flex w-full max-w-2xl flex-col gap-4 px-4 pb-10">
        {notice ? (
          <div role="status" className="glass rounded-xl px-4 py-3 text-sm">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="glass rounded-xl px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <section aria-labelledby="stripe-heading" className="glass rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <CreditCard aria-hidden className="mt-0.5 size-5 text-foreground/70" />
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="stripe-heading" className="text-base font-semibold">
                Stripe {text ? <span className="font-normal text-muted-foreground">· {text.title}</span> : null}
              </h2>
              <p className="text-sm text-muted-foreground">
                {text ? text.body : status === null && !error ? 'Reading the payment status…' : null}
              </p>
            </div>
          </div>

          {status && status !== 'ready' ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void onboard()}>
                {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ExternalLink aria-hidden className="size-4" />}
                {status === 'not_connected' ? 'Set up a new Stripe account' : 'Continue the setup with Stripe'}
              </Button>
              {status === 'not_connected' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  // A full navigation: the route answers with a redirect to Stripe, not a page.
                  onClick={() => window.location.assign('/api/payments/stripe/oauth/start')}
                >
                  I already have a Stripe account
                </Button>
              ) : null}
            </div>
          ) : null}

          <p className="mt-4 text-xs text-muted-foreground">
            Payments go straight into your own Stripe account, and Stripe bills its fees to you directly. The platform
            takes 1% of each payment (VAT and shipping included), shown as its own line in Stripe. A refund returns that
            1% too.
          </p>
        </section>
      </main>
    </div>
  );
}
