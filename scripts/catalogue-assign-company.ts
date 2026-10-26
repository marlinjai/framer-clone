// scripts/catalogue-assign-company.ts
//
// Operator CLI for the one step migration 020_catalogue_company may leave: assign the catalogue and order
// rows of a tenant group that the migration could not assign (its schema knew no company or several) to
// the company they belong to, and optionally validate the "names its company" constraints afterwards.
// Idempotent, owner role, one transaction (src/server/commerce/provisioning/assignCompany.ts).
//
//   COMMERCE_OWNER_DATABASE_URL=... pnpm catalogue:assign-company <tenant group id> <company id> [--validate]
//
// In production the owner URL comes from Infisical through the secrets proxy, never typed.

import { assignCatalogueCompany } from '@/server/commerce/provisioning/assignCompany';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const validate = args.includes('--validate');
  const [tenantGroupId, companyId] = args.filter((a) => a !== '--validate');
  const connectionString = process.env.COMMERCE_OWNER_DATABASE_URL;
  if (!tenantGroupId || !companyId) {
    throw new Error('usage: pnpm catalogue:assign-company <tenant group id> <company id> [--validate]');
  }
  if (!connectionString) throw new Error('COMMERCE_OWNER_DATABASE_URL is not set (the owner role, from Infisical)');
  const result = await assignCatalogueCompany({ connectionString, tenantGroupId, companyId, validate });
  console.log(
    `assigned rows: ${JSON.stringify(result.assigned)}; legacy drafts published: ${result.published}; constraints validated: ${result.validated}`,
  );
}

main().catch((err) => {
  console.error('catalogue:assign-company failed:', err);
  process.exitCode = 1;
});
