// src/server/commerce/jobs/__tests__/fixtures/pollerProcess.ts
//
// A real server-like process for runtime.itest.ts: the real poller on a short interval, a handler that takes a moment,
// and an open timer standing in for the HTTP server, so only a signal ends it. It prints a line when a job starts and
// when it finishes. Run by the test with `node --conditions=react-server --import tsx`, with
// COMMERCE_APP_DATABASE_URL in its environment.

import { z } from 'zod';

import { startCommerceWorker } from '../../runtime';
import { defineJobKind } from '../../types';

const held = defineJobKind({
  policy: { deadlineMs: 5000, backoffMinutes: [1], laterMinutes: 1, giveUpAfterMs: null },
  payload: z.object({ orderId: z.string() }),
  run: async ({ payload }) => {
    process.stdout.write(`started ${payload.orderId}\n`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.stdout.write(`finished ${payload.orderId}\n`);
  },
});

console.info = () => undefined;
setInterval(() => undefined, 60_000);
startCommerceWorker({ kinds: { held }, everyMs: 50 });
