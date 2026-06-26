// src/app/api/projects/_schema.ts
//
// The shared editor-snapshot request schema for the project write routes
// (POST /api/projects/publish and POST /api/projects/save). Both routes accept
// the EXACT SAME body — the editor's live ProjectModel serialized as a snapshot
// — and differ only in what they do with it (publish flips the site to
// `published`; save persists the working copy and leaves the status alone). The
// schema lives here so the two routes can never drift apart.

import { z } from 'zod';

// A single persisted page snapshot. We validate only the `slug` the persistence
// layer mirrors out for URL resolution; the rest of the PageModel SnapshotOut is
// opaque JSON that must round-trip byte-for-byte, so `.passthrough()` keeps every
// other key intact instead of stripping it.
export const pageSnapshotSchema = z
  .object({ slug: z.string().optional() })
  .passthrough();

// The ProjectModel SnapshotOut shape projectToPersisted reads. MST `types.Date`
// serializes to epoch ms, so createdAt/updatedAt are numbers. `.passthrough()`
// at every level preserves the full editor snapshot for a lossless save.
export const projectSnapshotSchema = z
  .object({
    id: z.string().min(1),
    metadata: z
      .object({
        title: z.string(),
        description: z.string().optional(),
        createdAt: z.number(),
        updatedAt: z.number(),
      })
      .passthrough(),
    lumitra: z
      .object({
        projectId: z.string().nullish(),
        ingestionEndpoint: z.string().nullish(),
        apiKeyRef: z.string().nullish(),
        enabled: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    pages: z.record(z.string(), pageSnapshotSchema),
  })
  .passthrough();

// The request body wrapper: `{ project: <snapshot> }`. Shared by both the
// publish and the save routes.
export const projectBodySchema = z.object({ project: projectSnapshotSchema });
