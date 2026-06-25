// Round-trip tests for the pure MST <-> persistence mapping (P1b).
//
// The load-bearing correctness guarantee: a ProjectModel serialized to the
// persistence shape and rebuilt from it is structurally identical. If this
// holds, Prisma can be the source of truth and the MST a disposable working
// copy. No Prisma, no database — pure functions only.

import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import {
  projectToPersisted,
  persistedToProjectSnapshot,
  type SiteRowData,
} from '../snapshot';

function makeProjectWithPages() {
  const project = ProjectModel.create({
    id: 'site_round_trip',
    metadata: { title: 'My Site', description: 'a test site' },
    pages: {},
  });
  // Use the model's own createPage so the page subtree (viewports, app tree)
  // is realistic, not a hand-rolled fixture.
  project.createPage('Home');
  project.createPage('About');
  return project;
}

describe('projectToPersisted', () => {
  it('splits a ProjectModel into site scalars + one entry per page', () => {
    const project = makeProjectWithPages();
    const persisted = projectToPersisted(project);

    expect(persisted.siteId).toBe('site_round_trip');
    expect(persisted.name).toBe('My Site');
    expect(persisted.description).toBe('a test site');
    expect(persisted.pages).toHaveLength(2);
    // pageId mirrors the MST page identifier; slug is mirrored out for routing.
    for (const page of persisted.pages) {
      expect(typeof page.pageId).toBe('string');
      expect(page.slug.length).toBeGreaterThan(0);
      expect(page.snapshot).toBeDefined();
    }
  });

  it('denormalises the lumitra binding onto the site scalars', () => {
    const project = makeProjectWithPages();
    project.setLumitraProjectId('proj_analytics_123');
    project.setLumitraIngestionEndpoint('https://analytics.lumitra.co/api/collect');
    project.setLumitraApiKeyRef('infisical:/framer-clone/ws-1/AP_LIVE');
    project.setLumitraEnabled(true);

    const persisted = projectToPersisted(project);
    expect(persisted.analyticsProjectId).toBe('proj_analytics_123');
    expect(persisted.ingestionEndpoint).toBe('https://analytics.lumitra.co/api/collect');
    expect(persisted.apiKeyRef).toBe('infisical:/framer-clone/ws-1/AP_LIVE');
    expect(persisted.lumitraEnabled).toBe(true);
  });

  it('accepts an already-taken SnapshotOut as well as a live instance', () => {
    const project = makeProjectWithPages();
    const fromInstance = projectToPersisted(project);
    const fromSnapshot = projectToPersisted(getSnapshot(project));
    expect(fromSnapshot.siteId).toBe(fromInstance.siteId);
    expect(fromSnapshot.pages.length).toBe(fromInstance.pages.length);
  });
});

describe('persistedToProjectSnapshot -> ProjectModel round-trip', () => {
  it('rebuilds a structurally identical ProjectModel from persisted rows', () => {
    const original = makeProjectWithPages();
    const persisted = projectToPersisted(original);

    // Simulate the repository read: each page snapshot stored as opaque JSON,
    // the project timestamps round-tripped through DateTime columns.
    const rowData: SiteRowData = {
      id: persisted.siteId,
      name: persisted.name,
      description: persisted.description,
      analyticsProjectId: persisted.analyticsProjectId,
      ingestionEndpoint: persisted.ingestionEndpoint,
      apiKeyRef: persisted.apiKeyRef,
      lumitraEnabled: persisted.lumitraEnabled,
      projectCreatedAt: new Date(persisted.projectCreatedAt),
      projectUpdatedAt: new Date(persisted.projectUpdatedAt),
      pages: persisted.pages.map((p) => ({
        pageId: p.pageId,
        // JSON round-trip to prove the snapshot survives a DB write/read.
        snapshot: JSON.parse(JSON.stringify(p.snapshot)),
      })),
    };

    const rebuilt = ProjectModel.create(persistedToProjectSnapshot(rowData));

    // The whole tree must match. getSnapshot normalizes both to plain data.
    expect(getSnapshot(rebuilt)).toEqual(getSnapshot(original));
  });

  it('loads a site with no analytics binding with the default empty block', () => {
    const original = makeProjectWithPages(); // no lumitra calls
    const persisted = projectToPersisted(original);

    const rowData: SiteRowData = {
      id: persisted.siteId,
      name: persisted.name,
      description: persisted.description,
      analyticsProjectId: null,
      ingestionEndpoint: null,
      apiKeyRef: null,
      lumitraEnabled: false,
      projectCreatedAt: new Date(persisted.projectCreatedAt),
      projectUpdatedAt: new Date(persisted.projectUpdatedAt),
      pages: persisted.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
    };

    const rebuilt = ProjectModel.create(persistedToProjectSnapshot(rowData));
    expect(rebuilt.lumitra.enabled).toBe(false);
    expect(rebuilt.lumitra.projectId).toBeUndefined();
  });

  it('preserves the lumitra binding across a full round-trip', () => {
    const original = makeProjectWithPages();
    original.setLumitraProjectId('proj_xyz');
    original.setLumitraEnabled(true);

    const persisted = projectToPersisted(original);
    const rowData: SiteRowData = {
      id: persisted.siteId,
      name: persisted.name,
      description: persisted.description,
      analyticsProjectId: persisted.analyticsProjectId,
      ingestionEndpoint: persisted.ingestionEndpoint,
      apiKeyRef: persisted.apiKeyRef,
      lumitraEnabled: persisted.lumitraEnabled,
      projectCreatedAt: new Date(persisted.projectCreatedAt),
      projectUpdatedAt: new Date(persisted.projectUpdatedAt),
      pages: persisted.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
    };

    const rebuilt = ProjectModel.create(persistedToProjectSnapshot(rowData));
    expect(rebuilt.lumitra.projectId).toBe('proj_xyz');
    expect(rebuilt.lumitra.enabled).toBe(true);
  });
});
