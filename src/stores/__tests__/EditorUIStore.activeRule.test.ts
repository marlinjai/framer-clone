// The state the panel edits, through the four paths of the stateful flow standard:
// forward, backtrack, resume and re-entry. docs/plans/2026-11-02-selector-styling.md,
// "Unhappy and re-entry paths".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '../RootStore';
import { whilePanelWritesRule } from '../EditorUIStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { storedRulesOf } from '@/lib/rules/rules';

let store: RootStoreType;
let main: ComponentInstance;
let other: ComponentInstance;
let desktop: string;
let tablet: string;

const ui = () => store.editorUI;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('State test');
  const project = projectStore.findProjectByTitle('State test')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
  [main, other] = root.children as ComponentInstance[];
  desktop = page.sortedViewportNodes[0].breakpointId!;
  tablet = page.sortedViewportNodes[1].breakpointId!;
  getHistoryStore()!.setTargetStore(project);
  editorUI.selectComponent(main, desktop);
});

describe('forward', () => {
  it('shows the picked state on every copy of the node', () => {
    ui().setActiveRule('hover');
    expect(ui().activeRule).toBe('hover');
    expect(ui().activeRuleLabel).toBe('Hover');
    expect(ui().previewRule).toEqual({ componentId: main.id, ruleId: 'hover' });
  });

  it('stores nothing until the first value', () => {
    ui().setActiveRule('hover');
    ui().setActiveRule('pressed');
    ui().setActiveRule('focused');
    ui().setActiveRule(null);
    expect('rules' in (main.props as object)).toBe(false);
  });

  it('keeps a state with no rule when moving to another one', () => {
    main.setRuleStyle('hover', 'color', '#00f', desktop);
    ui().setActiveRule('hover');
    ui().setActiveRule('pressed');
    expect(ui().activeRule).toBe('pressed');
  });
});

describe('backtrack', () => {
  it('stays on the state when its last value is cleared in the panel', () => {
    ui().setActiveRule('hover');
    main.setRuleStyle('hover', 'color', '#00f', desktop);
    whilePanelWritesRule(() => main.clearRuleStyles('hover', ['color'], desktop));
    expect(storedRulesOf(main.props)).toEqual([]);
    expect(ui().activeRule).toBe('hover');
  });

  it('keeps the state on another frame of the same node', () => {
    ui().setActiveRule('hover');
    ui().selectComponent(main, tablet);
    expect(ui().activeRule).toBe('hover');
    expect(ui().previewRule).toEqual({ componentId: main.id, ruleId: 'hover' });
  });

  it('returns to Normal when the active rule is deleted', () => {
    main.setRuleStyle('hover', 'color', '#00f', desktop);
    ui().setActiveRule('hover');
    main.removeRule('hover');
    expect(ui().activeRule).toBeNull();
    expect(ui().previewRule).toBeNull();
  });

  it('returns to Normal on Normal', () => {
    ui().setActiveRule('hover');
    ui().setActiveRule(null);
    expect(ui().previewRule).toBeNull();
  });
});

describe('resume', () => {
  it('saves nothing about the state with the project', () => {
    main.setRuleStyle('hover', 'color', '#00f', desktop);
    ui().setActiveRule('hover');
    const saved = getSnapshot(ui()) as unknown as Record<string, unknown>;
    expect('activeRule' in saved).toBe(false);
    expect('previewRule' in saved).toBe(false);
  });
});

