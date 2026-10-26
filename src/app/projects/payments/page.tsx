// src/app/projects/payments/page.tsx
//
// /projects/payments: where a company owner connects the shop's payments (Stripe Connect; slice 5 of
// docs/plans/2026-10-25-catalogue-design.md). The edge middleware requires a session for every /projects
// path; every /api/payments/stripe call enforces the active company and the admin role, and the client shows
// the server's refusal as text.

import React from 'react';

import PaymentsHome from './PaymentsHome';

export const dynamic = 'force-dynamic';

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { stripe } = await searchParams;
  return <PaymentsHome returned={typeof stripe === 'string' ? stripe : null} />;
}
