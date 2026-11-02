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
  mergeKeptSiteSettings,
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

describe('projectToPersisted and reusable components', () => {
  const base = { ...getSnapshot(makeProjectWithPages()) } as Record<string, unknown>;

  it('carries a present key, including an empty one', () => {
    expect(projectToPersisted({ ...base, components: { card: {} } } as never).components).toEqual({ card: {} });
    expect(projectToPersisted({ ...base, components: {} } as never).components).toEqual({});
  });

  it('has no key at all for an old-shape body, or for a value that is no record', () => {
    const oldShape = { ...base };
    delete oldShape.components;
    expect('components' in projectToPersisted(oldShape as never)).toBe(false);
    expect('components' in projectToPersisted({ ...base, components: null } as never)).toBe(false);
    expect('components' in projectToPersisted({ ...base, components: ['card'] } as never)).toBe(false);
  });
});

describe('projectToPersisted and the kept site settings keys', () => {
  const base = { ...getSnapshot(makeProjectWithPages()) } as Record<string, unknown>;
  const theme = { tokens: [{ id: 'ab12cd34', name: 'Ink', kind: 'color', light: '#111111' }], document: {} };

  it('carries theme and head when the body holds them, empty ones included', () => {
    const full = projectToPersisted({ ...base, siteSettings: { theme, head: [] } } as never).siteSettings;
    expect(full.theme).toEqual(theme);
    expect(full.head).toEqual([]);
    const live = projectToPersisted(makeProjectWithPages()).siteSettings;
    expect(live.theme).toEqual({ tokens: [], document: {} });
    expect(live.head).toEqual([]);
  });

  it('has neither key for a body from a build before they existed, so the save keeps the stored ones', () => {
    const old = projectToPersisted({ ...base, siteSettings: { language: 'de' } } as never).siteSettings;
    expect('theme' in old).toBe(false);
    expect('head' in old).toBe(false);
    expect(old.language).toBe('de');
    expect('theme' in projectToPersisted({ ...base, siteSettings: undefined } as never).siteSettings).toBe(false);
    // null is the usual way to say nothing: it counts as absent, so it keeps the stored value too.
    const nulls = projectToPersisted({ ...base, siteSettings: { theme: null, head: null } } as never).siteSettings;
    expect('theme' in nulls).toBe(false);
    expect('head' in nulls).toBe(false);
    const stored = { theme: { mode: 'dark', tokens: [{ id: 'aaaaaaaa', name: 'A', kind: 'color', light: '#123' }], document: {} } };
    expect(mergeKeptSiteSettings(nulls, stored).theme).toEqual(stored.theme);
  });

  it('mergeKeptSiteSettings takes a missing key from the stored row and a present one from the body', () => {
    const stored = { language: 'de', theme, head: [{ kind: 'meta', name: 'author', content: 'x' }] };
    const kept = mergeKeptSiteSettings(projectToPersisted({ ...base, siteSettings: { language: 'en' } } as never).siteSettings, stored);
    expect(kept.language).toBe('en');
    expect(kept.theme).toEqual(theme);
    expect(kept.head).toEqual(stored.head);
    const cleared = mergeKeptSiteSettings(projectToPersisted({ ...base, siteSettings: { theme: {}, head: [] } } as never).siteSettings, stored);
    expect(cleared.theme).toEqual({ tokens: [], document: {} });
    expect(cleared.head).toEqual([]);
    // A brand-new site has no stored row.
    expect(mergeKeptSiteSettings(projectToPersisted({ ...base, siteSettings: {} } as never).siteSettings, undefined).theme).toEqual({ tokens: [], document: {} });
  });

  it('reads a bare theme key from an older build without throwing', () => {
    const odd = projectToPersisted({ ...base, siteSettings: { theme: 'x', head: 'y' } } as never).siteSettings;
    expect(odd.theme).toEqual({ tokens: [], document: {} });
    expect(odd.head).toEqual([]);
  });
});

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

  it('gives a stored page without breakpoint frames the three default ones on load', () => {
    const rowData: SiteRowData = {
      id: 'site_empty',
      name: 'Untitled Project',
      description: '',
      analyticsProjectId: null,
      ingestionEndpoint: null,
      apiKeyRef: null,
      lumitraEnabled: false,
      projectCreatedAt: new Date(0),
      projectUpdatedAt: new Date(0),
      // What the dashboard's "New project" stored before this fix.
      pages: [
        {
          pageId: 'home',
          snapshot: {
            id: 'home',
            slug: '',
            metadata: { title: 'test page', description: '' },
            appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {} },
            canvasNodes: {},
          },
        },
      ],
    };
    const page = ProjectModel.create(persistedToProjectSnapshot(rowData)).getPage('home')!;
    expect(page.sortedViewportNodes.map((v) => v.label)).toEqual(['Desktop', 'Tablet', 'Mobile']);
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

  it('preserves the site settings across a full round-trip, and old rows load with the defaults', () => {
    const original = makeProjectWithPages();
    original.updateSiteSettings({ ...original.site, siteName: 'Müller', language: 'de' });

    const persisted = projectToPersisted(original);
    expect(persisted.siteSettings.siteName).toBe('Müller');
    const rowData: SiteRowData = {
      id: persisted.siteId,
      name: persisted.name,
      description: persisted.description,
      analyticsProjectId: null,
      ingestionEndpoint: null,
      apiKeyRef: null,
      lumitraEnabled: false,
      siteSettings: JSON.parse(JSON.stringify(persisted.siteSettings)),
      projectCreatedAt: new Date(persisted.projectCreatedAt),
      projectUpdatedAt: new Date(persisted.projectUpdatedAt),
      pages: persisted.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
    };
    expect(ProjectModel.create(persistedToProjectSnapshot(rowData)).site).toEqual(original.site);

    const oldRow: SiteRowData = { ...rowData, siteSettings: {} };
    expect(ProjectModel.create(persistedToProjectSnapshot(oldRow)).site.language).toBe('en');
  });
});
