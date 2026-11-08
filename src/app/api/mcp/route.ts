// src/app/api/mcp/route.ts
//
// The Lumitra Sites MCP endpoint at https://app.lumitra.co/api/mcp (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, build step 4). The handler
// (src/server/mcp/handler.ts) verifies the company API key on every request
// itself; the middleware never does.

import { mcp } from '@/server/mcp/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = mcp.POST;
export const GET = mcp.GET;
export const DELETE = mcp.DELETE;
