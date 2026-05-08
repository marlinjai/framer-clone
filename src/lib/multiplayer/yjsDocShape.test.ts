// src/lib/multiplayer/yjsDocShape.test.ts
//
// Vitest coverage for the Yjs document shape and conversion helpers.
//
// The fixture is built through real MST `ProjectModel.create(...)` then
// serialised with `getSnapshot()` so we exercise the same shape the live
// binding will see. Round-trip equality is checked by re-creating an MST
// model from the decoded snapshot and comparing both `getSnapshot()`
// outputs — this normalises away differences in how snapshot literals
// vs. MST-emitted snapshots represent defaults / undefined fields.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import * as Y from 'yjs';

import {
  YJS_DOC_SCHEMA_VERSION,
  YJS_KEYS,
  YJS_NODE_KEYS,
  YJS_PROJECT_KEYS,
  YJS_PROPS_KEYS,
  createEmptyProjectYDoc,
  getChildrenArray,
  getNodeMap,
  mstSnapshotToYDoc,
  yDocToMstSnapshot,
} from './yjsDocShape';

import { ProjectModel } from '@/models/ProjectModel';
import PageModel from '@/models/PageModel';
import ComponentModel, {
  CanvasNodeType,
  ComponentTypeEnum,
} from '@/models/ComponentModel';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
//
// One project with one page, populated by hand to exercise every shape the
// spec calls out:
//   - viewport node (canvasNodeType: VIEWPORT) with breakpoint metadata
//   - container node nested inside the viewport
//   - text node nested inside the container with `props.children: '...'`
//   - one floating element (canvasNodeType: FLOATING_ELEMENT) at (x, y)
//   - app-tree root with a responsive style map under `props.style.width`
//
// IDs are deterministic so failure messages point at a known node.

