// scripts/csp-report.ts
//
// Operator CLI: what the report-only policy of published pages would block. One
// line per directive and blocked host, highest count first: count, directive,
// host, last seen, the sites loading it. See deploy/README.md.
//
//   pnpm csp:report
//
// Environment: DATABASE_URL (inject with Infisical, never a .env file).

import { PrismaClient } from '@prisma/client';
import { formatCspReportSummary, readCspReportSummary } from '../src/server/sites/cspReportStore';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const line of formatCspReportSummary(await readCspReportSummary(prisma))) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
