import 'server-only';

// src/server/commerce/payment/stripe/ownerHandlers.ts
//
// What the owner-facing Stripe routes do (slice 5), kept apart from the route files so tests drive them with
// a fake StripeApi and a provisioned schema:
//
//   GET  /api/payments/stripe/account          -> { status }  not_connected, pending, ready or restricted
//   POST /api/payments/stripe/onboarding       -> { url }     Stripe's hosted onboarding for a new account
//   GET  /api/payments/stripe/oauth/start      -> 302         connect an existing Stripe account (OAuth)
//   GET  /api/payments/stripe/oauth/callback   -> 302         back to the payments page, connected or not
//   GET  /api/payments/stripe/return           -> 302         back from onboarding: readiness asked of Stripe

import { completeOauth, oauthState, oauthUrl, readAccount, readOauthState, refreshAccount, startOnboarding } from './connect';
import type { OwnerContext } from './ownerRoute';

/** Where the owner manages payments in the editor. */
export const PAYMENTS_PAGE = '/projects/payments';

/** The editor's own origin, from the request (the proxy's forwarded protocol when present). */
export function editorOrigin(req: Request): string {
  const host = req.headers.get('host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return `${proto}://${host}`;
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } });
}

export async function accountStatus(ctx: OwnerContext): Promise<Response> {
  const account = await readAccount(ctx.db, ctx.companyId);
  return Response.json({ status: account.status });
}

export async function onboarding(ctx: OwnerContext, req: Request): Promise<Response> {
  const origin = editorOrigin(req);
  const link = await startOnboarding(ctx.db, ctx.api, {
    tenantId: ctx.companyId,
    email: ctx.email ?? undefined,
    country: 'DE',
    refreshUrl: `${origin}${PAYMENTS_PAGE}?stripe=refresh`,
    returnUrl: `${origin}/api/payments/stripe/return`,
  });
  return Response.json({ url: link.url });
}

export async function oauthStart(ctx: OwnerContext, req: Request): Promise<Response> {
  const state = oauthState(ctx.config, ctx.companyId);
  return redirect(oauthUrl(ctx.config, state, `${editorOrigin(req)}/api/payments/stripe/oauth/callback`));
}

export async function oauthCallback(ctx: OwnerContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const back = `${editorOrigin(req)}${PAYMENTS_PAGE}`;
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  // The state must name the company the owner is acting for now, unexpired and signed by the platform.
  if (readOauthState(ctx.config, state) !== ctx.companyId) return redirect(`${back}?stripe=invalid_state`);
  if (!code) return redirect(`${back}?stripe=${encodeURIComponent(url.searchParams.get('error') ?? 'cancelled')}`);
  try {
    const account = await completeOauth(ctx.db, ctx.api, ctx.companyId, code);
    return redirect(`${back}?stripe=${account.status}`);
  } catch (err) {
    console.error(`[stripe] connecting an existing account for company ${ctx.companyId} failed:`, err);
    return redirect(`${back}?stripe=failed`);
  }
}

export async function onboardingReturn(ctx: OwnerContext, req: Request): Promise<Response> {
  const account = await refreshAccount(ctx.db, ctx.api, ctx.companyId);
  return redirect(`${editorOrigin(req)}${PAYMENTS_PAGE}?stripe=${account.status}`);
}
