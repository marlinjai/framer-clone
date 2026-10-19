// src/app/projects/AuthUnavailable.tsx
//
// Shown on the editor pages when auth-brain could not answer whether the
// session is valid (network error, timeout, 5xx). Deliberately NOT a redirect:
// sending a possibly signed-in user to the login during an auth-brain outage
// loops (auth-brain, once back, sees the valid session and sends them back),
// and a redirect would also lose the page they asked for. The retry link
// reloads the same address.
//
// Status code: the App Router (Next 15) offers no way for a server component to
// set a response status other than notFound()/redirect(), so this page answers
// 200. The editor API routes, which CAN, answer a real JSON 503
// `auth_unavailable` (src/lib/authBrainAvailability.ts).

import React from 'react';

export default function AuthUnavailable({ retryHref }: { retryHref: string }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <section role="alert" className="rounded-lg border p-10 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Sign-in service unavailable
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          We could not check your sign-in just now. Your work is safe; this is
          usually over within a minute. Please try again.
        </p>
        <a
          href={retryHref}
          className="mt-6 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
        >
          Retry
        </a>
      </section>
    </main>
  );
}
