// src/app/api/projects/[projectId]/commerce/inventory/route.ts
//
// GET /api/projects/<projectId>/commerce/inventory?variantId=&locationId=
//   -> AvailabilityDTO (advisory only, never permission to sell)
//
// The EDITOR read route for one project (CM-10 follow-up). The editor and its
// preview run on the editor host (or localhost), not on a published storefront,
// so they cannot use the host-resolved /api/commerce/* routes. This route takes
// the tenant from the signed-in auth-brain session instead: the session must
// have access to the project's workspace (401 / 403 otherwise, an unknown
// project is the same 403), and the read runs on commerceTenantDb of THAT
// project's site tenant group, failing closed with 404 commerce_not_provisioned
// when the site has none (src/server/commerce/editorTenant.ts). The read itself
// is shared with the storefront route (src/server/commerce/readHandlers.ts).
//
// A separate route family, not a branch in the storefront routes: the storefront
// plane must never read a session (D2), and keeping the two planes in different
// files makes that provable from source; this path also sits under the already
// session-gated /api/projects/* authoring surface (src/middleware.ts).

import { resolveEditorCommerce } from '@/server/commerce/editorTenant';
import { handleInventory } from '@/server/commerce/readHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await params;
  return handleInventory(req, () => resolveEditorCommerce(req, projectId));
}
