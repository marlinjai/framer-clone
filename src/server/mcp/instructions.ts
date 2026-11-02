// src/server/mcp/instructions.ts
//
// The `instructions` the Lumitra Sites MCP endpoint answers at initialize: how an
// agent should work with the tools. Written for an agent, read once per session.

import { MAX_BATCH_OPS } from '@/lib/siteOps/types';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';

export const SERVER_INSTRUCTIONS = `Lumitra Sites: build and edit the websites of the company the API key belongs to (the editor at app.lumitra.co). Every tool acts on that company's sites only.

Workflow:
1. describe_vocabulary once before the first write: it explains the batch operations and the node format insertNodes takes. Its text names operations in camelCase (getSite, applyBatch, findImages); the tools are the same names in snake_case (get_site, apply_batch, find_images).
2. Read before you write: list_sites, then get_site (pages, breakpoints, theme, components, and the site's version), then get_page for the page you change (node ids; long pages come in parts through nextCursor).
3. Write in small batches with apply_batch (a section or a handful of edits per call, at most ${MAX_BATCH_OPS} operations). A batch is all or nothing. generate_page drafts a whole page or section from a brief and is slower; use apply_batch for precise edits.
4. Always pass expectedVersion: the version of your last read or write. Every write answers the new version; use it for the next call.
5. After a change, open preview_url in a browser and look at the page at every breakpoint before you call it done.
6. Publish only when the person asks for it. publish and rollback ask the person to confirm (a dialog, or a summary and a token you bring back after they said yes in the chat). Never confirm on their behalf.

When a write is refused nothing was written:
- site_changed: someone (the editor, another agent) changed the site since your read. Read it again (get_site, get_page), redo your change on the current version, and send it with that version. Never resend the old batch unchanged on the new version without checking what changed.
- rejected: each refused operation is listed with its index and reason (a blocked tag or attribute, an unknown id, a value the editor would not keep). Fix those operations and resend the whole batch.
- rate_limited: wait retryAfterSec seconds.

Limits: one batch holds at most ${MAX_BATCH_OPS} operations; a generation brief at most ${GENERATION_LIMITS.maxBriefChars} characters and one generated tree at most ${GENERATION_LIMITS.maxNodes} nodes; writes are rate limited per key, generations to one at a time per key. Stock photos from find_images must keep their data-credit-* attributes. Deleting sites or domains is not possible through this endpoint.`;
