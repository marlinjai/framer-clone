// src/app/api/projects/__tests__/whileBusy.ts
//
// For integration suites that create a project on the shared Postgres: repeat a
// request while the route answers 503 commerce_busy, waiting what its Retry-After
// says, as a client does. The route suites provision through the production lock,
// so one suite's provision that outlasts the 10 s wait, on a container other suites
// keep busy, answers another suite with exactly that. Their subject is what the
// create does, not that wait (concurrency.itest.ts proves the wait). Any other
// answer returns at once, and a suite that calls this needs room for the waits
// (WHILE_BUSY_TIMEOUT_MS). Not a test file itself.

/** Six answers after 10 s of lock wait each, with 10 s between them, plus the rest of the test. */
export const WHILE_BUSY_TIMEOUT_MS = 180_000;

const ATTEMPTS = 6;

export async function whileBusy(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await send();
    if (attempt === ATTEMPTS || res.status !== 503) return res;
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    if (body.error?.code !== 'commerce_busy') return res;
    await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after')) * 1000));
  }
}
