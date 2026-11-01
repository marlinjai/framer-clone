// src/server/commerce/jobs/__tests__/fixtures/crashingWorker.ts
//
// A real worker process for jobs.itest.ts: it claims the next job through the real engine, and the handler kills its
// own process with SIGKILL, which no `finally` and no failure path survives. Run by the test with
// `node --conditions=react-server --import tsx`. Arguments: the app role's URL, the tenant group, the clock.

import { tenantDb } from '@marlinjai/tenant-db';
import { createNodeDb } from '@marlinjai/tenant-db/node';
import { z } from 'zod';

import type { CommerceDB } from '../../../db-types';
import { runNextJob } from '../../run';
import { defineJobKind } from '../../types';

const [url, tenantGroupId, now] = process.argv.slice(2);

const crashes = defineJobKind({
  policy: { deadlineMs: 1000, backoffMinutes: [1], laterMinutes: 1, giveUpAfterMs: null },
  payload: z.object({ orderId: z.string() }),
  run: async () => {
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => undefined);
  },
});

async function main(): Promise<void> {
  const base = createNodeDb<CommerceDB>({ connectionString: url, max: 1 });
  const result = await runNextJob(tenantDb(base, tenantGroupId), { kinds: { crashes }, now: () => new Date(now) });
  process.stdout.write(JSON.stringify({ outcome: result?.outcome ?? null }));
  await base.destroy();
}

void main();
