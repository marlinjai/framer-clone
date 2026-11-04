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

// The request body wrapper: `{ project: <snapshot>, expectedVersion }`. Shared
// by both the publish and the save routes.
//
// `expectedVersion` is the version lock: the site version the snapshot was
// based on (the editor gets it from the loader and from every successful save
// or publish). A stale one is refused with 409 `site_changed` and the stored
// `currentVersion`. It is REQUIRED: a body without it (an editor tab built
// before the lock existed) is refused with 400 `version_required` and writes
// nothing, so no client of these routes ever gets a silent "newest wins" save.
//
// `requestKey` (save only) names one attempt of the editor's save: a retry of
// the same content after a lost answer reuses it, and the save route answers
// the stored result instead of a 409 against the write itself.
export const projectBodySchema = z.object({
  project: projectSnapshotSchema,
  expectedVersion: z.number().int().positive().optional(),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
});