function buildFixtureProject() {
  const desktopBreakpointId = 'bp-desktop';
  const mobileBreakpointId = 'bp-mobile';

  const textNode = ComponentModel.create({
    id: 'text-1',
    type: 'p',
    componentType: ComponentTypeEnum.HOST,
    props: { children: 'Hello world', style: { color: 'navy' } },
    label: 'Greeting',
  });

  const containerNode = ComponentModel.create({
    id: 'container-1',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    props: { style: { padding: '12px' } },
    label: 'Container',
  });
  containerNode.addChild(textNode);

  const desktopViewport = ComponentModel.create({
    id: 'viewport-desktop',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.VIEWPORT,
    label: 'Desktop',
    props: {
      className: 'viewport-frame',
      style: {
        width: '1280px',
        height: '800px',
        backgroundColor: 'white',
      },
    },
    canvasX: 100,
    canvasY: 100,
    breakpointId: desktopBreakpointId,
    breakpointMinWidth: 1280,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  desktopViewport.addChild(containerNode);

  const floatingNode = ComponentModel.create({
    id: 'floating-1',
    type: 'img',
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.FLOATING_ELEMENT,
    canvasX: 500,
    canvasY: 320,
    canvasZIndex: 2,
    label: 'Hero Image',
    props: { src: '/hero.png', alt: 'Hero' },
  });

  // App-tree root carries a responsive style map to verify nested-Y.Map
  // serialization for `{ base, mobile }` shapes.
  const appTree = ComponentModel.create({
    id: 'root-1',
    type: 'div',
    componentType: ComponentTypeEnum.HOST,
    props: {
      style: {
        padding: '16px',
        width: { base: '100%', [mobileBreakpointId]: '50%' },
        fontFamily: 'Inter, sans-serif',
      },
    },
  });

  const page = PageModel.create({
    id: 'page-1',
    slug: 'home',
    metadata: {
      title: 'Home',
      description: 'Landing page',
      keywords: ['home', 'landing'],
      ogTitle: 'Home',
      ogDescription: '',
      ogImage: '',
      canonicalUrl: '',
    },
    appComponentTree: appTree,
    canvasNodes: {
      [desktopViewport.id]: desktopViewport,
      [floatingNode.id]: floatingNode,
    },
  });

  const project = ProjectModel.create({
    id: 'project-1',
    metadata: {
      title: 'Demo',
      description: 'Test project',
    },
    pages: { [page.id]: page },
  });

  return {
    project,
    ids: {
      desktopViewport: desktopViewport.id,
      container: containerNode.id,
      text: textNode.id,
      floating: floatingNode.id,
      root: appTree.id,
      page: page.id,
      desktopBreakpoint: desktopBreakpointId,
      mobileBreakpoint: mobileBreakpointId,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEmptyProjectYDoc', () => {
  it('seeds the four top-level shared types and schema metadata', () => {
    const doc = createEmptyProjectYDoc({
      projectId: 'p1',
      name: 'Demo',
      primaryBreakpointId: 'bp-desktop',
    });

    const project = doc.getMap(YJS_KEYS.project);
    expect(project.get(YJS_PROJECT_KEYS.schemaVersion)).toBe(
      YJS_DOC_SCHEMA_VERSION,
    );
    expect(project.get(YJS_PROJECT_KEYS.projectId)).toBe('p1');
    expect(project.get(YJS_PROJECT_KEYS.name)).toBe('Demo');
    expect(project.get(YJS_PROJECT_KEYS.primaryBreakpointId)).toBe(
      'bp-desktop',
    );

    // The other three top-level types exist (Y.Doc creates them lazily on
    // first read; make sure we can read them and they're empty).
    expect(doc.getArray(YJS_KEYS.pageOrder).length).toBe(0);
    expect(doc.getMap(YJS_KEYS.pagesById).size).toBe(0);
    expect(doc.getMap(YJS_KEYS.nodes).size).toBe(0);
  });
});

describe('mstSnapshotToYDoc -> yDocToMstSnapshot round-trip', () => {
  it('preserves viewport, nested children, floating elements, responsive style maps, and text content', () => {
    const { project, ids } = buildFixtureProject();
    const snap = getSnapshot(project);

    const doc = mstSnapshotToYDoc(snap as any);

    // --- structural sanity on the encoded doc -----------------------------

    // Project metadata mirrored on the project Y.Map.
    const projectMap = doc.getMap(YJS_KEYS.project);
    expect(projectMap.get(YJS_PROJECT_KEYS.schemaVersion)).toBe(
      YJS_DOC_SCHEMA_VERSION,
    );
    expect(projectMap.get(YJS_PROJECT_KEYS.projectId)).toBe('project-1');
    expect(projectMap.get(YJS_PROJECT_KEYS.name)).toBe('Demo');
    expect(projectMap.get(YJS_PROJECT_KEYS.description)).toBe('Test project');
    // primaryBreakpointId is auto-derived from the first viewport node.
    expect(projectMap.get(YJS_PROJECT_KEYS.primaryBreakpointId)).toBe(
      ids.desktopBreakpoint,
    );

    // Page order + page map.
    const pageOrder = doc.getArray<string>(YJS_KEYS.pageOrder);
    expect(pageOrder.toArray()).toEqual([ids.page]);

    // Flat node registry contains every component (root, viewport,
    // container, text, floating).
    const nodes = doc.getMap(YJS_KEYS.nodes);
    expect(nodes.size).toBe(5);
    expect(nodes.has(ids.root)).toBe(true);
    expect(nodes.has(ids.desktopViewport)).toBe(true);
    expect(nodes.has(ids.container)).toBe(true);
    expect(nodes.has(ids.text)).toBe(true);
    expect(nodes.has(ids.floating)).toBe(true);

    // The viewport carries the breakpoint metadata.
    const viewportMap = nodes.get(ids.desktopViewport) as Y.Map<any>;
    expect(viewportMap.get(YJS_NODE_KEYS.canvasNodeType)).toBe(
      CanvasNodeType.VIEWPORT,
    );
    expect(viewportMap.get(YJS_NODE_KEYS.breakpointId)).toBe(
      ids.desktopBreakpoint,
    );
    expect(viewportMap.get(YJS_NODE_KEYS.viewportWidth)).toBe(1280);

    // The viewport's children Y.Array references the container by id.
    const viewportChildren = viewportMap.get(YJS_NODE_KEYS.children);
    expect(viewportChildren).toBeInstanceOf(Y.Array);
    expect((viewportChildren as Y.Array<string>).toArray()).toEqual([
      ids.container,
    ]);

    // The text node has a string children prop (text content) preserved.
    const textMap = nodes.get(ids.text) as Y.Map<any>;
    const textProps = textMap.get(YJS_NODE_KEYS.props) as Y.Map<any>;
    expect(textProps.get('children')).toBe('Hello world');

    // The floating element keeps its absolute position and zIndex.
    const floatingMap = nodes.get(ids.floating) as Y.Map<any>;
    expect(floatingMap.get(YJS_NODE_KEYS.canvasNodeType)).toBe(
      CanvasNodeType.FLOATING_ELEMENT,
    );
    expect(floatingMap.get(YJS_NODE_KEYS.canvasX)).toBe(500);
    expect(floatingMap.get(YJS_NODE_KEYS.canvasY)).toBe(320);
    expect(floatingMap.get(YJS_NODE_KEYS.canvasZIndex)).toBe(2);

    // The root's responsive style map is encoded as a nested Y.Map.
    const rootMap = nodes.get(ids.root) as Y.Map<any>;
    const rootProps = rootMap.get(YJS_NODE_KEYS.props) as Y.Map<any>;
    const rootStyle = rootProps.get(YJS_PROPS_KEYS.style) as Y.Map<any>;
    expect(rootStyle).toBeInstanceOf(Y.Map);
    expect(rootStyle.get('padding')).toBe('16px');
    const widthInner = rootStyle.get('width');
    expect(widthInner).toBeInstanceOf(Y.Map);
    expect((widthInner as Y.Map<any>).get('base')).toBe('100%');
    expect((widthInner as Y.Map<any>).get(ids.mobileBreakpoint)).toBe('50%');

    // --- decode and structurally compare ---------------------------------

    const decoded = yDocToMstSnapshot(doc);
    const project2 = ProjectModel.create(decoded as any);
    const snap2 = getSnapshot(project2);

    expect(snap2).toEqual(snap);
  });
});

describe('getNodeMap / getChildrenArray', () => {
  it('return live Y references that are observable when mutated', () => {
    const { project, ids } = buildFixtureProject();
    const doc = mstSnapshotToYDoc(getSnapshot(project) as any);

    const viewport = getNodeMap(doc, ids.desktopViewport);
    expect(viewport).toBeInstanceOf(Y.Map);

    const children = getChildrenArray(doc, ids.desktopViewport);
    expect(children).toBeInstanceOf(Y.Array);
    expect(children!.toArray()).toEqual([ids.container]);

    // Live mutation on the returned reference is observed on the doc.
    let observedChildren: string[] | undefined;
    children!.observe(() => {
      observedChildren = children!.toArray();
    });
    children!.push(['floating-2']);
    expect(observedChildren).toEqual([ids.container, 'floating-2']);

    // Read-through on the registry still sees the mutation.
    const same = getChildrenArray(doc, ids.desktopViewport);
    expect(same!.toArray()).toEqual([ids.container, 'floating-2']);
  });

  it('returns undefined for unknown node ids', () => {
    const doc = createEmptyProjectYDoc({
      projectId: 'p1',
      name: 'Demo',
      primaryBreakpointId: 'bp-desktop',
    });
    expect(getNodeMap(doc, 'does-not-exist')).toBeUndefined();
    expect(getChildrenArray(doc, 'does-not-exist')).toBeUndefined();
  });
});

describe('encoded state preserves the round-trip', () => {
  it('encodes to Uint8Array and reapplies into a fresh doc without loss', () => {
    const { project } = buildFixtureProject();
    const snap = getSnapshot(project);
    const doc1 = mstSnapshotToYDoc(snap as any);

    const update = Y.encodeStateAsUpdate(doc1);
    expect(update).toBeInstanceOf(Uint8Array);
    expect(update.byteLength).toBeGreaterThan(0);

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);

    const decoded = yDocToMstSnapshot(doc2);
    const project2 = ProjectModel.create(decoded as any);
    expect(getSnapshot(project2)).toEqual(snap);
  });
});