describe('re-entry', () => {
  it('returns to Normal on another selection', () => {
    ui().setActiveRule('hover');
    ui().selectComponent(other, desktop);
    expect(ui().activeRule).toBeNull();
    expect(ui().previewRule).toBeNull();
  });

  it('returns to Normal on several selected nodes and on none', () => {
    ui().setActiveRule('hover');
    ui().toggleInSelection(other, desktop);
    expect(ui().activeRule).toBeNull();

    ui().selectComponent(main, desktop);
    ui().setActiveRule('hover');
    ui().clearSelection();
    expect(ui().activeRule).toBeNull();
  });

  it('returns to Normal on undo past the creation of the rule', () => {
    ui().setActiveRule('hover');
    whilePanelWritesRule(() => main.setRuleStyle('hover', 'color', '#00f', desktop));
    expect(ui().activeRule).toBe('hover');
    getHistoryStore()!.undo();
    expect(storedRulesOf(main.props)).toEqual([]);
    expect(ui().activeRule).toBeNull();
    expect(ui().previewRule).toBeNull();
  });

  it('stays on the state when an undo leaves its rule in place', () => {
    ui().setActiveRule('hover');
    whilePanelWritesRule(() => main.setRuleStyle('hover', 'color', '#00f', desktop));
    whilePanelWritesRule(() => main.setRuleStyle('hover', 'opacity', '0.5', desktop));
    getHistoryStore()!.undo();
    expect(ui().activeRule).toBe('hover');
  });

  it('returns to Normal when the selected node goes', () => {
    ui().setActiveRule('hover');
    const page = ui().currentPage!;
    expect(page.deleteComponent(main.id)).toBe(true);
    expect(ui().selectedComponent).toBeUndefined();
    expect(ui().activeRule).toBeNull();
    expect(ui().previewRule).toBeNull();
  });

  it('returns to Normal when a rule that is not a state vanishes', () => {
    main.addRule({ id: 'custom', selector: '&:first-child', style: { color: '#00f' } });
    ui().setActiveRule('custom');
    expect(ui().activeRuleLabel).toBe('&:first-child');
    main.setProps({ rules: undefined });
    expect(ui().activeRule).toBeNull();
  });

  it('offers no state on a frame, a text node or a placement', () => {
    const page = ui().currentPage!;
    ui().setSelectedViewportNode(page.sortedViewportNodes[0]);
    expect(ui().ruleTarget).toBeUndefined();
    ui().setActiveRule('hover');
    expect(ui().activeRule).toBeNull();

    expect(createIntrinsicComponent('run', 'span', { children: 'x' }).holdsRules).toBe(true);
    expect(createIntrinsicComponent('run', '#text' as 'span', { children: 'x' }).holdsRules).toBe(false);
  });
});

describe('what a state may hold', () => {
  it('refuses an external address and keeps what the rule holds', () => {
    main.setRuleStyle('hover', 'color', '#00f', desktop);
    const result = main.setRuleStyle('hover', 'backgroundImage', 'url(https://example.test/x.jpg)', desktop);
    expect(result.ok).toBe(false);
    expect(storedRulesOf(main.props)[0].style).toEqual({ color: '#00f' });
  });

  it('takes a site path', () => {
    expect(main.setRuleStyle('hover', 'backgroundImage', 'url(/x.jpg)', desktop).ok).toBe(true);
  });

  it('clears a whole property without a breakpoint and one breakpoint with it', () => {
    main.setRuleStyle('hover', 'color', '#00f', desktop);
    main.setRuleStyle('hover', 'color', '#0a0', tablet);
    main.clearRuleStyles('hover', ['color'], tablet);
    expect(storedRulesOf(main.props)[0].style).toEqual({ color: '#00f' });
    main.setRuleStyle('hover', 'color', '#0a0', tablet);
    main.setRuleStyle('hover', 'opacity', 0.5, desktop);
    main.clearRuleStyles('hover', ['color']);
    expect(storedRulesOf(main.props)[0].style).toEqual({ opacity: 0.5 });
  });

  it('is one undo step for a row of two', () => {
    main.setRuleStyle('hover', 'width', '1px', desktop);
    main.setRuleStyle('hover', 'height', '2px', desktop);
    main.clearRuleStyles('hover', ['width', 'height'], desktop);
    expect(storedRulesOf(main.props)).toEqual([]);
    getHistoryStore()!.undo();
    expect(storedRulesOf(main.props)[0].style).toEqual({ width: '1px', height: '2px' });
  });
});
