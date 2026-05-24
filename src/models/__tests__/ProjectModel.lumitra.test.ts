// Unit tests for the Lumitra Studio binding sub-tree on ProjectModel.
//
// Covers the spec checklist in
// `docs/specs/wave-1/lumitra-studio-project-binding.md`:
//   - default shape: `lumitra.enabled === false` and undefined fields
//   - mutation actions update fields and flip flags
//   - snapshot round-trip preserves the lumitra block exactly
//   - pre-existing snapshots without `lumitra` load with the default block
//     (pre-MVP no-backcompat: MST `types.optional` rewrites the shape)
//
// History / undo behavior for lumitra writes is exercised implicitly: the
// mutations are regular MST actions on the project tree, identical in shape
// to existing `updateMetadata` writes, so they participate in HistoryStore
// the same way without any opt-in.

import { describe, it, expect } from 'vitest';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import ProjectModel from '../ProjectModel';

function makeProject() {
  return ProjectModel.create({
    id: 'proj_test',
    metadata: { title: 'Test project', description: '' },
    pages: {},
  });
}

describe('ProjectModel — lumitra binding', () => {
  it('defaults to enabled=false with all reference fields undefined', () => {
    const project = makeProject();

    expect(project.lumitra).toBeDefined();
    expect(project.lumitra.enabled).toBe(false);
    expect(project.lumitra.projectId).toBeUndefined();
    expect(project.lumitra.ingestionEndpoint).toBeUndefined();
    expect(project.lumitra.apiKeyRef).toBeUndefined();
  });

  it('setLumitraProjectId updates the field and clears it on undefined', () => {
    const project = makeProject();

    project.setLumitraProjectId('01H8XYZ-LUMITRA-UUID');
    expect(project.lumitra.projectId).toBe('01H8XYZ-LUMITRA-UUID');

    project.setLumitraProjectId(undefined);
    expect(project.lumitra.projectId).toBeUndefined();
  });

  it('setLumitraIngestionEndpoint and setLumitraApiKeyRef round-trip strings', () => {
    const project = makeProject();

    project.setLumitraIngestionEndpoint('https://analytics.lumitra.co/api/collect');
    project.setLumitraApiKeyRef('infisical:/framer-clone/ws-1/LUMITRA_API_KEY');

    expect(project.lumitra.ingestionEndpoint).toBe('https://analytics.lumitra.co/api/collect');
    expect(project.lumitra.apiKeyRef).toBe('infisical:/framer-clone/ws-1/LUMITRA_API_KEY');
  });

  it('setLumitraEnabled flips the flag', () => {
    const project = makeProject();
    expect(project.lumitra.enabled).toBe(false);

    project.setLumitraEnabled(true);
    expect(project.lumitra.enabled).toBe(true);

    project.setLumitraEnabled(false);
    expect(project.lumitra.enabled).toBe(false);
  });

  it('bumps metadata.updatedAt on every lumitra mutation', async () => {
    const project = makeProject();
    const before = project.metadata.updatedAt.getTime();

    // Wait one ms so the Date comparison is unambiguous.
    await new Promise(resolve => setTimeout(resolve, 2));
    project.setLumitraEnabled(true);

    expect(project.metadata.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('preserves the lumitra block through a getSnapshot / applySnapshot round-trip', () => {
    const original = makeProject();
    original.setLumitraProjectId('01H8XYZ-LUMITRA-UUID');
    original.setLumitraIngestionEndpoint('https://analytics.lumitra.co/api/collect');
    original.setLumitraApiKeyRef('infisical:/framer-clone/ws-1/LUMITRA_API_KEY');
    original.setLumitraEnabled(true);

    const snapshot = getSnapshot(original);

    expect(snapshot.lumitra).toEqual({
      projectId: '01H8XYZ-LUMITRA-UUID',
      ingestionEndpoint: 'https://analytics.lumitra.co/api/collect',
      apiKeyRef: 'infisical:/framer-clone/ws-1/LUMITRA_API_KEY',
      enabled: true,
    });

    const rebuilt = ProjectModel.create({
      id: 'proj_test',
      metadata: { title: 'Test project', description: '' },
      pages: {},
    });
    applySnapshot(rebuilt, snapshot);

    expect(getSnapshot(rebuilt)).toEqual(snapshot);
    expect(rebuilt.lumitra.projectId).toBe('01H8XYZ-LUMITRA-UUID');
    expect(rebuilt.lumitra.enabled).toBe(true);
  });

  it('loads a pre-existing snapshot without a lumitra field as the default empty block', () => {
    // A snapshot persisted before this spec landed — note the absence of
    // a `lumitra` key. Pre-MVP, no backcompat: MST's `types.optional`
    // rewrites the shape silently on load.
    const legacySnapshot = {
      id: 'proj_legacy',
      metadata: {
        title: 'Legacy project',
        description: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      pages: {},
    };

    const project = ProjectModel.create(legacySnapshot);

    expect(project.lumitra).toBeDefined();
    expect(project.lumitra.enabled).toBe(false);
    expect(project.lumitra.projectId).toBeUndefined();
    expect(project.lumitra.ingestionEndpoint).toBeUndefined();
    expect(project.lumitra.apiKeyRef).toBeUndefined();

    // The serialized snapshot now carries the canonical (empty) block, so
    // subsequent loads no longer need any guard.
    const rehydrated = getSnapshot(project);
    expect(rehydrated.lumitra).toEqual({ enabled: false });
  });
});
