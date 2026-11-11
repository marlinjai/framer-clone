// src/app/projects/[projectId]/confirm/[approvalId]/page.tsx
//
// The approval link an agent hands the person when it asks to publish or roll
// back a site, or to merge a branch into it, through the Lumitra Sites MCP endpoint and its client has no
// confirmation dialog (src/server/mcp/approvals.ts). An editor page: the
// middleware serves it only on the editor host and bounces a visitor without a
// session to the login. Here the person's verified session is checked against
// publishSite (mergeBranch for a merge) on the request's workspace (src/server/mcp/approvalCheck.ts), the
// person must have signed in within 15 minutes (else they sign in again), the
// page shows what would go live, and the button approves (ApproveButton posts to
// /api/projects/<id>/confirmations/<approvalId>, which checks everything again).

import React from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthUnavailableError, AuthzUnavailableError, verifySessionOrThrowUnavailable } from '@/lib/authBrainAvailability';
import { approvalView, checkApprover, freshSignInUrl, signedInRecently } from '@/server/mcp/approvalCheck';
import AuthUnavailable from '../../../AuthUnavailable';
import ApproveButton from './ApproveButton';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ projectId: string; approvalId: string }>;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <section role="alert" className="rounded-lg border p-10 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{children}</p>
      </section>
    </main>
  );
}

export default async function ConfirmAgentActionPage({ params }: Props) {
  const { projectId, approvalId } = await params;
  const here = `/projects/${encodeURIComponent(projectId)}/confirm/${encodeURIComponent(approvalId)}`;

  const h = await headers();
  const pageUrl = `${h.get('x-forwarded-proto') || 'https'}://${h.get('x-forwarded-host') || h.get('host') || ''}${here}`;
  const cookie = (await cookies()).get('lumitra_session')?.value;
  let session: Awaited<ReturnType<typeof verifySessionOrThrowUnavailable>> | null = null;
  try {
    session = cookie ? await verifySessionOrThrowUnavailable(cookie) : null;
  } catch (err) {
    if (err instanceof AuthUnavailableError) return <AuthUnavailable retryHref={here} />;
    throw err;
  }
  const userId = session?.user?.id;
  if (!userId) {
    const login = new URL('/login', process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co');
    login.searchParams.set('return_to', pageUrl);
    redirect(login.toString());
  }

  let checked: Awaited<ReturnType<typeof checkApprover>>;
  try {
    checked = await checkApprover(userId, projectId, approvalId);
  } catch (err) {
    if (err instanceof AuthzUnavailableError) return <AuthUnavailable retryHref={here} />;
    throw err;
  }

  if (checked.status === 'not_found') {
    return (
      <Notice title="This approval link is not valid">
        It is unknown, expired or already used. Nothing was changed or published. Ask the agent for a new link.
      </Notice>
    );
  }
  if (checked.status === 'forbidden') {
    return (
      <Notice title="You cannot approve this">
        Only someone who may do this on the site themselves (publish it, or merge a branch into it) can approve it for
        an agent. Nothing was changed or published.
      </Notice>
    );
  }
  if (checked.status === 'changed') {
    return (
      <Notice title="The site changed since the agent asked">
        What you would approve is no longer what the agent would act on. Nothing was approved. Ask the agent to read
        the site again and send a new link.
      </Notice>
    );
  }

  // An old sign-in (a browser left signed in) must sign in again before it can
  // approve; the route refuses it the same way.
  if (!signedInRecently(session)) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <section role="alert" className="rounded-lg border p-10 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Sign in again to approve</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            An agent asks to publish or roll back a site, or to merge a branch. Approving needs a sign-in from the last 15 minutes. You are
            signed out once, sign in again, and come back to this page. Nothing has been approved.
          </p>
          <a href={freshSignInUrl(pageUrl)} className="mt-6 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent">
            Sign in again
          </a>
        </section>
      </main>
    );
  }

  const view = approvalView(checked.approval);
  const verb = view.action === 'publish' ? 'Publish' : view.action === 'merge' ? 'Merge the branch' : 'Serve an earlier version';
  const declined = view.action === 'merge' ? 'Declined. Nothing will be merged from this request.' : 'Declined. Nothing will be published from this request.';
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <section className="rounded-lg border p-10">
        <h1 className="text-xl font-semibold tracking-tight">An agent asks to {verb.toLowerCase()}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An agent using your company&apos;s API key asks for your approval. Check what it would do:
        </p>
        <p className="mt-4 whitespace-pre-wrap rounded-md border bg-muted/40 p-4 text-sm" data-testid="approval-summary">
          {view.summary}
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          The link works once and expires at {view.expiresAt.slice(11, 16)} UTC. After you approve, the agent carries it
          out on its next call. If you did not ask for this, close the page: nothing happens.
        </p>
        <div className="mt-6">
          <ApproveButton projectId={projectId} approvalId={approvalId} label={verb} declinedText={declined} decided={view.decision} />
        </div>
      </section>
    </main>
  );
}
