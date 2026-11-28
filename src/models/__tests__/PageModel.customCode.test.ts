// The two model actions of a custom code block (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// slice C4, D101 and D102): PageModel.insertCustomCodeBlock adds a block with no saved code and a
// fallback in the site language, ComponentModel.setCustomCode names the stored code by its hash.
// Each is one action, so one undo step.
import { beforeEach, describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { CUSTOM_CODE_FALLBACK_TEXT } from '@/lib/customCode/fallbackText';

const HASH = 'ab'.repeat(32);
let store: RootStoreType;
let project: ProjectModelType;
let page: PageModelType;
let main: ComponentInstance;

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Blocks');
  project = store.projectStore.findProjectByTitle('Blocks')!;
  page = project.findPageBySlug('')!;
  getHistoryStore()!.setTargetStore(project);
  main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
});

describe('PageModel.insertCustomCodeBlock', () => {
  it('adds a block with no saved code and an English fallback, as one undo step', () => {
    const before = getSnapshot(page.appComponentTree);
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id });
    expect(block).toBeDefined();
    expect((block!.props as Record<string, unknown>).customCode).toBeNull();
    expect(block!.type).toBe('div');
    expect(block!.children).toHaveLength(1);
    expect((block!.children[0].props as { children: string }).children).toBe(CUSTOM_CODE_FALLBACK_TEXT.en);
    expect(main.children.at(-1)).toBe(block);
    getHistoryStore()!.undo();
    expect(getSnapshot(page.appComponentTree)).toEqual(before);
  });

  it('writes the fallback in German on a German site', () => {
    const result = project.updateSiteSettings({ ...project.siteSettings, language: 'de' } as never);
    expect(result.ok).toBe(true);
    expect(project.siteSettings.language).toBe('de');
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id });
    expect((block!.children[0].props as { children: string }).children).toBe(CUSTOM_CODE_FALLBACK_TEXT.de);
  });

  it('refuses a floating place and a parent that holds no children', () => {
    expect(page.insertCustomCodeBlock({ kind: 'floating', x: 0, y: 0 })).toBeUndefined();
    main.addChild(createIntrinsicComponent('pic', 'img', { src: '/a.png', alt: '' }));
    expect(page.insertCustomCodeBlock({ kind: 'parent', parentId: 'pic' })).toBeUndefined();
  });
});

describe('ComponentModel.setCustomCode', () => {
  it('names the hash and the title of a block, as one undo step, and nothing when unchanged', () => {
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    const history = getHistoryStore()!;
    const steps = history.undoIdx;
    expect(block.setCustomCode({ sha256: HASH, title: '  A   clock ' })).toEqual({ ok: true });
    expect((block.props as Record<string, unknown>).customCode).toEqual({ sha256: HASH, title: 'A clock' });
    expect(history.undoIdx).toBe(steps + 1);
    expect(block.setCustomCode({ sha256: HASH, title: 'A clock' })).toEqual({ ok: true });
    history.undo();
    expect((block.props as Record<string, unknown>).customCode).toBeNull();
  });

  it('refuses an element that is not a block, a malformed hash and an unusable title, changing nothing', () => {
    expect(main.setCustomCode({ sha256: HASH, title: 'x' })).toEqual({ ok: false, reason: 'This element is not a custom code block.' });
    expect((main.props as Record<string, unknown>).customCode).toBeUndefined();
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    expect(block.setCustomCode({ sha256: HASH.toUpperCase(), title: 'x' }).ok).toBe(false);
    expect(block.setCustomCode({ sha256: HASH, title: '‮' }).ok).toBe(false);
    expect((block.props as Record<string, unknown>).customCode).toBeNull();
  });
});
// ci-replay touch
