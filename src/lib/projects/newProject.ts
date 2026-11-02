// src/lib/projects/newProject.ts
//
// The empty project every server create path starts from: the project create
// route (POST /api/projects) and the site operations library's createSite
// (src/server/siteOps). Client-safe, no I/O.

import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { createIntrinsicComponent } from '@/models/ComponentModel';
import { NEW_PROJECT_SITE_SETTINGS } from '@/lib/site/siteSettings';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';

/**
 * Build a MINIMAL valid draft ProjectModel snapshot: one home page (`slug: ''`)
 * whose app tree is a single empty `div` root and the three default frames. We
 * round-trip through `ProjectModel.create(...)` + `getSnapshot(...)` so the
 * result is GUARANTEED to be a structurally valid SnapshotOut (the same shape
 * saveProject/projectToPersisted read) rather than a hand-built shape that could
 * silently drift from the model.
 */
export function buildEmptyDraftSnapshot(
  siteId: string,
  name: string,
  now: number,
): ProjectSnapshotOut {
  const pageId = crypto.randomUUID();
  const rootId = `root-${crypto.randomUUID()}`;

  const project = ProjectModel.create({
    id: siteId,
    metadata: { title: name, description: '', createdAt: now, updatedAt: now },
    // A new project starts in German (src/lib/site/siteSettings.ts); projects
    // saved before Site settings existed keep `en`.
    siteSettings: NEW_PROJECT_SITE_SETTINGS,
    pages: {
      [pageId]: {
        id: pageId,
        slug: '',
        metadata: { title: name, description: '' },
        appComponentTree: getSnapshot(
          createIntrinsicComponent(rootId, 'div', {}),
        ),
        // The three default breakpoint frames, as a page made in the editor
        // gets them. (An empty map left the home page of every new project
        // without frames: nothing on the canvas, no Preview.)
        canvasNodes: defaultViewportSnapshots(),
      },
    },
  });

  return getSnapshot(project) as ProjectSnapshotOut;
}
