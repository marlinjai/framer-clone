// scripts/catalogue-assign-sites.ts
//
// Operator CLI for the step migration 033_catalogue_site leaves: assign each company's catalogue of one tenant
// group to its sites (src/server/commerce/provisioning/assignSites.ts, which says exactly what moves where). A
// DRY RUN unless `--apply`: it prints the report (products per site, the copies with their new SKUs, the company
// items, the collections) and rolls everything back. `--company <id>` limits the run to one company.
//
//   DATABASE_URL=... COMMERCE_OWNER_DATABASE_URL=... pnpm catalogue:assign-sites <tenant group id> [--company <id>] [--apply]
//
// The main sites come from the public schema (DATABASE_URL, Prisma); the catalogue is written as the owner role.
// On production both URLs come from Infisical through the secrets proxy, never typed, and `--apply` is a release
// step that needs Marlin's yes (it moves live catalogue data).

import { PrismaClient } from '@prisma/client';

import { assignCatalogueSites } from '@/server/commerce/provisioning/assignSites';

function usage(): never {
  throw new Error('usage: pnpm catalogue:assign-sites <tenant group id> [--company <id>] [--apply]');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const at = args.indexOf('--company');
  const companyId = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !companyId) usage();
  const rest = args.filter((a, i) => a !== '--apply' && i !== at && i !== at + 1);
  const [tenantGroupId] = rest;
  if (!tenantGroupId || rest.length !== 1) usage();
  const connectionString = process.env.COMMERCE_OWNER_DATABASE_URL;
  if (!connectionString) throw new Error('COMMERCE_OWNER_DATABASE_URL is not set (the owner role, from Infisical)');

  const prisma = new PrismaClient();
  try {
    // Main sites only: a branch never owns a catalogue.
    const sites = await prisma.site.findMany({
      where: { tenantGroupId, branchOfSiteId: null },
      select: { id: true, companyId: true, createdAt: true, status: true },
    });
    const report = await assignCatalogueSites({
      connectionString,
      tenantGroupId,
      sites: sites.map((s) => ({ id: s.id, companyId: s.companyId, createdAt: s.createdAt, published: s.status === 'published' })),
      companyId,
      apply,
    });
    console.log(JSON.stringify(report, null, 2));
    console.log(apply ? 'applied' : 'dry run: nothing was written (run again with --apply to write it)');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('catalogue:assign-sites failed:', err);
  process.exitCode = 1;
});
